import {promises as fs} from 'node:fs';
import path from 'node:path';
import {platformLock} from './platform.mjs';

export const LOCK_FILE = 'versions.lock.json';
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const https = (value) => typeof value === 'string' && value.startsWith('https://');
const relative = (value) => text(value) && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
  && value.split('/').every((part) => part && part !== '.' && part !== '..');

function checkDownload(problems, name, entry) {
  if (!https(entry?.url)) problems.push(`${name}.url must be an https URL`);
  if (!SHA256.test(entry?.sha256 ?? '')) problems.push(`${name}.sha256 must be 64 lowercase hex characters`);
  if (!Number.isInteger(entry?.bytes) || entry.bytes <= 0) problems.push(`${name}.bytes must be a positive integer`);
}

function checkSource(problems, name, entry) {
  if (!text(entry?.license)) problems.push(`${name}.license is missing`);
  if (!https(entry?.homepage)) problems.push(`${name}.homepage must be an https URL`);
}

export function validateLock(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('versions.lock.json must contain a JSON object.');
  const problems = [];
  if (lock.schema !== 1) problems.push('schema must be 1');
  if (!SEMVER.test(lock.edition ?? '')) problems.push('edition must be a semantic version');
  if (!SEMVER.test(lock.engine ?? '')) problems.push('engine must be a semantic version');
  for (const name of ['node', 'git', 'ffmpeg']) {
    if (!text(lock[name]?.version)) problems.push(`${name}.version is missing`);
    checkDownload(problems, name, lock[name]);
    checkSource(problems, name, lock[name]);
  }
  const browser = lock.browser;
  if (!text(browser?.version)) problems.push('browser.version is missing');
  if (!SEMVER.test(browser?.remotion ?? '')) problems.push('browser.remotion must be the Remotion version');
  if (!https(browser?.url)) problems.push('browser.url must be an https URL');
  if (!relative(browser?.exe) || !browser.exe.startsWith('chrome-headless-shell/')) problems.push('browser.exe must be a relative path under chrome-headless-shell/');
  if (!SHA256.test(browser?.exeSha256 ?? '')) problems.push('browser.exeSha256 must be 64 lowercase hex characters');
  checkSource(problems, 'browser', browser);
  if (!Array.isArray(lock.models) || lock.models.length === 0) problems.push('models must be a non-empty array');
  for (const [index, model] of (Array.isArray(lock.models) ? lock.models : []).entries()) {
    const name = `models[${index}]`;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(model?.id ?? '')) problems.push(`${name}.id must be a lowercase slug`);
    if (!relative(model?.path) || !model.path.startsWith('Tools/models/')) problems.push(`${name}.path must be under Tools/models/`);
    checkDownload(problems, name, model);
    checkSource(problems, name, model);
  }
  const transcription = lock.transcription;
  if (!/^b\d+$/.test(transcription?.runtime?.release ?? '')) problems.push('transcription.runtime.release must be an official build tag such as b4938');
  for (const part of ['runtime', 'model', 'vad']) {
    checkDownload(problems, `transcription.${part}`, transcription?.[part]);
    checkSource(problems, `transcription.${part}`, transcription?.[part]);
  }
  for (const part of ['model', 'vad']) {
    const entry = transcription?.[part];
    if (!text(entry?.name)) problems.push(`transcription.${part}.name is missing`);
    if (!relative(entry?.path) || !entry.path.startsWith('Tools/whisper-models/')) problems.push(`transcription.${part}.path must be under Tools/whisper-models/`);
  }
  if (!Array.isArray(lock.fonts)) problems.push('fonts must be an array');
  const files = new Set();
  for (const [index, font] of (Array.isArray(lock.fonts) ? lock.fonts : []).entries()) {
    const name = `fonts[${index}]`;
    if (!/^[A-Za-z0-9-]+\.woff2$/.test(font?.file ?? '')) problems.push(`${name}.file must be a .woff2 file name`);
    else if (files.has(font.file)) problems.push(`${name}.file is listed twice: ${font.file}`);
    else files.add(font.file);
    for (const field of ['family', 'subset', 'unicodeRange']) if (!text(font?.[field])) problems.push(`${name}.${field} is missing`);
    if (!Number.isInteger(font?.weight)) problems.push(`${name}.weight must be an integer`);
    if (!['normal', 'italic'].includes(font?.style)) problems.push(`${name}.style must be normal or italic`);
    if (!(typeof font?.url === 'string' && font.url.startsWith('https://fonts.gstatic.com/'))) problems.push(`${name}.url must be a fonts.gstatic.com URL`);
    if (!SHA256.test(font?.sha256 ?? '')) problems.push(`${name}.sha256 must be 64 lowercase hex characters`);
    if (!Number.isInteger(font?.bytes) || font.bytes <= 0) problems.push(`${name}.bytes must be a positive integer`);
  }
  if (!Array.isArray(lock.notices)) problems.push('notices must be an array');
  for (const [index, notice] of (Array.isArray(lock.notices) ? lock.notices : []).entries()) {
    if (!text(notice?.name)) problems.push(`notices[${index}].name is missing`);
    checkSource(problems, `notices[${index}]`, notice);
  }
  checkPlatforms(problems, lock.platforms);
  if (problems.length) throw new Error(`versions.lock.json is invalid:\n- ${problems.join('\n- ')}`);
  return lock;
}

