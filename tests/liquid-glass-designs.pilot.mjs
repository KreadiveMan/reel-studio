import {assertStyleIdentity} from './helpers/style-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bundleEngine,setSsrFrame} from './helpers/engine-bundle.mjs';

const pilotPath='docs/superpowers/specs/assets/v4-pilots/liquid-glass/';
const original=readFileSync(pilotPath+'design.tsx','utf8').replaceAll('\r\n','\n');
const entry=readFileSync(pilotPath+'entry.tsx','utf8');
const samplesSource=entry.slice(entry.indexOf('const heading ='),entry.indexOf('const CAPTION ='));
const basePilot=original.replace("'@rs/core/type'","'./engine/src/core/type'")
  .replace(/export const StandIn:[\s\S]*?\/\/ ---------- the lens ----------/,'export const StandIn: React.FC<any> = () => null;\n// ---------- the lens ----------');
const pilot=await bundleEngine(basePilot+'\n'+samplesSource+`
  import {renderToStaticMarkup} from 'react-dom/server';
  export const render=(kind,d,n='01')=>renderToStaticMarkup(<Scene kind={kind} d={d} n={n}/>);
`,{ssr:true,media:true});

// An independent copy of the approved pilot with ONLY the named safe-zone corrections.
// No production source is rewritten or substituted into the pilot parity oracle.
const safePilot=basePilot
 .replace('top={ruleTop + 38} right={60} width={830}', 'top={ruleTop + 38} right={g.slab.y+ruleTop+38+g.s.lines.length*g.s.box>1150 ? 222 : 60} width={g.slab.y+ruleTop+38+g.s.lines.length*g.s.box>1150 ? 668 : 830}')
 .replace('bottom: 62, left: 0, width: g.card.w','bottom: 62, left: 0, width: 787')
 .replace('h: 1236 - top','h: 1130 - top')
 .replace('const checkLens = (f: number, d: any) => lensState(f, checkStops(d), {appear: 2, r: Math.max(78, Math.min(120, checkGeo(d).rowH * 0.62)), zoom: 1.6, travel: 14, arc: 30});',
  'const checkLens = (f: number, d: any) => { const s=lensState(f,checkStops(d),{appear:2,r:Math.max(78,Math.min(120,checkGeo(d).rowH*0.62)),zoom:1.6,travel:14,arc:30}); return {...s,cy:Math.min(s.cy,1149-s.r)}; };')
 .replace('right: 58, bottom: 38','right: 220, bottom: 38')
 .replace('600, 700, {size: 56','600, 587, {size: 56')
 .replace("inset: 0, display: 'flex', alignItems: 'center', gap: 26", "left:0, top:0, bottom:0, width:787, boxSizing:'border-box', display: 'flex', alignItems: 'center', gap: 26")
 .replace('400, 840,','400, 787,').replace('bottom: 26, left: 0, width: CW','bottom: 26, left: 0, width: 787')
 .replace('400, 900,','400, 787,').replace('top: g.top + g.h + 18, left: X0, width: CW','top: g.top + g.h + 18, left: X0, width: 787');
const expected=await bundleEngine(safePilot+'\n'+samplesSource+`
  import {renderToStaticMarkup} from 'react-dom/server';
  export const render=(kind,d,n='01')=>renderToStaticMarkup(<Scene kind={kind} d={d} n={n}/>);
`,{ssr:true,media:true});

const transitionSource=entry.slice(entry.indexOf('const LensZoom:'),entry.indexOf('const Tr:'))
 .replace(/const frozenA = [\s\S]*?;\n/, 'const frozenA = <aside data-outgoing="true"/>;\n')
 .replace(/const rollB = [\s\S]*?;\n/, 'const rollB = <main data-incoming="true"/>;\n');
const pilotTransition=await bundleEngine(basePilot+'\n'+samplesSource+`
 import {LayerBox} from './engine/src/core/mask';
 import {renderToStaticMarkup} from 'react-dom/server';
 const ease=(t,e)=>e(clamp01(t)),settle=Easing.bezier(.16,1,.3,1),inOut=Easing.inOut(Easing.quad),PRE=14;
 ${transitionSource}
 export const render=()=>renderToStaticMarkup(<LayerBox box={{x:0,y:0,width:1080,height:1920}} clip><LensZoom a="checklist" b="intro"/></LayerBox>);
`,{ssr:true,media:true});

