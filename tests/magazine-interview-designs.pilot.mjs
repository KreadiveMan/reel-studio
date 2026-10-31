import {assertStyleIdentity} from './helpers/style-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bundleEngine,setSsrFrame} from './helpers/engine-bundle.mjs';
import {ARABIC_SCENES} from './fixtures/arabic-scenes.mjs';

const api=await bundleEngine(`
  import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {MAGAZINE_INTERVIEW_DESIGNS} from './engine/src/styles/magazine-interview/designs';
  import {MagazineScope,MagazineCaption,NAVY,CREAM,fit,planHeadline,statementPlacement,railInset} from './engine/src/styles/magazine-interview/designs/kit';
  import {magazineSceneSchema,validateMagazineTiming} from './engine/src/styles/magazine-interview/scenes/schema';
  import {magazineTemplateData} from './engine/src/styles/magazine-interview/scenes/templates';
  import {MagazineFlip,magazineFlipGeometry} from './engine/src/core/transitions-v4/magazine-flip';
  import {ChapterThemeProvider,TypographyProvider} from './engine/src/creative-kit/chapter-theme';
  import {editSceneSchema} from './engine/src/prepared-edit/schema';
  import theme,{MAGAZINE_CAPTION} from './engine/src/styles/magazine-interview/theme';
  import {getSceneGeometry} from './engine/src/creative-kit/primitives';
  import {fitsSafeZone,safeWidthFor} from './engine/src/core/type';
  export {MAGAZINE_INTERVIEW_DESIGNS,magazineSceneSchema,validateMagazineTiming,magazineTemplateData,magazineFlipGeometry,
    fit,planHeadline,statementPlacement,railInset,editSceneSchema,theme,MAGAZINE_CAPTION,getSceneGeometry,fitsSafeZone,safeWidthFor};
  export const render=(scene,headBox=null,fontFamily=null,chapter=null)=>{
    const Component=MAGAZINE_INTERVIEW_DESIGNS[scene.family];
    return renderToStaticMarkup(<TypographyProvider fontFamily={fontFamily}><ChapterThemeProvider chapter={chapter}>
      <Component scene={scene} style="magazine-interview" seam={1080} headBox={headBox}
        geometry={{windowTop:1080,windowHeight:840,videoWidth:1080,videoLeft:0,videoTop:-340}} aspect={16/9}/>
    </ChapterThemeProvider></TypographyProvider>);
  };
  export const caption=(cream=false)=>renderToStaticMarkup(<MagazineScope data={{title:'Example'}}><MagazineCaption y={1300} text="Example caption" th={cream?CREAM:NAVY}/></MagazineScope>);
  export const transition=(outgoingHeight)=>renderToStaticMarkup(<MagazineFlip atFrame={27} durationInFrames={14} fps={30} outgoingHeight={outgoingHeight}><article>Outgoing page</article></MagazineFlip>);
`,{ssr:true,media:true});

