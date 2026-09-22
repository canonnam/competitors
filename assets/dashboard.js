/* Home overview consumes existing collectors without acknowledging news.
   Inquiry totals use a separate authenticated, aggregate-only collector. */
(function(root, factory) {
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.HomeDashboard=api;
})(typeof window==='undefined'?globalThis:window, function() {
  'use strict';
  const sources={
    competitor:{title:'경쟁사·요양원 뉴스',href:'/competitor-news.html'},
    agency:{title:'정책·지원사업',href:'/agency-news.html'},
    claims:{title:'지점별 청구',href:'/claim-check.html'},
    keywords:{title:'네이버 광고',href:'/naver-ads.html'},
    visibility:{title:'검색노출',href:'/search-visibility.html'},
    reputation:{title:'평판 점검',href:'/reputation-watch.html'},
    requests:{title:'상담·무료체험 신청 현황',href:'/website-requests.html'},
    ads:{title:'네이버 광고 추이',href:'/naver-ads.html'}
  };
  const state={};
  let redraw=()=>{};
  const number=value=>Number.isFinite(value)?value.toLocaleString('ko-KR'):'—';
  const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'확인 기록 없음';
  const oldestDate=values=>values.length&&values.every(value=>value&&Number.isFinite(Date.parse(value)))?new Date(Math.min(...values.map(value=>Date.parse(value)))).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}):'일부 미조회';
  function update(id,data,status={}) {
    if(!sources[id])return;
    state[id]={data,status,error:false};redraw();
  }
  function fail(id) {
    if(!sources[id])return;
    state[id]={...(id==='requests'?{}:state[id]),error:true,status:{label:'연결 확인 필요',warning:true}};redraw();
  }
  function laborStatus(labor) {
    const verified=labor?.status==='verified'&&labor.annualRatio!==null&&labor.annualRatio!==''&&Number.isFinite(Number(labor.annualRatio));
    if(!verified)return {value:'—',label:labor?.status==='query_failed'?'조회 실패':'미조회',tone:'warning'};
    const label=labor.assessment==='stable'?'안정':labor.assessment==='check'?'점검 필요':'운영 기준 미설정';
    return {value:`${labor.annualRatio}%`,label,tone:label==='안정'?'success':label==='점검 필요'?'warning':''};
  }
  function snapshot(records,counts={}) {
    const ready=id=>!!records[id]?.data&&!records[id].error;
    const claims=records.claims?.data;
    const support=records.agency?.data?.support;
    const supportCollected=ready('agency')&&records.agency.data.sources?.some(source=>source.id==='bizinfo'&&source.last_success);
    const keywords=records.keywords?.data;
    const bothNews=ready('competitor')&&ready('agency')&&Number.isFinite(counts.competitor)&&Number.isFinite(counts.agency);
    const newsWarning=['competitor','agency'].some(id=>records[id]?.status?.warning);
    return {
      metrics:[
        {id:'news',title:'미확인 새 소식',value:bothNews?number(counts.competitor+counts.agency)+'건':'—',note:bothNews?(newsWarning?'이전 수집 포함 · 갱신 상태 확인':'경쟁사·요양원 + 정책·지원사업'):['competitor','agency'].some(id=>records[id]?.error)?'일부 소식을 불러오지 못했습니다':'새 소식 확인 중',href:'#dashboard-news',warning:newsWarning},
        {id:'support',title:'추천 지원사업',value:supportCollected&&Number.isFinite(support?.active)?number(support.active)+'건':'—',note:supportCollected?(records.agency.status?.warning?'수집 상태 확인 필요 · 저장된 추천':'관심·추천 기준 반영 · 접수 조건 확인'):records.agency?.error?'지원사업 연결 확인 필요':ready('agency')?'지원사업 첫 수집 대기':'추천 확인 중',href:sources.agency.href,warning:records.agency?.status?.warning},
        {id:'claims',title:'청구 접수 완료',value:ready('claims')?`${(claims.branches||[]).filter(b=>b.status==='accepted').length} / ${(claims.branches||[]).length}지점`:'—',note:ready('claims')?`${claims.benefitMonth} 급여제공분 · 저장 결과`:records.claims?.error?'청구 결과 연결 확인 필요':'청구 상태 확인 중',href:sources.claims.href,warning:!!records.claims?.error||ready('claims')&&(claims.branches||[]).some(b=>b.status!=='accepted')},
        {id:'keywords',title:'광고 평균 3위 이내',value:ready('keywords')&&keywords.updated_at?number(keywords.top_count)+'개':'—',note:ready('keywords')?(records.keywords.status?.warning?'갱신 대기 · 이전 집계':keywords.updated_at?`최근 7일 · 집행 가능 ${number(keywords.eligible_top_count)}개`:'아직 수집된 순위가 없습니다'):records.keywords?.error?'광고 순위 연결 확인 필요':'키워드 확인 중',href:sources.keywords.href,warning:records.keywords?.status?.warning}
      ]
    };
  }
  function mount(win,container) {
    const doc=win.document;
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const badge=(text,tone='')=>`<span class="ui-status"${tone?` data-status="${tone===true?'warning':esc(tone)}"`:''}>${esc(text)}</span>`;
    container.className='kb-dashboard';container.id='kb-dashboard';container.setAttribute('aria-labelledby','dashboard-title');
    container.innerHTML=`<div class="dash-heading"><div><h1 id="dashboard-title">대시보드</h1><p>오늘 확인할 소식과 업무</p></div><time class="dash-date"></time></div>
      <div class="dash-metrics" data-dash-slot="metrics" aria-label="핵심 현황"></div>
      <div class="dash-columns">
        <section class="dash-panel dash-summary" aria-labelledby="dashboard-branches-title"><div class="dash-panel-head"><h2 id="dashboard-branches-title">지점별 상태표</h2><a href="/claim-check.html" aria-label="청구·인건비 상세 보기">상세 보기</a></div><div data-dash-slot="branches"></div><div class="dash-summary-footer"><span class="dash-meta" data-dash-slot="branches-time"></span></div></section>
        <section class="dash-panel dash-summary" aria-labelledby="dashboard-requests-title"><div class="dash-panel-head"><h2 id="dashboard-requests-title">상담·무료체험 현황</h2><a href="/website-requests.html">신청 관리</a></div><div data-dash-slot="requests" aria-live="polite"></div><div class="dash-summary-footer"><span class="dash-meta" data-dash-slot="requests-time"></span><button type="button" class="ui-button dash-refresh" data-dash-refresh="requests" aria-label="신청 현황 새로고침">새로고침</button></div></section>
        <section class="dash-panel dash-ads-panel" aria-labelledby="dashboard-ads-title"><div class="dash-panel-head"><h2 id="dashboard-ads-title">네이버 광고 노출·클릭 추이</h2><a href="/naver-ads.html">광고 상세</a></div><div data-dash-slot="ads"></div></section>
        <section class="dash-panel" id="dashboard-news" aria-labelledby="dashboard-news-title"><div class="dash-panel-head"><h2 id="dashboard-news-title">시장·정책 새 소식</h2></div><div data-dash-slot="news"></div><p class="dash-footnote">미확인 수는 이 브라우저의 읽음 기록 기준입니다.</p></section>
        <section class="dash-panel" aria-labelledby="dashboard-marketing-title"><div class="dash-panel-head"><h2 id="dashboard-marketing-title">마케팅·점검 현황</h2></div><div data-dash-slot="marketing"></div></section>
      </div>
      <section class="dash-shortcuts" aria-labelledby="dashboard-shortcuts-title"><h2 id="dashboard-shortcuts-title">주요 업무 바로가기</h2><div class="dash-shortcut-grid">
        <a href="/website-requests.html"><strong>상담·무료체험 신청</strong><span>로그인 후 신청 내역 확인</span></a>
        <a href="/payroll-insurance.html"><strong>월별 급여·4대보험</strong><span>담당자 로그인 후 확인</span></a>
        <a href="/operating-costs.html"><strong>운영비 분석</strong><span>지점별 수입·비용 비교</span></a>
        <a href="/support-projects.html"><strong>지원사업 준비·기록</strong><span>참여 과제와 준비 현황</span></a>
      </div></section>`;
    // Replace only changed sections, preserving keyboard focus across refreshes.
    function slot(name,html) {
      const target=container.querySelector('[data-dash-slot="'+name+'"]');
      if(target._html===html)return;
      const focus=target.contains(doc.activeElement)?doc.activeElement?.getAttribute('data-dash-key'):null;
      target.innerHTML=html;target._html=html;
      if(focus)[...target.querySelectorAll('[data-dash-key]')].find(el=>el.dataset.dashKey===focus)?.focus({preventScroll:true});
    }
    const row=(id,title,description,meta,tone)=>`<a class="dash-row" href="${sources[id].href}" data-dash-key="${id}"><div><strong>${esc(title)}</strong><p>${esc(description)}</p><small>${esc(meta)}</small></div><span>${badge(state[id]?.error?'연결 확인 필요':tone||state[id]?.status?.label||'확인 중',state[id]?.error||state[id]?.status?.warning)}</span></a>`;
    function draw() {
      const counts=win.NewsBadge?.counts()||{};
      const view=snapshot(state,counts);
      container.querySelector('.dash-date').textContent=new Date().toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'long'});
      slot('metrics',view.metrics.map(item=>`<a class="dash-metric" href="${item.href}" data-dash-key="metric-${item.id}"${item.warning?' data-warning="true"':''}><span>${esc(item.title)}</span><strong>${esc(item.value)}</strong><small>${esc(item.note)}</small></a>`).join(''));
      const claim=state.claims?.data;
      const branches=claim?.branches||[],laborMonths=[...new Set(branches.map(branch=>branch.laborCost?.benefitMonth).filter(Boolean))];
      slot('branches',claim?`<p class="dash-meta">청구 ${esc(claim.benefitMonth)} · 인건비 ${esc(laborMonths.join(', ')||'미조회')} 조회분</p>${state.claims.error?'<p class="dash-warning">연결 확인 필요 · 아래는 이전 조회 결과입니다.</p>':''}<div class="dash-table-wrap"><table class="dash-branch-table"><caption class="dash-sr-only">지점별 청구 접수 및 연간 인건비 비율</caption><thead><tr><th scope="col">지점</th><th scope="col">청구</th><th scope="col">연간 인건비</th></tr></thead><tbody>${branches.map(branch=>{
        const labor=branch.laborCost,status=laborStatus(labor);
        return `<tr><th scope="row">${esc(branch.name)}</th><td>${badge(branch.label,branch.status==='accepted'?'success':'warning')}<span class="dash-sr-only">${esc(branch.message)}</span></td><td><div class="dash-labor-value"><strong>${esc(status.value)}</strong>${badge(status.label,status.tone)}</div></td></tr>`;
      }).join('')}</tbody></table></div>`:`<p class="dash-empty">${state.claims?.error?'지점별 상태 조회 실패 · 상세 보기에서 확인해주세요.':'청구·인건비 확인 중'}</p>`);
      slot('branches-time',claim?`저장 조회 · 청구 ${esc(oldestDate(branches.map(branch=>branch.checkedAt)))} · 인건비 ${esc(oldestDate(branches.map(branch=>branch.laborCost?.checkedAt)))}`:'');
      const request=state.requests,data=request?.data;
      slot('requests',request?.status?.locked?`<div class="dash-locked"><p>담당자 로그인 후 신청 현황을 확인하세요.</p><a class="ui-button" href="/website-requests.html" data-dash-key="requests-login">담당자 로그인</a></div>`:request?.error?'<p class="dash-empty">신청 현황 조회 실패 · 다시 새로고침해주세요.</p>':data?`<p class="dash-meta">운영 사이트 누적 · 개발 사이트 제외</p><dl class="dash-request-counts">${Object.entries({new:'새 접수',contacted:'상담 중',completed:'상담 완료',archived:'보관함'}).map(([key,label])=>`<div${key==='new'&&data.counts[key]>0?' data-status="warning"':''}><dt>${label}</dt><dd>${number(data.counts[key])}<span>건</span></dd></div>`).join('')}</dl>${data.total===0?'<p class="dash-meta">접수된 신청이 없습니다.</p>':''}`:'<p class="dash-empty">신청 현황 확인 중</p>');
      slot('requests-time',data&&!request.error?`조회 ${esc(date(data.generatedAt))}`:'');
      container.querySelector('[data-dash-refresh="requests"]').disabled=!request||(!request.data&&!request.error&&!request.status?.locked);
      const adsExpanded=!!container.querySelector('[data-dash-slot="ads"] details[open]');
      slot('ads',win.DashboardAds?win.DashboardAds.render(state.ads,adsExpanded):'<p class="dash-empty">광고 추이 확인 중</p>');
      slot('news',['competitor','agency'].map(id=>{
        const record=state[id],data=record?.data;
        return row(id,sources[id].title,data?`미확인 ${number(counts[id])}건 · 전체 ${number(data.total)}건`:record?.error?'소식을 불러오지 못했습니다.':'최근 소식 확인 중',data?`전체 수집 ${date(data.updated_at)}${record.error?' · 이전 결과':''}`:record?.error?'상세 화면에서 다시 확인해주세요.':'수집 결과를 불러옵니다.');
      }).join(''));
      slot('marketing',['keywords','visibility','reputation'].map(id=>{
        const record=state[id],data=record?.data;
        const meta=id==='visibility'?`다음 점검 ${date(data?.next_run)}`:`수집 ${date(data?.updated_at)}`;
        return row(id,sources[id].title,record?.error?'저장 결과 연결을 확인해주세요.':record?.status?.detail||record?.status?.label||'점검 상태 확인 중',data?meta:'최근 결과를 불러옵니다.');
      }).join(''));
    }
    redraw=draw;win.NewsBadge?.subscribe(draw);draw();
    win.addEventListener('pageshow',draw);
    return container;
  }
  return {update,fail,mount,snapshot,laborStatus};
});
