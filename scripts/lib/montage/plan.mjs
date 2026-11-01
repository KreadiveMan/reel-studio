import {bestMoment} from './media.mjs';

// The beat montage plan: which picture plays on which beats, and the sound design on top of the music.
// Pure function of the analysis, so the same inputs always give the same edit, and the plan file it writes is
// the editable record (Claude or the creator can change a shot and render again).
//
// Pacing follows the music: loud stretches cut every one or two beats, calm stretches hold for a bar or two,
// and every cut lands on a beat (longer shots on bar starts). Where the music lifts (a drop, a chorus coming in)
// the cut gets a punch-in and the sound design marks it: a riser into it and an impact on it. Videos play
// muted; photos move slowly (zoom or pan) so nothing sits still.

export const FPS = 30;
export const WIDTH = 1080, HEIGHT = 1920;
const PACES = {calm: [4, 8, 8], medium: [2, 4, 8], fast: [1, 2, 4]};
const IMAGE_MOVES = ['zoom-in', 'pan-left', 'zoom-out', 'pan-right'];

const frame = (t) => Math.round(t * FPS);

/** Beats per shot for a loudness 0..1 at the given pace. */
export function beatsFor(energy, pace = 'medium') {
  const [loud, middle, quiet] = PACES[pace] ?? PACES.medium;
  return energy >= 0.75 ? loud : energy >= 0.45 ? middle : quiet;
}

/**
 * Builds the plan. `music` is the beat analysis with the chosen `window`; `media` is a list of
 * {path, kind, ...analysis}. Options: pace (calm|medium|fast), id.
 */
