(() => {
  'use strict';
  const M=window.OperatingModel, $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=(v,d=1)=>v==null?'—':v.toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d});
  const money=v=>v==null?'자료 없음':num(v/10000)+'만원';
  const signed=v=>(v>0?'+':'')+money(v);
  const exact=v=>num(v,0)+'원';
  const tone=v=>v<0?'negative':v>0?'positive':'';
  const monthName=v=>`${v.slice(0,4)}년 ${Number(v.slice(5))}월`;
  const pct=(v,base)=>base>0?num(v/base*100)+'%':'—';
  const colors=['#087c68','#477bc3'];
  const charts=new Map();
  let report, allMonths, selectedMonth, selectedYear;
  const record=b=>b.months.find(m=>m.month===selectedMonth);
  const previous=b=>b.months.find(m=>m.month===M.previousMonth(selectedMonth));
  const periodMonths=()=>allMonths.filter(m=>selectedYear==='all'||m.startsWith(selectedYear));
  const location=b=>`<span class="location"><i class="${b.id}"></i>${esc(b.name)}</span>`;
  const empty=b=>`<article class="panel">${location(b)}<p class="empty">이 달의 자료가 없습니다.</p><p class="small muted">제공 범위: ${monthName(b.months[0].month)} ~ ${monthName(b.months.at(-1).month)}</p></article>`;

  function renderSummary() {
    const months=report.branches.map(record), total=M.combined(months);
    $('summary-title').textContent=total ? `${monthName(selectedMonth)}, 두 지점 합산 ${money(Math.abs(total.profit))} ${total.profit<0?'적자':total.profit>0?'흑자':'손익 균형'}` : `${monthName(selectedMonth)}, 제공된 지점의 실적을 살펴보세요`;
    $('summary-text').textContent=total ? months.map((m,i)=>`${report.branches[i].name} ${money(Math.abs(m.profit))} ${m.profit<0?'적자':'흑자'}`).join(' · ')+'. 운영 손익과 자금 증감을 함께 확인하세요.' : '두 지점의 자료가 모두 있는 달에만 합산 성과를 표시합니다.';
    $('kpis').innerHTML=[['운영수입','revenue','요양급여·이용료·보조금 등'],['운영비용','cost','인건비·식비·운영비·이자 등'],['운영 손익','profit','두 지점 합산 · 입출금 기준'],['실제 자금 증감','cashChange','대출·상환·시설 투자 등 포함']].map(([label,key,note])=>`<article class="kpi"><span class="kpi-label">${label}</span><strong class="${key==='profit'||key==='cashChange'?tone(total?.[key]):''}" ${total?`title="${exact(total[key])}"`:''}>${total?money(total[key]):'합산 불가'}</strong><small>${note}</small></article>`).join('');
    $('branches').innerHTML=report.branches.map(b=>{
      const m=record(b), p=previous(b); if(!m)return empty(b);
      const labor=M.groups(m,'expense')['인건비']||0;
      const cashNote=m.profit>=0&&m.cashChange<0?'운영에서는 남았지만, 상환·자금 이동으로 실제 자금은 줄었습니다.':m.profit<0&&m.cashChange>=0?'차입·자금 유입이 운영 적자를 보완하고 있습니다.':m.profit<0?`운영수입보다 비용이 ${money(-m.profit)} 많았습니다.`:`운영수입의 ${pct(m.profit,m.revenue)}가 남았습니다.`;
      return `<article class="branch-card ${b.id}"><div class="card-heading">${location(b)}<span class="badge ${m.profit<0?'loss':''}">${m.profit<0?'운영 적자':m.profit>0?'운영 흑자':'손익 균형'}</span></div><div class="profit-line"><strong class="${tone(m.profit)}" title="${exact(m.profit)}">${money(m.profit)}</strong><span>운영 손익</span></div><p class="change">${p?`전월보다 <b class="${tone(m.profit-p.profit)}">${money(Math.abs(m.profit-p.profit))} ${m.profit>=p.profit?'개선':'감소'}</b> · 손익률 ${pct(m.profit,m.revenue)}`:'전월 자료 없음 · 전월 대비 비교 불가'}</p><div class="mini-stats"><div><span>운영수입</span><strong title="${exact(m.revenue)}">${money(m.revenue)}</strong></div><div><span>운영비용</span><strong title="${exact(m.cost)}">${money(m.cost)}</strong></div><div><span>수입 대비 인건비</span><strong>${pct(labor,m.revenue)}</strong></div></div><p class="card-note">${cashNote}</p></article>`;
    }).join('');
  }

  function recommendation(m, p, changes) {
    if(m.flags.length)return m.flags.map(f=>`<p class="flag">${esc(f.message)}${f.amount?` (${money(f.amount)})`:''}</p>`).join('');
    const largest=changes.find(d=>d.impact<0);
    let text='수입과 비용의 입출금 시점을 함께 확인하면 월별 변동을 더 정확하게 읽을 수 있습니다.';
    if(largest?.group==='인건비')text='인건비 변동이 가장 크게 작용했습니다. 급여·퇴직금·보험료 중 일시 정산분과 매달 반복될 비용을 구분해보세요.';
    else if(largest?.label==='수입')text=`${largest.group} 감소가 가장 크게 작용했습니다. 청구·입금 시점의 차이인지 실제 이용 수입 감소인지 대조가 필요합니다.`;
    else if(largest)text=`${largest.group} 증가가 가장 크게 작용했습니다. 여러 달분의 한꺼번에 지급 또는 일회성 지출이 포함됐는지 확인해보세요.`;
    if(m.profit<0)text+=` 현재 기록 기준으로 수입 증가나 비용 감소가 ${money(-m.profit)}만큼 있어야 손익 균형에 도달합니다.`;
    return `<div class="insight"><strong>함께 확인할 점</strong>${esc(text)}</div>`;
  }

  function renderDrivers() {
    $('drivers').innerHTML=report.branches.map(b=>{
      const m=record(b), p=previous(b); if(!m)return empty(b);
      const changes=M.drivers(m,p), negatives=changes.filter(d=>d.impact<0), positives=changes.filter(d=>d.impact>0);
      const chosen=(m.profit<0||p&&m.profit<p.profit) ? negatives.slice(0,3) : positives.sort((a,b)=>b.impact-a.impact).slice(0,3);
      const maximum=Math.max(1,...chosen.map(d=>Math.abs(d.impact)));
      const headline=m.profit<0?`운영비용이 수입보다 ${money(-m.profit)} 많습니다.`:`운영 손익은 ${money(m.profit)} 흑자입니다.`;
      const description=p?`전월 대비 수입 ${signed(m.revenue-p.revenue)}, 비용 ${signed(m.cost-p.cost)}. 손익은 ${money(Math.abs(m.profit-p.profit))} ${m.profit>=p.profit?'개선':'감소'}했습니다.`:'전월 자료가 없어 증감 원인은 비교하지 않습니다.';
      const other=(p?m.profit-p.profit:0)-chosen.reduce((n,d)=>n+d.impact,0);
      return `<article class="driver-card"><div class="card-heading">${location(b)}<span class="small muted">${Number(selectedMonth.slice(5))}월 분석</span></div><p class="driver-intro"><strong>${headline}</strong><br>${description}</p>${chosen.map(d=>`<div class="impact-row"><div>${esc(d.group)}${d.label === '수입' && !d.group.endsWith('수입') ? ' 수입' : ''} ${d.delta>0?'증가':'감소'}<small>${money(d.before)} → ${money(d.after)}</small></div><b class="${tone(d.impact)}" title="${exact(d.impact)}">${signed(d.impact)}</b><div class="impact-bar"><i class="${d.impact>0?'good':''}" style="width:${Math.abs(d.impact)/maximum*100}%"></i></div></div>`).join('')}${p?`<p class="offsets">그 외 항목의 손익 영향 ${signed(other)}<br>위 항목과 합산한 전월 대비 손익 변화 <b>${signed(m.profit-p.profit)}</b></p>`:''}${recommendation(m,p,changes)}</article>`;
    }).join('');
  }

  function renderCharts() {
    if(typeof Chart==='undefined') {
      $('profit-chart').parentElement.innerHTML='<p class="notice">차트를 불러오지 못했습니다. 아래 월별 표에서 수치를 확인해주세요.</p>';
      return;
    }
    for(const chart of charts.values()) chart.destroy(); charts.clear();
    Chart.defaults.font.family="Pretendard, 'Malgun Gothic', Arial, sans-serif";
    Chart.defaults.color='#67766c';
    const months=periodMonths();
    charts.set('profit',new Chart($('profit-chart'),{type:'bar',data:{labels:months.map(m=>`${m.slice(2,4)}.${m.slice(5)}`),datasets:report.branches.map((b,i)=>({label:b.name,data:months.map(month=>{const m=b.months.find(m=>m.month===month);return m?m.profit/10000:null;}),backgroundColor:months.map(m=>m===selectedMonth?colors[i]:i?'#a1bade':'#73aa96'),borderColor:colors[i],borderWidth:0,borderRadius:4,maxBarThickness:34}))},options:{responsive:true,maintainAspectRatio:false,animation:false,onClick:(e,elements)=>{if(elements.length){selectedMonth=months[elements[0].index];$('month').value=selectedMonth;render();}},plugins:{legend:{display:false},tooltip:{callbacks:{title:items=>monthName(months[items[0].dataIndex]),label:item=>`${item.dataset.label}: ${money(item.parsed.y*10000)}`}}},scales:{x:{grid:{display:false},ticks:{maxRotation:0,autoSkip:true}},y:{beginAtZero:true,grid:{color:ctx=>ctx.tick.value===0?'#9aada0':'#edf1ed'},ticks:{callback:v=>num(v,0)}}}}}));
    const expenses=report.branches.map(b=>M.groups(record(b),'expense'));
    const groupNames=[...new Set(expenses.flatMap(g=>Object.keys(g)))].filter(g=>expenses.some(e=>e[g])).sort((a,b)=>Math.max(...expenses.map(g=>Math.abs(g[b]||0)))-Math.max(...expenses.map(g=>Math.abs(g[a]||0))));
    charts.set('cost',new Chart($('cost-chart'),{
      type:'bar',
      data:{labels:groupNames,datasets:report.branches.map((b,i)=>({
        label:b.name,data:groupNames.map(g=>record(b)?(expenses[i][g]||0)/10000:null),
        backgroundColor:colors[i],borderRadius:3,maxBarThickness:12
      }))},
      options:{
        indexAxis:'y',responsive:true,maintainAspectRatio:false,animation:false,
        plugins:{
          legend:{position:'bottom',labels:{boxWidth:9,boxHeight:9,usePointStyle:true,padding:18}},
          tooltip:{callbacks:{label:item=>`${item.dataset.label}: ${money(item.parsed.x*10000)}`}}
        },
        scales:{
          x:{beginAtZero:true,grid:{color:'#edf1ed'},ticks:{callback:v=>num(v,0)}},
          y:{grid:{display:false},ticks:{font:{size:11}}}
        }
      }
    }));
    $('cost-detail').innerHTML=`<table class="cost-table"><caption>비용 상세 <span class="small muted">· 만원 / 비용 비중</span></caption><thead><tr><th scope="col">항목</th>${report.branches.map(b=>`<th scope="col">${b.name}</th>`).join('')}</tr></thead><tbody>${groupNames.map(g=>`<tr><td>${esc(g)}</td>${report.branches.map((b,i)=>{const m=record(b);return `<td title="${m?exact(expenses[i][g]||0):''}">${m?num((expenses[i][g]||0)/10000):'자료 없음'}${m?`<small>${pct(expenses[i][g]||0,m.cost)}</small>`:''}</td>`;}).join('')}</tr>`).join('')}<tr class="total"><td>합계</td>${report.branches.map(b=>`<td>${record(b)?num(record(b).cost/10000):'자료 없음'}</td>`).join('')}</tr></tbody></table><p class="small muted">환급은 비용에서 차감합니다. 음수 비용이 있으면 다른 항목의 비중이 100%를 넘을 수 있습니다.</p>`;
  }

  function renderBridge() {
    const keys=[['운영 손익','profit'],['차입·원금 상환','financing'],['시설·자산 투자','investment'],['기타 자금 이동','transfer'],['오입금·반환','correction'],['실제 자금 증감','cashChange']];
    $('cash-bridge').innerHTML=report.branches.map(b=>{
      const m=record(b);if(!m)return empty(b);
      return `<article class="cash-card">${location(b)}<table class="bridge-table"><tbody>${keys.map(([label,key])=>`<tr><td>${label}</td><td class="${tone(m[key])}" title="${exact(m[key])}">${signed(m[key])}</td></tr>`).join('')}</tbody></table><p class="balance">월초 ${money(m.openingBalance)} → 월말 ${money(m.closingBalance)}</p>${m.carry?`<p class="small muted">전년도 이월금 ${money(m.carry)}는 월초 잔액에만 반영했습니다.</p>`:''}</article>`;
    }).join('');
  }

  function renderHistory() {
    $('history').innerHTML=periodMonths().map(month=>`<tr class="${month===selectedMonth?'selected':''}"><td><button type="button" data-month="${month}" aria-label="${monthName(month)} 상세 분석" ${month===selectedMonth?'aria-current="true"':''}>${month.slice(2,4)}년 ${Number(month.slice(5))}월</button></td>${report.branches.map(b=>{const m=b.months.find(m=>m.month===month);return ['revenue','cost','profit'].map(k=>`<td class="${k==='profit'?'profit-cell '+tone(m?.[k]):''}" ${m?`title="${exact(m[k])}"`:''}>${m?num(m[k]/10000):'자료 없음'}</td>`).join('');}).join('')}</tr>`).join('');
  }
  function renderSources() {
    $('methodology').innerHTML=`<p>${report.sourceCount}개 월별 파일의 거래 합계·월 합계·거래별 잔액을 대조했습니다. 제공된 기록 ${num(M.sum(report.branches.flatMap(b=>b.months),'transactionCount'),0)}건 기준입니다.</p><p>${report.branches.map(b=>`${b.name}: ${monthName(b.months[0].month)} ~ ${monthName(b.months.at(-1).month)}`).join('<br>')}<br>2026년 8월·9월 자료는 제공되지 않았습니다. 마지막 거래일이 월말보다 이르더라도 제공된 월별 파일의 집계 범위를 따릅니다.</p>`;
    $('source-details').innerHTML=`<p><strong>선택한 달의 근거 자료</strong></p><div class="source-list">${report.branches.map(b=>{const m=record(b);return m?`${b.name} · ${esc(m.source.file)} · ${esc(m.source.sheet)} ${esc(m.source.range)} · 월 합계 ${esc(m.source.controlRange)}<br>기록 ${m.firstDate} ~ ${m.lastDate}, ${num(m.transactionCount,0)}건`:`${b.name}: 해당 월 자료 없음`;}).join('<br>')}</div>`;
  }
  function render() {
    renderSummary();renderDrivers();renderCharts();renderBridge();renderHistory();renderSources();
    const params=new URLSearchParams({year:selectedYear,month:selectedMonth});
    window.history.replaceState(null,'',`${locationPath()}?${params}`);
  }
  const locationPath=()=>window.location.pathname;
  function fillMonths(preferred) {
    const months=periodMonths();
    selectedMonth=months.includes(preferred)?preferred:months.at(-1);
    $('month').innerHTML=[...months].reverse().map(m=>`<option value="${m}">${monthName(m)}</option>`).join('');
    $('month').value=selectedMonth;
  }
  async function load() {
    $('status').hidden=false;$('retry').hidden=true;$('dashboard').hidden=true;$('download').disabled=true;
    $('status').textContent='운영비 자료를 불러오고 있습니다.';
    try {
      const response=await fetch('/api/operating-report');
      if(!response.ok)throw new Error('report unavailable');
      report=await response.json();
      if(report.schemaVersion!==1||report.branches?.length!==2)throw new Error('invalid report');
      allMonths=[...new Set(report.branches.flatMap(b=>b.months.map(m=>m.month)))].sort();
      const years=[...new Set(allMonths.map(m=>m.slice(0,4)))].sort().reverse();
      const params=new URLSearchParams(window.location.search);
      const requested=params.get('year');selectedYear=years.includes(requested)||requested==='all'?requested:years[0];
      $('year').innerHTML=years.map(y=>`<option value="${y}">${y}년</option>`).join('')+'<option value="all">전체 기간</option>';
      $('year').value=selectedYear;fillMonths(params.get('month'));
      $('coverage').textContent=`자료 ${report.sourceDate.replaceAll('-','.')} · 최근 ${monthName(allMonths.at(-1))}`;
      $('dashboard').hidden=false;render();$('status').hidden=true;$('download').disabled=false;
    }catch(error){$('dashboard').hidden=true;$('status').textContent='운영비 자료를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.';$('retry').hidden=false;}
  }
  $('year').addEventListener('change',()=>{selectedYear=$('year').value;fillMonths(selectedMonth);render();});
  $('month').addEventListener('change',()=>{selectedMonth=$('month').value;render();});
  $('history').addEventListener('click',e=>{const button=e.target.closest('[data-month]');if(button){selectedMonth=button.dataset.month;$('month').value=selectedMonth;render();$('month').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});}});
  $('download').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([M.csv(report,selectedYear)],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`더비다_월별운영비_${selectedYear}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  $('retry').addEventListener('click',load);
  load();
})();
