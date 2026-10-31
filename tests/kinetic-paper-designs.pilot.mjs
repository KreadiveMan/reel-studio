import {assertStyleIdentity} from './helpers/style-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bundleEngine, setSsrFrame} from './helpers/engine-bundle.mjs';
import {ARABIC_SCENES} from './fixtures/arabic-scenes.mjs';

const families = ['intro','proof','process','checklist','comparison','statement','count','comment','follow','ticket-offer','comment-stack'];
const names = ['Intro','Proof','Process','Checklist','Comparison','Statement','CountSplit','Comment','Follow','TicketOffer','CommentStack'];
const frames = [0,12,50,100];
const pilotPath = '../docs/superpowers/specs/assets/v4-pilots/kinetic-paper/';
let pilotSource = readFileSync(new URL(pilotPath+'design.tsx',import.meta.url),'utf8').replaceAll('\r\n','\n');
pilotSource = pilotSource.replace("'@rs/core/type'","'./engine/src/core/type'");
const standStart = pilotSource.indexOf('export const StandIn:');
const standEnd = pilotSource.indexOf('/** Headline lines pasted',standStart);
pilotSource = pilotSource.slice(0,standStart)+'export const StandIn: React.FC<any> = () => null;\n'+pilotSource.slice(standEnd);
const entry = readFileSync(new URL(pilotPath+'entry.tsx',import.meta.url),'utf8');
const sampleSource = entry.slice(entry.indexOf('const heading ='),entry.indexOf('const CAPTION ='));

const api = await bundleEngine(pilotSource+'\n'+sampleSource+`
  import {renderToStaticMarkup} from 'react-dom/server';
  import {KINETIC_PAPER_DESIGNS} from './engine/src/styles/kinetic-paper/designs';
  import {CopyContext,fit as portFit,useDesign,statementSafety} from './engine/src/styles/kinetic-paper/designs/kit';
  import {sceneCopy} from './engine/src/styles/scene-copy';
  import {editSceneSchema} from './engine/src/prepared-edit/schema';
  import {getSceneGeometry} from './engine/src/creative-kit/primitives';
  import {fitsSafeZone,safeWidthFor} from './engine/src/core/type';
  import {TypographyProvider,ChapterThemeProvider} from './engine/src/creative-kit/chapter-theme';
  import {InkSlab as PortSlab,slabEdges as portEdges,inkSlabPictureMasks} from './engine/src/core/transitions-v4/ink-slab';
  ${families.map((family,i)=>`import {${names[i]} as Port${names[i]}} from './engine/src/styles/kinetic-paper/designs/${family}';`).join('\n')}
  const bodies = {${families.map((family,i)=>`${JSON.stringify(family)}:Port${names[i]}`).join(',')}};
  const pilots = {${families.map((family,i)=>`${JSON.stringify(family)}:${names[i]}`).join(',')}};
  const geometry = {windowTop:1056,windowHeight:864,videoWidth:1080,videoLeft:0,videoTop:-340};
  const props = (scene,extra={}) => ({scene,sectionIndex:1,style:'kinetic-paper',geometry,aspect:16/9,seam:1056,...extra});
  export {KINETIC_PAPER_DESIGNS,editSceneSchema,getSceneGeometry,fitsSafeZone,safeWidthFor,portFit,statementSafety,portEdges,inkSlabPictureMasks};
  export const render = (scene,extra={}) => renderToStaticMarkup(React.createElement(KINETIC_PAPER_DESIGNS[scene.family],props(scene,extra)));
  export const body = scene => renderToStaticMarkup(<CopyContext.Provider value={sceneCopy(scene.data)}>{React.createElement(bodies[scene.family],props(scene))}</CopyContext.Provider>);
  export const pilot = (family,data) => renderToStaticMarkup(React.createElement(pilots[family],{d:data,n:'01',seam:1056,tap:80}));
  export const transition = () => renderToStaticMarkup(<PortSlab atFrame={0} durationInFrames={12} fps={30}><aside>Incoming scene</aside></PortSlab>);
  const Font = () => <output>{useDesign().HEAD}</output>;
  export const font = fontFamily => renderToStaticMarkup(<TypographyProvider fontFamily={fontFamily}><Font/></TypographyProvider>);
  export const brand = (scene,chapter) => renderToStaticMarkup(<ChapterThemeProvider chapter={chapter}>{React.createElement(KINETIC_PAPER_DESIGNS[scene.family],props(scene))}</ChapterThemeProvider>);
`,{ssr:true,media:true});

