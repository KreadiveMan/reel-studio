import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DECLARED_FONTS, V4_FONT_FAMILIES, cssRequestUrl, fontFileName} from '../scripts/lib/font-css.mjs';
import {PREVIEW_FAMILIES, previewFaces} from '../scripts/lib/settings-fonts.mjs';
import {normalizePreferences} from '../scripts/lib/branding.mjs';
import {FONT_CHOICES} from '../engine/src/styles/types.ts';
import {PREFERENCE_VALUES, defaultPreferences} from '../engine/src/core/preference-options.ts';
import {FONT_LABEL} from '../engine/src/review-editor/panels/look-state.ts';
import {editManifestSchema} from '../engine/src/prepared-edit/schema.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');
const lock = JSON.parse(await read('versions.lock.json'));
const V4 = ['Lalezar', 'Aref Ruqaa', 'Aref Ruqaa Ink', 'Reem Kufi', 'Amiri', 'Alexandria', 'Marhey', 'Almarai'];

// The exact Google Fonts requests and the flat file names the download table in LANE-REPORT.md lists.
const EXPECTED = {
  Lalezar: {url: 'https://fonts.googleapis.com/css2?family=Lalezar:wght@400&display=swap', files: ['Lalezar-arabic-400.woff2', 'Lalezar-latin-400.woff2']},
  'Aref Ruqaa': {url: 'https://fonts.googleapis.com/css2?family=Aref+Ruqaa:wght@400;700&display=swap',
    files: ['ArefRuqaa-arabic-400.woff2', 'ArefRuqaa-arabic-700.woff2', 'ArefRuqaa-latin-400.woff2', 'ArefRuqaa-latin-700.woff2']},
  'Aref Ruqaa Ink': {url: 'https://fonts.googleapis.com/css2?family=Aref+Ruqaa+Ink:wght@400;700&display=swap',
    files: ['ArefRuqaaInk-arabic-400.woff2', 'ArefRuqaaInk-arabic-700.woff2', 'ArefRuqaaInk-latin-400.woff2', 'ArefRuqaaInk-latin-700.woff2']},
  'Reem Kufi': {url: 'https://fonts.googleapis.com/css2?family=Reem+Kufi:wght@400..700&display=swap', files: ['ReemKufi-arabic-var.woff2', 'ReemKufi-latin-var.woff2']},
  Amiri: {url: 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap',
    files: ['Amiri-arabic-400.woff2', 'Amiri-arabic-700.woff2', 'Amiri-latin-400.woff2', 'Amiri-latin-700.woff2']},
  Alexandria: {url: 'https://fonts.googleapis.com/css2?family=Alexandria:wght@100..900&display=swap', files: ['Alexandria-arabic-var.woff2', 'Alexandria-latin-var.woff2']},
  Marhey: {url: 'https://fonts.googleapis.com/css2?family=Marhey:wght@300..700&display=swap', files: ['Marhey-arabic-var.woff2', 'Marhey-latin-var.woff2']},
  Almarai: {url: 'https://fonts.googleapis.com/css2?family=Almarai:wght@400;700;800&display=swap',
    files: ['Almarai-arabic-400.woff2', 'Almarai-arabic-700.woff2', 'Almarai-arabic-800.woff2', 'Almarai-latin-400.woff2', 'Almarai-latin-700.woff2', 'Almarai-latin-800.woff2']},
};

test('the later families are declared for the fetch script with the requests the download table lists', () => {
  assert.deepEqual([...V4_FONT_FAMILIES], V4);
  for (const family of V4) {
    const spec = DECLARED_FONTS.find((item) => item.family === family);
    assert.ok(spec, `${family} is declared`);
    assert.deepEqual(spec.subsets, ['arabic', 'latin']);
    assert.equal(cssRequestUrl(spec), EXPECTED[family].url, family);
    const files = spec.subsets.flatMap((subset) => (spec.axes ? [spec.weights[0]] : spec.weights).map((weight) =>
      fontFileName(spec, {subset, weight: String(weight), style: 'normal'})));
    assert.deepEqual([...files].sort(), [...EXPECTED[family].files].sort(), `${family} flat file names`);
  }
  // Variable families are requested as one file per subset; their axes are checked on download (woff2Axes).
  assert.deepEqual(DECLARED_FONTS.find((spec) => spec.family === 'Reem Kufi').axes, {wght: [400, 700]});
  assert.deepEqual(DECLARED_FONTS.find((spec) => spec.family === 'Alexandria').axes, {wght: [100, 900]});
  assert.deepEqual(DECLARED_FONTS.find((spec) => spec.family === 'Marhey').axes, {wght: [300, 700]});
  for (const family of ['Lalezar', 'Aref Ruqaa', 'Aref Ruqaa Ink', 'Amiri', 'Almarai']) assert.equal(DECLARED_FONTS.find((spec) => spec.family === family).axes, undefined, `${family} is static`);
});

