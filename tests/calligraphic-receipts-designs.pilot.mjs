import {assertStyleIdentity} from './helpers/style-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bundleEngine, setSsrFrame} from './helpers/engine-bundle.mjs';

const pilotPath = new URL('../docs/superpowers/specs/assets/v4-pilots/calligraphic-receipts/', import.meta.url);
const [entry, kitSource, sceneSource] = await Promise.all(['entry.tsx', 'kit.tsx', 'scenes.tsx'].map(file => readFile(new URL(file, pilotPath), 'utf8')));
const samples = (await bundleEngine(entry.slice(entry.indexOf('const heading'), entry.indexOf('const CAPTION')))).SAMPLES;
const api = await bundleEngine(`
  import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {CALLIGRAPHIC_RECEIPTS_DESIGNS as designs} from './engine/src/styles/calligraphic-receipts/designs';
  import {inkLayout, statementPlacement, sceneCopy, useFonts, C, InkCaption} from './engine/src/styles/calligraphic-receipts/designs/kit';
  import {editSceneSchema} from './engine/src/prepared-edit/schema';
  import {receiptsSceneSchema, claimProofDataSchema, validateReceiptsTiming, RECEIPTS_FAMILIES} from './engine/src/styles/calligraphic-receipts/scenes/schema';
  import {receiptsTemplateData} from './engine/src/styles/calligraphic-receipts/scenes/templates';
  import {PaperPull} from './engine/src/core/transitions-v4/paper-pull';
  import {TypographyProvider, ChapterThemeProvider} from './engine/src/creative-kit/chapter-theme';
  import {getSceneGeometry} from './engine/src/creative-kit/primitives';
  import {safeWidthFor, fitsSafeZone} from './engine/src/core/type';
  export {designs, editSceneSchema, receiptsSceneSchema, claimProofDataSchema, validateReceiptsTiming, RECEIPTS_FAMILIES, receiptsTemplateData, inkLayout, statementPlacement, sceneCopy, getSceneGeometry, safeWidthFor, fitsSafeZone};
  const geometry = {windowTop:1000, windowHeight:920, videoWidth:1080, videoLeft:0, videoTop:-340};
  export const render = (scene, headBox = null, font = null, chapter = null) => renderToStaticMarkup(
    <TypographyProvider fontFamily={font}><ChapterThemeProvider chapter={chapter}>
      {React.createElement(designs[scene.family], {scene, style:'calligraphic-receipts', geometry, aspect:16/9, seam:1000, headBox})}
    </ChapterThemeProvider></TypographyProvider>);
  const Fonts = () => <output>{JSON.stringify({fonts:useFonts(), colors:C})}</output>;
  export const fonts = font => renderToStaticMarkup(<TypographyProvider fontFamily={font}><Fonts/></TypographyProvider>);
  export const transition = () => renderToStaticMarkup(<PaperPull atFrame={0} durationInFrames={14} fps={30}><b>Outgoing sheet</b></PaperPull>);
  export const caption = () => renderToStaticMarkup(<InkCaption y={1260} text="A supplied caption" slip/>);
`, {ssr: true, media: true});

const families = ['intro', 'proof', 'process', 'checklist', 'comparison', 'statement', 'count', 'comment', 'follow', 'meter-receipt', 'claim-proof'];
const frames = [0, 12, 50, 100];
const familyOf = key => key.replace(/-(long|missing)$/, '');
function parsed(key, data = samples[key]) {
  const family = familyOf(key);
  let mapped = {...structuredClone(data)};
  if (['intro', 'proof', 'process', 'comparison', 'comment', 'follow'].includes(family)) mapped.caption = 'Example';
  if (family === 'count') mapped = {...mapped, rollFrame:52, rollDuration:26, unitFrame:20, badgeFrame:92};
  if (family === 'meter-receipt') mapped = {kicker:data.kicker, title:data.title, rows:[{...data.before, atFrame:24}, {...data.after, atFrame:42}], maximum:100, unit:'%', source:data.note};
  if (family === 'claim-proof') {mapped.keyIndex = mapped.key; delete mapped.key;}
  const scene = {id:key, fromFrame:0, durationInFrames:150, family, layout:family === 'count' ? 'split' : family === 'statement' ? 'presenter' : 'takeover', motion:'quiet', data:mapped};
  return (family === 'claim-proof' ? api.receiptsSceneSchema : api.editSceneSchema).parse(scene);
}

