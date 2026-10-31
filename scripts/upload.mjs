import './lib/project-tmp.mjs';
import {parseArgs} from 'node:util';
import {ROOT} from './lib/project-paths.mjs';
import {createUploadServer} from './lib/upload-server.mjs';

// Opens the Raw upload page. Run it as a long-running command and keep it running while the creator uploads.
//   node scripts/upload.mjs [--port 4382]
const {values} = parseArgs({args: process.argv.slice(2), options: {port: {type: 'string'}}, strict: true});
const port = values.port === undefined ? 4382 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Upload port must be from 0 to 65535.');
const app = await createUploadServer({root: ROOT, port});
console.log('صفحة رفع الفيديوهات جاهزة — افتح الرابط على جهازك (ونافذة SSH مفتوحة) وارفع الملفات لفولدر Raw.');
console.log(JSON.stringify({ok: true, url: app.url, command: 'upload'}));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
