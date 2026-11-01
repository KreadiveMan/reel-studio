import './lib/project-tmp.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {ROOT, assertProjectOutput} from './lib/project-paths.mjs';
import {joinFiles} from './lib/join-recordings.mjs';

// Several recordings for one reel (parts in order, or several takes of the same lines) become one source file in
// the project, so the normal intake → transcript → cut workflow (instructions/EDITING.md) treats them as one
// recording. The originals in Raw/ are only read.
//   node scripts/join-recordings.mjs --id <slug> --sources Raw/IMG_3103.MOV,Raw/IMG_3104.MOV
// Same camera and settings (codec, size, pixel format, frame rate, audio): the streams are joined without
// re-encoding (seconds, no quality loss; HDR stays HDR for intake to tone-map). Otherwise each part is re-encoded
// to the first part's size and frame rate (HEVC 10-bit keeping HDR tags when the first part is HDR, else H.264).
// Writes Projects/<slug>/source/joined.<ext> and join.json (where each recording starts in the joined file).

const {values} = parseArgs({args: process.argv.slice(2), strict: true, options: {id: {type: 'string'}, sources: {type: 'string'}}});

async function main() {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(values.id ?? '')) throw new Error('--id must be a project slug such as my-reel.');
  const sources = String(values.sources ?? '').split(',').map((s) => s.trim().replaceAll('\\', '/')).filter(Boolean);
  if (sources.length < 2) throw new Error('محتاج تسجيلين على الأقل (--sources Raw/a.mov,Raw/b.mov).');
  for (const s of sources) {
    if (!s.startsWith('Raw/') || s.split('/').some((p) => p === '..' || !p)) throw new Error(`${s}: التسجيلات لازم تكون من فولدر Raw.`);
    if (!(await fs.stat(path.join(ROOT, ...s.split('/'))).catch(() => null))?.isFile()) throw new Error(`${s} مش موجود.`);
  }
  const dir = assertProjectOutput(path.join(ROOT, 'Projects', values.id, 'source'));
  const record = await joinFiles(ROOT, sources, dir);
  console.log(JSON.stringify({ok: true, message: `اتجمّعوا في ملف واحد (${record.totalSeconds.toFixed(1)} ث، ${record.method === 'stream-copy' ? 'من غير إعادة ترميز' : 'بإعادة ترميز'}).`, ...record}));
}

main().catch((error) => { console.error(JSON.stringify({ok: false, error: error.message})); process.exit(1); });
