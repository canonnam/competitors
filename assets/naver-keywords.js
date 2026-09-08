(function (root) {
  'use strict';
  function isTop(row, data) { return Number.isFinite(row.average_rank) && row.average_rank >= 1 && row.average_rank <= data.threshold; }
  function signal(row, data) {
    if (data.stale || data.error) return {tone:'is-warning', text:'갱신 대기 · 이전 순위'};
    if (row.average_rank == null) return {tone:'', text:'순위 정보 없음'};
    if (!row.eligible) return {tone:'', text:isTop(row,data) ? '평균 3위 이내 · 집행 제한' : '집행 제한'};
    return isTop(row,data) ? {tone:'is-top', text:'최근 평균 3위 이내'} : {tone:'', text:'평균 3위 밖'};
  }
  function summary(data) {
    if (!data || !data.updated_at) return {tone:'', text:'키워드 순위 수집 대기'};
    if (data.stale || data.error) return {tone:'is-warning', text:'키워드 순위 갱신 대기 · 이전 집계'};
    if (!data.total) return {tone:'', text:'등록된 파워링크 키워드 없음'};
    return {tone:data.eligible_top_count > 0 ? 'is-top' : '', text:`최근 7일 평균 3위 이내 ${data.top_count}개 · 집행 가능 ${data.eligible_top_count}개`};
  }
  const api = {isTop, signal, summary};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AdKeywords = api;
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = (value, digits=0) => Number.isFinite(value) ? value.toLocaleString('ko-KR',{maximumFractionDigits:digits}) : '미제공';
  const rank = row => row.average_rank == null ? '순위 없음' : `${num(row.average_rank,1)}위`;
  let current;
  function renderSignal(element, status) {
    element.className = 'keyword-signal ' + status.tone;
    element.innerHTML = '<span class="keyword-dot" aria-hidden="true"></span><span>'+esc(status.text)+'</span>';
  }
  function draw() {
    if (!current) return;
    if (current.next_check && Date.now() >= Date.parse(current.next_check)) current={...current,stale:true};
    renderSignal($('keyword-summary'),summary(current));
    const query=$('keyword-search').value.trim().toLocaleLowerCase(), filter=$('keyword-filter').value, sort=$('keyword-sort').value;
    const rows=current.items.filter(row=>(row.keyword+' '+row.group).toLocaleLowerCase().includes(query) && (filter==='all' || (filter==='top' && isTop(row,current)) || (filter==='eligible' && row.eligible) || (filter==='unknown' && row.average_rank==null)));
    rows.sort((a,b)=>sort==='name' ? a.keyword.localeCompare(b.keyword,'ko') : sort==='rank' ? (a.average_rank??Infinity)-(b.average_rank??Infinity) || b.impressions-a.impressions : b[sort]-a[sort]);
    $('keyword-cards').innerHTML=rows.length ? rows.map(row=>{
      const state=signal(row,current);
      return `<article class="keyword-card"><h3>${esc(row.keyword)}</h3><p class="keyword-group">${esc(row.group)}</p><div class="keyword-rank">${esc(rank(row))}<span>평균 광고 노출순위</span></div><div class="keyword-signal ${state.tone}"><span class="keyword-dot" aria-hidden="true"></span><span>${esc(state.text)}</span></div><dl><div><dt>노출</dt><dd>${num(row.impressions)}회</dd></div><div><dt>클릭</dt><dd>${num(row.clicks)}회</dd></div><div><dt>광고비</dt><dd>${num(row.cost)}원</dd></div></dl></article>`;
    }).join('') : '<p class="keyword-empty">조건에 맞는 키워드가 없습니다.</p>';
    $('keyword-table').innerHTML='<table><thead><tr><th scope="col">키워드 / 광고그룹</th><th scope="col">평균 순위</th><th scope="col">상태</th><th scope="col">노출</th><th scope="col">클릭</th><th scope="col">광고비</th><th scope="col">CTR</th><th scope="col">CPC</th></tr></thead><tbody>'+rows.map(row=>`<tr><td class="title-cell">${esc(row.keyword)}<span>${esc(row.group)}</span></td><td>${esc(rank(row))}</td><td>${esc(signal(row,current).text)}</td><td>${num(row.impressions)}</td><td>${num(row.clicks)}</td><td>${num(row.cost)}원</td><td>${row.impressions ? num(row.clicks/row.impressions*100,2)+'%' : '미제공'}</td><td>${row.clicks ? num(row.cost/row.clicks)+'원' : '미제공'}</td></tr>`).join('')+(rows.length?'':'<tr><td colspan="8">조건에 맞는 키워드가 없습니다.</td></tr>')+'</tbody></table>';
  }
  api.render = data => {
    if (!$('keyword-cards')) return;
    current=data || {items:[],stale:true,threshold:3};
    renderSignal($('keyword-summary'),summary(current));
    $('keyword-period').textContent=current.updated_at ? `${current.since} ~ ${current.through} · 등록 ${current.total}개 / 순위 제공 ${current.ranked_count}개 · 수집 ${new Date(current.updated_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} (한국시간)${current.error ? ' · '+current.error : ''}` : '아직 수집된 순위가 없습니다. 매일 10:30 (한국시간)에 자동 갱신합니다.';
    draw();
  };
  ['keyword-search','keyword-filter','keyword-sort'].forEach(id=>$(id)?.addEventListener(id==='keyword-search'?'input':'change',draw));
  if($('keyword-cards')) {
    const refresh=async()=>{
      try {
        const response=await fetch('/api/naver-ad-keywords',{cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('request');
        api.render(await response.json());
      } catch { if(current)api.render({...current,stale:true,error:'순위 갱신 연결 실패 · 이전 집계'}); }
    };
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){draw();refresh();}});
    setInterval(()=>{if(!document.hidden){draw();refresh();}},300000);
  }
  const home=$('home-keyword-status');
  if(home) {
    const refresh=async()=>{
      try {
        const response=await fetch('/api/naver-ad-keywords',{cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('request');
        renderSignal(home,summary(await response.json()));
      } catch { renderSignal(home,{tone:'is-warning',text:'키워드 순위 연결 확인 필요'}); }
    };
    refresh();
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
    setInterval(()=>{if(!document.hidden)refresh();},300000);
  }
})(globalThis);
