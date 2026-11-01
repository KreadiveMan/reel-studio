import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDashboardServer, firstMessage} from '../scripts/lib/dashboard/server.mjs';
import {claudeArgs, childEnv} from '../scripts/lib/dashboard/claude-session.mjs';
import {detectStages, recordStages, slugFromText, stageSummary} from '../scripts/lib/dashboard/progress.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
mkdirSync(path.join(ROOT, 'state', 'tmp'), {recursive: true});

function call(app, {method = 'GET', pathname, body, cookie = true, headers = {}}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(pathname, app.origin), {method, headers: {...(cookie ? {cookie: `rs_dashboard=${app.token}`} : {}), ...(method !== 'GET' ? {'x-dashboard': '1'} : {}), ...(data ? {'content-type': 'application/json', 'content-length': data.length} : {}), ...headers}}, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({status: res.statusCode, headers: res.headers, json, text}); });
    });
    req.on('error', reject); req.end(data);
  });
}

function events(app) {
  const list = [], waiters = [];
  const req = http.get(new URL('/api/events', app.origin), {headers: {cookie: `rs_dashboard=${app.token}`}}, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)); list.push(event);
        for (const w of [...waiters]) if (w.match(event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(event); }
      }
    });
  });
  return {list, close: () => req.destroy(), wait: (match, ms = 8000) => {
    const found = list.find(match); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { waiters.push({match, resolve}); setTimeout(() => reject(new Error('timed out waiting for event')), ms).unref(); });
  }};
}

async function withDashboard(fn) {
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'dashboard-test-'));
  const app = await createDashboardServer({root, port: 0, claudeCommand: FAKE});
  const stream = events(app);
  try { await fn(app, root, stream); } finally { stream.close(); await app.close(); rmSync(root, {recursive: true, force: true}); }
}

test('Claude runs headless with host-answered permissions, accepted edits and the dashboard guidance', () => {
  const args = claudeArgs({sessionId: 'abc', resume: false});
  for (const flag of ['-p', '--permission-prompt-tool', 'stdio', '--permission-mode', 'acceptEdits', '--include-partial-messages', '--session-id']) assert.ok(args.includes(flag), flag);
  assert.ok(claudeArgs({sessionId: 'abc', resume: true}).includes('--resume'));
  assert.ok(!claudeArgs({sessionId: 'abc', resume: true}).includes('--session-id'));
  assert.ok(!('CLAUDECODE' in childEnv({CLAUDECODE: '1', PATH: '/bin'})));
});

