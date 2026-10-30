// Reproducible mechanical packing of built-in image_gen originals.
// This script crops/resamples generated pixels; it does not paint replacement artwork.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url)), tmp=path.join(root,'.packing-2');
fs.mkdirSync(tmp,{recursive:true});
process.env.XDG_CACHE_HOME=path.join(tmp,'cache');
fs.mkdirSync(process.env.XDG_CACHE_HOME,{recursive:true});
const mag=(...args)=>execFileSync('magick',args.map(String),{maxBuffer:128*1024*1024});
const str=(...args)=>mag(...args).toString().trim();
const json=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
const write=(f,x)=>fs.writeFileSync(path.join(root,f),JSON.stringify(x,null,2)+'\n');
const size=f=>str('identify','-format','%w %h',f).split(' ').map(Number);
const base=json('manifest-set-1.json'),jobs=json('generation-2.json').jobs;
const sprites=[...base.sprites], byId=Object.fromEntries(sprites.map(s=>[s.id,s]));
const mask=path.join(tmp,'diamond.png');
mag('-size','128x64','xc:black','-fx','abs(i+0.5-64)/64+abs(j+0.5-32)/32<=1?1:0',mask);
for(const j of jobs.filter(j=>!j.id.startsWith('terrace-'))){
 const source='source/set-2/'+j.id+'.png',src=path.join(root,source);
 const dir={building:'buildings',resident:'residents',ground:'ground',terrain:'terrain',prop:'props',vegetation:'vegetation'}[j.cat];
 fs.mkdirSync(path.join(root,dir),{recursive:true});
 const file=dir+'/'+j.id+'.png',dest=path.join(root,file);
 const crop=str(src,'-alpha','extract','-threshold',j.cat==='ground'?'50%':'15%','-format','%@','info:');
 let anchor;
 if(j.base){
   const b=byId[j.base], [w,h]=b.sizePx;
   mag(src,'-crop',crop,'+repage','-filter','Lanczos','-resize',(w-8)+'x'+(h-8)+'!',
     '-bordercolor','none','-border','4',dest);
   anchor=b.anchorPx;
 }else if(j.cat==='ground'){
   mag(src,'-crop',crop,'+repage','-filter','Lanczos','-resize','136x68!','-gravity','center',
     '-crop','128x64+0+0','+repage','-alpha','off',mask,'-compose','CopyOpacity','-composite',dest);
   anchor=[64,32];
 }else if(j.id==='stone-stair-ramp'){
   mag(src,'-crop',crop,'+repage','-resize','136x80!','-gravity','center','-crop','128x80+0+0','+repage',dest);
   anchor=[64,48];
 }else {
   const target=j.cat==='building'?64*(j.footprint[0]+j.footprint[1])+'x':'x'+j.height;
   mag(src,'-crop',crop,'+repage','-filter','Lanczos','-resize',target,'-bordercolor','none','-border','4',dest);
   const [w,h]=size(dest);anchor=[Math.round(w/2),h-4];
 }
 if(j.id==='deep-water'){
   // Repeat an interior crop of the generated ripples in screen coordinates.
   // Both tile-axis translations are multiples of this 32x16 crop, hence no border bands.
   const px=mag(dest,'-depth','8','rgba:-'),out=Buffer.alloc(128*64*4);
   for(let y=0;y<64;y++)for(let x=0;x<128;x++){
     const k=(y*128+x)*4,q=(((y%16)+24)*128+(x%32)+48)*4;
     if(Math.abs(x+.5-64)/64+Math.abs(y+.5-32)/32<=1)copyPixel(out,k,px,q);
   }
   execFileSync('magick',['-size','128x64','-depth','8','rgba:-',dest],{input:out});
 }
 const s={id:j.id,file,category:j.cat,footprintTiles:j.footprint,anchorPx:anchor,sizePx:size(dest),source,
   sha256:createHash('sha256').update(fs.readFileSync(dest)).digest('hex')};
 if(j.cat==='resident')s.figureHeightPx=j.height;
 if(j.base){s.variantOf=j.base;s.state='shuttered';}
 if(j.cat==='terrain')s.stepPx=16;
 sprites.push(s);byId[s.id]=s;
}
// Shared generated grass + generated limestone faces, resampled into exact tile meshes.
// Sharing the same sampled edge texture avoids eight independently painted seam colours.
const grass=mag(path.join(root,'ground/grass.png'),'-depth','8','rgba:-');
const wallFile=path.join(root,'source/set-2/terrace-outer-s.png');
const [ww,wh]=size(wallFile),wall=mag(wallFile,'-depth','8','rgba:-');
const N=[64,0],E=[128,32],S=[64,64],W=[0,32],C=[64,32];
const configurations={
 'terrace-se':{top:[N,E,S,W],faces:[[E,S]]},
 'terrace-sw':{top:[N,E,S,W],faces:[[W,S]]},
 'terrace-ne':{lower:true,faces:[[N,E]]},
 'terrace-nw':{lower:true,faces:[[W,N]]},
 'terrace-outer-s':{top:[N,E,S,W],faces:[[W,S],[E,S]]},
 'terrace-outer-n':{lower:true,faces:[[W,N],[N,E]]},
 'terrace-inner-e':{top:[N,[96,16],C,[96,48],S,W],faces:[[[96,16],C],[C,[96,48]]]},
 'terrace-inner-w':{top:[N,E,S,[32,48],C,[32,16]],faces:[[[32,16],C],[C,[32,48]]]}
};
const inside=(x,y,p)=>{let b=false;for(let i=0,k=p.length-1;i<p.length;k=i++){
 const [a,c]=p[i],[d,e]=p[k];if((c>y)!==(e>y)&&x<(d-a)*(y-c)/(e-c)+a)b=!b;
}return b;};
function copyPixel(out,k,src,q){out[k]=src[q];out[k+1]=src[q+1];out[k+2]=src[q+2];out[k+3]=255;}
for(const [id,cfg] of Object.entries(configurations)){
 const out=Buffer.alloc(128*80*4);
 // Copy the original lawn pixels. Concave pieces include the lower lawn in their notch.
 for(let y=0;y<80;y++)for(let x=0;x<128;x++){
   const k=4*(y*128+x),gy=y-16;
   if((cfg.lower||id.includes('inner'))&&gy>=0&&gy<64&&grass[(gy*128+x)*4+3])copyPixel(out,k,grass,4*(gy*128+x));
   if(cfg.top&&inside(x+.5,y+.5,cfg.top))copyPixel(out,k,grass,4*(Math.min(63,y)*128+x));
 }
 // Sample the two visible wall faces from the selected image_gen output.
 for(const [a,b] of cfg.faces)for(let y=0;y<80;y++)for(let x=0;x<128;x++){
   const t=(x+.5-a[0])/(b[0]-a[0]),top=a[1]+t*(b[1]-a[1]),d=(y+.5-top)/16;
   if(t<0||t>=1||d<0||d>=1)continue;
   const left=(b[1]-a[1])/(b[0]-a[0])>0;
   const tt=left?t:1-t;
   // Interior-only source quadrilaterals exclude alpha fringes and grass cap.
   const sx=(left?(.065+.425*tt):(.925-.425*tt))*ww;
   const sy=(.458+.325*tt+.105*d)*wh;
   const q=4*(Math.min(wh-1,Math.floor(sy))*ww+Math.min(ww-1,Math.floor(sx)));
   copyPixel(out,4*(y*128+x),wall,q);
 }
 const file='terrain/'+id+'.png',dest=path.join(root,file);
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 execFileSync('magick',['-size','128x80','-depth','8','rgba:-',dest],{input:out});
 const s={id,file,category:'terrain',footprintTiles:[1,1],anchorPx:[64,48],sizePx:[128,80],
 source:'source/set-2/terrace-outer-s.png',generatedCandidate:'source/set-2/'+id+'.png',sha256:createHash('sha256').update(fs.readFileSync(dest)).digest('hex'),
 stepPx:16,surfaceSources:['ground/grass.png','source/set-2/terrace-outer-s.png'],edgeGeometry:cfg};
 sprites.push(s);byId[id]=s;
}
const manifest={...base,sprites,samples:[base.sample,{file:'sample-neighbourhood-2.png',scene:'sample-scene-2.json',sizePx:[1600,1000],scale:0.25}]};
write('manifest.json',manifest);
// Sparse second neighbourhood: wooded plateau west, health campus south, launch island east.
const ground=[],terrain=[],objects=[];
const put=(id,u,v,zPx=0)=>objects.push({id,u,v,zPx});
const hill=(u,v)=>u>=2&&u<=18&&v>=12&&v<=29;
const hillHeight=(u,v)=>!hill(u,v)?0:(u>=6&&u<=14&&v>=16&&v<=25?48:u>=4&&u<=16&&v>=14&&v<=27?32:16);
for(let u=0;u<50;u++)for(let v=0;v<40;v++){
 let id='grass';
 const ocean=u>=28&&v<=16, island=u>=34&&u<=44&&v>=3&&v<=12;
 if(ocean)id='deep-water';
 if(island)id=(u===34||u===44||v===3||v===12)?'sand':'grass';
 if(u>=28&&u<=34&&v===9)id='causeway';
 if(u===27&&v<=16)id='shoreline-u';
 if(v===17&&u>=28)id='shoreline-v';
 if((u<3||v>36)&&!hill(u,v))id='meadow';
 if(u>=22&&u<=39&&v>=20&&v<=35&&(u===22||v===30||u===36))id='cobbled-square';
 if(hill(u,v)){
   ground.push({id:'grass',u,v,zPx:hillHeight(u,v)});
   if(u===18&&v===29)terrain.push({id:'terrace-outer-s',u,v,zPx:0});
   else if(u===18)terrain.push({id:'terrace-se',u,v,zPx:0});
   else if(v===29)terrain.push({id:'terrace-sw',u,v,zPx:0});
   else if(u<5||v<14)ground[ground.length-1].id='heather';
   if(u>=14&&v===25)ground[ground.length-1].id='cobbled-square';
 }else ground.push({id,u,v,zPx:0});
 if(u>=19&&u<=22&&v===25)ground[ground.length-1].id='cobbled-square';
}
for(const [umin,umax,vmin,vmax,z] of [[4,16,14,27,16],[6,14,16,25,32]]){
 for(let u=umin;u<=umax;u++)for(let v=vmin;v<=vmax;v++){
   if(u===umax&&v===vmax)terrain.push({id:'terrace-outer-s',u,v,zPx:z});
   else if(u===umax)terrain.push({id:'terrace-se',u,v,zPx:z});
   else if(v===vmax)terrain.push({id:'terrace-sw',u,v,zPx:z});
 }
}
// A shallow retaining notch demonstrates both inside corners away from the observatory.
terrain.push({id:'terrace-inner-e',u:18,v:23,zPx:0},{id:'terrace-inner-w',u:12,v:29,zPx:0});
terrain.push({id:'terrace-ne',u:8,v:11,zPx:0},{id:'terrace-nw',u:1,v:19,zPx:0},{id:'terrace-outer-n',u:1,v:11,zPx:0});
put('observatory-a',13,24,48);
put('hospital-a',32,28);put('hospital-b',43,28);put('rehabilitation-garden',31,36);
put('launch-gantry-a',41,10);
put('cottage-stone-a-shuttered',13,37);
put('stone-stair-ramp',18,25);put('stone-stair-ramp',18,26);
put('stone-stair-ramp',16,25,16);put('stone-stair-ramp',14,25,32);
put('wind-turbine',45,6);put('copper-water-tower',43,13);
put('solar-glass-pergola',35,35);put('tram-stop',23,32);
put('bridge-straight',29,17);put('wooden-footbridge',26,17);put('canal-boat',33,16);
put('street-lamp',23,26);put('street-lamp',36,31);put('bench',21,27);put('bench',33,34);
put('doctor',33,30);put('nurse-plant',29,32);put('tinkerer-goggles',34,10);
put('cyclist',22,30);put('child-a',26,35);put('child-b',27,36);put('cat',32,35);
put('rock-outcrop',6,19,16);put('rock-outcrop',16,28,16);
[[3,13],[4,17],[3,22],[6,25],[9,28],[14,13],[16,17],[2,31],[5,35],[19,6],[21,9],[20,14],[18,34],[21,37],[47,32],[47,37],[39,39],[49,36]].forEach(([u,v],i)=>put(['tree-oak','tree-birch','tree-copper-beech','tree-apple'][i%4],u,v,hillHeight(u,v)));
const scene={version:1,sizePx:[1600,1000],originPx:[720,220],scale:0.25,stepPx:16,ground,terrain,objects};
write('sample-scene-2.json',scene);
const resized={};
for(const s of sprites){
 const p=path.join(tmp,s.id+'.png');mag(path.join(root,s.file),'-filter','Point','-resize','25%',p);resized[s.id]=p;
}
const draw=p=>{const s=byId[p.id];return "image over "+Math.round(720+16*(p.u-p.v)-s.anchorPx[0]/4)+","+Math.round(220+8*(p.u+p.v)-(s.anchorPx[1]+(p.zPx||0))/4)+" 0,0 '"+resized[p.id]+"'";};
// Sort terrain with ground, so a cliff face can cover the lower tile immediately in front.
const surfaces=[...ground,...terrain].sort((a,b)=>a.u+a.v-b.u-b.v||(a.id.startsWith('terrace')?1:-1));
const gd=surfaces.map(draw),all=[...gd,...objects.sort((a,b)=>a.u+a.v-b.u-b.v).map(draw)];
for(const [name,commands] of [['ground-proof',gd],['sample',all]]){
 const p=path.join(tmp,name+'.mvg');fs.writeFileSync(p,commands.join('\n'));
 mag('-size','1600x1000','xc:none','-draw','@'+p,name==='sample'?path.join(root,'sample-neighbourhood-2.png'):path.join(tmp,'ground-proof.png'));
}
mag(path.join(root,'sample-neighbourhood-2.png'),'-background','#e9e5d8','-alpha','remove',path.join(root,'sample-neighbourhood-2-light.png'));
// An isolated plateau proof cannot hide missing cliff pixels behind lower ground.
const elevated=surfaces.filter(p=>hill(p.u,p.v)).map(draw);
fs.writeFileSync(path.join(tmp,'terrace-proof.mvg'),elevated.join('\n'));
mag('-size','1600x1000','xc:none','-draw','@'+path.join(tmp,'terrace-proof.mvg'),path.join(tmp,'terrace-proof.png'));
// Catalogue cards are presentation only; all images come from manifest PNGs.
const cards=[];
for(const s of sprites){
 const p=path.join(tmp,'card-'+s.id+'.png');cards.push(p);
 mag(path.join(root,s.file),'-resize','190x180','-background','#e9e5d8','-gravity','center','-extent','210x190',
   '-gravity','south','-splice','0x30','-font','Helvetica','-pointsize','11','-fill','#344f3f','-annotate','+0+9',s.id,p);
}
mag('montage',...cards,'-tile','6x','-geometry','+0+0','-background','#e9e5d8',path.join(root,'sprite-catalogue.png'));
console.log('Packed '+jobs.length+' new sprites; total '+sprites.length+'.');
// Preserve the destination worlds when rebuilding earlier art sets.
if(fs.existsSync(path.join(root,'generation-3.json')))await import('./build-art-3.mjs');
