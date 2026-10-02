/* Shared insurance status, actions and accessible explanations. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.LiabilityUI=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const people=value=>value===null||value===undefined?'—':`${value}명`;
  const paths={info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',edit:'<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>'};
  const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
  function schedule(data){
    const next=data?.nextCheckAt?new Date(data.nextCheckAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'확인 중';
    return `${data?.schedule||'매일 오전 9시 (한국시간)'} 자동 점검 · 다음 점검 ${next}`;
  }
  function info(data,extra=''){
    return `<button type="button" class="ui-button ui-info-button li-icon-button" aria-label="보험 자동 점검 안내" data-li-tooltip="${esc(schedule(data))}" ${extra}>${icon('info')}</button>`;
  }
  function actions(branch){
    const file=branch.certificate,label=branch.name+' 보험 증서 다운로드';
    return `<div class="li-card-actions">${file?`<a class="ui-button ui-info-button li-icon-button" href="${esc(file.url)}" aria-label="${esc(label)}" data-li-tooltip="${esc(label+' · '+file.name)}" data-dash-key="li-download-${branch.id}">${icon('download')}</a>`:`<button class="ui-button ui-info-button li-icon-button" type="button" disabled aria-label="${esc(branch.name)} 등록된 보험 증서 없음">${icon('download')}</button>`}<button class="ui-button ui-info-button li-icon-button" type="button" aria-label="${esc(branch.name)} 보험 정보 등록·수정" data-li-edit="${branch.id}" data-li-tooltip="${esc(branch.name)} 보험 정보 등록·수정" data-dash-key="li-edit-${branch.id}">${icon('edit')}</button></div>`;
  }
  function branch(branch,level=3){
    const p=branch.policy;
    return `<div class="li-heading"><h${level}>${esc(branch.name)}</h${level}><div class="li-heading-actions"><span class="ui-status" data-status="${esc(branch.status)}">${esc(branch.label)}</span>${actions(branch)}</div></div><dl class="li-counts"><div><dt>${branch.stale?'이전 전체 현원':'전체 현원'}</dt><dd>${people(branch.occupancy?.total)}</dd></div><div><dt>보험 가입 인원</dt><dd>${people(p?.insuredCount)}</dd></div></dl>${p?`<p class="li-period"><strong>${esc(p.insuranceName||'보험 이름 미등록')}</strong><br>가입기간 ${esc(p.startDate||'미등록')} ~ ${esc(p.endDate||'미등록')}${branch.daysRemaining!==null?`<br>${branch.daysRemaining<0?'만료됨':branch.daysRemaining===0?'오늘 만료':`만료 ${branch.daysRemaining}일 전`}`:''}</p>`:''}${branch.issues.length?`<ul class="li-issues">${branch.issues.map(i=>`<li data-status="${esc(i.tone)}">${esc(i.message)}</li>`).join('')}</ul>`:''}`;
  }
  function mountTooltips(doc,win){
    const tooltip=doc.createElement('div');tooltip.id='li-tooltip';tooltip.className='ui-tooltip';tooltip.setAttribute('role','tooltip');tooltip.hidden=true;doc.body.append(tooltip);
    let trigger=null,timer=null;
    function hide(){clearTimeout(timer);tooltip.hidden=true;trigger?.removeAttribute('aria-describedby');trigger=null;}
    function position(){
      if(!trigger?.isConnected){hide();return;}
      const rect=trigger.getBoundingClientRect(),box=tooltip.getBoundingClientRect(),width=doc.documentElement.clientWidth,height=win.innerHeight;
      tooltip.style.left=Math.max(12,Math.min(rect.left+rect.width/2-box.width/2,width-box.width-12))+'px';
      tooltip.style.top=Math.max(12,rect.top>=box.height+20?rect.top-box.height-8:Math.min(rect.bottom+8,height-box.height-12))+'px';
    }
    function show(button){clearTimeout(timer);if(trigger!==button)hide();trigger=button;tooltip.textContent=button.dataset.liTooltip;tooltip.hidden=false;button.setAttribute('aria-describedby',tooltip.id);position();}
    const target=event=>event.target.closest?.('[data-li-tooltip]');
    doc.addEventListener('pointerover',event=>{const button=target(event);if(button)show(button);});
    doc.addEventListener('pointerout',event=>{if(target(event)&&!event.relatedTarget?.closest?.('[data-li-tooltip]'))timer=setTimeout(hide,180);});
    tooltip.addEventListener('pointerenter',()=>clearTimeout(timer));tooltip.addEventListener('pointerleave',hide);
    doc.addEventListener('focusin',event=>{const button=target(event);if(button)show(button);});
    doc.addEventListener('focusout',event=>{if(target(event))hide();});
    doc.addEventListener('click',event=>{const button=target(event);if(button){if(button.hasAttribute('data-li-edit')||button.tagName==='A')hide();else show(button);}else if(!tooltip.contains(event.target))hide();});
    doc.addEventListener('keydown',event=>{if(event.key==='Escape')hide();});
    doc.addEventListener('scroll',hide,true);win.addEventListener('resize',hide);
    return {hide};
  }
  return {esc,icon,branch,info,schedule,mountTooltips};
});
