// Mechanical crop, downsample and composition of built-in image_gen artwork.
// No replacement artwork is drawn here. All scene sprites share one scale.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const tmp=path.join(root,'.packing-3');fs.mkdirSync(tmp,{recursive:true});
process.env.XDG_CACHE_HOME=path.join(tmp,'cache');fs.mkdirSync(process.env.XDG_CACHE_HOME,{recursive:true});
const mag=(...args)=>execFileSync('magick',args.map(String),{maxBuffer:128*1024*1024});
const json=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
const write=(f,x)=>fs.writeFileSync(path.join(root,f),JSON.stringify(x,null,2)+'\n');
const size=f=>mag('identify','-format','%w %h',f).toString().split(' ').map(Number);
const manifest=json('manifest.json'),jobs=json('generation-3.json').jobs;
manifest.sprites=manifest.sprites.filter(s=>!jobs.some(j=>j.id===s.id));
fs.mkdirSync(path.join(root,'planets'),{recursive:true});
for(const j of jobs){
 const src=path.join(root,j.source);
 const crop=mag(src,'-alpha','extract','-threshold','1%','-format','%@','info:').toString().trim();
 const [cw,ch,cx,cy]=crop.match(/\d+/g).map(Number);
 const file='planets/'+j.id+'.png',dest=path.join(root,file);
 mag(src,'-crop',crop,'+repage','-filter','Lanczos','-resize','384x','-bordercolor','none','-border','4',dest);
 const routeAnchorPx=j.routeSourcePx.map((n,i)=>Math.round((n-[cx,cy][i])*384/cw)+4);
 manifest.sprites.push({id:j.id,file,category:'planet',footprintTiles:[3,3],
  anchorPx:routeAnchorPx,routeAnchorPx,sizePx:size(dest),source:j.source,
  sha256:createHash('sha256').update(fs.readFileSync(dest)).digest('hex')});
}
const scale=0.5,originPx=[800,490];
const sample={file:'sample-planets.png',scene:'sample-scene-3.json',sizePx:[1600,1000],scale};
manifest.samples=[...(manifest.samples||[manifest.sample]).filter(s=>s.file!==sample.file),sample];
write('manifest.json',manifest);
const byId=Object.fromEntries(manifest.sprites.map(s=>[s.id,s]));
const ground=[],objects=[
 {id:'reading-room-a',u:8,v:14},{id:'workshop-a',u:16,v:8},
 {id:'tree-birch',u:2,v:9},{id:'tree-apple',u:4,v:17},
 {id:'street-lamp',u:10,v:14},{id:'bench',u:11,v:13},
 {id:'writer-notebook',u:10,v:12}
];
for(let u=0;u<20;u++)for(let v=0;v<20;v++)ground.push({id:(u===10||u===11||v===10||v===11)?'cobbled-square':'grass',u,v});
const planets=[{id:'planet-blog',u:0,v:0,screenAnchorPx:[340,360]},
 {id:'planet-spacehq',u:0,v:0,screenAnchorPx:[800,310]},
 {id:'planet-textbook',u:0,v:0,screenAnchorPx:[1260,360]}];
const scene={version:1,sizePx:[1600,1000],scale,originPx,ground,objects,planets,
 note:'Every sprite is at one common 0.5 scale: tiles 64x32, planet content width 192px. Planet screen anchors are brass mooring eyes. Worlds are symbolic miniatures, not human-scale campuses.'};
write('sample-scene-3.json',scene);
const resized={};
for(const id of new Set([...ground,...objects,...planets].map(p=>p.id))){
 const p=path.join(tmp,id+'.png');mag(path.join(root,byId[id].file),'-filter',byId[id].category==='ground'?'Point':'Lanczos','-resize','50%',p);resized[id]=p;
}
const draw=p=>{
 const s=byId[p.id],anchor=p.screenAnchorPx||[originPx[0]+32*(p.u-p.v),originPx[1]+16*(p.u+p.v)];
 return `image over ${Math.round(anchor[0]-s.anchorPx[0]*scale)},${Math.round(anchor[1]-s.anchorPx[1]*scale)} 0,0 '${resized[p.id]}'`;
};
const commands=[...ground,...objects.sort((a,b)=>a.u+a.v-b.u-b.v),...planets].map(draw);
fs.writeFileSync(path.join(tmp,'sample.mvg'),commands.join('\n'));
mag('-size','1600x1000','xc:none','-draw','@'+path.join(tmp,'sample.mvg'),path.join(root,sample.file));
mag(path.join(root,sample.file),'-background','#e9e5d8','-alpha','remove',path.join(root,'sample-planets-light.png'));
// Reuse the established catalogue layout and validate one card for every asset.
const cards=[];
for(const s of manifest.sprites){
 const p=path.join(root,'.packing-2','card-'+s.id+'.png');cards.push(p);
 mag(path.join(root,s.file),'-resize','190x180','-background','#e9e5d8','-gravity','center','-extent','210x190',
  '-gravity','south','-splice','0x30','-font','Helvetica','-pointsize','11','-fill','#344f3f','-annotate','+0+9',s.id,p);
}
mag('montage',...cards,'-tile','6x','-geometry','+0+0','-background','#e9e5d8',path.join(root,'sprite-catalogue.png'));
mag('montage',...jobs.map(j=>path.join(root,'.packing-2','card-'+j.id+'.png')),'-tile','3x','-geometry','+0+0',path.join(root,'planet-catalogue.png'));
console.log(`Packed ${jobs.length} planets; ${manifest.sprites.length} total sprites. Sample scale ${scale}.`);
// Earlier art rebuilds must retain the later character set and its catalogue.
if(fs.existsSync(path.join(root,'generation-agents.json')))await import('./build-agents.mjs');
