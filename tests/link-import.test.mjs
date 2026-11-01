import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {importLink, megaKeys, megaName, parseLink} from '../scripts/lib/link-import.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(path.join(ROOT, 'state', 'tmp'), {recursive: true});
const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const reply = (body, headers = {}, status = 200) => new Response(body, {status, headers});

async function withRoot(fn) {
  const root = mkdtempSync(path.join(ROOT, 'state', 'tmp', 'link-import-'));
  try { await fn(root); } finally { rmSync(root, {recursive: true, force: true}); }
}

test('share links are recognised by host and shape; folders and other sites are not downloaded', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUv';
  for (const link of [`https://drive.google.com/file/d/${id}/view?usp=sharing`, `https://drive.google.com/open?id=${id}`, `https://drive.google.com/uc?id=${id}&export=download`, `https://drive.usercontent.google.com/download?id=${id}`]) {
    assert.deepEqual(parseLink(link), {provider: 'gdrive', id}, link);
  }
  assert.deepEqual(parseLink('https://drive.google.com/drive/folders/1abcdefghijk?usp=sharing'), {provider: 'gdrive-folder', id: '1abcdefghijk'});
  const key = b64url(randomBytes(32));
  assert.deepEqual(parseLink(`https://mega.nz/file/AbCd1234#${key}`), {provider: 'mega', handle: 'AbCd1234', key});
  assert.deepEqual(parseLink(`https://mega.nz/#!AbCd1234!${key}`), {provider: 'mega', handle: 'AbCd1234', key});
  const folderKey = b64url(randomBytes(16));
  assert.deepEqual(parseLink(`https://mega.nz/folder/AbCd1234#${folderKey}`), {provider: 'mega-folder', handle: 'AbCd1234', key: folderKey});
  assert.deepEqual(parseLink(`https://mega.nz/#F!AbCd1234!${folderKey}`), {provider: 'mega-folder', handle: 'AbCd1234', key: folderKey});
  assert.equal(parseLink('https://mega.nz/folder/AbCd1234#xyz'), null, 'a folder link without its key');
  for (const bad of ['http://drive.google.com/file/d/1AbCdEfGhIjK/view', 'https://evil.example/file/d/1AbCdEfGhIjK', 'https://mega.nz/file/AbCd1234#short', 'not a link', 'https://127.0.0.1:4380/?id=1AbCdEfGhIjK']) assert.equal(parseLink(bad), null, bad);
});

test('a Google Drive file lands in Raw under its own name, through the large-file confirmation when Drive asks', async () => withRoot(async (root) => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (!url.includes('uuid=')) return reply('<html><form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="1AbCdEfGhIjKlMn"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form></html>', {'content-type': 'text/html; charset=utf-8'});
    return reply('video-bytes', {'content-type': 'video/mp4', 'content-length': '11', 'content-disposition': "attachment; filename=\"x.mp4\"; filename*=UTF-8''%D8%B1%D8%AD%D9%84%D8%A9.mp4"});
  };
  const progress = [];
  const result = await importLink(root, 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view', {fetchImpl, onProgress: (p) => progress.push(p)});
  assert.equal(result.path, 'Raw/رحلة.mp4');
  assert.equal(readFileSync(path.join(root, 'Raw', 'رحلة.mp4'), 'utf8'), 'video-bytes');
  assert.ok(asked.every((u) => u.startsWith('https://drive.usercontent.google.com/download?')), 'only Drive itself is contacted');
  assert.equal(progress.at(-1).received, 11);
  const again = await importLink(root, 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view', {fetchImpl});
  assert.equal(again.path, 'Raw/رحلة-2.mp4', 'an existing file is never replaced');
}));

