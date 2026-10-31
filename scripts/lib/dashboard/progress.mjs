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

const clipFolders = async (root, slug) => slug ? (await fs.readdir(path.join(root, 'Projects')).catch(() => [])).filter((name) => name.startsWith(`${slug}--`)) : [];

/** Which stage files exist now. graphics projects (no recording) skip upload and transcript; podcast projects count their clip projects. */
export async function detectStages(root, {slug, rawFile, kind}) {
  if (kind === 'podcast') return detectPodcast(root, {slug, rawFile});
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

// A podcast batch (instructions/PODCAST.md): the episode's transcript and approved selections, then one studio
// project per clip, Projects/<batch>--<clip>. A stage counts once any clip reaches it.
async function detectPodcast(root, {slug, rawFile}) {
  const at = (...parts) => path.join(root, ...parts);
  const clips = await clipFolders(root, slug);
  const some = async (...rel) => { for (const clip of clips) if (await anyExists(rel.map((r) => at('Projects', clip, ...r.split('/'))))) return true; return false; };
  const outputs = async () => { for (const clip of clips) for (const name of await fs.readdir(at('Outputs', clip)).catch(() => [])) if (/\.(mp4|mov)$/i.test(name)) return true; return false; };
  const found = {
    upload: !!rawFile && await exists(at(...rawFile.split('/'))),
    transcript: !!slug && await anyExists([at('Projects', slug, 'words.json'), at('Projects', slug, 'transcript', 'captions.json'), at('Projects', slug, 'podcast', 'proposals.json')]),
    plan: !!slug && await anyExists([at('Projects', slug, 'selections.json'), at('Projects', slug, 'podcast', 'batch.json')]),
    draft: await some('edit.json'),
    preview: await some('prepared/props.json', 'renders/edit-preview.mp4'),
    render: await some('renders/edit-delivery.mp4'),
    done: await outputs(),
  };
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
  // A podcast clip project belongs to its batch: Projects/<batch>--<clip>/ → <batch>.
  return match && !match[1].startsWith('_') ? match[1].split('--')[0] : null;
}
