'use strict';
// Reel Studio dashboard client: projects, uploads, the chat with Claude, approvals and stage progress.
const $ = (sel, root = document) => root.querySelector(sel);
const H = {'x-dashboard': '1', 'content-type': 'application/json'};
const state = {stages: [], styles: [], projects: new Map(), raw: [], current: null, project: null, drafts: new Map(), tabs: new Map(), details: null, remote: null};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const size = (b) => b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0'); };
const LINK_LABEL = {editor: 'افتح المحرر', settings: 'افتح الإعدادات'};
// Opened through Tailscale (from a phone, say): local editor/settings links become their https addresses on the same name.
function publicUrl(url) {
  if (!state.remote) return url;
  try {
    const u = new URL(url);
    const match = Object.values(state.remote).find((r) => String(r.local) === u.port);
    return match ? match.url + u.pathname + u.search : url;
  } catch { return url; }
}

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
    .replace(/http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/[^\s"'<>)\]`]*/g, (url) => `<a href="${publicUrl(url)}" target="_blank" rel="noopener">${url.includes(':4380') ? 'افتح المحرر' : url.includes(':4381') ? 'افتح الإعدادات' : 'افتح الرابط'} ↗</a>`);
}

// ---------- sidebar ----------
function badge(p) {
  if (p.queued) return ['queue', 'في الطابور'];
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
    const kind = form.kind.value, graphics = kind === 'graphics', montage = kind === 'montage';
    $('.rec', form).hidden = graphics || montage;
    $('.mont', form).hidden = !montage;
    $('.style-field', form).hidden = montage;
    $('.pod', form).hidden = kind !== 'podcast';
    $('.rec-label', form).textContent = kind === 'podcast' ? 'الحلقة' : 'الفيديو (ممكن تختار أكتر من واحد)';
    $('.notes-label', form).innerHTML = graphics ? 'فكرة الموشن' : 'ملاحظاتك <span class="opt">اختياري</span>';
    renderPicks();
  };
  form.addEventListener('change', (e) => { if (e.target.name === 'kind') syncKind(); else if (e.target.name === 'pick') pickNote(); else if (e.target.name === 'mpick') montageNote(); });
  syncKind();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', form), error = $('.form-error', form);
    button.disabled = true; error.textContent = '';
    try {
      const montage = form.kind.value === 'montage';
      const rawFiles = [...form.querySelectorAll(montage ? 'input[name=mpick]:checked' : 'input[name=pick]:checked')].map((x) => x.value);
      const body = {kind: form.kind.value, rawFiles, clips: form.clips.value || null, style: montage ? '' : form.style.value, title: form.title.value, notes: form.notes.value};
      if (montage) Object.assign(body, {music: form.music.value, duration: form.duration.value, pace: form.pace.value});
      const data = await api('/api/projects', {method: 'POST', body: JSON.stringify(body)});
      for (const p of data.projects ?? [data.project]) state.projects.set(p.id, p);
      state.projects.set(data.project.id, data.project);
      location.hash = 'p=' + data.project.id;
    } catch (err) { error.textContent = err.message; button.disabled = false; }
  });
  renderRaw();
}
function renderRaw() {
  const list = $('.rawlist');
  if (!list) return;
  list.innerHTML = state.raw.length ? state.raw.map((f) => `<div class="row"><div class="top2"><span class="name">Raw/${esc(f.name)}</span><span><span class="size">${size(f.bytes)}</span> <button class="rawdel" data-name="${esc(f.name)}" title="امسح الملف">مسح</button></span></div></div>`).join('') : '<p class="dim">لسه مفيش ملفات.</p>';
  for (const b of list.querySelectorAll('.rawdel')) b.addEventListener('click', async () => {
    if (!confirm(`تمسح Raw/${b.dataset.name} من السيرفر؟ الملف ده هيتمسح نهائي.`)) return;
    try { await api('/api/raw?name=' + encodeURIComponent(b.dataset.name), {method: 'DELETE', body: '{}'}); } catch (err) { alert(err.message); }
  });
  renderPicks();
}
function renderPicks() {
  const form = $('.new-form'); if (!form) return;
  const box = $('.rec .picks', form), podcast = form.kind.value === 'podcast';
  const kept = new Set([...box.querySelectorAll('input:checked')].map((x) => x.value));
  const videos = state.raw.filter((f) => /\.(mp4|mov|m4v|mkv|webm|avi|mts|mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name));
  box.innerHTML = videos.length ? videos.map((f, i) => {
    const value = `Raw/${f.name}`, checked = kept.size ? kept.has(value) : i === 0;
    return `<label><input type="${podcast ? 'radio' : 'checkbox'}" name="pick" value="${esc(value)}" ${checked ? 'checked' : ''}> <span class="name">${esc(f.name)}</span> <span class="size">${size(f.bytes)}</span></label>`;
  }).join('') : '<span class="dim">ارفع فيديو الأول من فوق.</span>';
  pickNote();
  // The montage picks: one music file, and any number of videos and photos.
  const music = $('select[name=music]', form), keepMusic = music.value;
  const audio = state.raw.filter((f) => /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(f.name));
  music.innerHTML = audio.length ? audio.map((f) => `<option value="Raw/${esc(f.name)}">${esc(f.name)}</option>`).join('') : '<option value="">ارفع ملف موسيقى الأول (mp3 أو wav)</option>';
  if (keepMusic) music.value = keepMusic;
  const mbox = $('.mpicks', form), mkept = new Set([...mbox.querySelectorAll('input:checked')].map((x) => x.value));
  const visuals = state.raw.filter((f) => /\.(mp4|mov|m4v|mkv|webm|avi|mts|jpe?g|png|webp|gif|bmp|tiff?|heic)$/i.test(f.name));
  mbox.innerHTML = visuals.length ? visuals.map((f) => {
    const value = `Raw/${f.name}`, photo = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic)$/i.test(f.name);
    return `<label><input type="checkbox" name="mpick" value="${esc(value)}" ${mkept.size ? (mkept.has(value) ? 'checked' : '') : 'checked'}> <span>${photo ? '🖼️' : '🎬'}</span> <span class="name">${esc(f.name)}</span> <span class="size">${size(f.bytes)}</span></label>`;
  }).join('') : '<span class="dim">ارفع فيديوهات أو صور الأول من فوق.</span>';
  montageNote();
}
function montageNote() {
  const form = $('.new-form'); if (!form) return;
  const picked = [...form.querySelectorAll('input[name=mpick]:checked')].map((x) => x.value);
  const photos = picked.filter((v) => /\.(jpe?g|png|webp|gif|bmp|tiff?|heic)$/i.test(v)).length;
  $('.mpick-note', form).textContent = picked.length ? `${picked.length - photos} فيديو و${photos} صورة` : 'اختار فيديو أو صورة واحدة على الأقل';
}
function pickNote() {
  const form = $('.new-form'); if (!form) return;
  const n = form.querySelectorAll('input[name=pick]:checked').length;
  $('.pick-note', form).textContent = n > 1 ? `هيتعمل ${n} مشاريع، مشروع لكل فيديو، وهيشتغلوا ورا بعض في الطابور.` : '';
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
  state.current = id; state.details = null; renderSide();
  const main = $('#main');
  main.innerHTML = '<p class="empty">بحمّل المشروع…</p>';
  let data;
  try { data = await api('/api/projects/' + id); } catch (err) { main.innerHTML = `<p class="empty">${esc(err.message)}</p>`; return; }
  if (state.current !== id) return;
  state.project = data.project;
  main.replaceChildren($('#tpl-project').content.cloneNode(true));
  $('.ptitle').textContent = data.project.title;
  const where = data.project.kind === 'graphics' ? 'موشن من فكرة' : data.project.kind === 'montage' ? `مونتاج على ${data.project.rawFile} · ${data.project.media?.length ?? 0} ملف` : data.project.rawFile;
  $('.meta').textContent = `${where} · بدأ ${new Date(data.project.createdAt).toLocaleString('ar-EG')}`;
  const log = $('.log');
  for (const item of data.project.items) placeItem(log, itemNode(item));
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
  $('.start-now').addEventListener('click', () => api(`/api/projects/${id}/start`, {method: 'POST', body: '{}'}).catch((err) => alert(err.message)));
  $('.del').addEventListener('click', () => {
    const dialog = $('.del-dialog'); dialog.querySelector('form').reset(); dialog.showModal();
    dialog.onclose = async () => {
      if (dialog.returnValue !== 'ok') return;
      const f = dialog.querySelector('form');
      try { await api(`/api/projects/${id}`, {method: 'DELETE', body: JSON.stringify({studio: f.studio.checked, outputs: f.outputs.checked})}); }
      catch (err) { alert(err.message); }
    };
  });
  for (const button of document.querySelectorAll('.tabs button')) button.addEventListener('click', () => showTab(button.dataset.tab));
  showTab(state.tabs.get(id) ?? 'chat');
  loadDetails();
}

