const token = new URLSearchParams(location.search).get('token');
const content = document.querySelector('#content');
const actions = document.querySelector('#actions');
const errorBox = document.querySelector('#error');
const steps = ['بياناتك', 'ستايل الفيديو', 'الكلام على الفيديو', 'الخطوط والأرقام', 'وصف المنشور', 'الألوان والنهاية', 'راجع واحفظ'];
const labels = {
  captionsGrouping: {compact: 'كلمات قصيرة', clauses: 'جُمل هادية', single: 'كلمة في كل مرة'},
  captionsPresentation: {pill: 'كبسولة واضحة', minimal: 'كلام من غير خلفية', 'ink-strip': 'شريط غامق'},
  captionsSkin: {'spoken-box': 'صندوق الكلمة المنطوقة', karaoke: 'كاريوكي', 'bold-outline': 'حدود عريضة', 'soft-shadow': 'ظل ناعم', 'paper-tag': 'قصاصة ورق'},
  font: {Cairo: 'Cairo', Tajawal: 'Tajawal', 'Noto Naskh Arabic': 'نسخ عربي', 'Plex Display': 'Plex Display', 'Grid Sans': 'Grid Sans', 'Noto Kufi Arabic': 'كوفي', 'Readex Pro': 'Readex', 'El Messiri': 'المسيري', Lalezar: 'لالزار', 'Aref Ruqaa': 'عارف رقعة', 'Aref Ruqaa Ink': 'عارف رقعة حبر', 'Reem Kufi': 'ريم كوفي', Amiri: 'أميري', Alexandria: 'الإسكندرية', Marhey: 'مرحي', Almarai: 'المراعي'},
  writingStyle: {short: 'مختصر ومباشر', educational: 'شرح ونقط عملية', storytelling: 'حكاية قصيرة'},
};
const sampleWriting = {
  short: 'فكرتك تستاهل تتشاف.\nرتّب الكلام، وضّح الفكرة، وسيب الصورة تساعدك.',
  educational: 'إزاي تخلي فكرتك أوضح؟\n• ابدأ بالنقطة اللي تهم جمهورك.\n• قسّم الشرح لخطوات بسيطة.\n• استخدم صورة توضح كل خطوة.',
  storytelling: 'كانت الفكرة واضحة في دماغي، بس الفيديو كان مزدحم.\nلما قسّمت الشرح، واستخدمت صورة لكل نقطة، بقى الكلام أسهل يتفهم.\nكل فكرة محتاجة مساحة.',
};
// The three digit states. tests/settings-arabic.test.mjs pins these strings to DIGIT_LABELS_AR in preference-options.ts.
const digitLabels = {auto: 'كما هو', latin: '1 2 3', 'arabic-indic': '١ ٢ ٣'};
const digitSamples = {auto: 'كل مشهد كما كان', latin: '3 خطوات · 2025', 'arabic-indic': '٣ خطوات · ٢٠٢٥'};
let catalog, draft, etag, existing = false, dirty = false, busy = false, step = 0, setup, pollTimer;

