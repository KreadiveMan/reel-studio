import {createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {HttpError} from '../upload-server.mjs';

// Optional dashboard password, set with `node scripts/dashboard.mjs --set-password`. Stored as a scrypt hash;
// a login gives a 30-day HttpOnly session cookie whose sha256 is kept on disk, so a restart does not log out.
// Five wrong tries in a minute pause logins for that address.

const scrypt = promisify(scryptCallback);
const DAY = 24 * 3600 * 1000;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const cookieValue = (header = '', name) => header.split(';').map((p) => p.trim().split('=')).find(([k]) => k === name)?.[1];

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return {salt, hash: (await scrypt(password, salt, 64)).toString('hex')};
}

export class PasswordGate {
  constructor(dir) {
    this.file = path.join(dir, 'password.json');
    this.sessionsFile = path.join(dir, 'sessions.json');
    this.cookie = 'rs_session';
    this.record = null; this.sessions = new Map(); this.failures = new Map();
  }

  async open() {
    this.record = await fs.readFile(this.file, 'utf8').then(JSON.parse).catch(() => null);
    const saved = await fs.readFile(this.sessionsFile, 'utf8').then(JSON.parse).catch(() => ({}));
    for (const [digest, expires] of Object.entries(saved)) if (expires > Date.now()) this.sessions.set(digest, expires);
    return this;
  }

  get enabled() { return !!this.record?.hash; }

  static async set(dir, password) {
    if (typeof password !== 'string' || password.length < 8) throw new Error('الباسورد لازم يكون 8 حروف على الأقل.');
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'password.json'), `${JSON.stringify(await hashPassword(password))}\n`, {mode: 0o600});
    await fs.rm(path.join(dir, 'sessions.json'), {force: true});
  }

  static async clear(dir) {
    await fs.rm(path.join(dir, 'password.json'), {force: true});
    await fs.rm(path.join(dir, 'sessions.json'), {force: true});
  }

  async login(password, address = 'local') {
    const now = Date.now();
    const recent = (this.failures.get(address) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 5) throw new HttpError(429, 'محاولات كتير غلط. استنى دقيقة وجرّب تاني.');
    const {hash} = await hashPassword(password, this.record.salt);
    if (!timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(this.record.hash, 'hex'))) {
      this.failures.set(address, [...recent, now]);
      throw new HttpError(401, 'الباسورد غلط.');
    }
    this.failures.delete(address);
    const session = randomBytes(32).toString('hex');
    this.sessions.set(sha(session), now + 30 * DAY);
    await this.persist();
    return {session};
  }

  valid(cookieHeader) {
    const session = cookieValue(cookieHeader, this.cookie);
    const expires = session && this.sessions.get(sha(session));
    return !!expires && expires > Date.now();
  }

  logout(cookieHeader) {
    const session = cookieValue(cookieHeader, this.cookie);
    if (session) { this.sessions.delete(sha(session)); this.persist().catch(() => {}); }
  }

  async persist() {
    await fs.writeFile(this.sessionsFile, `${JSON.stringify(Object.fromEntries(this.sessions))}\n`, {mode: 0o600});
  }
}
