(function(root){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
  const drafts=new Map(),contexts=new Map(),pending=new Set();
  const date=value=>new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
  function render(item,provider){
    const plan=item.mission;
    if(!plan)return '';
    const task=plan.current,key=plan.id;
    contexts.set(key,{provider,keyword:item.keyword,branch:item.branch,revision:plan.revision,mission_id:task?.id});
    const draft=drafts.get(key)||{};
    const history=plan.history.length?`<details class="aeo-history"><summary>진행 기록 ${plan.history.length}건</summary><ol>${plan.history.slice().reverse().map(event=>`<li><strong>${esc(event.title)} · ${event.action==='complete'?'완료':'미완료'}</strong><time>${esc(date(event.created_at))}</time>${event.reason?`<p>사유: ${esc(plan.reason_options[event.reason_code])} · ${esc(event.reason)}</p>`:''}${event.note?`<p>${esc(event.note)}</p>`:''}${safeUrl(event.evidence_url)?`<a href="${esc(safeUrl(event.evidence_url))}" target="_blank" rel="noopener noreferrer">작업 결과 보기</a>`:''}</li>`).join('')}</ol></details>`:'';
    return `<section class="aeo-mission" data-mission="${esc(key)}" aria-label="${esc(item.keyword)} AEO 미션"><div class="aeo-heading"><strong>AEO 순차 미션</strong><span>${esc(plan.track_label)}</span></div><p class="aeo-progress">${plan.completed} / ${plan.total}단계 완료</p><progress value="${plan.completed}" max="${plan.total}" aria-label="미션 진행률"></progress>${task?`
      <h4 tabindex="-1">${plan.completed+1}. ${esc(task.title)}</h4><p class="aeo-why">${esc(task.why)}</p><span class="aeo-duration">작업 약 ${task.minutes}분${task.id==='review'?' · 관측 7일 별도':''}</span><ol class="aeo-steps">${task.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol><p class="aeo-done"><strong>완료 기준</strong> ${esc(task.done)}</p>
      ${task.blocker?`<div class="aeo-blocker"><strong>미완료 사유를 반영한 재시도</strong><p>${esc(task.blocker.reason)}</p><p>${esc(task.retry)}</p><span>이 단계를 완료하면 다음 미션을 제안합니다.</span></div>`:''}
      <form data-plan="${esc(key)}"><fieldset${pending.has(key)?' disabled':''}><legend>이번 미션 결과</legend><div class="aeo-outcomes"><label><input type="radio" name="action" value="complete" required${draft.action==='complete'?' checked':''}> 완료했습니다</label><label><input type="radio" name="action" value="blocked" required${draft.action==='blocked'?' checked':''}> 하지 못했습니다</label></div>
      <div class="aeo-reason"${draft.action==='blocked'?'':' hidden'}><label>미완료 사유<select name="reason_code"${draft.action==='blocked'?' required':''}><option value="">사유를 선택해주세요</option>${Object.entries(plan.reason_options).map(([value,label])=>`<option value="${esc(value)}"${draft.reason_code===value?' selected':''}>${esc(label)}</option>`).join('')}</select></label><label>구체적인 이유<textarea name="reason" maxlength="1500" rows="3" placeholder="어떤 부분에서 막혔는지 적어주세요."${draft.action==='blocked'?' required':''}>${esc(draft.reason)}</textarea></label></div>
      <label>작업 메모 <span>(선택)</span><textarea name="note" maxlength="1500" rows="2" placeholder="확인한 내용이나 변경 결과">${esc(draft.note)}</textarea></label><label>결과 페이지 주소 <span>(선택)</span><input type="url" name="evidence_url" maxlength="2000" placeholder="https://" value="${esc(draft.evidence_url)}"></label><button type="submit">${pending.has(key)?'저장 중…':'결과 저장'}</button></fieldset><p class="aeo-save-status" role="status" aria-live="polite"></p></form>
      <a class="aeo-source" href="${esc(safeUrl(task.source.url))}" target="_blank" rel="noopener noreferrer">${esc(task.source.title)} ↗</a>`:'<h4 tabindex="-1">모든 미션을 완료했습니다.</h4><p>위 관측 기록에서 실제 언급·인용 변화를 계속 확인하세요. 완료 기록은 검색노출 결과를 변경하지 않습니다.</p>'}
      <details class="aeo-roadmap"><summary>전체 미션 순서</summary><ol>${plan.roadmap.map(step=>`<li>${step.complete?'완료 · ':step.id===task?.id?'진행 중 · ':''}${esc(step.title)}</li>`).join('')}</ol></details>${history}</section>`;
  }
  const api={render,safeUrl,isEditing:()=>typeof document!=='undefined'&&(pending.size>0||Boolean(document.activeElement?.closest('.aeo-mission form')))};
  root.AeoMissions=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;
  function remember(form){
    const key=form.dataset.plan,value=Object.fromEntries(new FormData(form));
    const previous=drafts.get(key);
    if(previous?.request_id&&JSON.stringify({...previous,request_id:undefined})===JSON.stringify(value))value.request_id=previous.request_id;
    drafts.set(key,value);
  }
  document.addEventListener('input',event=>{const form=event.target.closest('.aeo-mission form');if(form)remember(form);});
  document.addEventListener('change',event=>{
    const form=event.target.closest('.aeo-mission form');if(!form)return;
    remember(form);
    const blocked=form.elements.action.value==='blocked';
    form.querySelector('.aeo-reason').hidden=!blocked;
    form.elements.reason.required=blocked;form.elements.reason_code.required=blocked;
  });
  document.addEventListener('submit',async event=>{
    const form=event.target.closest('.aeo-mission form');if(!form)return;
    event.preventDefault();const key=form.dataset.plan;if(pending.has(key))return;
    remember(form);const draft=drafts.get(key),context=contexts.get(key),status=form.querySelector('.aeo-save-status');
    if(draft.action==='blocked'&&!draft.reason?.trim()){status.textContent='구체적인 미완료 이유를 입력해주세요.';form.elements.reason.focus();return;}
    if(draft.evidence_url&&!safeUrl(draft.evidence_url)){status.textContent='결과 주소는 http 또는 https 주소로 입력해주세요.';form.elements.evidence_url.focus();return;}
    draft.request_id ||= crypto.randomUUID();
    const body={...draft,...context};
    if(body.action==='complete'){body.reason='';body.reason_code='';}
    pending.add(key);form.querySelector('fieldset').disabled=true;status.textContent='저장 중…';
    try{
      const response=await fetch('/api/search-visibility/missions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'저장하지 못했습니다. 다시 시도해주세요.');
      drafts.delete(key);pending.delete(key);
      document.dispatchEvent(new CustomEvent('aeo-mission-saved',{detail:{id:key,mission:result.mission}}));
      const section=document.querySelector(`[data-mission="${key}"]`);
      if(section){const message=section.querySelector('.aeo-save-status');if(message)message.textContent=body.action==='complete'?'완료를 저장했습니다. 다음 미션을 확인하세요.':'미완료 사유를 저장했습니다. 재시도 안내를 확인하세요.';section.querySelector('h4')?.focus({preventScroll:true});}
    }catch(error){status.textContent=error.name==='TimeoutError'?'저장 응답이 늦습니다. 입력 내용은 유지됩니다. 다시 저장하거나 새로고침으로 확인해주세요.':error.message||'연결을 확인한 뒤 다시 저장해주세요.';}
    finally{pending.delete(key);form.querySelector('fieldset').disabled=false;}
  });
})(globalThis);
