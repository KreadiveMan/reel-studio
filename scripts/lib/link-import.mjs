import {createDecipheriv} from 'node:crypto';
import {Readable} from 'node:stream';
import {HttpError, safeUploadName, saveRawStream} from './upload-server.mjs';

// Bring files into Raw/ from a share link instead of uploading them from the browser: the server downloads them
// directly, which is much faster for big recordings already in the cloud. A link can be one file or a folder
// (every video, photo and audio file inside it and its subfolders, other files skipped). Supported:
//   Google Drive  files (drive.google.com/file/d/<id>/…, …/open?id=<id>, …/uc?id=<id>) and folders (…/drive/folders/<id>)
//   MEGA          files (mega.nz/file/<handle>#<key>, the old #!<handle>!<key>) and folders (mega.nz/folder/<handle>#<key>, #F!…)
// Everything must be shared as "anyone with the link". Only these hosts are ever contacted (no other URL is fetched),
// and each file lands in Raw/ under the same never-replace naming as an upload.

const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
const b64url = (text) => Buffer.from(String(text).replaceAll('-', '+').replaceAll('_', '/'), 'base64');

/** {provider, …} for a supported link, or null. */
export function parseLink(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(host)) {
    const folder = /\/folders\/([^/?#]+)/.exec(url.pathname)?.[1];
    if (folder) return DRIVE_ID.test(folder) ? {provider: 'gdrive-folder', id: folder} : null;
    const id = /\/file\/d\/([^/]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
    return id && DRIVE_ID.test(id) ? {provider: 'gdrive', id} : null;
  }
  if (['mega.nz', 'mega.io', 'mega.co.nz', 'www.mega.nz'].includes(host)) {
    const folder = /^\/folder\/([A-Za-z0-9_-]{8})$/.exec(url.pathname);
    const folderHandle = folder?.[1] ?? /^#F!([A-Za-z0-9_-]{8})!/.exec(url.hash)?.[1];
    if (folderHandle) {
      const folderKey = (folder ? url.hash.slice(1) : /^#F![A-Za-z0-9_-]{8}!([A-Za-z0-9_-]+)/.exec(url.hash)?.[1] ?? '').split('/')[0];
      return b64url(folderKey).length === 16 ? {provider: 'mega-folder', handle: folderHandle, key: folderKey} : null;
    }
    const modern = /^\/file\/([A-Za-z0-9_-]{8})$/.exec(url.pathname);
    const handle = modern?.[1] ?? /^#!([A-Za-z0-9_-]{8})!/.exec(url.hash)?.[1];
    const key = modern ? url.hash.slice(1) : /^#![A-Za-z0-9_-]{8}!([A-Za-z0-9_-]+)/.exec(url.hash)?.[1];
    return handle && key && b64url(key).length === 32 ? {provider: 'mega', handle, key} : null;
  }
  return null;
}

const PRIVATE = 'الملف مش متاح للكل. خليه «أي حد معاه اللينك» وجرّب تاني.';

function nameFromDisposition(header) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '')?.[1];
  if (star) { try { return decodeURIComponent(star); } catch { /* fall through */ } }
  return /filename="?([^";]+)"?/i.exec(header ?? '')?.[1] ?? null;
}

// Google Drive answers small files at once; for large ones it may return a "can't scan for viruses" page whose
// form carries the confirm token. That form is followed once, on the same host.
async function openDrive({id}, fetchImpl) {
  if (!DRIVE_ID.test(id)) throw new HttpError(400, 'لينك Drive ناقص.');
  let response = await fetchImpl(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, {redirect: 'follow'});
  if (response.ok && /text\/html/i.test(response.headers.get('content-type') ?? '')) {
    const html = await response.text();
    const form = /<form[^>]+action="(https:\/\/drive\.usercontent\.google\.com\/download)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
    if (!form) throw new HttpError(403, PRIVATE);
    const params = new URLSearchParams();
    for (const input of form[2].matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)) params.set(input[1], input[2]);
    response = await fetchImpl(`${form[1]}?${params}`, {redirect: 'follow'});
    if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new HttpError(403, PRIVATE);
  }
  if (response.status === 404 || response.status === 403) throw new HttpError(404, PRIVATE);
  if (!response.ok || !response.body) throw new HttpError(502, `Google Drive رجّع خطأ (${response.status}). جرّب تاني بعد شوية.`);
  const length = Number(response.headers.get('content-length'));
  return {name: nameFromDisposition(response.headers.get('content-disposition')) ?? `drive-${id}`, size: Number.isSafeInteger(length) && length > 0 ? length : null,
    body: Readable.fromWeb(response.body), transforms: []};
}

