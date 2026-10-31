'use strict';
// Reel Studio dashboard client: projects, uploads, the chat with Claude, approvals and stage progress.
const $ = (sel, root = document) => root.querySelector(sel);
const H = {'x-dashboard': '1', 'content-type': 'application/json'};
const state = {stages: [], styles: [], projects: new Map(), raw: [], current: null, project: null, drafts: new Map()};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const size = (b) => b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0'); };
const LINK_LABEL = {editor: 'افتح المحرر', settings: 'افتح الإعدادات'};

async function api(path, options = {}) {
  const res = await fetch(path, {...options, headers: {...H, ...(options.headers ?? {})}});
  const data = await res.json().catch(() => ({ok: false, error: 'رد غير مفهوم من السيرفر.'}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'حصلت مشكلة.');
  return data;
}

// Light formatting for Claude's replies: escaped text, **bold**, `code`, and local links as buttons.
function format(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/[^\s"'<>)\]`]*/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url.includes(':4380') ? 'افتح المحرر' : url.includes(':4381') ? 'افتح الإعدادات' : 'افتح الرابط'} ↗</a>`);
}

// ---------- sidebar ----------
function badge(p) {
  if (p.waiting) return ['wait', 'مستني ردك'];
  if (p.running) return ['run', 'Claude شغال'];
  if (p.current === null) return ['done', 'جاهز'];
  return ['', `${p.percent}%`];
}
function renderSide() {
  const list = [...state.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('#projects').innerHTML = list.length ? list.map((p) => {
    const [cls, label] = badge(p);
    return `<a href="#p=${p.id}" class="${state.current === p.id ? 'active' : ''}"><span class="t">${esc(p.title)}</span><span class="s"><i class="dot ${cls}"></i>${esc(label)}</span></a>`;
  }).join('') : '<p class="dim">لسه مفيش مشاريع.</p>';
}

// ---------- home: upload + new project ----------
function renderHome() {
  state.current = null; state.project = null; renderSide();
  const main = $('#main');
  main.replaceChildren($('#tpl-home').content.cloneNode(true));
  const drop = $('.drop', main), pick = $('input[type=file]', main);
  drop.addEventListener('click', () => pick.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') pick.click(); });
  pick.addEventListener('change', () => { enqueue(pick.files); pick.value = ''; });
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => enqueue(e.dataTransfer.files));
  const form = $('.new-form', main);
  $('select[name=style]', form).insertAdjacentHTML('beforeend', state.styles.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join(''));
  const syncKind = () => {
    const graphics = form.kind.value === 'graphics';
    $('.rec', form).hidden = graphics;
    $('.notes-label', form).textContent = graphics ? 'فكرة الموشن (مطلوبة)' : 'ملاحظاتك (اختياري)';
  };
  form.addEventListener('change', syncKind); syncKind();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', form), error = $('.form-error', form);
    button.disabled = true; error.textContent = '';
    try {
      const data = await api('/api/projects', {method: 'POST', body: JSON.stringify({kind: form.kind.value, rawFile: form.rawFile.value, style: form.style.value, title: form.title.value, notes: form.notes.value})});
      state.projects.set(data.project.id, data.project);
      location.hash = 'p=' + data.project.id;
    } catch (err) { error.textContent = err.message; button.disabled = false; }
  });
  renderRaw();
}
function renderRaw() {
  const main = $('#main');
  const list = $('.rawlist', main), select = $('select[name=rawFile]', main);
  if (!list) return;
  list.innerHTML = state.raw.length ? state.raw.map((f) => `<div class="row"><div class="top2"><span class="name">Raw/${esc(f.name)}</span><span class="size">${size(f.bytes)}</span></div></div>`).join('') : '<p class="dim">لسه مفيش ملفات.</p>';
  const keep = select.value;
  const videos = state.raw.filter((f) => /\.(mp4|mov|m4v|mkv|webm|avi|mts|mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name));
  select.innerHTML = videos.length ? videos.map((f) => `<option value="Raw/${esc(f.name)}">${esc(f.name)}</option>`).join('') : '<option value="">ارفع فيديو الأول</option>';
  if (keep) select.value = keep;
}

let uploadChain = Promise.resolve();
function enqueue(files) {
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="top2"><span class="name">${esc(file.name)}</span><span class="size">${size(file.size)}</span></div><div class="bar"><i></i></div><div class="msg">مستني دوره…</div>`;
    $('.queue')?.prepend(row);
    uploadChain = uploadChain.then(() => upload(file, row));
  }
}
function upload(file, row) {
  return new Promise((resolve) => {
    const bar = $('.bar i', row), msg = $('.msg', row), xhr = new XMLHttpRequest(), started = Date.now();
    xhr.open('PUT', '/api/upload?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('x-dashboard', '1');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = e.loaded / e.total * 100, secs = (Date.now() - started) / 1000, rate = e.loaded / Math.max(secs, .1);
      bar.style.width = pct.toFixed(1) + '%';
      msg.textContent = `${pct.toFixed(0)}% — ${size(rate)}/ث — باقي حوالي ${clock((e.total - e.loaded) / rate * 1000)}`;
    };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && data.ok) { row.classList.add('done'); bar.style.width = '100%'; msg.textContent = `اترفع ✓ ${data.path}` + (data.renamed ? ' (الاسم اتغير عشان ما يمسحش ملف قديم)' : ''); }
      else { row.classList.add('fail'); msg.textContent = data.error || 'الرفع فشل؛ جرّب تاني.'; }
      resolve();
    };
    xhr.onerror = () => { row.classList.add('fail'); msg.textContent = 'الاتصال اتقطع. اتأكد إن نافذة SSH مفتوحة وجرّب تاني.'; resolve(); };
    xhr.send(file);
  });
}

// ---------- project view ----------
async function openProject(id) {
  state.current = id; renderSide();
  const main = $('#main');
  main.innerHTML = '<p class="empty">بحمّل المشروع…</p>';
  let data;
  try { data = await api('/api/projects/' + id); } catch (err) { main.innerHTML = `<p class="empty">${esc(err.message)}</p>`; return; }
  if (state.current !== id) return;
  state.project = data.project;
  main.replaceChildren($('#tpl-project').content.cloneNode(true));
  $('.ptitle').textContent = data.project.title;
  const where = data.project.kind === 'graphics' ? 'موشن من فكرة' : data.project.rawFile;
  $('.meta').textContent = `${where} · بدأ ${new Date(data.project.createdAt).toLocaleString('ar-EG')}`;
  const log = $('.log');
  for (const item of data.project.items) log.append(itemNode(item));
  if (!data.project.items.length) log.innerHTML = '<p class="empty">لسه مفيش رسايل.</p>';
  for (const entry of data.project.pending) addApproval(entry);
  renderHead(); renderLinks();
  scrollLog(true);
  const form = $('.composer'), box = $('textarea', form);
  box.value = state.drafts.get(id) ?? '';
  box.addEventListener('input', () => state.drafts.set(id, box.value));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = box.value.trim(); if (!text) return;
    const button = $('button[type=submit]', form); button.disabled = true;
    try { await api(`/api/projects/${id}/messages`, {method: 'POST', body: JSON.stringify({text})}); box.value = ''; state.drafts.delete(id); }
    catch (err) { alert(err.message); }
    button.disabled = false;
  });
  $('.stop').addEventListener('click', () => api(`/api/projects/${id}/interrupt`, {method: 'POST', body: '{}'}).catch((err) => alert(err.message)));
}

function itemNode(item) {
  const node = document.createElement('div');
  node.dataset.id = item.id; node.dataset.role = item.role;
  if (item.role === 'tool') {
    node.className = 'tool ' + (item.status ?? '');
    node.innerHTML = `<span class="st"></span><span class="txt" title="${esc(item.text)}">${esc(item.text || item.name)}</span>`;
  } else {
    node.className = 'bubble ' + item.role;
    node.innerHTML = item.role === 'assistant' ? format(item.text) : esc(item.text);
  }
  return node;
}
function upsertItem(item) {
  const log = $('.log'); if (!log) return;
  $('.empty', log)?.remove();
  const old = log.querySelector(`[data-id="${CSS.escape(item.id)}"][data-role="${item.role}"]`);
  const node = itemNode(item);
  if (old) old.replaceWith(node); else log.append(node);
  scrollLog();
}
function delta(itemId, text) {
  const log = $('.log'); if (!log) return;
  $('.empty', log)?.remove();
  let node = log.querySelector(`[data-id="${CSS.escape(itemId)}"][data-role="assistant"]`);
  if (!node) { node = itemNode({id: itemId, role: 'assistant', text: ''}); node.dataset.raw = ''; log.append(node); }
  node.dataset.raw = (node.dataset.raw ?? '') + text;
  node.innerHTML = format(node.dataset.raw);
  scrollLog();
}
function scrollLog(force) {
  const log = $('.log'); if (!log) return;
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight;
  if (window.matchMedia('(max-width:780px)').matches && (force || innerHeight + scrollY > document.body.scrollHeight - 200)) scrollTo(0, document.body.scrollHeight);
}

function renderHead() {
  const p = state.project; if (!p || !$('.stages')) return;
  const summary = state.projects.get(p.id) ?? p;
  Object.assign(p, {running: summary.running, waiting: summary.waiting, percent: summary.percent, current: summary.current, stages: summary.stages ?? p.stages});
  const [cls, label] = badge(p);
  const b = $('.badge'); b.className = 'badge ' + cls; b.textContent = label;
  let previous = Date.parse(p.createdAt);
  $('.stages').innerHTML = state.stages.map((s) => {
    const at = p.stages?.[s.id];
    let note = '';
    if (at) { const t = Date.parse(at); note = `خلص بعد ${clock(t - previous)}`; previous = t; }
    else if (s.id === p.current) note = p.running ? `شغالين عليها من ${clock(Date.now() - previous)}` : 'الخطوة الجاية';
    return `<li class="${at ? 'ok' : s.id === p.current ? 'now' : ''}"><b>${esc(s.label)}</b>${esc(note)}</li>`;
  }).join('');
  $('.bar i').style.width = (p.percent ?? 0) + '%';
  const activity = $('.activity');
  if (p.waiting) activity.innerHTML = '<span style="color:var(--warn)">⏸ Claude مستني ردك تحت.</span>';
  else if (p.running) activity.innerHTML = `<span class="spin"></span>${esc(p.activity?.text || 'Claude بيفكّر…')} <span class="dim">· ${clock(Date.now() - Date.parse(p.activity?.since ?? p.updatedAt))}</span>`;
  else activity.innerHTML = p.current === null ? '<span style="color:var(--ok)">✓ الفيديو النهائي جاهز في Outputs.</span>' : '<span class="dim">Claude مستني رسالتك.</span>';
  $('.stop').hidden = !p.running;
}
function renderLinks() {
  const p = state.project; if (!p || !$('.links')) return;
  $('.links').innerHTML = Object.entries(p.links ?? {}).map(([kind, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(LINK_LABEL[kind] ?? 'افتح ' + kind)} ↗</a>`).join('');
}

