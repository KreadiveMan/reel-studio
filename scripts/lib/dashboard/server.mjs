import http from 'node:http';
import net from 'node:net';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {STYLE_LABELS} from '../../../engine/src/core/preference-options.ts';
import {HttpError, listRawFiles, receiveUpload, sameToken} from '../upload-server.mjs';
import {ClaudeSession} from './claude-session.mjs';
import {DashboardStore} from './store.mjs';
import {STAGES, detectStages, recordStages, slugFromText, stageSummary} from './progress.mjs';
import {mediaFile, projectDetails, sendMedia} from './details.mjs';
import {RENDER_PROGRESS_DIR} from '../render-progress.mjs';
import {PasswordGate} from './auth.mjs';
import {allowedHost, publicLinks, readRemote, startRelays} from './remote.mjs';

// The studio dashboard: projects, uploads into Raw/, a chat with Claude Code running in the studio folder,
// approve/deny buttons for anything outside the allowlist, and stage progress read from the project files.
// Loopback only (reach it through an SSH tunnel); a token sets an HttpOnly cookie on first visit.

const UI = fileURLToPath(new URL('../../dashboard-ui/', import.meta.url));
const STATIC = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css']};
const COOKIE = 'rs_dashboard';
const LINK = /http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})\/[^\s"'<>)\]`]*/g;
const LINK_KINDS = {4380: 'editor', 4381: 'settings'};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Renders that are running now, keyed by studio project slug, with an estimate of the time left. */
async function activeRenders(root, dir = RENDER_PROGRESS_DIR) {
  const bySlug = new Map();
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const entry = await fs.readFile(path.join(dir, name), 'utf8').then(JSON.parse).catch(() => null);
    const slug = /^(?:Projects|Outputs)\/([a-z0-9][a-z0-9-]{0,63})\//.exec(entry?.out ?? '')?.[1];
    if (!slug || entry.status !== 'running' || !alive(entry.pid)) continue;
    const elapsed = Date.now() - Date.parse(entry.startedAt);
    const remainingMs = entry.percent >= 3 ? Math.round(elapsed * (100 - entry.percent) / entry.percent) : null;
    bySlug.set(slug, {out: entry.out, mode: entry.mode, percent: entry.percent, phase: entry.phase, fps: entry.fps, chunks: entry.chunks, startedAt: entry.startedAt, remainingMs});
  }
  return bySlug;
}

// The dashboard's own typeface: IBM Plex Sans Arabic (and Plex Mono for file names), served from the fonts the
// studio already installed in engine/public/fonts. Only these families are exposed.
const FONT_DIR = fileURLToPath(new URL('../../../engine/public/fonts/', import.meta.url));
const UI_FONTS = ['IBM Plex Sans Arabic', 'IBM Plex Mono'];
async function uiFonts() {
  const manifest = await fs.readFile(path.join(FONT_DIR, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => []);
  return manifest.filter((f) => UI_FONTS.includes(f.family) && ['arabic', 'latin'].includes(f.subset));
}
async function fontCss() {
  return (await uiFonts()).map((f) => `@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weight};font-display:swap;src:url('/fonts/${f.file}') format('woff2');unicode-range:${f.unicodeRange};}`).join('\n');
}

const cookieToken = (header = '') => header.split(';').map((p) => p.trim().split('=')).find(([k]) => k === COOKIE)?.[1];

async function bodyJson(req, limit = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'الطلب كبير.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'الطلب مش مفهوم.'); }
}

// A link Claude printed earlier only counts while its local server still answers.
const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect({host: '127.0.0.1', port, timeout: 600}, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false)); socket.on('timeout', () => { socket.destroy(); resolve(false); });
});
async function liveLinks(links = {}) {
  const live = {};
  for (const [kind, url] of Object.entries(links)) if (await portOpen(Number(new URL(url).port))) live[kind] = url;
  return live;
}

