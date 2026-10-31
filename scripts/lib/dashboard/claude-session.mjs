import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import readline from 'node:readline';
import {EventEmitter} from 'node:events';

// One Claude Code conversation driven from the dashboard. Claude runs headless in the studio folder
// (`claude -p` with stream-json in and out), so the studio's own .claude/settings.json allowlist and guides apply.
// Anything that would normally prompt in a terminal arrives here as a `can_use_tool` control request and is
// answered by the creator in the page. The process stays alive between messages; when it has exited, the next
// message resumes the same session id.

// Variables that tie a child to a parent Claude session; a dashboard started from inside Claude must not inherit them.
const PARENT_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID'];

export const DASHBOARD_PROMPT = `You are running inside the Reel Studio dashboard: the creator talks to you from a web page on their own computer, not from a terminal.
- Follow AGENTS.md and the studio guides exactly as in a terminal session; reply in concise Egyptian Arabic, in short numbered steps when there are several.
- Files arrive in Raw/ through the dashboard's upload panel. Do not start scripts/upload.mjs.
- Start long-running screens with fixed ports so the creator's SSH tunnel reaches them: live editor --port 4380, settings --port 4381. Run them in the background and put the printed http://127.0.0.1:... link in your reply on its own line; the dashboard turns it into a button.
- Ask creative or consequential decisions with the AskUserQuestion tool; the dashboard shows the options as buttons.
- Commands outside the studio allowlist appear to the creator as approve/deny buttons, so keep them rare: read files with Read and search with Grep/Glob instead of cat, sed, grep or ls in Bash; run studio commands plainly (node scripts/<name>.mjs …) without pipes, redirections, && chains or 2>&1 so they match the allowlist. If a command is denied, say what is blocked and continue with what you can.
- Write every tool description in short Egyptian Arabic; the creator sees it as the progress line and on approval cards.
- When a plan is ready, summarise it in the chat in numbered Egyptian Arabic (the scenes, what is cut, the style) before asking for approval; the dashboard's plan tab shows the scene table beside it.`;

export function claudeArgs({sessionId, resume}) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', 'acceptEdits', '--append-system-prompt', DASHBOARD_PROMPT,
    ...(resume ? ['--resume', sessionId] : sessionId ? ['--session-id', sessionId] : [])];
}

export function childEnv(base = process.env) {
  const env = {...base};
  for (const name of PARENT_SESSION_VARS) delete env[name];
  return env;
}

const toolSummary = (name, input = {}) => {
  if (input.description) return String(input.description);
  if (name === 'Bash') return String(input.command ?? '').slice(0, 160);
  if (['Read', 'Write', 'Edit'].includes(name)) return String(input.file_path ?? '');
  if (name === 'Agent' || name === 'Task') return String(input.description ?? input.prompt ?? '').slice(0, 160);
  return '';
};
const textOf = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.type === 'text' ? c.text : '').join('\n') : '';

/**
 * Events: 'item' (a finished chat entry), 'delta' ({id, text} streaming assistant text), 'tool' ({id, name, summary, input}),
 * 'tool-result' ({toolUseId, text, isError}), 'permission' ({requestId, tool, input, description}), 'state' ({running}),
 * 'session' (sessionId), 'result' ({ok, text, durationMs}), 'error' (message).
 */
export class ClaudeSession extends EventEmitter {
  constructor({cwd, sessionId = null, command = process.env.REEL_STUDIO_CLAUDE || 'claude', spawnImpl = spawn}) {
    super();
    Object.assign(this, {cwd, sessionId, command, spawnImpl, child: null, running: false, started: !!sessionId});
    this.pending = new Map();
  }

  get alive() { return !!this.child && this.child.exitCode === null; }

