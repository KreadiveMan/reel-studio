import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ROOT} from '../scripts/lib/project-paths.mjs';
import {loadSoundCatalog} from '../scripts/lib/job-sound.mjs';
import {createSfxPreview, quantizeGain} from '../scripts/lib/review-editor-sfx.mjs';
import {createReviewServer} from '../scripts/lib/review-editor-server.mjs';
import {buildReviewApp} from '../scripts/lib/review-editor-build.mjs';
import {editorRenderCommand} from '../scripts/lib/editor-director.mjs';
import {sfxUrl} from '../engine/src/review-editor/api.ts';
import {MAX_PREVIEW_SOUNDS, PREVIEW_SFX_TEXT, SHARED_AUDIO_TAGS, previewSoundsFor, quantizeGain as clientQuantize} from '../engine/src/review-editor/shell/preview-sounds.ts';
import {encodeWav, mixHits} from '../scripts/sfx.mjs';
import {dialectIn} from './helpers/dialect.mjs';
import {reviewManifest} from './helpers/review-manifest.mjs';
import {renderConcurrency} from '../scripts/lib/cpu-budget.mjs';

const catalog = await loadSoundCatalog();
const expectedWav = (recipe, gain) => {
  const {L, R} = mixHits(recipe.hits.map((hit) => ({...hit, gain: (hit.gain ?? 1) * gain})), recipe.duration);
  return encodeWav(L, R);
};

test('every catalog recipe previews as the export would mix it: the same bytes, PCM16 stereo 48 kHz, 44 plus samples times four long', async () => {
  const preview = createSfxPreview();
  assert.ok(catalog.recipes.length > 0);
  for (const recipe of catalog.recipes) {
    for (const gain of [1, 0.5, 0]) {
      const body = await preview.wav(recipe.id, gain);
      assert.ok(body.equals(expectedWav(recipe, gain)), `${recipe.id} at gain ${gain}`);
      assert.equal(body.length, 44 + Math.round(recipe.duration * 48000) * 4, `${recipe.id} length`);
      assert.equal(body.toString('ascii', 0, 4), 'RIFF');
      assert.equal(body.readUInt32LE(24), 48000);
      assert.equal(body.readUInt16LE(22), 2);
      assert.equal(body.readUInt16LE(34), 16);
    }
  }
});

test('the gain is rounded to a tenth on the server, and the same mix is reused', async () => {
  assert.equal(quantizeGain(0.52), 0.5);
  assert.equal(quantizeGain(0.56), 0.6);
  assert.equal(quantizeGain(1.95), 2);
  const preview = createSfxPreview();
  const id = catalog.recipes[0].id;
  const a = await preview.wav(id, 0.52);
  const b = await preview.wav(id, 0.5);
  const c = await preview.wav(id, 0.56);
  assert.equal(a, b, 'two gains that round to 0.5 share one buffer');
  assert.notEqual(a, c);
  assert.ok(c.equals(expectedWav(catalog.recipes[0], 0.6)));
});

test('the cache drops the least recently used mix first, reads the catalog once and rejects bad input with the right status', async () => {
  const preview = createSfxPreview({limit: 2});
  const id = catalog.recipes[0].id;
  const first = await preview.wav(id, 0.1);
  const second = await preview.wav(id, 0.2);
  assert.equal(await preview.wav(id, 0.1), first, 'a hit refreshes the entry');
  await preview.wav(id, 0.3);
  assert.equal(await preview.wav(id, 0.1), first, '0.1 was used more recently than 0.2, so 0.2 went first');
  const again = await preview.wav(id, 0.2);
  assert.notEqual(again, second, '0.2 was dropped and mixed again');
  assert.ok(again.equals(second), 'the new mix is identical');
  await assert.rejects(preview.wav('no-such-recipe', 1), (error) => error.status === 404);
  for (const gain of [-0.1, 2.1, Number.NaN, Infinity]) await assert.rejects(preview.wav(id, gain), (error) => error.status === 400, String(gain));
  let loads = 0;
  const counting = createSfxPreview({loadCatalog: async () => { loads += 1; return catalog; }});
  await counting.wav(id, 1);
  await counting.wav(id, 0.5);
  assert.equal(loads, 1, 'the catalog is read once per session');
  const failing = createSfxPreview({loadCatalog: async () => { throw new Error('catalog broke'); }});
  await assert.rejects(failing.wav(id, 1), /catalog broke/);
  await assert.rejects(failing.wav(id, 1), /catalog broke/, 'a failed read is retried, not remembered');
});