function addApproval(entry) {
  const box = $('.approvals'); if (!box || box.querySelector(`[data-req="${CSS.escape(entry.requestId)}"]`)) return;
  const card = document.createElement('div');
  card.className = 'approval'; card.dataset.req = entry.requestId;
  const id = state.current;
  const reply = async (body) => {
    card.querySelectorAll('button').forEach((b) => b.disabled = true);
    try { await api(`/api/projects/${id}/permissions/${encodeURIComponent(entry.requestId)}`, {method: 'POST', body: JSON.stringify(body)}); card.remove(); }
    catch (err) { alert(err.message); card.querySelectorAll('button').forEach((b) => b.disabled = false); }
  };
  if (entry.tool === 'AskUserQuestion') {
    const questions = entry.input?.questions ?? [];
    const answers = {};
    card.innerHTML = '<h3>Claude بيسألك</h3>' + questions.map((q, i) => `<div class="q" data-i="${i}"><p><b>${esc(q.question)}</b>${q.multiSelect ? ' <span class="dim">(ممكن تختار أكتر من واحد)</span>' : ''}</p><div class="btns">${(q.options ?? []).map((o, j) => `<button type="button" class="choice" data-j="${j}">${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}</div><input class="other" placeholder="أو اكتب إجابة تانية…"></div>`).join('')
      + '<div class="btns"><button type="button" class="primary send">ابعت الإجابة</button><button type="button" class="ghost skip">تخطّى</button></div>';
    card.querySelectorAll('.q').forEach((qn) => {
      const q = questions[qn.dataset.i];
      qn.querySelectorAll('.choice').forEach((btn) => btn.addEventListener('click', () => {
        if (!q.multiSelect) qn.querySelectorAll('.choice').forEach((x) => x.classList.remove('sel'));
        btn.classList.toggle('sel');
      }));
    });
    card.querySelector('.send').addEventListener('click', () => {
      card.querySelectorAll('.q').forEach((qn) => {
        const q = questions[qn.dataset.i];
        const picked = [...qn.querySelectorAll('.choice.sel')].map((b) => q.options[b.dataset.j].label);
        const other = qn.querySelector('.other').value.trim();
        if (other) picked.push(other);
        if (picked.length) answers[q.question] = picked.join(', ');
      });
      if (Object.keys(answers).length < questions.length) return alert('اختار إجابة لكل سؤال.');
      reply({allow: true, answers});
    });
    card.querySelector('.skip').addEventListener('click', () => reply({allow: false, message: 'صاحب الاستوديو تخطى السؤال؛ اختار الأنسب وقول اختارت إيه.'}));
  } else {
    const detail = entry.input?.command ?? entry.input?.file_path ?? JSON.stringify(entry.input, null, 1);
    card.innerHTML = `<h3>Claude محتاج موافقتك</h3><div>${esc(entry.description || entry.tool)}</div><pre>${esc(String(detail).slice(0, 3000))}</pre><div class="btns"><button type="button" class="primary yes">وافق</button>${entry.suggestions?.length ? '<button type="button" class="ghost always">وافق دايمًا على ده في المشروع</button>' : ''}<button type="button" class="danger no">ارفض</button></div>`;
    card.querySelector('.yes').addEventListener('click', () => reply({allow: true}));
    card.querySelector('.always')?.addEventListener('click', () => reply({allow: true, always: true}));
    card.querySelector('.no').addEventListener('click', () => reply({allow: false}));
  }
  box.append(card);
  scrollLog(true);
}

// ---------- notifications (only while the tab is in the background) ----------
function notify(before, after) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  let text = null;
  if (after.waiting && !before.waiting) text = 'Claude مستني ردك.';
  else if (after.done > (before.done ?? 0)) text = after.current === null ? 'الفيديو النهائي جاهز ✓' : `خلصت مرحلة: ${state.stages[after.done - 1]?.label ?? ''}`;
  else if (before.running && !after.running) text = 'Claude خلص ورد عليك.';
  if (text) new Notification(after.title, {body: text, tag: after.id});
}

// ---------- live events ----------
function connect() {
  const source = new EventSource('/api/events');
  const conn = $('#conn');
  source.onopen = () => { conn.textContent = 'متصل'; conn.className = 'conn on'; refreshState(); };
  source.onerror = () => { conn.textContent = 'الاتصال اتقطع — بيحاول تاني…'; conn.className = 'conn off'; };
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === 'project') {
      const before = state.projects.get(e.project.id);
      state.projects.set(e.project.id, {...before, ...e.project});
      if (before) notify(before, e.project);
      renderSide(); if (e.project.id === state.current) renderHead(); return;
    }
    if (e.type === 'raw') { api('/api/raw').then((d) => { state.raw = d.files; renderRaw(); }).catch(() => {}); return; }
    if (e.id !== state.current) return;
    if (e.type === 'item') upsertItem(e.item);
    else if (e.type === 'delta') delta(e.itemId, e.text);
    else if (e.type === 'activity') { state.project.activity = e.activity; renderHead(); }
    else if (e.type === 'links') { state.project.links = e.links; renderLinks(); }
    else if (e.type === 'permission') addApproval(e.entry);
    else if (e.type === 'permission-done') $(`.approval[data-req="${CSS.escape(e.requestId)}"]`)?.remove();
  };
}
async function refreshState() {
  const data = await api('/api/state');
  Object.assign(state, {stages: data.stages, styles: data.styles, raw: data.raw});
  state.projects = new Map(data.projects.map((p) => [p.id, p]));
  renderSide();
  if (!state.current) { if ($('.new-form') && !$('select[name=style] option:nth-child(2)')) route(); else renderRaw(); }
}

function route() {
  $('#side').classList.remove('open');
  const match = /^#p=([a-z0-9]+)$/.exec(location.hash);
  if (match) openProject(match[1]); else renderHome();
}
$('#new').addEventListener('click', () => { if (location.hash) location.hash = ''; else renderHome(); });
$('#files').addEventListener('click', () => { if (location.hash) location.hash = ''; else renderHome(); setTimeout(() => $('.rawlist')?.scrollIntoView({behavior: 'smooth'}), 50); });
$('#menu').addEventListener('click', () => $('#side').classList.toggle('open'));
window.addEventListener('hashchange', route);
setInterval(() => { if (state.project?.running) renderHead(); }, 1000);
if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), {once: true});
refreshState().then(route).catch((err) => { $('#main').innerHTML = `<p class="empty">${esc(err.message)}</p>`; });
connect();
