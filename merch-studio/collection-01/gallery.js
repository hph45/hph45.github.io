(() => {
  'use strict';
  const items=window.ZBC_MERCH.items;
  const $=s=>document.querySelector(s);
  const labels={hoodie:'Hoodie',shirt:'T-shirt',cap:'Baseball cap'};
  const key='zbc-merch-collection-01-shortlist';
  let saved;
  try { saved=new Set(JSON.parse(localStorage.getItem(key)||'[]').filter(id=>items.some(i=>i.id===id))); } catch { saved=new Set(); }
  let filter='selected',active=null,lastFocus=null;
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4Z"/></svg>';
  function visible(){return items.filter(i=>filter==='all'||(filter==='selected'?i.selected:filter==='saved'?saved.has(i.id):i.category===filter));}
  function persist(){try{localStorage.setItem(key,JSON.stringify([...saved]));}catch{notify('Shortlist saved for this session.');}}
  function notify(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(notify.timer);notify.timer=setTimeout(()=>{$('#toast').hidden=true;},2400);}
  function render(){
    const list=visible();$('#saved-count').textContent=String(saved.size);$('#results').textContent=`${list.length} design${list.length===1?'':'s'}`;$('#empty').hidden=list.length>0;$('#export').disabled=!saved.size;
    document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===filter)));
    $('#grid').innerHTML=list.map(i=>`<article class="card"><span class="card-id">${i.id}</span><button class="card-open" data-open="${i.id}" aria-label="View ${escape(i.name)} ${labels[i.category]}"><img class="card-image" src="renders/${i.filename}" width="1536" height="1024" loading="lazy" alt="${escape(i.name)} ${labels[i.category]}, front and back with decoration close-up"><div class="card-bottom"><div><h2>${escape(i.name)}</h2><div class="card-meta">${labels[i.category]} · ${escape(i.color)}<br>${escape(i.method)}</div></div><svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 19 5M6 5h13v13"/></svg></div></button><button class="save" data-save="${i.id}" aria-pressed="${saved.has(i.id)}" aria-label="${saved.has(i.id)?'Remove':'Save'} ${escape(i.name)} ${labels[i.category]} ${saved.has(i.id)?'from':'to'} shortlist">${icon}</button></article>`).join('');
  }
  function toggle(id){saved.has(id)?saved.delete(id):saved.add(id);persist();render();if(active===id)updateSave();}
  function updateSave(){const b=$('#detail-save');if(b){b.setAttribute('aria-pressed',String(saved.has(active)));b.textContent=saved.has(active)?'Saved to shortlist':'Save to shortlist';}}
  function show(id){
    const i=items.find(x=>x.id===id);if(!i)return;active=id;
    $('#detail-kicker').textContent=`${i.id} / ${labels[i.category]} / COLLECTION 01`;
    $('#detail-body').innerHTML=`<img class="detail-render" src="renders/${i.filename}" alt="${escape(i.name)} ${labels[i.category]} product render"><div class="detail-content"><div><div class="detail-category">${labels[i.category]} · ${escape(i.color)}</div><h2 id="detail-title">${escape(i.name)}</h2><p>${escape(i.motif)}</p><button class="detail-save" id="detail-save" type="button"></button><div class="download-links"><a href="renders/${i.filename}" download>Download full render</a><a href="plans/${i.id}-prompt.txt" download>Generation prompt</a></div></div><dl class="detail-facts"><dt>Decoration</dt><dd>${escape(i.method)} · ${escape(i.ink)}</dd><dt>Front direction</dt><dd>${escape(i.front)}</dd><dt>Back direction</dt><dd>${escape(i.back)}</dd><dt>Supplier status</dt><dd>Blank and template not selected. Proposed artwork sizes are listed below. Fit and approve a sample before production.</dd></dl></div><section class="art-section"><h3>Flat artwork</h3><div class="art-grid">${i.artwork_files.map(f=>`<div><img class="art-preview ${i.ink==='cream'?'dark':''}" src="${f.svg}" alt="${escape(i.name)} ${f.side} outlined artwork"><div class="art-caption"><strong>${f.side==='front'?'Front':'Back'}</strong> · ${f.width_mm} × ${f.height_mm} mm<br><a href="${f.svg}" download>Outlined SVG</a><a href="${f.png}" download>Transparent PNG · 300 DPI</a></div></div>`).join('')}</div><p class="art-note">The vector masters are clean production interpretations of the render designs and control final shapes and lettering. Mockups illustrate placement, texture and styling; use the flat files for manufacture. Embroidery requires supplier digitization and a sew-out. Full specifications are in the <a href="supplier-handoff.html">supplier handoff</a>.</p></section>`;
    $('#detail-save').onclick=()=>toggle(id);updateSave();
    const list=visible();const position=list.findIndex(x=>x.id===id);$('#detail-position').textContent=`${Math.max(1,position+1)} / ${list.length||1}`;
    $('#detail').scrollTop=0;
    if(!$('#detail').open){lastFocus=document.activeElement;$('#detail').showModal();document.body.style.overflow='hidden';$('#close').focus();}
  }
  function close(){if($('#detail').open)$('#detail').close();document.body.style.overflow='';active=null;if(lastFocus?.isConnected)lastFocus.focus();else document.querySelector('[data-filter][aria-pressed=true]')?.focus();}
  function step(dir){const list=visible();if(!list.length)return close();const index=list.findIndex(i=>i.id===active);show(list[(index+dir+list.length)%list.length].id);}
  document.addEventListener('click',event=>{const b=event.target.closest('[data-open],[data-save],[data-filter]');if(!b)return;if(b.dataset.open)show(b.dataset.open);else if(b.dataset.save)toggle(b.dataset.save);else{filter=b.dataset.filter;render();}});
  $('#close').onclick=close;$('#detail').addEventListener('cancel',event=>{event.preventDefault();close();});$('#detail').addEventListener('click',event=>{if(event.target===$('#detail')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
  $('#previous').onclick=()=>step(-1);$('#next').onclick=()=>step(1);$('#show-all').onclick=()=>{filter='all';render();};
  $('#export').onclick=()=>{const selected=items.filter(i=>saved.has(i.id));const body='ZEBRA BOOK CLUB / COLLECTION 01\nDESIGN SHORTLIST\n\n'+selected.map(i=>`${i.id} — ${i.name} ${labels[i.category]}\nColor: ${i.color}; decoration: ${i.method}\nFront: ${i.front}\nBack: ${i.back}\nArtwork: ${i.artwork_files.map(f=>`${f.side} ${f.width_mm} x ${f.height_mm} mm`).join('; ')}\n`).join('\n')+'\nSupplier-neutral design proposals. Confirm blanks, templates, colors and physical samples before sale.\n';const u=URL.createObjectURL(new Blob([body],{type:'text/plain'}));const a=document.createElement('a');a.href=u;a.download='zbc-merch-shortlist.txt';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);notify('Shortlist exported.');};
  render();
})();
