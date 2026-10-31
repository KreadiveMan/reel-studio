import './lib/project-tmp.mjs';
import path from 'node:path';
import readline from 'node:readline';
import {parseArgs} from 'node:util';
import {ROOT} from './lib/project-paths.mjs';
import {createDashboardServer} from './lib/dashboard/server.mjs';
import {PasswordGate} from './lib/dashboard/auth.mjs';

// The studio dashboard: upload, projects, chat with Claude, approvals, progress, preview and delivery in one page.
//   node scripts/dashboard.mjs [--port 4382]        run it (bash scripts/dashboard-service.sh install keeps it running)
//   node scripts/dashboard.mjs --set-password       ask for a password on every new browser (optional)
//   node scripts/dashboard.mjs --clear-password     remove the password
//   node scripts/dashboard.mjs --link               print the dashboard link (the token is stable)
const {values} = parseArgs({args: process.argv.slice(2), options: {port: {type: 'string'}, 'set-password': {type: 'boolean'}, 'clear-password': {type: 'boolean'}, link: {type: 'boolean'}}, strict: true});
const STATE = path.join(ROOT, 'state', 'dashboard');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(text); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const port = values.port === undefined ? 4382 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Dashboard port must be from 0 to 65535.');

if (values['set-password']) {
  const first = await askHidden('الباسورد الجديد (8 حروف على الأقل): ');
  const second = await askHidden('اكتبه تاني للتأكيد: ');
  if (first !== second) { console.error('الباسوردين مش زي بعض؛ ما اتغيّرش حاجة.'); process.exit(1); }
  await PasswordGate.set(STATE, first);
  console.log('الباسورد اتحفظ ✓ — أعد تشغيل اللوحة عشان يتطبّق (لو شغالة كخدمة: bash scripts/dashboard-service.sh restart).');
} else if (values['clear-password']) {
  await PasswordGate.clear(STATE);
  console.log('الباسورد اتشال ✓ — أعد تشغيل اللوحة عشان يتطبّق.');
} else if (values.link) {
  const {DashboardStore} = await import('./lib/dashboard/store.mjs');
  const store = await new DashboardStore(ROOT).open();
  console.log(`http://127.0.0.1:${port}/?token=${await store.token()}`);
} else {
  const app = await createDashboardServer({root: ROOT, port});
  console.log('لوحة الاستوديو شغالة — افتح الرابط ده في متصفح جهازك (ونافذة SSH مفتوحة):');
  console.log(app.url);
  console.log(JSON.stringify({ok: true, url: app.url, command: 'dashboard'}));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