test('stages follow the studio files, and a later file implies the earlier stages', async () => {
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'dashboard-stages-'));
  try {
    mkdirSync(path.join(root, 'Raw')); writeFileSync(path.join(root, 'Raw', 'clip.mp4'), 'x');
    const project = {slug: null, rawFile: 'Raw/clip.mp4', kind: 'recording', stages: {}};
    recordStages(project, await detectStages(root, project));
    assert.deepEqual(Object.keys(project.stages), ['upload']);
    project.slug = 'my-reel';
    mkdirSync(path.join(root, 'Projects', 'my-reel', 'prepared'), {recursive: true});
    writeFileSync(path.join(root, 'Projects', 'my-reel', 'prepared', 'props.json'), '{}');
    recordStages(project, await detectStages(root, project));
    assert.deepEqual(Object.keys(project.stages).sort(), ['draft', 'plan', 'preview', 'transcript', 'upload']);
    assert.deepEqual(stageSummary(project), {percent: 71, current: 'render', done: 5});
    assert.equal(slugFromText('node scripts/editor.mjs prepare Projects/my-reel/edit.json'), 'my-reel');
    assert.equal(slugFromText('Projects/_doctor/doctor.mp4'), null);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('the first message names the recording or the idea, and the chosen style', () => {
  assert.equal(firstMessage({kind: 'recording', rawFile: 'Raw/a.mp4', notes: ''}, 'ورق متحرك'), 'عدّل الفيديو Raw/a.mp4 بستايل ورق متحرك.');
  assert.match(firstMessage({kind: 'graphics', notes: 'عرض جديد'}, null), /موشن جرافيك من غير تسجيل[\s\S]*عرض جديد/);
});

test('access needs the token: the link sets an HttpOnly cookie; other hosts and cross-site writes are refused', async () => withDashboard(async (app) => {
  assert.equal((await call(app, {pathname: '/', cookie: false})).status, 401);
  const visit = await call(app, {pathname: `/?token=${app.token}`, cookie: false});
  assert.equal(visit.status, 303);
  assert.match(visit.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal((await call(app, {pathname: '/'})).status, 200);
  assert.equal((await call(app, {pathname: '/api/state', headers: {host: 'evil.example'}})).status, 421);
  assert.equal((await call(app, {method: 'POST', pathname: '/api/projects', body: {}, headers: {'x-dashboard': ''}})).status, 403);
}));

test('a project chat streams Claude, asks approval and questions in the page, and tracks the studio project', async () => withDashboard(async (app, root, stream) => {
  mkdirSync(path.join(root, 'Raw')); writeFileSync(path.join(root, 'Raw', 'clip.mp4'), 'x');
  assert.equal((await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'recording', rawFile: 'Raw/missing.mp4'}})).status, 400);
  const created = await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'recording', rawFile: 'Raw/clip.mp4', style: 'kinetic-paper'}});
  assert.equal(created.status, 200, created.text);
  const id = created.json.project.id;
  assert.equal(created.json.project.items[0].text, 'عدّل الفيديو Raw/clip.mp4 بستايل ورق متحرك.');
  await stream.wait((e) => e.type === 'delta' && e.id === id);
  const permission = await stream.wait((e) => e.type === 'permission' && e.entry.tool === 'Bash');
  assert.equal(permission.entry.input.command, 'rm -rf Projects/old');
  const busy = await call(app, {method: 'POST', pathname: `/api/projects/${id}/messages`, body: {text: 'تاني'}});
  assert.equal(busy.status, 409, 'one message at a time');
  assert.equal(permission.entry.suggestions.length, 1, 'Claude Code suggested a rule');
  assert.equal((await call(app, {method: 'POST', pathname: `/api/projects/${id}/permissions/${permission.entry.requestId}`, body: {allow: true, always: true}})).status, 200);
  const question = await stream.wait((e) => e.type === 'permission' && e.entry.tool === 'AskUserQuestion');
  await call(app, {method: 'POST', pathname: `/api/projects/${id}/permissions/${question.entry.requestId}`, body: {allow: true, answers: {'أنهي ستايل؟': 'مجلة'}}});
  const reply = await stream.wait((e) => e.type === 'item' && e.item.role === 'assistant' && e.item.text.startsWith('اخترت'));
  assert.match(reply.item.text, /اخترت: مجلة/);
  await stream.wait((e) => e.type === 'project' && e.project.id === id && !e.project.running);
  const project = (await call(app, {pathname: `/api/projects/${id}`})).json.project;
  assert.equal(project.slug, 'test-reel');
  assert.equal(app.store.get(id).links.editor, 'http://127.0.0.1:4380/?token=abc123', 'the printed editor link is kept');
  assert.equal(project.links.editor, undefined, 'and hidden while nothing answers on its port');
  assert.ok(project.items.some((i) => i.role === 'decision' && i.text.includes('وافقت دايمًا')));
  assert.ok(stream.list.some((e) => e.type === 'item' && e.item.role === 'tool' && e.item.status === 'done'), 'the rule went back for this conversation only');
  assert.ok(project.items.some((i) => i.role === 'tool' && i.status === 'done'));
  assert.ok(project.sessionId);
  await app.store.flush();
  assert.ok(existsSync(path.join(root, 'state', 'dashboard', 'projects', `${id}.json`)), 'the chat is saved');
}));

test('a denied command reaches Claude as a denial, and the page records it', async () => withDashboard(async (app, root, stream) => {
  const created = await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'graphics', notes: 'فكرة عرض'}});
  const id = created.json.project.id;
  const permission = await stream.wait((e) => e.type === 'permission' && e.entry.tool === 'Bash');
  await call(app, {method: 'POST', pathname: `/api/projects/${id}/permissions/${permission.entry.requestId}`, body: {allow: false}});
  const question = await stream.wait((e) => e.type === 'permission' && e.entry.tool === 'AskUserQuestion');
  await call(app, {method: 'POST', pathname: `/api/projects/${id}/permissions/${question.entry.requestId}`, body: {allow: false}});
  await stream.wait((e) => e.type === 'item' && e.item.text?.includes('اخترت: none'));
  const project = (await call(app, {pathname: `/api/projects/${id}`})).json.project;
  assert.ok(project.items.some((i) => i.role === 'tool' && i.status === 'error'));
  assert.ok(project.items.some((i) => i.role === 'decision' && i.text.includes('رفضت')));
  assert.equal(project.links.editor, undefined);
}));

