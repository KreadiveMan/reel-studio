import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';

// Dashboard projects live in state/dashboard/ (local, never published). One JSON file per project holds its
// request, the Claude session id, the chat and the stage times. Writes go through a temporary file.

const ID = /^[a-z0-9]{8,32}$/;
const MAX_ITEMS = 2000;

export class DashboardStore {
  constructor(root) {
    this.dir = path.join(root, 'state', 'dashboard');
    this.projectsDir = path.join(this.dir, 'projects');
    this.projects = new Map();
    this.timers = new Map();
  }

  async open() {
    await fs.mkdir(this.projectsDir, {recursive: true});
    for (const name of await fs.readdir(this.projectsDir)) {
      if (!name.endsWith('.json')) continue;
      const project = await fs.readFile(path.join(this.projectsDir, name), 'utf8').then(JSON.parse).catch(() => null);
      if (project && ID.test(project.id ?? '')) this.projects.set(project.id, project);
    }
    return this;
  }

  /** A stable token so a bookmarked link keeps working after the dashboard restarts. */
  async token() {
    const file = path.join(this.dir, 'token');
    const saved = (await fs.readFile(file, 'utf8').catch(() => '')).trim();
    if (/^[a-f0-9]{64}$/.test(saved)) return saved;
    const token = randomBytes(32).toString('hex');
    await fs.writeFile(file, `${token}\n`, {mode: 0o600});
    return token;
  }

  list() { return [...this.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id) { return this.projects.get(id) ?? null; }

  create({kind, title, rawFile, style, notes}) {
    const now = new Date().toISOString();
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const project = {id, kind, title, rawFile: rawFile ?? null, style: style ?? null, notes: notes ?? '', slug: null, sessionId: null,
      createdAt: now, updatedAt: now, stages: {}, items: [], links: {}, activity: null};
    this.projects.set(id, project);
    this.save(project, {now: true});
    return project;
  }

  addItem(project, item) {
    const entry = {id: item.id ?? randomUUID(), at: new Date().toISOString(), ...item};
    const index = project.items.findIndex((x) => x.id === entry.id && x.role === entry.role);
    if (index >= 0) project.items[index] = {...project.items[index], ...entry};
    else project.items.push(entry);
    if (project.items.length > MAX_ITEMS) project.items.splice(0, project.items.length - MAX_ITEMS);
    this.touch(project);
    return entry;
  }

  touch(project) { project.updatedAt = new Date().toISOString(); this.save(project); }

  save(project, {now = false} = {}) {
    clearTimeout(this.timers.get(project.id));
    const write = async () => {
      this.timers.delete(project.id);
      const file = path.join(this.projectsDir, `${project.id}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(project, null, 1)}\n`, 'utf8');
      await fs.rename(temporary, file);
    };
    if (now) return write();
    this.timers.set(project.id, setTimeout(() => write().catch(() => {}), 400));
  }

  async flush() {
    const ids = [...this.timers.keys()];
    for (const id of ids) { clearTimeout(this.timers.get(id)); await this.save(this.projects.get(id), {now: true}); }
  }
}
