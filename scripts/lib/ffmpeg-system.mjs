import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, existsSync, promises as fs} from 'node:fs';
import path from 'node:path';

// Linux hosts use the distribution's FFmpeg: it is maintained and security-patched by the OS and linked
// against the host's own libraries, which a downloaded static build cannot promise across distributions.
// Setup links it into Tools/bin so every studio script still finds Tools/bin/ffmpeg and Tools/bin/ffprobe.

const SEARCH = ['/usr/bin', '/usr/local/bin', '/bin'];

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const capture = (file, args) => {
  const result = execFileSync(file, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000});
  return result;
};

export function findSystemTool(name, {search = SEARCH, envPath = process.env.PATH ?? '', exclude = []} = {}) {
  const dirs = [...search, ...envPath.split(path.delimiter).filter(Boolean)];
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (exclude.some((skip) => path.resolve(skip) === path.resolve(dir))) continue;
    if (existsSync(file)) return file;
  }
  return null;
}

export function parseFfmpegVersion(line) {
  const match = /^ff(?:mpeg|probe) version n?(\d+)\.(\d+)/.exec(line ?? '');
  return match ? {major: Number(match[1]), minor: Number(match[2])} : null;
}

export const versionAtLeast = (actual, minimum) => {
  const [major, minor] = minimum.split('.').map(Number);
  return !!actual && (actual.major > major || (actual.major === major && actual.minor >= minor));
};

/** Checks a system FFmpeg against the pins and links it into Tools/bin. Returns the install report. */
export async function installSystemFfmpeg(root, pins, {log = () => {}} = {}) {
  const bin = path.join(root, 'Tools', 'bin');
  await fs.mkdir(bin, {recursive: true});
  const missing = `FFmpeg is not installed on this Linux host. Install the distribution package (${pins.install ?? 'sudo apt-get install -y ffmpeg'}), then run node scripts/studio.mjs setup again.`;
  const found = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = findSystemTool(name, {exclude: [bin]});
    if (!file) throw new Error(missing);
    found[name] = await fs.realpath(file);
  }
  const versionLine = capture(found.ffmpeg, ['-version']).split(/\r?\n/)[0];
  const version = parseFfmpegVersion(versionLine);
  if (!versionAtLeast(version, pins.minVersion)) throw new Error(`System FFmpeg is too old (${versionLine}); the studio needs ${pins.minVersion} or newer.`);
  if (!versionAtLeast(parseFfmpegVersion(capture(found.ffprobe, ['-version']).split(/\r?\n/)[0]), pins.minVersion)) throw new Error('System ffprobe does not match the FFmpeg version the studio needs.');
  const filters = capture(found.ffmpeg, ['-hide_banner', '-filters']);
  const encoders = capture(found.ffmpeg, ['-hide_banner', '-encoders']);
  for (const filter of pins.filters) if (!new RegExp(`\\s${filter}\\s`).test(filters)) throw new Error(`System FFmpeg lacks the required filter ${filter}; install a full FFmpeg build.`);
  for (const encoder of pins.encoders) if (!new RegExp(`\\s${encoder}\\s`).test(encoders)) throw new Error(`System FFmpeg lacks the required encoder ${encoder}; install a full FFmpeg build.`);
  // Copies, not symlinks: job paths refuse links. The binaries are small; their libraries stay the system's.
  // Tools/bin/ffmpeg.exe and ffprobe.exe are identical copies kept for the prepared-plate key in
  // scripts/lib/edit-project.mjs, which hashes that literal path on every host.
  const hashes = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    hashes[name] = await sha256(found[name]);
    for (const target of [path.join(bin, name), path.join(bin, `${name}.exe`)]) {
      const partial = `${target}.partial`;
      await fs.rm(partial, {force: true});
      await fs.copyFile(found[name], partial);
      await fs.chmod(partial, 0o755);
      await fs.rm(target, {force: true});
      await fs.rename(partial, target);
    }
  }
  log(`ffmpeg: using ${versionLine}`);
  const report = {
    ok: true, source: 'system', version: versionLine, minVersion: pins.minVersion,
    ffmpeg: path.join(bin, 'ffmpeg'), ffprobe: path.join(bin, 'ffprobe'),
    system: found, sha256: hashes,
    filters: pins.filters, encoders: pins.encoders,
  };
  await fs.writeFile(path.join(bin, 'ffmpeg-install.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

/** True when Tools/bin holds unmodified copies of the system FFmpeg setup checked, and that system FFmpeg is unchanged. */
export async function verifySystemFfmpeg(root) {
  const bin = path.join(root, 'Tools', 'bin');
  const report = await fs.readFile(path.join(bin, 'ffmpeg-install.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (report?.ok !== true || report.source !== 'system') return false;
  for (const name of ['ffmpeg', 'ffprobe']) {
    const expected = report.sha256?.[name];
    for (const file of [path.join(bin, name), path.join(bin, `${name}.exe`), report.system?.[name]]) {
      const stat = file ? await fs.lstat(file).catch(() => null) : null;
      if (!stat || (file !== report.system?.[name] && !stat.isFile())) return false;
      if ((await sha256(file)) !== expected) return false;
    }
  }
  return true;
}
