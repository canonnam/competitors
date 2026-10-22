(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.RecipientHistoryUI=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'미조회';
  function label(b){return b.status==='previous'?'재조회 실패 · 이전 결과':b.status==='failed'?'조회 실패':!b.available?'미조회':b.reviewPeople?'확인 필요':b.changedPeople||b.scheduledPeople?'변경 있음':'확인된 자격 변경 없음';}
  function summary(data){
    if(!data||!Array.isArray(data.branches))return '<p class="rh-muted">조회 자료를 불러오지 못했습니다.</p>';
    return `<p class="rh-muted">급여제공월 ${esc(data.benefitMonth)} · 조회 시점 기준</p><div class="rh-branches">${data.branches.map(b=>`<section class="rh-branch"><div class="rh-branch-head"><h3>${esc(b.name)}</h3><span class="ui-status"${b.status==='failed'?' data-status="error"':b.status==='previous'||b.reviewPeople||b.changedPeople||b.scheduledPeople?' data-status="warning"':b.available?' data-status="success"':''}>${esc(label(b))}</span></div>${b.available?`<dl class="rh-counts"><div><dt>자격 변경</dt><dd>${esc(b.changedPeople)}명</dd></div><div><dt>변경 예정</dt><dd>${esc(b.scheduledPeople)}명</dd></div><div><dt>확인 필요</dt><dd>${esc(b.reviewPeople)}명</dd></div><div><dt>기간 갱신</dt><dd>${esc(b.periodOnlyPeople)}명</dd></div></dl><p class="rh-muted">조회 ${esc(time(b.checkedAt))} · ${esc(b.people)}명 / 원본 ${esc(b.sourceRecords)}행</p>`:`<p class="rh-muted">${b.failure?'조회하지 못했습니다. 로그인·PC 상태를 확인해주세요.':'이 월의 성공한 조회 자료가 없습니다.'}</p>`}${b.failure?`<p class="rh-error">재조회 실패 ${esc(time(b.failure.failedAt))}${b.available?' · 아래 수치는 이전 성공 자료입니다.':''}</p>`:''}</section>`).join('')}</div>`;
  }
  return {esc,time,label,summary};
});
