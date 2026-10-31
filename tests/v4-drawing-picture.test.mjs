import test from 'node:test';
import assert from 'node:assert/strict';
import {styleCheckProps} from './helpers/v4-style-check.mjs';
import {bundleEngine,setSsrFrame} from './helpers/engine-bundle.mjs';
import {compileEdit} from '../engine/src/prepared-edit/timeline.ts';
import {footageFrameState} from '../engine/src/prepared-edit/footage.ts';
import {graphicsTransitionIssues} from '../engine/src/prepared-edit/graphics-transitions.ts';
import {TRANSITION_RULES} from '../engine/src/prepared-edit/graphics-transitions.ts';
import {transitionSample} from './helpers/ssr-frames.mjs';
import {ARABIC_SCENES} from './fixtures/arabic-scenes.mjs';
import {getPreviewDefinition} from '../engine/src/library-preview/fixtures.ts';

const api=await bundleEngine(`
 import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {useCurrentFrame} from 'remotion';
 import {PreparedEdit} from './engine/src/prepared-edit/PreparedEdit';
 import {FAMILY_DESIGNS} from './engine/src/styles/family-designs';
 export {getStyleLayout} from './engine/src/styles/themes';
 export {getStyleCaption} from './engine/src/styles/themes';
 export {getSceneGeometry} from './engine/src/creative-kit/primitives';
 export {slabEdges} from './engine/src/core/transitions-v4/ink-slab';
 export {lensZoomMotion} from './engine/src/core/transitions-v4/lens-zoom';
 export {magazineFlipGeometry} from './engine/src/core/transitions-v4/magazine-flip';
 const Stub=({scene})=><aside data-scene={scene.id} data-frame={useCurrentFrame()}/>;
 export const render=(props)=>{
  const saved=FAMILY_DESIGNS[props.edit.style];
  FAMILY_DESIGNS[props.edit.style]=Object.fromEntries(props.edit.scenes.map(s=>[s.family,Stub]));
  try{return renderToStaticMarkup(<PreparedEdit {...props}/>);}finally{FAMILY_DESIGNS[props.edit.style]=saved;}
 };
`,{ssr:true,media:true,timeline:true});

