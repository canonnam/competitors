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
      return url.protocol === 'https:' && ['www.longtermcare.or.kr','www.mohw.go.kr'].includes(url.host) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {status,safeUrl};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id), home = $('home-agency-meta'), list = $('agency-list');
  if (!home && !list) return;
  const when = value => value ? new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '확인 중';
  const make = (tag,cls,text) => { const node=document.createElement(tag); if(cls)node.className=cls; if(text!==undefined)node.textContent=text; return node; };
  let current, visible=30, loading=false;
  function drawStatus(data) {
    const state=status(data), checked=data.sources.filter(source=>source.last_success&&!source.error&&!source.stale).length;
    const badge=$('home-agency-badge');
    if(badge) {
      badge.classList.toggle('is-warning',state.warning);
      badge.querySelector('span').textContent=state.label;
      badge.title=`매일 오전 9시 10분 (한국시간) · ${checked}/9개 게시판 확인 완료`;
      badge.setAttribute('aria-label',badge.title);
      home.textContent=data.total ? `최근 글 ${data.latest_published_at} · 총 ${data.total}건` : '관련 새 글 수집 대기';
      $('home-agency-update').textContent=data.updated_at ? `수집 ${when(data.updated_at)} · ${state.label}` : `${state.label} · ${checked}/9개 게시판 확인`;
      $('home-agency-update').classList.toggle('is-warning',state.warning);
    }
    if($('agency-sync')) {
      $('agency-sync').classList.toggle('is-warning',state.warning);
      $('agency-sync').textContent=`매일 오전 9시 10분 (한국시간) · ${checked}/9개 게시판 확인 · ${data.updated_at ? '최근 전체 수집 '+when(data.updated_at) : state.label}` + (state.warning&&data.updated_at ? ' · '+state.label : '');
      $('agency-count').textContent=`총 ${data.total}건 · 게시일 내림차순`;
      const fragment=document.createDocumentFragment();
      for(const source of data.sources) {
        const row=make('li'), a=make('a','',source.agency+' · '+source.name);
        a.href=safeUrl(source.url);a.target='_blank';a.rel='noopener noreferrer';
        row.append(a,make('span',source.error||source.stale?'is-warning':'',source.error || (source.last_success ? `확인 ${when(source.last_success)}${source.stale?' · 갱신 대기':''}` : '첫 수집 대기')));
        fragment.append(row);
      }
      $('agency-sources').replaceChildren(fragment);
    }
  }
  function drawList() {
    if(!list||!current)return;
    const source=$('agency-filter').value,query=$('agency-search').value.trim().toLocaleLowerCase();
    const items=current.items.filter(item=>(!source||item.source_id===source)&&(!query||(item.title+' '+item.topics.join(' ')+' '+item.department).toLocaleLowerCase().includes(query)));
    const fragment=document.createDocumentFragment();
    for(const item of items.slice(0,visible)) {
      const article=make('article','agency-item'), meta=make('div','agency-item-meta');
      const time=make('time','',item.published_at);time.dateTime=item.published_at;
      meta.append(time,make('span','',item.agency+' · '+item.source));
      if(item.pinned)meta.append(make('span','agency-pin','게시판 공지'));
      article.append(meta,make('h2','',item.title));
      const tags=make('div','agency-tags');item.topics.forEach(topic=>tags.append(make('span','',topic)));
      const footer=make('div','agency-item-footer');
      footer.append(make('span','',`${item.match_basis} 기준 선별 · 수집 ${when(item.collected_at)}`));
      const link=make('a','','원문·첨부파일 확인 ↗');link.href=safeUrl(item.url);link.target='_blank';link.rel='noopener noreferrer';footer.append(link);
      article.append(tags,footer);fragment.append(article);
    }
    if(!items.length)fragment.append(make('p','agency-empty',current.total?'조건에 맞는 게시글이 없습니다.':'관련 게시글을 수집하면 여기에 표시됩니다. 아래 원문 게시판에서도 확인할 수 있습니다.'));
    list.replaceChildren(fragment);
    $('agency-visible').textContent=`${Math.min(visible,items.length)} / ${items.length}건 표시`;
    $('agency-more').hidden=visible>=items.length;
  }
  function render(data) {
    if(!data?.sync||!Array.isArray(data.sources)||!Number.isInteger(data.total)||(list&&!Array.isArray(data.items)))throw new Error('Invalid agency data');
    current=data;drawStatus(data);drawList();
  }
  async function refresh() {
    if(loading)return;loading=true;
    try {
      const response=await fetch('/api/agency-news'+(list?'':'?summary=1'),{cache:'no-store',signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('Agency request failed');render(await response.json());
    } catch {
      const message=$('agency-sync')||$('home-agency-update');message.textContent='연결 확인 필요 · 기존 자료와 원문 게시판을 확인해주세요.';message.classList.add('is-warning');
      const badge=$('home-agency-badge');if(badge){badge.querySelector('span').textContent='연결 확인 필요';badge.classList.add('is-warning');badge.title=message.textContent;badge.setAttribute('aria-label',message.textContent);}
    } finally {loading=false;}
  }
  ['agency-filter','agency-search'].forEach(id=>$(id)?.addEventListener(id==='agency-search'?'input':'change',()=>{visible=30;drawList();}));
  $('agency-more')?.addEventListener('click',()=>{visible+=30;drawList();});
  refresh();document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(()=>{if(!document.hidden)refresh();},300000);
})(globalThis);
