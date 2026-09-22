/* Home overview consumes the existing collectors; it never starts a second request
   or acknowledges news. Private workflows remain behind their existing login. */
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
    reputation:{title:'평판 점검',href:'/reputation-watch.html'}
  };
  const state={};
  let redraw=()=>{};
  const number=value=>Number.isFinite(value)?value.toLocaleString('ko-KR'):'—';
  const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'확인 기록 없음';
  function update(id,data,status={}) {
    if(!sources[id])return;
    state[id]={data,status,error:false};redraw();
  }
  function fail(id) {
    if(!sources[id])return;
    state[id]={...state[id],error:true,status:{label:'연결 확인 필요',warning:true}};redraw();
  }
  function snapshot(records,counts={}) {
    const ready=id=>!!records[id]?.data&&!records[id].error;
    const attention=[];
    for(const [id,source] of Object.entries(sources)) {
      const record=records[id];
      if(record?.error||record?.status?.warning)attention.push({key:id,...source,label:record.status?.label||'확인 필요',detail:record.error?'저장 결과를 불러오지 못했습니다. 상세 화면에서 다시 확인해주세요.':record.status?.detail||'최근 수집·점검 상태와 저장된 결과를 확인해주세요.'});
    }
    const claims=records.claims?.data;
    if(ready('claims'))for(const branch of claims.branches||[]) {
      if(branch.status!=='accepted'||branch.lastQueryFailureAt)attention.push({key:'claim-'+branch.id,title:branch.name+' 청구',href:sources.claims.href,label:branch.lastQueryFailureAt?'재조회 필요':'청구 점검',detail:branch.lastQueryFailureAt?'최근 조회에 실패했습니다. 이전 확인 결과가 남아 있습니다.':branch.message});
    }
    const reputation=records.reputation?.data?.counts;
    if(ready('reputation')&&((reputation?.concern||0)+(reputation?.uncertain||0)>0))attention.push({key:'review-reputation',title:'평판 원문 검토',href:sources.reputation.href,label:'검토 후보',detail:`부정적 언급 후보 ${number(reputation.concern)}건 · 대상·맥락 확인 ${number(reputation.uncertain)}건. 원문에서 사실 여부를 확인해주세요.`});
    const support=records.agency?.data?.support;
    const supportCollected=ready('agency')&&records.agency.data.sources?.some(source=>source.id==='bizinfo'&&source.last_success);
    const keywords=records.keywords?.data;
    const bothNews=ready('competitor')&&ready('agency')&&Number.isFinite(counts.competitor)&&Number.isFinite(counts.agency);
    const newsWarning=['competitor','agency'].some(id=>records[id]?.status?.warning);
    return {
      attention,
      pending:Object.keys(sources).filter(id=>!records[id]).length,
      metrics:[
        {id:'news',title:'미확인 새 소식',value:bothNews?number(counts.competitor+counts.agency)+'건':'—',note:bothNews?(newsWarning?'이전 수집 포함 · 갱신 상태 확인':'경쟁사·요양원 + 정책·지원사업'):['competitor','agency'].some(id=>records[id]?.error)?'일부 소식을 불러오지 못했습니다':'새 소식 확인 중',href:'#dashboard-news',warning:newsWarning},
        {id:'support',title:'추천 지원사업',value:supportCollected&&Number.isFinite(support?.active)?number(support.active)+'건':'—',note:supportCollected?(records.agency.status?.warning?'수집 상태 확인 필요 · 저장된 추천':'관심·추천 기준 반영 · 접수 조건 확인'):records.agency?.error?'지원사업 연결 확인 필요':ready('agency')?'지원사업 첫 수집 대기':'추천 확인 중',href:sources.agency.href,warning:records.agency?.status?.warning},
        {id:'claims',title:'청구 접수 완료',value:ready('claims')?`${(claims.branches||[]).filter(b=>b.status==='accepted').length} / ${(claims.branches||[]).length}지점`:'—',note:ready('claims')?`${claims.benefitMonth} 급여제공분 · 저장 결과`:records.claims?.error?'청구 결과 연결 확인 필요':'청구 상태 확인 중',href:sources.claims.href,warning:!!records.claims?.error||ready('claims')&&(claims.branches||[]).some(b=>b.status!=='accepted'||b.lastQueryFailureAt)},
        {id:'keywords',title:'광고 평균 3위 이내',value:ready('keywords')&&keywords.updated_at?number(keywords.top_count)+'개':'—',note:ready('keywords')?(records.keywords.status?.warning?'갱신 대기 · 이전 집계':keywords.updated_at?`최근 7일 · 집행 가능 ${number(keywords.eligible_top_count)}개`:'아직 수집된 순위가 없습니다'):records.keywords?.error?'광고 순위 연결 확인 필요':'키워드 확인 중',href:sources.keywords.href,warning:records.keywords?.status?.warning}
      ]
    };
  }
  function mount(win,container) {
    const doc=win.document;
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const badge=(text,warning=false)=>`<span class="ui-status"${warning?' data-status="warning"':''}>${esc(text)}</span>`;
    container.className='kb-dashboard';container.id='kb-dashboard';container.setAttribute('aria-labelledby','dashboard-title');
    container.innerHTML=`<div class="dash-heading"><div><h1 id="dashboard-title">대시보드</h1><p>오늘 확인할 소식과 업무</p></div><time class="dash-date"></time></div>
      <div class="dash-metrics" data-dash-slot="metrics" aria-label="핵심 현황"></div>
      <div class="dash-columns">
        <section class="dash-panel" aria-labelledby="dashboard-attention-title"><div class="dash-panel-head"><h2 id="dashboard-attention-title">확인할 항목</h2><span data-dash-slot="attention-count" class="dash-meta" role="status"></span></div><div data-dash-slot="attention"></div></section>
        <section class="dash-panel" aria-labelledby="dashboard-claims-title"><div class="dash-panel-head"><h2 id="dashboard-claims-title">지점별 청구</h2><a href="/claim-check.html">상세 보기</a></div><div data-dash-slot="claims"></div></section>
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
      slot('attention-count',esc(view.pending?`확인 중 ${view.pending}개 · 현재 ${view.attention.length}개 항목`:`${view.attention.length}개 항목`));
      slot('attention',view.attention.length?`<ul class="dash-attention-list">${view.attention.map(item=>`<li><a href="${item.href}" data-dash-key="attention-${item.key}"><div class="dash-attention-heading"><strong>${esc(item.title)}</strong>${badge(item.label,true)}</div><p>${esc(item.detail)}</p></a></li>`).join('')}</ul>`:`<p class="dash-empty">${view.pending?'각 기능의 최근 상태를 확인하고 있습니다.':'현재 연결된 점검에서 확인이 필요한 항목이 없습니다.'}</p>`);
      const claim=state.claims?.data;
      slot('claims',claim?`<p class="dash-meta">${esc(claim.benefitMonth)} 급여제공분 · ${esc(claim.deadline)} 청구 마감</p>${state.claims.error?'<p class="dash-warning">연결 확인 필요 · 아래는 이전 조회 결과입니다.</p>':''}<div class="dash-branches">${(claim.branches||[]).map(branch=>`<a href="/claim-check.html" class="dash-branch" data-dash-key="branch-${esc(branch.id)}"><div><h3>${esc(branch.name)}</h3>${badge(branch.label,branch.status!=='accepted'||!!branch.lastQueryFailureAt||state.claims.error)}</div><p>${esc(branch.message)}</p><small>조회 ${esc(date(branch.checkedAt))}${branch.lastQueryFailureAt?' · 재조회 실패':''}</small></a>`).join('')}</div>`:`<p class="dash-empty">${state.claims?.error?'청구 결과를 불러오지 못했습니다. 상세 보기에서 다시 확인해주세요.':'안양점·인천점의 청구 상태를 확인하고 있습니다.'}</p>`);
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
  return {update,fail,mount,snapshot};
});
