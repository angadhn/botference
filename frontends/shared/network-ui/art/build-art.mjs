// Mechanical packing and exact-grid composition of the image_gen PNG originals.
// Requires Node and ImageMagick 7. No network calls, server, or drawing of artwork.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const tmp=path.join(root,'.packing'); fs.mkdirSync(tmp,{recursive:true});
const mag=(...args)=>execFileSync('magick',args.map(String),{maxBuffer:32*1024*1024}).toString().trim();
const jobs=JSON.parse(fs.readFileSync(path.join(root,'generation.json'),'utf8')).jobs;
const sprites=[];
const size=f=>mag('identify','-format','%w %h',f).split(' ').map(Number);
const mask=path.join(tmp,'diamond.png');
mag('-size','128x64','xc:black','-fx','abs(i+0.5-64)/64+abs(j+0.5-32)/32<=1?1:0',mask);
for(const j of jobs){
  const src=path.join(root,'source',j.id+'.png');
  if(!fs.existsSync(src)) throw Error('Missing source '+j.id);
  const dir=j.cat==='building'?'buildings':j.cat==='resident'?'residents':j.cat==='ground'?'ground':'vegetation';
  fs.mkdirSync(path.join(root,dir),{recursive:true});
  const file=dir+'/'+j.id+'.png', dest=path.join(root,file);
  const crop=mag(src,'-alpha','extract','-threshold',j.cat==='ground'?'50%':'15%','-format','%@','info:');
  if(j.cat==='ground'){
    // Crop slightly inside the generated diamond, then apply the exact 128x64 coverage mask.
    mag(src,'-crop',crop,'+repage','-filter','Lanczos','-resize','136x68!',
      '-gravity','center','-crop','128x64+0+0','+repage','-alpha','off',mask,
      '-compose','CopyOpacity','-composite',dest);
  } else {
    const silhouetteHeight=j.id==='engineer-ladder'?168:j.height;
    const target=j.cat==='building'?`${64*(j.footprint[0]+j.footprint[1])}x`:`x${silhouetteHeight}`;
    mag(src,'-crop',crop,'+repage','-filter','Lanczos','-resize',target,
      '-bordercolor','none','-border','4',dest);
  }
  const [w,h]=size(dest);
  const anchor=j.cat==='ground'?[64,32]:[Math.round(w/2),h-4];
  if(j.id==='writer-pages') anchor[0]=Math.round(w*.44);
  if(j.id==='student-satchel') anchor[0]=Math.round(w*.28);
  if(j.id==='writer-notebook') anchor[0]=Math.round(w*.35);
  const item={id:j.id,file,category:j.cat,footprintTiles:j.footprint,anchorPx:anchor,sizePx:[w,h],source:'source/'+j.id+'.png',sha256:createHash('sha256').update(fs.readFileSync(dest)).digest('hex')};
  if(j.cat==='resident') item.figureHeightPx=j.height;
  sprites.push(item);
}
const manifest={version:1,tile:{width:128,height:64},projection:{type:'isometric',ratio:'2:1',axisU:[64,32],axisV:[-64,32]},anchorConvention:'Subtract anchorPx from the projected tile coordinate. Ground anchors are tile centres. Upright sprite anchors are front ground contacts; a building footprint extends backwards from that contact.',light:{from:'upper-left',shadowTowards:'lower-right'},sample:{file:'sample-neighbourhood.png',scene:'sample-scene.json',sizePx:[1600,1000],scale:0.25},sprites};
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const byId=Object.fromEntries(sprites.map(s=>[s.id,s]));
// Mixed buildings around a public square; different setbacks break the regular plot rhythm.
const buildings=[
  ['observatory-a',8,8],['workshop-a',19,9],['cottage-stone-a',27,7],['library-b',39,9],['greenhouse-a',48,8],
  ['reading-room-a',8,18],['lecture-hall-a',19,19],['cottage-brick-b',37,17],['launch-gantry-a',48,18],
  ['greenhouse-b',9,29],['cottage-stone-b',18,27],['library-a',29,29],['workshop-b',39,29],['observatory-b',48,28],
  ['reading-room-b',9,38],['lecture-hall-b',20,39],['cottage-brick-a',28,37],['launch-gantry-b',39,38]
];
const ground=[], objects=buildings.map(([id,u,v])=>({id,u,v}));
const occupancy=(u,v)=>buildings.some(([id,x,y])=>{const [a,b]=byId[id].footprintTiles;return u>x-a&&u<=x&&v>y-b&&v<=y;});
for(let u=0;u<50;u++)for(let v=0;v<40;v++){
  let id='grass';
  if((u<3&&v>14)||(v<2&&u>30)||(u>42&&v>30)) id='meadow';
  if((u<4&&v<12)||(u>46&&v>29)) id='woodland-floor';
  // Main streets are broad cobbled walks; the central shared square uses the same tile.
  if([9,10,19,20,29,30,39,40].includes(u)||[9,10,19,20,29,30].includes(v)) id='cobbled-square';
  if(u>=21&&u<=30&&v>=11&&v<=20) id='cobbled-square';
  // A quiet meadow walk and a continuous shoreline at the southern edge.
  if(v===38&&u>=42) id='path-straight';
  if(v===38&&u===41) id='path-corner';
  if(v===39&&u>=41) id='water-edge';
  ground.push({id,u,v});
}
const trees=['tree-oak','tree-birch','tree-copper-beech','tree-apple'];
const treePositions=[[1,2],[2,6],[1,11],[3,14],[1,21],[2,25],[1,32],[2,37],[5,39],[11,1],[13,2],[21,1],[24,3],[31,2],[41,1],[45,2],[49,12],[49,23],[49,32],[48,36],[44,37],[44,34],[43,31],[31,34],[32,38],[22,33],[12,32],[12,25],[12,22],[22,22],[32,12],[32,16],[41,22],[22,7],[29,1],[6,21],[5,25],[24,12],[27,12]];
treePositions.forEach(([u,v],i)=>{if(!occupancy(u,v))objects.push({id:trees[i%trees.length],u,v});});
[[22,12],[28,12],[22,17],[28,17]].forEach(([u,v],i)=>objects.push({id:i%2?'hedge-corner':'hedge-straight',u,v}));
const residentPositions=[[21,15],[26,18],[31,22],[11,17],[41,19],[20,27],[25,16],[29,19],[10,28],[19,22],[30,31],[24,18]];
sprites.filter(s=>s.category==='resident').forEach((s,i)=>objects.push({id:s.id,u:residentPositions[i][0],v:residentPositions[i][1]}));
const scene={version:1,sizePx:[1600,1000],originPx:[720,220],scale:0.25,ground,objects};
fs.writeFileSync(path.join(root,'sample-scene.json'),JSON.stringify(scene,null,2)+'\n');
const resized={};
for(const s of sprites){
 const p=path.join(tmp,s.id+'.png');
 // Entire scene has one common scale. Never scale buildings or residents independently here.
 mag(path.join(root,s.file),'-filter','Point','-resize','25%',p);resized[s.id]=p;
}
const draw=[];
for(const p of [...ground,...objects.sort((a,b)=>a.u+a.v-b.u-b.v)]){
  const s=byId[p.id],x=Math.round(720+(p.u-p.v)*16-s.anchorPx[0]/4),y=Math.round(220+(p.u+p.v)*8-s.anchorPx[1]/4);
  draw.push(`image over ${x},${y} 0,0 '${resized[p.id]}'`);
}
fs.writeFileSync(path.join(tmp,'sample.mvg'),draw.join('\n'));
fs.writeFileSync(path.join(tmp,'ground.mvg'),draw.slice(0,ground.length).join('\n'));
mag('-size','1600x1000','xc:none','-draw','@'+path.join(tmp,'ground.mvg'),path.join(tmp,'ground-proof.png'));
mag('-size','1600x1000','xc:none','-draw','@'+path.join(tmp,'sample.mvg'),path.join(root,'sample-neighbourhood.png'));
// A light-background proof makes alpha defects visible without changing the transparent sample.
mag(path.join(root,'sample-neighbourhood.png'),'-background','#e9e5d8','-alpha','remove',path.join(root,'sample-neighbourhood-light.png'));
console.log(`Packed ${sprites.length} sprites and composed ${objects.length} objects on ${ground.length} tiles.`);
// Keep later additions when rebuilding the original set.
if(fs.existsSync(path.join(root,'generation-2.json')))await import('./build-art-2.mjs');