test('a private Drive file, a missing one and an unsupported type stop with a clear message and write nothing', async () => withRoot(async (root) => {
  await assert.rejects(importLink(root, 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view', {fetchImpl: async () => reply('<html>sign in</html>', {'content-type': 'text/html'})}), /أي حد معاه اللينك/);
  await assert.rejects(importLink(root, 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view', {fetchImpl: async () => reply('nope', {}, 404)}), /أي حد معاه اللينك/);
  await assert.rejects(importLink(root, 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view', {fetchImpl: async () => reply('MZ', {'content-disposition': 'attachment; filename="setup.exe"'})}), /مش مدعوم/);
  const raw = path.join(root, 'Raw');
  assert.ok(!existsSync(raw) || readdirSync(raw).length === 0, 'nothing written');
}));

test('a MEGA file is decrypted with the key in its link and named from its encrypted attributes', async () => withRoot(async (root) => {
  const raw = randomBytes(32), {k, iv} = megaKeys(b64url(raw));
  const plain = Buffer.from('a real music file '.repeat(1000));
  const cipher = createCipheriv('aes-128-ctr', k, iv), encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  let attributes = Buffer.from('MEGA{"n":"beat.mp3"}'); attributes = Buffer.concat([attributes, Buffer.alloc((16 - attributes.length % 16) % 16)]);
  const cbc = createCipheriv('aes-128-cbc', k, Buffer.alloc(16)); cbc.setAutoPadding(false);
  const at = b64url(Buffer.concat([cbc.update(attributes), cbc.final()]));
  assert.equal(megaName(at, k), 'beat.mp3');
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://g.api.mega.co.nz/cs') { assert.equal(JSON.parse(options.body)[0].p, 'AbCd1234'); return reply(JSON.stringify([{s: plain.length, at, g: 'https://gfs270n1.userstorage.mega.co.nz/dl/abc'}])); }
    assert.equal(url, 'https://gfs270n1.userstorage.mega.co.nz/dl/abc');
    return reply(encrypted);
  };
  const result = await importLink(root, `https://mega.nz/file/AbCd1234#${b64url(raw)}`, {fetchImpl});
  assert.equal(result.path, 'Raw/beat.mp3');
  assert.deepEqual(readFileSync(path.join(root, 'Raw', 'beat.mp3')), plain);
  await assert.rejects(importLink(root, `https://mega.nz/file/AbCd1234#${b64url(raw)}`, {fetchImpl: async () => reply(JSON.stringify([-9]))}), /مش موجود على MEGA/);
  await assert.rejects(importLink(root, `https://mega.nz/file/AbCd1234#${b64url(raw)}`, {fetchImpl: async () => reply(JSON.stringify([{s: 3, at, g: 'https://127.0.0.1:4380/x'}]))}), /غير متوقع/, 'only MEGA storage hosts are fetched');
}));

test('a Drive folder brings in every video, photo and sound inside it and its subfolders, and skips other files', async () => withRoot(async (root) => {
  const entry = (href, title) => `<div class="flip-entry" id="entry-x"><a href="${href}"><div class="flip-entry-title">${title}</div></a></div>`;
  const views = {
    '1RootFolder000': entry('https://drive.google.com/file/d/1FileVideo0001/view?usp=drive_web', 'trip.mp4') + entry('https://drive.google.com/file/d/1FileNotes0002/view', 'notes.txt') + entry('https://drive.google.com/drive/folders/1SubFolder0003', 'photos'),
    '1SubFolder0003': entry('https://drive.google.com/file/d/1FilePhoto0004/view', 'sea &amp; sun.jpg'),
  };
  const bodies = {'1FileVideo0001': ['trip.mp4', 'VIDEO'], '1FilePhoto0004': ['sea & sun.jpg', 'PHOTO']};
  const fetchImpl = async (url) => {
    const u = new URL(url), id = u.searchParams.get('id');
    if (u.pathname === '/embeddedfolderview') return views[id] ? reply(`<html><div class="folder-view">${views[id]}</div></html>`, {'content-type': 'text/html'}) : reply('x', {}, 404);
    const [name, body] = bodies[id];
    return reply(body, {'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`});
  };
  const steps = [];
  const result = await importLink(root, 'https://drive.google.com/drive/folders/1RootFolder000?usp=sharing', {fetchImpl, onProgress: (p) => steps.push(`${p.index + 1}/${p.count}`)});
  assert.equal(result.folder, true);
  assert.deepEqual(result.files.map((f) => f.path), ['Raw/trip.mp4', 'Raw/sea-sun.jpg']);
  assert.deepEqual(result.skipped, ['notes.txt']);
  assert.equal(readFileSync(path.join(root, 'Raw', 'trip.mp4'), 'utf8'), 'VIDEO');
  assert.ok(steps.includes('1/2') && steps.includes('2/2'));
  await assert.rejects(importLink(root, 'https://drive.google.com/drive/folders/1NoSuchFolder00', {fetchImpl}), /أي حد معاه اللينك/);
}));

test('a MEGA folder is listed, each file key opened with the folder copy of its key, and every file decrypted', async () => withRoot(async (root) => {
  const folderKey = randomBytes(16), files = {Nd0001aa: ['clip.mp4', Buffer.from('clip bytes '.repeat(50))], Nd0002bb: ['song.mp3', Buffer.from('song bytes '.repeat(80))], Nd0003cc: ['readme.pdf', Buffer.from('pdf')]};
  const nodes = [{h: 'Fold0000', t: 1, a: 'x', k: ''}];
  const stored = {};
  for (const [h, [name, plain]] of Object.entries(files)) {
    const fileKey = randomBytes(32), {k, iv} = megaKeys(b64url(fileKey));
    const ecb = createCipheriv('aes-128-ecb', folderKey, null); ecb.setAutoPadding(false);
    const encKey = Buffer.concat([ecb.update(fileKey), ecb.final()]);
    let attrs = Buffer.from(`MEGA{"n":"${name}"}`); attrs = Buffer.concat([attrs, Buffer.alloc((16 - attrs.length % 16) % 16)]);
    const cbc = createCipheriv('aes-128-cbc', k, Buffer.alloc(16)); cbc.setAutoPadding(false);
    const ctr = createCipheriv('aes-128-ctr', k, iv);
    stored[h] = Buffer.concat([ctr.update(plain), ctr.final()]);
    // As in a real shared folder: the owner's copy of the key comes first and does not open with the link key.
    nodes.push({h, p: 'Fold0000', t: 0, s: plain.length, a: b64url(Buffer.concat([cbc.update(attrs), cbc.final()])), k: `OwnerUsr:${b64url(randomBytes(32))}/Fold0000:${b64url(encKey)}`});
  }
  const fetchImpl = async (url, options = {}) => {
    if (url.startsWith('https://g.api.mega.co.nz/cs?id=0&n=AbCd1234')) {
      const [request] = JSON.parse(options.body);
      if (request.a === 'f') return reply(JSON.stringify([{f: nodes}]));
      return reply(JSON.stringify([{s: stored[request.n].length, g: `https://gfs1.userstorage.mega.co.nz/dl/${request.n}`}]));
    }
    return reply(stored[url.split('/').at(-1)]);
  };
  const result = await importLink(root, `https://mega.nz/folder/AbCd1234#${b64url(folderKey)}`, {fetchImpl});
  assert.deepEqual(result.files.map((f) => f.path).sort(), ['Raw/clip.mp4', 'Raw/song.mp3']);
  assert.deepEqual(result.skipped, ['readme.pdf']);
  assert.deepEqual(readFileSync(path.join(root, 'Raw', 'song.mp3')), files.Nd0002bb[1]);
}));