// Optional per-host pins (see scripts/lib/platform.mjs). Only linux-x64 exists today.
function checkPlatforms(problems, platforms) {
  if (platforms === undefined) return;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) { problems.push('platforms must be an object'); return; }
  for (const [key, entry] of Object.entries(platforms)) {
    const name = `platforms.${key}`;
    if (key !== 'linux-x64') { problems.push(`${name} is not a supported platform`); continue; }
    const browser = entry?.browser;
    if (!https(browser?.url)) problems.push(`${name}.browser.url must be an https URL`);
    if (!relative(browser?.exe) || !browser.exe.startsWith('chrome-headless-shell/')) problems.push(`${name}.browser.exe must be a relative path under chrome-headless-shell/`);
    if (!SHA256.test(browser?.exeSha256 ?? '')) problems.push(`${name}.browser.exeSha256 must be 64 lowercase hex characters`);
    const ffmpeg = entry?.ffmpeg;
    if (ffmpeg?.source !== 'system') problems.push(`${name}.ffmpeg.source must be "system"`);
    if (!/^\d+\.\d+$/.test(ffmpeg?.minVersion ?? '')) problems.push(`${name}.ffmpeg.minVersion must look like 6.0`);
    for (const list of ['filters', 'encoders']) if (!Array.isArray(ffmpeg?.[list]) || !ffmpeg[list].every(text)) problems.push(`${name}.ffmpeg.${list} must be a list of names`);
    checkSource(problems, `${name}.ffmpeg`, ffmpeg);
    const runtime = entry?.transcription?.runtime;
    if (runtime?.source !== 'git') problems.push(`${name}.transcription.runtime.source must be "git"`);
    if (!https(runtime?.repository)) problems.push(`${name}.transcription.runtime.repository must be an https URL`);
    if (!/^[a-f0-9]{40}$/.test(runtime?.commit ?? '')) problems.push(`${name}.transcription.runtime.commit must be a full commit hash`);
    if (!Array.isArray(runtime?.cmake) || !runtime.cmake.every((flag) => typeof flag === 'string' && flag.startsWith('-D'))) problems.push(`${name}.transcription.runtime.cmake must be a list of -D flags`);
    if (!text(runtime?.target)) problems.push(`${name}.transcription.runtime.target is missing`);
  }
}

/** The validated lock with this host's platform pins applied. */
export async function readLock(root) {
  return platformLock(validateLock(JSON.parse(await fs.readFile(path.join(root, LOCK_FILE), 'utf8'))));
}