const api=await bundleEngine(`
  import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {LIQUID_GLASS_DESIGNS,liquidGlassExitLens} from './engine/src/styles/liquid-glass/designs';
  import {ChapterThemeProvider,TypographyProvider} from './engine/src/creative-kit/chapter-theme';
  import {editSceneSchema} from './engine/src/prepared-edit/schema';
  import {getSceneGeometry} from './engine/src/creative-kit/primitives';
  import {fitsSafeZone,safeWidthFor} from './engine/src/core/type';
  import {Lens,DesignScene,tryFit,SANS,sceneCopy} from './engine/src/styles/liquid-glass/designs/kit';
  import {checkGeo,checkLens} from './engine/src/styles/liquid-glass/designs/checklist';
  import {introGeo} from './engine/src/styles/liquid-glass/designs/intro';
  import {procGeo} from './engine/src/styles/liquid-glass/designs/process';
  import {stmtGeo} from './engine/src/styles/liquid-glass/designs/statement';
  import {soft,ramp} from './engine/src/styles/liquid-glass/designs/kit';
  import {mtr} from './engine/src/styles/liquid-glass/designs/meter-receipt';
  import {LensZoom,lensZoomMotion} from './engine/src/core/transitions-v4/lens-zoom';
  export {editSceneSchema,getSceneGeometry,fitsSafeZone,safeWidthFor,tryFit,LIQUID_GLASS_DESIGNS,lensZoomMotion,liquidGlassExitLens};
  const geometry={windowTop:1080,windowHeight:840,videoWidth:1080,videoLeft:0,videoTop:-340};
  export const render=(scene,opts={})=>{
    const Design=LIQUID_GLASS_DESIGNS[scene.family];
    return renderToStaticMarkup(<ChapterThemeProvider chapter={opts.brand??null}><TypographyProvider fontFamily={opts.font??null}>
      <Design scene={scene} sectionIndex={1} style="liquid-glass" geometry={geometry} aspect={16/9} seam={opts.seam??1080} headBox={opts.headBox??null}/>
    </TypographyProvider></ChapterThemeProvider>);
  };
  export const geo=(kind,data,extra={})=>({checklist:checkGeo,intro:introGeo,process:procGeo,statement:stmtGeo,'meter-receipt':mtr}[kind])({...data,font:SANS,copy:sceneCopy(data),seam:1080,headTop:null,...extra});
  export const checkState=(frame,data)=>checkLens(frame,{...data,font:SANS,copy:sceneCopy(data)});
  export const statementTravel=frame=>(1-Math.min(1,soft(frame,6)))*40+(1-ramp(frame,12,22))*34;
  export const transition=(frame,ls)=>renderToStaticMarkup(<LensZoom atFrame={0} durationInFrames={14} fps={30} outgoing={<aside data-outgoing="true"/>} outgoingLens={ls}><main data-incoming="true"/></LensZoom>);
  export const lensMounts=vis=>{
    let mounts=0;
    const Count=()=>{mounts++;return <b/>;};
    renderToStaticMarkup(<><Count/><Lens s={{cx:540,cy:800,r:140,zoom:1.5,blur:0,vis,spin:0}} ground={null}><Count/></Lens></>);
    return mounts;
  };
`,{ssr:true,media:true});

const families=['intro','proof','process','checklist','comparison','statement','count','comment','follow','token-lens','meter-receipt'];
const frames=[0,12,50,100];
const kindOf=key=>key.replace(/-(long|missing)$/,'');
function sceneFor(key,data=pilot.SAMPLES[key]) {
 const family=kindOf(key);
 let mapped={...data};
 if(['intro','proof','process','comparison','comment','follow'].includes(family)) mapped.caption='مثال';
 if(family==='count')Object.assign(mapped,{rollFrame:26,rollDuration:44,unitFrame:66,badgeFrame:90});
 if(family==='token-lens')mapped={kicker:data.kicker,title:'مجموعات توضيحية',groups:data.groups.map((g,i)=>({label:g.label,tokens:g.text.split(' '),atFrame:[36,66,94][i]})),lens:{groupIndex:2,tokenIndex:0,atFrame:94},footer:data.note};
 if(family==='meter-receipt')mapped={kicker:data.kicker,title:data.title,rows:[{...data.before,atFrame:18},{...data.after,atFrame:46}],maximum:100,unit:'%',source:data.note};
 return api.editSceneSchema.parse({id:'glass-'+key,fromFrame:0,durationInFrames:150,layout:family==='count'?'split':family==='statement'?'presenter':'takeover',motion:'stagger',family,data:mapped});
}

