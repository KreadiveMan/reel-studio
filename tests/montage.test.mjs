import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SAMPLE_RATE, analyzeSamples, chooseWindow} from '../scripts/lib/montage/beats.mjs';
import {bestMoment} from '../scripts/lib/montage/media.mjs';
import {FPS, beatsFor, buildPlan, checkPlan} from '../scripts/lib/montage/plan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(path.join(ROOT, 'state', 'tmp'), {recursive: true});

// A click track: a low kick on every bar start, a brighter click on the other beats, louder from `liftAt` seconds.
function clicks(bpm, seconds, {liftAt = Infinity, first = 0.37} = {}) {
  const s = new Float32Array(SAMPLE_RATE * seconds), period = 60 / bpm;
  for (let b = 0; first + b * period < seconds; b++) {
    const start = Math.floor((first + b * period) * SAMPLE_RATE), bar = b % 4 === 0, loud = first + b * period >= liftAt ? 2.2 : 1;
    for (let i = 0; i < 2000 && start + i < s.length; i++) s[start + i] += Math.sin(i * (bar ? 0.02 : 0.25)) * Math.exp(-i / 300) * (bar ? 0.4 : 0.2) * loud;
  }
  return s;
}

test('tempo, beats and bar starts are found on click tracks within a few milliseconds', () => {
  for (const bpm of [90, 128, 150]) {
    const a = analyzeSamples(clicks(bpm, 30)), period = 60 / bpm;
    assert.ok(Math.abs(a.bpm - bpm) < 1.2, `${bpm} BPM read as ${a.bpm}`);
    const errors = a.beats.map((t) => Math.abs(t - (0.37 + Math.round((t - 0.37) / period) * period)) * 1000).sort((x, y) => x - y);
    assert.ok(errors[Math.floor(errors.length / 2)] < 15, `median beat error ${errors[Math.floor(errors.length / 2)]} ms`);
    const bar = a.beats[a.downbeats[0]];
    assert.ok(Math.abs(((bar - 0.37) / period) % 4) < 0.3 || Math.abs(((bar - 0.37) / period) % 4 - 4) < 0.3, `${bpm}: the first bar start sits on a kick`);
  }
});

test('a rise in the music is one lift, and the window is bar to bar around it', () => {
  const a = analyzeSamples(clicks(120, 40, {liftAt: 20.37}));
  assert.equal(a.lifts.length, 1);
  assert.ok(Math.abs(a.lifts[0].t - 20.37) < 0.1, `lift at ${a.lifts[0].t}`);
  const w = chooseWindow(a, 16);
  assert.ok(a.downbeats.includes(w.fromBeat) && a.downbeats.includes(w.toBeat));
  assert.ok(Math.abs(w.end - w.start - 16) < 0.6);
  assert.ok(w.start < 20.37 && w.end > 20.37, 'the window holds the lift');
});

test('the best moment of a video avoids dark and already used stretches', () => {
  const media = {duration: 10, fps: 2, motion: [], brightness: []};
  for (let t = 0; t <= 10; t += 0.5) { media.motion.push({t, v: t < 3 ? 30 : t > 6 ? 12 : 4}); media.brightness.push({t, v: t < 3 ? 5 : 120}); }
  const first = bestMoment(media, 2);
  assert.ok(first.from >= 3, 'the dark but busy start is skipped');
  const second = bestMoment(media, 2, [{from: first.from, to: first.from + 2}]);
  assert.ok(second.from >= first.from + 2.2 || second.from + 2 <= first.from - 0.2, 'no overlap with the used stretch');
});