// ---------- tabs: plan, preview, editor, output ----------
const LAYOUTS = {takeover: 'شاشة كاملة', split: 'مقسومة', presenter: 'المتكلم'};
const PLATFORMS = {instagram: 'إنستجرام', tiktok: 'تيك توك', youtube: 'يوتيوب شورتس'};
const sec = (n) => n === null || n === undefined ? '—' : `${n} ث`;
const media = (p, download) => '/media/' + p.split('/').map(encodeURIComponent).join('/') + (download ? '?download=1' : '');

function showTab(tab) {
  if (!state.current) return;
  state.tabs.set(state.current, tab);
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const pane of document.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab;
  if (tab !== 'chat') renderTab(tab);
  if (tab === 'chat') scrollLog(true);
}

let detailsTimer = null;
async function loadDetails() {
  const id = state.current; if (!id) return;
  clearTimeout(detailsTimer);
  try {
    const data = await api(`/api/projects/${id}/details`);
    if (state.current !== id) return;
    state.details = data.details;
    if (state.project) { state.project.links = data.links; renderLinks(); }
    $('.psize') && ($('.psize').innerHTML = data.details.bytes ? `حجم المشروع على السيرفر: <span class="size">${size(data.details.bytes)}</span>` : '');
    const tab = state.tabs.get(id) ?? 'chat';
    if (tab !== 'chat') renderTab(tab, {keepPlayers: true});
    markTabs();
  } catch {}
}
function markTabs() {
  const d = state.details ?? {};
  const counts = {plan: d.plan || d.scenes?.length ? '✓' : '', preview: d.renders?.length || '', output: d.outputs?.length ? '✓' : '', editor: state.project?.links?.editor ? '●' : ''};
  for (const b of document.querySelectorAll('.tabs button')) {
    const n = counts[b.dataset.tab];
    b.querySelector('.n')?.remove();
    if (n) b.insertAdjacentHTML('beforeend', `<span class="n">${esc(n)}</span>`);
  }
}

