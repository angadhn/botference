// Packs original built-in image_gen pixels; no character artwork is drawn in code.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.dirname(fileURLToPath(import.meta.url));
const tmp=path.join(root,'.packing-agents');
fs.mkdirSync(tmp,{recursive:true});
fs.mkdirSync(path.join(root,'agents'),{recursive:true});
process.env.XDG_CACHE_HOME=path.join(tmp,'cache');
const mag=(...args)=>execFileSync('magick',args.map(String),{maxBuffer:128*1024*1024});
const read=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
const write=(f,v)=>fs.writeFileSync(path.join(root,f),JSON.stringify(v,null,2)+'\n');
const dimensions=f=>mag('identify','-format','%w %h',f).toString().split(' ').map(Number);
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const alpha=f=>mag(f,'-alpha','extract','-depth','8','gray:-');
const jobs=read('generation-agents.json').jobs.toSorted((a,b)=>{
 const key=j=>`${{body:0,badge:1,overlay:2}[j.kind||'body']}-${j.family||''}-${{idle:0,working:1,walk:2}[j.pose]??0}-${j.role||j.status||''}-${{sw:0,se:1,nw:2,ne:3}[j.direction]??0}-${j.frame||0}`;
 return key(a).localeCompare(key(b));
});
const partial=process.argv.includes('--partial');
if(!partial)assert.equal(jobs.length,57,'40 body frames + 5 badges + 12 directional role overlays');
const baseline=read('manifest-set-3.json');
const manifest=read('manifest.json');
manifest.sprites=manifest.sprites.filter(s=>s.category!=='agent');
const overlayLayout={
 writer:{size:[27,27],top:57},engineer:{size:[23,10],top:38},
 scientist:{size:[35,49],top:60},teacher:{size:[7,14],top:90},
 builder:{size:[43,22],top:12},reviewer:{size:[21,8],top:40}
};
const registration=[];
for(const j of jobs){
 const src=path.join(root,j.source),file='agents/'+j.id+'.png',out=path.join(root,file);
 const crop=mag(src,'-alpha','extract','-threshold','1%','-format','%@','info:').toString().trim();
 const cropped=path.join(tmp,j.id+'-crop.png');
 mag(src,'-crop',crop,'+repage',cropped);
 const s={id:j.id,file,category:'agent',agentKind:j.kind||'body',footprintTiles:[0.5,0.5],source:j.source};
 if(j.kind==='badge'){
  mag(cropped,'-filter','Lanczos','-resize','24x24','-background','none','-gravity','center','-extent','32x32',out);
  Object.assign(s,{status:j.status,anchorPx:[16,31],attachOffsetPx:[0,-136]});
 }else if(j.kind==='overlay'){
  const l=overlayLayout[j.role],resized=path.join(tmp,j.id+'-resized.png');
  mag(cropped,'-filter','Lanczos','-resize',l.size.join('x')+'!',resized);
  const x=j.role==='teacher'?(j.direction==='sw'?63:90):Math.round(80-l.size[0]/2+(j.direction==='sw'?-1:1));
  mag('-size','160x160','xc:none',resized,'-geometry',`+${x}+${l.top}`,'-composite',out);
  Object.assign(s,{role:j.role,direction:j.direction,pose:'idle',compatibleFamilies:['claude','codex'],anchorPx:[80,144],overlayOffsetPx:[0,0],contentRectPx:[x,l.top,...l.size]});
 }else{
  const resized=path.join(tmp,j.id+'-resized.png');
  mag(cropped,'-filter','Lanczos','-resize','x128',resized);
  const [w,h]=dimensions(resized),a=alpha(resized);
  // Register the emblem's upper 32 pixels, independent of the swinging arms/feet.
  let left=w,right=-1;
  for(let y=0;y<32;y++)for(let x=0;x<w;x++)if(a[y*w+x]>128){left=Math.min(left,x);right=Math.max(right,x);}
  const headCentre=(left+right)/2,x=Math.round(80-headCentre),y=144-h;
  assert(x>=0&&x+w<=160,j.id+' exceeds frame canvas');
  mag('-size','160x160','xc:none',resized,'-geometry',`+${x}+${y}`,'-composite',out);
  Object.assign(s,{family:j.family,pose:j.pose,direction:j.direction,anchorPx:[80,144],figureHeightPx:128,headAxisPx:80});
  if(j.pose==='walk')Object.assign(s,{frame:j.frame,frameDurationMs:140,animation:`${j.family}-walk-${j.direction}`});
  registration.push({id:j.id,sourceCrop:crop,placedPx:[x,y],headCentrePx:headCentre+x,groundBaselinePx:144,contentSizePx:[w,h]});
 }
 s.sizePx=dimensions(out);s.sha256=sha(out);manifest.sprites.push(s);
}
for(const old of baseline.sprites)assert.deepEqual(manifest.sprites.find(s=>s.id===old.id),old);
manifest.agents={version:1,canvasPx:[160,160],anchorPx:[80,144],figureHeightPx:128,
 directions:{sw:[-64,32],se:[64,32],nw:[-64,-32],ne:[64,-32]},
 animation:{frameDurationMs:140,order:[1,2,3,4],loop:true},
 layering:['body','role overlay at the same origin (idle only)','badge at ground anchor + attachOffsetPx'],
 note:'Artwork only. Presence, movement and event handling are not implemented by this art pack.'};
