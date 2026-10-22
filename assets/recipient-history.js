(function(){
  'use strict';
  const ui=window.RecipientHistoryUI, page=document.getElementById('recipient-history'), home=document.getElementById('home-recipient-history-status');
  if(!ui||(!page&&!home))return;
  const {esc,time}=ui;
  let data=null, requestId=0;
  const kind=e=>e.kind==='change'?(e.scheduled?'변경 예정':'자격 변경'):e.kind==='period'?'기간 갱신':'확인 필요';
  function render(){
    document.getElementById('rh-summary').innerHTML=ui.summary(data);
    const branch=document.getElementById('rh-branch').value, view=document.getElementById('rh-view').value;
    const branches=data.branches.filter(b=>(!branch||b.id===branch)&&b.available);
    const items=branches.flatMap(b=>(view==='records'?b.records:b.events).map(r=>({...r,branch:b.name})));
    const heads=view==='records'?['지점','수급자명','자격','적용일자','종료일자']:['지점','수급자명','구분','적용일자','이전 자격','이후 자격','확인 사항'];
    document.getElementById('rh-result-title').textContent=view==='records'?'원본 자격 이력':'해당 월 변경·확인 내역';
    document.getElementById('rh-table').innerHTML=items.length?`<div class="rh-table-wrap" tabindex="0" role="region" aria-label="수급자 이력 표, 좌우 스크롤 가능"><table><caption>${esc(data.benefitMonth)} · ${view==='records'?'원본 이력':'변경·확인 내역'} ${items.length}행</caption><thead><tr>${heads.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${items.map(r=>`<tr>${(view==='records'?[r.branch,r.name,r.qualification,r.appliedOn,r.endOn==='9999-12-31'?'종료일 미정':r.endOn]:[r.branch,r.name,kind(r),r.effectiveOn,r.before??'미확인',r.after??'미확인',r.reason||(r.kind==='period'?'자격 동일 · 기간만 갱신':r.scheduled?'조회일 이후 적용 예정':'원본 이전·이후 자격 대조')]).map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:`<p class="rh-muted">${branches.length?'선택한 지점에서 이 월에 확인된 변경·확인 내역이 없습니다.':'선택한 지점의 성공한 조회 자료가 없습니다.'}</p>`;
  }
  async function load(){
    const id=++requestId;
    const selected=page?document.getElementById('rh-month').value:'';
    try{
      const response=await fetch('/api/recipient-history'+(page?'':'/summary')+(selected?'?month='+encodeURIComponent(selected):''),{cache:'no-store',credentials:'same-origin'});
      if(!response.ok)throw new Error('수급자구분 변경이력을 불러오지 못했습니다. 로그인 및 연결 상태를 확인해주세요.');
      const incoming=await response.json();if(id!==requestId)return;data=incoming;
      if(home){home.textContent=incoming.branches.every(b=>b.available&&!b.failure)?`${incoming.benefitMonth} · 변경 ${incoming.branches.reduce((n,b)=>n+b.changedPeople,0)}명 · 확인 필요 ${incoming.branches.reduce((n,b)=>n+b.reviewPeople,0)}명`:`${incoming.benefitMonth} · 일부 미조회·실패`;window.HomeDashboard?.update('recipients',incoming);}
      if(page){const month=document.getElementById('rh-month');month.innerHTML=incoming.months.map(m=>`<option value="${esc(m)}"${m===incoming.benefitMonth?' selected':''}>${esc(m)}</option>`).join('');document.getElementById('rh-error').textContent='';render();}
    }catch(error){if(id!==requestId)return;if(home){home.textContent='조회 연결 확인 필요';window.HomeDashboard?.fail('recipients');}if(page)document.getElementById('rh-error').textContent=error.message+(data?' 이전 화면을 유지합니다.':'');}
  }
  if(page){document.getElementById('rh-month').addEventListener('change',load);for(const key of ['rh-branch','rh-view'])document.getElementById(key).addEventListener('change',()=>data&&render());document.getElementById('rh-refresh').addEventListener('click',load);}
  load();
  // Only reads saved summaries; never initiates a portal login or data collection.
  if(home)setInterval(()=>{if(!document.hidden)load();},60000);
})();
