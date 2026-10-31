import {assertStyleIdentity} from './helpers/style-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bundleEngine, setSsrFrame} from './helpers/engine-bundle.mjs';
import {ARABIC_SCENES} from './fixtures/arabic-scenes.mjs';

const pilotPath = 'docs/superpowers/specs/assets/v4-pilots/paper-collage/';
let pilotSource = (await readFile(pilotPath + 'design.tsx', 'utf8')).replace(/\r\n/g,'\n');
const entry = await readFile(pilotPath + 'entry.tsx', 'utf8');
const sampleSource = entry.slice(entry.indexOf('const heading ='), entry.indexOf('const CAPTION'));

// These are the authorized differences, applied only to the test's in-memory
// reference. The approved source on disk is never changed. Text fit fallback,
// shadow isolation and preview-only silhouettes are production safety adapters.
pilotSource = pilotSource.replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
pilotSource = pilotSource.replace(/<StandIn[^>]*\/>/g, '');
const fitStart = pilotSource.indexOf('const fit = ');
pilotSource = pilotSource.slice(0, fitStart) + 'const fit = productionFit;\n' + pilotSource.slice(pilotSource.indexOf('const textW =', fitStart));
pilotSource = pilotSource.replace('return <div style={{position: \'absolute\', left: p.x, top: p.y', 'return <div data-paper-id={p.id} style={{position: \'absolute\', left: p.x, top: p.y');
pilotSource = pilotSource.replace(',\r\n    filter: p.noShadow ? undefined : shadowFilter(lift, p.depth ?? 1, p.tight)', '').replace(',\n    filter: p.noShadow ? undefined : shadowFilter(lift, p.depth ?? 1, p.tight)', '');
pilotSource = pilotSource.replace("style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>\n      {shape.fringe", "style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', filter: p.noShadow ? undefined : shadowFilter(lift, p.depth ?? 1, p.tight)}}>\n      {shape.fringe");
const comparisonStart=pilotSource.indexOf('const Comparison:'),comparisonEnd=pilotSource.indexOf('const Statement:');
const comparisonReference=pilotSource.slice(comparisonStart,comparisonEnd).replace('opacity: dim, direction:', 'direction:').replace('color: C.ink, whiteSpace:', 'color: `rgba(40,50,46,${dim})`, whiteSpace:').replace("color: 'rgba(40,50,46,0.8)'", 'color: `rgba(40,50,46,${dim})`').replace('1 - 0.5 * ramp(f, 66, 12)', '1 - 0.28 * ramp(f, 66, 12)');
pilotSource=pilotSource.slice(0,comparisonStart)+comparisonReference+pilotSource.slice(comparisonEnd);

const api = await bundleEngine(`
  import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {AbsoluteFill, Easing, useCurrentFrame} from 'remotion';
  import {measure, fitsSafeZone, safeWidthFor} from './engine/src/core/type';
  import {PAPER_COLLAGE_DESIGNS} from './engine/src/styles/paper-collage/designs';
  import {DesignProvider, fit as productionFit, showOffcuts, PaperLabelCaption} from './engine/src/styles/paper-collage/designs/kit';
  import {ChapterThemeProvider, TypographyProvider} from './engine/src/creative-kit/chapter-theme';
  import {SafeRoot} from './engine/src/core/safe';
  import {PaperSwap} from './engine/src/core/transitions-v4/paper-swap';
  import {editSceneSchema} from './engine/src/prepared-edit/schema';
  import {PreparedEdit} from './engine/src/prepared-edit/PreparedEdit';
  import {FAMILY_DESIGNS} from './engine/src/styles/family-designs';
  import {getSceneGeometry} from './engine/src/creative-kit/primitives';
  import theme from './engine/src/styles/paper-collage/theme';
  import meta from './engine/src/styles/paper-collage/meta';
  export {productionFit, PAPER_COLLAGE_DESIGNS, editSceneSchema, theme, meta, getSceneGeometry, fitsSafeZone, safeWidthFor, showOffcuts};
  ${sampleSource}
  const pilot = (() => {
    ${pilotSource}
    return {intro: Intro, proof: Proof, process: Process, checklist: Checklist, comparison: Comparison, statement: Statement, count: CountSplit, comment: Comment, follow: Follow, 'message-board': MessageBoard, 'evidence-wipe': EvidenceWipe, PaperSwap};
  })();
  const geometry = {windowTop:1030, windowHeight:890, videoWidth:1080, videoLeft:0, videoTop:-340};
  export const render = (scene, sectionIndex, headBox = null, font = null, chapter = null) => {
    const Drawing = PAPER_COLLAGE_DESIGNS[scene.family];
    return renderToStaticMarkup(<ChapterThemeProvider chapter={chapter}><TypographyProvider fontFamily={font}><Drawing scene={scene} sectionIndex={sectionIndex} style="paper-collage" geometry={geometry} aspect={16/9} seam={1030} headBox={headBox}/></TypographyProvider></ChapterThemeProvider>);
  };
  export const reference = (family, data) => renderToStaticMarkup(React.createElement(pilot[family], {d:data, seam:1030, tap:80}));
  export const transition = (atFrame=107, durationInFrames=14, probe) => renderToStaticMarkup(<SafeRoot probe={probe}><PaperSwap atFrame={atFrame} durationInFrames={durationInFrames} fps={30}/></SafeRoot>);
  export const transitionReference = frame => renderToStaticMarkup(React.createElement(pilot.PaperSwap, {frame,len:14}));
  export const caption = (text,y=1240) => renderToStaticMarkup(<DesignProvider data={{text}}><PaperLabelCaption y={y} text={text}/></DesignProvider>);
  export const prepared = edit => {
    const original = FAMILY_DESIGNS['paper-collage'];
    FAMILY_DESIGNS['paper-collage'] = PAPER_COLLAGE_DESIGNS;
    try {return renderToStaticMarkup(<PreparedEdit edit={edit} plate={{src:'_prepared/paper-collage/abc.mp4',width:1080,height:1920}}/>);}
    finally {if(original)FAMILY_DESIGNS['paper-collage']=original;else delete FAMILY_DESIGNS['paper-collage'];}
  };
`, {ssr:true, media:true});

