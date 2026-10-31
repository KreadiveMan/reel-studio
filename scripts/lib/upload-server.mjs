import http from 'node:http';
import {createWriteStream, promises as fs} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

// The Raw upload page: the creator sends recordings and assets from their own computer into Raw/ while the studio
// runs on a server. It listens on 127.0.0.1 only (reach it through an SSH tunnel), every request needs the
// session token, and a file never replaces anything already in Raw/: a taken name gets a -2, -3 … suffix.

const UI_FILE = fileURLToPath(new URL('../upload-ui/index.html', import.meta.url));
export const UPLOAD_EXTENSIONS = Object.freeze(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
export const MAX_UPLOAD_BYTES = 50 * 1024 ** 3;
const DISK_MARGIN = 1024 ** 3;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** A safe file name for Raw/: letters (any script), digits, dot, dash, underscore; spaces become dashes. */
export function safeUploadName(raw) {
  const base = path.basename(String(raw ?? '').replaceAll('\\', '/')).normalize('NFC');
  const dot = base.lastIndexOf('.');
  if (dot <= 0) throw new HttpError(400, 'اسم الملف لازم يكون فيه امتداد زي .mp4');
  const ext = base.slice(dot + 1).toLowerCase();
  if (!UPLOAD_EXTENSIONS.includes(ext)) throw new HttpError(400, `نوع الملف .${ext} مش مدعوم. المدعوم: ${UPLOAD_EXTENSIONS.join(' ')}`);
  const stem = base.slice(0, dot).trim().replace(/\s+/gu, '-').replace(/[^\p{L}\p{N}._-]/gu, '').replace(/^[.-]+/u, '').slice(0, 120);
  return `${stem || 'upload'}.${ext}`;
}

const sameToken = (given, token) => typeof given === 'string' && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

export async function createUploadServer({root, port = 0, token = randomBytes(32).toString('hex')} = {}) {
  root = await fs.realpath(root);
  const rawDir = path.join(root, 'Raw');
  let origin;

  async function rawFolder() {
    await fs.mkdir(rawDir, {recursive: true});
    const stat = await fs.lstat(rawDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(500, 'فولدر Raw مربوط بمكان تاني؛ مش هرفع فيه.');
    return rawDir;
  }

  async function listFiles() {
    const dir = await rawFolder();
    const files = [];
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      files.push({name: entry.name, bytes: stat.size, modified: stat.mtime.toISOString()});
    }
    return files.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async function receive(req, url) {
    const name = safeUploadName(url.searchParams.get('name'));
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(411, 'حجم الملف مش معروف؛ جرّب تاني.');
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'الملف أكبر من 50 جيجا.');
    const dir = await rawFolder();
    const free = await fs.statfs(dir).then(s => s.bavail * s.bsize).catch(() => Infinity);
    if (size + DISK_MARGIN > free) throw new HttpError(507, `المساحة الفاضية على السيرفر مش كفاية (فاضي ${(free / 1024 ** 3).toFixed(1)} جيجا).`);
    const partial = path.join(dir, `.${randomUUID()}.upload.partial`);
    let received = 0;
    const counter = new Transform({transform(chunk, _enc, done) {
      received += chunk.length;
      if (received > size) return done(new HttpError(400, 'الملف وصل أكبر من حجمه المعلن.'));
      done(null, chunk);
    }});
    try {
      await pipeline(req, counter, createWriteStream(partial, {flags: 'wx'}));
      if (received !== size) throw new HttpError(400, 'الرفع اتقطع قبل ما يكمل؛ جرّب تاني.');
      const dot = name.lastIndexOf('.');
      for (let n = 1; n < 1000; n++) {
        const candidate = n === 1 ? name : `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
        try {
          await fs.link(partial, path.join(dir, candidate)); // fails when the name is taken: nothing is ever replaced
          return {ok: true, name: candidate, path: `Raw/${candidate}`, bytes: received, renamed: candidate !== name};
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      throw new HttpError(409, 'فيه ملفات كتير بنفس الاسم؛ غيّر اسم الملف.');
    } finally {
      await fs.rm(partial, {force: true});
    }
  }

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'});
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      // Only a loopback name may call (any local port, so an SSH tunnel may map another one); any other Host
      // header means DNS rebinding.
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(req.headers.host ?? '')) throw new HttpError(421, 'العنوان ده مش مسموح.');
      if (!sameToken(req.headers['x-upload-token'] ?? url.searchParams.get('token'), token)) throw new HttpError(401, 'الرابط ناقص أو قديم؛ افتح الرابط اللي طبعه المساعد.');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, (await fs.readFile(UI_FILE, 'utf8')).replaceAll('__TOKEN__', token), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/files') return send(res, 200, {ok: true, files: await listFiles()});
      if (req.method === 'PUT' && url.pathname === '/api/upload') return send(res, 200, await receive(req, url));
      throw new HttpError(404, 'الصفحة مش موجودة.');
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, {ok: false, error: error.status ? error.message : 'حصلت مشكلة في الرفع؛ جرّب تاني.'});
      if (error.status && req.readable) req.resume();
    }
  });
  server.requestTimeout = 0; // large recordings over a slow link must not be cut off
  server.headersTimeout = 30_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {origin, token, url: `${origin}/?token=${token}`, close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })};
}
