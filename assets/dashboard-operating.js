(function(root,factory){
  const common=typeof module==='object'&&module.exports;
  const api=factory();
  if(common)module.exports=api;
  else {root.DashboardOperating=api;if(root.document?.body.classList.contains('kb-homepage'))api.start(root,root.HomeDashboard);}
})(typeof window==='undefined'?globalThis:window,function(){
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
    const available=[...new Set(branches.flatMap(branch=>branch.months.map(m=>m.month)))].sort();
    const month=available.at(-1),year=month?.slice(0,4);
    const first=available.find(m=>m.startsWith(year));
    // 최신 자료가 있는 연도를 표시하며, 중간에 빠진 달도 축에서 생략하지 않는다.
    const months=month?Array.from({length:Number(month.slice(5))-Number(first.slice(5))+1},(_,i)=>year+'-'+String(Number(first.slice(5))+i).padStart(2,'0')):[];
    const rows=months.map(month=>({month,profits:branches.map(branch=>branch.months.find(m=>m.month===month)?.profit??null)}));
    return {month,year,branches,rows};
  }
  const num=(value,digits=1)=>value.toLocaleString('ko-KR',{minimumFractionDigits:digits,maximumFractionDigits:digits});
  const monthName=month=>`${month.slice(0,4)}년 ${Number(month.slice(5))}월`;
  const detailLink=month=>'/operating-costs.html?year='+month.slice(0,4)+'&month='+month;
  function profitScale(values) {
    const low=Math.min(0,...values),high=Math.max(0,...values);
    const raw=(high-low||1)/7,unit=10**Math.floor(Math.log10(raw));
    const step=[1,2,2.5,5,10].find(n=>n*unit>=raw)*unit;
    const min=Math.floor(low/step)*step,max=high===low?1:Math.ceil(high/step)*step;
    const ticks=Array.from({length:Math.round((max-min)/step)+1},(_,i)=>Number((max-i*step).toPrecision(12)));
    return {min,max,ticks,zero:100*max/(max-min)};
  }
  function barGeometry(value,scale) {
    const position=100*(scale.max-value)/(scale.max-scale.min);
    return {top:Math.min(position,scale.zero),height:Math.abs(position-scale.zero)};
  }
  function plot(view) {
    const scale=profitScale(view.rows.flatMap(row=>row.profits.filter(p=>p!==null).map(p=>p/10000)));
    const grid=scale.ticks.map(value=>`<div class="dash-profit-gridline${value===0?' is-zero':''}" style="top:${100*(scale.max-value)/(scale.max-scale.min)}%"><span>${esc(value.toLocaleString('ko-KR',{maximumFractionDigits:6}))}</span></div>`).join('');
    const groups=view.rows.map(row=>`<div class="dash-profit-month"><div class="dash-profit-pair">${row.profits.map((profit,i)=>{
      const name=view.branches[i].name,label=monthName(row.month)+' '+name;
      if(profit===null)return `<span class="dash-profit-missing" style="--branch:${i};top:${scale.zero}%" aria-label="${esc(label)} 자료 없음" title="${esc(label)} 자료 없음">—</span>`;
      const value=profit/10000,{top,height}=barGeometry(value,scale);
      const description=label+' 운영 손익 '+num(value)+'만원 · 상세 분석';
      const origin=profit>0?`bottom:${100-scale.zero}%`:`top:${top}%`;
      return `<a class="dash-profit-bar ${view.branches[i].id}${row.month===view.month?' is-latest':''}" href="${detailLink(row.month)}" data-dash-key="operating-${row.month}-${view.branches[i].id}" data-profit="${profit}" style="--branch:${i};${origin};height:${height}%" aria-label="${esc(description)}" title="${esc(description)}"><span class="dash-sr-only">${esc(description)}</span></a>`;
    }).join('')}</div><span class="dash-profit-month-label">${row.month.slice(2,4)}.${row.month.slice(5)}</span></div>`).join('');
    return `<div class="dash-operating-scroll" data-dash-scroll="operating-chart" role="group" aria-label="${view.year}년 안양점·인천점 월별 운영손익 막대그래프"><div class="dash-profit-chart" style="min-width:${Math.max(340,view.rows.length*76+60)}px"><div class="dash-profit-plot"><div class="dash-profit-grid" aria-hidden="true">${grid}</div><div class="dash-profit-months">${groups}</div></div></div></div>`;
  }
  function render(record) {
    if(!record?.data)return `<p class="dash-empty">${record?.error?'운영비 자료를 불러오지 못했습니다. 상세 보기에서 다시 확인해주세요.':'운영비 자료를 불러오는 중입니다.'}</p>`;
    const data=record.data,view=prepare(data),{month,branches,rows}=view;
    if(!month)return '<p class="dash-empty">아직 등록된 운영비 자료가 없습니다.</p>';
    return `<div class="dash-operating-meta"><p class="dash-meta">운영 손익 · 단위: 만원</p><div class="dash-profit-legend">${branches.map(b=>`<span><i class="${b.id}" aria-hidden="true"></i>${esc(b.name)}</span>`).join('')}</div><p class="dash-meta">막대를 누르면 해당 월 분석으로 이동합니다.</p></div>${record.error?'<p class="dash-warning">연결 확인 필요 · 이전에 불러온 자료입니다.</p>':''}${plot(view)}<p class="dash-profit-mobile-hint dash-meta">좌우로 밀어 전체 월을 확인하세요.</p>${rows.some(row=>row.profits.includes(null))?'<p class="dash-warning">자료가 없는 지점·월은 —로 표시하며 0원으로 간주하지 않습니다.</p>':''}`;
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
  return {prepare,profitScale,barGeometry,render,start};
});
