(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else {root.DashboardResidents=api;const boot=()=>api.start(root,root.HomeDashboard);root.document.readyState==='loading'?root.document.addEventListener('DOMContentLoaded',boot):boot();}
})(typeof window==='undefined'?globalThis:window,function(){
  let selectedYear=null;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count=value=>Number.isInteger(value)&&value>=0?value:null;
  function prepare(data,year=selectedYear){
    if(data?.schemaVersion!==1||!/^\d{4}-\d{2}-\d{2}$/.test(data.today)||!Array.isArray(data.branches))throw new Error('format');
    const currentYear=Number(data.today.slice(0,4)),currentMonth=Number(data.today.slice(5,7));
    const branches=[2,3].map(id=>{
      const branch=data.branches.find(b=>b.id===id);
      if(!branch)return {id,name:id===2?'안양점':'인천점',months:null};
      if(branch.months!==null&&!Array.isArray(branch.months))throw new Error('months');
      for(const m of branch.months||[])if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m.month)||count(m.admitted)===null||count(m.discharged)===null)throw new Error('count');
      if(branch.yearStarts!==undefined){
        if(!Array.isArray(branch.yearStarts))throw new Error('yearStarts');
        const years=new Set();
        for(const start of branch.yearStarts){
          if(!Number.isInteger(start.year)||start.date!==`${start.year}-01-01`||(start.occupancy!==null&&count(start.occupancy)===null)||years.has(start.year))throw new Error('occupancy');
          years.add(start.year);
        }
      }
      return branch;
    });
    const oldest=Math.min(currentYear,...branches.flatMap(b=>(b.months||[]).map(m=>Number(m.month.slice(0,4)))));
    const years=Array.from({length:currentYear-oldest+1},(_,i)=>currentYear-i);
    year=years.includes(Number(year))?Number(year):currentYear;
    const months=Array.from({length:year===currentYear?currentMonth:12},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`);
    return {year,years,months,branches,today:data.today};
  }
  function value(branch,month,key){
    if(!branch.months||!branch.asOf||month>branch.asOf.slice(0,7))return null;
    const entry=branch.months.find(m=>m.month===month);
    return entry?count(entry[key]):0;
  }
  function sum(values){return values.some(n=>n===null)?null:values.reduce((a,b)=>a+b,0);}
  function total(branch,months,key){return sum(months.map(m=>value(branch,m,key)));}
  function baseline(branch,year){const start=branch.yearStarts?.find(s=>s.year===year);return start&&!start.error?count(start.occupancy):null;}
  function rate(people,occupancy){return people!==null&&occupancy>0?(people/occupancy*100).toFixed(1)+'%':null;}
  function summary(view){
    const occupancy=sum(view.branches.map(b=>baseline(b,view.year)));
    return {occupancy,...Object.fromEntries(['admitted','discharged'].map(key=>{
      const people=sum(view.branches.map(b=>total(b,view.months,key)));
      return [key,{people,rate:rate(people,occupancy)}];
    }))};
  }
  function totalCell(branch,view,key){
    const people=total(branch,view.months,key),percent=rate(people,baseline(branch,view.year)),label=key==='admitted'?'입소':'퇴소';
    return `<td class="dash-resident-total" aria-label="${esc(branch.name)} ${view.year}년 ${label} 합계 ${people===null?'미조회':people+'명'}, ${label}율 ${percent||'계산 불가'}">${people===null?'—':people+'명'}<small>${percent||'—'}</small></td>`;
  }
  function render(record){
    if(!record?.data)return `<p class="dash-empty">${record?.error?'입·퇴소 현황을 불러오지 못했습니다. 잠시 후 다시 확인해주세요.':'입·퇴소 현황 확인 중'}</p>`;
    let view;try{view=prepare(record.data);}catch(_){return '<p class="dash-empty">입·퇴소 자료 형식을 확인하지 못했습니다.</p>';}
    const warnings=view.branches.filter(b=>b.stale||b.collectionError||!b.months).map(b=>`${b.name}: ${b.months?'이전 조회 결과':'미조회'}${b.collectionError?' · '+b.collectionError:''}`);
    if(record.error)warnings.unshift('갱신 실패 · 아래는 이전 조회 결과입니다.');
    const checked=view.branches.map(b=>b.checkedAt).filter(Boolean).sort()[0];
    const asOf=view.branches.map(b=>b.asOf).filter(Boolean).sort()[0]||view.today;
    const missing=view.branches.filter(b=>b.missingAdmissionDates>0).map(b=>`${b.name} 입소일 미등록 ${b.missingAdmissionDates}명`);
    const all=summary(view);
    return `<div class="dash-resident-toolbar"><div class="dash-resident-summary" aria-label="${view.year}년 전체 입퇴소 합계">${['admitted','discharged'].map((key,i)=>{const label=i===0?'입소':'퇴소',s=all[key];return `<p>전체 ${label} <strong>${s.people===null?'—':s.people+'명'}</strong> <span aria-label="${label}율 ${s.rate||'계산 불가'}">(${s.rate||'—'})</span></p>`;}).join('')}</div><select aria-label="입퇴소 현황 연도" data-resident-year data-dash-key="resident-year">${view.years.map(y=>`<option value="${y}"${y===view.year?' selected':''}>${y}년</option>`).join('')}</select></div>
      ${warnings.length?`<p class="dash-warning" role="status">${warnings.map(esc).join('<br>')}</p>`:''}
      <div class="dash-table-wrap dash-resident-scroll" data-dash-scroll="residents" tabindex="0" role="region" aria-label="월별 입소·퇴소 인원 표, 가로 스크롤 가능"><table class="dash-resident-table"><caption class="dash-sr-only">${view.year}년 안양점·인천점 월별 입소·퇴소 인원, 단위 명</caption><thead><tr><th scope="col">지점</th><th scope="col">구분</th>${view.months.map(m=>`<th scope="col"${m===view.today.slice(0,7)?' class="is-current"':''}>${Number(m.slice(5))}월</th>`).join('')}<th scope="col" class="dash-resident-total">합계<small>입·퇴소율</small></th></tr></thead>${view.branches.map(b=>`<tbody>${['admitted','discharged'].map((key,i)=>`<tr${i===0?' class="dash-resident-branch"':''}>${i===0?`<th scope="rowgroup" rowspan="2">${esc(b.name)}</th>`:''}<th scope="row">${i===0?'입소':'퇴소'}</th>${view.months.map(m=>{const n=value(b,m,key);return `<td${m===view.today.slice(0,7)?' class="is-current"':''}><span${n===null?' class="dash-resident-unknown"':''} aria-label="${esc(b.name)} ${Number(m.slice(5))}월 ${i===0?'입소':'퇴소'} ${n===null?'미조회':n+'명'}">${n===null?'—':n}</span></td>`;}).join('')}${totalCell(b,view,key)}</tr>`).join('')}</tbody>`).join('')}</table></div>
      <p class="dash-meta dash-resident-footer">${view.year}년 누적 · 비율은 1월 1일 현원 대비${all.occupancy===null?' · 기준 현원 미조회':all.occupancy===0?' · 기준 현원 0명':` (전체 ${all.occupancy}명)`}<br>입소는 최근 입소일 기준${view.year===Number(asOf.slice(0,4))?` · ${Number(asOf.slice(5,7))}월은 ${Number(asOf.slice(8))}일까지`:''}${checked?' · 확인 '+esc(new Date(checked).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})):''}${missing.length?'<br>'+missing.map(esc).join(' · '):''}</p>`;
  }
  function start(win,dashboard){
    if(!dashboard)return;
    let loading=false;
    win.document.addEventListener('change',event=>{if(event.target.matches('[data-resident-year]')){selectedYear=Number(event.target.value);dashboard.redraw();}});
    async function refresh(){
      if(loading||win.document.hidden)return;
      loading=true;
      try{const response=await win.fetch('/api/resident-movement',{cache:'no-store',signal:win.AbortSignal.timeout(15000)});if(!response.ok)throw new Error('request');const data=await response.json();prepare(data);dashboard.update('residents',data);}
      catch(_){dashboard.fail('residents');}finally{loading=false;}
    }
    refresh();win.addEventListener('pageshow',refresh);win.document.addEventListener('visibilitychange',()=>{if(!win.document.hidden)refresh();});win.setInterval(refresh,60000);
    return {refresh};
  }
  return {prepare,value,total,baseline,rate,summary,render,start};
});
