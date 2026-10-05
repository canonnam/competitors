/* Explicitly marked explanations retain their live nodes and original print position. */
(function () {
  'use strict';
  const doc=document, entries=[], mounted=new WeakSet();
  let active=null, sequence=0;
  const focusable='a[href],button,input,select,textarea,[tabindex]';
  const icon='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></svg>';
  function hide(entry=active){
    if(!entry)return;
    clearTimeout(entry.timer);entry.pinned=false;entry.panel.hidden=true;
    entry.button.setAttribute('aria-expanded','false');
    if(entry.sources[0].marker.isConnected)entry.sources[0].marker.after(entry.panel);
    if(active===entry)active=null;
  }
  function position(entry){
    const a=entry.button.getBoundingClientRect(),p=entry.panel.getBoundingClientRect();
    const width=doc.documentElement.clientWidth,height=window.innerHeight;
    entry.panel.style.left=Math.max(12,Math.min(a.left,width-p.width-12))+'px';
    const top=a.bottom+8+p.height<=height-12?a.bottom+8:a.top-p.height-8;
    entry.panel.style.top=Math.max(12,Math.min(top,height-p.height-12))+'px';
  }
  function show(entry){
    if(active!==entry)hide();
    active=entry;clearTimeout(entry.timer);(entry.button.closest('dialog[open]')||doc.body).append(entry.panel);
    entry.panel.hidden=false;entry.button.setAttribute('aria-expanded','true');position(entry);
  }
  function leave(entry){
    clearTimeout(entry.timer);
    if(!entry.pinned&&!entry.panel.contains(doc.activeElement))entry.timer=setTimeout(()=>hide(entry),180);
  }
  function mount(){
    for(let index=entries.length-1;index>=0;index--)if(!entries[index].button.isConnected){hide(entries[index]);entries[index].panel.remove();entries.splice(index,1);}
    for(const source of doc.querySelectorAll('[data-ui-help]')){
      if(mounted.has(source))continue;
      let anchor=source.dataset.uiHelpTarget?doc.querySelector(source.dataset.uiHelpTarget):null;
      if(!source.dataset.uiHelpTarget)for(let region=source.parentElement;region;region=region.parentElement){
        const heading=region.querySelector(region.tagName==='DETAILS'?'summary':'h1,h2,h3');
        if(heading&&!source.contains(heading)){anchor=heading;break;}
      }
      if(!anchor)continue;
      mounted.add(source);
      const label=source.dataset.uiHelp, marker=doc.createComment('Explanation print position');
      const wasOpen=source.tagName==='DETAILS'?source.open:null;
      const group=entries.find(entry=>entry.anchor===anchor&&entry.label===label);
      if(group){source.before(marker);group.panel.append(source);if(wasOpen!==null)source.open=true;group.sources.push({source,marker,wasOpen});continue;}
      const panel=doc.createElement('div'),button=doc.createElement('button');
      panel.id='ui-help-'+(++sequence);panel.className='ui-tooltip ui-help-tooltip';panel.setAttribute('role','tooltip');panel.hidden=true;
      const title=doc.createElement('strong');title.textContent=label;panel.append(title);
      source.before(marker);source.replaceWith(panel);panel.append(source);
      if(wasOpen!==null)source.open=true;
      button.type='button';button.className='ui-button ui-info-button ui-help-button';button.innerHTML=icon;
      button.setAttribute('aria-label',label);button.setAttribute('aria-describedby',panel.id);button.setAttribute('aria-controls',panel.id);button.setAttribute('aria-expanded','false');
      anchor.append(button);
      const entry={button,panel,anchor,label,sources:[{source,marker,wasOpen}],pinned:false,timer:null};entries.push(entry);
      button.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse')show(entry);});
      button.addEventListener('pointerleave',()=>leave(entry));
      button.addEventListener('focus',()=>show(entry));
      button.addEventListener('blur',event=>{if(!panel.contains(event.relatedTarget))hide(entry);});
      button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(entry.pinned)hide(entry);else{show(entry);entry.pinned=true;}});
      button.addEventListener('keydown',event=>{
        if(event.key==='Tab'&&!event.shiftKey&&!panel.hidden){const first=panel.querySelector(focusable);if(first){event.preventDefault();first.focus();}}
      });
      panel.addEventListener('keydown',event=>{
        if(event.key!=='Tab')return;
        const links=[...panel.querySelectorAll(focusable)].filter(node=>!node.disabled&&node.tabIndex>=0&&node.getClientRects().length);
        if(event.shiftKey&&doc.activeElement===links[0]){event.preventDefault();button.focus();}
        else if(!event.shiftKey&&doc.activeElement===links[links.length-1]){
          const controls=[...doc.querySelectorAll(focusable)].filter(node=>!panel.contains(node)&&!node.disabled&&node.tabIndex>=0&&node.getClientRects().length);
          const next=controls[controls.indexOf(button)+1];if(next){event.preventDefault();hide(entry);next.focus();}
        }
      });
      panel.addEventListener('pointerenter',()=>clearTimeout(entry.timer));panel.addEventListener('pointerleave',()=>leave(entry));
      panel.addEventListener('focusout',event=>{if(!panel.contains(event.relatedTarget)&&event.relatedTarget!==button)hide(entry);});
    }
    if(active&&active.button.isConnected)position(active);
  }
  doc.addEventListener('pointerdown',event=>{if(active&&!active.button.contains(event.target)&&!active.panel.contains(event.target))hide();});
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&active){event.preventDefault();const entry=active;if(entry.panel.contains(doc.activeElement))entry.button.focus();hide(entry);}});
  window.addEventListener('resize',()=>hide());
  window.addEventListener('scroll',event=>{if(active&&!active.panel.contains(event.target))hide();},true);
  window.addEventListener('beforeprint',()=>{
    hide();
    for(const entry of entries){for(const item of entry.sources){item.marker.after(item.source);if(item.wasOpen!==null)item.source.open=item.wasOpen;}entry.panel.remove();}
  });
  window.addEventListener('afterprint',()=>{
    for(const entry of entries){entry.sources[0].marker.after(entry.panel);for(const item of entry.sources){entry.panel.append(item.source);if(item.wasOpen!==null)item.source.open=true;}}
  });
  mount();
  new MutationObserver(mount).observe(doc.body,{childList:true,subtree:true});
})();