export function firstMessage(project, styleLabel) {
  const style = styleLabel ? ` بستايل ${styleLabel}` : '';
  const notes = project.notes?.trim() ? `\nملاحظاتي: ${project.notes.trim()}` : '';
  if (project.kind === 'graphics') return `اعمل موشن جرافيك من غير تسجيل${style}.\nالفكرة: ${project.notes.trim()}`;
  if (project.kind === 'montage') {
    const pace = {calm: 'هادية (قطعات أطول)', medium: 'متوسطة', fast: 'سريعة (قطعة كل ضربة)'}[project.pace] ?? 'متوسطة';
    return [`اعمل مونتاج على الموسيقى (instructions/MONTAGE.md).`, `الموسيقى: ${project.rawFile}`, `الفيديوهات والصور: ${project.media.join('، ')}`,
      `المدة: ${project.duration === 'full' ? 'طول الموسيقى' : `${project.duration} ثانية`}. السرعة: ${pace}.`,
      'شيل صوت الفيديوهات، وخلّي القطعات على الضربات بساوند ديزاين.', ...(project.notes?.trim() ? [`ملاحظاتي: ${project.notes.trim()}`] : [])].join('\n');
  }
  if (project.kind === 'podcast') return `طلّع ${project.clips ? `${project.clips} كليبات` : 'كليبات'} من الحلقة ${project.rawFile}${style}.${notes}`;
  return `عدّل الفيديو ${project.rawFile}${style}.${notes}`;
}

const sizeOf = async (target) => {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await fs.readdir(target).catch(() => [])) total += await sizeOf(path.join(target, name));
  return total;
};
/** The studio folders a dashboard project owns: its project, podcast clip projects (<slug>--<clip>) and their outputs. */
async function ownedFolders(root, slug) {
  if (!slug) return {projects: [], outputs: []};
  const near = async (dir) => (await fs.readdir(path.join(root, dir)).catch(() => [])).filter((name) => name === slug || name.startsWith(`${slug}--`)).map((name) => path.join(root, dir, name));
  return {projects: await near('Projects'), outputs: await near('Outputs')};
}

