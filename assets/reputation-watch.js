(function(root){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function safeUrl(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
  function state(data){
    if(!data?.sync)return {label:'연결 확인 필요',warning:true};
    if(!data.sync.enabled)return {label:'자동 점검 중지',warning:true};
    if(!data.sync.complete)return {label:data.sync.running?'점검 중':data.analysis.error||data.sources.some(s=>s.error)?'점검 지연':data.sync.checked_sources?'점검 미완료':'첫 점검 대기',warning:true};
    return {label:'매일 갱신',warning:false};
  }
  function headline(data){
    const s=state(data),counts=data.counts;
    if(s.warning)return `${s.label} · 수집처 ${data.sync.checked_sources}/${data.sync.expected_sources}개 · 분류 ${counts.reviewed}/${counts.documents}건`;
    if(counts.concern)return `최근 30일 부정적 언급 후보 ${counts.concern}건 · 원문 확인 필요`;
    if(counts.uncertain)return `부정적 언급 후보 0건 · 대상·맥락 확인 ${counts.uncertain}건`;
    return '확인한 공개 검색 결과에서 부정적 언급 후보를 찾지 못했습니다.';
  }
  function filterItems(items,{filter='active',branch='',query=''}={}){
    query=query.trim().toLocaleLowerCase();
    return items.filter(item=>(filter==='archived'?!item.active:item.active&&(filter==='active'||item.verdict===filter))&&(!branch||item.identity===branch)&&(!query||[item.title,item.evidence,item.publisher].join(' ').toLocaleLowerCase().includes(query)));
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={state,headline,filterItems,safeUrl,esc};
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id),home=$('home-reputation-status'),list=$('reputation-list');
  if(!home&&!list)return;
  const tracker=root.NewsBadge?.create('reputation',{badge:$('home-reputation-new'),detail:!!list});
  const when=value=>value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'미확인';
  const branchName={incheon:'인천점',anyang:'안양점',brand:'지점 미표기',unknown:'대상 확인 필요'};
  const categoryName={care:'돌봄·안전',staff:'직원·응대',billing:'비용·계약',facility:'시설·위생',administration:'행정·운영',other:'기타',none:'해당 없음'};
  const verdictName={concern:'부정적 언급 후보',uncertain:'대상·맥락 확인',neutral:'부정 표현 미감지',unrelated:'다른 대상·무관',pending:'분류 대기'};
  let current,loading=false;
  function drawList(){
    const items=filterItems(current.items,{filter:$('reputation-filter').value,branch:$('reputation-branch').value,query:$('reputation-query').value});
    $('reputation-count').textContent=`${items.length}건 표시`;
    list.innerHTML=items.map(item=>`<article class="reputation-finding ${!item.active?'is-archived':item.verdict==='uncertain'?'is-uncertain':''}"><div class="reputation-tags"><span class="visibility-tag is-warning">${esc(item.active?verdictName[item.verdict]:'후속 분류에서 제외')}</span><span class="visibility-tag is-absent">${esc(branchName[item.identity])}</span><span class="visibility-tag is-absent">${esc(categoryName[item.category])}</span></div><h3><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a></h3><p>${esc(item.publisher)} · ${esc(item.basis)}<br>게시일 ${item.published_at?esc(when(item.published_at)):'확인하지 못함'}</p><blockquote>${esc(item.evidence)}</blockquote><p>위 표현은 수집한 제목·요약에서 그대로 발췌했습니다. 주장 내용의 사실 여부와 정확한 대상은 원문에서 확인해주세요.</p><p>처음 감지 ${esc(when(item.first_detected))} · 최근 감지 ${esc(when(item.last_detected))}${!item.seen_in_latest_search?'<br>이번 검색에서는 다시 확인하지 못했습니다. 해결 여부는 알 수 없습니다.':''}${!item.active?'<br>후속 수집·분류에서 같은 부정 표현을 다시 확인하지 못했습니다. 이전 감지 기록이며 해결을 뜻하지 않습니다.':''}</p><a class="reputation-source-link" href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">원문 확인 →</a></article>`).join('')||`<div class="reputation-empty">${state(current).warning?'점검이 완료되지 않았습니다. 현재까지 저장된 후보 중 이 조건에 맞는 글이 없습니다.':current.counts.concern||current.counts.uncertain||current.counts.archived?'선택한 조건에 맞는 검토 후보가 없습니다.':'이번에 확인한 공개 검색 결과에서는 검토 후보를 찾지 못했습니다.<br>확인한 수집처와 글 목록을 아래에서 살펴볼 수 있습니다.'}</div>`;
  }
  function render(data){
    current=data;
    const status=state(data),counts=data.counts;
    if(home){
      home.textContent=headline(data);home.classList.toggle('is-warning',status.warning||counts.concern>0||counts.uncertain>0);
      const badge=$('home-reputation-badge');badge.classList.toggle('is-warning',status.warning);badge.querySelector('span').textContent=status.label;
      badge.setAttribute('aria-label',`${data.sync.schedule} · ${status.label}`);
    }else{
      $('reputation-sync').textContent=`${data.sync.enabled?data.sync.schedule:'자동 점검 중지'} · 최근 전체 완료 ${when(data.updated_at)} · 다음 정기 점검 ${when(data.sync.next_run)}`;
      $('reputation-overview').innerHTML=[['부정적 언급 후보',counts.concern,'최근 30일 감지 · 사실 확인 필요'],['대상·맥락 확인',counts.uncertain,'대상이나 의미가 불명확한 표현'],['분류한 공개 글',`${counts.reviewed} / ${counts.documents}`,'오늘 수집한 중복 제외 글'],['정상 확인 수집처',`${data.sync.checked_sources} / ${data.sync.expected_sources}`,'실패한 수집처는 완료로 세지 않음']].map(([title,value,description],i)=>`<article class="visibility-metric ${i===0&&counts.concern?'has-concern':!data.sync.complete?'is-pending':''}"><h2>${title}</h2><strong>${i<2&&!value&&!data.sync.complete?'미확인':value}</strong><p>${description}</p></article>`).join('');
      const message=$('reputation-status');message.textContent=headline(data)+(data.analysis.error?' · '+data.analysis.error:'')+(counts.documents>data.analysis.limit?` · 분류 상한 ${data.analysis.limit}개를 넘어 일부 글은 대기 중입니다.`:'');message.className='reputation-status'+(status.warning?' is-warning':counts.concern?' has-concern':'');
      $('reputation-sources').innerHTML=data.sources.map(source=>`<li><a href="${esc(safeUrl(source.url))}" target="_blank" rel="noopener noreferrer">${esc(source.name)}</a><span class="${!source.fresh?'is-warning':''}">${source.error?esc(source.error):source.fresh?`확인 ${esc(when(source.last_success))} · 관련 글 ${source.related}건`:source.running?'수집 중':'수집 대기'}</span></li>`).join('');
      $('reputation-documents').innerHTML=data.documents.map(item=>`<li><span><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a><span class="visibility-small">${esc(item.publisher)} · ${esc(item.basis)}</span></span><span class="visibility-tag ${item.verdict==='concern'||item.verdict==='uncertain'||item.verdict==='pending'?'is-warning':'is-absent'}">${esc(verdictName[item.verdict])}</span></li>`).join('')||'<li>현재 점검에서 저장된 관련 글이 없습니다.</li>';
      $('reputation-history').innerHTML=data.history.map(row=>`<tr><td>${esc(when(row.at))}</td><td>${row.documents}건</td><td>${row.concern}건</td><td>${row.uncertain}건</td></tr>`).join('')||'<tr><td colspan="4">전체 점검이 완료되면 기록됩니다.</td></tr>';
      drawList();
    }
    // Only acknowledge identities after the successful result has been rendered.
    tracker?.update(data.article_ids);
  }
  async function refresh(){
    if(loading)return;loading=true;
    try{const response=await fetch('/api/reputation-watch'+(home?'?summary=1':''),{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error();render(await response.json());}
    catch{if(home){home.textContent='평판 점검 결과 연결 확인 필요';home.classList.add('is-warning');$('home-reputation-badge').querySelector('span').textContent='연결 확인 필요';}else{$('reputation-status').textContent='점검 결과를 불러오지 못했습니다. 표시된 기록은 이전 조회 결과입니다.';$('reputation-status').className='reputation-status is-warning';}}
    finally{loading=false;}
  }
  if(list){$('reputation-refresh').addEventListener('click',refresh);['reputation-query','reputation-filter','reputation-branch'].forEach(id=>$(id).addEventListener(id.endsWith('query')?'input':'change',()=>{if(current)drawList();}));}
  refresh();setInterval(()=>{if(!document.hidden)refresh();},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
})(globalThis);