  start() {
    if (this.alive) return;
    const resume = this.started && !!this.sessionId;
    if (!this.sessionId) this.sessionId = randomUUID();
    const child = this.spawnImpl(this.command, claudeArgs({sessionId: this.sessionId, resume}), {cwd: this.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child;
    this.started = true;
    this.emit('session', this.sessionId);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (error) => {
      this.emit('error', error.code === 'ENOENT' ? 'Claude Code مش متسطّب أو مش في PATH على السيرفر.' : error.message);
      this.setRunning(false);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      for (const id of this.pending.keys()) this.emit('permission-cancel', id);
      this.pending.clear();
      if (this.running) {
        this.emit('error', code === 0 ? 'Claude وقف قبل ما يكمّل الرد.' : `Claude وقف (كود ${code}). ${stderr.trim().split('\n').slice(-3).join(' ')}`.trim());
        this.setRunning(false);
      }
    });
    readline.createInterface({input: child.stdout}).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      try { this.handle(message); } catch (error) { this.emit('error', `رسالة غير متوقعة من Claude: ${error.message}`); }
    });
  }

  write(object) { if (this.alive) this.child.stdin.write(`${JSON.stringify(object)}\n`); }

  setRunning(running) {
    if (this.running === running) return;
    this.running = running;
    this.emit('state', {running});
  }

  send(text) {
    this.start();
    this.setRunning(true);
    this.write({type: 'user', message: {role: 'user', content: text}, parent_tool_use_id: null, session_id: this.sessionId});
  }

  /** Stops the current turn; the session stays usable. */
  interrupt() {
    if (!this.alive) return false;
    this.write({type: 'control_request', request_id: randomUUID(), request: {subtype: 'interrupt'}});
    return true;
  }

  /** Answers a permission request. decision: {allow:boolean, input?:object, message?:string}. */
  answer(requestId, {allow, input, message, always = false}) {
    const request = this.pending.get(requestId);
    if (!request) return false;
    this.pending.delete(requestId);
    const response = allow
      ? {behavior: 'allow', updatedInput: input ?? request.input,
        // «وافق دايمًا»: Claude Code's own suggested rule, kept for this conversation only.
        ...(always && request.suggestions?.length ? {updatedPermissions: request.suggestions.map((rule) => ({...rule, destination: 'session'}))} : {})}
      : {behavior: 'deny', message: message || 'صاحب الاستوديو رفض الأمر ده من اللوحة.'};
    this.write({type: 'control_response', response: {subtype: 'success', request_id: requestId, response}});
    return true;
  }

  close() {
    if (this.alive) { this.child.stdin.end(); setTimeout(() => this.child?.kill(), 3000).unref(); }
  }

  handle(m) {
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) { this.sessionId = m.session_id; this.emit('session', m.session_id); return; }
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'message_start') this.streamId = e.message?.id ?? null;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && this.streamId && !m.parent_tool_use_id) this.emit('delta', {id: this.streamId, text: e.delta.text});
      return;
    }
    if (m.type === 'assistant' && !m.parent_tool_use_id) {
      const id = m.message?.id ?? randomUUID();
      const content = m.message?.content ?? [];
      // The CLI may send one event per content block under the same message id: keep the text of all of them.
      const added = content.filter((block) => block.type === 'text' && block.text.trim()).map((block) => block.text.trim());
      if (added.length) {
        if (this.textId !== id) { this.textId = id; this.texts = []; }
        this.texts.push(...added);
        this.emit('item', {id, role: 'assistant', text: this.texts.join('\n\n')});
      }
      for (const block of content) if (block.type === 'tool_use') this.emit('tool', {id: block.id, name: block.name, summary: toolSummary(block.name, block.input), input: block.input});
      return;
    }
    if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) if (block.type === 'tool_result') this.emit('tool-result', {toolUseId: block.tool_use_id, text: textOf(block.content), isError: !!block.is_error});
      return;
    }
    if (m.type === 'control_request') {
      const request = m.request ?? {};
      if (request.subtype === 'can_use_tool') {
        const suggestions = (request.permission_suggestions ?? []).filter((rule) => rule?.type === 'addRules' && rule.behavior === 'allow');
        const entry = {requestId: m.request_id, tool: request.tool_name, input: request.input ?? {}, description: request.description ?? toolSummary(request.tool_name, request.input), suggestions};
        this.pending.set(m.request_id, entry);
        this.emit('permission', entry);
      } else {
        this.write({type: 'control_response', response: {subtype: 'error', request_id: m.request_id, error: `Unsupported request ${request.subtype}`}});
      }
      return;
    }
    if (m.type === 'result') {
      this.emit('result', {ok: !m.is_error, text: m.result ?? '', durationMs: m.duration_ms ?? null});
      this.setRunning(false);
    }
  }
}
