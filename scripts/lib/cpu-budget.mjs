import os from 'node:os';

// How much of the machine the studio's heavy work may use while it runs: transcription threads, render tabs,
// FFmpeg threads and parallel montage shots all size themselves from here. Default 80% of the logical cores,
// leaving the rest for the system, the dashboard and Claude. Override with REEL_STUDIO_CPU_SHARE (0.1–1).

export const CPU_SHARE = (() => {
  const value = Number(process.env.REEL_STUDIO_CPU_SHARE ?? 0.8);
  return Number.isFinite(value) ? Math.min(1, Math.max(0.1, value)) : 0.8;
})();

/** Logical cores available to this process. */
export const cpuCount = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);

/** Threads for one heavy job: the CPU share of the cores, at least 1, at most `max`. */
export const cpuThreads = (max = Infinity) => Math.max(1, Math.min(max, Math.floor(cpuCount() * CPU_SHARE)));

/**
 * Render tabs (Remotion concurrency): the CPU share, but never more tabs than free memory allows
 * (about 600 MB each) and at most `max`.
 */
export function renderConcurrency(max = 16) {
  const byMemory = Math.max(1, Math.floor((os.freemem() - 1024 ** 3) / (600 * 1024 ** 2)));
  return Math.max(1, Math.min(max, cpuThreads(), byMemory));
}