test('project details read the plan, scenes, cuts, renders, outputs and post copy from the studio files', async () => {
  const {projectDetails, mediaFile} = await import('../scripts/lib/dashboard/details.mjs');
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'dashboard-details-'));
  try {
    const dir = path.join(root, 'Projects', 'demo');
    mkdirSync(path.join(dir, 'renders'), {recursive: true}); mkdirSync(path.join(root, 'Outputs', 'demo'), {recursive: true});
    writeFileSync(path.join(dir, 'EDITORIAL_PLAN.md'), '# Plan\n');
    writeFileSync(path.join(dir, 'edit.json'), JSON.stringify({style: 'grid-glide', source: {fps: 30, totalFrames: 900}, segments: [{fromFrame: 30, toFrame: 300}, {fromFrame: 360, toFrame: 600}],
      captions: {status: 'reviewed'}, scenes: [{id: 'a', family: 'intro', layout: 'split', fromFrame: 0, durationInFrames: 90, data: {title: 'أهلا'}}]}));
    writeFileSync(path.join(dir, 'renders', 'edit-preview.mp4'), 'v');
    writeFileSync(path.join(dir, 'renders', 'edit-preview.mp4.qc.json'), JSON.stringify({ok: true, mode: 'preview', timing: {totalSec: 12}, igCheck: {ok: true, fails: [], warnings: [], summary: {width: 1080, height: 1920, fps: 30, durationSec: 17, sizeMB: 2, loudness: {integratedLUFS: -14}}}, safe: {ok: true}, motion: {exempt: 'static-graphics'}}));
    writeFileSync(path.join(root, 'Outputs', 'demo', 'demo.mp4'), '0123456789');
    writeFileSync(path.join(root, 'Outputs', 'demo', 'demo.srt'), '1');
    writeFileSync(path.join(dir, 'publish-copy.json'), JSON.stringify({title: 't', instagram: {caption: 'وصف', hashtags: ['#a', '#b']}}));
    const d = await projectDetails(root, 'demo');
    assert.equal(d.plan, '# Plan\n');
    assert.deepEqual(d.scenes[0], {id: 'a', family: 'intro', layout: 'split', from: 0, to: 3, title: 'أهلا'});
    assert.deepEqual(d.cuts.removed, [{from: 0, to: 1}, {from: 10, to: 12}, {from: 20, to: 30}]);
    assert.equal(d.cuts.editSeconds, 17);
    assert.deepEqual(d.renders[0].qc.checks.map((c) => [c.key, c.state]), [['igCheck', 'ok'], ['safe', 'ok'], ['motion', 'skip']]);
    assert.equal(d.renders[0].qc.lufs, -14);
    assert.deepEqual(d.outputs.map((f) => f.name).sort(), ['demo.mp4', 'demo.srt']);
    assert.deepEqual(d.publish, [{platform: 'instagram', text: 'وصف\n\n#a #b', altText: null, pinnedComment: null}]);
    assert.ok(await mediaFile(root, 'Outputs/demo/demo.mp4'));
    assert.ok(await mediaFile(root, 'Projects/demo/renders/edit-preview.mp4'));
    for (const bad of ['Projects/demo/edit.json', 'Projects/demo/../../etc/passwd', 'Outputs/demo/../../Raw/clip.mp4', 'Raw/x.mp4', 'Projects/demo/renders/edit-preview.mp4.qc.json']) assert.equal(await mediaFile(root, bad), null, bad);
    assert.deepEqual(await projectDetails(root, '../x'), {slug: null});
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('media streams through the dashboard with seeking, and only with the session cookie', async () => withDashboard(async (app, root) => {
  mkdirSync(path.join(root, 'Outputs', 'demo'), {recursive: true});
  writeFileSync(path.join(root, 'Outputs', 'demo', 'demo.mp4'), '0123456789');
  assert.equal((await call(app, {pathname: '/media/Outputs/demo/demo.mp4', cookie: false})).status, 401);
  const part = await call(app, {pathname: '/media/Outputs/demo/demo.mp4', headers: {range: 'bytes=2-5'}});
  assert.equal(part.status, 206); assert.equal(part.text, '2345'); assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  const whole = await call(app, {pathname: '/media/Outputs/demo/demo.mp4?download=1'});
  assert.equal(whole.text, '0123456789'); assert.match(whole.headers['content-disposition'], /attachment/);
  assert.equal((await call(app, {pathname: '/media/Outputs%2Fdemo%2F..%2F..%2FRaw%2Fdemo.mp4'})).status, 404);
}));

async function finishTurn(app, stream, id) {
  const permission = await stream.wait((e) => e.type === 'permission' && e.id === id && e.entry.tool === 'Bash');
  await call(app, {method: 'POST', pathname: `/api/projects/${id}/permissions/${permission.entry.requestId}`, body: {allow: true}});
  const question = await stream.wait((e) => e.type === 'permission' && e.id === id && e.entry.tool === 'AskUserQuestion');
  await call(app, {method: 'POST', pathname: `/api/projects/${id}/permissions/${question.entry.requestId}`, body: {allow: false}});
}

test('several videos become queued projects that start one after another; a podcast names its clip count', async () => withDashboard(async (app, root, stream) => {
  mkdirSync(path.join(root, 'Raw'));
  for (const name of ['a.mp4', 'b.mp4', 'ep.mp4']) writeFileSync(path.join(root, 'Raw', name), 'x');
  const bulk = await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'recording', rawFiles: ['Raw/a.mp4', 'Raw/b.mp4'], title: 'دفعة'}});
  assert.equal(bulk.status, 200, bulk.text);
  const [first, second] = bulk.json.projects;
  assert.equal(first.queued, false); assert.equal(second.queued, true);
  assert.equal(second.title, 'دفعة — b.mp4');
  const podcast = await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'podcast', rawFile: 'Raw/ep.mp4', clips: 4}});
  assert.equal(podcast.json.project.queued, true, 'waits behind the running project');
  assert.equal((await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'podcast', rawFiles: ['Raw/a.mp4', 'Raw/b.mp4']}})).status, 400);
  await finishTurn(app, stream, first.id);
  await stream.wait((e) => e.type === 'item' && e.id === second.id && e.item.role === 'user', 10000);
  assert.equal(app.store.get(second.id).items[0].text, 'عدّل الفيديو Raw/b.mp4.');
  assert.equal(app.store.get(podcast.json.project.id).queued.message, 'طلّع 4 كليبات من الحلقة Raw/ep.mp4.', 'still queued while the second runs');
  assert.equal((await call(app, {method: 'POST', pathname: `/api/projects/${podcast.json.project.id}/start`, body: {}})).status, 200, '«ابدأ دلوقتي» skips the queue');
  await stream.wait((e) => e.type === 'item' && e.id === podcast.json.project.id && e.item.role === 'user');
}));

