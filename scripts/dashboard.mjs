import './lib/project-tmp.mjs';
import {parseArgs} from 'node:util';
import {ROOT} from './lib/project-paths.mjs';
import {createDashboardServer} from './lib/dashboard/server.mjs';

// The studio dashboard: upload, projects, chat with Claude, approvals and progress in one page.
//   node scripts/dashboard.mjs [--port 4382]
// Keep it running (for example inside tmux); open the printed link through the SSH tunnel.
const {values} = parseArgs({args: process.argv.slice(2), options: {port: {type: 'string'}}, strict: true});
const port = values.port === undefined ? 4382 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Dashboard port must be from 0 to 65535.');
const app = await createDashboardServer({root: ROOT, port});
console.log('لوحة الاستوديو شغالة — افتح الرابط ده في متصفح جهازك (ونافذة SSH مفتوحة):');
console.log(app.url);
console.log(JSON.stringify({ok: true, url: app.url, command: 'dashboard'}));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