function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== null && text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function button(text, className, click, attrs = {}) {
  const node = el('button', text, {type: 'button', class: className, ...attrs});
  node.addEventListener('click', click); return node;
}
function showError(message) {errorBox.textContent = message; errorBox.hidden = !message;}
function changed() {dirty = true; document.querySelector('#save-state').textContent = 'فيه اختيارات لسه ما اتحفظتش';}
async function api(route, {method = 'GET', body} = {}) {
  const response = await fetch(`/api/${route}`, {method, headers: {'x-reel-studio-token': token, ...(body ? {'content-type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error ?? 'حصلت مشكلة. جرّب تاني.');
  return data;
}
const title = (heading, description) => {content.append(el('h2', heading, {id: 'page-title', tabindex: '-1'}), el('p', description, {class: 'lead'}));};
const note = text => el('p', text, {class: 'note'});
const prefLabel = (key, value) => key === 'style' ? catalog.styles[value]?.label : labels[key]?.[value] ?? value;

function setPref(key, mode, value, focusId) {
  draft.preferences[key] = {mode, value: mode === 'auto' ? null : value}; changed(); render();
  if (focusId) document.getElementById(focusId)?.focus();
}
function modeChoice(key) {
  const box = el('div', null, {class: 'mode', role: 'group', 'aria-label': key === 'palette' ? 'اختيار الألوان' : 'تلقائي أو ثابت'});
  for (const [mode, text] of [['auto', 'تلقائي حسب كل فيديو'], ['fixed', 'اختار بنفسي وثبّت']]) {
    const id = `mode-${key}-${mode}`;
    const label = el('label', null, {for: id});
    const input = el('input', null, {id, type: 'radio', name: `mode-${key}`, value: mode});
    input.checked = draft.preferences[key].mode === mode;
    input.addEventListener('change', () => setPref(key, mode, draft.preferences[key].value ?? catalog.choices[key][0], id));
    label.append(input, el('span', text)); box.append(label);
  }
  return box;
}
function pills(key) {
  const row = el('div', null, {class: 'radio-options', role: 'group', 'aria-label': key === 'writingStyle' ? 'طريقة وصف المنشور' : 'اختيارات الكابشن'});
  for (const value of catalog.choices[key]) {
    const id = `choice-${key}-${value}`;
    row.append(button(prefLabel(key, value), 'option-pill', () => setPref(key, 'fixed', value, id), {id, 'aria-pressed': String(draft.preferences[key].mode === 'fixed' && draft.preferences[key].value === value)}));
  }
  return row;
}
function setDigits(value, focusId) {
  if (value === 'auto') delete draft.preferences.digits; else draft.preferences.digits = {mode: 'fixed', value};
  changed(); render(); document.getElementById(focusId)?.focus();
}
function digitsSection() {
  const current = draft.preferences.digits ?? {mode: 'auto', value: null};
  const state = current.mode === 'fixed' ? current.value : 'auto';
  const row = el('div', null, {class: 'radio-options', role: 'group', 'aria-label': 'شكل الأرقام'});
  for (const value of ['auto', ...catalog.choices.digits]) {
    const id = `digits-${value}`;
    row.append(button(digitLabels[value], 'option-pill', () => setDigits(value, id), {id, 'aria-pressed': String(state === value)}));
  }
  const sample = el('p', digitSamples[state], {class: 'sample-note'});
  sample.style.fontFamily = `"${draft.preferences.font.value ?? 'Cairo'}"`; sample.style.fontSize = '22px'; sample.style.color = 'var(--ink)';
  return [el('h3', 'شكل الأرقام على الشاشة', {class: 'section-title'}), row, sample,
    note('هذا الاختيار يغيّر شكل الأرقام على الشاشة وفي الكابشن أيضًا. «كما هو» يترك كل مشهد كما كان.')];
}
function setCaptionSkin(value, focusId) {
  if (value === 'auto') delete draft.preferences.captionsSkin; else draft.preferences.captionsSkin = {mode: 'fixed', value};
  changed(); render(); document.getElementById(focusId)?.focus();
}
function captionSkinsSection() {
  const current = draft.preferences.captionsSkin;
  const state = current?.mode === 'fixed' ? current.value : 'auto';
  const row = el('div', null, {class: 'radio-options', role: 'group', 'aria-label': 'سكين الكابشن'});
  for (const value of ['auto', ...catalog.choices.captionsSkin]) {
    const id = `caption-skin-${value}`;
    row.append(button(value === 'auto' ? 'الشكل الأساسي' : prefLabel('captionsSkin', value), 'option-pill', () => setCaptionSkin(value, id), {id, 'aria-pressed': String(state === value)}));
  }
  return [el('h3', 'سكين الكابشن', {class: 'section-title'}), row,
    note('السكين يحدد رسم الكابشن بدل الشكل الأساسي. «الشكل الأساسي» يرجع لاختيارك أعلاه.')];
}
function field(labelText, key, value, callback, {hint, max = 80, dir} = {}) {
  const label = el('label', null, {class: 'field', for: key}); label.append(el('span', labelText));
  const input = el('input', null, {id: key, type: 'text', maxlength: max, ...(dir ? {dir} : {})}); input.value = value ?? '';
  input.addEventListener('input', () => {callback(input.value.trim()); changed();}); label.append(input);
  if (hint) label.append(el('span', hint, {class: 'hint'}));
  return label;
}
function validate({identityOnly = false} = {}) {
  if (!draft.name.trim()) return 'اكتب اسمك أو اسم البراند الأول.';
  if (draft.handle && !/^@[A-Za-z0-9_.]{1,30}$/.test(draft.handle)) return 'اليوزر يبدأ بـ @ وبعده حروف إنجليزي أو أرقام أو _ أو نقطة.';
  if (!draft.platforms.length) return 'اختار منصة واحدة على الأقل.';
  if (identityOnly) return null;
  if (draft.ending.followCard && !draft.handle) return 'كارت المتابعة محتاج اليوزر بتاعك.';
  for (const [key, value] of Object.entries(draft.brand)) if (value !== null && !/^#[0-9a-f]{6}$/i.test(value)) return `راجع لون ${key}. اكتبه بالشكل #RRGGBB.`;
  return null;
}
function go(index) {
  if (busy) return;
  if (index > step && step === 0 && validate({identityOnly: true})) {showError(validate({identityOnly: true})); return;}
  step = index; showError(''); render(); document.querySelector('#page-title')?.focus(); window.scrollTo({top: 0});
}
function identity() {
  title(existing ? 'أهلًا تاني. ظبّط أسلوبك.' : 'أهلًا بيك في Reel Studio.', 'ظبّط ذوقك مرة واحدة، والمساعد يستخدمه في فيديوهاتك الجاية. تقدر تثبّت كل اختيار أو تسيبه تلقائي حسب المحتوى.');
  const visual = el('div', null, {class: 'intro-visual'});
  const reel = el('div', null, {class: 'mini-reel', 'aria-hidden': 'true'}); for (let i = 0; i < 3; i++) reel.append(el('span'));
  const copy = el('div'); copy.append(el('strong', 'اختياراتك هي نقطة البداية.'), el('p', 'عايز حاجة مختلفة لفيديو واحد؟ قول للمساعد، وإعداداتك الأساسية تفضل زي ما هي.')); visual.append(reel, copy); content.append(visual);
  const grid = el('div', null, {class: 'form-grid'});
  grid.append(field('اسمك أو اسم البراند', 'name', draft.name, value => draft.name = value, {hint: 'الاسم اللي تحب يظهر في كروت الفيديو.'}),
    field('اليوزر بتاعك — اختياري', 'handle', draft.handle, value => {draft.handle = value || null;}, {max: 31, dir: 'ltr', hint: 'زي @yourname. سيبه فاضي لو مش محتاج كارت متابعة.'}));
  const platformBox = el('div', null, {class: 'wide'}); platformBox.append(el('h3', 'بتنشر فين؟', {class: 'section-title'}));
  const platforms = el('div', null, {class: 'platforms'});
  for (const [id, labelText] of [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube Shorts']]) {
    const label = el('label'); const input = el('input', null, {type: 'checkbox', id}); input.checked = draft.platforms.includes(id);
    input.addEventListener('change', () => {draft.platforms = input.checked ? [...draft.platforms, id] : draft.platforms.filter(p => p !== id); changed();}); label.append(input, el('span', labelText, {dir: 'ltr'})); platforms.append(label);
  }
  platformBox.append(platforms, note('هتستلم وصف منشور منفصل لكل منصة بتختارها.')); grid.append(platformBox); content.append(grid);
}
function stylePage() {
  title('تحب فيديوهاتك تبقى عاملة إزاي؟', 'اختار شكل تحبه، أو سيب الاستوديو يرشّح المناسب حسب فكرة كل فيديو.');
  content.append(modeChoice('style'));
  const grid = el('div', null, {class: 'choice-grid'});
  for (const id of catalog.choices.style) {
    const selected = draft.preferences.style.mode === 'fixed' && draft.preferences.style.value === id;
    const card = button('', 'choice-card', () => setPref('style', 'fixed', id, `style-${id}`), {id: `style-${id}`, 'aria-pressed': String(selected)});
    const art = el('div', null, {class: `illustration ${id}`, 'aria-hidden': 'true'});
    art.append(el('span', 'فكرة تستاهل تتشاف'), el('b', id === 'calligraphic-receipts' ? 'الدليل في التفاصيل' : id === 'section-deck' ? '١. ابدأ بالفكرة' : 'خلّي فكرتك واضحة'));
    const bars = el('div', null, {class: 'bars'}); for (let i = 0; i < 3; i++) bars.append(el('i')); art.append(bars);
    const copy = el('div', null, {class: 'card-copy'}); copy.append(el('strong', catalog.styles[id].label), el('small', catalog.styles[id].description)); card.append(art, copy);
    if (selected) card.append(el('span', '✓', {class: 'selected', 'aria-hidden': 'true'})); grid.append(card);
  }
  content.append(grid, el('p', 'دي رسومات توضيحية للستايلات. المونتاج النهائي بيتصمم على محتوى فيديوك.', {class: 'sample-note'}), note('الاختيار التلقائي يبدأ بالستايلين الأساسيين، ويضيف الستايلات الجديدة لما مشاهد فيديوك تناسبها. تقدر تختار أي ستايل بنفسك.'));
  content.append(looksPreview());
}
// Four whole-video looks, drawn with CSS only. They are illustrations: a look is chosen for one video (editor tab «المظهر» or a request to the assistant) and is never saved here.
const lookCards = [
  ['riso', 'طباعة ريزو', 'حبران وحبيبات وورق دافئ، كأن الفيديو مطبوع.'],
  ['blueprint', 'مخطط هندسي', 'ورق أزرق وخطوط بيضاء وشبكة، كأنه رسم تقني.'],
  ['film', 'حبيبات فيلم', 'حبيبات خفيفة تتحرك وتعتيم لطيف على الأطراف، كأنه شريط سينمائي.'],
  ['paper', 'ورق مطبوع', 'ملمس ورق دافئ فوق الصورة، كأن الفيديو مطبوع على ورقة.'],
];
function looksPreview() {
  const box = el('div', null, {class: 'look-previews'});
  box.append(el('h3', 'تأثير اختياري على الفيديو كله', {class: 'section-title'}));
  const row = el('div', null, {class: 'look-grid'});
  for (const [id, label, description] of lookCards) {
    const card = el('div', null, {class: 'look-card'});
    const art = el('div', null, {class: `look-art ${id}`, 'aria-hidden': 'true'});
    art.append(el('b', 'فكرة واضحة'), el('i'));
    const copy = el('div', null, {class: 'card-copy'});
    copy.append(el('strong', label), el('small', description));
    card.append(art, copy); row.append(card);
  }
  box.append(row, note('هذا شكل توضيحي. تختار التأثير لفيديو واحد من تبويب «المظهر» في المحرر أو بطلبك من المساعد، ولا يُحفظ ضمن إعداداتك. الكابشن يبقى فوق التأثير وواضحًا.'));
  return box;
}
function captionsPage() {
  title('الكلام اللي بيظهر مع صوتك.', 'شكل وترتيب الكلام على الفيديو. الكلام المسجّل نفسه بيتحافظ عليه.');
  content.append(el('h3', 'كم كلمة تظهر مع بعض؟', {class: 'section-title'}), modeChoice('captionsGrouping'), pills('captionsGrouping'),
    el('h3', 'وشكلها يبقى إيه؟', {class: 'section-title'}), modeChoice('captionsPresentation'), pills('captionsPresentation'));
  const sample = el('div', null, {class: 'caption-preview', 'aria-label': 'مثال توضيحي للكابشن'});
  content.append(...captionSkinsSection());
  const grouping = draft.preferences.captionsGrouping.value ?? 'compact'; const presentation = draft.preferences.captionsPresentation.value ?? 'pill';
  const text = grouping === 'single' ? 'فكرتك' : grouping === 'clauses' ? 'فكرتك تستاهل تتشاف بوضوح' : 'فكرتك تستاهل تتشاف';
  const skin = draft.preferences.captionsSkin?.mode === 'fixed' ? draft.preferences.captionsSkin.value : null;
  const caption = el('span', skin ? null : text, {class: `caption-sample ${skin ?? presentation}`});
  if (skin) text.split(' ').forEach((word, index) => {
    if (index) caption.append(document.createTextNode(' '));
    caption.append(el('span', word, {class: index === 0 ? 'spoken' : ''}));
  });
  caption.style.fontFamily = draft.preferences.font.value ?? 'Cairo'; sample.append(caption);
  content.append(sample, el('p', 'مثال توضيحي. التوقيت بيتظبط على صوتك، والاختيار التلقائي بيتغيّر حسب الفيديو.', {class: 'sample-note'}));
}
function fontsPage() {
  title('اختار الخط اللي يشبهك.', 'كل الخطوط دي بتدعم العربي وبتتنزّل مع الاستوديو. اختيارك بيتطبق على عناوين الفيديو والكابشن.'); content.append(modeChoice('font'));
  const grid = el('div', null, {class: 'choice-grid font-grid'});
  for (const family of catalog.choices.font) {
    const selected = draft.preferences.font.mode === 'fixed' && draft.preferences.font.value === family;
    const id = `font-${family.replaceAll(' ', '-')}`;
    const card = button('', 'choice-card', () => setPref('font', 'fixed', family, id), {id, 'aria-pressed': String(selected)});
    const ready = catalog.readyFonts.includes(family); const sample = el('div', ready ? 'فكرتك تستاهل تتشاف' : 'الخط لسه بيتجهّز', {class: 'font-sample'});
    if (ready) sample.style.fontFamily = `"${family}"`;
    if (ready && family === 'Grid Sans') sample.textContent += ' · Your idea';
    const copy = el('div', null, {class: 'card-copy'}); copy.append(el('strong', labels.font[family] ?? family), el('small', ready ? 'معاينة بالخط الحقيقي على جهازك' : 'اختاره دلوقتي، والمعاينة تظهر بعد تنزيل الخطوط.', {class: ready ? '' : 'waiting'})); card.append(sample, copy);
    if (selected) card.append(el('span', '✓', {class: 'selected', 'aria-hidden': 'true'})); grid.append(card);
  }
  content.append(grid, note('التلقائي بيختار خط مناسب للستايل. لو ثبّتّ خط، هيفضل هو الأساس لكل فيديو.'), ...digitsSection());
}
function writingPage() {
  title('ووصف المنشور يتكتب إزاي؟', 'ده الكلام اللي بيتنشر تحت الفيديو على المنصات اللي اخترتها. اختار طريقتك، أو سيبها حسب فكرة كل فيديو.');
  content.append(modeChoice('writingStyle'), pills('writingStyle'));
  const value = draft.preferences.writingStyle.value ?? 'educational';
  content.append(el('span', 'مثال للتوضيح', {class: 'tag'}), el('p', sampleWriting[value], {class: 'writing-demo'}), note('المساعد بيكتب الوصف من محتوى الفيديو الحقيقي، مع كلمة الكومنت اللي تختارها.'));
}
function colourField(key, labelText) {
  const box = el('div', null, {class: 'colour-field'}); const id = `colour-${key}`; box.append(el('label', labelText, {for: id}));
  const controls = el('div', null, {class: 'colour-controls'});
  const color = el('input', null, {type: 'color', id, 'aria-label': labelText}); color.value = draft.brand[key] ?? (key === 'text' ? '#183D3A' : '#F7F7F2');
  const hex = el('input', null, {type: 'text', dir: 'ltr', maxlength: 7, 'aria-label': `كود ${labelText}`}); hex.value = draft.brand[key] ?? '';
  const disabled = draft.preferences.palette.mode === 'auto'; color.disabled = disabled; hex.disabled = disabled;
  color.addEventListener('input', () => {draft.brand[key] = color.value.toUpperCase(); hex.value = draft.brand[key]; changed();});
  hex.addEventListener('input', () => {draft.brand[key] = hex.value.trim() || null; if (/^#[0-9a-f]{6}$/i.test(hex.value)) color.value = hex.value; changed();});
  controls.append(color, hex); box.append(controls); return box;
}
function endingPage() {
  title('ألوانك، وآخر انطباع.', 'استخدم ألوانك في الجرافيك، أو سيب كل ستايل بألوانه. وحدّد تحب الفيديو ينتهي بإيه.');
  content.append(modeChoice('palette'));
  const colors = el('div', null, {class: `colour-grid${draft.preferences.palette.mode === 'auto' ? ' auto' : ''}`});
  colors.append(colourField('primary', 'اللون الأساسي'), colourField('accent', 'لون التمييز')); content.append(colors);
  const extra = el('details'); extra.append(el('summary', 'لون الخلفية والكلام — اختياري'));
  const advanced = el('div', null, {class: 'colour-grid'}); advanced.append(colourField('background', 'الخلفية'), colourField('text', 'الكلام')); extra.append(advanced, note('سيب الكود فاضي عشان الاستوديو يختار لون مناسب.')); content.append(extra);
  const grid = el('div', null, {class: 'form-grid'});
  grid.append(field('كلمة الكومنت — اختياري', 'cta', draft.ending.ctaDefault, v => draft.ending.ctaDefault = v || null, {max: 20, hint: 'زي «مونتاج». تقدر تغيّرها لفيديو واحد.'}),
    field('جملة ختام بتقولها — اختياري', 'signoff', draft.ending.signOff, v => draft.ending.signOff = v || null, {max: 60, hint: 'لو عندك جملة ختام ثابتة، اكتبها زي ما بتقولها.'}));
  const check = el('label'); const checkbox = el('input', null, {type: 'checkbox', id: 'follow-card'}); checkbox.checked = draft.ending.followCard;
  checkbox.addEventListener('change', () => {draft.ending.followCard = checkbox.checked; changed();}); check.append(checkbox, el('span', 'كارت متابعة باليوزر بتاعي في النهاية'));
  const row = el('div', null, {class: 'check-row wide'}); row.append(check); grid.append(row); content.append(grid, note(draft.handle ? `الكارت هيستخدم ${draft.handle}.` : 'لو عايز كارت متابعة، ضيف اليوزر في خطوة «بياناتك».'));
}
function summaryPage() {
  title('ده أسلوبك. جاهز نبدأ؟', 'راجع اختياراتك. هتتحفظ للفيديوهات الجاية، وأي اختيار تلقائي المساعد هيحدده حسب المحتوى.');
  const grid = el('div', null, {class: 'summary'});
  for (const [label, value, target] of [
    ['بياناتك', `${draft.name || 'لسه ما كتبتش الاسم'}${draft.handle ? ` · ${draft.handle}` : ''}`, 0],
    ['ستايل الفيديو', draft.preferences.style.mode === 'auto' ? 'تلقائي لكل فيديو' : prefLabel('style', draft.preferences.style.value), 1],
    ['ترتيب الكابشن', draft.preferences.captionsGrouping.mode === 'auto' ? 'تلقائي لكل فيديو' : prefLabel('captionsGrouping', draft.preferences.captionsGrouping.value), 2],
    ['شكل الكابشن', draft.preferences.captionsPresentation.mode === 'auto' ? 'تلقائي لكل فيديو' : prefLabel('captionsPresentation', draft.preferences.captionsPresentation.value), 2],
    ['سكين الكابشن', draft.preferences.captionsSkin?.mode === 'fixed' ? prefLabel('captionsSkin', draft.preferences.captionsSkin.value) : 'الشكل الأساسي', 2],
    ['الخط', draft.preferences.font.mode === 'auto' ? 'تلقائي حسب الستايل' : prefLabel('font', draft.preferences.font.value), 3],
    ['الأرقام', digitLabels[draft.preferences.digits?.mode === 'fixed' ? draft.preferences.digits.value : 'auto'], 3],
    ['وصف المنشور', draft.preferences.writingStyle.mode === 'auto' ? 'تلقائي حسب المحتوى' : prefLabel('writingStyle', draft.preferences.writingStyle.value), 4],
    ['الألوان', draft.preferences.palette.mode === 'auto' ? 'ألوان الستايل' : 'ألوان البراند بتاعك', 5],
    ['النهاية', [draft.ending.followCard ? 'كارت متابعة' : 'بدون كارت متابعة', draft.ending.ctaDefault ? `كلمة: ${draft.ending.ctaDefault}` : 'بدون كلمة كومنت ثابتة'].join(' · '), 5],
  ]) {
    const item = el('div', null, {class: 'summary-item'}); item.append(el('small', label), el('strong', value), button('تعديل', '', () => go(target))); grid.append(item);
  }
  content.append(grid, el('p', 'عايز تعدّل بعدين؟ قول للمساعد «افتح إعداداتي». ولفيديو واحد: «الفيديو ده بس خليه كولاج» مثلًا.', {class: 'save-note'}));
}
function render() {
  content.replaceChildren(); actions.replaceChildren();
  document.querySelector('#step-number').textContent = `الخطوة ${Math.min(step + 1, 7)} من ٧`;
  document.querySelector('#user-label').textContent = draft.name ? `استوديو ${draft.name}` : 'إعداد الاستوديو';
  document.querySelector('#steps').replaceChildren(...steps.map((text, index) => {
    const link = button('', 'step-link', () => go(index), {'aria-label': `${index + 1} ${text}`, ...(step === index ? {'aria-current': 'step'} : {})});
    link.append(el('span', index + 1, {class: 'number'}), el('span', text, {class: 'step-name'})); return link;
  }));
  if (step === 7) {successPage(); return;}
  [identity, stylePage, captionsPage, fontsPage, writingPage, endingPage, summaryPage][step]();
  const back = step > 0 ? button('رجوع', 'secondary', () => go(step - 1)) : el('span', 'حوالي دقيقتين لضبط ذوقك', {class: 'actions-note'});
  const next = step === 6 ? button(busy ? 'بنحفظ…' : existing ? 'احفظ إعداداتي' : 'احفظ وابدأ', 'primary', save) : button('التالي ←', 'primary', () => go(step + 1));
  next.disabled = busy; actions.append(back, next);
}
async function save() {
  const error = validate(); if (error) {showError(error); return;}
  busy = true; showError(''); render();
  try {
    const saved = await api('profile', {method: 'PUT', body: {profile: draft, etag}});
    const wasNew = !existing; draft = saved.profile; etag = saved.etag; existing = true; dirty = false;
    document.querySelector('#save-state').textContent = 'إعداداتك محفوظة ✓';
    step = 7; busy = false; render();
    if (wasNew) await beginSetup(); else await refreshStatus();
  } catch (error) {busy = false; showError(error.message); render();}
}
function successPage() {
  content.append(el('div', '✓', {class: 'success-icon', 'aria-hidden': 'true'}));
  title('إعداداتك اتحفظت.', 'كده المساعد عارف ذوقك. ارجع للمحادثة لما التجهيز يخلص، عشان يكمل فحص الاستوديو معاك.');
  const region = el('div', null, {id: 'setup-progress', 'aria-live': 'polite'}); content.append(region); renderProgress();
  actions.append(button('راجع إعداداتي', 'secondary', () => go(6)));
  if (!setup || !['done', 'running'].includes(setup.status)) actions.append(button('كمّل تجهيز الاستوديو', 'primary', beginSetup));
}
function renderProgress() {
  const region = document.querySelector('#setup-progress'); if (!region) return;
  region.replaceChildren(); if (!setup) {region.append(note('بنراجع التجهيز…')); return;}
  const stageLabels = {folders: 'فولدرات الشغل', packages: 'مكتبات المونتاج', browser: 'متصفح الرندر', ffmpeg: 'أدوات الفيديو', fonts: 'الخطوط', models: 'أدوات كشف الوجه', transcription: 'التفريغ الصوتي'};
  const total = Object.keys(stageLabels).length, arabic = (value) => value.toLocaleString('ar-EG');
  const completed = Object.values(setup.done).filter(Boolean).length;
  region.append(el('h3', setup.status === 'done' ? 'التجهيز خلص ✓' : setup.status === 'running' ? 'بنجهّز الاستوديو على جهازك' : 'التجهيز محتاج تكملة', {class: 'section-title'}));
  const track = el('div', null, {class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': completed, 'aria-label': 'مراحل التجهيز المكتملة'});
  const bar = el('div'); bar.style.width = `${completed / total * 100}%`; track.append(bar); region.append(track);
  region.append(el('p', setup.status === 'done' ? 'ارجع للمساعد عشان يعمل فحص النظام. حفظ الإعدادات والتجهيز خلصوا.' : setup.status === 'running' ? `${arabic(completed)} من ${arabic(total)} مراحل خلصوا. أول تجهيز ممكن ياخد ١٥–٣٠ دقيقة حسب النت.` : 'قول للمساعد «كمّل تجهيز الاستوديو» لو واجهت مشكلة.', {class: 'status-line'}));
  const list = el('ul', null, {class: 'progress-list'});
  for (const [id, text] of Object.entries(stageLabels)) {
    const done = setup.done[id]; const active = id === setup.step && setup.status === 'running'; const item = el('li', null, {class: done ? 'done' : active ? 'active' : ''});
    item.append(el('span', done ? '✓' : active ? '◉' : '○', {class: 'stage-icon', 'aria-hidden': 'true'}), el('span', text), el('small', done ? 'خلصت' : active ? 'شغالة' : 'في الانتظار')); list.append(item);
  }
  region.append(list);
  if (setup.status === 'failed') region.append(note(`التجهيز وقف عند «${stageLabels[setup.step] ?? 'البداية'}»: ${setup.error ?? 'فيه مشكلة في الخطوة دي'}. إعداداتك محفوظة، جرّب تكمّل أو ارجع للمساعد.`));
  else if (setup.status === 'incomplete') region.append(note('فيه مراحل لسه ما اتجهزتش. اضغط «كمّل تجهيز الاستوديو» عشان نكمّلها.'));
}
async function refreshStatus() {
  try {
    const previous = setup?.status; setup = (await api('status')).setup;
    if (step === 7) {if (previous !== setup.status) render(); else renderProgress();}
    if (setup.done.fonts && catalog.readyFonts.length < catalog.choices.font.length) {
      catalog = await api('catalog'); document.querySelector('#font-styles').href = `/fonts.css?token=${token}&v=${Date.now()}`;
      if (step === 3) render();
    }
  } catch (error) {showError(error.message);}
}
async function beginSetup() {
  if (busy) return; busy = true; showError('');
  for (const b of actions.querySelectorAll('button')) b.disabled = true;
  try {setup = (await api('setup', {method: 'POST', body: {}})).setup;}
  catch (error) {showError(error.message);}
  finally {busy = false; render();}
}
async function load() {
  try {
    const [options, state, progress] = await Promise.all([api('catalog'), api('profile'), api('status')]);
    catalog = options; draft = state.profile ?? structuredClone(catalog.defaults); etag = state.etag; existing = state.profile !== null; setup = progress.setup;
    draft.preferences.digits ??= {mode: 'auto', value: null};
    document.querySelector('#edition').textContent = catalog.edition ? `v${catalog.edition}` : '';
    document.querySelector('#save-state').textContent = state.notices?.length ? state.notices.join(' ') : existing ? 'إعداداتك محفوظة ✓' : 'جاهز لاختياراتك';
    render(); pollTimer = setInterval(refreshStatus, 3000);
  } catch (error) {
    content.replaceChildren(); title('مش قادرين نفتح إعداداتك.', 'إعداداتك محفوظة. خلي المساعد يراجع المشكلة، أو جرّب تفتح الشاشة تاني.'); showError(error.message);
    actions.replaceChildren(button('حاول تاني', 'primary', load));
  }
}
window.addEventListener('beforeunload', event => {if (dirty) {event.preventDefault(); event.returnValue = '';}});
window.addEventListener('pagehide', () => clearInterval(pollTimer));
load();