export async function createDashboardServer({root, port = 0, claudeCommand, sessionFactory, settingsPort = 4381, startSettings, relays = true} = {}) {
  root = await fs.realpath(root);
  const store = await new DashboardStore(root).open();
  const token = await store.token();
  const sessions = new Map();
  let renders = new Map();
  const pending = new Map(); // projectId -> Map(requestId -> entry)
  const clients = new Set();
  const styles = Object.entries(STYLE_LABELS).map(([id, v]) => ({id, label: v.label, description: v.description}));
  const makeSession = sessionFactory ?? ((options) => new ClaudeSession({...options, command: claudeCommand}));
  const gate = await new PasswordGate(path.join(root, 'state', 'dashboard')).open();
  // Remote access over Tailscale (node scripts/dashboard.mjs --tailscale): the saved machine name is accepted as a
  // Host, and the editor/settings relays start with the dashboard.
  const remote = await readRemote(path.join(root, 'state', 'dashboard'));
  const closeRelays = remote && relays ? await startRelays(remote, relays === true ? undefined : {relays}) : null;
  let settings = null;
  let origin;

  const broadcast = (event) => { const line = `data: ${JSON.stringify(event)}\n\n`; for (const res of clients) res.write(line); };
  const summary = (p) => ({id: p.id, kind: p.kind, title: p.title, rawFile: p.rawFile, slug: p.slug, updatedAt: p.updatedAt, createdAt: p.createdAt,
    running: !!sessions.get(p.id)?.running, waiting: (pending.get(p.id)?.size ?? 0) > 0, queued: !!p.queued, stages: p.stages, activity: p.activity, render: renders.get(p.slug) ?? null, ...stageSummary(p)});
  const full = (p) => ({...p, ...summary(p), pending: [...(pending.get(p.id)?.values() ?? [])]});
  const changed = (p) => broadcast({type: 'project', project: summary(p)});

  function noteText(project, text) {
    const slug = !project.slug && slugFromText(text);
    if (slug) { project.slug = slug; changed(project); }
    for (const match of String(text ?? '').matchAll(LINK)) {
      const kind = LINK_KINDS[match[1]] ?? `port-${match[1]}`;
      if (project.links[kind] !== match[0]) { project.links[kind] = match[0]; broadcast({type: 'links', id: project.id, links: project.links}); }
    }
  }

  function sessionFor(project) {
    let session = sessions.get(project.id);
    if (session) return session;
    session = makeSession({cwd: root, sessionId: project.sessionId});
    sessions.set(project.id, session);
    const id = project.id;
    session.on('session', (sid) => { if (project.sessionId !== sid) { project.sessionId = sid; store.touch(project); } });
    session.on('delta', ({id: itemId, text}) => broadcast({type: 'delta', id, itemId, text}));
    session.on('item', (item) => { noteText(project, item.text); broadcast({type: 'item', id, item: store.addItem(project, item)}); });
    session.on('tool', (tool) => {
      noteText(project, JSON.stringify(tool.input));
      project.activity = {text: tool.summary || tool.name, since: new Date().toISOString()};
      broadcast({type: 'item', id, item: store.addItem(project, {id: tool.id, role: 'tool', name: tool.name, text: tool.summary, status: 'running'})});
      broadcast({type: 'activity', id, activity: project.activity});
    });
    session.on('tool-result', ({toolUseId, text, isError}) => {
      noteText(project, text);
      const existing = project.items.find((x) => x.id === toolUseId && x.role === 'tool');
      if (existing) broadcast({type: 'item', id, item: store.addItem(project, {...existing, status: isError ? 'error' : 'done'})});
    });
    session.on('permission', (entry) => {
      if (!pending.has(id)) pending.set(id, new Map());
      pending.get(id).set(entry.requestId, entry);
      broadcast({type: 'permission', id, entry}); changed(project);
    });
    session.on('permission-cancel', (requestId) => { pending.get(id)?.delete(requestId); broadcast({type: 'permission-done', id, requestId}); });
    session.on('state', ({running}) => {
      if (!running) { project.activity = null; broadcast({type: 'activity', id, activity: null}); pending.get(id)?.clear(); }
      store.touch(project); changed(project);
    });
    session.on('error', (message) => broadcast({type: 'item', id, item: store.addItem(project, {role: 'error', text: message})}));
    return session;
  }

  function say(project, text) {
    broadcast({type: 'item', id: project.id, item: store.addItem(project, {role: 'user', text})});
    sessionFor(project).send(text);
  }

  async function refreshStages() {
    const before = renders;
    renders = await activeRenders(root);
    for (const project of store.list()) {
      const was = before.get(project.slug), now = renders.get(project.slug);
      if (JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)) changed(project);
      if (was && !now) broadcast({type: 'details', id: project.id});
    }
    const day = Date.now() - 24 * 3600 * 1000;
    for (const project of store.list()) {
      if (!sessions.get(project.id)?.running && Date.parse(project.updatedAt) < day && project.stages?.done) continue;
      if (recordStages(project, await detectStages(root, project))) { store.save(project); changed(project); broadcast({type: 'details', id: project.id}); }
    }
  }
  // The queue: a project created while Claude works on another waits, and starts when no project is running.
  function startQueued() {
    if ([...sessions.values()].some((session) => session.running)) return;
    const next = store.list().filter((p) => p.queued).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next) begin(next);
  }
  function begin(project) {
    const text = project.queued.message;
    project.queued = null;
    say(project, text);
    changed(project);
  }
  const poll = setInterval(() => refreshStages().then(startQueued).catch(() => {}), 3000);

  async function route(req, res, url) {
    const [, api, a, b, c, d] = url.pathname.split('/');
    if (api === 'media' && req.method === 'GET') {
      const media = await mediaFile(root, decodeURIComponent(url.pathname.slice('/media/'.length)));
      if (!media) throw new HttpError(404, 'الملف مش موجود.');
      return sendMedia(req, res, media, {download: url.searchParams.get('download') === '1'});
    }
    if (url.pathname === '/fonts.css' && req.method === 'GET') return send(res, 200, await fontCss(), 'text/css; charset=utf-8');
    if (api === 'fonts' && req.method === 'GET') {
      const face = (await uiFonts()).find((f) => `/fonts/${f.file}` === url.pathname);
      const bytes = face && await fs.readFile(path.join(FONT_DIR, face.file)).catch(() => null);
      if (!bytes) throw new HttpError(404, 'الخط مش موجود.');
      res.writeHead(200, {'content-type': 'font/woff2', 'cache-control': 'max-age=86400'}); return res.end(bytes);
    }
    if (api !== 'api') {
      const file = STATIC[url.pathname];
      if (!file || req.method !== 'GET') throw new HttpError(404, 'الصفحة مش موجودة.');
      return send(res, 200, await fs.readFile(path.join(UI, file[0]), 'utf8'), `${file[1]}; charset=utf-8`);
    }
    if (req.method !== 'GET' && req.headers['x-dashboard'] !== '1') throw new HttpError(403, 'الطلب لازم يجي من اللوحة.');
    if (a === 'state' && req.method === 'GET') {
      const disk = await fs.statfs(root).then((st) => ({free: st.bavail * st.bsize, total: st.blocks * st.bsize})).catch(() => null);
      return send(res, 200, {ok: true, stages: STAGES, styles, projects: store.list().map(summary), raw: await listRawFiles(root), disk, password: gate.enabled, remote: publicLinks(req.headers.host, remote)});
    }
    if (a === 'settings' && req.method === 'POST') {
      if (!settings) {
        const create = startSettings ?? (async () => (await import('../settings-server.mjs')).createSettingsServer({root, port: settingsPort}));
        settings = await create().catch((error) => { throw new HttpError(500, error.code === 'EADDRINUSE' ? `بورت ${settingsPort} مشغول؛ اقفل شاشة الإعدادات القديمة.` : error.message); });
      }
      return send(res, 200, {ok: true, url: settings.url});
    }
    if (a === 'raw' && req.method === 'DELETE') {
      const name = url.searchParams.get('name') ?? '';
      const files = await listRawFiles(root);
      if (!files.some((f) => f.name === name)) throw new HttpError(404, 'الملف مش موجود.');
      const users = store.list().filter((p) => p.rawFile === `Raw/${name}` && (p.queued || sessions.get(p.id)?.running));
      if (users.length) throw new HttpError(409, `الفيديو ده مستخدم في مشروع شغال: ${users[0].title}`);
      await fs.rm(path.join(root, 'Raw', name), {force: true});
      broadcast({type: 'raw'});
      return send(res, 200, {ok: true});
    }
    if (a === 'raw' && req.method === 'GET') return send(res, 200, {ok: true, files: await listRawFiles(root)});
    if (a === 'upload' && req.method === 'PUT') { const result = await receiveUpload(root, req, url); broadcast({type: 'raw'}); return send(res, 200, result); }
    if (a === 'events' && req.method === 'GET') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'});
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (a === 'projects' && !b && req.method === 'POST') {
      const body = await bodyJson(req);
      const kind = ['graphics', 'podcast', 'montage'].includes(body.kind) ? body.kind : 'recording';
      if (kind === 'montage') {
        const files = new Set((await listRawFiles(root)).map((f) => `Raw/${f.name}`));
        const music = String(body.music ?? '');
        if (!files.has(music) || !/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(music)) throw new HttpError(400, 'اختار ملف الموسيقى من الملفات المرفوعة.');
        const media = [...new Set(Array.isArray(body.rawFiles) ? body.rawFiles : [])].filter((f) => files.has(f) && /\.(mp4|mov|m4v|mkv|webm|avi|mts|jpe?g|png|webp|gif|bmp|tiff?|heic)$/i.test(f));
        if (!media.length) throw new HttpError(400, 'اختار فيديو أو صورة واحدة على الأقل.');
        if (media.length > 60) throw new HttpError(400, 'أقصى عدد 60 ملف في المونتاج.');
        const duration = ['15', '30', '45', '60', 'full'].includes(String(body.duration)) ? String(body.duration) : '30';
        const pace = ['calm', 'medium', 'fast'].includes(body.pace) ? body.pace : 'medium';
        const notes = String(body.notes ?? '').slice(0, 4000);
        const title = String(body.title ?? '').trim().slice(0, 80) || `مونتاج — ${music.slice(4)}`;
        const project = store.create({kind, title, rawFile: music, style: null, notes});
        Object.assign(project, {media, duration, pace});
        recordStages(project, await detectStages(root, project));
        const busy = [...sessions.values()].some((session) => session.running);
        if (busy) project.queued = {message: firstMessage(project), at: new Date().toISOString()};
        store.touch(project); changed(project);
        if (!busy) say(project, firstMessage(project));
        return send(res, 200, {ok: true, project: full(project), projects: [summary(project)]});
      }
      const style = body.style ? styles.find((s) => s.id === body.style) : null;
      if (body.style && !style) throw new HttpError(400, 'الستايل ده مش معروف.');
      const notes = String(body.notes ?? '').slice(0, 4000);
      let rawFiles = [null];
      if (kind !== 'graphics') {
        const files = new Set((await listRawFiles(root)).map((f) => `Raw/${f.name}`));
        rawFiles = [...new Set(Array.isArray(body.rawFiles) ? body.rawFiles : [body.rawFile])].filter(Boolean);
        if (!rawFiles.length || rawFiles.some((f) => !files.has(f))) throw new HttpError(400, 'اختار فيديو من الملفات المرفوعة.');
        if (kind === 'podcast' && rawFiles.length > 1) throw new HttpError(400, 'اختار حلقة واحدة للبودكاست.');
        if (rawFiles.length > 20) throw new HttpError(400, 'أقصى عدد 20 فيديو في المرة.');
      } else if (!notes.trim()) throw new HttpError(400, 'اكتب فكرة الموشن.');
      const clips = kind === 'podcast' && Number.isInteger(Number(body.clips)) && Number(body.clips) >= 1 && Number(body.clips) <= 10 ? Number(body.clips) : null;
      const created = [];
      for (const rawFile of rawFiles) {
        const named = String(body.title ?? '').trim().slice(0, 80);
        const title = (named && rawFiles.length > 1 ? `${named} — ${rawFile.slice(4)}` : named) || (rawFile ? rawFile.slice(4) : notes.trim().slice(0, 40));
        const project = store.create({kind, title, rawFile, style: style?.id ?? null, notes});
        if (clips) project.clips = clips;
        recordStages(project, await detectStages(root, project));
        const busy = [...sessions.values()].some((session) => session.running) || created.length > 0;
        if (busy) project.queued = {message: firstMessage(project, style?.label), at: new Date().toISOString()};
        store.touch(project); changed(project);
        if (!busy) say(project, firstMessage(project, style?.label));
        created.push(project);
      }
      return send(res, 200, {ok: true, project: full(created[0]), projects: created.map(summary)});
    }
    const project = a === 'projects' && b ? store.get(b) : null;
    if (a === 'projects' && !project) throw new HttpError(404, 'المشروع مش موجود.');
    if (project && !c && req.method === 'GET') return send(res, 200, {ok: true, project: {...full(project), links: await liveLinks(project.links)}});
    if (project && c === 'details' && req.method === 'GET') {
      const owned = await ownedFolders(root, project.slug);
      let bytes = 0; for (const dir of [...owned.projects, ...owned.outputs]) bytes += await sizeOf(dir);
      return send(res, 200, {ok: true, details: {...await projectDetails(root, project.slug), bytes}, links: await liveLinks(project.links)});
    }
    if (project && c === 'start' && req.method === 'POST') {
      if (!project.queued) throw new HttpError(409, 'المشروع ده مش في الطابور.');
      begin(project); return send(res, 200, {ok: true});
    }
    if (project && !c && req.method === 'DELETE') {
      const body = await bodyJson(req);
      if (sessions.get(project.id)?.running) throw new HttpError(409, 'وقّف Claude الأول قبل ما تمسح المشروع.');
      sessions.get(project.id)?.close(); sessions.delete(project.id); pending.delete(project.id);
      const owned = await ownedFolders(root, project.slug);
      const removed = [];
      for (const dir of [...(body.studio ? owned.projects : []), ...(body.outputs ? owned.outputs : [])]) { await fs.rm(dir, {recursive: true, force: true}); removed.push(path.relative(root, dir).split(path.sep).join('/')); }
      await store.remove(project.id);
      broadcast({type: 'removed', id: project.id});
      return send(res, 200, {ok: true, removed});
    }
    if (project && c === 'messages' && req.method === 'POST') {
      const text = String((await bodyJson(req)).text ?? '').trim().slice(0, 8000);
      if (!text) throw new HttpError(400, 'اكتب رسالة.');
      if (sessions.get(project.id)?.running) throw new HttpError(409, 'Claude لسه شغال على الرسالة اللي فاتت. استنى أو دوس «وقّف».');
      say(project, text); return send(res, 200, {ok: true});
    }
    if (project && c === 'interrupt' && req.method === 'POST') return send(res, 200, {ok: !!sessions.get(project.id)?.interrupt()});
    if (project && c === 'permissions' && d && req.method === 'POST') {
      const body = await bodyJson(req);
      const entry = pending.get(project.id)?.get(d);
      if (!entry) throw new HttpError(404, 'الطلب ده خلص أو اتلغى.');
      let input;
      if (entry.tool === 'AskUserQuestion' && body.allow) {
        const answers = body.answers && typeof body.answers === 'object' ? Object.fromEntries(Object.entries(body.answers).map(([k, v]) => [String(k), String(v).slice(0, 2000)])) : {};
        input = {...entry.input, answers};
      }
      sessions.get(project.id)?.answer(d, {allow: !!body.allow, input, message: body.message, always: !!body.always});
      pending.get(project.id).delete(d);
      const label = entry.tool === 'AskUserQuestion' ? (body.allow ? `اخترت: ${Object.values(input?.answers ?? {}).join('، ')}` : 'تخطيت السؤال') : `${body.allow ? (body.always ? 'وافقت دايمًا على' : 'وافقت على') : 'رفضت'}: ${entry.description || entry.tool}`;
      broadcast({type: 'item', id: project.id, item: store.addItem(project, {role: 'decision', text: label})});
      broadcast({type: 'permission-done', id: project.id, requestId: d}); changed(project);
      return send(res, 200, {ok: true});
    }
    throw new HttpError(404, 'الطلب مش موجود.');
  }

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, {'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY'});
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (!allowedHost(req.headers.host, remote)) throw new HttpError(421, 'العنوان ده مش مسموح.');
      const given = url.searchParams.get('token');
      if (given && sameToken(given, token) && url.pathname === '/') {
        const secure = publicLinks(req.headers.host, remote) ? '; Secure' : '';
        res.writeHead(303, {location: '/', 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`}); return res.end();
      }
      if (!sameToken(cookieToken(req.headers.cookie) ?? req.headers['x-dashboard-token'], token)) throw new HttpError(401, 'افتح الرابط الكامل اللي طبعه أمر اللوحة (فيه token).');
      // Optional password: a second lock on top of the link, for a server other people can reach.
      if (gate.enabled && !(req.method === 'GET' && (url.pathname === '/fonts.css' || url.pathname.startsWith('/fonts/')))) {
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const result = await gate.login(String((await bodyJson(req)).password ?? ''), req.socket.remoteAddress);
          res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'set-cookie': `${gate.cookie}=${result.session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`});
          return res.end(JSON.stringify({ok: true}));
        }
        if (!gate.valid(req.headers.cookie)) {
          if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await fs.readFile(path.join(UI, 'login.html'), 'utf8'), 'text/html; charset=utf-8');
          throw new HttpError(401, 'سجّل الدخول بالباسورد.');
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') { gate.logout(req.headers.cookie); return send(res, 200, {ok: true}); }
      }
      await route(req, res, url);
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, {ok: false, error: error.status ? error.message : `حصلت مشكلة: ${error.message}`});
      if (req.readable) req.resume();
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  await refreshStages().catch(() => {});
  return {
    origin, token, url: `${origin}/?token=${token}`, store,
    close: async () => {
      clearInterval(poll); clearInterval(heartbeat);
      for (const session of sessions.values()) session.close();
      await settings?.close().catch(() => {});
      await closeRelays?.();
      for (const res of clients) res.end();
      await store.flush();
      await new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    },
  };
}
