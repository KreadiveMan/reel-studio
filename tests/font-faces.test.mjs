import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bundleEngine} from './helpers/engine-bundle.mjs';

const lock = JSON.parse(await readFile(new URL('../versions.lock.json', import.meta.url), 'utf8'));
const fonts = await bundleEngine(`export {FAMILY, LOADED_FAMILIES, REGISTERED} from './engine/src/core/fonts.ts';`);
const facesOf = (family) => fonts.REGISTERED.filter((face) => face.family === family);
const pinned = (file) => lock.fonts.find((font) => font.file === file);

test('Grid Sans is one family made of Inter latin and IBM Plex Sans Arabic arabic', () => {
  assert.equal(fonts.FAMILY.gridSans, 'Grid Sans');
  assert.ok(fonts.LOADED_FAMILIES.includes('Grid Sans'));
  assert.deepEqual(facesOf('Grid Sans').map((face) => [face.subset, face.file, face.weight]), [
    ['latin', 'Inter-latin-var.woff2', '400'],
    ['arabic', 'IBMPlexSansArabic-arabic-400.woff2', '400'],
    ['latin', 'Inter-latin-var.woff2', '500'],
    ['arabic', 'IBMPlexSansArabic-arabic-500.woff2', '500'],
    ['latin', 'Inter-latin-var.woff2', '600'],
    ['arabic', 'IBMPlexSansArabic-arabic-600.woff2', '600'],
    ['latin', 'Inter-latin-var.woff2', '700'],
    ['arabic', 'IBMPlexSansArabic-arabic-700.woff2', '700'],
  ]);
  for (const face of facesOf('Grid Sans')) {
    assert.equal(face.unicodeRange, pinned(face.file).unicodeRange, `${face.file} keeps the recorded range`);
    assert.equal(face.bytes, pinned(face.file).bytes);
  }
});

test('Latin and Arabic share the same weight descriptors, so a browser keeps both scripts in one face', () => {
  // A browser picks the face for the requested weight first and applies unicode-range only among faces with the
  // same descriptors. A Latin range face ("100 900") next to static Arabic weights lost to the exact Arabic match
  // at 400 to 700 and left every Latin letter and digit in the system serif.
  const faces = facesOf('Grid Sans');
  const weights = (subset) => faces.filter((face) => face.subset === subset).map((face) => face.weight);
  assert.deepEqual(weights('latin'), ['400', '500', '600', '700'], 'one Inter face per weight, never a range');
  assert.deepEqual(weights('latin'), weights('arabic'), 'the same weights for both scripts');
  assert.equal(new Set(faces.filter((face) => face.subset === 'latin').map((face) => face.file)).size, 1, 'one Latin file serves every weight');
});

test('the families that already existed keep their faces', () => {
  assert.deepEqual(facesOf('Plex Display').map((face) => [face.subset, face.file, face.weight]), [
    ['latin', 'IBMPlexSansArabic-latin-700.woff2', '1 1000'],
    ['arabic', 'IBMPlexSansArabic-arabic-700.woff2', '1 1000'],
  ]);
  assert.deepEqual(['Cairo', 'Tajawal', 'IBM Plex Mono', 'Noto Naskh Arabic', 'Source Serif 4'].map((family) => facesOf(family).length), [2, 6, 2, 6, 7]);
  const v4 = ['Alexandria', 'Almarai', 'Amiri', 'Aref Ruqaa', 'Aref Ruqaa Ink', 'Lalezar', 'Marhey', 'Reem Kufi'];
  assert.equal(fonts.REGISTERED.filter((face) => !v4.includes(face.family)).length, 39, 'twenty-four earlier faces, eight for Grid Sans, six for the three Arabic display families and the Source Serif italic');
  assert.deepEqual(v4.map((family) => facesOf(family).length), [2, 6, 4, 4, 4, 2, 2, 2], 'the V4 display families and Almarai, as pinned in the manifest template');
  assert.deepEqual(['Noto Kufi Arabic', 'Readex Pro', 'El Messiri'].map((family) => facesOf(family).length), [2, 2, 2]);
});

test('Source Serif 4 carries one real italic face (latin 400), so Latin words in a cartoon headline are never slanted by the browser', () => {
  const italic = facesOf('Source Serif 4').filter((face) => face.style === 'italic');
  assert.deepEqual(italic.map((face) => [face.subset, face.file, face.weight]), [['latin', 'SourceSerif4-latin-400-italic.woff2', '400']]);
  assert.equal(italic[0].bytes, pinned(italic[0].file).bytes, 'the pinned byte count');
  assert.ok(facesOf('Source Serif 4').filter((face) => face.style !== 'italic').every((face) => face.style === 'normal'), 'the upright faces say so');
});