for(const key of Object.keys(pilot.SAMPLES)) for(const frame of frames) test(`${key}: parsed SSR frame ${frame}`,()=>{
 setSsrFrame(frame);
 const html=api.render(sceneFor(key));
 assert.ok(html.length>400);
 assert.doesNotMatch(html,/NaN|Infinity|undefined/);
 assert.match(html,/backdrop-filter:blur/);
});

const english={
 intro:{kicker:'Example',title:'One clear idea',subtitle:'From an idea to a clear picture',caption:'Example'},
 proof:{label:'Illustrative value',value:42,suffix:'×',source:'ILLUSTRATIVE VALUE',caption:'Example'},
 process:{title:'One step at a time',steps:[{title:'Choose',detail:'Find the main idea'},{title:'Arrange',detail:'One step follows another'},{title:'Review',detail:'Check the final picture'}],caption:'Example'},
 checklist:{kicker:'Example',title:'A clear plan',variant:'blueprint',items:[{label:'Choose',detail:'First step',atFrame:15},{label:'Arrange',detail:'Second step',atFrame:45},{label:'Review',detail:'Last step',atFrame:75}]},
 comparison:{title:'The same idea, organised',beforeTitle:'Before',beforeDetail:'Separate pieces',afterTitle:'After',afterDetail:'One clear picture',caption:'Example'},
 statement:{kicker:'Example',title:'One clear idea'},
 count:{kicker:'Example',title:'Illustrative value',value:42,suffix:'×',unit:'Sample value',badge:'Example',rollFrame:26,rollDuration:44,unitFrame:66,badgeFrame:90},
 comment:{keyword:'example',promise:'An illustrative request',caption:'Example'},
 follow:{handle:'@sample',message:'An illustrative account',caption:'Example'},
 'token-lens':{kicker:'Example',title:'Illustrative grouping',groups:[{label:'Subject',tokens:['One','idea'],atFrame:36},{label:'Action',tokens:['clarifies'],atFrame:66},{label:'Result',tokens:['the','picture'],atFrame:94}],lens:{groupIndex:2,tokenIndex:0,atFrame:94},footer:'ILLUSTRATIVE GROUPING'},
 'meter-receipt':{kicker:'Example',title:'One scale, two results',rows:[{label:'Before',value:35,atFrame:18},{label:'After',value:80,atFrame:46}],maximum:100,unit:'%',source:'ILLUSTRATIVE VALUES'},
};
for(const family of families)test(`${family}: English copy aligns left`,()=>{
 setSsrFrame(50);
 const scene=sceneFor(family);
 scene.data=english[family];
 const html=api.render(api.editSceneSchema.parse(scene));
 assert.doesNotMatch(html,/[\u0600-\u06ff]|direction:rtl/);
 assert.match(html,/direction:ltr;text-align:left/);
 if(!['proof','follow'].includes(family))assert.match(html,/align-items:flex-start|text-align:left/);
});

test('pilot glass inks and primary words survive authored timing and fit',()=>{
 for(const key of Object.keys(pilot.SAMPLES))for(const frame of frames){setSsrFrame(frame);const scene=sceneFor(key);assertStyleIdentity(api.render(scene),pilot.render(kindOf(key),pilot.SAMPLES[key]),scene.data,scene.family);}
});

test('lens mounts a second scene only while visible, exactly as the pilot guard',()=>{
 for(const [vis,count]of [[0,1],[0.019,1],[0.02,2],[1,2]])assert.equal(api.lensMounts(vis),count);
});