test('the editor serves /api/sfx behind the token with ranges, and refuses bad gain or an unknown recipe', async (t) => {
  const id = `sfx-http-${randomUUID()}`;
  const directory = path.join(ROOT, 'Projects', id);
  const manifestPath = `Projects/${id}/edit.json`;
  await mkdir(directory, {recursive: true});
  await writeFile(path.join(ROOT, manifestPath), JSON.stringify(reviewManifest(id)));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.join(ROOT, 'Projects'));
    await rm(directory, {recursive: true, force: true});
  });
  // The route does not depend on the browser bundle, so a stub keeps this test light; the real bundle is checked in the client tests below.
  const bundle = {files: new Map([['/index.html', {contents: Buffer.from('<html>editor</html>'), type: 'text/html'}]])};
  const app = await createReviewServer({manifestPath, bundle});
  t.after(() => app.close());
  const origin = new URL(app.url).origin;
  const recipe = catalog.recipes[0];
  const url = (query) => `${origin}/api/sfx/${recipe.id}?${query}`;
  const expected = expectedWav(recipe, 0.5);

  const full = await fetch(url(`gain=0.5&token=${app.token}`));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/wav');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('cache-control'), 'private, max-age=300');
  assert.equal(Number(full.headers.get('content-length')), expected.length);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(expected), 'byte-equal to encodeWav(mixHits(...))');

  const rounded = await fetch(url(`gain=0.52&token=${app.token}`));
  assert.ok(Buffer.from(await rounded.arrayBuffer()).equals(expected), 'the server rounds the gain too');
  const noGain = await fetch(url(`token=${app.token}`));
  assert.ok(Buffer.from(await noGain.arrayBuffer()).equals(expectedWav(recipe, 1)), 'no gain means 1');

  const part = await fetch(url(`gain=0.5&token=${app.token}`), {headers: {range: 'bytes=0-99'}});
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${expected.length}`);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(expected.subarray(0, 100)));
  const tail = await fetch(url(`gain=0.5&token=${app.token}`), {headers: {range: 'bytes=-50'}});
  assert.equal(tail.status, 206);
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(expected.subarray(expected.length - 50)));
  const open = await fetch(url(`gain=0.5&token=${app.token}`), {headers: {range: `bytes=${expected.length - 10}-`}});
  assert.equal(open.status, 206);
  assert.equal((await open.arrayBuffer()).byteLength, 10);
  const beyond = await fetch(url(`gain=0.5&token=${app.token}`), {headers: {range: `bytes=${expected.length + 5}-`}});
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), `bytes */${expected.length}`);

  assert.equal((await fetch(url('gain=0.5'))).status, 401, 'no token, no sound');
  assert.equal((await fetch(url('gain=0.5&token=wrong'))).status, 401);
  for (const gain of ['abc', '3', '-1']) assert.equal((await fetch(url(`gain=${gain}&token=${app.token}`))).status, 400, `gain=${gain}`);
  assert.equal((await fetch(`${origin}/api/sfx/no-such-recipe?gain=1&token=${app.token}`)).status, 404);
  assert.equal((await fetch(`${origin}/api/sfx/${recipe.id}?gain=1&token=${app.token}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).status, 404, 'read-only route');
});

// ---- the Player side: which effects sound, and what stays untouched -------------------------------------------
const sound = (atFrame, recipe = 'pop', gain = 0.5) => ({atFrame, recipe, gain});
const recipes = [{id: 'pop', name: 'Pop', use: '', duration: 0.5}, {id: 'long', name: 'Long', use: '', duration: 2}];
const urlFor = (recipe, gain) => `/api/sfx/${recipe}?gain=${gain}`;
const manifestOf = (sounds, fps = 30) => ({sounds, source: {fps}});

test('previewSoundsFor places each effect at its frame for its length and skips what cannot sound', () => {
  const result = previewSoundsFor(manifestOf([sound(60), sound(10, 'long', 0.52), sound(30, 'missing'), sound(40, 'pop', 0), sound(45, 'pop', 0.04)]), recipes, urlFor);
  assert.deepEqual(result.sounds.map((item) => [item.from, item.durationInFrames, item.src]), [
    [10, 60, '/api/sfx/long?gain=0.5'],
    [60, 15, '/api/sfx/pop?gain=0.5'],
  ], 'time order, ceil(duration x fps) frames, the gain asked for in tenths');
  assert.equal(result.skipped, 3, 'an unknown recipe, a gain of zero and a gain that rounds to zero');
  assert.equal(new Set(result.sounds.map((item) => item.key)).size, result.sounds.length);
  assert.equal(previewSoundsFor(manifestOf([sound(0)], 25), recipes, urlFor).sounds[0].durationInFrames, 13, 'ceil(0.5 x 25)');
  assert.deepEqual(previewSoundsFor(manifestOf([]), recipes, urlFor), {sounds: [], skipped: 0});
});

