(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
  const expanded=new Set(),labels={checked:'점검 완료',updated:'보완 완료',needs_approval:'승인 대기',blocked:'확인 필요'};
  const date=value=>new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'});
  function render(item,provider){
    const q=item.content_quality,key=provider+'-'+item.branch+'-'+encodeURIComponent(item.keyword);
    const stale=q&&Date.now()-new Date(q.checked_at).getTime()>4*86400000;
    const status=q?(stale?'갱신 대기':labels[q.status]||'확인 필요'):'점검 기록 대기';
    const branch=item.branch==='incheon'?'인천점':'안양점';
    const list=(title,items)=>items?.length?`<h4>${title}</h4><ul>${items.map(v=>`<li>${esc(v)}</li>`).join('')}</ul>`:'';
    const old=item.mission?.history||[];
    return `<section class="aeo-mission" aria-label="${esc(branch)} 콘텐츠 관리"><details class="aeo-panel" data-mission-panel="${esc(key)}"${expanded.has(key)?' open':''}><summary>콘텐츠 개선 · ${status}</summary><p class="visibility-small">${branch} 홈페이지·블로그 공통 관리 기록${q?' · '+esc(date(q.checked_at)):''}</p>${q?`${stale?'<p>아래는 이전 점검 기록입니다.</p>':''}<p>${esc(q.summary)}</p>${q.completed?.length?`<h4>확인·보완한 내용</h4><ul>${q.completed.map(entry=>`<li>${esc(entry.note)}${safeUrl(entry.url)?` · <a href="${esc(safeUrl(entry.url))}" target="_blank" rel="noopener noreferrer">공개 페이지</a>`:''}<span class="visibility-small">검증 ${esc(date(entry.verified_at))}</span></li>`).join('')}</ul>`:''}${list('다음 작업',q.next_tasks)}${list('승인 대기',q.approvals)}`:'<p>다음 콘텐츠 관리 실행에서 실제 확인한 내용과 후속 작업을 기록합니다.</p>'}${old.length?`<details><summary>이전 미션 기록 ${old.length}건</summary><ul>${old.map(e=>`<li>${esc(e.title)} · ${e.action==='complete'?'완료':'미완료'}${e.note?' · '+esc(e.note):''}</li>`).join('')}</ul></details>`:''}</details></section>`;
  }
  root.AeoMissions={render,safeUrl,isEditing:()=>false};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.AeoMissions;
  if(typeof document==='undefined')return;
  document.addEventListener('toggle',e=>{const el=e.target;if(!el.matches?.('.aeo-panel'))return;if(el.open)expanded.add(el.dataset.missionPanel);else expanded.delete(el.dataset.missionPanel);},true);
})(globalThis);