function renderTab(tab, {keepPlayers = false} = {}) {
  const pane = document.querySelector(`[data-pane="${tab}"]`); if (!pane) return;
  // Do not rebuild a pane while a video in it is playing.
  if (keepPlayers && [...pane.querySelectorAll('video')].some((v) => !v.paused)) return;
  const d = state.details;
  if (!d) { pane.innerHTML = '<p class="empty">بحمّل…</p>'; return; }
  if (tab === 'plan') pane.innerHTML = planHtml(d);
  if (tab === 'preview') pane.innerHTML = previewHtml(d);
  if (tab === 'editor') pane.innerHTML = editorHtml();
  if (tab === 'output') pane.innerHTML = outputHtml(d);
  wireTab(pane);
}

function noProject(text) { return `<p class="empty">${esc(text)}</p>`; }

function planHtml(d) {
  if (!d.slug) return noProject('Claude لسه ما بدأش المشروع. الخطة هتظهر هنا أول ما يكتبها.');
  let html = '';
  const facts = [d.style && `الستايل: ${state.styles.find((x) => x.id === d.style)?.label ?? d.style}`, d.durationSec && `المدة: ${d.durationSec} ث`, d.contentMode === 'graphics' ? 'موشن من غير تسجيل' : null, d.captionsStatus && `الكابشن: ${d.captionsStatus === 'reviewed' ? 'متراجع' : 'مسودة'}`].filter(Boolean);
  if (facts.length) html += `<div class="facts">${facts.map((f) => `<span class="fact" dir="auto">${esc(f)}</span>`).join('')}</div>`;
  if (d.scenes?.length) html += `<div class="sec"><h3>المشاهد بالترتيب</h3><div class="tablewrap"><table><thead><tr><th>#</th><th>المشهد</th><th>النوع</th><th>الشكل</th><th>من</th><th>لحد</th></tr></thead><tbody>${d.scenes.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.title ?? s.id)}</td><td><code>${esc(s.family)}</code></td><td>${esc(LAYOUTS[s.layout] ?? s.layout)}</td><td>${sec(s.from)}</td><td>${sec(s.to)}</td></tr>`).join('')}</tbody></table></div></div>`;
  if (d.cuts) html += `<div class="sec"><h3>القطعات</h3><p class="dim">التسجيل ${sec(d.cuts.sourceSeconds)} ← بعد القص ${sec(d.cuts.editSeconds)}</p><div class="tablewrap"><table><thead><tr><th>اللي هيتشال من التسجيل</th></tr></thead><tbody>${d.cuts.removed.length ? d.cuts.removed.map((c) => `<tr><td>من ${sec(c.from)} لحد ${sec(c.to)}</td></tr>`).join('') : '<tr><td>مفيش قص</td></tr>'}</tbody></table></div></div>`;
  // The studio writes its editorial plan in English; the scene table above is the creator's view, the full plan stays one click away.
  if (d.plan) html += d.scenes?.length ? `<details class="full"><summary>الخطة التفصيلية زي ما Claude كتبها</summary><div class="md">${markdown(d.plan)}</div></details>` : `<div class="sec md">${markdown(d.plan)}</div>`;
  if (!html) return noProject('الخطة لسه ما اتكتبتش.');
  html += `<div class="cta-row"><button class="primary" data-say="موافق على الخطة، كمّل.">موافق، كمّل</button><textarea class="plan-edit" rows="2" placeholder="عايز تعدّل إيه في الخطة؟"></textarea><button class="ghost" data-say-from=".plan-edit" data-prefix="عدّل الخطة: ">ابعت التعديل</button></div>`;
  return html;
}

function qcHtml(qc) {
  if (!qc) return '';
  const facts = [qc.width && `${qc.width}×${qc.height}`, qc.fps && `${qc.fps} fps`, qc.durationSec && `${Math.round(qc.durationSec * 10) / 10} s`, qc.sizeMB && `${qc.sizeMB} MB`, qc.lufs !== null && qc.lufs !== undefined && `${qc.lufs} LUFS`, qc.renderSeconds && `render ${qc.renderSeconds} s`].filter(Boolean);
  return `<div class="facts">${facts.map((f) => `<span class="fact">${esc(f)}</span>`).join('')}</div>` + (qc.checks?.length ? `<ul class="checks">${qc.checks.map((c) => `<li class="${c.state}">${esc(c.label)}${c.note ? ` <span class="dim">(${esc(c.note)})</span>` : ''}</li>`).join('')}</ul>` : '');
}

const clipHtml = (d, render) => d.clips?.length ? d.clips.map((c) => `<div class="clip"><h3>كليب: <span class="name">${esc(c.slug.split('--').slice(1).join('--') || c.slug)}</span></h3>${render(c)}</div>`).join('') : '';
function previewHtml(d) {
  if (d.clips?.length) return clipHtml(d, (c) => c.renders?.length ? previewHtml({...c, clips: []}) : '<p class="dim">لسه مفيش بريفيو للكليب ده.</p>');
  if (!d.renders?.length) return noProject(state.project?.render ? 'البريفيو بيترندر دلوقتي… هيظهر هنا أول ما يخلص.' : 'لسه مفيش بريفيو. لما Claude يرندر نسخة معاينة هتظهر هنا.');
  let html = d.renders.map((r) => `<div class="vid"><video controls preload="metadata" playsinline src="${media(r.path)}"></video><div><h3>${r.name.includes('delivery') ? 'نسخة التسليم' : 'نسخة معاينة'}</h3><p class="dim">${new Date(r.modified).toLocaleString('ar-EG')}</p>${qcHtml(r.qc)}<div class="downloads"><a href="${media(r.path, true)}">تحميل ⬇</a></div></div></div>`).join('');
  if (d.stills?.length) html += `<div class="sec"><h3>لقطات المراجعة</h3><div class="stills">${d.stills.map((s) => `<a href="${media(s.path)}" target="_blank"><img loading="lazy" src="${media(s.path)}" alt=""></a>`).join('')}</div></div>`;
  html += `<div class="cta-row"><textarea class="prev-edit" rows="2" placeholder="ملاحظاتك على البريفيو…"></textarea><button class="primary" data-say-from=".prev-edit" data-prefix="ملاحظاتي على البريفيو: ">ابعت لـ Claude</button><button class="ghost" data-say="البريفيو تمام، جهّز النسخة النهائية للتسليم.">تمام، جهّز النهائي</button></div>`;
  return html;
}

function editorHtml() {
  const url = state.project?.links?.editor && publicUrl(state.project.links.editor);
  if (!url) return `<p class="empty">المحرر مش شغال دلوقتي.</p><div class="cta-row" style="justify-content:center"><button class="primary" data-say="افتح المحرر الحي على بورت 4380.">اطلب من Claude يفتح المحرر</button></div>`;
  return `<div class="cta-row" style="margin:0 0 10px"><a class="primary" style="text-decoration:none" href="${esc(url)}" target="_blank" rel="noopener">افتح المحرر في صفحة لوحده ↗</a><span class="dim">لو المحرر ما ظهرش تحت، اتأكد إن البورت 4380 موجود في أمر SSH.</span></div><iframe class="editor" src="${esc(url)}" title="المحرر"></iframe>`;
}

function outputHtml(d) {
  if (d.clips?.length) return clipHtml(d, (c) => c.outputs?.length || c.publish?.length ? outputHtml({...c, clips: []}) : '<p class="dim">لسه ما اتسلّمش.</p>');
  if (!d.outputs?.length && !d.publish?.length) return noProject(state.project?.render?.mode === 'deliver' ? 'النسخة النهائية بتترندر دلوقتي…' : 'لسه مفيش مخرج نهائي. لما Claude يسلّم الفيديو هيظهر هنا.');
  const video = d.outputs.find((f) => /\.(mp4|mov)$/i.test(f.name));
  const cover = d.outputs.find((f) => /\.(jpe?g|png)$/i.test(f.name));
  let html = '';
  if (video) html += `<div class="vid"><video controls preload="metadata" playsinline ${cover ? `poster="${media(cover.path)}"` : ''} src="${media(video.path)}"></video><div><h3>الفيديو النهائي</h3><p class="dim"><span class="name">${esc(video.path)}</span></p>${qcHtml(video.qc)}</div></div>`;
  if (d.outputs.length) html += `<div class="downloads">${d.outputs.map((f) => `<a href="${media(f.path, true)}">${/\.srt$/i.test(f.name) ? 'الكابشن SRT' : /\.(jpe?g|png)$/i.test(f.name) ? 'صورة الغلاف' : 'الفيديو'} ⬇ <span class="size">${size(f.bytes)}</span></a>`).join('')}</div>`;
  if (d.publish?.length) html += `<div class="sec"><h3>وصف البوست</h3>${d.publish.map((p, i) => `<div class="copybox"><div class="hd"><b>${esc(PLATFORMS[p.platform] ?? p.platform)}</b><button class="ghost" data-copy="${i}">انسخ</button></div><pre dir="auto">${esc(p.text)}</pre>${p.pinnedComment ? `<p class="dim">تعليق مثبّت: ${esc(p.pinnedComment)}</p>` : ''}${p.altText ? `<p class="dim">النص البديل: ${esc(p.altText)}</p>` : ''}</div>`).join('')}</div>`;
  else if (video) html += `<div class="cta-row"><button class="ghost" data-say="اكتبلي وصف البوست للفيديو النهائي.">اطلب وصف البوست</button></div>`;
  if (d.qcReport) html += `<div class="sec md"><h3>تقرير الجودة</h3>${markdown(d.qcReport)}</div>`;
  return html;
}

function wireTab(pane) {
  const say = async (text, button) => {
    if (!text.trim()) return;
    button.disabled = true;
    try { await api(`/api/projects/${state.current}/messages`, {method: 'POST', body: JSON.stringify({text})}); showTab('chat'); }
    catch (err) { alert(err.message); }
    button.disabled = false;
  };
  for (const b of pane.querySelectorAll('[data-say]')) b.addEventListener('click', () => say(b.dataset.say, b));
  for (const b of pane.querySelectorAll('[data-say-from]')) b.addEventListener('click', () => { const box = pane.querySelector(b.dataset.sayFrom); if (box.value.trim()) say(b.dataset.prefix + box.value.trim(), b); });
  for (const b of pane.querySelectorAll('[data-copy]')) b.addEventListener('click', async () => {
    const text = b.closest('.copybox').querySelector('pre').textContent;
    try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
    b.textContent = 'اتنسخ ✓'; setTimeout(() => { b.textContent = 'انسخ'; }, 1500);
  });
}

// Small Markdown reader for the plan and reports: headings, tables, lists, paragraphs; everything escaped first.
function markdown(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th dir="auto">${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td dir="auto">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${Math.min(4, h[1].length + 1)} dir="auto">${inline(h[2])}</h${Math.min(4, h[1].length + 1)}>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(`<li dir="auto">${inline(lines[i++].replace(/^\s*[-*]\s+/, ''))}</li>`); out.push(`<ul>${items.join('')}</ul>`); continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(`<li dir="auto">${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))}</li>`); out.push(`<ol>${items.join('')}</ol>`); continue; }
    if (!line.trim()) { i++; continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#|\s*\||\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(inline(lines[i++]));
    out.push(`<p dir="auto">${para.join('<br>')}</p>`);
  }
  return out.join('');
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
// Claude's working steps (tool calls and approve/deny notes) fold into one quiet line between messages.
const isStep = (node) => node.dataset.role === 'tool' || node.dataset.role === 'decision';
function placeItem(log, node) {
  if (!isStep(node)) { log.append(node); return; }
  let group = log.lastElementChild;
  if (!group?.classList.contains('steps')) {
    group = document.createElement('details');
    group.className = 'steps';
    group.innerHTML = '<summary></summary><div class="steps-list"></div>';
    log.append(group);
  }
  group.querySelector('.steps-list').append(node);
  summarizeSteps(group);
}
function summarizeSteps(group) {
  const steps = [...group.querySelectorAll('.tool')];
  const running = steps.find((n) => n.classList.contains('running'));
  const last = running ?? steps.at(-1);
  const failed = steps.filter((n) => n.classList.contains('error')).length;
  group.querySelector('summary').innerHTML = `<span class="steps-count">${running ? '<span class="spin"></span>' : '⚙'} Claude عمل ${steps.length} ${steps.length === 1 ? 'خطوة' : 'خطوات'}${failed ? ` <span class="steps-fail">· ${failed} ما نفعتش</span>` : ''}</span>${last ? `<span class="steps-last">${esc(last.querySelector('.txt')?.textContent ?? '')}</span>` : ''}`;
}
function upsertItem(item) {
  const log = $('.log'); if (!log) return;
  $('.empty', log)?.remove();
  const old = log.querySelector(`[data-id="${CSS.escape(item.id)}"][data-role="${item.role}"]`);
  const node = itemNode(item);
  if (old) { old.replaceWith(node); const group = node.closest('.steps'); if (group) summarizeSteps(group); }
  else placeItem(log, node);
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
  Object.assign(p, {running: summary.running, waiting: summary.waiting, queued: summary.queued, percent: summary.percent, current: summary.current, stages: summary.stages ?? p.stages});
  $('.queued-box').hidden = !p.queued;
  const [cls, label] = badge(p);
  const b = $('.badge'); b.className = 'badge ' + cls; b.textContent = label;
  let previous = Date.parse(p.createdAt);
  // A music montage has no speech: its second and third stages are the beat analysis and the cut plan.
  const labels = p.kind === 'montage' ? {upload: 'رفع الملفات', transcript: 'تحليل الإيقاع', plan: 'خطة القطعات', draft: 'اختيار اللقطات'} : {};
  $('.stages').innerHTML = state.stages.map((s) => {
    const at = p.stages?.[s.id];
    let note = '';
    if (at) { const t = Date.parse(at); note = `خلص بعد ${clock(t - previous)}`; previous = t; }
    else if (s.id === p.current) note = p.running ? `شغالين عليها من ${clock(Date.now() - previous)}` : 'الخطوة الجاية';
    return `<li class="${at ? 'ok' : s.id === p.current ? 'now' : ''}"><b>${esc(labels[s.id] ?? s.label)}</b>${esc(note)}</li>`;
  }).join('');
  $('.bar i').style.width = (p.percent ?? 0) + '%';
  const activity = $('.activity');
  if (p.waiting) activity.innerHTML = '<span style="color:var(--warn)">⏸ Claude مستني ردك تحت.</span>';
  else if (p.running) activity.innerHTML = `<span class="spin"></span>${esc(p.activity?.text || 'Claude بيفكّر…')} <span class="dim">· ${clock(Date.now() - Date.parse(p.activity?.since ?? p.updatedAt))}</span>`;
  else activity.innerHTML = p.current === null ? '<span style="color:var(--ok)">✓ الفيديو النهائي جاهز في Outputs.</span>' : '<span class="dim">Claude مستني رسالتك.</span>';
  $('.stop').hidden = !p.running;
  const r = summary.render, box = $('.render');
  box.hidden = !r;
  if (r) {
    const what = r.mode === 'deliver' ? 'النسخة النهائية' : r.mode === 'review' ? 'نسخة المراجعة' : 'البريفيو';
    const phase = {frames: r.chunks ? `جزء ${r.chunks.done} من ${r.chunks.total}` : 'الفريمات', audio: 'الصوت', finalize: 'التجهيز الأخير'}[r.phase] ?? '';
    $('.render-line').innerHTML = `🎬 بيرندر ${what}: <b>${r.percent}%</b> <span class="dim">· ${esc(phase)}${r.fps ? ` · ${r.fps} fps` : ''} · فات ${clock(Date.now() - Date.parse(r.startedAt))}${r.remainingMs !== null ? ` · باقي حوالي ${clock(r.remainingMs)}` : ''}</span>`;
    $('.render .bar i').style.width = r.percent + '%';
  }
}
function renderLinks() {
  const p = state.project; if (!p || !$('.links')) return;
  $('.links').innerHTML = Object.entries(p.links ?? {}).map(([kind, url]) => `<a href="${esc(publicUrl(url))}" target="_blank" rel="noopener">${esc(LINK_LABEL[kind] ?? 'افتح ' + kind)} ↗</a>`).join('');
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
    if (e.type === 'removed') { state.projects.delete(e.id); renderSide(); if (e.id === state.current) location.hash = ''; return; }
    if (e.type === 'raw') { api('/api/raw').then((d) => { state.raw = d.files; renderRaw(); }).catch(() => {}); return; }
    if (e.id !== state.current) return;
    if (e.type === 'item') upsertItem(e.item);
    else if (e.type === 'delta') delta(e.itemId, e.text);
    else if (e.type === 'activity') { state.project.activity = e.activity; renderHead(); }
    else if (e.type === 'links') { state.project.links = e.links; renderLinks(); markTabs(); if ((state.tabs.get(state.current) ?? 'chat') === 'editor') renderTab('editor'); }
    else if (e.type === 'details') loadDetails();
    else if (e.type === 'permission') addApproval(e.entry);
    else if (e.type === 'permission-done') $(`.approval[data-req="${CSS.escape(e.requestId)}"]`)?.remove();
  };
}
async function refreshState() {
  const data = await api('/api/state');
  Object.assign(state, {stages: data.stages, styles: data.styles, raw: data.raw, remote: data.remote});
  $('#disk').innerHTML = data.disk ? `فاضي <span class="size">${size(data.disk.free)}</span> من <span class="size">${size(data.disk.total)}</span><div class="meter"><i style="width:${Math.round((1 - data.disk.free / data.disk.total) * 100)}%"></i></div>` : '';
  $('#logout').hidden = !data.password;
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
$('#settings').addEventListener('click', async () => {
  const w = window.open('', '_blank');
  try { const data = await api('/api/settings', {method: 'POST', body: '{}'}); w.opener = null; w.location = publicUrl(data.url); }
  catch (err) { w.close(); alert(err.message); }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', {method: 'POST', body: '{}'}).catch(() => {}); location.reload(); });
window.addEventListener('hashchange', route);
setInterval(() => { if (state.project?.running) renderHead(); }, 1000);
if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), {once: true});
refreshState().then(route).catch((err) => { $('#main').innerHTML = `<p class="empty">${esc(err.message)}</p>`; });
connect();