const families = ['intro','proof','process','checklist','comparison','statement','count','comment','follow','message-board','evidence-wipe'];
const frames = [0,12,50,100];
const makeScene = (family,data) => ({id:family,family,layout:family==='count'?'split':family==='statement'?'presenter':'takeover',motion:'land',fromFrame:0,durationInFrames:150,data});
const parsed = (key) => {
  const family = key.replace(/-(long|missing)$/, '');
  let data = structuredClone(api.SAMPLES[key]);
  if (family==='message-board') data = {initialTitle:'الرسائل',boardTitle:'اللوحة',focusTitle:'الفكرة',closingTitle:'النتيجة',items:data.messages.map((label,i)=>({id:'item-'+i,label})),focusIndex:1,gatherFrame:66,gatherDurationFrames:20,focusFrame:90,focusDurationFrames:10};
  if (family==='evidence-wipe') data = {kicker:'الدليل',title:data.title,before:{src:'examples/evidence-before.svg',width:640,height:360,label:'قبل'},after:{src:'examples/evidence-after.svg',width:640,height:360,label:'بعد'},revealFrame:42,revealDurationFrames:26,dir:'rtl',footer:data.label};
  if (family==='count') data = {...data,rollFrame:26,rollDuration:34,unitFrame:56,badgeFrame:70};
  if (['intro','proof','process','comparison','comment','follow'].includes(family)) data.caption = 'مثال';
  return api.editSceneSchema.parse(makeScene(family,data));
};

for (const key of [...families,'intro-long','checklist-missing']) for(const frame of frames) test(`${key}: parsed SSR frame ${frame}`, () => {
  setSsrFrame(frame);
  const html=api.render(parsed(key),1);
  assert.ok(html.length>400);
  assert.doesNotMatch(html,/NaN|Infinity|undefined/);
});

