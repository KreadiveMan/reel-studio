import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';

// Remote access over a private Tailscale network. The dashboard, editor and settings screens still listen on
// 127.0.0.1 only; `tailscale serve` publishes them inside the tailnet over HTTPS, and nothing is opened to the
// internet. Two things make that work:
//  - the dashboard accepts the machine's Tailscale name as a Host (saved in state/dashboard/remote.json), and
//  - two small relays on 127.0.0.1 (4390 → editor 4380, 4391 → settings 4381) forward requests to those
//    screens as if they came from the server itself, because both deliberately accept only loopback Host/Origin.
// A relay only forwards requests whose Host is loopback or a saved Tailscale name; the screens' own tokens
// still guard every request.

export const RELAYS = Object.freeze({
  editor: {listen: 4390, target: 4380, https: 8443},
  settings: {listen: 4391, target: 4381, https: 8444},
});
export const DASHBOARD_HTTPS = 443;
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;

export const remoteFile = (stateDir) => path.join(stateDir, 'remote.json');

export async function readRemote(stateDir) {
  const saved = await fs.readFile(remoteFile(stateDir), 'utf8').then(JSON.parse).catch(() => null);
  const hosts = (saved?.hosts ?? []).map((h) => String(h).toLowerCase()).filter((h) => NAME.test(h));
  return hosts.length ? {hosts} : null;
}

export async function saveRemote(stateDir, hosts) {
  const clean = [...new Set(hosts.map((h) => String(h).toLowerCase().replace(/\.$/, '')))];
  for (const host of clean) if (!NAME.test(host)) throw new Error(`«${host}» مش اسم جهاز صالح.`);
  await fs.mkdir(stateDir, {recursive: true});
  await fs.writeFile(remoteFile(stateDir), `${JSON.stringify({hosts: clean}, null, 1)}\n`, {mode: 0o600});
  return {hosts: clean};
}

/** The host part of a Host header, without its port. */
export const hostName = (header = '') => String(header).toLowerCase().replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/:\d{1,5}$/, '');

/** Loopback always; a saved Tailscale name when remote access is on. */
export function allowedHost(header, remote) {
  if (LOOPBACK.test(header ?? '')) return true;
  return !!remote?.hosts.includes(hostName(header));
}

/** Public links for a page opened through Tailscale: the screen's https port on the same name. */
export function publicLinks(header, remote) {
  if (!remote || LOOPBACK.test(header ?? '') || !allowedHost(header, remote)) return null;
  const host = hostName(header);
  return Object.fromEntries(Object.entries(RELAYS).map(([kind, relay]) => [kind, {local: relay.target, url: `https://${host}:${relay.https}`}]));
}

/** Starts the editor and settings relays; returns a close function. */
export async function startRelays(remote, {relays = RELAYS, targetHost = '127.0.0.1'} = {}) {
  const servers = [];
  for (const relay of Object.values(relays)) {
    const server = http.createServer((req, res) => {
      if (!allowedHost(req.headers.host, remote)) { res.writeHead(421); return res.end('Host not allowed'); }
      const local = `${targetHost}:${relay.target}`;
      const headers = {...req.headers, host: local};
      if (headers.origin) headers.origin = `http://${local}`;
      delete headers.referer;
      const upstream = http.request({host: targetHost, port: relay.target, method: req.method, path: req.url, headers}, (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, {'content-type': 'text/plain; charset=utf-8'}); res.end('الشاشة دي مش شغالة دلوقتي. اطلب من Claude يفتحها.'); });
      req.pipe(upstream);
      res.on('close', () => upstream.destroy());
    });
    server.requestTimeout = 0;
    await new Promise((resolve) => { server.once('error', () => resolve()); server.listen(relay.listen, '127.0.0.1', resolve); });
    if (server.listening) servers.push(server);
  }
  return () => Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
}

/** The server's Tailscale DNS name (for example studio.tail1234.ts.net), or null. */
export function tailscaleName(run = execFileSync) {
  try {
    const status = JSON.parse(run('tailscale', ['status', '--json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000}));
    const name = String(status?.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    return NAME.test(name) ? name : null;
  } catch { return null; }
}

/** The tailscale serve commands that publish the three screens inside the tailnet. */
export function serveCommands(dashboardPort = 4382) {
  return [
    ['serve', '--bg', `--https=${DASHBOARD_HTTPS}`, `http://127.0.0.1:${dashboardPort}`],
    ...Object.values(RELAYS).map((r) => ['serve', '--bg', `--https=${r.https}`, `http://127.0.0.1:${r.listen}`]),
  ];
}
