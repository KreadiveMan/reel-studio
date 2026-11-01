import {spawn} from 'node:child_process';

// Music analysis for the beat montage: tempo, beat times, bar starts (downbeats), loudness per beat and the
// moments where the music lifts. Pure JavaScript on FFmpeg-decoded mono PCM; no extra packages.
//   onset envelope : spectral flux of the log-magnitude spectrum (frame 2048, hop 512 at 22.05 kHz)
//   tempo          : autocorrelation of the envelope, weighted towards 120 BPM, refined between lags
//   beats          : dynamic-programming beat tracker (Ellis 2007) on that tempo
//   downbeats      : the beat phase (of four) carrying the most onset and bass energy

export const SAMPLE_RATE = 22050;
const FRAME = 2048, HOP = 512;
export const ENVELOPE_FPS = SAMPLE_RATE / HOP;

/** Decodes any audio (or a video's audio) to mono float PCM at 22.05 kHz. */
export function decodeMono(file, {ffmpeg = 'ffmpeg', start = null, duration = null} = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', ...(start !== null ? ['-ss', String(start)] : []), '-i', file, ...(duration !== null ? ['-t', String(duration)] : []), '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'];
    const child = spawn(ffmpeg, args, {stdio: ['ignore', 'pipe', 'pipe']});
    const chunks = []; let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg could not read the music: ${err.trim().split('\n').at(-1) ?? code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)).slice());
    });
  });
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Onset strength and low-band (kick/bass) strength per hop. */
export function onsetEnvelope(samples) {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const window = Float32Array.from({length: FRAME}, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const bins = FRAME / 2, bassBin = Math.ceil((150 * FRAME) / SAMPLE_RATE);
  const onset = new Float32Array(frames), bass = new Float32Array(frames);
  let prev = new Float32Array(bins);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = samples[off + i] * window[i]; im[i] = 0; }
    fft(re, im);
    const cur = new Float32Array(bins);
    let flux = 0, low = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.log1p(1000 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      const d = mag - prev[k];
      if (d > 0) { flux += d; if (k <= bassBin) low += d; }
    }
    onset[f] = flux; bass[f] = low; prev = cur;
  }
  return {onset: normalize(onset), bass: normalize(bass)};
}

// Remove the slow trend (about half a second) and scale to unit spread, keeping only rises.
function normalize(env) {
  const n = env.length, w = Math.round(ENVELOPE_FPS * 0.5), out = new Float32Array(n);
  let sum = 0;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { sum += env[i]; pre[i + 1] = sum; }
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    out[i] = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a));
    sq += out[i] * out[i];
  }
  const sd = Math.sqrt(sq / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** Beats per minute from the onset envelope (60–200 BPM, weighted towards 120). */
export function estimateTempo(onset, {min = 60, max = 200} = {}) {
  const fps = ENVELOPE_FPS, lo = Math.floor((60 / max) * fps), hi = Math.ceil((60 / min) * fps);
  const score = (lag) => { let s = 0; for (let i = lag; i < onset.length; i++) s += onset[i] * onset[i - lag]; return s / (onset.length - lag); };
  let best = null;
  const scores = new Map();
  for (let lag = lo; lag <= hi; lag++) {
    const bpm = (60 * fps) / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const s = score(lag); scores.set(lag, s);
    if (!best || s * weight > best.value) best = {lag, value: s * weight};
  }
  if (!best) return 120;
  // Parabolic refinement between neighbouring lags.
  const a = scores.get(best.lag - 1) ?? scores.get(best.lag), b = scores.get(best.lag), c = scores.get(best.lag + 1) ?? b;
  const denom = a - 2 * b + c, shift = denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return (60 * fps) / (best.lag + shift);
}

/** Beat frames (envelope frame indices) by dynamic programming on the given tempo. */
export function trackBeats(onset, bpm, {tightness = 100} = {}) {
  const n = onset.length, period = (60 * ENVELOPE_FPS) / bpm;
  if (n < period * 2) return [];
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0, from = -1;
    for (let p = Math.round(t - 2 * period); p <= Math.round(t - period / 2); p++) {
      if (p < 0) continue;
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (from < 0 || v > best) { best = v; from = p; }
    }
    score[t] = onset[t] + (from >= 0 ? best : 0);
    back[t] = from;
  }
  let end = n - 1, top = -Infinity;
  for (let t = Math.max(0, Math.floor(n - period)); t < n; t++) if (score[t] > top) { top = score[t]; end = t; }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
  beats.reverse();
  // Extend backwards to the start at the steady period if the chain stopped early.
  while (beats.length && beats[0] - period > 0) beats.unshift(Math.round(beats[0] - period));
  return beats;
}

