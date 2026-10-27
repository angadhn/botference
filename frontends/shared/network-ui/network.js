const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
export function layout(nodes, links, width = 900, height = 600) {
  const count = nodes.length;
  const positions = nodes.map((n, i) => ({ ...n, x: width/2 + Math.cos(i * Math.PI*2/Math.max(1,count)) * Math.min(260, count*25),
    y: height/2 + Math.sin(i * Math.PI*2/Math.max(1,count)) * Math.min(210, count*20) }));
  const byId = new Map(positions.map(p => [p.id,p]));
  for (let tick=0; tick<150; tick++) {
    const force = new Map(positions.map(p => [p.id,{x:(width/2-p.x)*.04,y:(height/2-p.y)*.04}]));
    for(let i=0;i<count;i++) for(let j=i+1;j<count;j++) {
      const a=positions[i],b=positions[j],dx=a.x-b.x||.1,dy=a.y-b.y||.1,d2=Math.max(400,dx*dx+dy*dy),f=350/d2;
      force.get(a.id).x+=dx*f;force.get(a.id).y+=dy*f;force.get(b.id).x-=dx*f;force.get(b.id).y-=dy*f;
    }
    for(const link of links){const a=byId.get(link.a),b=byId.get(link.b);if(!a||!b)continue;
      const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,f=(d-150)*(link.state==='suggested'?.015:.05)/d;
      force.get(a.id).x+=dx*f;force.get(a.id).y+=dy*f;force.get(b.id).x-=dx*f;force.get(b.id).y-=dy*f;
    }
    for(const p of positions){const f=force.get(p.id);p.x=Math.max(100,Math.min(width-100,p.x+Math.max(-12,Math.min(12,f.x))));p.y=Math.max(65,Math.min(height-65,p.y+Math.max(-12,Math.min(12,f.y))));}
  }
  return positions;
}