write('agent-registration.json',registration);
write('manifest.json',manifest);
const byId=Object.fromEntries(manifest.sprites.map(s=>[s.id,s]));
// Catalogue: preserve the established card format for every previous and new asset.
const cards=[],agentCards=[];
for(const s of manifest.sprites){
 const p=path.join(root,'.packing-2','card-'+s.id+'.png');cards.push(p);
 if(s.category==='agent'||!fs.existsSync(p))mag(path.join(root,s.file),'-resize','190x180','-background','#e9e5d8','-gravity','center','-extent','210x190','-gravity','south','-splice','0x30','-font','Helvetica','-pointsize','11','-fill','#344f3f','-annotate','+0+9',s.id,p);
 if(s.category==='agent')agentCards.push(p);
}
mag('montage',...cards,'-tile','6x','-geometry','+0+0','-background','#e9e5d8',path.join(root,'sprite-catalogue.png'));
mag('montage',...agentCards,'-tile','6x','-geometry','+0+0','-background','#e9e5d8',path.join(root,'agent-catalogue.png'));
// Each sample uses the same native-world scale for buildings, residents and agents.
const scale=0.75,originPx=[800,290],ground=[];
for(let u=0;u<=14;u++)for(let v=0;v<=14;v++)ground.push({id:(v>=7&&v<=9)||(u>=6&&u<=8)?'cobbled-square':'grass',u,v});
const objects=[{id:'reading-room-a',u:5,v:6},{id:'workshop-a',u:13,v:6},
 {id:'tree-birch',u:1,v:10},
 {id:'bench',u:4,v:10},{id:'street-lamp',u:10,v:10}];
