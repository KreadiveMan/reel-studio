import { browserExeRelative } from './platform.mjs';
// The person matte: cuts the speaker out of a named source video and writes an alpha clip a layered-speaker scene can use.
//
//   source frames --ffmpeg--> RGBA --local Chromium + MediaPipe Image Segmenter (CPU)--> person confidence --refine--> alpha
//   alpha --ffmpeg (lossless)--> small file --ffmpeg alphamerge with the source--> engine/public/_prepared/<project>/matte-<key>.webm
//
// It runs the same way as the face detection in reframe-runtime.mjs: a loopback-only page in the studio's own headless Chromium,
// tasks-vision 1.0.1 WebAssembly, the explicit CPU delegate, no network. The model file is a download the owner approves
// (see matte-model-pins.json); until it is on disk and pinned, only the parts that do not need it run.
import './project-tmp.mjs';
import path from 'node:path';
import { promises as fs, createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { requireFromEngine } from './bundle.mjs';
import { ROOT, run, ffprobeJson, writeJson } from './media.mjs';
import { checkedPath, externalFileSnapshot, fileSnapshot } from './job-paths.mjs';
import { withOutputTransaction } from './delivery.mjs';
import {
  MATTE_SETTINGS, MATTE_VERSION, alphaEncodeArgs, alphaFromConfidence, decodeArgs, evenSize, foregroundRecord, matteKey, mattePaths,
  mergeArgs, pickPersonMask, planMatteRange, refineAlpha,
} from './matte-core.mjs';

const PINS = JSON.parse(readFileSync(new URL('./matte-model-pins.json', import.meta.url), 'utf8'));
const PIN = PINS['selfie-segmenter-float16-v1'];

export const MATTE_MODEL = Object.freeze({
  id: 'selfie-segmenter-float16-v1',
  path: PIN.path,
  url: PIN.url,
  sha256: PIN.sha256,
  bytes: PIN.bytes,
  license: PIN.license,
  homepage: PIN.homepage,
});

const BROWSER = ['engine', 'node_modules', '.remotion', ...browserExeRelative().split('/')];
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** missing: not on disk. unpinned: on disk but the pin is empty. mismatch: on disk and different from the pin. ok: verified. */
export async function matteModelStatus({ root = ROOT } = {}) {
  const file = path.join(root, ...MATTE_MODEL.path.split('/'));
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    return { state: 'missing', path: MATTE_MODEL.path, message: `selfie_segmenter.tflite is not installed at ${MATTE_MODEL.path}. Run the models step of setup (node scripts/studio.mjs setup --steps models) and then node scripts/matte.mjs status.` };
  }
  const measured = await sha256Of(file);
  if (!MATTE_MODEL.sha256 || !MATTE_MODEL.bytes) {
    return { state: 'unpinned', path: MATTE_MODEL.path, measured: { sha256: measured, bytes: stat.size }, message: `selfie_segmenter.tflite is on disk (sha256 ${measured}, ${stat.size} bytes) but scripts/lib/matte-model-pins.json has no pin yet; copy these two values into the pins file and into versions.lock.json models[].` };
  }
  if (measured !== MATTE_MODEL.sha256 || stat.size !== MATTE_MODEL.bytes) {
    return { state: 'mismatch', path: MATTE_MODEL.path, measured: { sha256: measured, bytes: stat.size }, message: `selfie_segmenter.tflite does not match its pin (found ${measured}, ${stat.size} bytes); delete it and run setup again.` };
  }
  return { state: 'ok', path: MATTE_MODEL.path, measured: { sha256: measured, bytes: stat.size }, message: 'The selfie segmenter model is installed and verified.' };
}

export async function requireMatteModel() {
  const status = await matteModelStatus();
  if (status.state !== 'ok') throw new Error(status.message);
  return status;
}

async function runtimeIdentity() {
  const packageDir = path.dirname(requireFromEngine.resolve('@mediapipe/tasks-vision'));
  const pkg = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
  if (pkg.version !== '1.0.1') throw new Error(`The person matte needs the pinned tasks-vision 1.0.1, found ${pkg.version}.`);
  const wasm = (await fs.readdir(path.join(packageDir, 'wasm'))).filter((name) => /\.(?:wasm|js)$/.test(name)).sort();
  const browser = path.join(ROOT, ...BROWSER);
  if (!existsSync(browser)) throw new Error('The studio browser (chrome-headless-shell) is not installed; run setup first.');
  return { packageDir, version: pkg.version, wasm, browser };
}