// A small SSR tree reader: assertions follow actual ancestors, so a mask on a sibling cannot pass.
function tree(html){
 const root={children:[]},stack=[root],nodes=[];
 for(const tag of html.matchAll(/<([^>]+)>/g)){
  if(tag[1].startsWith('/')){const node=stack.pop();node.html=html.slice(node.start,tag.index+tag[0].length);continue;}
  if(tag[1].startsWith('!'))continue;
  const name=tag[1].match(/^\S+/)[0];
  const attrs=Object.fromEntries([...tag[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([,k,v])=>[k,v.replaceAll('&quot;','"')]));
  const node={name,attrs,parent:stack.at(-1),children:[],start:tag.index};
  node.style=Object.fromEntries((attrs.style??'').split(';').filter(Boolean).map(s=>{const i=s.indexOf(':');return [s.slice(0,i),s.slice(i+1)];}));
  node.parent.children.push(node);nodes.push(node);
  if(!['link','meta','img','input','br','hr'].includes(name)&&!tag[1].endsWith('/'))stack.push(node);
 }
 return nodes;
}
const ancestors=node=>{const rows=[];for(let p=node.parent;p?.parent;p=p.parent)rows.push(p);return rows;};
const readProps=style=>styleCheckProps(style);

for(const [kind,style] of [['ink-slab','kinetic-paper'],['lens-zoom','liquid-glass'],['magazine-flip','magazine-interview']]){
 for(const layout of kind==='magazine-flip'?['split']:['presenter','split'])test(`${kind}: ${layout} into takeover retains the single plate, outgoing geometry and uncovered picture`,()=>{
  const props=readProps(style),edit=props.edit;
  const index=layout==='presenter'?1:3,cut=edit.scenes[index].fromFrame,duration=14;
  edit.transitions=[{kind,atFrame:cut,durationInFrames:duration}];
  const original=structuredClone(edit),compiled=compileEdit(edit);
  assert.deepEqual(graphicsTransitionIssues(edit.transitions,edit.scenes),[]);
  const end=cut+(kind==='magazine-flip'?7:duration);
  const seam=api.getStyleLayout(style).seam;
  for(const frame of new Set([cut-(kind==='ink-slab'?10:14),cut-1,cut,cut+3,cut+6,...(kind==='magazine-flip'?[]:[cut+7]),end-1])){
   setSsrFrame(frame);
   const html=api.render(props),nodes=tree(html),videos=nodes.filter(n=>n.name==='video');
   assert.equal(videos.length,1,`frame ${frame}: one continuous plate`);
   assert.equal(nodes.filter(n=>n.name==='audio').length,1,'one unchanged audio carrier');
   const video=videos[0],win=video.parent.parent;
   const retained={...edit,scenes:edit.scenes.map((s,i)=>i===index?{...s,layout}:s)};
   const expected=footageFrameState(retained,frame,{aspect:props.plate.height/props.plate.width,canvasHeight:seam}).geo;
   assert.equal(parseFloat(win.style.top),expected.windowTop);
   assert.equal(parseFloat(win.style.height),expected.windowHeight);
   assert.equal(parseFloat(video.parent.style.left),expected.videoLeft);
   assert.equal(parseFloat(video.parent.style.top),expected.videoTop);
   assert.equal(parseFloat(video.parent.style.width),expected.videoWidth,'camera uses current nominal frame');
   assert.equal(win.parent.attrs['data-drawing-plate'],layout);
   assert.equal(win.parent.style['clip-path'],undefined,'plate remains under the lens crossfade, including transparent outgoing graphics');
   const incoming=nodes.filter(n=>n.attrs['data-scene']===edit.scenes[index].id);
   if(kind==='lens-zoom' && frame<cut)assert.equal(incoming.length,0,'no unmasked incoming during lead');
   else{
    assert.equal(incoming.length,1);
    const masks=ancestors(incoming[0]).filter(n=>n.style['clip-path']);
    if(kind==='ink-slab'){
     const {trail}=api.slabEdges((frame-cut)/duration*12);
     assert.ok(masks.some(n=>n.style['clip-path']===`inset(0 0 0 ${Math.max(0,Math.min(1080,trail))}px)`),'incoming exists only behind trailing edge');
     if(frame===cut || frame===cut+7)assert.ok(trail>0,'left pixels still show outgoing footage at cut and midpoint');
    }else if(kind==='lens-zoom'){
     const lens=masks.find(n=>/^circle\([\d.]+px at 50% 50%\)$/.test(n.style['clip-path']));
     assert.ok(lens,'all incoming graphics are inside the lens disc');
     const R=Number(lens.style['clip-path'].match(/[\d.]+/)[0]);
     const cx=parseFloat(lens.style.left)+R,cy=parseFloat(lens.style.top)+R;
     if(frame===cut || frame===cut+7)assert.ok([0,1080].some(x=>Math.hypot(x-cx,1919-cy)>R),'an uncovered lower pixel keeps footage at cut and midpoint');
    }else{
     const {edge}=api.magazineFlipGeometry((frame-cut)/duration+.5);
     assert.ok(masks.some(n=>n.style['clip-path']===`inset(0 0 0 ${edge}px)`),'incoming exists only under the turned page');
    }
   }
   const caption=nodes.find(n=>n.attrs['data-caption-layer']!==undefined);
   assert.ok(caption,'one independent speech layer');
   assert.equal(nodes.filter(n=>n.attrs['data-caption-layer']!==undefined).length,1);
   assert.ok(!nodes.some(n=>n.attrs['data-drawing-caption']!==undefined),'no per-mask caption regions');
   const picture=ancestors(video).find(n=>n.attrs['data-drawing-picture']!==undefined);
   assert.equal(picture?.style.isolation,'isolate','scene z-indices cannot escape the picture');
   assert.ok(!ancestors(caption).includes(picture),'unfiltered captions remain outside the isolated picture');
   assert.ok(nodes.some(n=>n.attrs['data-scene']===edit.scenes[index-1].id),'outgoing graphics retained');
   assert.doesNotMatch(html,/NaN|Infinity/);
  }
  for(const frame of [end,end+1]){
   setSsrFrame(frame);assert.equal(tree(api.render(props)).filter(n=>n.name==='video').length,0,'takeover visibility resumes after effect');
   const nodes=tree(api.render({...props,__editorSkipHiddenVideo:false})),video=nodes.find(n=>n.name==='video');
   const expected=footageFrameState(edit,frame,{aspect:props.plate.height/props.plate.width,canvasHeight:seam}).geo;
   assert.equal(parseFloat(video.parent.parent.style.top),expected.windowTop,'incoming geometry applies after effect');
   assert.equal(video.parent.parent.parent.attrs['data-drawing-plate'],undefined);
  }
  assert.deepEqual(edit,original,'authored boundaries and words unchanged');
  assert.deepEqual(compileEdit(edit),compiled,'caption and audio timeline unchanged');
 });
}

test('drawing handovers keep the plate camera clock moving across the nominal cut',()=>{
 const props=readProps('kinetic-paper');
 props.edit.camera=[{atFrame:0,scale:1,focusX:.5,focusY:.5},{atFrame:200,scale:1.25,focusX:.4,focusY:.5}];
 for(const frame of [120,123,126]){
  setSsrFrame(frame);const video=tree(api.render(props)).find(n=>n.name==='video');
  const retained={...props.edit,scenes:props.edit.scenes.map(s=>s.id==='process'?{...s,layout:'presenter'}:s)};
  const expected=footageFrameState(retained,frame,{aspect:1920/1080,canvasHeight:1056}).geo;
  assert.equal(video.parent.style.width,`${expected.videoWidth}px`);
 }
});

const captionLayer=nodes=>nodes.find(n=>n.attrs['data-caption-layer']!==undefined);
const transitions=[['ink-slab','kinetic-paper'],['lens-zoom','liquid-glass'],['magazine-flip','magazine-interview'],['paper-swap','paper-collage'],['paper-pull','calligraphic-receipts']];
for(const [kind,style] of transitions)for(const skin of [undefined,'spoken-box','karaoke','bold-outline','soft-shadow','paper-tag'])test(`${kind}: ${skin??'style caption'} is a single unmasked line above the transition at lead, cut, midpoint and tail`,()=>{
 const edit=transitionSample(kind);edit.style=style;
 edit.transitions[0].durationInFrames=14;
 edit.scenes[0].layout=kind==='paper-pull'?'takeover':'split';
 edit.scenes[1].chapter={ground:'#050916',ink:'#FFFFFF',accent:'#24374F',onAccent:'#FFFFFF'};
 edit.captions={status:'reviewed',reviewer:'SSR fixture',grouping:'single',skin,words:[{text:'Outgoing',startMs:0,endMs:2000,confidence:1},{text:'Incoming',startMs:2000,endMs:6000,confidence:1}]};
 assert.deepEqual(graphicsTransitionIssues(edit.transitions,edit.scenes),[]);
 const props={edit,plate:{src:'sample.mp4',width:1080,height:1920}};
 const original=structuredClone(edit),compiled=compileEdit(edit);
 const rule=TRANSITION_RULES[kind],end=60+(rule.centred?7:14);
 for(const frame of new Set([60-rule.lead,59,60,60+Math.floor((end-60)/2),end-1,end])){
  setSsrFrame(frame);
  const html=api.render(props),nodes=tree(html),layer=captionLayer(nodes);
  assert.equal(nodes.filter(n=>n.attrs['data-caption-layer']!==undefined).length,1);
  assert.equal((html.match(/>Outgoing</g)??[]).length,frame<60?1:0,`frame ${frame}: outgoing cue occurs once before cut`);
  assert.equal((html.match(/>Incoming</g)??[]).length,frame<60?0:1,`frame ${frame}: incoming cue occurs once from cut`);
  assert.doesNotMatch(html,/data-drawing-caption|NaN|Infinity/);
  const picture=nodes.find(n=>n.attrs['data-drawing-picture']!==undefined);
  assert.equal(picture.style.isolation,'isolate','all scene and transition z-indices are contained');
  assert.equal(layer.parent,picture.parent,'caption and picture are sibling stacking contexts');
  assert.equal(layer.style.isolation,'isolate');
  assert.ok(layer.parent.children.indexOf(layer)>layer.parent.children.indexOf(picture),'caption paints above the complete transition stack');
  for(const n of [layer,...ancestors(layer)])for(const key of ['clip-path','mask','overflow','opacity','transform','filter'])assert.equal(n.style[key],undefined,`caption ancestor cannot ${key}`);
  for(const transition of nodes.filter(n=>n.attrs['data-transition']!==undefined))assert.ok(ancestors(transition).includes(picture),'transition is confined beneath caption');
  if(kind==='paper-swap' && frame===60)assert.ok(nodes.some(n=>n.attrs['data-transition']===kind),'opaque paper sheet is present at the cut');
  const hardCut=captionLayer(tree(api.render({...props,edit:{...edit,transitions:[]}})));
  assert.equal(layer.html,hardCut.html,`frame ${frame}: placement, scene context, cue timing and paint match a hard cut`);
  if(skin){
   const line=nodes.find(n=>n.attrs['data-caption-skin']===skin);
   assert.equal(nodes.filter(n=>n.attrs['data-caption-skin']).length,1,'one caption line');
   const layout=frame<60?edit.scenes[0].layout:edit.scenes[1].layout;
   const center=layout==='takeover'?api.getStyleCaption(style).takeoverCenter:api.getSceneGeometry(style,layout).captionCenter;
   assert.ok(Math.abs(parseFloat(line.style.top)+parseFloat(line.style.height)/2-center)<=.5,`frame ${frame}: ${layout} caption center ${center}`);
  }
 }
 assert.deepEqual(edit,original);
 assert.deepEqual(compileEdit(edit),compiled,'authored caption/audio timing stays unchanged');
});

test('lowered and hidden families still switch on the manifest cut during a drawing handover',()=>{
 for(const family of ['figures','chat-thread','proof-screen','arabic-type','creator-cta','ticket-offer','verdict']){
  const style=family==='ticket-offer'?'kinetic-paper':family==='verdict'?'magazine-interview':'grid-glide';
  const edit=transitionSample('ink-slab');edit.style=style;
  const scene=structuredClone(ARABIC_SCENES.find(s=>s.family===family)??getPreviewDefinition('scene:'+family).fixture.scene);
  assert.ok(scene,`fixture for ${family}`);
  edit.scenes[1]={...scene,id:'new',fromFrame:60,durationInFrames:120};
  edit.captions={status:'reviewed',reviewer:'SSR fixture',skin:'spoken-box',words:[{text:'Speech',startMs:0,endMs:6000,confidence:1}]};
  const props={edit,plate:{src:'sample.mp4',width:1080,height:1920}};
  for(const frame of [50,59,60,67,83,84]){
   setSsrFrame(frame);
   const nodes=tree(api.render(props)),layer=captionLayer(nodes);
   const expected=captionLayer(tree(api.render({...props,edit:{...edit,transitions:[]}})));
   assert.equal(layer.html,expected.html,`${family} at ${frame}: family rules match hard cut`);
   const hidden=frame>=60 && ['creator-cta','verdict'].includes(family);
   assert.equal((layer.html.match(/>Speech</g)??[]).length,hidden?0:1,`${family} at ${frame}: expected family visibility`);
   if(frame>=60 && ['figures','chat-thread','proof-screen','arabic-type'].includes(family)){const line=nodes.find(n=>n.attrs['data-caption-skin']);assert.ok(parseFloat(line.style.top)>1300,'full-frame family keeps lowered presenter placement');}
  }
 }
});

test('a layout transition cannot fade or duplicate the spoken line',()=>{
 const edit=transitionSample('whiteout');edit.transitions=[];edit.style='grid-glide';
 edit.scenes[0]={...edit.scenes[0],family:'statement',layout:'presenter',data:{kicker:'Example',title:'Example'}};
 edit.scenes[1].layout='split';
 edit.layoutTransitions=[{kind:'window-morph',atFrame:60,durationInFrames:24,from:'presenter',to:'split'}];
 edit.captions={status:'reviewed',reviewer:'SSR fixture',skin:'spoken-box',words:[{text:'Speech',startMs:0,endMs:6000,confidence:1}]};
 const props={edit,plate:{src:'sample.mp4',width:1080,height:1920}};
 for(const frame of [59,60,61,64,72,82,83,84]){
  setSsrFrame(frame);
  const layer=captionLayer(tree(api.render(props)));
  const hardCut=captionLayer(tree(api.render({...props,edit:{...edit,layoutTransitions:[]}})));
  assert.equal((layer.html.match(/>Speech</g)??[]).length,1);
  assert.equal(layer.html,hardCut.html,`frame ${frame}: one unchanged caption at nominal placement`);
 }
});

test('short, long and odd drawing durations release outgoing geometry on the actual effect end',()=>{
 for(const [kind,style] of [['ink-slab','kinetic-paper'],['lens-zoom','liquid-glass'],['magazine-flip','magazine-interview']])for(const durationInFrames of [8,15,24]){
  const props=readProps(style),cut=366;
  props.edit.transitions=[{kind,atFrame:cut,durationInFrames}];
  const end=cut+(kind==='magazine-flip'?Math.ceil(durationInFrames/2):durationInFrames);
  setSsrFrame(end-1);assert.match(api.render(props),/data-drawing-plate="split"/);
  setSsrFrame(end);assert.doesNotMatch(api.render(props),/data-drawing-plate=/);
 }
});

test('with no look, settled captions and later overlays remain above isolated scene z-indices',()=>{
 const props=readProps('kinetic-paper');delete props.edit.look;
 props.edit.transitions.push({kind:'whiteout',atFrame:180,durationInFrames:14});
 for(const frame of [120,127,134,180]){
  setSsrFrame(frame);const nodes=tree(api.render(props));
  const picture=nodes.find(n=>n.attrs['data-drawing-picture']!==undefined);
  assert.equal(picture.style.isolation,'isolate');
  const captions=nodes.filter(n=>n.attrs['data-caption-skin']);assert.ok(captions.length);
  for(const caption of captions)assert.ok(!ancestors(caption).includes(picture));
 }
});
