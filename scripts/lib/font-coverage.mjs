import {promises as fs, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {woff2Tables} from './woff2-axes.mjs';

// Which Unicode code points a font file draws. The cmap of a WOFF2 font is stored untransformed, so the table directory and brotli
// code of woff2-axes.mjs hand over the real table bytes. No network, no browser: the answer is read from the file itself.

/**
 * Code points every installed Arabic font should draw: the letters of the Arabic alphabet (U+0621-U+063A and U+0641-U+064A; the rarely shipped
 * extended letters U+063B-U+063F are left out), the Arabic-Indic digits, the tatweel and the harakat. The doctor checks them.
 */
export const REQUIRED_ARABIC_CODE_POINTS = Object.freeze([
  ...range(0x0621, 0x063a), ...range(0x0641, 0x064a), ...range(0x0660, 0x0669), 0x0640, ...range(0x064b, 0x0652),
]);

function range(from, to) {
  return Array.from({length: to - from + 1}, (_, index) => from + index);
}

/**
 * The code points a `cmap` table maps to a real glyph (glyph 0 is .notdef, so it counts as missing). Unicode subtables only
 * (platform 0, and Windows encodings 1 and 10), formats 4 and 12; other formats are skipped.
 */
export function parseCmap(table) {
  const bytes = table instanceof Uint8Array ? table : new Uint8Array(table);
  if (bytes.length < 4) throw new Error('The cmap table is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = view.getUint16(2);
  if (bytes.length < 4 + records * 8) throw new Error('The cmap table directory is truncated.');
  const covered = new Set();
  const done = new Set();
  for (let i = 0; i < records; i++) {
    const platform = view.getUint16(4 + i * 8), encoding = view.getUint16(6 + i * 8), offset = view.getUint32(8 + i * 8);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || done.has(offset)) continue;
    done.add(offset);
    if (offset + 4 > bytes.length) throw new Error('A cmap subtable starts outside the table.');
    const format = view.getUint16(offset);
    if (format === 4) readFormat4(view, offset, covered);
    else if (format === 12) readFormat12(view, offset, covered);
  }
  return covered;
}

function readFormat4(view, offset, covered) {
  if (offset + 14 > view.byteLength) throw new Error('A cmap format 4 subtable is truncated.');
  const segments = view.getUint16(offset + 6) / 2;
  const ends = offset + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, offsets = deltas + segments * 2;
  if (offsets + segments * 2 > view.byteLength) throw new Error('A cmap format 4 subtable is truncated.');
  for (let i = 0; i < segments; i++) {
    const end = view.getUint16(ends + i * 2), start = view.getUint16(starts + i * 2);
    const delta = view.getUint16(deltas + i * 2), rangeOffset = view.getUint16(offsets + i * 2);
    for (let code = start; code <= end; code++) {
      if (code === 0xffff) continue;
      let glyph;
      if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
      else {
        const at = offsets + i * 2 + rangeOffset + (code - start) * 2;
        if (at + 2 > view.byteLength) continue;
        const raw = view.getUint16(at);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) covered.add(code);
    }
  }
}

function readFormat12(view, offset, covered) {
  if (offset + 16 > view.byteLength) throw new Error('A cmap format 12 subtable is truncated.');
  const groups = view.getUint32(offset + 12);
  if (offset + 16 + groups * 12 > view.byteLength) throw new Error('A cmap format 12 subtable is truncated.');
  for (let i = 0; i < groups; i++) {
    const at = offset + 16 + i * 12;
    const start = view.getUint32(at), end = Math.min(view.getUint32(at + 4), 0x10ffff), first = view.getUint32(at + 8);
    // A real font never maps a block this wide; a dummy group would only fill the set with noise.
    if (end < start || end - start > 0x20000) continue;
    for (let code = start; code <= end; code++) if (first + (code - start) !== 0) covered.add(code);
  }
}

function coverageFromBuffer(buffer) {
  const cmap = woff2Tables(buffer).get('cmap');
  if (!cmap) throw new Error('The WOFF2 font has no cmap table.');
  return parseCmap(cmap);
}

const cache = new Map();
const signature = (file, stat) => `${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`;

/** The code points a WOFF2 file draws. The same unchanged file is parsed once per process. */
export async function fontCoverage(file) {
  const stat = await fs.stat(file);
  const key = signature(file, stat);
  const hit = cache.get(key);
  if (hit) return hit;
  const covered = coverageFromBuffer(await fs.readFile(file));
  cache.set(key, covered);
  return covered;
}

export function fontCoverageSync(file) {
  const key = signature(file, statSync(file));
  const hit = cache.get(key);
  if (hit) return hit;
  const covered = coverageFromBuffer(readFileSync(file));
  cache.set(key, covered);
  return covered;
}

/**
 * The installed font files behind each family the studio can draw text in. A name is either a PreferredFont of the editor
 * (engine/src/styles/types.ts FONT_CHOICES) or a family a theme uses; the values are the family names of
 * engine/public/fonts/manifest.json whose faces make it up (core/fonts.ts registers the same sources).
 */
export const FAMILY_SOURCES = Object.freeze({
  'Cairo': ['Cairo'],
  'Tajawal': ['Tajawal'],
  'Noto Naskh Arabic': ['Noto Naskh Arabic'],
  'Plex Display': ['IBM Plex Sans Arabic'],
  'Grid Sans': ['Inter', 'IBM Plex Sans Arabic'],
  'Noto Kufi Arabic': ['Noto Kufi Arabic'],
  'Readex Pro': ['Readex Pro'],
  'El Messiri': ['El Messiri'],
  'IBM Plex Sans Arabic': ['IBM Plex Sans Arabic'],
  'Inter': ['Inter'],
  'Source Serif 4': ['Source Serif 4'],
  'IBM Plex Mono': ['IBM Plex Mono'],
  'Lalezar': ['Lalezar'],
  'Aref Ruqaa': ['Aref Ruqaa'],
  'Aref Ruqaa Ink': ['Aref Ruqaa Ink'],
  'Reem Kufi': ['Reem Kufi'],
  'Amiri': ['Amiri'],
  'Alexandria': ['Alexandria'],
  'Marhey': ['Marhey'],
  'Almarai': ['Almarai'],
});

/** `U+0600-06FF, U+200C, U+4??` as `[[from, to], ...]`. */
export function parseUnicodeRange(text) {
  const spans = [];
  for (const part of String(text ?? '').split(',')) {
    const match = /^\s*U\+([0-9A-Fa-f?]{1,6})(?:-([0-9A-Fa-f]{1,6}))?\s*$/.exec(part);
    if (!match) continue;
    if (match[1].includes('?')) spans.push([parseInt(match[1].replace(/\?/g, '0'), 16), parseInt(match[1].replace(/\?/g, 'F'), 16)]);
    else spans.push([parseInt(match[1], 16), parseInt(match[2] ?? match[1], 16)]);
  }
  return spans;
}

const inSpans = (spans, code) => spans.some(([from, to]) => code >= from && code <= to);

function plan(family, fontsDir, manifestText) {
  const sources = FAMILY_SOURCES[family];
  if (!sources) return null;
  const manifest = JSON.parse(manifestText);
  const seen = new Set();
  const faces = [];
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (!sources.includes(entry.family)) continue;
    const key = `${entry.sha256 ?? entry.file}|${entry.unicodeRange ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    faces.push({file: path.join(fontsDir, entry.file), spans: entry.unicodeRange ? parseUnicodeRange(entry.unicodeRange) : null});
  }
  return faces.length ? faces : null;
}

function union(faces, coverageOf) {
  const out = new Set();
  let read = 0;
  for (const face of faces) {
    let covered;
    try { covered = coverageOf(face.file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    read++;
    for (const code of covered) if (!face.spans || inSpans(face.spans, code)) out.add(code);
  }
  return read ? out : null;
}

/**
 * The code points a family really draws in the browser: the union of its installed faces, each cut to its own unicode-range
 * (a face never serves a code point outside the range the studio declares for it). null when the family or its files are not installed.
 */
export async function familyCoverage(family, {fontsDir}) {
  let manifestText;
  try { manifestText = await fs.readFile(path.join(fontsDir, 'manifest.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const faces = plan(family, fontsDir, manifestText);
  if (!faces) return null;
  const sets = new Map();
  for (const face of faces) {
    try { sets.set(face.file, await fontCoverage(face.file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return union(faces, (file) => { const hit = sets.get(file); if (!hit) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return hit; });
}

export function familyCoverageSync(family, {fontsDir}) {
  let manifestText;
  try { manifestText = readFileSync(path.join(fontsDir, 'manifest.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const faces = plan(family, fontsDir, manifestText);
  return faces ? union(faces, fontCoverageSync) : null;
}