const fixtures = families.map(family=>ARABIC_SCENES.find(scene=>scene.family===family));
const parsed = scene => api.editSceneSchema.parse(scene);
const textOf = html => html.replace(/<[^>]*>/g,'').replaceAll('&#x27;',"'").replaceAll('&amp;','&');
const makeScene = (family,data) => parsed({...structuredClone(fixtures.find(scene=>scene.family===family)),data});
const sampleScene = key => {
  const family = key.replace(/-(long|missing)$/,'');
  let data = structuredClone(api.SAMPLES[key]);
  if (family==='ticket-offer')data = {kicker:data.kicker,title:data.title,ticket:{label:'دعوة',value:data.serial,detail:data.detail,atFrame:6},footer:'شروط المثال'};
  if (family==='comment-stack')data = {kicker:data.kicker,title:'أسئلة',comments:data.comments.map((text,i)=>({author:'تعليق',text,atFrame:[14,36,58][i]})),keyword:'مثال',prompt:'اكتب الكلمة'};
  if (family==='count')Object.assign(data,{rollFrame:22,rollDuration:30,unitFrame:34,badgeFrame:34});
  if (['intro','proof','process','comparison','comment','follow'].includes(family))data.caption = 'مثال';
  return makeScene(family,data);
};

test('the eleven approved families and the three new scene families export a design',()=>assert.deepEqual(Object.keys(api.KINETIC_PAPER_DESIGNS), [...families, 'figures', 'chat-thread', 'proof-screen']));

