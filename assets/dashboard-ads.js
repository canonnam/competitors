/* Read-only, campaign-level trend. Missing observations stay unknown, not zero. */
(function(root,factory) {
  const api=factory();root.DashboardAds=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root.document?.body.classList.contains('kb-homepage'))api.start(root,root.HomeDashboard);
})(typeof window==='undefined'?globalThis:window,function() {
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count=value=>Number.isFinite(value)?value.toLocaleString('ko-KR'):'—';
  const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  const shift=(date,offset)=>new Date(Date.parse(date+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
  const short=date=>`${Number(date.slice(5,7))}/${Number(date.slice(8))}`;
  function prepare(data) {
    if(!Array.isArray(data.daily))throw new Error('format');
    if(!data.through)return {rows:[],known:0,total:{impressions:null,clicks:null}};
    if(!day(data.through))throw new Error('date');
    const start=shift(data.through,-13),groups=new Map();
    for(const row of data.daily) {
      if(row.level!=='campaign')continue;
      if(!day(row.date))throw new Error('date');
      if(row.date<start||row.date>data.through)continue;
      if(!['impressions','clicks'].every(key=>Number.isSafeInteger(row[key])&&row[key]>=0))throw new Error('metric');
      const previous=groups.get(row.date)||{impressions:0,clicks:0};
      groups.set(row.date,{impressions:previous.impressions+row.impressions,clicks:previous.clicks+row.clicks});
    }
    const rows=Array.from({length:14},(_,i)=>{const date=shift(start,i);return {date,...(groups.get(date)||{impressions:null,clicks:null})};});
    const known=groups.size,total={impressions:known?0:null,clicks:known?0:null};
    for(const row of groups.values())for(const key of Object.keys(total))total[key]+=row[key];
    return {start,end:data.through,rows,known,total};
  }
  function pathFor(rows,key,max) {
    let connected=false;
    return rows.map((row,i)=>{
      if(row[key]===null){connected=false;return '';}
      const point=`${(8+i*504/(rows.length-1)).toFixed(2)},${(132-row[key]/max*124).toFixed(2)}`;
      const segment=(connected?'L':'M')+point;connected=true;return segment;
    }).join(' ');
  }
  function figure(view,key,label) {
    const peak=Math.max(0,...view.rows.map(row=>row[key]??0)),max=Math.max(2,Math.ceil(peak/2)*2);
    const points=view.rows.map((row,i)=>row[key]===null?'':`<circle cx="${(8+i*504/13).toFixed(2)}" cy="${(132-row[key]/max*124).toFixed(2)}" r="3"><title>${esc(row.date)} · ${label} ${count(row[key])}회</title></circle>`).join('');
    return `<figure class="dash-ad-chart dash-ad-${key}"><figcaption id="dash-ad-${key}-title">${label}<strong>${count(view.total[key])}<span>회</span></strong><small>${view.known===14?'14일 합계':`확인된 ${view.known}일 합계`}</small></figcaption><div class="dash-ad-plot"><div class="dash-ad-y" aria-hidden="true"><span>${count(max)}</span><span>${count(max/2)}</span><span>0</span></div><div class="dash-ad-lines"><svg viewBox="0 0 520 140" preserveAspectRatio="none" role="img" aria-labelledby="dash-ad-${key}-title dash-ad-${key}-desc"><desc id="dash-ad-${key}-desc">${esc(view.start)}부터 ${esc(view.end)}까지 일별 ${label}. 누락된 날짜는 선이 끊기며 정확한 값은 아래 일별 수치 표에서 확인할 수 있습니다.</desc><g class="dash-ad-grid"><path d="M8,8H512 M8,70H512 M8,132H512"/></g><path class="dash-ad-line" d="${pathFor(view.rows,key,max)}"/>${points}</svg><div class="dash-ad-x" aria-hidden="true"><span>${short(view.start)}</span><span>${short(view.rows[6].date)}</span><span>${short(view.end)}</span></div></div></div></figure>`;
  }
  function render(record,expanded=false) {
    if(!record?.data)return `<p class="dash-empty">${record?.error?'광고 추이를 불러오지 못했습니다. 광고 상세에서 다시 확인해주세요.':'노출수·클릭수 추이를 불러오는 중입니다.'}</p>`;
    const data=record.data,view=prepare(data);
    const warning=record.error?'연결 확인 필요 · 이전에 불러온 결과입니다.':data.sync?.stale||data.sync?.error?'갱신 지연 · 저장된 결과 기준입니다.':data.sync?.enabled===false?'자동 갱신 연결 대기 · 저장된 결과 기준입니다.':'';
    const updated=data.updated_at&&Number.isFinite(Date.parse(data.updated_at))?new Date(data.updated_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'확인 기록 없음';
    const meta=`<p class="dash-meta">${esc(data.branch||'연결된 광고 계정')}${view.start?` · ${esc(view.start)} ~ ${esc(view.end)}`:''}</p>${warning?`<p class="dash-warning">${warning}</p>`:''}`;
    if(!view.known)return meta+'<p class="dash-empty">아직 수집된 노출·클릭 지표가 없습니다.</p>';
    return `${meta}<div class="dash-ad-charts">${figure(view,'impressions','노출수')}${figure(view,'clicks','클릭수')}</div>${view.known<14?`<p class="dash-warning">14일 중 ${view.known}일 확인 · 누락된 날짜는 0으로 집계하지 않습니다.</p>`:''}${view.total.impressions===0&&view.total.clicks===0?'<p class="dash-meta">확인된 기간에 기록된 노출·클릭이 없습니다.</p>':''}<div class="dash-ad-footer"><p class="dash-meta">캠페인 합계 · 그래프별 별도 축 · 수집 ${esc(updated)}</p><details${expanded?' open':''}><summary data-dash-key="ads-values">일별 수치 보기</summary><div class="dash-table-wrap"><table class="dash-branch-table"><caption class="dash-sr-only">네이버 광고 일별 노출수와 클릭수</caption><thead><tr><th scope="col">날짜</th><th scope="col">노출수</th><th scope="col">클릭수</th></tr></thead><tbody>${view.rows.map(row=>`<tr><th scope="row">${esc(row.date)}</th><td>${count(row.impressions)}</td><td>${count(row.clicks)}</td></tr>`).join('')}</tbody></table></div></details></div>`;
  }
  function start(win,dashboard) {
    if(!dashboard)return;
    let loading=false;
    async function refresh() {
      if(loading||win.document.hidden)return;
      loading=true;
      try {
        const response=await win.fetch('/api/naver-ads?summary=1',{cache:'no-store',signal:win.AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('request');
        const data=await response.json();prepare(data);dashboard.update('ads',data);
      } catch (_) {dashboard.fail('ads');}
      finally {loading=false;}
    }
    refresh();
    win.addEventListener('pageshow',refresh);
    win.document.addEventListener('visibilitychange',()=>{if(!win.document.hidden)refresh();});
    win.setInterval(refresh,300000);
    return {refresh};
  }
  return {prepare,pathFor,render,start};
});