let pilotSource=(await readFile(new URL('../docs/superpowers/specs/assets/v4-pilots/magazine-interview/design.tsx',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const entry=await readFile(new URL('../docs/superpowers/specs/assets/v4-pilots/magazine-interview/entry.tsx',import.meta.url),'utf8');
const samplesSource=entry.slice(entry.indexOf('const heading'),entry.indexOf('const CAPTION'));
// Only the two art-director adjustments and data/plate mapping are applied to the baseline.
pilotSource=pilotSource.replace("from '@rs/core/type'","from './engine/src/core/type'")
  .replaceAll('fontSize: 25','fontSize: 30')
  .replaceAll('fontSize: 26','fontSize: 30')
  .replace('wid(label, 28, 600)','wid(label, 30, 600)')
  .replace("fontSize: 28, lineHeight: '38px'","fontSize: 30, lineHeight: '38px'")
  .replace("fontSize: 24, letterSpacing: 1, color: th.gold","fontSize: 30, letterSpacing: 1, color: th.gold")
  .replaceAll('    <StandIn/>','').replaceAll('    <StandIn top={seam} height={1920 - seam}/>','')
  .replace('>02</div>','>{(d as any).chapterNumber}</div>');
// Mandatory platform clearance is excluded from pilot parity. These are the only Arabic
// geometry changes: lower text/rings/TOC numeral move 162 px clear of the right UI rail.
pilotSource=pilotSource.replace('const FPS = 30;',"const FPS = 30;\nconst railInset=(top:number,height:number)=>top+height>1150?162:0;")
  .replace('const width = p.width ?? CW;\n  const t = fit(p.text,', 'let width = p.width ?? CW;\n  let t = fit(p.text,')
  .replace("  return <div style={{position: 'absolute', top: p.top, right: p.right ?? W - X1, width, direction: 'rtl', display: 'flex', flexDirection: 'column'}}>\n    {t.lines.map", "  if(p.top+t.box*t.lines.length+30>1150 && width>788){width=788;t=fit(p.text,{width,size:p.size,min:p.min,lines:p.lines,weight:p.weight??400,lh:p.lh,family:p.family});}\n  return <div style={{position: 'absolute', top: p.top, right: (p.right ?? W-X1)+railInset(p.top,t.box*t.lines.length+30), width, direction: 'rtl', display: 'flex', flexDirection: 'column'}}>\n    {t.lines.map")
  .replace('top: top - 6, right: W - X1, width: numW','top: top - 6, right: W - X1+railInset(top-6,NS+30), width: numW')
  .replace('top: top + 8, right: W - titleRight,','top: top + 8, right: W - titleRight+railInset(top-6,NS+30),')
  .replace('right: W - dotsRight, width: dotsW *','right: W - dotsRight+railInset(top-6,NS+30), width: Math.max(0,dotsW-railInset(top-6,NS+30)) *')
  .replace('top: top + (rowH - R) / 2 - 6, right: W - X1','top: top + (rowH - R) / 2 - 6, right: W - X1+railInset(top,rowH+30)')
  .replace('right: W - X1 + R + 34,','right: W - X1 + R + 34+railInset(top,rowH+30),')
  .replace('top: textBottom + 46, right: W - X1,','top: textBottom + 46, right: W - X1+railInset(textBottom+46,104),')
  .replace('top: 1096, right: W - X1,','top: 1096, right: W - X1+railInset(1096,88),');
const pilot=await bundleEngine(`${pilotSource}\n${samplesSource}
  import {renderToStaticMarkup} from 'react-dom/server';
  const components={intro:Intro,proof:Proof,process:Process,checklist:Checklist,comparison:Comparison,statement:Statement,count:CountSplit,comment:Comment,follow:Follow,'chapter-quote':ChapterQuote,verdict:Verdict};
  export const renderPilot=(family,data)=>{const Component=components[family];return renderToStaticMarkup(<Component d={data} n="01" seam={1080} tap={80}/>);};
  export const renderTurn=(t)=>renderToStaticMarkup(<TurnLayers t={t}><article>Outgoing page</article></TurnLayers>);
  export {turnGeo};
`,{ssr:true,media:true});

const families=['intro','proof','process','checklist','comparison','statement','count','comment','follow','chapter-quote','verdict'];
const frames=[0,12,50,100];
const make=(family,data)=>({id:family,family,layout:family==='count'?'split':family==='statement'?'presenter':'takeover',motion:'land',fromFrame:0,durationInFrames:150,data});
const mapSample=(key)=>{
  const family=key.replace(/-(long|missing)$/,'');
  let data=structuredClone(pilot.SAMPLES[key]);
  if(['intro','proof','process','comparison','comment','follow'].includes(family))data.caption='مثال';
  if(family==='count')Object.assign(data,{rollFrame:24,rollDuration:44,unitFrame:66,badgeFrame:84});
  if(family==='chapter-quote')data={...data,chapter:'02',title:data.chapter,quoteFrame:20};
  if(family==='verdict')data={...data,rows:data.rows.map((row,i)=>({...row,atFrame:[30,46,62][i]})),verdictFrame:84};
  const scene=make(family,data);
  // The pilot's stress title exceeds the shared intro schema's 64-character editorial limit.
  return key==='intro-long'?scene:family==='verdict'?api.magazineSceneSchema.parse(scene):api.editSceneSchema.parse(scene);
};
const scenes=families.map(mapSample);

for(const family of families)test(`${family}: parsed Arabic fixtures render at four frames`,()=>{
  const sample=scenes.find(scene=>scene.family===family);
  const fixture=ARABIC_SCENES.find(scene=>scene.family===family);
  for(const scene of [sample,...(fixture?[api.editSceneSchema.parse(fixture)]:[])])for(const frame of frames){
    setSsrFrame(frame);
    const html=api.render(scene);
    assert.ok(html.length>400);
    assert.doesNotMatch(html,/NaN|Infinity|undefined/);
    assert.doesNotMatch(html,/StandIn|#4A4039|#5A4D44|<video/,'graphics use the existing production footage layer');
  }
});

test('long title and four-item missing checklist render at all four frames',()=>{
  for(const key of ['intro-long','checklist-missing'])for(const frame of frames){
    setSsrFrame(frame);assert.doesNotMatch(api.render(mapSample(key)),/NaN|Infinity/);
  }
});

const english={
  intro:{kicker:'Example',title:'One clear idea',subtitle:'A simple explanation',caption:'Example'},
  proof:{label:'Example value',value:42,suffix:'x',source:'Illustrative source',caption:'Example'},
  process:{title:'One step at a time',steps:[{title:'Choose',detail:'Pick the idea'},{title:'Arrange',detail:'Put it in order'},{title:'Review',detail:'Check the result'}],caption:'Example'},
  checklist:{kicker:'Example',title:'Review the plan',variant:'missing',items:[{label:'Title',detail:'Add one',atFrame:15},{label:'Steps',detail:'Put in order',atFrame:40},{label:'Ending',detail:'Review it',atFrame:65},{label:'Audio',detail:'Check it',atFrame:90}]},
  comparison:{title:'The same idea in order',beforeTitle:'Before',beforeDetail:'Separate ideas',afterTitle:'After',afterDetail:'One clear idea',caption:'Example'},
  statement:{kicker:'Example',title:'One clear idea'},
  count:{kicker:'Example',title:'A supplied value',value:42,suffix:'x',unit:'Example units',badge:'Example',rollFrame:24,rollDuration:44,unitFrame:66,badgeFrame:84},
  comment:{keyword:'Example',promise:'An illustrative preview',caption:'Example'},
  follow:{handle:'@sample',message:'An illustrative account',caption:'Example'},
  'chapter-quote':{chapter:'02',title:'The next chapter',quote:'One clear idea saves time',speaker:'Example speaker',role:'Illustrative role',quoteFrame:20},
  verdict:{question:'Is this useful? Example',rows:[{label:'Ease',value:8,outOf:10,atFrame:30},{label:'Price',value:6,outOf:10,atFrame:46},{label:'Result',value:9,outOf:10,atFrame:62}],verdict:'Example: useful',verdictFrame:84},
};
for(const family of families)test(`${family}: English is left-aligned and has no fixed Arabic words`,()=>{
  const scene=family==='verdict'?api.magazineSceneSchema.parse(make(family,english[family])):api.editSceneSchema.parse(make(family,english[family]));
  for(const frame of frames){setSsrFrame(frame);const html=api.render(scene);assert.doesNotMatch(html,/[\u0600-\u06ff]|direction:rtl/);assert.match(html,/text-align:left/);}
});

test('unfittable copy preserves all words at the minimum size without throwing',()=>{
  const original=console.warn,warnings=[];console.warn=warning=>warnings.push(warning);
  try{
    const text='An intentionally unfittable word '.repeat(70).trim();
    const result=api.fit(text,{width:100,size:150,min:64,lines:4,weight:800});
    assert.equal(result.size,64);assert.equal(result.fits,false);assert.ok(result.lines.length<=4);assert.equal(result.lines.join(' '),text);
    const plan=api.planHeadline(text,{max:150,min:64,lines:4});assert.equal(plan.size,64);assert.ok(plan.rows.length<=4);
    assert.ok(warnings.some(warning=>warning.startsWith('magazine-interview fit-warning:')));
    assert.doesNotThrow(()=>api.render({...scenes[0],data:{...scenes[0].data,title:text}}));
  }finally{console.warn=original;}
});

test('Alexandria is the headline default; saved typography wins; brand keeps the fixed palette',()=>{
  setSsrFrame(100);
  const plain=api.render(scenes[0]);assert.match(plain,/font-family:Alexandria/);
  assert.match(api.render(scenes[0],null,'Cairo'),/font-family:Cairo/);
  assert.equal(api.render(scenes[0],null,null,{ground:'#FFFFFF',ink:'#000000',accent:'#00FFCC',onAccent:'#000000'}),plain);
});

test('statement retains words in the lower band for null/high heads',()=>{
 setSsrFrame(100);const scene=scenes.find(s=>s.family==='statement');for(const head of [null,{x:300,y:300,width:400,height:600}])assert.match(api.render(scene,head),/data-statement-placement="lower"/);
});

test('caption geometry and furniture band fit ig-reels-organic',()=>{
  assert.equal(api.getSceneGeometry('magazine-interview','takeover').captionCenter,api.MAGAZINE_CAPTION.takeoverCenter);
  for(const center of [api.MAGAZINE_CAPTION.takeoverCenter,api.MAGAZINE_CAPTION.splitCenter]){
    const band=api.safeWidthFor(center-64,128,'ig-reels-organic',{inset:32});
    assert.equal(api.fitsSafeZone({left:band.left,top:center-64,width:band.width,height:128},'ig-reels-organic').ok,true);
    assert.ok(band.left>=65);assert.ok(band.left+band.width<=853);
  }
  for(const box of [{left:65,top:270,width:950,height:50},{left:65,top:1436,width:788,height:34},{left:65,top:1300,width:788,height:78}])assert.equal(api.fitsSafeZone(box,'ig-reels-organic').ok,true);
  assert.match(api.caption(),/top:1300px;left:65px;width:788px/);assert.match(api.caption(true),/#0B1A2C/);
});

test('lower content clears the right UI rail in both directions',()=>{
  setSsrFrame(100);
  for(const data of [pilot.SAMPLES['checklist-missing'],english.checklist]){
    const html=api.render(make('checklist',data));
    const rings=[...html.matchAll(/top:([\d.]+)px;(right|left):([\d.]+)px"><svg width="78" height="78"/g)];
    assert.equal(rings.length,4);
    for(const [,top,side,offset] of rings){
      const left=side==='right'?1080-Number(offset)-78:Number(offset);
      assert.equal(api.fitsSafeZone({left,top:Number(top),width:78,height:78},'ig-reels-organic').ok,true);
    }
  }
  const chapter=api.render(scenes.find(scene=>scene.family==='chapter-quote'));
  assertStyleIdentity(chapter,pilot.renderPilot('chapter-quote',scenes.find(s=>s.family==='chapter-quote').data),scenes.find(s=>s.family==='chapter-quote').data,'chapter-quote');
  const comment=api.render(scenes.find(scene=>scene.family==='comment'));
  assert.match(comment,/top:1096px;right:227px/);
  const process=api.render(scenes.find(scene=>scene.family==='process'));
  assert.match(process,/top:1044px;right:227px/);
});

test('classic split scenes retain their existing shared graphics panel',()=>{
  for(const family of ['intro','proof','process','comparison','comment','follow','chapter-quote']){
    const scene=api.editSceneSchema.parse({...scenes.find(scene=>scene.family===family),layout:'split'});
    const html=api.render(scene);assert.ok(html.length>400);assert.doesNotMatch(html,/NaN|Infinity/);
  }
});

test('verdict rejects bad scores, row counts, ordering and out-of-scene cues',()=>{
  const scene=api.magazineSceneSchema.parse(make('verdict',structuredClone(api.magazineTemplateData.verdict)));
  assert.match(scene.data.question,/مثال/);assert.deepEqual(api.validateMagazineTiming(scene),[]);
  for(const rows of [[{label:'A',value:-1,outOf:10,atFrame:10},{label:'B',value:2,outOf:10,atFrame:20}],[{label:'A',value:11,outOf:10,atFrame:10},{label:'B',value:2,outOf:10,atFrame:20}],[],Array.from({length:5},()=>scene.data.rows[0])])assert.equal(api.magazineSceneSchema.safeParse({...scene,data:{...scene.data,rows}}).success,false);
  for(const data of [{...scene.data,verdictFrame:scene.durationInFrames},{...scene.data,rows:scene.data.rows.map(row=>({...row,atFrame:30}))},{...scene.data,verdictFrame:50}]){
    assert.ok(api.validateMagazineTiming({...scene,data}).length);
    assert.equal(api.magazineSceneSchema.safeParse({...scene,data}).success,false);
  }
  for(const count of [2,4]){
    const data={...scene.data,rows:Array.from({length:count},(_,i)=>({label:'Example',value:0,outOf:0,atFrame:20+i*12})),verdictFrame:84};
    for(const verdict of ['A single line','Example: includes: punctuation'])for(const frame of frames){setSsrFrame(frame);assert.doesNotMatch(api.render({...scene,data:{...data,verdict}}),/NaN|Infinity/);}
  }
});

test('magazine-flip preserves pilot geometry, late shadow fade and outgoing child',()=>{
  // Compare every layer's CSS values independent of serialization/attribute order.
  const layerStyles=html=>[...html.matchAll(/<div\b[^>]*\bstyle="([^"]*)"/g)].map(([,css])=>
    Object.fromEntries(css.split(';').filter(Boolean).map(s=>{const i=s.indexOf(':');return [s.slice(0,i),s.slice(i+1)];})));
  for(const t of [0,.5,13/14,1])for(const outgoingHeight of [undefined,1080]){
    setSsrFrame(20+t*14);const html=api.transition(outgoingHeight);assert.doesNotMatch(html,/NaN|Infinity/);
    const g=pilot.turnGeo(t);
    assert.deepEqual(api.magazineFlipGeometry(t),{angle:g.ang,perspective:g.D,edge:g.edge,shade:g.shade,castFade:g.castFade},`pilot geometry at progress ${t}`);
    const actual=layerStyles(html),expected=layerStyles(pilot.renderTurn(t));
    assert.deepEqual(actual.shift(),{position:'absolute',left:'0',top:'0',width:'1080px',height:'1920px','pointer-events':'none'},'unchanged page width and canvas');
    // Only the outgoing page height and the cast shadow's height/clip may differ.
    for(const style of actual){
      if(style.transform || style['mix-blend-mode']==='multiply'){
        assert.equal(style.height,outgoingHeight===undefined?undefined:`${outgoingHeight}px`,'height confined to outgoing panel');
        delete style.height;
      }
      if(style['mix-blend-mode']==='multiply'){
        assert.equal(style['clip-path'],`inset(0 0 0 ${Math.max(0,Math.min(1080,g.edge))}px)`,'cast shadow clips at pilot page edge');
        delete style['clip-path'];
      }
    }
    for(const style of expected)if(style['mix-blend-mode']==='multiply'){
      assert.equal(style.height,'100%','pilot shadow originally spans the page');
      delete style.height;
    }
    assert.deepEqual(actual,expected,`pilot angle, hinge, perspective, shadow, gradients and edge width at progress ${t}`);
    assert.equal((html.match(/Outgoing page/g)??[]).length,t===1?0:1);
    if(t<1)assert.match(html,/<div\b[^>]*style="[^"]*transform:rotateY\([^"]*"[^>]*><article>Outgoing page<\/article>/,'outgoing child turns with the page');
  }
  assert.equal(api.magazineFlipGeometry(0).angle,0);assert.equal(api.magazineFlipGeometry(1).angle,92);
});

test('pilot inks and authored copy survive geometry and timing adaptations',()=>{
 for(const key of [...families,'intro-long','checklist-missing'])for(const frame of frames){setSsrFrame(frame);const scene=mapSample(key);assertStyleIdentity(api.render(scene),pilot.renderPilot(scene.family,scene.data),scene.data,scene.family);}
});