/** Index (0–3) of the beat phase that starts bars. */
export function downbeatPhase(beatFrames, onset, bass) {
  // Kicks (the low band) mark bars far more reliably than overall flux.
  const strength = (f) => (onset[f] ?? 0) + 4 * (bass[f] ?? 0);
  let best = 0, bestScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let s = 0;
    for (let i = phase; i < beatFrames.length; i += 4) s += strength(beatFrames[i]);
    if (s > bestScore) { bestScore = s; best = phase; }
  }
  return best;
}

/** Full analysis of a decoded song. */
export function analyzeSamples(samples) {
  const duration = samples.length / SAMPLE_RATE;
  const {onset, bass} = onsetEnvelope(samples);
  const bpm = estimateTempo(onset);
  // Snap each tracked beat to the strongest onset within ±70 ms: the tracker keeps the pulse, the snap keeps the hit.
  const reach = Math.round(0.07 * ENVELOPE_FPS);
  const frames = trackBeats(onset, bpm).map((f) => {
    let best = f;
    for (let g = Math.max(0, f - reach); g <= Math.min(onset.length - 1, f + reach); g++) if (onset[g] > onset[best]) best = g;
    return best;
  });
  // A frame's flux peaks once its window holds the hit: half a window plus about one hop after the frame start
  // (600 samples, measured on click tracks at 90–150 BPM: median error under 5 ms).
  const beats = frames.map((f) => Math.round(((f * HOP + FRAME / 2 + 600) / SAMPLE_RATE) * 1000) / 1000);
  const phase = downbeatPhase(frames, onset, bass);
  // Loudness of each beat interval, scaled so the loud part of the song is near 1.
  const rms = beats.map((t, i) => {
    const a = Math.floor(t * SAMPLE_RATE), b = Math.floor((beats[i + 1] ?? duration) * SAMPLE_RATE);
    let s = 0; for (let k = a; k < b; k++) s += samples[k] * samples[k];
    return Math.sqrt(s / Math.max(1, b - a));
  });
  const sorted = [...rms].sort((x, y) => x - y), ref = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const energy = rms.map((v) => Math.round(Math.min(1, v / ref) * 1000) / 1000);
  const downbeats = beats.map((_, i) => i).filter((i) => i % 4 === phase);
  // A lift: the next two bars are clearly louder than the two before (a drop, a chorus coming in).
  const mean = (a, b) => { const s = energy.slice(Math.max(0, a), Math.max(0, b)); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0; };
  const candidates = downbeats.filter((i) => i >= 8 && mean(i, i + 8) - mean(i - 8, i) > 0.18).map((i) => ({beat: i, t: beats[i], rise: Math.round((mean(i, i + 8) - mean(i - 8, i)) * 1000) / 1000}));
  // One lift per change: neighbouring bars around a single rise all score, so keep only the strongest within four bars.
  const lifts = candidates.filter((c) => !candidates.some((o) => o !== c && Math.abs(o.beat - c.beat) <= 16 && (o.rise > c.rise || (o.rise === c.rise && o.beat < c.beat))));
  return {duration: Math.round(duration * 1000) / 1000, bpm: Math.round(bpm * 10) / 10, beats, downbeats, energy, lifts};
}

/** The best window of about `target` seconds, bar to bar: the loudest stretch, with a lift inside when there is one. */
export function chooseWindow(music, target) {
  const {beats, downbeats, energy, duration} = music;
  if (!beats.length || duration <= target + 0.5) return {start: 0, end: duration, fromBeat: 0, toBeat: beats.length};
  let best = null;
  for (const a of downbeats) {
    const end = beats[a] + target;
    const b = downbeats.find((i) => beats[i] >= end - 0.01) ?? null;
    if (b === null) break;
    const slice = energy.slice(a, b), avg = slice.reduce((x, y) => x + y, 0) / Math.max(1, slice.length);
    const lift = music.lifts.some((l) => l.beat > a && l.beat < b - 4) ? 0.15 : 0;
    const score = avg + lift - Math.abs(beats[b] - beats[a] - target) / target;
    if (!best || score > best.score) best = {score, fromBeat: a, toBeat: b};
  }
  if (!best) return {start: 0, end: Math.min(duration, target), fromBeat: 0, toBeat: beats.findIndex((t) => t >= target)};
  return {start: beats[best.fromBeat], end: beats[best.toBeat], fromBeat: best.fromBeat, toBeat: best.toBeat};
}
