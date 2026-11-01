import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {ROOT} from '../project-paths.mjs';
import {createRenderProgress} from '../render-progress.mjs';
import {FPS, WIDTH, HEIGHT} from './plan.mjs';
import {cpuThreads} from '../cpu-budget.mjs';

// Renders a beat-montage plan with FFmpeg: every shot becomes an exact-length 1080×1920 clip (videos muted,
// photos moving), the clips are joined and encoded once to the studio's delivery spec (H.264 High 4.1, closed
// 2-second GOP, VBV 20M/40M, yuv420p BT.709), and the sound is the music window plus the synthesized sound
// design stem, mixed and normalised to -14 LUFS / -1 dBTP, AAC 48 kHz stereo.

function run(command, args, {cwd = ROOT} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({out, err}) : reject(new Error(`${path.basename(command)} failed: ${err.trim().split('\n').slice(-3).join(' | ')}`)));
  });
}

const cover = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1`;

/** FFmpeg arguments for one shot (exported for tests). */
export function shotArgs(shot, file, out, {preview = false} = {}) {
  const n = shot.frames, seconds = n / FPS;
  const encode = ['-an', '-threads', '2', '-c:v', 'libx264', '-preset', preview ? 'ultrafast' : 'veryfast', '-crf', preview ? '20' : '14', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-frames:v', String(n), '-y', out];
  const extras = [];
  if (shot.punch) extras.push(`zoompan=z='if(lt(on,8),1.12-0.12*on/8,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}`);
  if (shot.flash) extras.push('fade=t=in:st=0:d=0.15:color=white');
  if (shot.kind === 'image') {
    const z = {'zoom-in': `1+0.10*on/${n}`, 'zoom-out': `1.10-0.10*on/${n}`, 'pan-left': '1.10', 'pan-right': '1.10'}[shot.move] ?? '1';
    const x = shot.move === 'pan-left' ? `(iw-iw/zoom)*(1-on/${n})` : shot.move === 'pan-right' ? `(iw-iw/zoom)*on/${n}` : 'iw/2-(iw/zoom/2)';
    const chain = [`scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase`, `crop=${WIDTH * 2}:${HEIGHT * 2}`,
      `zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${n}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`, 'setsar=1', ...extras, 'format=yuv420p'];
    return ['-v', 'error', '-i', file, '-vf', chain.join(','), ...encode];
  }
  const chain = [`fps=${FPS}`, cover, `tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds + 1)}`, ...extras, 'format=yuv420p'];
  return ['-v', 'error', '-ss', String(shot.from ?? 0), '-t', String(seconds + 0.5), '-i', file, '-vf', chain.join(','), ...encode];
}

async function pool(items, jobs, work) {
  let next = 0;
  await Promise.all(Array.from({length: Math.min(jobs, items.length)}, async () => { while (next < items.length) { const i = next++; await work(items[i], i); } }));
}

/** Renders the plan to `out`. mode: preview | deliver. Returns timing and the audio measurement. */
export async function renderPlan(plan, out, {mode = 'preview', log = () => {}} = {}) {
  const preview = mode === 'preview';
  const work = path.join(path.dirname(out), `.montage-work-${process.pid}`);
  await fs.rm(work, {recursive: true, force: true});
  await fs.mkdir(work, {recursive: true});
  const progress = createRenderProgress({out, mode, frames: plan.totalFrames});
  const started = Date.now();
  try {
    // 1. Shots, in parallel.
    let done = 0;
    const parts = plan.shots.map((_, i) => path.join(work, `shot-${String(i).padStart(4, '0')}.mp4`));
    // Shots run side by side, two FFmpeg threads each, inside the studio CPU share.
    await pool(plan.shots, Math.max(1, Math.floor(cpuThreads() / 2)), async (shot, i) => {
      await run('ffmpeg', shotArgs(shot, path.join(ROOT, ...shot.media.split('/')), parts[i], {preview}));
      done++;
      progress.frames({percent: (done / plan.shots.length) * 100});
      log(`shot ${done}/${plan.shots.length}`);
    });

    // 2. Sound: music window with fades, the sound-design stem, mixed and normalised in two passes.
    progress.phase('audio', 91);
    const seconds = plan.totalFrames / FPS;
    const music = path.join(ROOT, ...plan.music.path.split('/'));
    const hits = path.join(work, 'hits.json'), stem = path.join(work, 'sfx.wav'), mixed = path.join(work, 'mix.wav');
    await fs.writeFile(hits, JSON.stringify(plan.sfx ?? []));
    await run(process.execPath, [path.join(ROOT, 'scripts', 'sfx.mjs'), '--hits', hits, '--dur', String(seconds), '--out', stem]);
    const fades = [plan.music.fadeIn > 0 ? `afade=t=in:st=0:d=${plan.music.fadeIn}` : null, plan.music.fadeOut > 0 ? `afade=t=out:st=${Math.max(0, seconds - plan.music.fadeOut)}:d=${plan.music.fadeOut}` : null].filter(Boolean);
    const mixGraph = `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${plan.music.gain ?? 1}${fades.length ? ',' + fades.join(',') : ''}[m];[1:a]aresample=48000,aformat=channel_layouts=stereo[s];[m][s]amix=inputs=2:normalize=0:duration=first`;
    const audioIn = ['-ss', String(plan.music.start), '-t', String(seconds), '-i', music, '-i', stem];
    const measure = await run('ffmpeg', ['-v', 'info', '-hide_banner', ...audioIn, '-filter_complex', `${mixGraph},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-']);
    const m = JSON.parse(measure.err.slice(measure.err.lastIndexOf('{'), measure.err.lastIndexOf('}') + 1));
    await run('ffmpeg', ['-v', 'error', ...audioIn, '-filter_complex',
      `${mixGraph},loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
      '-t', String(seconds), '-c:a', 'pcm_s16le', '-y', mixed]);

    // 3. Join, encode once to the delivery spec, and add the sound.
    progress.phase('finalize', 93);
    const list = path.join(work, 'list.txt');
    await fs.writeFile(list, parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n'));
    const temporary = `${out}.partial.mp4`;
    await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', mixed, '-map', '0:v:0', '-map', '1:a:0',
      '-threads', String(cpuThreads()), '-c:v', 'libx264', '-preset', preview ? 'veryfast' : 'medium', '-crf', preview ? '21' : '18', '-maxrate', '20M', '-bufsize', '40M',
      '-profile:v', 'high', '-level:v', '4.1', '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0', '-flags', '+cgop',
      '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2', '-frames:v', String(plan.totalFrames), '-movflags', '+faststart', '-y', temporary]);
    await fs.rename(temporary, out);
    progress.done();
    return {renderSeconds: Math.round((Date.now() - started) / 100) / 10, loudness: {inputLUFS: Number(m.input_i), targetLUFS: -14}};
  } finally {
    await fs.rm(work, {recursive: true, force: true});
  }
}
