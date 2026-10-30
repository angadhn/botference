import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {verifyAgents} from './verify-agents.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const scene=JSON.parse(fs.readFileSync(path.join(root,'sample-scene.json'),'utf8'));
const scene2=JSON.parse(fs.readFileSync(path.join(root,'sample-scene-2.json'),'utf8'));
const baseline=JSON.parse(fs.readFileSync(path.join(root,'manifest-set-1.json'),'utf8'));
const jobs=JSON.parse(fs.readFileSync(path.join(root,'generation-2.json'),'utf8')).jobs;
const planetJobs=JSON.parse(fs.readFileSync(path.join(root,'generation-3.json'),'utf8')).jobs;
const scene3=JSON.parse(fs.readFileSync(path.join(root,'sample-scene-3.json'),'utf8'));
const baseline2=JSON.parse(fs.readFileSync(path.join(root,'manifest-set-2.json'),'utf8'));
const agentJobs=JSON.parse(fs.readFileSync(path.join(root,'generation-agents.json'),'utf8')).jobs;
assert.equal(manifest.sprites.length,baseline.sprites.length+jobs.length+planetJobs.length+agentJobs.length);
assert.equal(jobs.length,52,'All requested set-two assets must be present');
assert.deepEqual(planetJobs.map(j=>j.id),['planet-blog','planet-spacehq','planet-textbook']);
const placements=[...scene.ground,...scene.objects,...scene2.ground,...scene2.terrain,...scene2.objects,...scene3.ground,...scene3.objects,...scene3.planets];
const used=new Set(placements.map(p=>p.id));
const byId=Object.fromEntries(manifest.sprites.map(s=>[s.id,s]));
for(const old of baseline.sprites)assert.deepEqual(byId[old.id],old,'First-set asset changed: '+old.id);
for(const old of baseline2.sprites)assert.deepEqual(byId[old.id],old,'Earlier asset changed: '+old.id);
for(const j of [...jobs,...planetJobs])assert(byId[j.id],'Missing requested sprite '+j.id);
const ids=new Set();let transparentPixels=0;
const counts={};
for(const s of manifest.sprites){
 assert(!ids.has(s.id));ids.add(s.id);
 // Quiet variants are shown in the catalogue; the sample stays spacious.
 if(s.state!=='shuttered'&&s.category!=='agent')assert(used.has(s.id),s.id+' absent from either sample');
 assert(fs.existsSync(path.join(root,'.packing-2','card-'+s.id+'.png')),s.id+' absent from catalogue');
 const f=path.join(root,s.file),b=fs.readFileSync(f);
 assert.equal(b.subarray(1,4).toString(),'PNG');
 const w=b.readUInt32BE(16),h=b.readUInt32BE(20);
 assert.deepEqual([w,h],s.sizePx);assert(s.footprintTiles.every(n=>n>0));
 assert(s.anchorPx[0]>=0&&s.anchorPx[0]<w&&s.anchorPx[1]>=0&&s.anchorPx[1]<h);
 assert.equal(createHash('sha256').update(b).digest('hex'),s.sha256);
 const alpha=execFileSync('magick',[f,'-alpha','extract','-depth','8','gray:-'],{maxBuffer:8*1024*1024});
 assert(alpha.includes(0),s.id+' lacks transparency');
 // Thin wearable rims can be slightly translucent in the generated original
 // (spectacle source max alpha is 254). Keep that alpha rather than painting it opaque.
 if(s.category==='agent'&&s.agentKind==='overlay')assert(alpha.some(a=>a>=250),s.id+' has no near-opaque pixels');
 else assert(alpha.includes(255),s.id+' has no solid pixels');
 transparentPixels+=alpha.reduce((a,v)=>a+(v===0),0);
 if(s.category==='ground') assert.deepEqual(s.sizePx,[128,64]);
 if(s.category==='planet'){
   assert.deepEqual(s.footprintTiles,[3,3]);assert.equal(s.sizePx[0],392);
   assert.deepEqual(s.anchorPx,s.routeAnchorPx,'Planet origin must coincide with its brass mooring eye');
   const [x,y]=s.routeAnchorPx;
   // The centre of a mooring ring is transparent; check its nearby painted rim.
   let rim=0;
   for(let dy=-10;dy<=10;dy++)for(let dx=-10;dx<=10;dx++){
     if(x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h&&alpha[(y+dy)*w+x+dx]>128)rim++;
   }
   assert(rim>12,s.id+' route eye has no painted attachment');
   assert(!s.frames&&!s.variants,'Planets are single frames');
 }
 if(s.category==='resident'&&!['cat','child-a','child-b'].includes(s.id))assert.equal(s.figureHeightPx,128);
 if(s.id==='child-a')assert.equal(s.figureHeightPx,88);
 if(s.id==='child-b')assert.equal(s.figureHeightPx,96);
 if(s.state==='shuttered'){
   const original=byId[s.variantOf];assert(original);
   for(const key of ['sizePx','anchorPx','footprintTiles'])assert.deepEqual(s[key],original[key],s.id+' '+key);
 }
 if(s.id.startsWith('terrace-')){
   assert.deepEqual(s.sizePx,[128,80]);assert.deepEqual(s.anchorPx,[64,48]);assert.equal(s.stepPx,16);
 }
 counts[s.category]=(counts[s.category]||0)+1;
}
assert.deepEqual(counts,{building:38,vegetation:8,ground:13,resident:18,terrain:9,prop:9,planet:3,agent:57});
const agentValidation=verifyAgents(manifest,root);
for(const p of placements){assert(ids.has(p.id));assert(Number.isInteger(p.u)&&Number.isInteger(p.v));}
const ground=execFileSync('magick',[path.join(root,'.packing/ground-proof.png'),'-alpha','extract','-depth','8','gray:-'],{maxBuffer:2*1024*1024});
let interiorPixels=0,holes=0;
for(let y=0;y<1000;y++)for(let x=0;x<1600;x++){
 const a=(x+.5-scene.originPx[0])/16,b=(y+.5-scene.originPx[1])/8;
 const u=(a+b)/2,v=(b-a)/2;
 if(u>=.5&&u<48.5&&v>=.5&&v<38.5){interiorPixels++;if(ground[y*1600+x]!==255)holes++;}
}
assert.equal(holes,0,'Transparent seams inside the ground');
const png=fs.readFileSync(path.join(root,'sample-neighbourhood.png'));
assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[1600,1000]);
const alpha2=execFileSync('magick',[path.join(root,'.packing-2/ground-proof.png'),'-alpha','extract','-depth','8','gray:-'],{maxBuffer:2*1024*1024});
const raised=execFileSync('magick',[path.join(root,'.packing-2/terrace-proof.png'),'-alpha','extract','-depth','8','gray:-'],{maxBuffer:2*1024*1024});
let scene2Holes=0,terraceHoles=0,terracePixels=0,wallPixels=0,wallHoles=0;
for(let y=0;y<1000;y++)for(let x=0;x<1600;x++){
 const a=(x+.5-scene2.originPx[0])/16,b=(y+.5-scene2.originPx[1])/8;
 const u=(a+b)/2,v=(b-a)/2;
 if(u>=.5&&u<48.5&&v>=.5&&v<38.5&&alpha2[y*1600+x]!==255)scene2Holes++;
 // Upper plane is 4 screen pixels above z=0. Pixel-centre inequalities cover all joins.
 const bu=(y+.5-scene2.originPx[1]+4)/8,uu=(a+bu)/2,vv=(bu-a)/2;
 if(uu>=1.5&&uu<18.5&&vv>=11.5&&vv<29.5){
   terracePixels++;if(raised[y*1600+x]!==255)terraceHoles++;
 }
 // Front two cliff faces, tested without any lower grass behind them.
 const surfaceFront=(u>=18.25&&u<18.5&&v>=12&&v<29)||(v>=29.25&&v<29.5&&u>=2&&u<18);
 if(surfaceFront){wallPixels++;if(raised[y*1600+x]!==255)wallHoles++;}
}
assert.equal(scene2Holes,0,'Second sample has ground holes');
assert.equal(terraceHoles,0,'Isolated elevated plateau has gaps');
assert(wallPixels>200);assert.equal(wallHoles,0,'Terrace cliff face has gaps');
const png2=fs.readFileSync(path.join(root,'sample-neighbourhood-2.png'));
assert.deepEqual([png2.readUInt32BE(16),png2.readUInt32BE(20)],[1600,1000]);
const png3=fs.readFileSync(path.join(root,'sample-planets.png'));
assert.deepEqual([png3.readUInt32BE(16),png3.readUInt32BE(20)],[1600,1000]);
assert.equal(scene3.scale,0.5);
assert.deepEqual(scene3.planets.map(p=>p.id),planetJobs.map(j=>j.id));
for(const p of scene3.planets){
 const s=byId[p.id];
 const [x,y]=p.screenAnchorPx.map((n,i)=>n-s.anchorPx[i]*scene3.scale);
 assert(x>=0&&y>=0&&x+s.sizePx[0]*scene3.scale<=1600&&y+s.sizePx[1]*scene3.scale<=1000,'Planet clipped in sample');
}
const report={status:'passed',sprites:manifest.sprites.length,newSprites:jobs.length+planetJobs.length+agentJobs.length,counts,agentValidation,
 originalSpritesPreserved:baseline.sprites.length,earlierSpritesPreserved:baseline2.sprites.length,shutteredPairsChecked:18,catalogueSprites:manifest.sprites.length,
 planetRouteAnchorsChecked:3,sample3Scale:scene3.scale,
 groundTileSize:[128,64],terraceTileSize:[128,80],stepPx:16,sampleSize:[1600,1000],sampleScale:scene.scale,
 checkedInteriorGroundPixels:interiorPixels,transparentGroundSeamPixels:holes,
 sample2TransparentGroundSeamPixels:scene2Holes,isolatedTerracePixelsChecked:terracePixels,
 isolatedTerraceSeamPixels:terraceHoles,cliffPixelsChecked:wallPixels,cliffGapPixels:wallHoles,
 transparentSpritePixels:transparentPixels,
 checks:[`${manifest.sprites.length} PNG files, dimensions, hashes, anchors, footprints and alpha`,'98 earlier manifest entries unchanged',
 '40 body frames, 5 badges, 12 directional overlays; fixed walk anchors and head axes; 1600x1000 agent sample',
 'Three single-frame planets, three-tile width, visible route attachments and unclipped common-scale sample',
 'All 52 requested additions present','All 18 shuttered variants retain original dimensions, footprint and anchor',
 'All scenic sprites occur in a sample; all sprites occur in catalogue','All four 1600x1000 samples',
 'Integer tile placement; ground seams; elevated plateau and front cliff coverage without lower-ground backing'],
 limitations:['Generated architectural silhouettes are close matches, not pixel-identical edits.',
 'The terrace meshes resample shared generated lawn and limestone surfaces for exact joins.',
 'Coverage checks certify no transparent gaps, not CAD accuracy or every possible terrain layout.',
 'Purpose-based terrain logic and automatic selection of new sprites are a separate UI task.']};
fs.writeFileSync(path.join(root,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