test('twenty overlapping effects never mount more than nine audio tags, and later effects reuse freed slots', () => {
  assert.equal(MAX_PREVIEW_SOUNDS + 3, SHARED_AUDIO_TAGS, 'three of the twelve pooled tags stay free');
  const crowded = previewSoundsFor(manifestOf(Array.from({length: 20}, (_, i) => sound(i, 'long'))), recipes, urlFor);
  assert.equal(crowded.sounds.length, 9);
  assert.equal(crowded.skipped, 11);
  assert.deepEqual(crowded.sounds.map((item) => item.from), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'the earliest ones win');
  const peak = (sounds) => Math.max(...sounds.map((a) => sounds.filter((b) => b.from <= a.from && a.from < b.from + b.durationInFrames).length));
  assert.ok(peak(crowded.sounds) <= 9);
  const spread = previewSoundsFor(manifestOf(Array.from({length: 30}, (_, i) => sound(i * 100, 'long'))), recipes, urlFor);
  assert.equal(spread.sounds.length, 30);
  assert.equal(spread.skipped, 0);
  const touching = previewSoundsFor(manifestOf([sound(0, 'pop'), sound(15, 'pop')]), recipes, urlFor, {maxConcurrent: 1});
  assert.equal(touching.sounds.length, 2, 'a sound that ends on the frame the next one starts is already free');
  assert.equal(previewSoundsFor(manifestOf([sound(0), sound(5)]), recipes, urlFor, {maxConcurrent: 1}).skipped, 1);
});

test('the browser asks for the same tenth of gain that the server rounds to, behind the token', () => {
  for (const gain of [0, 0.04, 0.05, 0.52, 0.56, 1, 1.95, 2]) {
    assert.equal(clientQuantize(gain), quantizeGain(gain), String(gain));
    const url = sfxUrl('soft-whoosh', gain);
    assert.equal(new URL(url, 'http://127.0.0.1').searchParams.get('gain'), String(quantizeGain(gain)), url);
    assert.ok(url.startsWith('/api/sfx/soft-whoosh?gain='), url);
    assert.ok(url.includes('&token='), 'the audio element cannot send a header, so the token is in the query');
  }
  assert.ok(sfxUrl('a b', 1).includes('/api/sfx/a%20b?'), 'the recipe is encoded');
});

test('the preview strings are neutral Arabic', () => {
  const texts = [PREVIEW_SFX_TEXT.on, PREVIEW_SFX_TEXT.off, PREVIEW_SFX_TEXT.skipped(3), PREVIEW_SFX_TEXT.title, PREVIEW_SFX_TEXT.skippedTitle, PREVIEW_SFX_TEXT.panelHint];
  for (const text of texts) {
    assert.match(text, /\p{Script=Arabic}/u, text);
    assert.deepEqual(dialectIn(text), [], text);
  }
  assert.ok(PREVIEW_SFX_TEXT.skipped(3).includes('3'));
});

test('the export never reaches the preview code, the editor bundle carries it, and the export command is unchanged', async () => {
  for (const file of ['engine/src/prepared-edit/PreparedEdit.tsx', 'engine/src/Root.tsx', 'scripts/render.mjs', 'scripts/stills.mjs']) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    for (const word of ['PreviewComposition', 'preview-sounds', '/api/sfx', 'review-editor-sfx']) assert.equal(source.includes(word), false, `${file} must not mention ${word}`);
  }
  const composition = await readFile(path.join(ROOT, 'engine/src/review-editor/PreviewComposition.tsx'), 'utf8');
  assert.match(composition, /from "\.\.\/prepared-edit\/PreparedEdit"/, 'the preview wraps the unchanged composition');
  const player = await readFile(path.join(ROOT, 'engine/src/review-editor/PreviewPlayer.tsx'), 'utf8');
  assert.match(player, /component=\{PreviewComposition\}/, 'the live Player plays the preview composition');
  assert.match(player, /numberOfSharedAudioTags=\{SHARED_AUDIO_TAGS\}/, 'the Player pools the audio tags the planner counts on');
  const built = await buildReviewApp({});
  const js = built.files.get('/app.js').contents.toString('utf8');
  assert.ok(js.includes('/api/sfx/'), 'the bundle asks the sound route');
  assert.ok(js.includes('PreviewComposition'));
  assert.ok(js.includes('numberOfSharedAudioTags'));

  const manifest = {version: 1, id: 'command-test', purpose: 'test', style: 'section-deck',
    source: {path: 'Raw/example.mp4', sha256: 'a'.repeat(64), fps: 30, width: 1080, height: 1920, totalFrames: 360},
    segments: [{fromFrame: 0, toFrame: 360}], captions: {status: 'reviewed', reviewer: 'Creator', words: []},
    scenes: [], sounds: [], camera: [], presenter: false};
  const prepared = {propsFile: 'Projects/command-test/prepared/props.json', sfxFile: 'Projects/command-test/prepared/sounds.wav'};
  assert.deepEqual(editorRenderCommand(manifest, prepared, {}), {
    script: 'scripts/render.mjs',
    args: ['PreparedEdit', '--out', 'Projects/command-test/renders/edit-preview.mp4', '--props-file', 'Projects/command-test/prepared/props.json', '--sfx',
      'Projects/command-test/prepared/sounds.wav', '--channel', 'organic', '--concurrency', String(renderConcurrency()), '--media-engine', 'offthread', '--preview'],
    inputs: ['Raw/example.mp4', 'Projects/command-test/prepared/props.json', 'Projects/command-test/prepared/sounds.wav'],
    output: 'Projects/command-test/renders/edit-preview.mp4', qc: 'Projects/command-test/renders/edit-preview.mp4.qc.json', safeReport: null,
  }, 'the export still receives the prepared sounds.wav and nothing from the preview');
});