test('deleting a project removes only what was asked, never Raw; a Raw file in use cannot be deleted', async () => withDashboard(async (app, root, stream) => {
  mkdirSync(path.join(root, 'Raw')); writeFileSync(path.join(root, 'Raw', 'clip.mp4'), 'x');
  const created = await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'recording', rawFile: 'Raw/clip.mp4'}});
  const id = created.json.project.id;
  assert.equal((await call(app, {method: 'DELETE', pathname: `/api/projects/${id}`, body: {}})).status, 409, 'not while Claude works');
  assert.equal((await call(app, {method: 'DELETE', pathname: '/api/raw?name=clip.mp4', body: {}})).status, 409, 'not while its project runs');
  await finishTurn(app, stream, id);
  await stream.wait((e) => e.type === 'project' && e.project.id === id && !e.project.running);
  for (const dir of ['Projects/test-reel', 'Projects/test-reel--one', 'Outputs/test-reel', 'Projects/other']) mkdirSync(path.join(root, dir), {recursive: true});
  const removed = await call(app, {method: 'DELETE', pathname: `/api/projects/${id}`, body: {studio: true}});
  assert.deepEqual(removed.json.removed.sort(), ['Projects/test-reel', 'Projects/test-reel--one']);
  assert.ok(existsSync(path.join(root, 'Outputs', 'test-reel')), 'outputs kept unless asked');
  assert.ok(existsSync(path.join(root, 'Projects', 'other')) && existsSync(path.join(root, 'Raw', 'clip.mp4')));
  assert.equal(app.store.get(id), null);
  assert.equal((await call(app, {method: 'DELETE', pathname: '/api/raw?name=clip.mp4', body: {}})).status, 200);
  assert.ok(!existsSync(path.join(root, 'Raw', 'clip.mp4')));
}));