const TYPES = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };

/**
 * A segmenter that runs the MediaPipe Image Segmenter in the studio's headless Chromium.
 * `segment(frames, {width, height})` takes RGBA frames (Uint8Array each) and returns one Uint8Array of person confidence
 * (0 to 255, width x height) per frame.
 */
export async function createBrowserSegmenter({ log = () => {}, modelFile } = {}) {
  // `modelFile` is a test hook: it serves another file in place of the pinned model, to try the harness without the download.
  const status = modelFile ? { measured: null } : await requireMatteModel();
  const identity = await runtimeIdentity();
  const prefix = `/${randomUUID()}`;
  const files = new Map();
  files.set(`${prefix}/vision_bundle.mjs`, path.join(identity.packageDir, 'vision_bundle.mjs'));
  for (const name of identity.wasm) files.set(`${prefix}/wasm/${name}`, path.join(identity.packageDir, 'wasm', name));
  files.set(`${prefix}/model.tflite`, modelFile ?? path.join(ROOT, ...MATTE_MODEL.path.split('/')));
  const batches = new Map();
  const waiting = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' blob:; worker-src 'self' blob:");
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === `${prefix}/`) {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><meta charset="utf-8"><title>Local person matte</title>');
      return;
    }
    const post = /^\/[^/]+\/masks\/(\d+)$/.exec(url.pathname);
    if (request.method === 'POST' && post && url.pathname.startsWith(prefix)) {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        waiting.get(Number(post[1]))?.(Buffer.concat(chunks));
        response.writeHead(204);
        response.end();
      });
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const frames = /^\/[^/]+\/frames\/(\d+)$/.exec(url.pathname);
    if (frames && url.pathname.startsWith(prefix) && batches.has(Number(frames[1]))) {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(batches.get(Number(frames[1])));
      return;
    }
    const file = files.get(url.pathname);
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.tflite') ? 'application/octet-stream' : TYPES[path.extname(file)] ?? 'application/octet-stream');
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}${prefix}`;
  let browser;
  let page;
  const browserLogs = [];
  let pick = null;
  const close = async () => {
    try {
      if (page) await page.evaluate(() => { try { window.__matteSegmenter?.close(); } catch { /* already closed */ } }).catch(() => {});
      if (browser) await browser.close({ silent: true });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
  try {
    browser = await requireFromEngine('@remotion/renderer').openBrowser('chrome', { browserExecutable: identity.browser, logLevel: 'error', chromiumOptions: { headless: true } });
    page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0,
      onBrowserLog: ({ text, type }) => { if (browserLogs.length < 30) browserLogs.push({ type, text: text.slice(0, 1200) }); },
      onLog: ({ previewString }) => { if (browserLogs.length < 30) browserLogs.push(previewString.slice(0, 1200)); } });
    await page.goto({ url: `${baseUrl}/`, timeout: 30000 });
    const started = await page.evaluate(async (url) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const target = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (target.origin !== location.origin) return Promise.reject(new TypeError('External requests are disabled for the local person matte'));
        return originalFetch(input, options);
      };
      const { FilesetResolver, ImageSegmenter } = await import(`${url}/vision_bundle.mjs`);
      const vision = await FilesetResolver.forVisionTasks(`${url}/wasm`);
      const segmenter = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${url}/model.tflite`, delegate: 'CPU' },
        runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
      });
      window.__matteSegmenter = segmenter;
      window.__matteClock = 0;
      // One blank frame tells how many masks the model returns, which decides how the person mask is picked.
      const probe = new OffscreenCanvas(64, 64);
      probe.getContext('2d').fillRect(0, 0, 64, 64);
      let count = 0;
      segmenter.segmentForVideo(probe, (window.__matteClock += 40), (result) => { count = result.confidenceMasks?.length ?? 0; });
      return { labels: segmenter.getLabels(), count, userAgent: navigator.userAgent };
    }, baseUrl);
    pick = pickPersonMask(started.labels, started.count);
    log(`person matte: model ready (${started.count} mask(s), labels ${started.labels.join(', ') || 'none'}, person = ${pick.invert ? '1 - ' : ''}mask ${pick.index})`);
  } catch (error) {
    await close().catch(() => {});
    throw new Error(`The person matte could not start: ${error.message}${browserLogs.length ? `\nbrowser: ${JSON.stringify(browserLogs.slice(0, 5))}` : ''}`);
  }
  let batchNumber = 0;
  return {
    id: MATTE_MODEL.id,
    identity: { model: status.measured, tasksVision: identity.version, delegate: 'CPU', mask: pick },
    async open() {},
    async segment(frames, { width, height }) {
      const n = batchNumber++;
      const size = width * height * 4;
      const body = Buffer.alloc(frames.length * size);
      frames.forEach((frame, i) => {
        if (frame.length !== size) throw new Error(`Frame ${i} has ${frame.length} bytes, expected ${size}.`);
        body.set(frame, i * size);
      });
      batches.set(n, body);
      const done = new Promise((resolve) => waiting.set(n, resolve));
      try {
        await page.evaluate(async (url, number, count, w, h, choice) => {
          const raw = new Uint8ClampedArray(await (await fetch(`${url}/frames/${number}`)).arrayBuffer());
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const out = new Uint8Array(count * w * h);
          for (let i = 0; i < count; i++) {
            ctx.putImageData(new ImageData(raw.subarray(i * w * h * 4, (i + 1) * w * h * 4), w, h), 0, 0);
            window.__matteSegmenter.segmentForVideo(canvas, (window.__matteClock += 40), (result) => {
              const mask = result.confidenceMasks[choice.index];
              const data = mask.getAsFloat32Array();
              const same = mask.width === w && mask.height === h;
              for (let y = 0; y < h; y++) {
                const sy = same ? y : Math.min(mask.height - 1, Math.floor((y * mask.height) / h));
                for (let x = 0; x < w; x++) {
                  const sx = same ? x : Math.min(mask.width - 1, Math.floor((x * mask.width) / w));
                  const value = choice.invert ? 1 - data[sy * mask.width + sx] : data[sy * mask.width + sx];
                  out[i * w * h + y * w + x] = value <= 0 ? 0 : value >= 1 ? 255 : Math.round(value * 255);
                }
              }
            });
          }
          const response = await fetch(`${url}/masks/${number}`, { method: 'POST', body: out });
          if (!response.ok) throw new Error(`mask upload failed: ${response.status}`);
        }, baseUrl, n, frames.length, width, height, pick);
        const bytes = await done;
        if (bytes.length !== frames.length * width * height) throw new Error(`The browser returned ${bytes.length} mask bytes, expected ${frames.length * width * height}.`);
        return frames.map((_, i) => new Uint8Array(bytes.buffer, bytes.byteOffset + i * width * height, width * height));
      } finally {
        batches.delete(n);
        waiting.delete(n);
      }
    },
    close,
  };
}