for (const key of [...families, 'intro-long', 'checklist-missing']) for (const frame of frames) test(`${key}: parsed SSR frame ${frame}`, () => {
  setSsrFrame(frame);
  const html = api.render(parsed(key));
  assert.ok(html.length > 400);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

const english = {
  intro:{kicker:'Example', title:'One idea with clear steps', subtitle:'Make the idea clear'},
  proof:{label:'Supplied value', value:42, suffix:'x', source:'Illustrative value only'},
  process:{title:'Three clear steps', steps:[{title:'Choose',detail:'Choose the main idea'},{title:'Arrange',detail:'Put the steps in order'},{title:'Review',detail:'Check the final result'}]},
  checklist:{kicker:'Example',title:'Check your idea',variant:'blueprint',items:[{label:'Choose',detail:'First step',atFrame:15},{label:'Arrange',detail:'Next step',atFrame:45},{label:'Review',detail:'Final step',atFrame:75}]},
  comparison:{title:'The same idea in order',beforeTitle:'Before',beforeDetail:'Separate parts',afterTitle:'After',afterDetail:'One clear idea'},
  statement:{kicker:'Example',title:'One clear idea'},
  count:{kicker:'Example',title:'Supplied value',value:42,suffix:'x',unit:'Illustrative value',badge:'Example'},
  comment:{keyword:'Example',promise:'A supplied explanation'},
  follow:{handle:'@sample',message:'Practical ideas'},
  'meter-receipt':{kicker:'Example',title:'One scale, two results',before:{label:'Before',value:35},after:{label:'After',value:80},note:'Illustrative values only'},
  'claim-proof':{claim:['Order','saves','time'],key:2,rows:[{label:'Before',value:40},{label:'After',value:15}],diff:{label:'Difference',value:25},unit:'min',note:'Illustrative example'},
};
for (const family of families) test(`${family}: English copy aligns left and stays LTR`, () => {
  setSsrFrame(100);
  const html = api.render(parsed(family, english[family]));
  assert.match(html, /direction:ltr;text-align:left/);
  assert.doesNotMatch(html, /[\u0600-\u06ff]|direction:rtl/);
  const field = english[family].title ?? english[family].label ?? english[family].keyword ?? english[family].handle ?? english[family].claim.join(' ');
  for (const word of field.split(' ')) assert.ok(html.includes(word), word);
});

test('claim-proof rejects inconsistent numbers, invalid words and an absent key; decimal differences are exact', () => {
  const good = parsed('claim-proof');
  assert.deepEqual(api.RECEIPTS_FAMILIES, ['claim-proof']);
  for (const change of [{diff:{label:'Difference',value:24}}, {keyIndex:3}, {claim:[]}, {claim:['two words']}, {claim:['a','b','c','d','e']}]) {
    assert.equal(api.claimProofDataSchema.safeParse({...good.data,...change}).success,false);
  }
  const decimal = {...good.data,rows:[{label:'A',value:.3},{label:'B',value:.1}],diff:{label:'Difference',value:.2}};
  assert.equal(api.claimProofDataSchema.safeParse(decimal).success,true);
  assert.equal(api.claimProofDataSchema.safeParse({...decimal,diff:{label:'Difference',value:.21}}).success,false);
  assert.equal(api.claimProofDataSchema.safeParse({...decimal,rows:[{label:'A',value:Infinity},{label:'B',value:0}]}).success,false);
});

test('claim-proof template, cue defaults, ordering and resolved hold', () => {
  const scene = parsed('claim-proof');
  assert.deepEqual([scene.data.claimFrame,scene.data.receiptFrame,scene.data.totalFrame],[4,14,54]);
  assert.deepEqual(api.validateReceiptsTiming(scene),[]);
  assert.deepEqual(api.validateReceiptsTiming({...scene,durationInFrames:120}),[]);
  assert.ok(api.validateReceiptsTiming({...scene,durationInFrames:100}).length);
  assert.ok(api.validateReceiptsTiming({...scene,data:{...scene.data,totalFrame:20}}).length);
  assert.ok(api.validateReceiptsTiming({...scene,data:{...scene.data,claimFrame:20}}).length);
  assert.deepEqual(api.receiptsSceneSchema.parse({...scene,data:api.receiptsTemplateData['claim-proof']}).data,scene.data);
});

test('claim-proof preserves decimal totals, accepts one to four whole words and follows authored cues', () => {
  const original=parsed('claim-proof');
  for (const words of [['فكرة'],['فكرة','واحدة','واضحة','للجميع']]) {
    const scene=api.receiptsSceneSchema.parse({...original,data:{...original.data,claim:words,keyIndex:words.length-1}});
    for(const frame of frames) {setSsrFrame(frame);assert.doesNotMatch(api.render(scene),/NaN|Infinity|undefined/);}
  }
  setSsrFrame(100);
  const decimal=api.receiptsSceneSchema.parse({...original,data:{...original.data,rows:[{label:'Before',value:.3},{label:'After',value:.1}],diff:{label:'Difference',value:.2}}});
  assert.match(api.render(decimal),/>0\.2<\/span>/);
  const later={...original,data:{...original.data,claimFrame:28,receiptFrame:42,totalFrame:82},durationInFrames:160};
  assert.deepEqual(api.validateReceiptsTiming(later),[]);
  assert.doesNotMatch(api.render(later),/baseFrequency="0.7"/);
  setSsrFrame(130);assert.match(api.render(later),/baseFrequency="0.7"/);
});

test('meter-receipt uses the supplied common maximum and unit, including a negative decimal difference', () => {
  setSsrFrame(100);
  const original=parsed('meter-receipt');
  const scene=api.editSceneSchema.parse({...original,data:{...original.data,rows:[{label:'Before',value:70,atFrame:24},{label:'After',value:160,atFrame:42}],maximum:200,unit:'hours',source:'Supplied source'}});
  const html=api.render(scene), bars=[];
  visit(tree(html),node=>{if(node.children.length===20&&node.children.every(child=>typeof child!=='string'&&/width:26px;height:39px/.test(child.attrs)))bars.push(node);});
  assert.equal(bars.length,2);
  assert.deepEqual(bars.map(bar=>bar.children.filter(child=>!child.attrs.includes('background:rgba(46,32,25,0.10)')).length),[7,16]);
  assert.match(html,/>200 hours<\/span>/);assert.doesNotMatch(textOf(tree(html)),/%/);
  const decreasing=api.editSceneSchema.parse({...scene,data:{...scene.data,rows:[{label:'Before',value:.3,atFrame:24},{label:'After',value:.1,atFrame:42}]}});
  assert.match(api.render(decreasing),/−<\/span>0\.2/);
});

test('unfittable text keeps all whole words at the minimum and maximum line budget, with a warning', () => {
  const warn = console.warn, warnings=[];
  console.warn = message => warnings.push(message);
  try {
    const text = 'Unfittable whole words '.repeat(30).trim();
    const layout = api.inkLayout(text,[{size:236,min:150,lines:2,width:100},{size:176,min:96,lines:3,width:100}]);
    assert.equal(layout.size,96); assert.equal(layout.lines.length,3); assert.equal(layout.lines.join(' '),text);
    assert.ok(warnings.some(message => message.includes('calligraphic-receipts fit-warning:')));
    for (const frame of frames) {setSsrFrame(frame); assert.doesNotThrow(() => api.render({...parsed('intro'),data:{...parsed('intro').data,title:text}}));}
  } finally {console.warn=warn;}
});

test('statement preserves the pilot without a head box and protects an actual head; no StandIn enters production', () => {
  const L={lines:['One clear idea'],size:118,box:136,baseline:87,family:'Aref Ruqaa',weight:700,width:950};
  assert.equal(api.statementPlacement({...L}).top,306);
  for (const y of [600,510,460]) {
    const p=api.statementPlacement({...L},{y});
    assert.ok(p.visible); assert.ok(p.top+p.box+p.size*.34<=y-40); assert.ok(p.kickerTop>=250);
  }
  const warn=console.warn; console.warn=()=>{};
  try {assert.equal(api.statementPlacement({...L},{y:300}).visible,false);} finally {console.warn=warn;}
  setSsrFrame(100);
  for(const family of ['statement','count']) assert.doesNotMatch(api.render(parsed(family)),/#5A4D44|#4A4039|<video|<img/);
});

test('the saved headline font wins; the paper palette ignores creator brand colours', () => {
  assert.match(api.fonts(null),/Aref Ruqaa/);
  assert.match(api.fonts('Cairo'),/ruqaa&quot;:&quot;Cairo/);
  setSsrFrame(100);
  const scene=parsed('intro'), original=api.render(scene);
  assert.match(api.render(scene,null,'Cairo'),/font-family:Cairo/);
  assert.equal(api.render(scene,null,null,{ground:'#FFFFFF',ink:'#000000',accent:'#00FFCC',onAccent:'#000000'}),original);
});

test('takeover caption at 1260 and split seam at 1000 fit ig-reels-organic', () => {
  for(const [layout,center] of [['takeover',1260],['split',1000]]) {
    assert.equal(api.getSceneGeometry('calligraphic-receipts',layout).captionCenter,center);
    const band=api.safeWidthFor(center-64,128,'ig-reels-organic',{inset:32});
    assert.equal(api.fitsSafeZone({left:band.left,top:center-64,width:band.width,height:128},'ig-reels-organic').ok,true);
  }
  assert.equal(api.fitsSafeZone({left:65,top:1220,width:788,height:80},'ig-reels-organic').ok,true);
  assert.equal(api.fitsSafeZone({left:65,top:1220,width:789,height:80},'ig-reels-organic').ok,false);
});

// Lightweight DOM tree for checking server markup, not a browser render or a screenshot.
function tree(html) {
  const root={tag:'root',attrs:'',children:[]}, stack=[root];
  for(const token of html.match(/<[^>]+>|[^<]+/g)??[]) {
    if(token.startsWith('</')) {stack.pop();continue;}
    if(token.startsWith('<')) {
      const m=token.match(/^<([^\s/>]+)([\s\S]*?)\/?\s*>$/);
      if(!m)continue;
      const node={tag:m[1],attrs:m[2],children:[]}; stack.at(-1).children.push(node);
      if(!token.endsWith('/>')&&!['img','input','br','link','meta'].includes(node.tag))stack.push(node);
    }else stack.at(-1).children.push(token);
  }
  return root;
}
const textOf=node=>typeof node==='string'?node:node.children.map(textOf).join('');
function visit(node,fn) {if(typeof node==='string')return;fn(node);node.children.forEach(child=>visit(child,fn));}
test('no CSS filter wraps a text-bearing clip-path layer; SVG seal grain remains intact', () => {
  setSsrFrame(100);
  for(const family of families) {
    const html=api.render(parsed(family));
    visit(tree(html),node=>{
      if(!/\bstyle="[^"]*(?:^|;)filter:/.test(node.attrs))return;
      visit(node,child=>{if(/clip-path:/.test(child.attrs))assert.equal(textOf(child).trim(),'',family+' clipped text below CSS filter');});
    });
    if(['proof','comparison','count','meter-receipt','claim-proof'].includes(family)) {
      assert.match(html,/baseFrequency="0.7"/);assert.match(html,/baseFrequency="0.09"/);assert.match(html,/scale="3.2"/);
    }
  }
});

for(const [frame,q] of [[0,0],[6.5,.5],[13,1]])test(`paper-pull progress ${q}`,()=>{
  setSsrFrame(frame);const html=api.transition();assert.doesNotMatch(html,/NaN|Infinity|undefined/);
  if(q===1)assert.doesNotMatch(html,/Outgoing sheet/);
  else {assert.match(html,/Outgoing sheet/);assert.match(html,/transform-origin:30% 100%/);assert.match(html,/clip-path:polygon/);}
});

// Amend only the two requested typography changes. Geometry and animation still come from the pilot.
let expectedScenes=sceneSource.replace(/^import .*\r?\n/gm,'').replace(/    <StandIn[^\n]*\n/g,'');
expectedScenes=expectedScenes.replace("const src = one(d.source, {family: FONT.mono, weight: 400, width: 584, size: 24, min: 15});",
  "const src = inkLayout(d.source, {family: FONT.mono, weight:400, width:584, size:28, min:28, lines:3, lh:1.15}); const sourceH=Math.max(56,src.lines.length*src.box);");
expectedScenes=expectedScenes.replace("{h: 56, node: <div style={{height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', ...mono(src.fontSize, {fontWeight: 400, color: C.inkSoft, letterSpacing: 0})}}>{d.source}</div>}",
  "{h:sourceH,node:<div style={{height:sourceH,display:'flex',flexDirection:'column',alignItems:'flex-end',justifyContent:'center',padding:`0 ${PAD}px`,...mono(src.size,{fontWeight:400,color:C.inkSoft,letterSpacing:0})}}>{src.lines.map((line,i)=><div key={i} style={{lineHeight:`${src.box}px`}}>{line}</div>)}</div>}");
expectedScenes=expectedScenes.replace("const note = one(d.note, {family: FONT.mono, weight: 400, width: 584, size: 22, min: 14});",
  "const note=inkLayout(d.note,{family:FONT.mono,weight:400,width:584,size:30,min:30,lines:4,lh:1.1}); const noteH=Math.max(44,note.lines.length*note.box);");
expectedScenes=expectedScenes.replace('...mono(24,','...mono(30,');
expectedScenes=expectedScenes.replace("{at: 76, h: 44, node: <div style={{height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', ...mono(note.fontSize, {fontWeight: 400, color: C.inkSoft})}}>{d.note}</div>}",
  "{at:76,h:noteH,node:<div style={{height:noteH,padding:`0 ${PAD}px`,display:'flex',flexDirection:'column',alignItems:'flex-end',justifyContent:'center',...mono(note.size,{fontWeight:400,color:C.inkSoft})}}>{note.lines.map((line,i)=><div key={i} style={{lineHeight:`${note.box}px`}}>{line}</div>)}</div>}");
const pilot=await bundleEngine(kitSource.replace("'@rs/core/type'","'./engine/src/core/type'")+expectedScenes+`
  import {renderToStaticMarkup} from 'react-dom/server';
  const views={intro:Intro,proof:Proof,process:Process,checklist:Checklist,comparison:Comparison,statement:Statement,count:CountSplit,comment:Comment,follow:Follow,'meter-receipt':MeterReceipt,'claim-proof':ClaimProof};
  export const renderPilot=(family,d)=>renderToStaticMarkup(React.createElement(views[family],{d,seam:1000,tap:80}));
`,{ssr:true,media:true});

function canonical(html) {
  // IDs depend on wrapper depth. Rewrite definitions and references together, preserving their associations.
  const ids=new Map();
  html=html.replace(/id="([^"]+)"/g,(_,id)=>{const n='id-'+ids.size;ids.set(id,n);return `id="${n}"`;});
  for(const [old,id] of ids)html=html.replaceAll('#'+old+')','#'+id+')');
  const root=tree(html);
  function clean(node) {
    if(typeof node==='string')return node;
    // Separate shape-only shadows are an explicit headless-safety change.
    if(/filter:blur\(/.test(node.attrs)&&!textOf(node).trim())return null;
    let attrs=node.attrs.replace(/style="([^"]*)"/,(_,style)=>{
      const declarations=style.split(';').filter(p=>p&&!/^(direction|text-align|letter-spacing):/.test(p)&&!/^filter:(drop-shadow|saturate)/.test(p)).sort();
      return `style="${declarations.join(';')}"`;
    });
    return {tag:node.tag,attrs,children:node.children.map(clean).filter(n=>n!==null)};
  }
  return clean(root);
}
for(const key of [...families,'intro-long','checklist-missing'])test(key+': pilot ink identity and whole words after safety adaptations',()=>{
 for(const frame of frames){setSsrFrame(frame);const scene=parsed(key);assertStyleIdentity(api.render(scene),pilot.renderPilot(familyOf(key),samples[key]),scene.data,scene.family);}
});