test('the optional password locks everything behind a login, and wrong tries are slowed down', async () => {
  const {PasswordGate} = await import('../scripts/lib/dashboard/auth.mjs');
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'dashboard-pass-'));
  await PasswordGate.set(path.join(root, 'state', 'dashboard'), 'correct horse');
  const app = await createDashboardServer({root, port: 0, claudeCommand: FAKE, startSettings: async () => ({url: 'http://127.0.0.1:4381/?token=s', close: async () => {}})});
  try {
    const page = await call(app, {pathname: '/'});
    assert.match(page.text, /type="password"/, 'the login page');
    assert.equal((await call(app, {pathname: '/api/state'})).status, 401);
    assert.equal((await call(app, {method: 'POST', pathname: '/api/login', body: {password: 'wrong'}})).status, 401);
    const ok = await call(app, {method: 'POST', pathname: '/api/login', body: {password: 'correct horse'}});
    const session = ok.headers['set-cookie'][0].split(';')[0];
    const state = await call(app, {pathname: '/api/state', headers: {cookie: `rs_dashboard=${app.token}; ${session}`}});
    assert.equal(state.status, 200); assert.equal(state.json.password, true); assert.ok(state.json.disk.free > 0);
    const settings = await call(app, {method: 'POST', pathname: '/api/settings', body: {}, headers: {cookie: `rs_dashboard=${app.token}; ${session}`}});
    assert.equal(settings.json.url, 'http://127.0.0.1:4381/?token=s');
    for (let i = 0; i < 5; i++) await call(app, {method: 'POST', pathname: '/api/login', body: {password: 'nope'}});
    assert.equal((await call(app, {method: 'POST', pathname: '/api/login', body: {password: 'correct horse'}})).status, 429);
  } finally { await app.close(); rmSync(root, {recursive: true, force: true}); }
});

test('podcast stages follow the batch and its clip projects', async () => {
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'dashboard-podcast-'));
  try {
    mkdirSync(path.join(root, 'Raw')); writeFileSync(path.join(root, 'Raw', 'ep.mp4'), 'x');
    mkdirSync(path.join(root, 'Projects', 'ep', 'podcast'), {recursive: true}); writeFileSync(path.join(root, 'Projects', 'ep', 'selections.json'), '{}');
    mkdirSync(path.join(root, 'Projects', 'ep--one', 'prepared'), {recursive: true}); writeFileSync(path.join(root, 'Projects', 'ep--one', 'edit.json'), '{}');
    const project = {kind: 'podcast', slug: 'ep', rawFile: 'Raw/ep.mp4', stages: {}};
    recordStages(project, await detectStages(root, project));
    assert.deepEqual(Object.keys(project.stages), ['upload', 'transcript', 'plan', 'draft']);
    mkdirSync(path.join(root, 'Outputs', 'ep--one'), {recursive: true}); writeFileSync(path.join(root, 'Outputs', 'ep--one', 'ep--one.mp4'), 'v');
    recordStages(project, await detectStages(root, project));
    assert.equal(stageSummary(project).current, null);
    assert.equal(slugFromText('Projects/ep--one/edit.json'), 'ep');
    const {projectDetails} = await import('../scripts/lib/dashboard/details.mjs');
    assert.deepEqual((await projectDetails(root, 'ep')).clips.map((c) => [c.slug, c.outputs.length]), [['ep--one', 1]]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('over Tailscale the dashboard accepts only the saved machine name and maps the editor and settings to its https ports', async () => {
  const {allowedHost, publicLinks, saveRemote} = await import('../scripts/lib/dashboard/remote.mjs');
  const remote = {hosts: ['studio.tail1234.ts.net']};
  assert.equal(allowedHost('127.0.0.1:4382', null), true);
  assert.equal(allowedHost('studio.tail1234.ts.net', remote), true);
  assert.equal(allowedHost('studio.tail1234.ts.net:443', remote), true);
  assert.equal(allowedHost('studio.tail1234.ts.net', null), false, 'off until --tailscale saves the name');
  assert.equal(allowedHost('evil.example', remote), false);
  assert.equal(allowedHost('studio.tail1234.ts.net.evil.example', remote), false);
  assert.equal(publicLinks('127.0.0.1:4382', remote), null, 'local pages keep local links');
  assert.deepEqual(publicLinks('studio.tail1234.ts.net', remote), {editor: {local: 4380, url: 'https://studio.tail1234.ts.net:8443'}, settings: {local: 4381, url: 'https://studio.tail1234.ts.net:8444'}});
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'dashboard-remote-'));
  await assert.rejects(() => saveRemote(path.join(root, 'state', 'dashboard'), ['bad host!']));
  await saveRemote(path.join(root, 'state', 'dashboard'), ['Studio.Tail1234.ts.net.']);
  const app = await createDashboardServer({root, port: 0, claudeCommand: FAKE, relays: false});
  try {
    const host = 'studio.tail1234.ts.net';
    const visit = await call(app, {pathname: `/?token=${app.token}`, cookie: false, headers: {host}});
    assert.match(visit.headers['set-cookie'][0], /Secure/);
    const state = await call(app, {pathname: '/api/state', headers: {host}});
    assert.equal(state.status, 200); assert.equal(state.json.remote.editor.url, 'https://studio.tail1234.ts.net:8443');
    assert.equal((await call(app, {pathname: '/api/state'})).json.remote, null);
    assert.equal((await call(app, {pathname: '/api/state', headers: {host: 'other.tail1234.ts.net'}})).status, 421);
  } finally { await app.close(); rmSync(root, {recursive: true, force: true}); }
});