const fraction = (text) => { const [n, d] = String(text ?? '0/1').split('/').map(Number); return d ? n / d : n; };

/** What the edit pipeline also checks of a source: constant cadence, no odd pixel shape, the display size and the frame count. */
async function inspectSource(absolute) {
  const probe = await ffprobeJson(absolute);
  const video = probe.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video) throw new Error('A matte needs a source with video.');
  const rate = fraction(video.r_frame_rate);
  if (!(rate > 0) || Math.abs(rate - fraction(video.avg_frame_rate)) > 0.01) {
    throw new Error('A matte needs constant cadence. Run node scripts/intake.mjs --source <file> --id <project> and cut the matte from the constant-rate copy it writes.');
  }
  if (video.sample_aspect_ratio && !['1:1', '0:1', 'N/A'].includes(video.sample_aspect_ratio)) throw new Error('The source has non-square pixels; use the normalised copy from intake.');
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer)) throw new Error('HDR footage must be converted first (node scripts/intake.mjs).');
  const turned = Math.abs(video.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0) % 180 === 90;
  let totalFrames = Number(video.nb_frames);
  if (!Number.isInteger(totalFrames) || totalFrames < 1) {
    const counted = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', absolute]);
    totalFrames = Number(JSON.parse(counted.stdout).streams?.[0]?.nb_read_frames);
  }
  if (!Number.isInteger(totalFrames) || totalFrames < 1) throw new Error('The source frame count could not be verified.');
  return { fps: video.r_frame_rate, fpsNumber: rate, width: turned ? video.height : video.width, height: turned ? video.width : video.height, totalFrames };
}