for(const scene of fixtures)test(`${scene.family}: parsed fixture at four frames`,()=>{
  for(const frame of frames){
    setSsrFrame(frame);
    const html = api.render(parsed(scene));
    assert.ok(html.length>400);
    assert.doesNotMatch(html,/NaN|undefined|Infinity|ADMIT ONE|#4A4039|#5A4D44/);
    const primary = scene.family==='comment-stack' ? scene.data.comments.map(c=>c.text).join(' ') : scene.data.title ?? scene.data.label ?? scene.data.keyword ?? scene.data.handle;
    assert.ok(primary.split(/\s+/).every(word=>textOf(html).includes(word)),`${scene.family}@${frame}: supplied copy`);
  }
});

test('pilot samples, long title and four missing items render at four frames',()=>{
  for(const key of [...families,'intro-long','checklist-missing'])for(const frame of frames){
    setSsrFrame(frame);
    assert.doesNotMatch(api.render(sampleScene(key)),/NaN|undefined|Infinity/);
  }
});

const english = {
  intro:{kicker:'Example',title:'One clear idea',subtitle:'Explain the idea',caption:'Example'},
  proof:{label:'Supplied value',value:42,suffix:'x',source:'Illustrative source',caption:'Example'},
  process:{title:'Three clear steps',steps:[{title:'Plan',detail:'Choose the idea'},{title:'Build',detail:'Put it together'},{title:'Review',detail:'Check the result'}],caption:'Example'},
  checklist:{kicker:'Example',title:'Check the plan',variant:'missing',items:[{label:'Plan',detail:'Choose the idea',atFrame:15},{label:'Build',detail:'Put it together',atFrame:45},{label:'Review',detail:'Check the result',atFrame:75},{label:'Publish',detail:'Share the result',atFrame:90}]},
  comparison:{title:'A clear difference',beforeTitle:'Before',beforeDetail:'Separate ideas',afterTitle:'After',afterDetail:'One clear idea',caption:'Example'},
  statement:{kicker:'Example',title:'One clear idea'},
  count:{kicker:'Example',title:'Supplied value',value:42,suffix:'x',unit:'of the sample',rollFrame:22,rollDuration:30,unitFrame:34,badge:'Example',badgeFrame:34},
  comment:{keyword:'guide',promise:'An illustrative example',caption:'Example'},
  follow:{handle:'@example',message:'Practical ideas',caption:'Example'},
  'ticket-offer':{kicker:'Invitation',title:'Book your place',ticket:{label:'Session',value:'No. 0042',detail:'A supplied offer',atFrame:6},footer:'Actual conditions'},
  'comment-stack':{kicker:'Discussion',title:'Your questions',comments:[{author:'Viewer',text:'Explain this idea',atFrame:14},{author:'Viewer two',text:'What happens next?',atFrame:36}],keyword:'guide',prompt:'Write the word'},
};
for(const family of families)test(`${family}: English is left aligned and mirrored`,()=>{
  for(const frame of frames){
    setSsrFrame(frame);
    const html = api.render(makeScene(family,english[family]));
    assert.match(html,/direction:ltr;text-align:left/);
    assert.doesNotMatch(html,/[\u0600-\u06FF]|direction:rtl/);
    if(!['follow','ticket-offer','comment-stack'].includes(family))assert.match(html,/left:65px/);
  }
});

test('English ticket mirrors its asymmetric geometry and Arabic serials have no letter spacing',()=>{
  setSsrFrame(100);
  const en = api.render(makeScene('ticket-offer',english['ticket-offer']));
  assert.match(en,/translate\(880 0\) scale\(-1 1\)/);
  assert.match(en,/translate\(232 0\) scale\(-1 1\)/);
  const ar = structuredClone(api.SAMPLES['ticket-offer']);
  const scene = sampleScene('ticket-offer');
  scene.data.ticket.value = 'جلسة واحدة';
  const html = api.render(parsed(scene));
  assert.doesNotMatch(html,/rotate\(-90deg\)/);assert.ok(scene.data.ticket.value.split(/\s+/).every(word=>textOf(html).includes(word)));
});

test('classic split fallbacks retain the fixed palette under a creator brand',()=>{
  setSsrFrame(50);
  const brand = {ground:'#FFFFFF',ink:'#000000',accent:'#00FFCC',onAccent:'#000000'};
  for(const family of ['intro','proof','process','comparison','comment','follow','ticket-offer','comment-stack']){
    const scene = makeScene(family,english[family]);
    scene.layout = 'split';
    assert.equal(api.brand(scene,null),api.brand(scene,brand));
  }
});

test('long parsed titles and one/four/five item cue extremes do not throw',()=>{
  for(const sample of fixtures.filter(scene=>'title' in scene.data))for(const frame of frames){
    const scene = structuredClone(sample), max = scene.family==='intro'?64:['process','comparison'].includes(scene.family)?52:['ticket-offer','comment-stack'].includes(scene.family)?100:140;
    scene.data.title = 'A long complete title with whole words '.repeat(8).slice(0,max);
    setSsrFrame(frame);
    assert.doesNotMatch(api.render(parsed(scene)),/NaN|Infinity/);
  }
  for(const count of [1,4,5])for(const equal of [false,true])for(const frame of frames){
    setSsrFrame(frame);
    const data = {...english.checklist,items:Array.from({length:count},(_,i)=>({label:'A supplied complete item '+i,detail:'A supplied detail',atFrame:equal?20:15+i*20}))};
    assert.doesNotMatch(api.render(makeScene('checklist',data)),/NaN|Infinity/);
  }
});

test('unfittable text keeps the smallest size, line budget and all words, and warns',()=>{
  const warnings=[],old=console.warn;console.warn=message=>warnings.push(message);
  try{
    const text='Unfittable whole words '.repeat(80), result=api.portFit(text,{width:100,size:196,min:88,lines:4});
    assert.equal(result.size,88);assert.equal(result.fits,false);assert.ok(result.lines.length<=4);
    assert.equal(result.lines.join(' ').trim(),text.trim());
    assert.ok(warnings.some(w=>w.startsWith('kinetic-paper fit-warning:')));
  }finally{console.warn=old;}
});

test('caption bands and the 65 px / y 250..1470 organic safe zone',()=>{
  for(const [layout,center] of [['takeover',1320],['split',1056]]){
    assert.equal(api.getSceneGeometry('kinetic-paper',layout).captionCenter,center);
    const band=api.safeWidthFor(center-64,128,'ig-reels-organic',{inset:32});
    assert.equal(api.fitsSafeZone({left:band.left,top:center-64,width:band.width,height:128},'ig-reels-organic').ok,true);
    if(center>=1150)assert.ok(band.left+band.width<853);
  }
  for(const box of [{left:65,top:250,width:950,height:890},{left:65,top:1150,width:787,height:320}])assert.equal(api.fitsSafeZone(box,'ig-reels-organic').ok,true);
  assert.equal(api.fitsSafeZone({left:65,top:1150,width:950,height:100},'ig-reels-organic').ok,false);
});

test('statement moves below null/high heads and preserves all words',()=>{
 setSsrFrame(50);const scene=parsed(fixtures.find(s=>s.family==='statement'));
 for(const head of [null,{x:300,y:300,width:400,height:600}]){const html=api.render(scene,{headBox:head});assert.match(html,/data-statement-placement="lower"/);assert.doesNotMatch(html,/<video/);}
 assert.equal(api.statementSafety(568).scale,1);
});

test('pilot font, creator font override, and fixed palette despite creator brand',()=>{
  assert.equal(api.font(null),'<output>Lalezar</output>');
  assert.equal(api.font('Cairo'),'<output>Cairo</output>');
  setSsrFrame(50);
  const scene=sampleScene('intro');
  assert.equal(api.brand(scene,null),api.brand(scene,{ground:'#FFFFFF',ink:'#000000',accent:'#00FFCC',onAccent:'#000000'}));
});

test('ink slab at three progress points matches pilot edges and mounts incoming once',()=>{
  for(const frame of [0,6,12]){
    setSsrFrame(frame);
    assert.deepEqual(api.portEdges(frame),api.slabEdges(frame));
    const html=api.transition(),{lead,trail}=api.slabEdges(frame);
    assert.equal((html.match(/Incoming scene/g)??[]).length,1);
    assert.ok(html.includes(`left:${lead}px`));
    const masks=api.inkSlabPictureMasks(frame,12);
    assert.deepEqual(masks,{
      incoming:`inset(0 0 0 ${Math.max(0,Math.min(1080,trail))}px)`,
      outgoing:`inset(0 ${Math.max(0,1080-Math.max(0,lead))}px 0 0)`,
    },`shared picture/caption masks at frame ${frame}`);
    // Match the parent of the incoming scene, not an unrelated clipped layer.
    const incoming=html.match(/<div data-ink-slab-incoming="" style="([^"]*)"><aside>Incoming scene<\/aside><\/div>/);
    assert.ok(incoming,'incoming scene is inside the shared-mask wrapper');
    if(frame<12)assert.ok(incoming[1].split(';').includes(`clip-path:${masks.incoming}`));
    else assert.doesNotMatch(html,/clip-path/);
    assert.doesNotMatch(html,/NaN|Infinity/);
  }
});

