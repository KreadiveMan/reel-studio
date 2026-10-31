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

// The studio dashboard: projects, uploads into Raw/, a chat with Claude Code running in the studio folder,
// approve/deny buttons for anything outside the allowlist, and stage progress read from the project files.
// Loopback only (reach it through an SSH tunnel); a token sets an HttpOnly cookie on first visit.

const UI = fileURLToPath(new URL('../../dashboard-ui/', import.meta.url));
const STATIC = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css']};
const COOKIE = 'rs_dashboard';
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;
const LINK = /http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})\/[^\s"'<>)\]`]*/g;
const LINK_KINDS = {4380: 'editor', 4381: 'settings'};

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
  return `عدّل الفيديو ${project.rawFile}${style}.${notes}`;
}

export async function createDashboardServer({root, port = 0, claudeCommand, sessionFactory} = {}) {
  root = await fs.realpath(root);
  const store = await new DashboardStore(root).open();
  const token = await store.token();
  const sessions = new Map();
  const pending = new Map(); // projectId -> Map(requestId -> entry)
  const clients = new Set();
  const styles = Object.entries(STYLE_LABELS).map(([id, v]) => ({id, label: v.label, description: v.description}));
  const makeSession = sessionFactory ?? ((options) => new ClaudeSession({...options, command: claudeCommand}));
  let origin;

  const broadcast = (event) => { const line = `data: ${JSON.stringify(event)}\n\n`; for (const res of clients) res.write(line); };
  const summary = (p) => ({id: p.id, kind: p.kind, title: p.title, rawFile: p.rawFile, slug: p.slug, updatedAt: p.updatedAt, createdAt: p.createdAt,
    running: !!sessions.get(p.id)?.running, waiting: (pending.get(p.id)?.size ?? 0) > 0, stages: p.stages, activity: p.activity, ...stageSummary(p)});
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
    const day = Date.now() - 24 * 3600 * 1000;
    for (const project of store.list()) {
      if (!sessions.get(project.id)?.running && Date.parse(project.updatedAt) < day && project.stages?.done) continue;
      if (recordStages(project, await detectStages(root, project))) { store.save(project); changed(project); }
    }
  }
  const poll = setInterval(() => refreshStages().catch(() => {}), 3000);

  async function route(req, res, url) {
    const [, api, a, b, c, d] = url.pathname.split('/');
    if (api !== 'api') {
      const file = STATIC[url.pathname];
      if (!file || req.method !== 'GET') throw new HttpError(404, 'الصفحة مش موجودة.');
      return send(res, 200, await fs.readFile(path.join(UI, file[0]), 'utf8'), `${file[1]}; charset=utf-8`);
    }
    if (req.method !== 'GET' && req.headers['x-dashboard'] !== '1') throw new HttpError(403, 'الطلب لازم يجي من اللوحة.');
    if (a === 'state' && req.method === 'GET') return send(res, 200, {ok: true, stages: STAGES, styles, projects: store.list().map(summary), raw: await listRawFiles(root)});
    if (a === 'raw' && req.method === 'GET') return send(res, 200, {ok: true, files: await listRawFiles(root)});
    if (a === 'upload' && req.method === 'PUT') { const result = await receiveUpload(root, req, url); broadcast({type: 'raw'}); return send(res, 200, result); }
    if (a === 'events' && req.method === 'GET') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'});
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (a === 'projects' && !b && req.method === 'POST') {
      const body = await bodyJson(req);
      const kind = body.kind === 'graphics' ? 'graphics' : 'recording';
      const style = body.style ? styles.find((s) => s.id === body.style) : null;
      if (body.style && !style) throw new HttpError(400, 'الستايل ده مش معروف.');
      const notes = String(body.notes ?? '').slice(0, 4000);
      let rawFile = null;
      if (kind === 'recording') {
        const files = await listRawFiles(root);
        if (!files.some((f) => `Raw/${f.name}` === body.rawFile)) throw new HttpError(400, 'اختار فيديو من الملفات المرفوعة.');
        rawFile = body.rawFile;
      } else if (!notes.trim()) throw new HttpError(400, 'اكتب فكرة الموشن.');
      const title = String(body.title ?? '').trim().slice(0, 80) || (rawFile ? rawFile.slice(4) : notes.trim().slice(0, 40));
      const project = store.create({kind, title, rawFile, style: style?.id ?? null, notes});
      recordStages(project, await detectStages(root, project));
      changed(project);
      say(project, firstMessage(project, style?.label));
      return send(res, 200, {ok: true, project: full(project)});
    }
    const project = a === 'projects' && b ? store.get(b) : null;
    if (a === 'projects' && !project) throw new HttpError(404, 'المشروع مش موجود.');
    if (project && !c && req.method === 'GET') return send(res, 200, {ok: true, project: {...full(project), links: await liveLinks(project.links)}});
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
      if (!LOOPBACK.test(req.headers.host ?? '')) throw new HttpError(421, 'العنوان ده مش مسموح.');
      const given = url.searchParams.get('token');
      if (given && sameToken(given, token) && url.pathname === '/') {
        res.writeHead(303, {location: '/', 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`}); return res.end();
      }
      if (!sameToken(cookieToken(req.headers.cookie) ?? req.headers['x-dashboard-token'], token)) throw new HttpError(401, 'افتح الرابط الكامل اللي طبعه أمر اللوحة (فيه token).');
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
      for (const res of clients) res.end();
      await store.flush();
      await new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    },
  };
}
