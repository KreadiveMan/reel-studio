import {createHash} from 'node:crypto';
import {mkdirSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {ROOT} from './project-paths.mjs';

// Live render progress for the dashboard: state/render-progress/<hash of the output path>.json, rewritten as
// the render moves. It is a side file outside the project and output folders and never affects a render.
// Plain renders report Remotion's own percentage; chunked renders report finished chunks (90%), then the
// audio, assembly and finishing steps.

export const RENDER_PROGRESS_DIR = path.join(ROOT, 'state', 'render-progress');
const CHUNK = /^chunk (\d+)\/(\d+): (?:rendered and verified|verified cache)/;

export function createRenderProgress({out, mode, frames}) {
  const relative = path.relative(ROOT, path.resolve(out)).split(path.sep).join('/');
  const file = path.join(RENDER_PROGRESS_DIR, `${createHash('sha1').update(relative).digest('hex').slice(0, 16)}.json`);
  const state = {out: relative, mode, frames, pid: process.pid, status: 'running', phase: 'frames', percent: 0, fps: null,
    startedAt: new Date().toISOString(), updatedAt: null, chunks: null};
  let chunksDone = 0, finished = false;
  const write = () => {
    state.updatedAt = new Date().toISOString();
    try {
      mkdirSync(RENDER_PROGRESS_DIR, {recursive: true});
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state)}\n`);
      renameSync(temporary, file);
    } catch { /* progress is informational only */ }
  };
  const set = (fields) => { Object.assign(state, fields); write(); };
  process.once('exit', () => { if (!finished) { state.status = 'stopped'; write(); } });
  write();
  return {
    file,
    frames: ({percent, fps}) => set({phase: 'frames', percent: Math.min(90, Math.round(percent * 0.9)), fps: fps ?? state.fps}),
    log: (message) => {
      const match = CHUNK.exec(String(message));
      if (!match) return;
      chunksDone += 1;
      set({phase: 'frames', chunks: {done: chunksDone, total: Number(match[2])}, percent: Math.round((chunksDone / Number(match[2])) * 90)});
    },
    phase: (phase, percent) => set({phase, percent: Math.max(state.percent, percent)}),
    done: () => { finished = true; set({status: 'done', phase: 'done', percent: 100}); },
  };
}