// Compare markup as a tree: attribute order is irrelevant. Only named, mandated
// adaptations are excluded: direction metadata, safe fit wrappers, head placement,
// the separate paper shadow and removed ticket decoration. All other numbers stay.
const tree = html => {
  const root={tag:'root',attrs:{},children:[]},stack=[root];
  for(const token of html.match(/<[^>]*>|[^<]+/g)??[]){
    if(token.startsWith('</')){stack.pop();continue;}
    if(token.startsWith('<')){
      const tag=token.match(/^<([^\s/>]+)/)?.[1];if(!tag)continue;
      const attrs=Object.fromEntries([...token.matchAll(/([^\s=<>]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
      const node={tag,attrs,children:[]};stack.at(-1).children.push(node);
      if(!['br','img','input','link','meta'].includes(tag)&&!token.endsWith('/>'))stack.push(node);
    }else stack.at(-1).children.push(token);
  }
  return root;
};
function canonical(node,family,isRoot=false){
  if(typeof node==='string')return node;
  if(textOfNode(node).includes('ADMIT ONE') && !node.children.some(c=>typeof c!=='string'))return null;
  const style=Object.fromEntries((node.attrs.style??'').split(';').filter(Boolean).map(s=>{const i=s.indexOf(':');return [s.slice(0,i),s.slice(i+1)];}));
  if(node.attrs['data-fit-width']!==undefined)return textOfNode(node);
  if(node.attrs['data-head-clear-bottom']!==undefined || node.attrs['data-number-scale']!==undefined)return node.children.map(c=>canonical(c,family)).flat().filter(c=>c!==null);
  if(family==='statement' && style.position==='absolute' && style.left==='10px' && style.top==='10px' && style['clip-path'] && style.background==='#15231F')return null;
  if(family==='statement' && (style.filter?.startsWith('drop-shadow') || node.children.some(c=>typeof c!=='string' && c.attrs?.style?.includes('left:10px;top:10px')))){
    delete style.filter;delete style.position;
  }
  if(isRoot){delete style.direction;delete style['text-align'];}
  if(family==='intro' && style['white-space']==='pre' && style['font-family']==='Cairo' && style['font-weight']==='700')style.right='65px';
  const attrs={...node.attrs};delete attrs.style;
  if(Object.keys(style).length)attrs.style=Object.fromEntries(Object.entries(style).sort());
  if(family==='ticket-offer' && node.tag==='g' && !Object.keys(node.attrs).length)return node.children.map(c=>canonical(c,family)).flat().filter(c=>c!==null);
  const children=node.children.map(c=>canonical(c,family)).flat().filter(c=>c!==null);
  const combined=[];
  for(const child of children){if(typeof child==='string' && typeof combined.at(-1)==='string')combined[combined.length-1]+=child;else combined.push(child);}
  return {tag:node.tag,attrs:Object.fromEntries(Object.entries(attrs).sort()),children:combined};
}
const textOfNode=node=>typeof node==='string'?node:node.children.map(textOfNode).join('');
const canon=(html,family)=>canonical(tree(html).children[0],family,true);

test('pilot material identity and primary copy after round-one adaptations',()=>{
 for(const family of families)for(const frame of frames){setSsrFrame(frame);const scene=sampleScene(family);assertStyleIdentity(api.render(scene),api.pilot(family,api.SAMPLES[family]),scene.data,family);}
});
