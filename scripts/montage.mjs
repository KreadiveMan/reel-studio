import './lib/project-tmp.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {ROOT, assertProjectOutput} from './lib/project-paths.mjs';
import {analyzeSamples, chooseWindow, decodeMono} from './lib/montage/beats.mjs';
import {MUSIC, analyzeMedia, isImage, isVideo} from './lib/montage/media.mjs';
import {FPS, buildPlan, checkPlan} from './lib/montage/plan.mjs';
import {renderPlan} from './lib/montage/render.mjs';

// Beat montage: music plus videos and photos (no speech) cut on the beat with sound design. instructions/MONTAGE.md.
//   node scripts/montage.mjs analyze --id my-reel --music Raw/song.mp3 --media Raw/a.mp4,Raw/b.jpg [--duration 30]
//   node scripts/montage.mjs plan    --id my-reel [--pace calm|medium|fast] [--duration 30] [--start 12.5]
//   node scripts/montage.mjs render  --id my-reel [--deliver]
//   node scripts/montage.mjs run     --id my-reel --music … --media … [--duration] [--pace]   (all three, preview)
//   node scripts/montage.mjs publish --id my-reel                    copy the delivered file to Outputs/<id>/ with a cover
const {values, positionals} = parseArgs({args: process.argv.slice(2), allowPositionals: true, strict: true, options: {
  id: {type: 'string'}, music: {type: 'string'}, media: {type: 'string'}, duration: {type: 'string'}, start: {type: 'string'},
  pace: {type: 'string'}, deliver: {type: 'boolean'}}});
const command = positionals[0];
const USAGE = 'Usage: node scripts/montage.mjs analyze|plan|render|run|publish --id <slug> [--music Raw/x.mp3 --media Raw/a.mp4,Raw/b.jpg] [--duration s] [--start s] [--pace calm|medium|fast] [--deliver]';
const say = (line, extra = {}) => console.log(JSON.stringify({ok: true, message: line, ...extra}));

function slug() {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(values.id ?? '')) throw new Error('--id must be a project slug such as my-reel.');
  return values.id;
}
const dir = (...parts) => assertProjectOutput(path.join(ROOT, 'Projects', slug(), ...parts));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// Named sources only, and only from Raw/.
async function source(file, test, what) {
  const clean = String(file ?? '').trim().replaceAll('\\', '/');
  if (!clean.startsWith('Raw/') || clean.split('/').some((p) => p === '..' || !p)) throw new Error(`${what} لازم يكون من فولدر Raw: ${clean || '(فاضي)'}`);
  if (!test(clean)) throw new Error(`${clean} مش ${what}.`);
  const stat = await fs.stat(path.join(ROOT, ...clean.split('/'))).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${clean} مش موجود.`);
  return clean;
}
const seconds = (v, name) => { if (v === undefined) return null; const n = Number(v); if (!(n > 0 && n <= 600)) throw new Error(`${name} لازم يكون عدد ثواني من 1 لـ 600.`); return n; };

async function analyze() {
  const music = await source(values.music, (f) => MUSIC.test(f) || isVideo(f), 'ملف موسيقى');
  const list = String(values.media ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('محتاج فيديو أو صورة واحدة على الأقل (--media).');
  const media = [];
  for (const file of list) media.push({path: await source(file, (f) => isVideo(f) || isImage(f), 'فيديو أو صورة'), ...await analyzeMedia(path.join(ROOT, ...file.split('/')))});
  const samples = await decodeMono(path.join(ROOT, ...music.split('/')));
  if (samples.length < 22050 * 4) throw new Error('الموسيقى أقصر من 4 ثواني.');
  const analysis = {version: 1, id: slug(), music: {path: music, ...analyzeSamples(samples)}, media, target: seconds(values.duration, '--duration') ?? 30};
  await fs.mkdir(dir('montage'), {recursive: true});
  await fs.writeFile(dir('montage', 'analysis.json'), `${JSON.stringify(analysis, null, 1)}\n`);
  return analysis;
}

function planText(plan) {
  const name = (p) => p.split('/').at(-1);
  const rows = plan.shots.map((s, i) => `| ${i + 1} | ${(s.at).toFixed(2)} ث | ${(s.frames / FPS).toFixed(2)} ث | ${name(s.media)} | ${s.kind === 'video' ? `من ${s.from} ث (من غير صوت)` : `صورة · ${{'zoom-in': 'زووم لجوه', 'zoom-out': 'زووم لبرّه', 'pan-left': 'حركة للشمال', 'pan-right': 'حركة لليمين'}[s.move]}`}${s.punch ? ' · دخلة قوية' : ''}${s.flash ? ' · فلاش' : ''} |`);
  const sounds = {riser: 'صوت بيعلى قبل الدروب', impact: 'ضربة على الدروب', whooshSoft: 'هوا خفيف على القطعة'};
  return [`# خطة المونتاج: ${plan.id}`, '',
    `الموسيقى: \`${plan.music.path}\` من ${plan.music.start.toFixed(2)} ث، المدة ${plan.music.duration.toFixed(1)} ث، الإيقاع ${plan.music.bpm} BPM. السرعة: ${{calm: 'هادية', medium: 'متوسطة', fast: 'سريعة'}[plan.pace]}.`,
    `${plan.shots.length} لقطة، كل القطعات على الضربات. صوت الفيديوهات متشال، والصوت هو الموسيقى والساوند ديزاين بس.`, '',
    '| # | يبدأ | المدة | الملف | اللقطة |', '| --- | --- | --- | --- | --- |', ...rows, '',
    `الساوند ديزاين (${plan.sfx.length}):`, ...(plan.sfx.length ? plan.sfx.map((h) => `- ${h.t.toFixed(2)} ث: ${sounds[h.sound] ?? h.sound}`) : ['- مفيش: الموسيقى من غير لحظات رفع واضحة.']), ''].join('\n');
}