const agents=[
 {id:'agent-claude-walk-se-1',u:5,v:8,badge:'agent-badge-thinking'},
 {id:'agent-codex-walk-nw-3',u:8,v:9,badge:'agent-badge-waiting'},
 {id:'agent-codex-walk-sw-1',u:7,v:12,badge:'agent-badge-done'},
 {id:'agent-claude-working-se',u:10,v:9,badge:'agent-badge-failed'},
 {id:'agent-codex-idle-sw',u:4,v:9,badge:'agent-badge-disconnected'}
].filter(p=>byId[p.id]&&byId[p.badge]);
const resized=new Map();
function scaled(id){if(!resized.has(id)){const s=byId[id],p=path.join(tmp,'sample-'+id+'.png');mag(path.join(root,s.file),'-filter',s.category==='ground'?'Point':'Lanczos','-resize','75%',p);resized.set(id,p);}return resized.get(id);}
function draw(id,anchor){const s=byId[id];return `image over ${Math.round(anchor[0]-s.anchorPx[0]*scale)},${Math.round(anchor[1]-s.anchorPx[1]*scale)} 0,0 '${scaled(id)}'`;}
const project=p=>[originPx[0]+48*(p.u-p.v),originPx[1]+24*(p.u+p.v)];
const commands=ground.map(p=>draw(p.id,project(p)));
for(const p of [...objects,...agents].sort((a,b)=>a.u+a.v-b.u-b.v)){
 const anchor=project(p);commands.push(draw(p.id,anchor));
 if(p.badge)commands.push(draw(p.badge,[anchor[0],anchor[1]-136*scale]));
}
fs.writeFileSync(path.join(tmp,'sample.mvg'),commands.join('\n'));
mag('-size','1600x1000','xc:#e9e5d8','-draw','@'+path.join(tmp,'sample.mvg'),path.join(root,'sample-agents.png'));
write('sample-scene-agents.json',{version:1,sizePx:[1600,1000],scale,originPx,ground,objects,agents,
 note:'Static demonstration of art, not live status. All objects use the same 0.75 scale. Body foot anchors and badge offsets come from manifest.'});
const sample={file:'sample-agents.png',scene:'sample-scene-agents.json',sizePx:[1600,1000],scale};
manifest.samples=[...(manifest.samples||[]).filter(s=>s.file!==sample.file),sample];
write('manifest.json',manifest);
// Eight horizontal strips and one animated proof, all with unchanged anchor per frame.
const strips=[];
for(const family of ['claude','codex'])for(const direction of ['sw','se','nw','ne']){
 const ids=[1,2,3,4].map(i=>`agent-${family}-walk-${direction}-${i}`);
 if(ids.some(id=>!byId[id]))continue;
 const strip=path.join(root,'agents',`${family}-walk-${direction}-strip.png`);
 mag(...ids.map(id=>path.join(root,byId[id].file)),'+append',strip);strips.push(strip);
}
if(strips.length===8){
 mag('montage',...strips,'-tile','1x','-geometry','+0+0','-background','#e9e5d8',path.join(root,'agent-walk-proof.png'));
 const frames=[];
 for(let frame=1;frame<=4;frame++){
  const p=path.join(tmp,'walk-proof-'+frame+'.png');
  const ids=['claude','codex'].flatMap(f=>['sw','se','nw','ne'].map(d=>`agent-${f}-walk-${d}-${frame}`));
  mag('montage',...ids.map(id=>path.join(root,byId[id].file)),'-tile','4x2','-geometry','+0+0','-background','#e9e5d8',p);frames.push(p);
 }
 mag('-delay','14',...frames,'-loop','0',path.join(root,'agent-walk-proof.gif'));
}
// A role fitting proof: each generated overlay is composited on both family idle sprites.
const fittings=[];
for(const family of ['claude','codex'])for(const direction of ['sw','se'])for(const role of Object.keys(overlayLayout)){
 const body=byId[`agent-${family}-idle-${direction}`],overlay=byId[`agent-role-${role}-${direction}`];
 if(!body||!overlay)continue;
 const p=path.join(tmp,`fit-${family}-${direction}-${role}.png`);
 mag(path.join(root,body.file),path.join(root,overlay.file),'-composite','-background','#e9e5d8','-alpha','remove','-gravity','south','-splice','0x24','-font','Helvetica','-pointsize','10','-fill','#344f3f','-annotate','+0+7',`${family} ${direction} ${role}`,p);fittings.push(p);
}
if(fittings.length)mag('montage',...fittings,'-tile','6x','-geometry','+0+0','-background','#e9e5d8',path.join(root,'agent-role-proof.png'));
console.log(`Packed ${jobs.length} generated agent sprites; ${manifest.sprites.length} total. Original ${baseline.sprites.length} entries preserved.`);