if (typeof document !== 'undefined') {
  const $=id=>document.getElementById(id);
  let data=null,selected=new URLSearchParams(location.hash.slice(1)).get('project')||new URLSearchParams(location.hash.slice(1)).get('link')||null,root=new URLSearchParams(location.search).get('root')||'';
  async function request(url, body){const r=await fetch(url,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    let d;try{d=await r.json();}catch{throw new Error('Sign in to this workspace, then reopen Project connections.');}
    if(!r.ok||d.ok===false)throw new Error(d.error||'The request failed');return d;}
  async function load(refresh=false){$('status').textContent=refresh?'Refreshing file evidence…':'Loading project records…';$('status').classList.remove('error');$('refresh').disabled=true;
    try{data=await request('/project-network?root='+encodeURIComponent(root)+(refresh?'&refresh=1':''));root=data.root;
      $('root').innerHTML=(data.roots||[root]).map(r=>`<option value="${esc(r)}">${esc(r.split('/').pop()||r)}</option>`).join('');$('root').value=root;
      render();}catch(e){$('status').textContent=e.message;$('status').classList.add('error');}finally{$('refresh').disabled=false;}}
  function filtered(){const q=$('search').value.trim().toLowerCase();return data.projects.filter(p=>($('archived').checked||p.status!=='archived')&&p.id!=='plugin-pages')
    .filter(p=>!q||[p.title,p.summary,...data.outputs.filter(o=>o.projects?.includes(p.id)).map(o=>o.title)].join(' ').toLowerCase().includes(q));}
  function linkClass(l){return l.stale||l.state==='dismissed'?'stale':l.state==='suggested'?'suggested':'linked';}
  function render(){if(!data)return;const all=filtered(),nodes=all.slice(0,60),ids=new Set(nodes.map(n=>n.id));
    const edges=data.links.filter(l=>ids.has(l.a)&&ids.has(l.b)&&($('suggestions').checked||l.state!=='suggested')&&($('dismissed').checked||l.state!=='dismissed'));
    const narrow=window.matchMedia('(max-width:800px)').matches;const width=narrow?420:900,height=narrow?420:600;$('map').setAttribute('viewBox',`0 0 ${width} ${height}`);$('map').classList.toggle('narrow',narrow);const points=layout(nodes,edges,width,height),byId=new Map(points.map(p=>[p.id,p]));
    $('map').classList.toggle('dense',nodes.length>12);
    $('map').innerHTML=edges.map(l=>{const a=byId.get(l.a),b=byId.get(l.b);const siblings=edges.filter(e=>[e.a,e.b].sort().join('|')===[l.a,l.b].sort().join('|'));const offset=(siblings.indexOf(l)-(siblings.length-1)/2)*34;const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1,cx=(a.x+b.x)/2-dy/length*offset,cy=(a.y+b.y)/2+dx/length*offset;return `<path class="edge ${linkClass(l)}" fill="none" data-link="${esc(l.id)}" tabindex="0" role="button" aria-label="${esc(l.relation+': '+l.reason)}" d="M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}"><title>${esc(l.relation+': '+l.reason)}</title></path>`;}).join('')
      +points.map(p=>{const n=data.outputs.filter(o=>o.projects?.includes(p.id)).length;return `<g class="node ${selected===p.id?'selected':''}" data-project="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(p.title)}" transform="translate(${p.x},${p.y})"><circle class="hit" r="35"/><circle r="${18+Math.min(10,n*2)}"/><text class="count" text-anchor="middle" dy="4">${n}</text><text class="label" text-anchor="middle" y="43">${esc(p.title.length>29?p.title.slice(0,27)+'…':p.title)}</text><title>${esc(p.title)}</title></g>`;}).join('')
      +(nodes.length?'':`<text class="empty" x="${width/2}" y="${height/2}" text-anchor="middle">No matching projects yet.</text>`);
    $('status').textContent=`${all.length} projects · ${data.outputs.filter(o=>o.projects?.length).length} linked outputs · ${data.sources.length} reading conversations${all.length>60?' · map shows the first 60; filter to narrow it':''}`;
    $('projects').innerHTML=all.map(p=>`<button data-project="${esc(p.id)}">${esc(p.title)}<small>${data.outputs.filter(o=>o.projects?.includes(p.id)).length} outputs · ${data.sources.filter(s=>s.projects?.includes(p.id)).length} readings</small></button>`).join('');
    if(selected) detail(selected);
  }
  function outputItem(o){const url=safeUrl(o.url);return `<div class="item">${url?`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(o.title)}</a>`:esc(o.title)}${o.missing?'<small class="error">File missing — its record is retained</small>':''}<details><summary class="muted">Source file and version</summary><small>${esc(o.path)}</small><small>Version ${esc(o.revision||'not indexed yet')}</small></details></div>`;}
  function sourceItem(s){const url=safeUrl(s.url);const discussion=(data.surface==='discuss'?location.origin:(data.discuss_base||'http://127.0.0.1:4189'))+'/p/'+encodeURIComponent(s.page_key);return `<div class="item">${url?`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`:esc(s.title)}<small>${esc(s.kind)} · ${(s.chats||[]).length} chat sessions · <a href="${esc(discussion)}" target="_blank" rel="noopener">Open discussion</a></small><small>${esc(s.excerpt||'')}</small></div>`;}
  function detail(id){selected=id;$('map').querySelectorAll('[data-project]').forEach(n=>n.classList.toggle('selected',n.dataset.project===id));const p=data.projects.find(p=>p.id===id);const l=data.links.find(l=>l.id===id);
    if(p){const outputs=data.outputs.filter(o=>o.projects?.includes(id)),sources=data.sources.filter(s=>s.projects?.includes(id)),links=data.links.filter(l=>(l.a===id||l.b===id)&&l.state!=='dismissed');
      $('detail').innerHTML=`<span class="tag">Project · ${esc(p.status)}</span><h2>${esc(p.title)}</h2><p>${esc(p.summary||'')}</p><h3>Outputs</h3>${outputs.map(outputItem).join('')||'<p class="muted">No outputs yet. A project can remain a collection of reading and discussion.</p>'}<h3>Reading conversations</h3>${sources.map(sourceItem).join('')||'<p class="muted">Link a reading from Discuss to collect it here.</p>'}<h3>Connections</h3>${links.map(l=>`<div class="item"><button data-link="${esc(l.id)}" class="${linkClass(l)}">${esc(data.projects.find(p=>p.id===(l.a===id?l.b:l.a))?.title||'Related project')}</button><small>${esc(l.relation)} · ${esc(l.origin)}</small></div>`).join('')||'<p class="muted">No recorded connections.</p>'}<h3>Add an output</h3><form id="output-form"><label>Existing file <input name="file" type="text" required placeholder="Absolute path inside this project"></label><label>Title <input name="title" type="text" placeholder="Optional display title"></label><button>Link file to project</button><small class="muted">The file stays where it is. This does not grant write access.</small></form>`;
      $('output-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);await act('/project-network/output',{root,project:id,file:f.get('file'),title:f.get('title')});};
    }else if(l){const a=data.projects.find(p=>p.id===l.a),b=data.projects.find(p=>p.id===l.b);const uses=(l.uses||[]).map(id=>data.uses.find(u=>u.id===id)).filter(Boolean);
      $('detail').innerHTML=`<span class="tag ${linkClass(l)}">${esc(l.stale?'Evidence changed':l.state)} · ${esc(l.origin)}</span><h2>${esc(a?.title)} ↔ ${esc(b?.title)}</h2><p><strong>${esc(l.relation.replaceAll('_',' '))}</strong></p><p>${esc(l.reason)}</p><p class="muted">A connection records relevance or use. It does not establish that the projects' claims agree or are true.</p><div class="actions">${l.state==='dismissed'?'<button data-action="restore">Restore</button>':'<button data-action="dismiss">Dismiss</button>'}${l.state==='suggested'?'<button data-action="link">Link these projects</button>':''}</div>${uses.length?'<h3>Evidence of use</h3>':''}${uses.map(u=>{const o=data.outputs.find(o=>o.id===u.output);return `<div class="item"><strong>${esc(o?.title||u.output)}</strong><small>${u.active?'Current citation':'Citation removed from current file'} · line ${u.line} · version ${esc(u.revision)}</small><div class="evidence">${esc(u.excerpt)}</div></div>`;}).join('')}`;
      $('detail').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act('/project-network/edge',{root,id:l.id,action:b.dataset.action}));
    }
  }
  async function act(url,body){try{await request(url,body);await load();}catch(e){$('status').textContent=e.message;$('status').classList.add('error');}}
  const select=e=>{const el=e.target.closest('[data-project],[data-link]');if(el){detail(el.dataset.project||el.dataset.link);$('detail').scrollIntoView({block:'nearest',behavior:'smooth'});}};
  $('map').onclick=select;$('projects').onclick=select;
  $('map').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(e);}};
  $('detail').addEventListener('click',e=>{const b=e.target.closest('[data-link]');if(b)detail(b.dataset.link);});
  $('search').oninput=render;for(const id of ['suggestions','archived','dismissed'])$(id).onchange=render;
  $('root').onchange=()=>{root=$('root').value;selected=null;load();};$('refresh').onclick=()=>load(true);
  load();
}