test('only the new families may be declared without a lock pin, and a pinned one is pinned for every declared face', () => {
  const pinned = new Set(lock.fonts.map((font) => font.family));
  const unpinned = DECLARED_FONTS.filter((spec) => !pinned.has(spec.family)).map((spec) => spec.family);
  assert.deepEqual(unpinned.filter((family) => !V4.includes(family)), [], 'the earlier families stay pinned');
  for (const spec of DECLARED_FONTS.filter((item) => V4.includes(item.family) && pinned.has(item.family))) {
    for (const subset of spec.subsets) {
      for (const weight of spec.weights) {
        assert.ok(lock.fonts.some((font) => font.family === spec.family && font.subset === subset && font.weight === weight), `${spec.family} ${subset} ${weight} is declared and pinned`);
      }
    }
    assert.ok(lock.fonts.filter((font) => font.family === spec.family).every((font) => font.file.endsWith('-var.woff2') === Boolean(spec.axes)), `${spec.family} file names`);
  }
});

test('the families reach every place a font is chosen', () => {
  assert.deepEqual(FONT_CHOICES.slice(-V4.length), V4);
  assert.deepEqual(Object.keys(FONT_LABEL).sort(), [...FONT_CHOICES].sort(), 'every font has an editor label');
  for (const family of V4) {
    assert.ok(PREFERENCE_VALUES.font.includes(family), `${family} is a preference value`);
    const preferences = {...defaultPreferences(), font: {mode: 'fixed', value: family}};
    assert.deepEqual(normalizePreferences(preferences).font, {mode: 'fixed', value: family});
    assert.equal(editManifestSchema.shape.fontFamily.parse(family), family);
  }
  assert.throws(() => normalizePreferences({...defaultPreferences(), font: {mode: 'fixed', value: 'Papyrus'}}));
});

test('the settings page previews each new family from its own files', () => {
  assert.deepEqual(PREVIEW_FAMILIES.slice(-V4.length).map((family) => family.alias), V4);
  const fake = (family, subset, weight, file) => ({family, file, subset, weight, style: 'normal', bytes: 10, unicodeRange: 'U+0000-00FF', sha256: 'a'.repeat(64), url: `https://fonts.gstatic.com/s/x/${file}`});
  const faces = [];
  for (const [family, {files}] of Object.entries(EXPECTED)) {
    for (const file of files) {
      const [, subset, kind] = /^[A-Za-z]+-([a-z-]+)-(var|\d+)\.woff2$/.exec(file);
      faces.push(fake(family, subset, kind === 'var' ? 400 : Number(kind), file));
    }
  }
  const css = (alias) => [...new Set(previewFaces(faces).filter((item) => item.alias === alias).map((item) => item.css))].sort();
  assert.deepEqual(css('Lalezar'), ['400']);
  assert.deepEqual(css('Aref Ruqaa'), ['400', '700']);
  assert.deepEqual(css('Aref Ruqaa Ink'), ['400', '700']);
  assert.deepEqual(css('Amiri'), ['400', '700']);
  assert.deepEqual(css('Reem Kufi'), ['400 700']);
  assert.deepEqual(css('Alexandria'), ['100 900']);
  assert.deepEqual(css('Marhey'), ['300 700']);
  assert.deepEqual(css('Almarai'), ['400', '700', '800']);
  for (const family of V4) assert.equal(previewFaces(faces).filter((item) => item.alias === family).every((item) => item.face.family === family), true);
});

test('the guides name every new font where fonts are listed', async () => {
  const settings = await read('instructions/SETTINGS.md');
  const notice = await read('NOTICE.md');
  const app = await read('scripts/settings-ui/app.js');
  for (const family of V4) {
    assert.ok(settings.includes(`\`${family}\``), `SETTINGS.md lists ${family}`);
    assert.ok(notice.includes(family), `NOTICE.md names ${family}`);
    assert.ok(app.includes(`'${family}':`) || app.includes(`${family}:`), `the settings page labels ${family}`);
  }
});

