import {promises as fs} from 'node:fs';
import path from 'node:path';

// A project's stages, read from the files the studio itself writes (instructions/EDITORIAL.md, EDITING.md,
// PRODUCTION.md). A stage is done when its file exists; the first time each is seen is recorded, so the page
// can show how long every stage took. Nothing here guesses from chat text.

export const STAGES = Object.freeze([
  {id: 'upload', label: 'رفع الفيديو'},
  {id: 'transcript', label: 'تفريغ الكلام'},
  {id: 'plan', label: 'خطة المونتاج'},
  {id: 'draft', label: 'المسودة'},
  {id: 'preview', label: 'البريفيو'},
  {id: 'render', label: 'الرندر النهائي'},
  {id: 'done', label: 'جاهز'},
]);

const exists = async (file) => !!(await fs.stat(file).catch(() => null));
const anyExists = async (files) => { for (const file of files) if (await exists(file)) return true; return false; };

/** Which stage files exist now. graphics projects (no recording) skip upload and transcript. */
export async function detectStages(root, {slug, rawFile, kind}) {
  const at = (...parts) => path.join(root, ...parts);
  const p = (...parts) => slug ? at('Projects', slug, ...parts) : null;
  const graphics = kind === 'graphics';
  const found = {
    upload: graphics || (!!rawFile && await exists(at(...rawFile.split('/')))),
    transcript: graphics || (!!slug && await anyExists([p('transcript', 'captions.json'), p('transcript', 'transcript-manifest.json')])),
    plan: !!slug && await anyExists([p('EDITORIAL_PLAN.md'), p('brief.json'), p('graphics-spec.json')]),
    draft: !!slug && await exists(p('edit.json')),
    preview: !!slug && await anyExists([p('prepared', 'props.json'), p('renders', 'edit-preview.mp4')]),
    render: !!slug && await anyExists([p('renders', 'edit-delivery.mp4'), p('renders', 'edit-delivery.vo.mp4')]),
    done: !!slug && await exists(at('Outputs', slug, `${slug}.mp4`)),
  };
  // A later stage implies the earlier ones (for example a re-used transcript under another name).
  let later = false;
  for (const stage of [...STAGES].reverse()) { if (found[stage.id]) later = true; else if (later) found[stage.id] = true; }
  return found;
}

/** Merges detection into the saved stage times; returns true when something changed. */
export function recordStages(project, found, now = new Date().toISOString()) {
  project.stages ??= {};
  let changed = false;
  for (const stage of STAGES) {
    if (found[stage.id] && !project.stages[stage.id]) { project.stages[stage.id] = now; changed = true; }
    if (!found[stage.id] && project.stages[stage.id]) { delete project.stages[stage.id]; changed = true; }
  }
  return changed;
}

/** Percentage of stages done (the visible bar), and the current stage. */
export function stageSummary(project) {
  const done = STAGES.filter((s) => project.stages?.[s.id]).length;
  const current = STAGES.find((s) => !project.stages?.[s.id]) ?? null;
  return {percent: Math.round((done / STAGES.length) * 100), current: current?.id ?? null, done};
}

/** The studio project folder a tool call touched, e.g. Projects/my-reel/edit.json → my-reel. */
export function slugFromText(text) {
  const match = /(?:^|[\s"'`=/(])Projects\/([a-z0-9][a-z0-9-]{0,63})\//.exec(String(text ?? ''));
  return match && !match[1].startsWith('_') ? match[1] : null;
}
