#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json` used by the dashboard tests.
// Each user message plays one scripted turn: streamed text, a Bash call that needs approval, a question, a reply.
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';

const args = process.argv.slice(2);
const sessionId = args[args.indexOf('--session-id') + 1] && args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : args[args.indexOf('--resume') + 1];
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const waiting = new Map();
const ask = (request) => new Promise((resolve) => { const id = randomUUID(); waiting.set(id, resolve); out({type: 'control_request', request_id: id, request}); });
let turn = 0;
out({type: 'system', subtype: 'init', session_id: sessionId, resumed: args.includes('--resume')});

async function play(text) {
  turn += 1;
  const id = `msg_${turn}`;
  out({type: 'stream_event', event: {type: 'message_start', message: {id}}});
  for (const piece of ['تمام، ', 'هبدأ ', 'دلوقتي.']) out({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: piece}}});
  out({type: 'assistant', message: {id, content: [{type: 'text', text: 'تمام، هبدأ دلوقتي.'}, {type: 'tool_use', id: `tool_${turn}`, name: 'Bash', input: {command: 'node scripts/intake.mjs --source Raw/clip.mp4 --id test-reel', description: 'Measure the recording'}}]}});
  const decision = await ask({subtype: 'can_use_tool', tool_name: 'Bash', input: {command: 'rm -rf Projects/old', description: 'Remove an old project'}, description: 'Remove an old project', permission_suggestions: [{type: 'addRules', rules: [{toolName: 'Bash', ruleContent: 'rm -rf Projects/old'}], behavior: 'allow', destination: 'localSettings'}]});
  out({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: `tool_${turn}`, content: decision.behavior === 'allow' ? `Editor ready: http://127.0.0.1:4380/?token=abc123 Projects/test-reel/edit.json rules:${(decision.updatedPermissions ?? []).map((r) => r.destination).join()}` : 'denied', is_error: decision.behavior !== 'allow'}]}});
  const answer = await ask({subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {questions: [{question: 'أنهي ستايل؟', header: 'Style', multiSelect: false, options: [{label: 'ورق متحرك', description: 'حركة ورق'}, {label: 'مجلة'}]}]}});
  const picked = answer.behavior === 'allow' ? Object.values(answer.updatedInput.answers ?? {}).join() : 'none';
  out({type: 'assistant', message: {id: `${id}_end`, content: [{type: 'text', text: `اخترت: ${picked}. وصلتني رسالتك: ${text}`}]}});
  out({type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, duration_ms: 5});
}

readline.createInterface({input: process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_response') { const resolve = waiting.get(m.response.request_id); waiting.delete(m.response.request_id); resolve?.(m.response.response); return; }
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') { out({type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sessionId}); return; }
  if (m.type === 'user') play(typeof m.message.content === 'string' ? m.message.content : '');
});
