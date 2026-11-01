import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {cpuThreads} from './cpu-budget.mjs';

// Joins several recordings into one source file for one reel. See scripts/join-recordings.mjs for the rules.
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').slice(-2).join(' | ') || `${command} exited ${code}`)));
  });
}

async function probe(file) {
  const data = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,codec_tag_string,width,height,pix_fmt,r_frame_rate,sample_rate,channels,color_transfer,color_primaries,color_space:stream_side_data=rotation', '-of', 'json', file]));
  const v = data.streams.find((s) => s.codec_type === 'video'), a = data.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`${file}: مفيهوش فيديو.`);
  const rotation = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  return {duration: Number(data.format.duration), video: v, audio: a, rotation,
    key: JSON.stringify([v.codec_name, v.codec_tag_string, v.width, v.height, v.pix_fmt, v.r_frame_rate, v.color_transfer, rotation, a?.codec_name, a?.sample_rate, a?.channels])};
}

/** Joins `sources` (paths relative to `root`) into `dir`/joined.<ext> and writes `dir`/join.json. */
export async function joinFiles(root, sources, dir) {
  const infos = [];
  for (const s of sources) infos.push(await probe(path.join(root, ...s.split('/'))));
  await fs.mkdir(dir, {recursive: true});
  const same = infos.every((i) => i.key === infos[0].key) && infos.every((i) => !!i.audio === !!infos[0].audio);
  const ext = same ? (path.extname(sources[0]).toLowerCase() === '.mp4' ? '.mp4' : '.mov') : '.mov';
  const out = path.join(dir, `joined${ext}`), partial = path.join(dir, `.joined-${process.pid}${ext}`);
  const started = Date.now();
  try {
    if (same) {
      const list = path.join(dir, `.join-${process.pid}.txt`);
      await fs.writeFile(list, sources.map((s) => `file '${path.join(root, ...s.split('/')).replaceAll("'", "'\\''")}'`).join('\n'));
      try {
        await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', ...(infos[0].audio ? ['-map', '0:a:0'] : []), '-c', 'copy', '-movflags', '+faststart', '-y', partial]);
      } finally { await fs.rm(list, {force: true}); }
    } else {
      // Different cameras or settings: one re-encode to the first recording's picture, sound kept at 48 kHz stereo.
      const first = infos[0].video, upright = Math.abs(infos[0].rotation) % 180 === 90;
      const width = upright ? first.height : first.width, height = upright ? first.width : first.height;
      const hdr = ['arib-std-b67', 'smpte2084'].includes(first.color_transfer);
      const inputs = sources.flatMap((s) => ['-i', path.join(root, ...s.split('/'))]);
      const legs = infos.map((info, i) => {
        const video = `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${first.r_frame_rate},format=${hdr ? 'yuv420p10le' : 'yuv420p'}[v${i}]`;
        const audio = info.audio ? `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${i}]` : `anullsrc=r=48000:cl=stereo,atrim=0:${info.duration}[a${i}]`;
        return `${video};${audio}`;
      });
      const graph = `${legs.join(';')};${infos.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${infos.length}:v=1:a=1[v][a]`;
      const codec = hdr
        ? ['-c:v', 'libx265', '-crf', '16', '-preset', 'medium', '-tag:v', 'hvc1', '-color_primaries', first.color_primaries ?? 'bt2020', '-color_trc', first.color_transfer, '-colorspace', first.color_space ?? 'bt2020nc']
        : ['-c:v', 'libx264', '-crf', '15', '-preset', 'medium', '-pix_fmt', 'yuv420p'];
      await run('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-threads', String(cpuThreads()), ...codec, '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-y', partial]);
    }
    await fs.rename(partial, out);
  } finally { await fs.rm(partial, {force: true}); }
  // Where each recording starts in the joined file, for cut decisions and for choosing between takes.
  let at = 0;
  const parts = sources.map((s, i) => { const part = {source: s, start: Math.round(at * 1000) / 1000, duration: Math.round(infos[i].duration * 1000) / 1000}; at += infos[i].duration; return part; });
  const record = {version: 1, joined: path.relative(root, out).split(path.sep).join('/'), method: same ? 'stream-copy' : 're-encode', parts, totalSeconds: Math.round(at * 1000) / 1000, seconds: Math.round((Date.now() - started) / 100) / 10};
  await fs.writeFile(path.join(dir, 'join.json'), `${JSON.stringify(record, null, 1)}\n`);
  return record;
}