test('unfittable text keeps smallest size and final line budget with console.warn',()=>{
 const warnings=[],saved=console.warn;console.warn=m=>warnings.push(m);
 try{
   const text='Long unfittable content '.repeat(80);
   const result=api.tryFit(text,'Grid Sans',700,100,[{size:150,min:128,lines:3},{size:100,min:76,lines:4}],1.2);
   assert.equal(result.size,76);assert.ok(result.lines.length<=4);
   assert.equal(result.lines.join(' ').trim(),text.trim());
   assert.ok(warnings.some(m=>m.startsWith('liquid-glass fit-warning:')));
   setSsrFrame(50);assert.doesNotThrow(()=>api.render({...sceneFor('intro'),data:{...sceneFor('intro').data,title:text}}));
 }finally{console.warn=saved;}
});

test('saved headline font wins and creator brand cannot recolour the glass',()=>{
 setSsrFrame(50);const scene=sceneFor('intro');
 const before=api.render(scene),after=api.render(scene,{brand:{ground:'#FFFFFF',ink:'#000000',accent:'#00FFCC',onAccent:'#000000'}});
 assert.equal(before,after);
 assert.match(api.render(scene,{font:'Cairo'}),/font-family:Cairo/);
 assert.match(before,/font-family:Grid Sans/);
 assert.match(api.render(sceneFor('follow'),{font:'Cairo'}),/font-family:Cairo/);
});

test('Arabic source notes use a joined Arabic face without instrument letter spacing',()=>{
 const scene=sceneFor('proof');scene.data.source='مصدر توضيحي';
 setSsrFrame(100);const html=api.render(api.editSceneSchema.parse(scene));
 assert.match(html,/font-family:Grid Sans;font-weight:400;font-size:25px;letter-spacing:0;color:[^;]+;direction:rtl/);
});

test('caption bands and protected lower-third boxes fit ig-reels-organic',()=>{
 for(const [layout,center]of [['takeover',1340],['split',1080]]){
   assert.equal(api.getSceneGeometry('liquid-glass',layout).captionCenter,center);
   const b=api.safeWidthFor(center-64,128,'ig-reels-organic',{inset:32});
   assert.equal(api.fitsSafeZone({left:b.left,top:center-64,width:b.width,height:128},'ig-reels-organic').ok,true);
 }
 for(const box of [
   {left:65,top:1130,width:787,height:40}, // proof source
   {left:65,top:1200,width:787,height:40}, // token/meter note
   {left:123,top:1090,width:672,height:110}, // comparison result
   {left:65,top:1074,width:787,height:190}, // comment promise
 ])assert.equal(api.fitsSafeZone(box,'ig-reels-organic').ok,true,JSON.stringify(box));
 for(const key of ['checklist','checklist-missing']){
   const d=pilot.SAMPLES[key],g=api.geo('checklist',d);
   for(const y of g.rowCy)assert.ok(y+g.ringSize/2<=1150);
   for(const frame of frames){const s=api.checkState(frame,d);assert.ok(s.cy+s.r<=1149);}
 }
 setSsrFrame(100);
 for(const family of ['proof','token-lens','meter-receipt','comment'])assert.match(api.render(sceneFor(family)),/width:787px/,'the real drawing reserves the rail: '+family);
 assert.match(api.render(sceneFor('comparison')),/right:220px;bottom:38px/);
 for(const data of [pilot.SAMPLES.process,english.process])for(const c of api.geo('process',data)){
   const ar=/[\u0600-\u06ff]/.test(data.title);
   const cardX=ar?c.x:1080-c.x-700;
   const textX=ar?cardX+40:cardX+230;
   assert.equal(api.fitsSafeZone({left:textX,top:c.y+35,width:430,height:95},'ig-reels-organic').ok,true,'process text stays clear of the rail in both directions');
 }
});

