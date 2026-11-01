import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';

// What the beat montage needs to know about each picture: its kind, size and length, and for a video how
// much it moves and how bright it is over time, sampled a few times per second. Moving, well-lit moments
// make the best cuts; black or frozen stretches are avoided.

const IMAGE = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic)$/i;
const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mts)$/i;
export const MUSIC = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
export const isImage = (file) => IMAGE.test(file);
export const isVideo = (file) => VIDEO.test(file);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({out, err}) : reject(new Error(err.trim().split('\n').at(-1) || `${command} exited ${code}`)));
  });
}

export async function probe(file) {
  const {out} = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,duration:stream_side_data=rotation', '-of', 'json', file]);
  const data = JSON.parse(out);
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  const rotation = Math.abs(Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180 === 90;
  return {width: rotation ? video?.height : video?.width, height: rotation ? video?.width : video?.height,
    duration: Number(data.format?.duration ?? video?.duration ?? 0) || 0, hasAudio: !!audio, hasVideo: !!video};
}

// Two light FFmpeg passes on a 96-pixel greyscale copy: the frame-to-frame difference (motion) and the plain luma
// average (brightness), each written as per-frame metadata to a temporary file.
async function curve(file, fps, chain) {
  const out = path.join(os.tmpdir(), `montage-${randomUUID()}.txt`);
  try {
    await run('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', `fps=${fps},scale=96:-2,format=gray,${chain}signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${out}`, '-f', 'null', '-']);
    const list = []; let t = null;
    for (const line of (await fs.readFile(out, 'utf8')).split('\n')) {
      const time = /pts_time:([\d.]+)/.exec(line); if (time) t = Number(time[1]);
      const value = /YAVG=([\d.]+)/.exec(line); if (value && t !== null) list.push({t: Math.round(t * 100) / 100, v: Math.round(Number(value[1]) * 10) / 10});
    }
    return list;
  } finally { await fs.rm(out, {force: true}); }
}
const samples = async (file, fps) => ({motion: await curve(file, fps, 'tblend=all_mode=difference,'), brightness: await curve(file, fps, '')});

/** Kind, size, length and (for videos) motion and brightness curves. */
export async function analyzeMedia(file) {
  const kind = isImage(file) ? 'image' : isVideo(file) ? 'video' : null;
  if (!kind) throw new Error(`${path.basename(file)} مش فيديو ولا صورة.`);
  const info = await probe(file);
  if (!info.hasVideo || !info.width || !info.height) throw new Error(`${path.basename(file)} مش مقروء كصورة أو فيديو.`);
  if (kind === 'image') return {kind, width: info.width, height: info.height};
  const fps = info.duration > 120 ? 1 : info.duration > 30 ? 2 : 4;
  const curves = await samples(file, fps);
  return {kind, width: info.width, height: info.height, duration: Math.round(info.duration * 1000) / 1000, hasAudio: info.hasAudio, fps, ...curves};
}

/**
 * The best start for a `length`-second piece of a video: most motion, not dark, away from the very start and end
 * and from ranges already used. Returns null when nothing is free.
 */
export function bestMoment(media, length, used = []) {
  const end = media.duration - length;
  if (end < 0) return used.length ? null : {from: 0, score: 0};
  const value = (list, t) => { let best = null; for (const p of list) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; return best?.v ?? 0; };
  const step = Math.max(0.1, 1 / media.fps);
  let best = null;
  for (let from = Math.min(0.3, end); from <= end + 1e-6; from += step) {
    if (used.some((u) => from < u.to + 0.2 && from + length > u.from - 0.2)) continue;
    let motion = 0, dark = 0, n = 0;
    // Motion is capped so a single hard cut inside the source (a jump from black, a camera switch) does not win alone.
    for (let t = from; t <= from + length + 1e-6; t += step) { motion += Math.min(40, value(media.motion, t)); dark += value(media.brightness, t) < 22 ? 1 : 0; n++; }
    const score = motion / n - 30 * (dark / n);
    if (!best || score > best.score) best = {from: Math.round(from * 100) / 100, score};
  }
  return best;
}