const closed = (child) => new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code)); });

/** Reads the decoder's stdout as whole frames of `frameBytes`, `batch` at a time. */
async function* frameBatches(stream, frameBytes, batch) {
  let chunks = [];
  let held = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    held += chunk.length;
    while (held >= frameBytes * batch) {
      const all = Buffer.concat(chunks);
      const take = frameBytes * batch;
      yield Array.from({ length: batch }, (_, i) => new Uint8Array(all.buffer, all.byteOffset + i * frameBytes, frameBytes));
      const rest = all.subarray(take);
      chunks = rest.length ? [rest] : [];
      held = rest.length;
    }
  }
  if (held % frameBytes !== 0) throw new Error(`The decoder ended in the middle of a frame (${held % frameBytes} stray bytes).`);
  if (held > 0) {
    const all = Buffer.concat(chunks);
    yield Array.from({ length: held / frameBytes }, (_, i) => new Uint8Array(all.buffer, all.byteOffset + i * frameBytes, frameBytes));
  }
}

/**
 * Cuts the matte for `sourceAbsolute` (an absolute path to the named source). `segmenter` is the browser segmenter, or a stand-in in tests.
 * The result is cached by the key of everything it depends on: a second call with the same inputs returns the finished file.
 */
export async function makeMatteFromFile({ sourceAbsolute, project, startFrame = 0, frames, outWidth = 1080, analysisWidth = 540, segmenter, settings = MATTE_SETTINGS, crf = 24, log = () => {} }) {
  const info = await inspectSource(sourceAbsolute);
  const range = planMatteRange({ totalFrames: info.totalFrames, startFrame, frames });
  const out = evenSize(info.width, info.height, outWidth);
  const analysis = evenSize(info.width, info.height, Math.min(analysisWidth, outWidth));
  const source = await externalFileSnapshot(sourceAbsolute);
  const key = matteKey({ sourceSha256: source.sha256, ...range, width: out.width, height: out.height, analysis, fps: info.fps, settings, crf, segmenter: segmenter.id, identity: segmenter.identity ?? null });
  const { src, file } = mattePaths(project, key);
  // Reading a finished matte needs no write permission (a render links it into its bundle); only making one goes through the output transaction.
  const target = await checkedPath(file);
  const foreground = foregroundRecord({ src, sourceSha256: source.sha256, sourceFromFrame: range.startFrame, frames: range.frames });
  const sidecar = `${target}.matte.json`;
  const previous = await fs.readFile(sidecar, 'utf8').then(JSON.parse).catch(() => null);
  if (previous?.key === key && (await fileSnapshot(file).then((s) => s.sha256 === previous.outputHash).catch(() => false))) {
    return { foreground, width: out.width, height: out.height, cached: true, coverage: previous.coverage, file, metadata: rel(sidecar) };
  }
  await segmenter.open();
  const staged = { coverage: null };
  await withOutputTransaction(target, async (stagedFile, work) => {
    const alphaFile = path.join(work, 'alpha.mkv');
    const decoder = spawn('ffmpeg', decodeArgs({ input: sourceAbsolute, startFrame: range.startFrame, frames: range.frames, ...analysis, fps: info.fps }), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const encoder = spawn('ffmpeg', alphaEncodeArgs({ ...analysis, fps: info.fps, out: alphaFile }), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let decoderErrors = '';
    let encoderErrors = '';
    decoder.stderr.on('data', (chunk) => { decoderErrors += chunk; });
    encoder.stderr.on('data', (chunk) => { encoderErrors += chunk; });
    encoder.stdin.on('error', () => {});
    const decoderDone = closed(decoder);
    const encoderDone = closed(encoder);
    let previousAlpha = null;
    let done = 0;
    let visibleFrames = 0;
    let coverageSum = 0;
    const pixels = analysis.width * analysis.height;
    try {
      for await (const batch of frameBatches(decoder.stdout, pixels * 4, settings.batch)) {
        const confidences = await segmenter.segment(batch, analysis);
        if (confidences.length !== batch.length) throw new Error('The segmenter returned a different number of masks than frames.');
        for (const confidence of confidences) {
          const raw = alphaFromConfidence(confidence, new Uint8Array(pixels), settings);
          previousAlpha = refineAlpha(raw, previousAlpha, analysis.width, analysis.height, settings);
          let solid = 0;
          for (let i = 0; i < pixels; i++) if (previousAlpha[i] > 128) solid++;
          coverageSum += solid / pixels;
          if (solid / pixels > 0.005) visibleFrames++;
          if (!encoder.stdin.write(previousAlpha)) await new Promise((resolve) => encoder.stdin.once('drain', resolve));
          done++;
        }
        log(`person matte: ${done}/${range.frames} frames`);
      }
      encoder.stdin.end();
    } catch (error) {
      decoder.kill();
      encoder.stdin.destroy();
      encoder.kill();
      await Promise.allSettled([decoderDone, encoderDone]);
      throw error;
    }
    const [decoderCode, encoderCode] = await Promise.all([decoderDone, encoderDone]);
    if (decoderCode !== 0) throw new Error(`Decoding the source failed:\n${decoderErrors.slice(-1500)}`);
    if (encoderCode !== 0) throw new Error(`Encoding the alpha frames failed:\n${encoderErrors.slice(-1500)}`);
    if (done !== range.frames) throw new Error(`The source decoded ${done} frames, the matte range holds ${range.frames}.`);
    if (visibleFrames === 0) throw new Error('The segmenter found no person in any frame. Check that the right source and range were named; no matte was written.');
    await run('ffmpeg', mergeArgs({ input: sourceAbsolute, alpha: alphaFile, startFrame: range.startFrame, frames: range.frames, ...out, fps: info.fps, out: stagedFile, crf }));
    const probe = await ffprobeJson(stagedFile);
    const stream = probe.streams.find((item) => item.codec_type === 'video');
    const counted = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', stagedFile]);
    const written = Number(JSON.parse(counted.stdout).streams?.[0]?.nb_read_frames);
    if (written !== range.frames) throw new Error(`The matte file holds ${written} frames, expected ${range.frames}.`);
    if (stream.width !== out.width || stream.height !== out.height) throw new Error('The matte file has the wrong size.');
    if (Math.abs(fraction(stream.avg_frame_rate) - info.fpsNumber) > 0.001) throw new Error(`The matte cadence ${stream.avg_frame_rate} does not match the source ${info.fps}.`);
    if (String(stream.tags?.alpha_mode ?? stream.tags?.ALPHA_MODE) !== '1') throw new Error('The matte file has no alpha channel.');
    const outputHash = (await fileSnapshot(rel(stagedFile))).sha256;
    staged.coverage = { visibleFrames, frames: range.frames, meanCoverage: Number((coverageSum / range.frames).toFixed(4)) };
    // A speaker rarely fills nearly the whole frame; a matte that does is more likely the background than the person.
    if (staged.coverage.meanCoverage > 0.85) {
      staged.coverage.warning = 'The matte covers most of the frame. If the speaker does not fill it, the mask may be inverted: look at the stills before using it.';
      log(`warning: ${staged.coverage.warning}`);
    }
    await writeJson(`${stagedFile}.matte.json`, {
      version: MATTE_VERSION, key, project, source: { sha256: source.sha256, fps: info.fps, width: info.width, height: info.height },
      range, output: { width: out.width, height: out.height, frames: range.frames }, analysis, settings, crf, outputHash,
      segmenter: { id: segmenter.id, ...(segmenter.identity ? { identity: segmenter.identity } : {}) }, coverage: staged.coverage,
    });
  }, { sidecars: ['.matte.json'] });
  if ((await externalFileSnapshot(sourceAbsolute)).sha256 !== source.sha256) throw new Error('The source changed while the matte was being cut.');
  return { foreground, width: out.width, height: out.height, cached: false, coverage: staged.coverage, file, metadata: rel(sidecar) };
}

/** The normal entry point: a named source (project-relative path) and a project, cut with the real model. */
export async function makeMatte({ source, project, startFrame = 0, frames, outWidth = 1080, log = () => {} }) {
  const sourceAbsolute = await checkedPath(source, { mustExist: true });
  const segmenter = await createBrowserSegmenter({ log });
  try {
    return await makeMatteFromFile({ sourceAbsolute, project, startFrame, frames, outWidth, segmenter, log });
  } finally {
    await segmenter.close();
  }
}
