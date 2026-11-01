import './lib/project-tmp.mjs';
import path from 'node:path';
import readline from 'node:readline';
import {parseArgs} from 'node:util';
import {ROOT} from './lib/project-paths.mjs';
import {createDashboardServer} from './lib/dashboard/server.mjs';
import {PasswordGate} from './lib/dashboard/auth.mjs';
import {execFileSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {DASHBOARD_HTTPS, RELAYS, remoteFile, saveRemote, serveCommands, tailscaleName} from './lib/dashboard/remote.mjs';

// The studio dashboard: upload, projects, chat with Claude, approvals, progress, preview and delivery in one page.
//   node scripts/dashboard.mjs [--port 4382]        run it (bash scripts/dashboard-service.sh install keeps it running)
//   node scripts/dashboard.mjs --set-password       ask for a password on every new browser (optional)
//   node scripts/dashboard.mjs --clear-password     remove the password
//   node scripts/dashboard.mjs --link               print the dashboard link (the token is stable)
//   node scripts/dashboard.mjs --tailscale [--host name.tailnet.ts.net]   open it from your phone over Tailscale
//   node scripts/dashboard.mjs --tailscale-off      stop accepting the Tailscale name
const {values} = parseArgs({args: process.argv.slice(2), options: {port: {type: 'string'}, 'set-password': {type: 'boolean'}, 'clear-password': {type: 'boolean'}, link: {type: 'boolean'}, tailscale: {type: 'boolean'}, host: {type: 'string'}, 'tailscale-off': {type: 'boolean'}}, strict: true});
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
} else if (values.tailscale) {
  const name = values.host ?? tailscaleName();
  if (!name) { console.error('مش لاقي Tailscale شغال على السيرفر. اتأكد إن `tailscale status` شغال، أو اكتب الاسم: --host name.tailnet.ts.net'); process.exit(1); }
  await saveRemote(STATE, [name]);
  console.log(`✓ اللوحة هتقبل العنوان ${name}`);
  // Publish the three screens inside the tailnet. tailscale serve needs root unless this user is the Tailscale operator.
  const failed = [];
  for (const args of serveCommands(port)) {
    try { execFileSync('tailscale', args, {stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000}); }
    catch { failed.push(args); }
  }
  if (failed.length) {
    console.log('\nمحتاج صلاحية مرة واحدة. نفّذ الأوامر دي:');
    for (const args of failed) console.log(`  sudo tailscale ${args.join(' ')}`);
  } else console.log('✓ اللوحة والمحرر والإعدادات متاحين على شبكة Tailscale بتاعتك بس.');
  const {DashboardStore} = await import('./lib/dashboard/store.mjs');
  const token = await (await new DashboardStore(ROOT).open()).token();
  console.log(`\nأعد تشغيل اللوحة (bash scripts/dashboard-service.sh restart)، وبعدين افتح من موبايلك وTailscale شغال عليه:\n  https://${name}${DASHBOARD_HTTPS === 443 ? '' : `:${DASHBOARD_HTTPS}`}/?token=${token}`);
  console.log(`(المحرر على :${RELAYS.editor.https} والإعدادات على :${RELAYS.settings.https} بيتفتحوا من الأزرار جوه اللوحة.)`);
} else if (values['tailscale-off']) {
  await fs.rm(remoteFile(STATE), {force: true});
  console.log('✓ اللوحة مش هتقبل عنوان Tailscale تاني. عشان توقف النشر على الشبكة كمان:');
  for (const args of serveCommands(port)) console.log(`  sudo tailscale serve --https=${args[2].split('=')[1]} off`);
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