test('the relay lets the real settings screen answer a Tailscale request, which it refuses when reached directly', async () => {
  const {startRelays} = await import('../scripts/lib/dashboard/remote.mjs');
  const {createSettingsServer} = await import('../scripts/lib/settings-server.mjs');
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'dashboard-relay-'));
  writeFileSync(path.join(root, 'versions.lock.json'), JSON.stringify({edition: '0.0.0', fonts: []}));
  const settings = await createSettingsServer({root, port: 0});
  const target = Number(new URL(settings.origin).port), listen = 47391;
  const close = await startRelays({hosts: ['studio.tail1234.ts.net']}, {relays: {settings: {listen, target, https: 8444}}});
  const get = (port, headers) => new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: `/?token=${settings.token}`, headers}, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  try {
    const remote = {host: 'studio.tail1234.ts.net:8444', origin: 'https://studio.tail1234.ts.net:8444'};
    assert.equal(await get(target, remote), 403, 'the settings screen alone refuses a remote Host');
    assert.equal(await get(listen, remote), 200, 'through the relay it answers');
    assert.equal(await get(listen, {host: 'evil.example'}), 421, 'the relay refuses other names');
  } finally { await close(); await settings.close(); rmSync(root, {recursive: true, force: true}); }
});

test('a music montage is one project with the music, the chosen pictures, length and pace in its first message', async () => withDashboard(async (app, root, stream) => {
  mkdirSync(path.join(root, 'Raw'));
  for (const name of ['song.mp3', 'a.mp4', 'b.jpg', 'notes.txt']) writeFileSync(path.join(root, 'Raw', name), 'x');
  const bad = await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'montage', music: 'Raw/a.mp4', rawFiles: ['Raw/b.jpg']}});
  assert.equal(bad.status, 400, 'the music must be an audio file');
  assert.equal((await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'montage', music: 'Raw/song.mp3', rawFiles: ['Raw/notes.txt']}})).status, 400, 'pictures must be videos or photos');
  const made = await call(app, {method: 'POST', pathname: '/api/projects', body: {kind: 'montage', music: 'Raw/song.mp3', rawFiles: ['Raw/a.mp4', 'Raw/b.jpg'], duration: '45', pace: 'fast', notes: 'حماس'}});
  assert.equal(made.status, 200, made.text);
  const project = app.store.get(made.json.project.id);
  assert.deepEqual([project.kind, project.rawFile, project.media, project.duration, project.pace], ['montage', 'Raw/song.mp3', ['Raw/a.mp4', 'Raw/b.jpg'], '45', 'fast']);
  const message = project.items[0].text;
  for (const part of ['instructions/MONTAGE.md', 'Raw/song.mp3', 'Raw/a.mp4، Raw/b.jpg', '45 ثانية', 'سريعة', 'شيل صوت الفيديوهات', 'ملاحظاتي: حماس']) assert.ok(message.includes(part), part);
  mkdirSync(path.join(root, 'Projects', 'beat', 'montage'), {recursive: true});
  writeFileSync(path.join(root, 'Projects', 'beat', 'montage', 'analysis.json'), '{}');
  const stages = await detectStages(root, {kind: 'montage', slug: 'beat', rawFile: 'Raw/song.mp3'});
  assert.deepEqual(Object.entries(stages).filter(([, v]) => v).map(([k]) => k), ['upload', 'transcript']);
}));
