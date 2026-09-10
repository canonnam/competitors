(function(root) {
  'use strict';
  function status(data, now = Date.now()) {
    if (!data?.sync) return {label:'연결 확인 필요', warning:true};
    if (!data.sync.enabled) return {label:'자동 수집 중지', warning:true};
    if (data.sync.errors?.length) return {label:'수집 지연', warning:true};
    if (!data.updated_at) return {label:'첫 수집 중', warning:true};
    if (data.sync.stale || (data.sync.next_run && now >= Date.parse(data.sync.next_run))) return {label:'갱신 대기', warning:true};
    return {label:'매일 갱신', warning:false};
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['www.longtermcare.or.kr','www.mohw.go.kr','www.bizinfo.go.kr'].includes(url.host) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function unreadSupport(data, readIds) {
    return (data.support?.items || []).filter(item=>item.active && item.preference!=='not_interested' && !readIds.has(item.id));
  }
  function filterItems(items, {source='', query='', onlyUnread=false, activeOnly=true, preference='recommended', readIds=new Set()}={}) {
    query=query.trim().toLocaleLowerCase();
    return items.filter(item=>{
      const support=item.kind==='support';
      return (!source || item.source_id===source || (source==='public-news'&&!support))
        && (preference==='all' || (preference==='recommended' ? (!support||item.preference!=='not_interested') : (support&&item.preference===preference)))
        && (!onlyUnread || (support&&item.application_status.active&&!readIds.has(item.id)))
        && (!activeOnly || !support || item.application_status.active)
        && (!query || [item.title,...item.topics,item.department,item.target||'',...(item.reasons||[])].join(' ').toLocaleLowerCase().includes(query));
    });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {status,safeUrl,unreadSupport,filterItems};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id), home = $('home-agency-meta'), list = $('agency-list');
  if (!home && !list) return;
  const newMark=root.NewsBadge?.create('agency',{badge:$('home-agency-new'),detail:!!list});
  const when = value => value ? new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '확인 중';
  const make = (tag,cls,text) => { const node=document.createElement(tag); if(cls)node.className=cls; if(text!==undefined)node.textContent=text; return node; };
  const readKey='vida-support-read-v1';
  let readIds=new Set();
  try {const saved=JSON.parse(localStorage.getItem(readKey)||'[]');if(Array.isArray(saved))readIds=new Set(saved.filter(id=>typeof id==='string'));}catch{}
  let current, visible=30, loading=false, onlyUnread=false, saving=false, revision=0;
  function drawStatus(data) {
    const state=status(data), checked=data.sources.filter(source=>source.last_success&&!source.error&&!source.stale).length, target=data.sources.length;
    const unread=unreadSupport(data,readIds).length;
    const supportSource=data.sources.find(source=>source.id==='bizinfo');
    const supportPending=!supportSource?.last_success;
    const supportDelayed=!!supportSource?.error;
    const badge=$('home-agency-badge');
    if(badge) {
      badge.classList.toggle('is-warning',state.warning);
      badge.querySelector('span').textContent=state.label;
      badge.title=`매일 오전 9시 10분 (한국시간) · ${checked}/${target}개 수집처 확인 완료`;
      badge.setAttribute('aria-label',badge.title);
      home.textContent=data.total ? `최근 글 ${data.latest_published_at} · 총 ${data.total}건` : '관련 새 글 수집 대기';
      $('home-agency-update').textContent=data.updated_at ? `수집 ${when(data.updated_at)} · ${state.label}` : `${state.label} · ${checked}/${target}개 수집처 확인`;
      $('home-agency-update').classList.toggle('is-warning',state.warning);
      if($('home-support-status')) {
        $('home-support-status').textContent=supportPending ? (supportDelayed?'지원사업 수집 지연':'지원사업 첫 수집 중') : (unread ? `새 지원사업 ${unread}건 · 콤파스원 검토 후보` : `지원사업 추천 ${data.support?.active||0}건 · 접수 여부 확인`);
        $('home-support-status').classList.toggle('has-new',unread>0);
      }
    }
    if($('agency-sync')) {
      $('agency-sync').classList.toggle('is-warning',state.warning);
      $('agency-sync').textContent=`매일 오전 9시 10분 (한국시간) · ${checked}/${target}개 수집처 확인 · ${data.updated_at ? '최근 전체 수집 '+when(data.updated_at) : state.label}` + (state.warning&&data.updated_at ? ' · '+state.label : '');
      $('agency-count').textContent=`총 ${data.total}건 · 공공기관 뉴스 최신순 · 지원사업 관심 반영 추천순`;
      const fragment=document.createDocumentFragment();
      for(const source of data.sources) {
        const row=make('li'), a=make('a','',source.agency+' · '+source.name);
        a.href=safeUrl(source.url);a.target='_blank';a.rel='noopener noreferrer';
        row.append(a,make('span',source.error||source.stale?'is-warning':'',source.error || (source.last_success ? `확인 ${when(source.last_success)}${source.stale?' · 갱신 대기':''}` : '첫 수집 대기')));
        fragment.append(row);
      }
      $('agency-sources').replaceChildren(fragment);
      $('support-alert-count').textContent=supportPending ? (supportDelayed?'지원사업 수집 지연':'지원사업 첫 수집 중') : (unread ? `새 지원사업 ${unread}건` : '새로 확인할 지원사업이 없습니다');
      $('support-alert-detail').textContent=(supportDelayed ? '수집 지연 · 기존 후보와 원문을 확인해주세요. ' : '')+`접수기간이 지나지 않은 후보 ${data.support?.active||0}건 · 신청 자격은 원문 조건 확인 필요`;
      $('support-show-new').disabled=!unread;
      $('support-mark-read').disabled=!unread;
    }
  }
  function drawList() {
    if(!list||!current)return;
    const source=$('agency-filter').value,query=$('agency-search').value;
    const items=filterItems(current.items,{source,query,onlyUnread,activeOnly:$('support-active-only').checked,preference:$('support-preference-filter').value,readIds});
    const fragment=document.createDocumentFragment();
    for(const item of items.slice(0,visible)) {
      const article=make('article','agency-item'), meta=make('div','agency-item-meta');
      const time=make('time','',item.published_at);time.dateTime=item.published_at;
      meta.append(time,make('span','',item.agency+' · '+item.source));
      if(item.pinned)meta.append(make('span','agency-pin','게시판 공지'));
      if(item.kind==='support') {
        article.classList.add('support-item');
        meta.append(make('span','support-match',item.recommendation));
        if(item.application_status.active&&item.preference!=='not_interested'&&!readIds.has(item.id))meta.append(make('span','support-new','새 공고'));
      }
      article.append(meta,make('h2','',item.title));
      const tags=make('div','agency-tags');item.topics.forEach(topic=>tags.append(make('span','',topic)));
      article.append(tags);
      if(item.kind==='support') {
        const period=make('p','support-period',`신청기간 · ${item.application_period} · ${item.application_status.label}`);
        if(item.application_status.days_left!==null&&item.application_status.active)period.append(make('strong','',` (D-${item.application_status.days_left})`));
        article.append(period);
        const reasons=make('ul','support-reasons');item.reasons.forEach(reason=>reasons.append(make('li','',reason)));article.append(reasons);
        const details=make('details','support-detail');details.append(make('summary','','지원 내용과 확인할 조건'));
        details.append(make('p','','공고상 대상 · '+item.target));
        if(item.benefit)details.append(make('p','','지원 내용 · '+item.benefit));
        const checks=make('ul','support-checks');item.checks.forEach(check=>checks.append(make('li','',check)));details.append(checks);article.append(details);
        const choices=make('div','support-interest');choices.setAttribute('role','group');choices.setAttribute('aria-label',item.title+' 관심 선택');
        for(const [value,label] of [['interested','관심있음'],['not_interested','관심없음']]) {
          const button=make('button','support-interest-button',label);button.type='button';
          button.dataset.articleId=item.id;button.dataset.preference=value;button.disabled=saving;
          button.setAttribute('aria-pressed',String(item.preference===value));
          button.title=item.preference===value?'다시 누르면 선택을 취소합니다.':label+'으로 선택하고 추천에 반영합니다.';
          button.addEventListener('click',()=>savePreference(item.id,item.preference===value?'neutral':value,value));choices.append(button);
        }
        article.append(choices);
        if(item.preference_reasons?.length)article.append(make('p','support-interest-reason',item.preference_reasons.join(' ')));
      }
      const footer=make('div','agency-item-footer');
      footer.append(make('span','',`${item.match_basis} 기준 선별 · 수집 ${when(item.collected_at)}`));
      const link=make('a','',item.kind==='support'?'지원사업 원문·공고문 확인 ↗':'원문·첨부파일 확인 ↗');link.href=safeUrl(item.url);link.target='_blank';link.rel='noopener noreferrer';footer.append(link);
      article.append(footer);fragment.append(article);
    }
    if(!items.length)fragment.append(make('p','agency-empty',current.total?'조건에 맞는 게시글이 없습니다.':'관련 게시글을 수집하면 여기에 표시됩니다. 아래 원문 게시판에서도 확인할 수 있습니다.'));
    list.replaceChildren(fragment);
    $('agency-visible').textContent=`${Math.min(visible,items.length)} / ${items.length}건 표시`;
    $('agency-more').hidden=visible>=items.length;
  }
  function render(data) {
    if(!data?.sync||!Array.isArray(data.sources)||!Number.isInteger(data.total)||(list&&!Array.isArray(data.items)))throw new Error('Invalid agency data');
    current=data;drawStatus(data);drawList();newMark?.update(data.article_ids);
  }
  async function loadReport() {
    const response=await fetch('/api/agency-news'+(list?'':'?summary=1'),{cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('Agency request failed');return response.json();
  }
  async function savePreference(id,preference,focusValue) {
    if(saving)return;saving=true;revision++;
    const message=$('support-feedback-status');message.textContent='관심 선택을 저장하고 있습니다.';
    list.querySelectorAll('[data-preference]').forEach(button=>{button.disabled=true;});
    let saved=false;
    try {
      const response=await fetch('/api/agency-news/support-preference',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({article_id:id,preference}),signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('Preference request failed');
      const result=await response.json();
      if(result.article_id!==id||result.preference!==preference)throw new Error('Invalid preference response');
      saved=true;
      // Keep the acknowledged choice visible even if the subsequent report refresh fails.
      const item=current.items.find(item=>item.id===id);item.preference=preference;item.preference_reasons=[];
      const summaryItem=current.support.items.find(item=>item.id===id);
      summaryItem.preference=preference;summaryItem.active=item.application_status.active&&preference!=='not_interested';
      current.support.active=current.support.items.filter(item=>item.active).length;
      current.article_ids=current.items.filter(item=>item.kind!=='support'||(item.application_status.active&&item.preference!=='not_interested')).map(item=>item.id);
      render(await loadReport());
      message.textContent=preference==='neutral'?'관심 선택을 취소하고 추천에 반영했습니다.':preference==='interested'
        ?'관심있음으로 저장했습니다. 해당 사업과 비슷한 분야의 추천 순위에 반영했습니다.'
        :'관심없음으로 저장했습니다. 기본 추천에서 숨겼으며, 관심없음 목록에서 취소할 수 있습니다.';
    } catch {
      message.textContent=saved?'관심 선택은 저장했습니다. 추천 목록을 갱신하지 못해 새로고침이 필요합니다.':'관심 선택의 저장을 확인하지 못했습니다. 잠시 후 다시 눌러주세요.';
    } finally {
      saving=false;drawStatus(current);drawList();newMark?.update(current.article_ids);
      const button=[...list.querySelectorAll('[data-preference]')].find(button=>button.dataset.articleId===id&&button.dataset.preference===focusValue);
      (button||message).focus({preventScroll:true});
    }
  }
  async function refresh() {
    if(loading||saving)return;loading=true;const started=revision;
    try {
      const data=await loadReport();if(started===revision)render(data);
    } catch {
      if(started!==revision)return;
      const message=$('agency-sync')||$('home-agency-update');message.textContent='연결 확인 필요 · 기존 자료와 원문 게시판을 확인해주세요.';message.classList.add('is-warning');
      const badge=$('home-agency-badge');if(badge){badge.querySelector('span').textContent='연결 확인 필요';badge.classList.add('is-warning');badge.title=message.textContent;badge.setAttribute('aria-label',message.textContent);}
    } finally {loading=false;}
  }
  ['agency-filter','agency-search','support-active-only','support-preference-filter'].forEach(id=>$(id)?.addEventListener(id==='agency-search'?'input':'change',()=>{visible=30;onlyUnread=false;if(id==='agency-filter')$('support-preference-filter').value='recommended';if(id==='support-preference-filter'&&['interested','not_interested'].includes($(id).value))$('agency-filter').value='bizinfo';drawList();}));
  $('support-show-new')?.addEventListener('click',()=>{onlyUnread=true;visible=30;$('agency-filter').value='bizinfo';$('support-preference-filter').value='recommended';$('agency-search').value='';drawList();list.scrollIntoView({behavior:'smooth',block:'start'});});
  $('support-show-all')?.addEventListener('click',()=>{onlyUnread=false;visible=30;$('agency-filter').value='bizinfo';$('support-preference-filter').value='all';$('agency-search').value='';drawList();});
  $('support-mark-read')?.addEventListener('click',()=>{
    if(!current)return;
    const next=new Set([...readIds,...unreadSupport(current,readIds).map(item=>item.id)]);
    try {localStorage.setItem(readKey,JSON.stringify([...next]));readIds=next;onlyUnread=false;drawStatus(current);drawList();$('support-read-status').textContent='이 브라우저에 확인 기록을 저장했습니다.';}
    catch {$('support-read-status').textContent='확인 기록을 저장하지 못했습니다. 브라우저 저장소 설정을 확인해주세요.';}
  });
  window.addEventListener('storage',event=>{if(event.key===readKey){try{const ids=JSON.parse(event.newValue||'[]');if(Array.isArray(ids)){readIds=new Set(ids.filter(id=>typeof id==='string'));if(current){drawStatus(current);drawList();}}}catch{}}});
  $('agency-more')?.addEventListener('click',()=>{visible+=30;drawList();});
  refresh();document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(()=>{if(!document.hidden)refresh();},300000);
})(globalThis);
