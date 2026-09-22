(function(root,factory){
  const common=typeof module==='object'&&module.exports;
  const api=factory(common?require('./operating-model.js'):root.OperatingModel,common?require('./operating-cards.js'):root.OperatingCards);
  if(common)module.exports=api;
  else {root.DashboardOperating=api;if(root.document?.body.classList.contains('kb-homepage'))api.start(root,root.HomeDashboard);}
})(typeof window==='undefined'?globalThis:window,function(M,Cards){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function prepare(data) {
    if(data?.schemaVersion!==1||!Array.isArray(data.branches))throw new Error('format');
    const branches=['anyang','incheon'].map(id=>{
      const matches=data.branches.filter(branch=>branch.id===id);
      if(matches.length>1)throw new Error('duplicate branch');
      const branch=matches[0]||{id,name:id==='anyang'?'안양점':'인천점',months:[]};
      if(!Array.isArray(branch.months))throw new Error('months');
      const seen=new Set();
      for(const m of branch.months) {
        if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m.month)||seen.has(m.month))throw new Error('month');
        seen.add(m.month);
        if(!['revenue','cost','profit','cashChange'].every(key=>Number.isSafeInteger(m[key]))||!Array.isArray(m.accounts)||!m.accounts.every(row=>typeof row.group==='string'&&Number.isSafeInteger(row.expense)))throw new Error('metric');
      }
      return branch;
    });
    const month=branches.flatMap(branch=>branch.months.map(m=>m.month)).sort().at(-1);
    return {month,branches};
  }
  function render(record) {
    if(!record?.data)return `<p class="dash-empty">${record?.error?'운영비 자료를 불러오지 못했습니다. 상세 보기에서 다시 확인해주세요.':'운영비 자료를 불러오는 중입니다.'}</p>`;
    const data=record.data,{month,branches}=prepare(data);
    if(!month)return '<p class="dash-empty">아직 등록된 운영비 자료가 없습니다.</p>';
    const href='/operating-costs.html?year='+month.slice(0,4)+'&month='+month;
    return `<div class="dash-operating-meta"><p class="dash-meta">${esc(month.slice(0,4))}년 ${Number(month.slice(5))}월 · 실제 입출금 기준 · 자료 기준 ${esc(data.sourceDate||'확인 필요')}</p><a href="${href}" data-dash-key="operating-detail">이 달 상세 보기</a></div>${record.error?'<p class="dash-warning">연결 확인 필요 · 이전에 불러온 자료입니다.</p>':''}<div class="dash-operating-grid">${branches.map(branch=>Cards.render(branch,branch.months.find(m=>m.month===month),branch.months.find(m=>m.month===M.previousMonth(month)))).join('')}</div><p class="dash-footnote">등록된 월별 자료 기준이며 새 거래를 자동 수집하지 않습니다. 수입 대비 인건비는 위 상태표의 연간 인건비 비율과 산정 기준이 다릅니다.</p>`;
  }
  function start(win,dashboard) {
    if(!dashboard)return;
    let loading=false;
    async function refresh() {
      if(loading||win.document.hidden)return;
      loading=true;
      try {
        const response=await win.fetch('/api/operating-report',{cache:'no-store',signal:win.AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('request');
        const data=await response.json();prepare(data);dashboard.update('operating',data);
      } catch(_){dashboard.fail('operating');}
      finally{loading=false;}
    }
    refresh();win.addEventListener('pageshow',refresh);
    win.document.addEventListener('visibilitychange',()=>{if(!win.document.hidden)refresh();});
    win.setInterval(refresh,300000);
    return {refresh};
  }
  return {prepare,render,start};
});