export function buildPlan({id, music, musicPath, window, media, pace = 'medium'}) {
  if (!media.length) throw new Error('محتاج فيديو أو صورة واحدة على الأقل.');
  const beats = music.beats.slice(window.fromBeat, window.toBeat + 1).map((t) => t - window.start);
  const energy = music.energy.slice(window.fromBeat, window.toBeat);
  const downbeat = new Set(music.downbeats.filter((i) => i >= window.fromBeat && i <= window.toBeat).map((i) => i - window.fromBeat));
  const lifts = new Map(music.lifts.filter((l) => l.beat > window.fromBeat && l.beat < window.toBeat).map((l) => [l.beat - window.fromBeat, l.rise]));
  const totalFrames = frame(window.end - window.start);
  if (beats.length < 2) throw new Error('الموسيقى قصيرة أوي أو ملهاش إيقاع واضح.');

  // 1. Cut points on the beat grid.
  const cuts = [0];
  for (let i = 0; i < beats.length - 1;) {
    let step = beatsFor(energy[i] ?? 0.5, pace);
    // A lift ahead inside this shot: cut exactly on it.
    for (let k = 1; k < step; k++) if (lifts.has(i + k)) { step = k; break; }
    let next = Math.min(i + step, beats.length - 1);
    // Shots of a bar or more end on a bar start when one is within two beats.
    if (step >= 4 && !downbeat.has(next)) for (const d of [1, -1, 2, -2]) if (downbeat.has(next + d) && next + d > i && next + d < beats.length) { next += d; break; }
    cuts.push(next); i = next;
  }

  // 2. Pictures in order, spread so photos never sit back to back when videos can sit between them.
  const videos = media.filter((m) => m.kind === 'video'), images = media.filter((m) => m.kind === 'image');
  const order = [];
  const shotsNeeded = cuts.length - 1;
  const ratio = images.length / Math.max(1, media.length);
  let vi = 0, ii = 0;
  for (let s = 0; s < shotsNeeded; s++) {
    const wantImage = images.length && (!videos.length || (order.at(-1)?.kind !== 'image' && (s + 1) * ratio >= ii + 0.5));
    if (wantImage) order.push(images[ii++ % images.length]); else order.push(videos[vi++ % videos.length]);
  }

  // 3. Shots with source moments, image moves and lift effects.
  const used = new Map();
  const shots = [];
  let biggestLift = null;
  for (const [beat, rise] of lifts) if (!biggestLift || rise > biggestLift.rise) biggestLift = {beat, rise};
  for (let s = 0; s < shotsNeeded; s++) {
    const a = cuts[s], b = cuts[s + 1], m = order[s];
    const startFrame = frame(beats[a]), endFrame = s === shotsNeeded - 1 ? totalFrames : frame(beats[b]);
    const frames = endFrame - startFrame;
    // A sliver (under three frames) joins the shot before it so the total length stays exact.
    if (frames < 3 && shots.length) { shots.at(-1).frames += frames; continue; }
    const seconds = frames / FPS;
    const shot = {media: m.path, kind: m.kind, at: Math.round((startFrame / FPS) * 1000) / 1000, frames};
    if (m.kind === 'video') {
      const ranges = used.get(m.path) ?? [];
      const moment = bestMoment(m, seconds, ranges) ?? bestMoment(m, seconds) ?? {from: 0};
      shot.from = moment.from;
      ranges.push({from: moment.from, to: moment.from + seconds}); used.set(m.path, ranges);
    } else shot.move = IMAGE_MOVES[s % IMAGE_MOVES.length];
    if (lifts.has(a)) shot.punch = true;
    if (biggestLift && biggestLift.beat === a) shot.flash = true;
    shots.push(shot);
  }

  // 4. Sound design over the music: marks only where the picture and the music turn together, never a carpet.
  const sfx = [];
  const at = (beat) => beats[beat];
  for (const [beat] of lifts) {
    if (at(beat) >= 0.9) sfx.push({t: Math.round((at(beat) - 0.8) * 1000) / 1000, sound: 'riser', gain: 0.05, opts: {dur: 0.8}});
    sfx.push({t: at(beat), sound: 'impact', gain: 0.07, opts: {dur: 0.5}});
  }
  // A soft air push into every second bar-start cut in the loud parts, at most one every two seconds.
  let last = -Infinity, barCuts = 0;
  for (const c of cuts.slice(1, -1)) {
    if (!downbeat.has(c) || lifts.has(c) || (energy[c] ?? 0) < 0.6) continue;
    if (barCuts++ % 2) continue;
    const t = at(c) - 0.12;
    if (t - last < 2 || t < 0.3) continue;
    sfx.push({t: Math.round(t * 1000) / 1000, sound: 'whooshSoft', gain: 0.035, opts: {dur: 0.22}}); last = t;
  }
  sfx.sort((x, y) => x.t - y.t);

  return {
    version: 1, kind: 'beat-montage', id, width: WIDTH, height: HEIGHT, fps: FPS, pace,
    music: {path: musicPath, start: window.start, duration: Math.round((window.end - window.start) * 1000) / 1000, bpm: music.bpm,
      fadeIn: window.start > 0.05 ? 0.25 : 0, fadeOut: Math.min(1.5, (window.end - window.start) / 6), gain: 1},
    totalFrames, shots, sfx,
    notes: {cuts: shots.length, lifts: [...lifts.keys()].map((b) => at(b)), videos: videos.length, images: images.length},
  };
}

/** Plain checks for a hand-edited plan before it renders. */
export function checkPlan(plan) {
  const problems = [];
  if (plan?.kind !== 'beat-montage') problems.push('الملف مش خطة مونتاج.');
  let frames = 0;
  for (const [i, s] of (plan?.shots ?? []).entries()) {
    if (!Number.isInteger(s.frames) || s.frames < 1) problems.push(`اللقطة ${i + 1}: عدد الفريمات غلط.`);
    if (!['video', 'image'].includes(s.kind)) problems.push(`اللقطة ${i + 1}: نوعها مش معروف.`);
    if (s.kind === 'video' && !(s.from >= 0)) problems.push(`اللقطة ${i + 1}: بدايتها في الفيديو ناقصة.`);
    frames += s.frames || 0;
  }
  if (plan?.shots?.length && frames !== plan.totalFrames) problems.push(`مجموع اللقطات ${frames} فريم والمدة ${plan.totalFrames}.`);
  return problems;
}
