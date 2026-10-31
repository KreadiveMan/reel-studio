import path from 'node:path';

// The studio's two supported hosts. Windows x64 is the reference desktop install; Linux x64 serves
// servers and cloud sessions. Every platform difference (tool file names, the render browser path,
// how FFmpeg and whisper.cpp arrive) is decided here so the rest of the studio stays platform-neutral.
export const PLATFORM = `${process.platform}-${process.arch}`;
export const SUPPORTED_PLATFORMS = Object.freeze(['win32-x64', 'linux-x64']);
export const IS_WINDOWS = process.platform === 'win32';
export const EXE = IS_WINDOWS ? '.exe' : '';

export const platformSupported = (key = PLATFORM) => SUPPORTED_PLATFORMS.includes(key);

/** File name of a studio tool binary on this host, e.g. ffmpeg.exe on Windows and ffmpeg on Linux. */
export const exeName = (name) => `${name}${EXE}`;

/** Project-relative POSIX path of a Tools/bin binary (for snapshots and messages). */
export const toolRelative = (name) => `Tools/bin/${exeName(name)}`;

/** Absolute path of a Tools/bin binary. */
export const toolPath = (root, name) => path.join(root, 'Tools', 'bin', exeName(name));

const BROWSER_EXE = Object.freeze({
  'win32-x64': 'chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'linux-x64': 'chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell',
});

/** Render browser executable relative to a .remotion folder. */
export const browserExeRelative = (key = PLATFORM) => BROWSER_EXE[key] ?? BROWSER_EXE['win32-x64'];

/** Render browser executable inside engine/node_modules/.remotion. */
export const engineBrowserPath = (root, key = PLATFORM) => path.join(root, 'engine', 'node_modules', '.remotion', ...browserExeRelative(key).split('/'));

/**
 * The lock as this host sees it: top-level pins are the Windows reference; lock.platforms[<platform>]
 * replaces browser, ffmpeg and transcription.runtime fields for other hosts.
 */
export function platformLock(lock, key = PLATFORM) {
  if (key === 'win32-x64') return lock;
  const overlay = lock?.platforms?.[key];
  if (!overlay) return lock;
  return {
    ...lock,
    platform: key,
    browser: {...lock.browser, ...overlay.browser},
    ffmpeg: {...lock.ffmpeg, ...overlay.ffmpeg},
    transcription: {...lock.transcription, runtime: {...lock.transcription?.runtime, ...overlay.transcription?.runtime}},
  };
}
