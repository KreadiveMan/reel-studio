import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizePreferences} from '../scripts/lib/branding.mjs';
import {createSettingsServer} from '../scripts/lib/settings-server.mjs';
import {PREVIEW_FAMILIES, previewFaces} from '../scripts/lib/settings-fonts.mjs';
import {quickChecks} from '../scripts/lib/studio-doctor.mjs';
import {validateLock} from '../scripts/lib/studio-lock.mjs';
import {setupSteps} from '../scripts/lib/studio-setup.mjs';
import {FONT_CHOICES} from '../engine/src/styles/types.ts';
import {PREFERENCE_VALUES, defaultPreferences, resolvePreferences} from '../engine/src/core/preference-options.ts';
import {editManifestSchema} from '../engine/src/prepared-edit/schema.ts';

const lock = validateLock(JSON.parse(readFileSync(new URL('../versions.lock.json', import.meta.url), 'utf8')));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tmp = async (t, prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
};
const fake = (family, subset, weight, file, bytes) => ({family, file, subset, weight, style: 'normal', bytes: bytes.length,
  unicodeRange: 'U+0000-00FF', sha256: sha(bytes), url: `https://fonts.gstatic.com/s/example/${file}`});

test('the lock pins Inter as one flat variable file and keeps every Plex Sans Arabic weight', () => {
  const inter = lock.fonts.filter((font) => font.family === 'Inter');
  assert.equal(inter.length, 1, 'only the upright latin file ships; Arabic has no italic');
  assert.deepEqual(
    {family: inter[0].family, file: inter[0].file, subset: inter[0].subset, weight: inter[0].weight, style: inter[0].style},
    {family: 'Inter', file: 'Inter-latin-var.woff2', subset: 'latin', weight: 400, style: 'normal'});
  assert.match(inter[0].url, /^https:\/\/fonts\.gstatic\.com\/s\/inter\//);
  assert.match(inter[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(inter[0].bytes > 20_000, 'a real font, not an error page');
  assert.ok(inter[0].unicodeRange.startsWith('U+0000-00FF'));
  for (const weight of [400, 500, 600, 700]) {
    assert.ok(lock.fonts.some((font) => font.family === 'IBM Plex Sans Arabic' && font.subset === 'arabic' && font.weight === weight), `Plex Sans Arabic arabic ${weight}`);
  }
});

test('Grid Sans is a creator-selectable font that reaches the manifest', () => {
  assert.deepEqual(FONT_CHOICES.slice(4, 8), ['Grid Sans', 'Noto Kufi Arabic', 'Readex Pro', 'El Messiri']);
  assert.deepEqual(FONT_CHOICES.slice(8), ['Lalezar', 'Aref Ruqaa', 'Aref Ruqaa Ink', 'Reem Kufi', 'Amiri', 'Alexandria', 'Marhey', 'Almarai'], 'the V4 families follow (tests/v4-fonts.test.mjs)');
  assert.ok(PREFERENCE_VALUES.font.includes('Grid Sans'));
  const preferences = {...defaultPreferences(), font: {mode: 'fixed', value: 'Grid Sans'}};
  assert.deepEqual(normalizePreferences(preferences).font, {mode: 'fixed', value: 'Grid Sans'});
  assert.throws(() => normalizePreferences({...preferences, font: {mode: 'fixed', value: 'Comic Sans'}}));
  assert.equal(resolvePreferences(preferences, {purpose: 'explainer', tone: 'calm', style: 'section-deck'}).fontFamily, 'Grid Sans');
  assert.equal(editManifestSchema.shape.fontFamily.parse('Grid Sans'), 'Grid Sans');
});

test('adding a font to the lock makes the fonts setup step stale until the file is installed', async (t) => {
  const root = await tmp(t, 'reel-font-step-');
  const folder = path.join(root, 'engine', 'public', 'fonts');
  await mkdir(folder, {recursive: true});
  const cairo = Buffer.from('cairo'), inter = Buffer.from('inter');
  const older = [fake('Cairo', 'latin', 400, 'Cairo-latin-400.woff2', cairo)];
  const newer = [...older, fake('Inter', 'latin', 400, 'Inter-latin-var.woff2', inter)];
  const step = (fonts) => setupSteps(root, {...lock, fonts}).find((item) => item.id === 'fonts');
  assert.notEqual(await step(older).key(), await step(newer).key(), 'a changed font list re-runs the step');
  await writeFile(path.join(folder, 'Cairo-latin-400.woff2'), cairo);
  await writeFile(path.join(folder, 'manifest.json'), '[]');
  assert.equal(await step(older).verify(), true);
  assert.equal(await step(newer).verify(), false, 'an install without the new file must run the step again');
  await writeFile(path.join(folder, 'Inter-latin-var.woff2'), inter);
  assert.equal(await step(newer).verify(), true);
});

test('doctor reports a missing Inter file after an update and passes once it is installed', async (t) => {
  const root = await tmp(t, 'reel-font-doctor-');
  const folder = path.join(root, 'engine', 'public', 'fonts');
  await mkdir(folder, {recursive: true});
  await mkdir(path.join(root, 'state'), {recursive: true});
  await writeFile(path.join(root, 'state', 'setup.json'), JSON.stringify({schema: 1, status: 'done', steps: {}}));
  await writeFile(path.join(folder, 'manifest.json'), '[]');
  for (const font of lock.fonts) if (font.family !== 'Inter') await writeFile(path.join(folder, font.file), 'x');
  const run = () => quickChecks(root, {lock, gitExe: null, readProfile: async () => ({}), runsTool: () => false, locationProblem: () => null});
  const before = await run();
  assert.deepEqual(before.checks.fonts, {ok: false, missing: ['Inter-latin-var.woff2']});
  assert.ok(before.failed.includes('fonts'));
  await writeFile(path.join(folder, 'Inter-latin-var.woff2'), 'x');
  assert.equal((await run()).checks.fonts.ok, true);
});

test('the settings page previews the four earlier fonts exactly as before and builds Grid Sans from two sources', () => {
  // The selection the settings server made before Grid Sans existed.
  const legacy = lock.fonts.filter((face) => {
    if (!['arabic', 'latin', 'latin-ext'].includes(face.subset)) return false;
    return face.family === 'Cairo' ? face.weight === 400 : face.family === 'IBM Plex Sans Arabic' ? face.weight === 700
      : ['Tajawal', 'Noto Naskh Arabic'].includes(face.family) && [400, 700].includes(face.weight);
  }).map((face) => ({
    alias: face.family === 'IBM Plex Sans Arabic' ? 'Plex Display' : face.family, file: face.file,
    css: face.family === 'Cairo' ? '200 1000' : face.family === 'IBM Plex Sans Arabic' ? '1 1000' : String(face.weight),
  }));
  const all = previewFaces(lock.fonts);
  const key = (item) => `${item.alias}|${item.file}|${item.css}`;
  const added = ['Noto Kufi Arabic', 'Readex Pro', 'El Messiri'];
  assert.deepEqual(all.filter((item) => added.includes(item.alias)).map(({alias, face, css}) => key({alias, file: face.file, css})).sort(), [
    'El Messiri|ElMessiri-arabic-400.woff2|400 700', 'El Messiri|ElMessiri-latin-400.woff2|400 700',
    'Noto Kufi Arabic|NotoKufiArabic-arabic-400.woff2|100 900', 'Noto Kufi Arabic|NotoKufiArabic-latin-400.woff2|100 900',
    'Readex Pro|ReadexPro-arabic-400.woff2|160 700', 'Readex Pro|ReadexPro-latin-400.woff2|160 700']);
  const v4 = ['Lalezar', 'Aref Ruqaa', 'Aref Ruqaa Ink', 'Reem Kufi', 'Amiri', 'Alexandria', 'Marhey', 'Almarai']; // pinned later; tests/v4-fonts.test.mjs checks them
  assert.deepEqual(all.filter((item) => item.alias !== 'Grid Sans' && !added.includes(item.alias) && !v4.includes(item.alias)).map(({alias, face, css}) => key({alias, file: face.file, css})).sort(), legacy.map(key).sort());
  assert.deepEqual(all.filter((item) => item.alias === 'Grid Sans').map(({face, css}) => [face.file, css]), [
    ['Inter-latin-var.woff2', '400'],
    ['Inter-latin-var.woff2', '500'],
    ['Inter-latin-var.woff2', '600'],
    ['Inter-latin-var.woff2', '700'],
    ['IBMPlexSansArabic-arabic-400.woff2', '400'],
    ['IBMPlexSansArabic-arabic-500.woff2', '500'],
    ['IBMPlexSansArabic-arabic-600.woff2', '600'],
    ['IBMPlexSansArabic-arabic-700.woff2', '700'],
  ]);
  assert.deepEqual(PREVIEW_FAMILIES.map((family) => family.alias), ['Cairo', 'Tajawal', 'Noto Naskh Arabic', 'Plex Display', 'Grid Sans', 'Noto Kufi Arabic', 'Readex Pro', 'El Messiri', ...v4]);
});

test('the settings server serves Grid Sans as one family and reports it ready only when both sources exist', async (t) => {
  const root = await tmp(t, 'reel-font-preview-');
  const folder = path.join(root, 'engine', 'public', 'fonts');
  await mkdir(folder, {recursive: true});
  const files = [
    ['Inter', 'latin', 400, 'Inter-latin-var.woff2'],
    ...[400, 500, 600, 700].map((weight) => ['IBM Plex Sans Arabic', 'arabic', weight, `IBMPlexSansArabic-arabic-${weight}.woff2`]),
    ['IBM Plex Sans Arabic', 'latin', 700, 'IBMPlexSansArabic-latin-700.woff2'],
  ];
  const fonts = [];
  for (const [family, subset, weight, file] of files) {
    const bytes = Buffer.from(`fake ${file}`);
    await writeFile(path.join(folder, file), bytes);
    fonts.push(fake(family, subset, weight, file, bytes));
  }
  await writeFile(path.join(root, 'versions.lock.json'), JSON.stringify({edition: '0.0.0', fonts}));
  const app = await createSettingsServer({root});
  t.after(() => app.close());
  const get = (route) => fetch(`${app.origin}${route}`, {headers: {'x-reel-studio-token': app.token}});
  const css = await (await get('/fonts.css')).text();
  const grid = css.split('\n').filter((rule) => rule.includes('font-family:"Grid Sans"'));
  assert.equal(grid.length, 8);
  assert.ok(grid.slice(0, 4).every((rule) => rule.includes('/fonts/Inter-latin-var.woff2')), 'Inter once per weight, declared before Plex Arabic');
  assert.deepEqual(grid.slice(0, 4).map((rule) => /font-weight:([^;]+);/.exec(rule)[1]), ['400', '500', '600', '700']);
  assert.ok(grid.slice(4).every((rule) => rule.includes('/fonts/IBMPlexSansArabic-arabic-')));
  assert.deepEqual(grid.slice(4).map((rule) => /font-weight:([^;]+);/.exec(rule)[1]), ['400', '500', '600', '700']);
  assert.ok(css.includes('font-family:"Plex Display"'));
  assert.deepEqual((await (await get('/api/catalog')).json()).readyFonts.sort(), ['Grid Sans', 'Plex Display']);
  assert.equal((await get('/fonts/Inter-latin-var.woff2')).status, 200);
  await rm(path.join(folder, 'Inter-latin-var.woff2'));
  assert.deepEqual((await (await get('/api/catalog')).json()).readyFonts, ['Plex Display']);
});
