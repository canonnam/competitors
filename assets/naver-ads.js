/* Shared arithmetic is also exercised by the Node regression tests. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const keys = ['impressions', 'clicks', 'cost'];
  const sum = rows => {
    const total = {impressions: 0, clicks: 0, cost: 0};
    rows.forEach(row => keys.forEach(key => total[key] += Number(row[key] || 0)));
    total.ctr = total.impressions ? total.clicks / total.impressions * 100 : null;
    total.cpc = total.clicks ? total.cost / total.clicks : null;
    total.per10000 = total.cost ? total.clicks / total.cost * 10000 : null;
    return total;
  };
  const shift = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  const dayCount = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
  const change = (current, previous) => current == null || previous == null || previous === 0 ? null : (current / previous - 1) * 100;
  function group(rows, field) {
    const groups = new Map();
    rows.forEach(row => { const key = typeof field === 'function' ? field(row) : row[field]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); });
    return [...groups].map(([key, items]) => ({key, title: items[0].title, channel: items[0].channel, ...sum(items)}));
  }
  function wilson(clicks, impressions) {
    if (!impressions) return null;
    const z = 1.95996398454, p = clicks / impressions, denominator = 1 + z * z / impressions;
    const center = (p + z * z / (2 * impressions)) / denominator;
    const radius = z * Math.sqrt(p * (1 - p) / impressions + z * z / (4 * impressions * impressions)) / denominator;
    return [Math.max(0, center - radius) * 100, Math.min(1, center + radius) * 100];
  }
  function selection(data, start, end) {
    const campaigns = data.daily.filter(row => row.level === 'campaign');
    const rows = campaigns.filter(row => row.date >= start && row.date <= end);
    const length = dayCount(start, end), prevEnd = shift(start, -1), prevStart = shift(start, -length);
    const previous = campaigns.filter(row => row.date >= prevStart && row.date <= prevEnd);
    return {start, end, length, prevStart, prevEnd, comparable: prevStart >= data.since,
      rows, total: sum(rows), previous: sum(previous),
      daily: group(rows, 'date').sort((a,b) => a.key.localeCompare(b.key)),
      monthly: group(rows, row => row.date.slice(0, 7)).sort((a,b) => a.key.localeCompare(b.key)),
      channels: group(rows, 'channel').sort((a,b) => b.cost-a.cost),
      creatives: group(data.daily.filter(row => row.level === 'creative' && row.date >= start && row.date <= end), 'entity')};
  }
  const arithmetic = {sum, shift, dayCount, change, group, wilson, selection};
  if (typeof module !== 'undefined' && module.exports) module.exports = arithmetic;
  root.AdMetrics = arithmetic;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = (value, digits = 0) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('ko-KR', {maximumFractionDigits: digits, minimumFractionDigits: digits});
  const won = value => value == null ? '—' : number(value) + '원';
  const percent = value => value == null ? '—' : number(value, 2) + '%';
  const delta = value => value == null ? '비교 불가' : (value > 0 ? '+' : '') + number(value, 1) + '%';
  const palette = ['#1f63dc', '#078568', '#bb782a', '#808d9b'];
  const color = channel => ({'파워링크': palette[0], '플레이스': palette[1], '파워컨텐츠': palette[2]}[channel] || palette[3]);
  let reportData, selected, activeTab = 'overview';
  const charts = new Map();

  function chart(id, rows, field, options = {}) {
    if (typeof Chart === 'undefined') return;
    if (charts.has(id)) charts.get(id).destroy();
    const dataset = {label: options.label || field, data: rows.map(row => row[field]), borderWidth: 2,
      borderColor: options.colors || palette[0], backgroundColor: options.colors || palette[0],
      pointRadius: rows.length > 60 ? 0 : 2, tension: 0.15, spanGaps: false, maxBarThickness: 36};
    charts.set(id, new Chart($(id), {type: options.type || 'bar',
      data: {labels: rows.map(row => options.labels ? options.labels(row) : row.key), datasets: options.datasets || [dataset]},
      options: {responsive: true, maintainAspectRatio: false, animation: false, indexAxis: options.horizontal ? 'y' : 'x',
        plugins: {legend: {display: !!options.datasets, position: 'bottom'},
          tooltip: {callbacks: {label: item => item.dataset.label + ': ' + number(options.horizontal ? item.parsed.x : item.parsed.y, ['ctr','cpc'].includes(field) ? 2 : 0)}}},
        scales: {x: {grid: {display: !!options.horizontal}, ticks: {maxRotation: 0, autoSkip: true, maxTicksLimit: options.horizontal ? 5 : 7, font: {size: 11}}, ...(options.horizontal ? {beginAtZero:true} : {})},
          y: {beginAtZero: true, grid: {color: '#edf1f5'}, ticks: {font: {size: 11}, ...(options.horizontal ? {} : {callback: value => Intl.NumberFormat('ko', {notation:'compact',maximumFractionDigits:1}).format(value)})}}}}}));
  }

  function table(rows, titleLabel, label, extras = false) {
    return `<table><thead><tr><th scope="col">${esc(titleLabel)}</th><th scope="col">노출 수</th><th scope="col">클릭 수</th><th scope="col">광고비</th><th scope="col">CTR</th><th scope="col">CPC</th>${extras ? '<th scope="col">CTR 95% 구간</th>' : '<th scope="col">1만원당 클릭</th>'}</tr></thead><tbody>` +
      (rows.length ? rows.map(row => {const interval = wilson(row.clicks, row.impressions); return `<tr><td class="title-cell">${label(row)}</td><td>${number(row.impressions)}</td><td>${number(row.clicks)}</td><td>${won(row.cost)}</td><td>${percent(row.ctr)}</td><td>${won(row.cpc)}</td><td>${extras ? (interval ? `${percent(interval[0])} ~ ${percent(interval[1])}` : '—') : number(row.per10000, 1)}</td></tr>`;}).join('') : '<tr><td colspan="7" class="empty">해당 기간에 수집된 데이터가 없습니다.</td></tr>') + '</tbody></table>';
  }

  function renderKpis() {
    const s = selected;
    $('kpis').innerHTML = [['광고비','cost',won],['클릭 수','clicks',v=>number(v)+'회'],['노출 수','impressions',v=>number(v)+'회'],['클릭률 (CTR)','ctr',percent],['클릭당 비용 (CPC)','cpc',won]].map(([title,key,format]) => {
      const difference = s.comparable ? change(s.total[key],s.previous[key]) : null;
      return `<div class="kpi"><div class="label">${title}</div><div class="value">${format(s.total[key])}</div><div class="delta">${delta(difference)} <span>직전 동기간 대비</span></div></div>`;
    }).join('');
    $('comparison-label').textContent = s.comparable ? `비교 기간 ${s.prevStart} ~ ${s.prevEnd} (${s.length}일). 노출 중단과 예산 변경 등 운영 조건의 차이가 포함됩니다.` : '이전 동기간 데이터가 없어 증감률을 표시하지 않습니다.';
    $('range-label').textContent = `${s.start} ~ ${s.end} · ${s.length}일`;
  }

  function renderOverview() {
    const s = selected, t = s.total, p = s.previous;
    const power = s.channels.find(row => row.key === '파워링크'), place = s.channels.find(row => row.key === '플레이스');
    const top = [...s.creatives].filter(row=>row.clicks).sort((a,b)=>b.clicks-a.clicks)[0];
    const active = s.daily.filter(row=>row.impressions || row.clicks || row.cost).length;
    const creativeTotals = sum(s.creatives), zeroClickCost = sum(s.creatives.filter(row=>!row.clicks)).cost;
    const costChange = s.comparable ? change(t.cost,p.cost) : null;
    $('executive').textContent = t.clicks ? `${s.length}일 동안 ${won(t.cost)}을 사용해 ${number(t.clicks)}회의 클릭을 얻었습니다. 클릭당 비용은 ${won(t.cpc)}이며, 직전 동기간 대비 광고비는 ${delta(costChange)}입니다. 예산 판단은 클릭 단가와 상담 유입을 함께 확인해야 합니다.` : `${s.length}일 동안 기록된 클릭이 없습니다. 노출 ${number(t.impressions)}회, 광고비 ${won(t.cost)}입니다. 잔액과 광고 운영 상태를 확인할 필요가 있습니다.`;
    const insights = [
      ['광고비 변화', s.comparable ? `직전 ${won(p.cost)} → 현재 ${won(t.cost)} (${delta(costChange)}). 기간 길이는 동일하지만 운영일 수는 달라질 수 있습니다.` : '직전 동기간 자료가 부족해 광고비 증감 판단을 보류합니다.'],
      ['클릭 유입 변화', `현재 ${number(t.clicks)}회. ${s.comparable ? `직전 동기간 대비 ${delta(change(t.clicks,p.clicks))}.` : '비교 기간 미확보.'} 클릭 증가는 상담 증가와 같은 의미가 아닙니다.`],
      ['단가와 지출', `클릭당 ${won(t.cpc)}. ${s.comparable ? `직전 동기간 대비 ${delta(change(t.cpc,p.cpc))}.` : ''} 총지출은 클릭 수와 클릭 단가의 곱이므로 두 요인을 함께 확인하세요.`],
      ['광고가 노출된 일수', `${s.length}일 중 실적 발생일 ${active}일. 실적 발생일당 비용 ${won(active ? t.cost/active : null)}, 클릭 ${number(active ? t.clicks/active : null,1)}회입니다.`],
      ['플레이스 클릭 단가', power?.cpc != null && place?.cpc != null && power.cpc > 0 ? `플레이스 ${won(place.cpc)}, 파워링크 ${won(power.cpc)}. 플레이스 단가가 ${number(Math.abs((place.cpc/power.cpc-1)*100),1)}% ${place.cpc <= power.cpc ? '낮습니다' : '높습니다'}. 상담의 질은 별도 검증이 필요합니다.` : '두 유형 모두 클릭 실적이 있어야 클릭 단가를 비교할 수 있습니다.'],
      ['플레이스 비용·클릭 비중', place && t.cost && t.clicks ? `비용 비중 ${percent(place.cost/t.cost*100)}, 클릭 비중 ${percent(place.clicks/t.clicks*100)}. 클릭 비중이 비용 비중보다 높으면 평균보다 낮은 단가로 클릭을 얻은 것입니다.` : '비용·클릭 실적이 부족해 비중 비교를 생략합니다.'],
      ['반응률', `전체 CTR ${percent(t.ctr)}. ${power && place ? `파워링크 ${percent(power.ctr)}, 플레이스 ${percent(place.ctr)}.` : ''} 노출 지면과 의도가 달라 CTR만으로 예산을 이동하지 않습니다.`],
      ['클릭을 모은 소재', top ? `${top.title} · ${number(top.clicks)}클릭, CPC ${won(top.cpc)}. 노출량 차이가 있으므로 다음 소재 실험의 후보로 활용하세요.` : '클릭 실적이 있는 소재가 아직 없습니다.'],
      ['소재 데이터의 설명 범위', `전체 클릭 중 소재로 분해된 비중 ${percent(t.clicks ? creativeTotals.clicks/t.clicks*100 : null)}. 클릭 0회 소재의 기록된 비용은 ${won(zeroClickCost)}이며 누락·반올림 가능성을 함께 확인해야 합니다.`],
      ['다음 예산 결정', '상담 시 유입 경로를 기록하고 방문 상담·입소까지 연결하세요. 같은 기간의 광고 유형별 상담 획득비용이 쌓이면 예산 증액 여부를 더 정확하게 판단할 수 있습니다.']
    ];
    $('insights').innerHTML = insights.map(([title,body])=>`<li><div><strong>${esc(title)}</strong><p>${esc(body)}</p></div></li>`).join('');
    chart('daily-cost', s.daily,'cost',{type:'line',label:'광고비 (원)'});
    chart('daily-clicks',s.daily,'clicks',{type:'line',label:'클릭 수',colors:palette[1]});
  }

  function renderTrends() {
    const s = selected;
    chart('daily-ctr',s.daily,'ctr',{type:'line',label:'CTR (%)',colors:palette[1]});
    chart('daily-cpc',s.daily,'cpc',{type:'line',label:'CPC (원)',colors:palette[2]});
    chart('monthly-cost',s.monthly,'cost',{label:'광고비 (원)'});
    chart('monthly-clicks',s.monthly,'clicks',{label:'클릭 수',colors:palette[1]});
    chart('monthly-impressions',s.monthly,'impressions',{label:'노출 수',colors:'#75849b'});
    $('monthly-table').innerHTML = table(s.monthly,'월',row=>{
      const last = shift(row.key + '-01',32).slice(0,7) + '-01';
      const partial = s.start > row.key+'-01' || s.end < shift(last,-1);
      return esc(row.key) + (partial ? '<span>부분 집계</span>' : '');
    });
    $('daily-table').innerHTML = table(s.daily,'날짜',row=>esc(row.key));
  }

  function renderChannels() {
    const rows = selected.channels, total = selected.total, colors = rows.map(row=>color(row.key));
    chart('channel-cost',rows,'cost',{label:'광고비 (원)',colors});
    chart('channel-ctr',rows,'ctr',{label:'CTR (%)',colors});
    chart('channel-cpc',rows,'cpc',{label:'CPC (원)',colors});
    chart('channel-share',rows,'share',{datasets:[
      {label:'광고비 비중 (%)',data:rows.map(row=>total.cost ? row.cost/total.cost*100 : null),backgroundColor:palette[0],maxBarThickness:36},
      {label:'클릭 비중 (%)',data:rows.map(row=>total.clicks ? row.clicks/total.clicks*100 : null),backgroundColor:palette[1],maxBarThickness:36}]});
    $('channel-table').innerHTML = table(rows,'광고 유형',row=>esc(row.key));
  }

  function renderCreatives() {
    const key = $('creative-sort').value;
    const rows = [...selected.creatives].filter(row=>row.impressions||row.clicks||row.cost).sort((a,b)=> key==='cpc' ? (a.cpc ?? Infinity)-(b.cpc ?? Infinity) : (b[key]??-1)-(a[key]??-1));
    const top = rows.slice(0,8).map((row,index)=>({...row,key:`소재 ${index+1}`}));
    const total = sum(rows), t = selected.total;
    $('coverage').textContent = `선택 기간 실적 소재 ${rows.length}개 · 캠페인 클릭 대비 소재 클릭 ${percent(t.clicks ? total.clicks/t.clicks*100 : null)} · 광고비 기준 ${percent(t.cost ? total.cost/t.cost*100 : null)}. 현재 이름 기준이며 수정 전 문구의 성과가 포함될 수 있습니다.`;
    chart('creative-clicks',top,'clicks',{horizontal:true,label:'클릭 수',colors:top.map(row=>color(row.channel))});
    chart('creative-cpc',top,'cpc',{horizontal:true,label:'CPC (원)',colors:top.map(row=>color(row.channel))});
    $('creative-table').innerHTML = table(rows,'소재',row=>`<strong>소재 ${rows.indexOf(row)+1}</strong> · ${esc(row.title)}<span>${esc(row.channel)} · ${row.clicks < 30 ? '클릭 30회 미만: 추가 관찰' : '상담 전환 검증 필요'}</span>`,true);
  }

  function renderHistory() {
    const h = reportData.history;
    if (!h.full_period || !h.change) { $('history-content').textContent='이전 분석 기록이 없습니다.'; return; }
    const full=h.full_period, c=h.change, before=sum([c.before]), after=sum([c.after]);
    const beforePlace=sum(c.channels.baseline_8d.filter(row=>row.channel==='플레이스'));
    const afterPlace=sum(c.channels.after.filter(row=>row.channel==='플레이스'));
    $('history-content').innerHTML = `<article class="history-entry"><h3>2026.08.23 · 전체 광고 기간 분석</h3><p class="muted">${esc(full.start)} ~ ${esc(full.end)} 당시 조회 가능한 캠페인 합계입니다. 현재 재수집 결과는 일별 합산·정정·삭제 상태 변화로 차이가 있을 수 있습니다.</p><div class="history-metrics"><div>누적 광고비<strong>${won(full.total.cost)}</strong></div><div>누적 클릭<strong>${number(full.total.clicks)}회</strong></div><div>누적 노출<strong>${number(full.total.impressions)}회</strong></div></div><p class="small muted">당시 소재 분해 커버리지: 클릭 ${percent(full.creative_coverage.clicks)}, 광고비 ${percent(full.creative_coverage.cost)}. 전체 소재의 성과로 해석할 수 없습니다.</p><details><summary>당시 소재별 기록</summary><div class="table-scroll">${table(full.creatives.map(row=>({...row,...sum([row])})),'소재',row=>esc(row.title),true)}</div></details></article>
      <article class="history-entry"><h3>2026.09.01 · 운영 변경 후 비교</h3><ul>${c.reported.map(note=>`<li>${esc(note)}</li>`).join('')}</ul><p>변경 전 ${c.before.start} ~ ${c.before.end}, 변경 후 ${c.after.start} ~ ${c.after.end}의 각각 5개 운영일을 비교했습니다. 변경의 정확한 적용 시각은 확인되지 않았으며 단기 관찰입니다.</p><div class="table-scroll">${table([{key:'변경 전 · 5일',...before},{key:'변경 후 · 5일',...after}],'기간',row=>esc(row.key))}</div><p>광고비 ${delta(change(after.cost,before.cost))}, 클릭 ${delta(change(after.clicks,before.clicks))}, CPC ${delta(change(after.cpc,before.cpc))}. 플레이스 CPC는 ${won(beforePlace.cpc)}에서 ${won(afterPlace.cpc)}으로 ${delta(change(afterPlace.cpc,beforePlace.cpc))} 변했습니다. 일 예산 증액이 추가 상담이나 입소로 이어졌는지는 확인되지 않았습니다.</p><p class="muted small">요일 제외와 예산 증액이 함께 일어나 각 변경의 인과효과를 분리할 수 없습니다.</p></article>`;
  }

  function renderTab() {
    if (!selected) return;
    ({overview:renderOverview,trends:renderTrends,channels:renderChannels,creatives:renderCreatives,history:renderHistory})[activeTab]();
  }

  function applyRange() {
    const start=$('start').value,end=$('end').value;
    if (!start || !end || start>end || start<reportData.since || end>reportData.through) {
      $('validation').textContent=`${reportData.since} ~ ${reportData.through} 안에서 시작일과 종료일을 선택해주세요.`; return;
    }
    $('validation').textContent='';
    selected=selection(reportData,start,end);renderKpis();renderTab();
  }

  function preset() {
    const through=reportData.through, mode=$('period').value, month=(reportData.today || through).slice(0,7)+'-01';
    let start, end=through;
    if(mode==='custom')return;
    if(mode==='all')start=reportData.since;
    else if(mode==='month')start=month;
    else if(mode==='lastmonth'){end=shift(month,-1);start=end.slice(0,7)+'-01';end=end>through ? through : end;}
    else start=shift(through,1-Number(mode));
    if(start>end){$('validation').textContent='선택한 달은 아직 수집된 날짜가 없습니다. 화면에는 이전 조회 결과를 유지합니다.';return;}
    $('start').value=start<reportData.since ? reportData.since : start;
    $('end').value=end;applyRange();
  }

  async function load() {
    $('reload').disabled=true;$('notice').hidden=true;
    try {
      const response=await fetch('/api/naver-ads',{cache:'no-store',signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('request');
      const data=await response.json();
      if(!Array.isArray(data.daily))throw new Error('format');
      reportData=data;
      if(!data.through || !data.daily.length){$('dashboard').hidden=true;$('freshness').textContent='초기 수집 대기';$('updated').textContent='아직 수집된 지표가 없습니다.';$('notice').textContent='광고 계정 연결과 초기 데이터 수집이 필요합니다.';$('notice').hidden=false;return;}
      $('dashboard').hidden=false;$('download').disabled=false;
      $('freshness').textContent=data.sync.stale ? '갱신 지연' : '수집 완료';
      $('freshness').classList.toggle('warning',data.sync.stale);
      const updated=data.updated_at ? new Date(data.updated_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}) : '확인 필요';
      $('updated').textContent=`${data.through}까지 반영 · 수집 ${updated} · ${data.sync.enabled ? data.sync.schedule+' 자동 갱신' : '자동 갱신 연결 대기'}`;
      if(data.sync.error || data.sync.stale || !data.sync.enabled){$('notice').textContent=data.sync.error || (data.sync.stale ? `최신 수집 기준일은 ${data.through}입니다. ${data.sync.target_date}까지의 갱신이 필요합니다.` : '현재 저장된 보고서입니다. 서버의 네이버 광고 계정 연결 후 매일 자동 갱신됩니다.');$('notice').hidden=false;}
      if(typeof Chart==='undefined'){$('notice').textContent='그래프를 불러오지 못했습니다. 표의 지표는 계속 확인할 수 있습니다.';$('notice').hidden=false;}
      ['start','end'].forEach(id=>{$(id).min=data.since;$(id).max=data.through;});
      $('notes').innerHTML=data.notes.map(note=>`<li>${esc(note)}</li>`).join('');
      if($('period').value==='custom' && selected)applyRange();else preset();
    } catch { $('freshness').textContent='불러오기 실패';$('freshness').classList.add('warning');$('notice').textContent=reportData ? '갱신 요청에 실패했습니다. 화면의 이전 보고서를 유지합니다.' : '보고서를 불러오지 못했습니다. 잠시 후 새로고침해주세요.';$('notice').hidden=false; }
    finally{$('reload').disabled=false;}
  }

  function activateTab(button) {
    activeTab=button.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(tab=>{const active=tab===button;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$(tab.dataset.tab).hidden=!active;});
    renderTab();
  }
  document.querySelectorAll('[data-tab]').forEach(button=>{
    button.addEventListener('click',()=>activateTab(button));
    button.addEventListener('keydown',event=>{const tabs=[...document.querySelectorAll('[data-tab]')],index=tabs.indexOf(button);let target;
      if(event.key==='ArrowRight')target=tabs[(index+1)%tabs.length];
      if(event.key==='ArrowLeft')target=tabs[(index-1+tabs.length)%tabs.length];
      if(event.key==='Home')target=tabs[0];if(event.key==='End')target=tabs.at(-1);
      if(target){event.preventDefault();target.focus();activateTab(target);}});
  });
  $('filters').addEventListener('submit',event=>{event.preventDefault();applyRange();});
  $('period').addEventListener('change',preset);
  ['start','end'].forEach(id=>$(id).addEventListener('change',()=>{$('period').value='custom';}));
  $('creative-sort').addEventListener('change',renderCreatives);
  $('reload').addEventListener('click',load);
  $('download').addEventListener('click',()=>{
    if(!selected)return;
    const csvCell=value=>{const text=String(value??'');return '"'+(/^[=+@\-]/.test(text)?"'":'')+text.replace(/"/g,'""')+'"';};
    const header=['날짜','광고 유형','노출 수','클릭 수','광고비(원, VAT 포함)','CTR(%)','CPC(원)'];
    const rows=selected.rows.map(row=>{const m=sum([row]);return [row.date,row.channel,m.impressions,m.clicks,m.cost,m.ctr,m.cpc];});
    const content='\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=`더비다_인천_광고_${selected.start}_${selected.end}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  load();
})(globalThis);