// MEGA keeps files encrypted; the link's key (after #) opens them. The 256-bit key folds into the AES-128 key, its
// third quarter is the CTR nonce, and the file name sits in the attributes, AES-CBC encrypted with a zero IV.
export const megaKeys = (key) => megaKeysRaw(b64url(key));
function megaKeysRaw(raw) {
  const k = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) k[i] = raw[i] ^ raw[i + 16];
  return {k, iv: Buffer.concat([raw.subarray(16, 24), Buffer.alloc(8)])};
}
export function megaName(attributes, k) {
  try {
    const decipher = createDecipheriv('aes-128-cbc', k, Buffer.alloc(16)); decipher.setAutoPadding(false);
    const text = Buffer.concat([decipher.update(b64url(attributes)), decipher.final()]).toString('utf8').replace(/\0+$/, '');
    return text.startsWith('MEGA') ? JSON.parse(text.slice(4)).n ?? null : null;
  } catch { return null; }
}

async function openMega({handle, key, folder = null}, fetchImpl) {
  // A file inside a shared folder is requested by its node handle under the folder (?n=<folder>), a single file by its public handle.
  const request = folder ? {a: 'g', g: 1, ssl: 1, n: handle} : {a: 'g', g: 1, ssl: 1, p: handle};
  const api = await fetchImpl(`https://g.api.mega.co.nz/cs${folder ? `?id=0&n=${folder}` : ''}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify([request])});
  const answer = await api.json().catch(() => null);
  const info = Array.isArray(answer) ? answer[0] : answer;
  if (typeof info === 'number' || !info?.g) throw new HttpError(404, info === -9 || info === -2 ? 'الملف مش موجود على MEGA أو اللينك ناقص.' : `MEGA رفض الطلب (${info}). جرّب تاني بعد شوية.`);
  // Only MEGA's own storage hosts.
  const where = new URL(info.g);
  if (where.protocol !== 'https:' || !/\.(userstorage\.mega\.co\.nz|mega\.co\.nz|mega\.nz)$/i.test(where.hostname)) throw new HttpError(502, 'MEGA رجّع مكان تحميل غير متوقع.');
  const {k, iv} = Buffer.isBuffer(key) ? megaKeysRaw(key) : megaKeys(key);
  const response = await fetchImpl(info.g);
  if (!response.ok || !response.body) throw new HttpError(502, `MEGA رجّع خطأ (${response.status}).`);
  return {name: megaName(info.at, k) ?? `mega-${handle}`, size: Number(info.s) || null, body: Readable.fromWeb(response.body),
    transforms: [createDecipheriv('aes-128-ctr', k, iv)]};
}

// ---- folders ---------------------------------------------------------------------------------------------------
const MEDIA = /\.(mp4|mov|m4v|mkv|webm|avi|mts|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif|svg)$/i;
const MAX_FILES = 200;
const htmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// A public Drive folder's file list from its embedded view (no API key): each entry links to a file or a subfolder.
async function listDriveFolder(id, fetchImpl, depth = 0, seen = new Set()) {
  if (seen.has(id) || depth > 4) return [];
  seen.add(id);
  const response = await fetchImpl(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, {redirect: 'follow'});
  if (response.status === 404 || response.status === 403) throw new HttpError(404, PRIVATE);
  if (!response.ok) throw new HttpError(502, `Google Drive رجّع خطأ (${response.status}).`);
  const html = await response.text();
  if (!/flip-entry|folder-view/i.test(html)) throw new HttpError(403, PRIVATE);
  const files = [];
  for (const block of html.split(/class="flip-entry"/).slice(1)) {
    const href = /href="([^"]+)"/.exec(block)?.[1] ?? '';
    const title = htmlText(/class="flip-entry-title"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '');
    const sub = /\/drive\/folders\/([A-Za-z0-9_-]{10,})/.exec(href)?.[1];
    const file = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(href)?.[1] ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(href)?.[1];
    if (sub) files.push(...await listDriveFolder(sub, fetchImpl, depth + 1, seen));
    else if (file) files.push({name: title || `drive-${file}`, size: null, open: () => openDrive({id: file}, fetchImpl)});
  }
  return files;
}

// A public MEGA folder: its nodes come from the folder API; each node's key is AES-ECB encrypted with the folder key.
async function listMegaFolder({handle, key}, fetchImpl) {
  const api = await fetchImpl(`https://g.api.mega.co.nz/cs?id=0&n=${handle}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify([{a: 'f', c: 1, r: 1, ca: 1}])});
  const answer = await api.json().catch(() => null);
  const info = Array.isArray(answer) ? answer[0] : answer;
  if (typeof info === 'number' || !Array.isArray(info?.f)) throw new HttpError(404, 'الفولدر مش موجود على MEGA أو اللينك ناقص.');
  const folderKey = b64url(key);
  const nodeKey = (k) => {
    const part = String(k ?? '').split('/').map((x) => x.split(':')).find(([, v]) => v)?.[1];
    if (!part) return null;
    const decipher = createDecipheriv('aes-128-ecb', folderKey, null); decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(b64url(part)), decipher.final()]);
  };
  const files = [];
  for (const node of info.f) {
    if (node.t !== 0) continue;
    const raw = nodeKey(node.k);
    if (!raw || raw.length !== 32) continue;
    const {k} = megaKeysRaw(raw);
    const name = megaName(node.a, k) ?? `mega-${node.h}`;
    // The download answer inside a folder carries no attributes, so the name comes from the listing.
    files.push({name, size: Number(node.s) || null, open: async () => ({...await openMega({handle: node.h, key: raw, folder: handle}, fetchImpl), name})});
  }
  return files;
}