const english = {
  intro:{kicker:'Example',title:'One clear idea',subtitle:'Explain it clearly',caption:'Example'},
  proof:{label:'Supplied value',value:42,suffix:'x',source:'ILLUSTRATIVE VALUE',caption:'Example'},
  process:{title:'One step at a time',steps:[{title:'Choose',detail:'Pick an idea'},{title:'Build',detail:'Arrange the pieces'},{title:'Review',detail:'Check the result'}],caption:'Example'},
  checklist:{kicker:'Example',title:'A clear plan',variant:'missing',items:[{label:'A title',detail:'Missing',atFrame:15},{label:'Steps',detail:'Missing',atFrame:40},{label:'An ending',detail:'Missing',atFrame:65},{label:'Audio',detail:'Missing',atFrame:90}]},
  comparison:{title:'A different order',beforeTitle:'Before',beforeDetail:'Separate parts',afterTitle:'After',afterDetail:'One clear idea',caption:'Example'},
  statement:{kicker:'Example',title:'One clear idea'},
  count:{kicker:'Example',title:'One clear value',value:42,suffix:'x',unit:'of the sample',badge:'Example',rollFrame:26,rollDuration:34,unitFrame:56,badgeFrame:70},
  comment:{keyword:'guide',promise:'An illustrative example',caption:'Example'},
  follow:{handle:'@example',message:'Practical ideas',caption:'Example'},
  'message-board':{initialTitle:'Messages',boardTitle:'Board',focusTitle:'Focus',closingTitle:'Result',items:['Idea','Example','Step','Result'].map((label,i)=>({id:'item-'+i,label})),focusIndex:1,gatherFrame:66,gatherDurationFrames:20,focusFrame:90,focusDurationFrames:10},
  'evidence-wipe':{kicker:'Evidence',title:'From the screen',before:{src:'examples/evidence-before.svg',width:640,height:360,label:'Before'},after:{src:'examples/evidence-after.svg',width:640,height:360,label:'After'},revealFrame:42,revealDurationFrames:26,dir:'ltr',footer:'Illustrative'},
};
for(const family of families) test(family+': English copy aligns left without Arabic words',()=>{
  for(const frame of frames){
    setSsrFrame(frame);
    const html=api.render(api.editSceneSchema.parse(makeScene(family,english[family])),1);
    assert.match(html,/direction:ltr;text-align:left/);
    assert.equal(/[\u0600-\u06FF]|direction:rtl|NaN|Infinity/.test(html),false,family+': Arabic or invalid values in English markup');
  }
});

// Small HTML tree reader: no browser, screenshots or image render is involved.
function tree(html){
  const root={tag:'root',attrs:{},children:[]}, stack=[root];
  for(const token of html.match(/<[^>]+>|[^<]+/g)??[]){
    if(token.startsWith('<!--'))continue;
    if(token.startsWith('</')){stack.pop();continue;}
    if(!token.startsWith('<')){stack.at(-1).children.push(token);continue;}
    const tag=token.match(/^<([^\s/>]+)/)[1],attrs={};
    for(const m of token.matchAll(/([^\s=]+)="([^"]*)"/g))attrs[m[1]]=m[2];
    const node={tag,attrs,children:[]};stack.at(-1).children.push(node);
    if(!/\/>$/.test(token)&&!['img','link','meta','br','input'].includes(tag))stack.push(node);
  }
  return root;
}
const style = node => Object.fromEntries((node.attrs.style??'').split(';').filter(Boolean).map(s=>{const i=s.indexOf(':');return [s.slice(0,i),s.slice(i+1)];}));
function find(node,predicate){if(typeof node==='string')return null;if(predicate(node))return node;for(const c of node.children){const found=find(c,predicate);if(found)return found;}return null;}
function canonical(node,{evidence=false}={}){
  if(typeof node==='string')return node;
  if(node.tag==='link'&&node.attrs.rel==='preload')return [];
  if(node.attrs['data-paper-design']||'data-statement-bottom' in node.attrs)return node.children.flatMap(c=>canonical(c,{evidence}));
  const attrs={...node.attrs};
  const children = evidence&&attrs['data-paper-id']==='ev-screen' ? [] : node.children.flatMap(c=>canonical(c,{evidence}));
  return [{tag:node.tag,attrs,children}];
}
function firstDifference(a,b,path='root'){
  if(Object.is(a,b))return null;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return {path,actual:a,expected:b};
  for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
    const diff=firstDifference(a[key],b[key],path+'.'+key);if(diff)return diff;
  }
  return null;
}

for(const key of [...families,'intro-long','checklist-missing']) for(const frame of frames) test(`pilot identity after round-one adaptations: ${key} @${frame}`,()=>{
  setSsrFrame(frame);
  const family=key.replace(/-(long|missing)$/, ''),scene=parsed(key), expected=api.reference(family,api.SAMPLES[key]);
  const actual=api.render(scene);
  assertStyleIdentity(actual,expected,scene.data,family);
});

test('fit fallback preserves every word at the minimum size and line budget',()=>{
  const warnings=[],warn=console.warn;console.warn=m=>warnings.push(m);
  try{
    const text='Unfittable text '.repeat(50),r=api.productionFit(text,{width:100,size:150,min:72,lines:4,weight:700,family:'Reem Kufi'});
    assert.equal(r.size,72);assert.equal(r.fits,false);assert.ok(r.lines.length<=4);
    assert.equal(r.lines.join(' ').replace(/\s+/g,' ').trim(),text.trim());
    assert.ok(warnings.some(m=>m.startsWith('paper-collage fit-warning:')));
  }finally{console.warn=warn;}
});

