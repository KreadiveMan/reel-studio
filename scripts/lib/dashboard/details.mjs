import {createReadStream, promises as fs} from 'node:fs';
import path from 'node:path';

// What the dashboard shows of a studio project, read from the files the studio writes: the editorial plan,
// the scenes and cuts of edit.json, renders, the delivered files in Outputs/, the post copy and the QC report.
// Media is served only from the project's renders/ and stills/ and from Outputs/<slug>/, never through a link.

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MEDIA_TYPES = Object.freeze({'.mp4': 'video/mp4', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.srt': 'text/plain; charset=utf-8', '.wav': 'audio/wav'});

const readText = (file, limit = 400_000) => fs.readFile(file, 'utf8').then((text) => text.slice(0, limit)).catch(() => null);
const readJson = (file) => fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
const seconds = (frames, fps) => Math.round((frames / fps) * 10) / 10;

async function filesIn(dir, prefix, pattern) {
  const list = [];
  for (const entry of await fs.readdir(dir, {withFileTypes: true}).catch(() => [])) {
    if (!entry.isFile() || !pattern.test(entry.name) || entry.name.includes('.raw.')) continue;
    const stat = await fs.stat(path.join(dir, entry.name));
    list.push({name: entry.name, path: `${prefix}/${entry.name}`, bytes: stat.size, modified: stat.mtime.toISOString()});
  }
  return list.sort((a, b) => b.modified.localeCompare(a.modified));
}

function scenesOf(edit) {
  const fps = edit?.source?.fps ?? 30;
  return (edit?.scenes ?? []).map((s) => ({id: s.id, family: s.family, layout: s.layout, from: seconds(s.fromFrame, fps), to: seconds(s.fromFrame + s.durationInFrames, fps),
    title: s.data?.title ?? s.data?.firstTitle ?? s.data?.text ?? s.data?.kicker ?? null}));
}

/** Kept source ranges and the gaps between them (what the cut removes), in source seconds. */
function cutsOf(edit) {
  if (!edit?.segments?.length || edit.contentMode === 'graphics') return null;
  const fps = edit.source?.fps ?? 30, total = edit.source?.totalFrames ?? 0;
  const kept = edit.segments.map((s) => ({from: seconds(s.fromFrame, fps), to: seconds(s.toFrame, fps)}));
  const removed = [];
  let cursor = 0;
  for (const s of edit.segments) { if (s.fromFrame > cursor) removed.push({from: seconds(cursor, fps), to: seconds(s.fromFrame, fps)}); cursor = s.toFrame; }
  if (total > cursor) removed.push({from: seconds(cursor, fps), to: seconds(total, fps)});
  const keptSeconds = edit.segments.reduce((sum, s) => sum + (s.toFrame - s.fromFrame), 0) / fps;
  return {kept, removed, sourceSeconds: seconds(total, fps), editSeconds: Math.round(keptSeconds * 10) / 10};
}

// The delivery checks a render recorded in its .qc.json sidecar, in plain words for the page.
const CHECK_LABELS = {igCheck: 'مواصفات إنستجرام وتيك توك', safe: 'المناطق الآمنة للكتابة', arabic: 'سلامة العربي', motion: 'الحركة', head: 'مكان الوش'};
function checkState(key, value) {
  if (value === null || value === undefined) return null;
  if (key === 'motion' && value.exempt) return {state: 'skip', note: 'مش مطلوب للموشن من غير تسجيل'};
  if (key === 'head') return value.status === 'PASS' ? {state: 'ok'} : value.ran === false ? {state: 'skip', note: 'مفيش فيديو متصوَّر'} : {state: value.status === 'NEEDS-REVIEW' ? 'review' : 'fail', note: value.status};
  if (key === 'igCheck') return {state: value.ok ? (value.warnings?.length ? 'review' : 'ok') : 'fail', note: [...(value.fails ?? []), ...(value.warnings ?? [])].join('، ') || null};
  return {state: value.ok === false ? 'fail' : value.ok === true ? 'ok' : 'review'};
}
function qcSummary(qc) {
  if (!qc) return null;
  const ig = qc.igCheck?.summary ?? null;
  const checks = Object.entries(CHECK_LABELS).map(([key, label]) => ({key, label, ...checkState(key, qc[key])})).filter((c) => c.state);
  return {ok: qc.ok ?? null, mode: qc.mode ?? null, renderSeconds: qc.timing?.totalSec ?? null, frames: Array.isArray(qc.frames) ? qc.frames[1] - qc.frames[0] + 1 : null,
    width: ig?.width ?? null, height: ig?.height ?? null, fps: ig?.fps ?? null, durationSec: ig?.durationSec ?? null,
    sizeMB: ig?.sizeMB ?? (qc.bytes ? Math.round(qc.bytes / 1e5) / 10 : null), lufs: ig?.loudness?.silent ? null : ig?.loudness?.integratedLUFS ?? null, checks};
}

export async function projectDetails(root, slug, {withClips = true} = {}) {
  if (!slug || !SLUG.test(slug)) return {slug: null};
  // Podcast clips are full projects of their own (Projects/<batch>--<clip>); show each with its renders and outputs.
  const clips = [];
  if (withClips) for (const name of (await fs.readdir(path.join(root, 'Projects')).catch(() => [])).filter((n) => n.startsWith(`${slug}--`)).sort()) clips.push(await projectDetails(root, name, {withClips: false}));
  const dir = path.join(root, 'Projects', slug), outDir = path.join(root, 'Outputs', slug);
  const edit = await readJson(path.join(dir, 'edit.json'));
  const renders = await filesIn(path.join(dir, 'renders'), `Projects/${slug}/renders`, /\.(mp4|mov)$/i);
  for (const render of renders) render.qc = qcSummary(await readJson(path.join(root, ...render.path.split('/')) + '.qc.json'));
  const outputs = await filesIn(outDir, `Outputs/${slug}`, /\.(mp4|mov|srt|jpe?g|png)$/i);
  for (const output of outputs) if (/\.(mp4|mov)$/i.test(output.name)) output.qc = qcSummary(await readJson(path.join(outDir, output.name) + '.qc.json'));
  const copy = await readJson(path.join(dir, 'publish-copy.json'));
  const publish = copy ? ['instagram', 'tiktok', 'youtube'].filter((p) => copy[p]).map((platform) => {
    const entry = copy[platform];
    const body = platform === 'youtube' ? `${entry.title ?? ''}\n\n${entry.description ?? ''}` : (entry.caption ?? '');
    return {platform, text: [body.trim(), (entry.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n'), altText: entry.altText ?? null, pinnedComment: entry.pinnedComment ?? null};
  }) : [];
  return {
    slug, style: edit?.style ?? null, purpose: edit?.purpose ?? null, contentMode: edit?.contentMode ?? 'recording',
    durationSec: edit?.segments ? Math.round(edit.segments.reduce((s, x) => s + x.toFrame - x.fromFrame, 0) / (edit.source?.fps ?? 30) * 10) / 10 : null,
    plan: await readText(path.join(dir, 'EDITORIAL_PLAN.md')),
    scenes: scenesOf(edit), cuts: cutsOf(edit), captionsStatus: edit?.captions?.status ?? null,
    renders, outputs, publish, publishPack: await readText(path.join(dir, 'PUBLISH_PACK.md')), qcReport: await readText(path.join(dir, 'QC_REPORT.md')),
    stills: (await filesIn(path.join(dir, 'stills'), `Projects/${slug}/stills`, /\.(jpe?g|png|webp)$/i)).slice(0, 24),
    clips,
  };
}

/** Resolves a media request to a file inside the allowed folders of one project, or null. */
export async function mediaFile(root, relative) {
  const parts = String(relative ?? '').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) return null;
  const allowed = (parts[0] === 'Projects' && SLUG.test(parts[1] ?? '') && ['renders', 'stills'].includes(parts[2]) && parts.length === 4)
    || (parts[0] === 'Outputs' && SLUG.test(parts[1] ?? '') && parts.length === 3);
  const type = MEDIA_TYPES[path.extname(parts.at(-1)).toLowerCase()];
  if (!allowed || !type) return null;
  const file = path.join(root, ...parts);
  for (let cursor = file; cursor !== root; cursor = path.dirname(cursor)) {
    const stat = await fs.lstat(cursor).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return null;
  }
  const stat = await fs.stat(file);
  return stat.isFile() ? {file, type, size: stat.size, name: parts.at(-1)} : null;
}

/** Streams a media file with HTTP Range support so the browser can seek. */
export function sendMedia(req, res, media, {download = false} = {}) {
  const headers = {'content-type': media.type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(download ? {'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(media.name)}`} : {})};
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && media.size > 0) {
    let start = range[1] === '' ? media.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? media.size - 1 : Number(range[2]);
    start = Math.max(0, start); end = Math.min(end, media.size - 1);
    if (start > end) { res.writeHead(416, {'content-range': `bytes */${media.size}`}); return res.end(); }
    res.writeHead(206, {...headers, 'content-range': `bytes ${start}-${end}/${media.size}`, 'content-length': end - start + 1});
    return createReadStream(media.file, {start, end}).pipe(res);
  }
  res.writeHead(200, {...headers, 'content-length': media.size});
  createReadStream(media.file).pipe(res);
}
