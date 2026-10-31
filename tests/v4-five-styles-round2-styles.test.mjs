import test from 'node:test';
import assert from 'node:assert/strict';
import {styleCheckProps} from './helpers/v4-style-check.mjs';
import {bundleEngine, setSsrFrame} from './helpers/engine-bundle.mjs';
import {getPreviewDefinition} from '../engine/src/library-preview/fixtures.ts';
import {ARABIC_SCENES} from './fixtures/arabic-scenes.mjs';

// Markup/geometry checks only. Browser typography and still review belong to Claude.
const api = await bundleEngine(`
  import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {FAMILY_DESIGNS} from './engine/src/styles/family-designs';
  import {TypographyProvider} from './engine/src/creative-kit/chapter-theme';
  import {measure} from './engine/src/core/type';
  import {ownSceneCopy} from './engine/src/style-kit/design-safety';
  import {tokGeo,tokLens} from './engine/src/styles/liquid-glass/designs/token-lens';
  export {measure,ownSceneCopy,tokGeo,tokLens};
  export const render=(style,scene,font,headBox=null)=>{
    const Design=FAMILY_DESIGNS[style][scene.family];
    return renderToStaticMarkup(<TypographyProvider fontFamily={font}><Design style={style} scene={scene} headBox={headBox} seam={1056} sectionIndex={2} geometry={{windowTop:1056,windowHeight:864,videoWidth:1080,videoLeft:0,videoTop:0}} aspect={1}/></TypographyProvider>);
  };
`, {ssr:true,media:true});
const fonts = [null,'Cairo','Tajawal'];
const fixture = family => structuredClone(ARABIC_SCENES.find(s=>s.family===family) ?? getPreviewDefinition('scene:'+family).fixture.scene);
const footage = (style,family) => styleCheckProps(style).edit.scenes.find(s=>s.family===family);
const render = (style,scene,frame,font='Cairo',head=null) => {setSsrFrame(frame); return tree(api.render(style,scene,font,head));};
function tree(html) {
  const root={attrs:{},style:{},children:[]}, stack=[root];
  for(const token of html.match(/<[^>]+>|[^<]+/g)??[]) {
    if(token.startsWith('<!--'))continue;
    if(token.startsWith('</')) {stack.pop(); continue;}
    if(!token.startsWith('<')) {stack.at(-1).children.push(token); continue;}
    const tag=token.match(/^<([^\s/>]+)/)[1];
    const attrs=Object.fromEntries([...token.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
    const style=Object.fromEntries((attrs.style??'').split(';').filter(Boolean).map(s=>{const i=s.indexOf(':'); return [s.slice(0,i),s.slice(i+1)];}));
    const node={tag,attrs,style,children:[],parent:stack.at(-1)};
    stack.at(-1).children.push(node);
    if(!token.endsWith('/>')&&!['img','meta','link','br','input'].includes(tag))stack.push(node);
  }
  return root;
}
const nodes = root => [root,...root.children.flatMap(c=>typeof c==='string'?[]:nodes(c))];
const find = (root,key,value) => nodes(root).find(n=>n.attrs[key]!==undefined&&(value===undefined||n.attrs[key]===String(value)));
const text = root => typeof root==='string'?root:root.children.map(text).join(' ');
const words = s => s.replaceAll('&amp;','&').replaceAll('&#x27;',"'").trim().split(/\s+/).join(' ');
const px = v => parseFloat(v)||0;
const measured = (content,n) => api.measure(content,{fontFamily:n.style['font-family'],fontSize:px(n.style['font-size']),fontWeight:px(n.style['font-weight']),letterSpacing:px(n.style['letter-spacing'])}).width;
const xOf = (n,width) => n.style.left!==undefined?px(n.style.left):width-px(n.style.right)-px(n.style.width);

test('1: comparison cards retain every title/detail inside padded widths, with an entirely mirrored LTR picture',()=>{
  for(const scene of [fixture('comparison'),footage('paper-collage','comparison')])for(const font of fonts)for(const frame of [54,90,119]) {
    const root=render('paper-collage',scene,frame,font), copy=api.ownSceneCopy(scene.data);
    const picture=find(root,'data-comparison-picture',copy.dir);
    assert.ok(picture); assert.equal(picture.style.transform,copy.ar?undefined:'scaleX(-1)');
    assert.equal(px(picture.style['z-index']),2);
    for(const [id,title,detail] of [['cmp-lb',scene.data.beforeTitle,scene.data.beforeDetail],['cmp-la',scene.data.afterTitle,scene.data.afterDetail]]) {
      const card=find(root,'data-comparison-card',id), piece=card.parent;
      assert.equal(words(text(card)),words(title+' '+detail));
      assert.equal(px(piece.style.left),copy.ar?700:65);
      assert.ok(px(piece.style['z-index'])>px(picture.style['z-index']));
      assert.equal(px(card.style.left),28); assert.equal(px(card.style.width),259);
      for(const line of card.children.filter(n=>typeof n!=='string'))assert.ok(measured(words(text(line)),line)<=px(card.style.width)+.01,words(text(line))+' exceeds card');
      if(frame>=90)assert.equal(px(piece.style.opacity),1);
      assert.ok(px(card.style.top)+card.children.filter(n=>typeof n!=='string').reduce((sum,n)=>sum+px(n.style.height)+px(n.style['margin-top']),0)<px(piece.style.height)-20);
    }
    // The picture's components use canonical positions; the enclosing transform
    // mirrors their shapes, joints and paths together rather than just their boxes.
    const sky=find(root,'data-paper-id','cmp-skyL'); assert.equal(px(sky.style.left),65);
    assert.ok(nodes(picture).includes(sky));
  }
});

test('2: library/long two-word chips stay inside a >=1.25x lens, clear the heading and report their real factor',()=>{
  for(const font of fonts)for(const english of [false,true])for(const long of [false,true]) {
    const scene=fixture('token-lens');
    if(english)scene.data.title='One idea in clear steps';
    if(long){scene.data.groups[1].label=english?'Illustrative arrangement':'التفاصيل التوضيحية';scene.data.groups[1].tokens=english?['Illustrative','arrangement']:['التفاصيل','التوضيحية'];}
    const d={...scene.data,font:font??'Grid Sans',copy:api.ownSceneCopy(scene.data),groups:scene.data.groups.map(g=>({...g,text:g.tokens.join(' ')}))};
    const g=api.tokGeo(d);
    for(let frame=75;frame<=140;frame++) {
      const lens=api.tokLens(frame,d);
      assert.ok(lens.zoom>=1.25);
      assert.ok(lens.cy-lens.r-28>=g.headingBottom+24-.01);
      for(const p of g.pos)assert.ok(lens.zoom*Math.hypot(p.w,p.h)<=lens.r*2*.86+.01);
    }
    // An early authored lens cue must also clear the heading while it rises in.
    for(const frame of [0,3,6,12,24]) {
      const lens=api.tokLens(frame,{...d,lens:{...d.lens,atFrame:0}});
      const early=structuredClone(scene); early.data.lens.atFrame=0;
      const heading=nodes(render('liquid-glass',early,frame,font)).find(n=>n.style.top==='376px');
      const row=heading.children.find(c=>typeof c!=='string');
      const shift=Number(row.style.transform.match(/translateY\(([-\d.]+)px\)/)[1]);
      assert.ok(lens.cy-lens.r-28>=376+px(row.style.height)+shift+24-.01);
      assert.ok(lens.zoom>=1.25);
    }
    for(const frame of [90,120]) {
      const root=render('liquid-glass',scene,frame,font),lens=find(root,'data-lens-zoom');
      assert.ok(Number(lens.attrs['data-lens-zoom'])>=1.25);
      assert.ok(words(text(lens)).includes(Number(lens.attrs['data-lens-zoom']).toFixed(1)+'×'));
      for(const gr of scene.data.groups)for(const token of gr.tokens)assert.ok(words(text(root)).includes(token));
      assert.ok(words(text(root)).includes(scene.data.groups[scene.data.lens.groupIndex].label));
    }
  }
});

const luminance = hex => {
  const c=hex.slice(1).match(/../g).map(s=>parseInt(s,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return c[0]*.2126+c[1]*.7152+c[2]*.0722;
};
test('3: the light kinetic statement card prints dark kicker ink on lime at >=4.5:1',()=>{
  for(const font of fonts) {
    const root=render('kinetic-paper',fixture('statement'),100,font),kicker=find(root,'data-statement-kicker','kinetic-paper');
    assert.equal(kicker.style.color,'#15231F'); assert.equal(kicker.style.background,'#DDF25E');
    assert.ok((luminance(kicker.style.background)+.05)/(luminance(kicker.style.color)+.05)>=4.5);
    assert.equal(words(text(kicker)),words(fixture('statement').data.kicker));
  }
});

const rotate = ([x,y],angle,ox,oy) => {const a=angle*Math.PI/180;return [ox+(x-ox)*Math.cos(a)-(y-oy)*Math.sin(a),oy+(x-ox)*Math.sin(a)+(y-oy)*Math.cos(a)];};
test('4: the ticket scales before the heading and clears it by >=24px throughout entrance and tear',()=>{
  for(const scene of [fixture('ticket-offer'),footage('kinetic-paper','ticket-offer')])for(const font of fonts) {
    for(let frame=scene.data.ticket.atFrame;frame<scene.durationInFrames;frame+=3) {
      const root=render('kinetic-paper',scene,frame,font),wrapper=find(root,'data-ticket-title-bottom'),ticket=find(root,'data-ticket-top');
      const scale=Number(wrapper.attrs['data-ticket-scale']),top=px(wrapper.style.top),bottom=Number(wrapper.attrs['data-ticket-title-bottom']);
      assert.ok(scale>0&&scale<=1);
      const transform=ticket.style.transform;
      const [,dx,dy]=transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/).map(Number);
      const k=Number(transform.match(/scale\(([-\d.]+)\)/)[1]);
      const corners=[[0,0],[880,0],[0,470],[880,470]].map(p=>rotate(p,-1.8,440,235)).map(([x,y])=>[440+(x-440)*k+dx,235+(y-235)*k+dy]);
      const ticketUpper=top+Math.min(...corners.map(p=>p[1]))*scale;
      assert.ok(ticketUpper-bottom>=24-.01,'ticket/title gap '+(ticketUpper-bottom));
      const headline=nodes(root).find(n=>n.style.top==='352px');
      const rows=headline.children.filter(n=>typeof n!=='string');
      let rowY=352;
      for(const row of rows) {
        const h=px(row.style.height),motion=row.style.transform??'';
        const sy=Number(motion.match(/scale\(([-\d.]+)\)/)?.[1]??1),ty=Number(motion.match(/translate\([-,\d.]+px, ([-\d.]+)px\)/)?.[1]??0);
        assert.ok(rowY+h/2+ty+h*sy/2<=bottom+.01);
        assert.ok(px(row.style['font-size'])>=56);
        rowY+=h;
      }
      // This scene handles its own fit, leaving the title independent of ticket size.
      assert.equal(find(root,'data-content-scale'),undefined);
    }
  }
});

test('5: every complete STEP tag clears its number badge by >=8px in both directions',()=>{
  for(const scene of [fixture('process'),footage('liquid-glass','process')])for(const font of fonts) {
    const root=render('liquid-glass',scene,100,font);
    for(let i=0;i<3;i++) {
      const badge=find(root,'data-process-badge',i),tag=find(root,'data-process-tag',i);
      assert.ok(words(text(tag)).endsWith('0'+(i+1)));
      const bx=xOf(badge,700),tx=xOf(tag,700),tw=px(tag.style.width);
      assert.ok(tx+tw<=bx-8||bx+px(badge.style.width)<=tx-8);
      assert.ok(measured(words(text(tag)),tag)<=tw);
    }
  }
});

test('6: process/comparison heading ink is already drawn at scene frame 3 and keeps writing at frame 6',()=>{
  for(const family of ['process','comparison'])for(const scene of [fixture(family),footage('calligraphic-receipts',family)])for(const font of fonts) {
    const samples=[0,3,6].map(frame=>{
      const root=render('calligraphic-receipts',scene,frame,font);
      const ink=nodes(root).filter(n=>n.attrs['data-event-progress']!==undefined&&n.children.some(c=>typeof c!=='string'&&c.style['font-size']));
      assert.ok(ink.length>0);
      return ink[0];
    });
    const progress=samples.map(n=>Number(n.attrs['data-event-progress']));
    assert.ok(progress[0]>=0&&progress[0]<progress[1]&&progress[1]<progress[2]&&progress[2]<1);
    const line=samples[1].children.find(c=>typeof c!=='string');
    // The opaque part of the whole-line mask exposes actual ink beyond its padding.
    const width=measured(words(text(line)),line),padding=px(samples[1].style.padding?.split(' ')[1]);
    assert.ok((width+2*padding)*(progress[1]*1.2-.2)>padding+24);
    assert.ok(samples[1].style['mask-image'].includes('linear-gradient'));
  }
});