test('offcuts are present only for missing index or 1, 4, 7...',()=>{
  setSsrFrame(100);
  for(const index of [undefined,0,1,2,3,4,5,6,7,8]){
    const html=api.render(parsed('intro'),index),on=index===undefined||index%3===1;
    assert.equal(/data-paper-id="oc-/.test(html),on);
    assert.equal(api.showOffcuts(index),on);
  }
});

test('caption center and 128 px band fit ig-reels-organic',()=>{
  assert.equal(api.theme.layout.caption,1240);assert.equal(api.getSceneGeometry('paper-collage','takeover').captionCenter,1240);
  for(const center of [1240,1030]){
    const band=api.safeWidthFor(center-64,128,'ig-reels-organic',{inset:32});
    assert.equal(api.fitsSafeZone({left:band.left,top:center-64,width:band.width,height:128},'ig-reels-organic').ok,true);
    assert.ok(band.left>=65);if(center>=1150)assert.ok(band.left+band.width<853);
  }
  setSsrFrame(100);
  const caption=find(tree(api.caption('جملة قصيرة')),n=>n.attrs['data-paper-id']==='caption'),s=style(caption);
  const box={left:parseFloat(s.left),top:parseFloat(s.top),width:parseFloat(s.width),height:parseFloat(s.height)};
  assert.equal(api.fitsSafeZone(box,'ig-reels-organic').ok,true);
  assert.equal(box.top+box.height/2,1240);
});

test('null and high heads retain the full statement below the face',()=>{
 setSsrFrame(100);const scene=parsed('statement');for(const head of [null,{x:350,y:300,width:380,height:600}]){const html=api.render(scene,1,head);assert.match(html,/data-statement-placement="lower"/);assert.ok(Number(html.match(/data-statement-bottom="([^"]+)"/)[1])<=1150);}
});

test('saved headline font wins; brand does not change the fixed palette',()=>{
  setSsrFrame(100);const scene=parsed('intro');
  assert.match(api.render(scene,1),/font-family:Reem Kufi/);
  assert.match(api.render(scene,1,null,'Cairo'),/font-family:Cairo/);
  const brand={ground:'#FFFFFF',ink:'#000000',accent:'#00FFCC',onAccent:'#000000'};
  assert.equal(api.render(scene,1,null,null,brand),api.render(scene,1));assert.equal(api.meta.brand,false);
});

test('dim before-label ink contrast stays at least 4.5:1 on its paper',()=>{
  const lum=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const paper=[255,254,247],ink=[40,50,46],dim=ink.map((v,i)=>v*.72+paper[i]*.28),ratio=(lum(paper)+.05)/(lum(dim)+.05);
  assert.ok(ratio>=4.5,ratio.toFixed(3));
  setSsrFrame(100);const label=find(tree(api.render(parsed('comparison'),1)),n=>n.attrs['data-paper-id']==='cmp-lb');
  assert.ok(JSON.stringify(label).includes('rgba(40,50,46,0.72)'));
});

test('supplied evidence images reveal on the fixed flap clock; callouts stay absent',()=>{
  for(const [frame,p]of [[0,0],[42,0],[55,.5],[68,1],[100,1]]){
    setSsrFrame(frame);const html=api.render(parsed('evidence-wipe'),1);
    assert.match(html,/src="\/examples\/evidence-before.svg"/);assert.match(html,/src="\/examples\/evidence-after.svg"/);
    assert.equal(Number(html.match(/data-evidence-reveal="([^"]+)"/)[1]),p);
    assert.doesNotMatch(html,/data-paper-id="ev-callout"/);
  }
});

test('no CSS filter ancestor contains both clip-path and text',()=>{
  setSsrFrame(50);
  const hasText=n=>typeof n==='string'?/[\p{L}\p{N}]/u.test(n):n.children.some(hasText);
  const unsafe=node=>typeof node!=='string'&&Boolean(style(node).filter)&&Boolean(find(node,n=>'clip-path' in style(n)))&&hasText(node);
  assert.equal(unsafe(tree('<div style="filter:blur(1px)"><div style="clip-path:inset(0)">text</div></div>').children[0]),true);
  for(const family of families){
    const visit=node=>{if(typeof node==='string')return;assert.equal(unsafe(node),false,family);node.children.forEach(visit);};
    visit(tree(api.render(parsed(family),1)));
  }
});

test('English lower labels remain left of the physical Instagram rail',()=>{
  setSsrFrame(100);
  for(const [family,id]of [['comment','cm-promise'],['evidence-wipe','ev-label']]){
    const html=api.render(api.editSceneSchema.parse(makeScene(family,english[family])),1);
    const s=style(find(tree(html),n=>n.attrs['data-paper-id']===id));
    const left=parseFloat(s.left),width=parseFloat(s.width),top=parseFloat(s.top),height=parseFloat(s.height);
    assert.ok(left>=65);assert.ok(left+width<853);assert.ok(top+height<=1470);
    assert.equal(api.fitsSafeZone({left,top,width,height},'ig-reels-organic').ok,true);
  }
});

test('evidence direction controls the flap independently of copy language',()=>{
  setSsrFrame(55);
  const scene=api.editSceneSchema.parse(makeScene('evidence-wipe',english['evidence-wipe']));
  const flap=dir=>{scene.data.dir=dir;return style(find(tree(api.render(scene,1)),n=>n.attrs['data-paper-id']==='ev-flap'));};
  const rtl=flap('rtl'),ltr=flap('ltr');
  assert.equal(parseFloat(rtl.left),-950);assert.equal(parseFloat(ltr.left),1210);
  assert.ok(rtl.transform.startsWith('translate(540px,'));assert.ok(ltr.transform.startsWith('translate(-540px,'));
});

test('five and six message items retain every card',()=>{
 for(const count of [5,6]){const scene=parsed('message-board');scene.data.items=Array.from({length:count},(_,i)=>({id:'card-'+i,label:'Supplied card '+i}));const html=api.render(api.editSceneSchema.parse(scene),1);assert.equal((html.match(/data-paper-id="mb-[0-9]"/g)??[]).length,count);}
});

test('statement and count leave the supplied prepared footage mounted once',()=>{
  setSsrFrame(100);
  for(const family of ['statement','count']){
    const scene=parsed(family),edit={version:1,id:'paper-collage-test',purpose:'test',style:'paper-collage',source:{path:'Projects/test/source.mp4',sha256:'0'.repeat(64),fps:30,width:1080,height:1920,totalFrames:150},segments:[{fromFrame:0,toFrame:150}],captions:{status:'draft',words:[]},scenes:[scene],sounds:[],camera:[]};
    const html=api.prepared(edit);
    assert.equal((html.match(/<video /g)??[]).length,1);
    assert.match(html,/src="\/_prepared\/paper-collage\/abc.mp4"/);
  }
});

for(const frame of [104,107,110]) test(`paper-swap: centered overlay at frame ${frame}`,()=>{
  setSsrFrame(frame);const html=api.transition();
  assert.match(html,/data-transition="paper-swap"/);assert.doesNotMatch(html,/NaN|Infinity/);
  const actual=find(tree(html),n=>n.attrs.style?.includes('width:1560px'));
  const expected=find(tree(api.transitionReference(frame-100)),n=>n.attrs.style?.includes('width:1560px'));
  assert.deepEqual(actual,expected);
  if(frame===107){const s=style(actual);assert.equal(s.left,'-240px');assert.equal(s.transform,'rotate(0deg)');}
});
test('paper-swap stays absent outside its centered window and in safe probes',()=>{
  for(const frame of [90,100,114,120]){setSsrFrame(frame);assert.doesNotMatch(api.transition(),/data-transition/);}
  setSsrFrame(107);assert.doesNotMatch(api.transition(107,14,'#00FF00'),/data-transition/);
});

test('all current Arabic family fixtures and checklist extremes remain renderable',()=>{
  for(const sample of ARABIC_SCENES.filter(s=>families.includes(s.family)))for(const frame of frames){setSsrFrame(frame);assert.doesNotMatch(api.render(api.editSceneSchema.parse(sample),1),/NaN|Infinity/);}
  for(const count of [1,4,5])for(const variant of ['missing','blueprint']){
    const scene=parsed('checklist');scene.data.variant=variant;scene.data.items=Array.from({length:count},(_,i)=>({label:'عنوان '+i,detail:'تفصيل',atFrame:20}));
    for(const frame of frames){setSsrFrame(frame);assert.doesNotMatch(api.render(api.editSceneSchema.parse(scene),1),/NaN|Infinity/);}
  }
});
