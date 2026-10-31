import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createUploadServer, safeUploadName} from '../scripts/lib/upload-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(path.join(ROOT, 'state', 'tmp'), {recursive: true});

function request(app, {method = 'GET', pathname = '/', token = app.token, host, body}) {
  const url = new URL(pathname, app.origin);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {method, headers: {...(token ? {'x-upload-token': token} : {}), ...(host ? {host} : {}), ...(body ? {'content-length': body.length} : {})}}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({status: res.statusCode, text, json}); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(fn) {
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'upload-test-'));
  const app = await createUploadServer({root, port: 0});
  try { await fn(app, root); } finally { await app.close(); rmSync(root, {recursive: true, force: true}); }
}

test('names keep letters and digits, lose folders and odd characters, and need a known extension', () => {
  assert.equal(safeUploadName('my video 01.MP4'), 'my-video-01.mp4');
  assert.equal(safeUploadName('../../etc/passwd.mp4'), 'passwd.mp4');
  assert.equal(safeUploadName('C:\\Users\\me\\فيديو جديد.mov'), 'فيديو-جديد.mov');
  assert.equal(safeUploadName('.hidden.mp4'), 'hidden.mp4');
  assert.throws(() => safeUploadName('script.sh'), /مش مدعوم/);
  assert.throws(() => safeUploadName('noextension'), /امتداد/);
});

test('every request needs the token and a loopback Host header', async () => withServer(async (app) => {
  assert.equal((await request(app, {token: null})).status, 401);
  assert.equal((await request(app, {token: 'x'.repeat(64)})).status, 401);
  assert.equal((await request(app, {host: 'evil.example:4382'})).status, 421);
  assert.equal((await request(app, {host: 'localhost:9999', pathname: '/api/files'})).status, 200);
  const page = await request(app, {});
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(app.token) && !page.text.includes('__TOKEN__'));
}));

test('an upload lands in Raw/ with its exact bytes and never replaces an existing file', async () => withServer(async (app, root) => {
  mkdirSync(path.join(root, 'Raw'), {recursive: true});
  writeFileSync(path.join(root, 'Raw', 'clip.mp4'), 'original');
  const body = Buffer.from('new recording bytes');
  const first = await request(app, {method: 'PUT', pathname: '/api/upload?name=clip.mp4', body});
  assert.equal(first.status, 200);
  assert.deepEqual({name: first.json.name, path: first.json.path, renamed: first.json.renamed, bytes: first.json.bytes}, {name: 'clip-2.mp4', path: 'Raw/clip-2.mp4', renamed: true, bytes: body.length});
  assert.equal(readFileSync(path.join(root, 'Raw', 'clip.mp4'), 'utf8'), 'original');
  assert.deepEqual(readFileSync(path.join(root, 'Raw', 'clip-2.mp4')), body);
  const second = await request(app, {method: 'PUT', pathname: '/api/upload?name=clip.mp4', body});
  assert.equal(second.json.name, 'clip-3.mp4');
  assert.deepEqual(readdirSync(path.join(root, 'Raw')).sort(), ['clip-2.mp4', 'clip-3.mp4', 'clip.mp4'], 'no partial file is left behind');
  const list = await request(app, {pathname: '/api/files'});
  assert.deepEqual(list.json.files.map((f) => f.name).sort(), ['clip-2.mp4', 'clip-3.mp4', 'clip.mp4']);
}));

test('a refused upload writes nothing', async () => withServer(async (app, root) => {
  const refused = await request(app, {method: 'PUT', pathname: '/api/upload?name=tool.exe', body: Buffer.from('MZ')});
  assert.equal(refused.status, 400);
  assert.ok(!existsSync(path.join(root, 'Raw')) || readdirSync(path.join(root, 'Raw')).length === 0);
}));