test('statement tracks the real head and split uses the supplied seam; no StandIn',()=>{
 for(const headTop of [600,680,760])for(const frame of [0,12,13,20,50,100]){
   setSsrFrame(frame);
   const g=api.geo('statement',pilot.SAMPLES.statement,{headTop});
   assert.ok(g.titleTop+g.t.lines.length*g.t.box<=headTop-40);
   const travel=api.statementTravel(frame),lift=Math.max(0,travel-34);
   assert.ok(g.titleTop+g.t.lines.length*g.t.box+travel-lift<=headTop-40,'animated text also clears the head');
   const html=api.render(sceneFor('statement'),{headBox:{x:360,y:headTop,width:350,height:420}});
   assert.doesNotMatch(html,/#3B3530|#4A4039|#5A4D44|<video|<img/);
 }
 setSsrFrame(100);assert.match(api.render(sceneFor('count'),{seam:1056}),/top:1055px/);
});

test('high head keeps the full statement in a lower body band',()=>{
 setSsrFrame(50);const scene=sceneFor('statement'),html=api.render(scene,{headBox:{x:300,y:300,width:400,height:600}});assert.match(html,/data-statement-placement="lower"/);assertStyleIdentity(html,pilot.render('statement',pilot.SAMPLES.statement),scene.data,'statement');
});

test('clip-path hosts never also carry a CSS filter and text',()=>{
 for(const key of Object.keys(pilot.SAMPLES))for(const frame of frames){
   setSsrFrame(frame);
   const html=api.render(sceneFor(key));
   for(const style of html.matchAll(/style="([^"]*clip-path[^\"]*)"/g))assert.doesNotMatch(style[1],/(?:^|;)filter:/);
 }
});

test('one to five checklist items, equal cues, and one to three token groups never throw',()=>{
 setSsrFrame(100);
 for(const n of [1,2,4,5]){
   const scene=sceneFor('checklist');scene.data.items=Array.from({length:n},(_,i)=>({label:'Item '+i,detail:'Detail',atFrame:20}));
   assert.doesNotMatch(api.render(api.editSceneSchema.parse(scene)),/NaN|Infinity/);
 }
 for(const n of [1,2,3]){
   const scene=sceneFor('token-lens');scene.data.groups=scene.data.groups.slice(0,n);scene.data.lens.groupIndex=n-1;
   assert.doesNotMatch(api.render(api.editSceneSchema.parse(scene)),/NaN|Infinity/);
 }
});

test('meter uses the real shared maximum, values, unit and a signed delta',()=>{
 const scene=sceneFor('meter-receipt');scene.data={...english['meter-receipt'],maximum:200,unit:'units',rows:[{label:'Before',value:150,atFrame:18},{label:'After',value:50,atFrame:46}]};
 setSsrFrame(100);const html=api.render(api.editSceneSchema.parse(scene));
 assert.match(html,/>150</);assert.match(html,/>50</);assert.match(html,/>200</);assert.match(html,/>-100</);
 assert.doesNotMatch(html,/>150%|\+-/);
 scene.data={...scene.data,maximum:100,unit:'%',rows:[{label:'Before',value:35.25,atFrame:18},{label:'After',value:80.5,atFrame:46}]};
 const fractional=api.render(api.editSceneSchema.parse(scene));
 assert.match(fractional,/>35.25%</);assert.match(fractional,/>80.5%</);assert.match(fractional,/>\+45.25</);
});

for(const frame of [0,5,13])test(`lens-zoom: pilot progress ${frame}/13`,()=>{
 setSsrFrame(frame);
 const ls=pilot.exitLens('checklist',pilot.SAMPLES.checklist);
 const motion=api.lensZoomMotion(frame,ls);
 const q=Math.max(0,Math.min(1,frame/10));
 const max=Math.max(Math.hypot(ls.cx,ls.cy),Math.hypot(1080-ls.cx,ls.cy),Math.hypot(ls.cx,1920-ls.cy),Math.hypot(1080-ls.cx,1920-ls.cy))+40;
 assert.equal(motion.R,ls.r+(max-ls.r)*(.5*q+.5*q*q));
 assert.equal(motion.zoomA,ls.zoom*(1+1.6*q*q));
 const html=api.transition(frame,ls);
 assert.equal(html,pilotTransition.render(),'full transition markup equals the pilot TR with neutral scene placeholders');
 assert.match(html,/data-outgoing/);assert.match(html,/data-incoming/);assert.doesNotMatch(html,/NaN|Infinity/);
 if(frame===13){assert.equal(motion.rim,0);assert.equal(motion.zoomB,1);assert.ok(motion.R>=max);}
});