// core/fonts.ts, bundled with chosen manifest contents (the earlier files plus, when asked, the new ones).
const engineRequire = createRequire(new URL('../engine/package.json', import.meta.url));
const {build} = engineRequire('esbuild');
const entryFor = (manifest, template) => ({
  name: 'v4-font-manifests',
  setup(b) {
    b.onResolve({filter: /public[\\/]fonts[\\/]manifest\.json$/}, () => ({path: 'manifest', namespace: 'v4-fonts'}));
    b.onResolve({filter: /public[\\/]fonts[\\/]manifest\.template\.json$/}, () => ({path: 'template', namespace: 'v4-fonts'}));
    b.onLoad({filter: /^manifest$/, namespace: 'v4-fonts'}, () => ({contents: JSON.stringify(manifest), loader: 'json'}));
    b.onLoad({filter: /^template$/, namespace: 'v4-fonts'}, () => ({contents: JSON.stringify(template), loader: 'json'}));
  },
});
const loadFonts = async (manifest, template) => {
  const result = await build({
    stdin: {contents: "export {FAMILY, LOADED_FAMILIES, REGISTERED, assertFamilyAvailable, familyRegistered} from './engine/src/core/fonts.ts';", resolveDir: ROOT, loader: 'ts'},
    nodePaths: [path.join(ROOT, 'engine', 'node_modules')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    external: ['remotion', '@remotion/fonts'], // only the manifests matter here; the font loader never runs without a document
    plugins: [entryFor(manifest, template)],
  });
  const module = {exports: {}};
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(engineRequire, module, module.exports);
  return module.exports;
};
const earlier = lock.fonts.filter((font) => !V4.includes(font.family)).map(({url, ...font}) => ({...font, sourceUrl: url}));
const v4Entries = Object.entries(EXPECTED).flatMap(([family, {files}]) => files.map((file) => {
  const [, subset, kind] = /^[A-Za-z]+-([a-z-]+)-(var|\d+)\.woff2$/.exec(file);
  return {family, file, subset, weight: kind === 'var' ? 400 : Number(kind), style: 'normal', bytes: 1000, unicodeRange: 'U+0000-00FF', sha256: 'b'.repeat(64), sourceUrl: `https://fonts.gstatic.com/s/x/${file}`};
}));
const sixKeys = ({family, file, subset, weight, style, bytes}) => ({family, file, subset, weight, style, bytes});

test('core/fonts registers a new family only when its files are installed or its pins are in the tracked template', async () => {
  const none = await loadFonts(earlier, earlier.map(sixKeys));
  assert.equal(none.REGISTERED.length, 39, 'the earlier faces are untouched');
  for (const family of V4) assert.equal(none.familyRegistered(family), false, `${family} is not registered without files`);
  assert.throws(() => none.assertFamilyAvailable('Lalezar'), /Lalezar[\s\S]*setup --steps fonts/);
  assert.doesNotThrow(() => none.assertFamilyAvailable('Cairo'), 'an earlier family is always available');

  const installed = await loadFonts([...earlier, ...v4Entries], earlier.map(sixKeys));
  const byFamily = (family) => installed.REGISTERED.filter((face) => face.family === family).map((face) => [face.subset, face.file, face.weight]);
  assert.deepEqual(byFamily('Lalezar'), [['arabic', 'Lalezar-arabic-400.woff2', '400'], ['latin', 'Lalezar-latin-400.woff2', '400']]);
  assert.deepEqual(byFamily('Aref Ruqaa').map(([subset, , weight]) => `${subset}/${weight}`).sort(), ['arabic/400', 'arabic/700', 'latin/400', 'latin/700']);
  assert.deepEqual(byFamily('Reem Kufi'), [['arabic', 'ReemKufi-arabic-var.woff2', '400 700'], ['latin', 'ReemKufi-latin-var.woff2', '400 700']]);
  assert.deepEqual(byFamily('Alexandria').map((face) => face[2]), ['100 900', '100 900']);
  assert.deepEqual(byFamily('Marhey').map((face) => face[2]), ['300 700', '300 700']);
  assert.deepEqual(byFamily('Almarai').map(([subset, , weight]) => `${subset}/${weight}`).sort(), ['arabic/400', 'arabic/700', 'arabic/800', 'latin/400', 'latin/700', 'latin/800']);
  for (const family of V4) assert.doesNotThrow(() => installed.assertFamilyAvailable(family));
  assert.equal(installed.REGISTERED.length, 39 + 2 + 4 + 4 + 2 + 4 + 2 + 2 + 6);

  // Once the tracked template pins a family, a missing installed file fails clearly at load, as for every earlier family.
  await assert.rejects(() => loadFonts(earlier, [...earlier, ...v4Entries].map(sixKeys)), /manifest\.json has no Lalezar arabic 400[\s\S]*setup --steps fonts/);
});