async function saveOne(root, source, onBytes) {
  let name;
  try { name = safeUploadName(source.name); }
  catch (error) { source.body.destroy(); throw new HttpError(400, `${source.name}: ${error.message}`); }
  return saveRawStream(root, name, source.size, source.body, {transforms: source.transforms, onBytes: (received) => onBytes(name, received, source.size)});
}

/**
 * Downloads a supported file or folder link into Raw/. onProgress({name, received, total, index, count}).
 * A file returns its save result; a folder returns {folder: true, files: [results], skipped: [names], failed: [{name, error}]}.
 */
export async function importLink(root, link, {fetchImpl = fetch, onProgress = () => {}} = {}) {
  const parsed = parseLink(link);
  if (!parsed) throw new HttpError(400, 'اللينك ده مش مدعوم. الصق لينك ملف أو فولدر من Google Drive أو MEGA.');
  if (parsed.provider === 'gdrive' || parsed.provider === 'mega') {
    const source = parsed.provider === 'gdrive' ? await openDrive(parsed, fetchImpl) : await openMega(parsed, fetchImpl);
    onProgress({name: source.name, received: 0, total: source.size, index: 0, count: 1});
    return saveOne(root, source, (name, received, total) => onProgress({name, received, total, index: 0, count: 1}));
  }
  const listed = parsed.provider === 'gdrive-folder' ? await listDriveFolder(parsed.id, fetchImpl) : await listMegaFolder(parsed, fetchImpl);
  const wanted = listed.filter((f) => MEDIA.test(f.name)), skipped = listed.filter((f) => !MEDIA.test(f.name)).map((f) => f.name);
  if (!wanted.length) throw new HttpError(400, listed.length ? `الفولدر مفيهوش فيديو أو صور أو صوت (فيه ${listed.length} ملف تاني).` : 'الفولدر فاضي أو مش متاح للكل.');
  if (wanted.length > MAX_FILES) throw new HttpError(400, `الفولدر فيه ${wanted.length} ملف؛ أقصى عدد ${MAX_FILES}. قسّمه لفولدرات أصغر.`);
  const files = [], failed = [];
  for (const [index, entry] of wanted.entries()) {
    try {
      onProgress({name: entry.name, received: 0, total: entry.size, index, count: wanted.length});
      const source = await entry.open();
      files.push(await saveOne(root, source, (name, received, total) => onProgress({name, received, total, index, count: wanted.length})));
    } catch (error) { failed.push({name: entry.name, error: error.message}); }
  }
  if (!files.length) throw new HttpError(502, `ولا ملف اتنزّل: ${failed[0]?.error ?? ''}`);
  return {folder: true, files, skipped, failed};
}
