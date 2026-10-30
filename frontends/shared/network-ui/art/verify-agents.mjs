import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export function verifyAgents(manifest,root){
 const json=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
 const baseline=json('manifest-set-3.json');
 const byId=Object.fromEntries(manifest.sprites.map(s=>[s.id,s]));
 for(const s of baseline.sprites)assert.deepEqual(byId[s.id],s,'Earlier sprite changed: '+s.id);
 const sprites=manifest.sprites.filter(s=>s.category==='agent');
 assert.equal(sprites.length,57);
 const bodies=sprites.filter(s=>s.agentKind==='body');
 const badges=sprites.filter(s=>s.agentKind==='badge');
 const overlays=sprites.filter(s=>s.agentKind==='overlay');
 assert.deepEqual([bodies.length,badges.length,overlays.length],[40,5,12]);
 const pixels=new Map();
 const alpha=s=>{
  if(!pixels.has(s.id))pixels.set(s.id,execFileSync('magick',[path.join(root,s.file),'-alpha','extract','-depth','8','gray:-']));
  return pixels.get(s.id);
 };
 let maxHeadAxisErrorPx=0;
 for(const s of bodies){
  assert.deepEqual(s.sizePx,[160,160]);assert.deepEqual(s.anchorPx,[80,144]);
  assert.equal(s.figureHeightPx,128);
  const a=alpha(s);let top=160,bottom=-1,left=160,right=-1;
  for(let y=0;y<160;y++)for(let x=0;x<160;x++)if(a[y*160+x]>128){
   top=Math.min(top,y);bottom=Math.max(bottom,y);
   if(y<48){left=Math.min(left,x);right=Math.max(right,x);}
  }
  assert(top>=16&&top<=18,s.id+' head top drift');
  assert(bottom>=141&&bottom<=143,s.id+' foot baseline drift');
  const error=Math.abs((left+right)/2-80);
  assert(error<=1,s.id+' head axis drift');maxHeadAxisErrorPx=Math.max(maxHeadAxisErrorPx,error);
  // No clipping against any edge of the common canvas.
  for(let i=0;i<160;i++)assert(a[i]===0&&a[159*160+i]===0&&a[i*160]===0&&a[i*160+159]===0,s.id+' clipped');
 }
 const walkStrips=[];
 for(const family of ['claude','codex']){
  for(const direction of ['sw','se'])for(const pose of ['idle','working'])assert(byId[`agent-${family}-${pose}-${direction}`]);
  for(const direction of ['sw','se','nw','ne']){
   const frames=[1,2,3,4].map(i=>byId[`agent-${family}-walk-${direction}-${i}`]);
   assert(frames.every(Boolean));assert.equal(new Set(frames.map(s=>s.sha256)).size,4,'Repeated walk frame');
   frames.forEach((s,i)=>{assert.equal(s.frame,i+1);assert.equal(s.frameDurationMs,140);assert.equal(s.animation,`${family}-walk-${direction}`);});
   const strip=fs.readFileSync(path.join(root,`agents/${family}-walk-${direction}-strip.png`));
   assert.deepEqual([strip.readUInt32BE(16),strip.readUInt32BE(20)],[640,160]);
   walkStrips.push(`${family}-${direction}`);
  }
 }
 assert.deepEqual(badges.map(s=>s.status).sort(),['disconnected','done','failed','thinking','waiting']);
 for(const s of badges){assert.deepEqual(s.sizePx,[32,32]);assert.deepEqual(s.anchorPx,[16,31]);assert.deepEqual(s.attachOffsetPx,[0,-136]);}
 const roles=['writer','engineer','scientist','teacher','builder','reviewer'];
 for(const role of roles)for(const direction of ['sw','se']){
  const s=byId[`agent-role-${role}-${direction}`];assert(s);
  assert.deepEqual(s.sizePx,[160,160]);assert.deepEqual(s.anchorPx,[80,144]);
  assert.deepEqual(s.compatibleFamilies,['claude','codex']);assert.equal(s.pose,'idle');
  const a=alpha(s);assert(a.some(n=>n>128));
  for(const family of s.compatibleFamilies){
   const body=alpha(byId[`agent-${family}-idle-${direction}`]);
   let overlap=0;for(let i=0;i<a.length;i++)if(a[i]>128&&body[i]>128)overlap++;
   assert(overlap>3,s.id+' does not meet '+family+' idle sprite');
  }
 }
 const generation=json('generation-agents.json');
 assert.equal(generation.tool,'built-in image_gen');assert.equal(generation.jobs.length,57);
 for(const j of generation.jobs){assert(byId[j.id]);assert(j.prompt&&j.generatedFile);assert(fs.existsSync(path.join(root,j.source)));}
 const scene=json('sample-scene-agents.json');assert.equal(scene.scale,0.75);
 assert.equal(scene.objects.filter(p=>byId[p.id].category==='building').length,2);
 assert(new Set(scene.agents.filter(p=>byId[p.id].pose==='walk').map(p=>byId[p.id].family)).size===2);
 assert.equal(new Set(scene.agents.map(p=>p.badge)).size,5);
 for(const p of [...scene.ground,...scene.objects,...scene.agents]){
  assert(byId[p.id]);assert(Number.isInteger(p.u)&&Number.isInteger(p.v));
  const s=byId[p.id],x=scene.originPx[0]+48*(p.u-p.v)-s.anchorPx[0]*scene.scale,y=scene.originPx[1]+24*(p.u+p.v)-s.anchorPx[1]*scene.scale;
  assert(x>=0&&y>=0&&x+s.sizePx[0]*scene.scale<=1600&&y+s.sizePx[1]*scene.scale<=1000,p.id+' clipped in sample');
 }
 const png=fs.readFileSync(path.join(root,'sample-agents.png'));
 assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[1600,1000]);
 const hashes=sprites.map(s=>createHash('sha256').update(fs.readFileSync(path.join(root,s.file))).digest('hex'));
 assert.equal(new Set(hashes).size,57);
 return {status:'passed',bodyFrames:40,walkFrames:32,walkCycles:8,badges:5,directionalRoleOverlays:12,
  canvasPx:[160,160],anchorPx:[80,144],figureHeightPx:128,maxHeadAxisErrorPx,earlierSpritesPreserved:baseline.sprites.length,
  walkStrips,sampleSizePx:[1600,1000],sampleScale:scene.scale,
  limitations:['Generated walk poses are separate paintings with some texture and silhouette variation; fixed anchors do not guarantee optical-flow smoothness.','Role overlays are fitted to idle poses only.','This pack contains artwork, not live agent presence or movement code.']};
}