test('the plan cuts on beats, fills the window exactly, marks the lift and spreads the photos', () => {
  const music = analyzeSamples(clicks(120, 40, {liftAt: 20.37}));
  const window = chooseWindow(music, 16);
  const video = (name) => ({path: `Raw/${name}.mp4`, kind: 'video', duration: 20, fps: 2, motion: [{t: 0, v: 10}, {t: 20, v: 10}], brightness: [{t: 0, v: 100}, {t: 20, v: 100}]});
  const media = [video('a'), {path: 'Raw/p.jpg', kind: 'image'}, video('b'), {path: 'Raw/q.png', kind: 'image'}];
  const plan = buildPlan({id: 'x', music, musicPath: 'Raw/song.mp3', window, media, pace: 'medium'});
  assert.deepEqual(checkPlan(plan), []);
  assert.equal(plan.shots.reduce((n, s) => n + s.frames, 0), plan.totalFrames);
  const beatFrames = new Set(music.beats.map((t) => Math.round((t - window.start) * FPS)));
  for (const shot of plan.shots.slice(1)) assert.ok([-1, 0, 1].some((d) => beatFrames.has(Math.round(shot.at * FPS) + d)), `cut at ${shot.at}s is on a beat`);
  assert.ok(plan.shots.every((s) => s.kind === 'image' ? !!s.move : s.from >= 0));
  for (let i = 1; i < plan.shots.length; i++) assert.ok(!(plan.shots[i].kind === 'image' && plan.shots[i - 1].kind === 'image'), 'photos never back to back');
  const liftShot = plan.shots.find((s) => s.flash);
  assert.ok(liftShot?.punch, 'the lift cut punches in and flashes');
  assert.ok(plan.sfx.some((h) => h.sound === 'impact' && Math.abs(h.t - liftShot.at) < 0.05));
  assert.ok(plan.sfx.some((h) => h.sound === 'riser' && h.t < liftShot.at));
  const calm = buildPlan({id: 'x', music, musicPath: 'Raw/song.mp3', window, media, pace: 'calm'});
  const fast = buildPlan({id: 'x', music, musicPath: 'Raw/song.mp3', window, media, pace: 'fast'});
  assert.ok(fast.shots.length > plan.shots.length && plan.shots.length > calm.shots.length, 'pace changes the cut rate');
  assert.deepEqual([beatsFor(0.9, 'fast'), beatsFor(0.2, 'calm')], [1, 8]);
});

test('a short montage renders muted video and a moving photo to the delivery spec with the music', async () => {
  const {renderPlan} = await import('../scripts/lib/montage/render.mjs');
  const dir = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'montage-test-'));
  const rel = (name) => path.relative(ROOT, path.join(dir, name)).split(path.sep).join('/');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*60*t)*exp(-20*mod(t,0.5))':s=44100:d=6", '-y', path.join(dir, 'song.wav')]);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=f=3000:d=4', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', path.join(dir, 'clip.mp4')]);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=400x300', '-frames:v', '1', '-y', path.join(dir, 'photo.jpg')]);
    const plan = {version: 1, kind: 'beat-montage', id: 'test', width: 1080, height: 1920, fps: 30, totalFrames: 90,
      music: {path: rel('song.wav'), start: 0, duration: 3, bpm: 120, fadeIn: 0, fadeOut: 0.5, gain: 1},
      shots: [{media: rel('clip.mp4'), kind: 'video', at: 0, frames: 45, from: 1}, {media: rel('photo.jpg'), kind: 'image', at: 1.5, frames: 45, move: 'zoom-in', punch: true, flash: true}],
      sfx: [{t: 1.5, sound: 'impact', gain: 0.07, opts: {dur: 0.4}}]};
    const out = path.join(dir, 'out.mp4');
    const result = await renderPlan(plan, out, {mode: 'preview'});
    assert.ok(result.renderSeconds > 0);
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', out], {encoding: 'utf8'}).stdout);
    const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio');
    assert.deepEqual([v.width, v.height, v.r_frame_rate, Number(v.nb_read_frames), v.profile, v.pix_fmt], [1080, 1920, '30/1', 90, 'High', 'yuv420p']);
    assert.deepEqual([a.codec_name, Number(a.sample_rate), a.channels], ['aac', 48000, 2]);
    // The clip's 3 kHz tone is gone: the mix holds the 60 Hz music and the effect only.
    const tone = spawnSync('ffmpeg', ['-v', 'info', '-i', out, '-af', 'highpass=f=2500,lowpass=f=3500,volumedetect', '-vn', '-f', 'null', '-'], {encoding: 'utf8'}).stderr;
    assert.ok(Number(/mean_volume: (-?[\d.]+) dB/.exec(tone)[1]) < -45, 'the video sound is removed');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the montage command takes named files from Raw only', () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/montage.mjs', ...args], {cwd: ROOT, encoding: 'utf8'});
  const outside = run('analyze', '--id', 'x-test', '--music', 'state/song.mp3', '--media', 'Raw/a.mp4');
  assert.equal(outside.status, 1); assert.match(outside.stderr, /Raw/);
  const climbing = run('analyze', '--id', 'x-test', '--music', 'Raw/../versions.lock.json', '--media', 'Raw/a.mp4');
  assert.equal(climbing.status, 1);
  assert.equal(run('analyze', '--id', 'Bad Id').status, 1);
  assert.equal(run('nonsense').status, 2);
});