async function plan() {
  const analysis = JSON.parse(await fs.readFile(dir('montage', 'analysis.json'), 'utf8').catch(() => { throw new Error('حلّل الأول: montage.mjs analyze'); }));
  const target = seconds(values.duration, '--duration') ?? analysis.target;
  let window = chooseWindow(analysis.music, target);
  const start = values.start === undefined ? null : Number(values.start);
  if (start !== null) {
    const {beats, downbeats} = analysis.music;
    const from = downbeats.reduce((best, i) => Math.abs(beats[i] - start) < Math.abs(beats[best] - start) ? i : best, downbeats[0]);
    const to = downbeats.find((i) => beats[i] >= beats[from] + target - 0.01) ?? beats.length - 1;
    window = {start: beats[from], end: beats[to], fromBeat: from, toBeat: to};
  }
  const pace = ['calm', 'medium', 'fast'].includes(values.pace) ? values.pace : 'medium';
  const result = buildPlan({id: slug(), music: analysis.music, musicPath: analysis.music.path, window, media: analysis.media, pace});
  await fs.writeFile(dir('montage', 'plan.json'), `${JSON.stringify(result, null, 1)}\n`);
  await fs.writeFile(dir('EDITORIAL_PLAN.md'), planText(result));
  return result;
}

async function render() {
  const planned = JSON.parse(await fs.readFile(dir('montage', 'plan.json'), 'utf8').catch(() => { throw new Error('اعمل الخطة الأول: montage.mjs plan'); }));
  const problems = checkPlan(planned);
  if (problems.length) throw new Error(problems.join('\n'));
  const mode = values.deliver ? 'deliver' : 'preview';
  await fs.mkdir(dir('renders'), {recursive: true});
  const out = dir('renders', `montage-${mode === 'deliver' ? 'delivery' : 'preview'}.mp4`);
  const result = await renderPlan(planned, out, {mode, log: (line) => process.stderr.write(`[montage] ${line}\n`)});
  // The studio's own delivery check, saved beside the file in the shape the dashboard reads.
  const {igCheck} = await import('./lib/ig.mjs');
  const ig = await igCheck(out, {channel: 'organic', withLoudness: true});
  const stat = await fs.stat(out);
  const qc = {ok: ig.ok !== false, comp: 'BeatMontage', mode, out, bytes: stat.size, frames: [0, planned.totalFrames - 1], timing: {totalSec: result.renderSeconds},
    igCheck: {ok: ig.ok, fails: ig.fails ?? [], warnings: ig.warnings ?? [], summary: ig.summary ?? ig}, motion: {exempt: 'beat-montage'}, head: {ran: false, status: 'NO-SPEECH'}};
  await fs.writeFile(`${out}.qc.json`, `${JSON.stringify(qc, null, 1)}\n`);
  return {out: rel(out), ...result, igCheck: {ok: ig.ok, fails: ig.fails ?? [], warnings: ig.warnings ?? []}};
}

async function publish() {
  const from = dir('renders', 'montage-delivery.mp4');
  if (!(await fs.stat(from).catch(() => null))) throw new Error('مفيش نسخة تسليم: montage.mjs render --deliver');
  const outDir = assertProjectOutput(path.join(ROOT, 'Outputs', slug()));
  await fs.mkdir(outDir, {recursive: true});
  const video = path.join(outDir, `${slug()}.mp4`), coverFile = path.join(outDir, `${slug()}-cover.jpg`);
  await fs.copyFile(from, video);
  await fs.copyFile(`${from}.qc.json`, `${video}.qc.json`).catch(() => {});
  // Cover: the first frame of the punchiest shot (the main lift), else a third of the way in.
  const planned = JSON.parse(await fs.readFile(dir('montage', 'plan.json'), 'utf8'));
  const at = planned.shots.find((s) => s.flash)?.at ?? planned.shots.find((s) => s.punch)?.at ?? planned.totalFrames / FPS / 3;
  const {spawnSync} = await import('node:child_process');
  spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at + 0.2), '-i', video, '-frames:v', '1', '-q:v', '2', '-y', coverFile]);
  return {video: rel(video), cover: rel(coverFile)};
}

try {
  if (command === 'analyze') { const a = await analyze(); say(`حللت الموسيقى: ${a.music.bpm} BPM، ${a.music.beats.length} ضربة، و${a.media.length} ملف.`, {bpm: a.music.bpm, duration: a.music.duration, lifts: a.music.lifts.length, media: a.media.map((m) => ({path: m.path, kind: m.kind, duration: m.duration ?? null}))}); }
  else if (command === 'plan') { const p = await plan(); say(`الخطة جاهزة: ${p.shots.length} لقطة على ${p.music.duration.toFixed(1)} ثانية.`, {plan: rel(dir('montage', 'plan.json')), summary: rel(dir('EDITORIAL_PLAN.md')), ...p.notes, sfx: p.sfx.length}); }
  else if (command === 'render') { const r = await render(); say(`اترندر: ${r.out}`, r); }
  else if (command === 'run') { await analyze(); const p = await plan(); const r = await render(); say(`البريفيو جاهز: ${r.out} (${p.shots.length} لقطة).`, r); }
  else if (command === 'publish') { const r = await publish(); say(`اتنقل لـ ${r.video} ومعاه الغلاف.`, r); }
  else { console.error(USAGE); process.exit(2); }
} catch (error) {
  console.error(JSON.stringify({ok: false, error: error.message}));
  process.exit(1);
}
