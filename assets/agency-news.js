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
        && (!query || [item.title,...item.topics,item.department,item.target||'',...(item.reasons||[]),item.research_focus?.label||'',item.research_focus?.reason||'',item.preference_feedback?.reason||''].join(' ').toLocaleLowerCase().includes(query));
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
  let current, visible=30, loading=false, onlyUnread=false, saving=false, revision=0, reasonTarget=null, reasonFocus=null;
  const reasonDialog=$('support-reason-dialog'), reasonForm=$('support-reason-form'), reasonInput=$('support-reason-input');
  const infoDialog=$('support-info-dialog'), infoTooltip=$('support-info-tooltip');
  let infoFocus=null, tooltipButton=null, tooltipTimer;
  function hideInfoTooltip() {
    clearTimeout(tooltipTimer);if(infoTooltip)infoTooltip.hidden=true;
    tooltipButton?.removeAttribute('aria-describedby');tooltipButton=null;
  }
  function showInfoTooltip(button) {
    if(infoDialog?.open)return;
    hideInfoTooltip();tooltipButton=button;infoTooltip.textContent=button.dataset.tooltip;infoTooltip.hidden=false;
    infoTooltip.style.left='12px';infoTooltip.style.top='0px';
    button.setAttribute('aria-describedby','support-info-tooltip');
    const rect=button.getBoundingClientRect(), width=infoTooltip.offsetWidth, height=infoTooltip.offsetHeight;
    infoTooltip.style.left=Math.max(12,Math.min(rect.left+rect.width/2-width/2,window.innerWidth-width-12))+'px';
    infoTooltip.style.top=(rect.bottom+height+20<window.innerHeight?rect.bottom+8:Math.max(12,rect.top-height-8))+'px';
  }
  function openSupportInfo(button) {
    const panel=[...infoDialog.querySelectorAll('[data-info-panel]')].find(panel=>panel.dataset.infoPanel===button.dataset.supportInfo);
    if(!panel)return;
    hideInfoTooltip();infoFocus=button;
    infoDialog.querySelectorAll('[data-info-panel]').forEach(section=>{section.hidden=section!==panel;});
    $('support-info-heading').textContent=panel.dataset.infoHeading;
    infoDialog.showModal();$('support-info-close').focus({preventScroll:true});
  }
  function showSupportList() {
    if(infoDialog?.open){infoFocus=null;infoDialog.close();}
    hideInfoTooltip();list.focus({preventScroll:true});list.scrollIntoView({behavior:'smooth',block:'start'});
  }
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
      if($('support-compact-new')) {
        $('support-compact-new').textContent=supportPending?(supportDelayed?'수집 지연':'확인 중'):`새 공고 ${unread}건`;
        $('support-compact-new').classList.toggle('has-new',unread>0);
        $('support-compact-new').classList.toggle('is-warning',supportDelayed);
        $('support-compact-active').textContent=supportPending?'':`추천 ${data.support?.active||0}건`;
        document.querySelector('[data-support-info="status"]').dataset.tooltip=supportPending?'지원사업을 수집하고 있습니다.':
          `${supportDelayed?'수집 지연 · ':''}새 공고 ${unread}건 · 접수기간이 지나지 않은 추천 ${data.support?.active||0}건`;
      }
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
        if(item.research_focus?.label)meta.append(make('span','support-research-match',item.research_focus.label));
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
        if(item.research_focus?.reason)reasons.append(make('li','',item.research_focus.reason));
        const details=make('details','support-detail');details.append(make('summary','','지원 내용과 확인할 조건'));
        details.append(make('p','','공고상 대상 · '+item.target));
        if(item.benefit)details.append(make('p','','지원 내용 · '+item.benefit));
        const checks=make('ul','support-checks');[...item.checks,...(item.research_focus?.checks||[])].forEach(check=>checks.append(make('li','',check)));details.append(checks);article.append(details);
        const choices=make('div','support-interest');choices.setAttribute('role','group');choices.setAttribute('aria-label',item.title+' 관심 선택');
        for(const [value,label] of [['interested','관심있음'],['not_interested','관심없음']]) {
          const button=make('button','support-interest-button',label);button.type='button';
          button.dataset.articleId=item.id;button.dataset.preference=value;button.disabled=saving;
          button.setAttribute('aria-pressed',String(item.preference===value));
          button.title=item.preference===value?'다시 누르면 선택을 취소합니다.':value==='not_interested'?'관심없는 이유를 입력하고 추천에 반영합니다.':label+'으로 선택하고 추천에 반영합니다.';
          button.addEventListener('click',()=>value==='not_interested'&&item.preference!==value
            ?openReason(item,button):savePreference(item.id,item.preference===value?'neutral':value,value));choices.append(button);
        }
        article.append(choices);
        if(item.preference==='not_interested') {
          const feedback=make('div','support-saved-feedback');feedback.append(make('strong','','관심없는 이유'));
          feedback.append(make('p','support-saved-reason',item.preference_feedback?.reason||'아직 입력한 이유가 없습니다.'));
          if(item.preference_feedback?.summary)feedback.append(make('p','support-reason-effect',item.preference_feedback.summary));
          const edit=make('button','support-reason-edit',item.preference_feedback?.reason?'이유 수정':'이유 추가');edit.type='button';edit.dataset.editReason=item.id;edit.disabled=saving;
          edit.addEventListener('click',()=>openReason(item,edit));feedback.append(edit);article.append(feedback);
        }
        if(item.preference_reasons?.length)article.append(make('p','support-interest-reason',item.preference_reasons.join(' ')));
      }
      const footer=make('div','agency-item-footer');
      footer.append(make('span','',`${item.match_basis} 기준 선별 · 수집 ${when(item.collected_at)}`));
      const link=make('a','',item.kind==='support'?'지원사업 원문·공고문 확인 ↗':'원문·첨부파일 확인 ↗');link.href=safeUrl(item.url);link.target='_blank';link.rel='noopener noreferrer';footer.append(link);
      if(item.kind==='support'&&item.preference==='interested') {
        const prepare=make('a','support-prepare-link','신청 준비 · 양식·초안');
        prepare.href='/support-prep.html#case='+encodeURIComponent(item.id);footer.append(prepare);
      }
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
  function openReason(item,button) {
    if(saving||!reasonDialog)return;
    reasonTarget=item.id;reasonFocus=button;revision++;
    $('support-reason-title').textContent=item.title;
    reasonInput.value=item.preference_feedback?.reason||'';reasonInput.setCustomValidity('');
    $('support-reason-error').textContent='';updateReasonCount();
    reasonDialog.showModal();reasonInput.focus();
  }
  function updateReasonCount() {
    if(reasonInput)$('support-reason-count').textContent=`${[...reasonInput.value].length} / 500자`;
  }
  async function savePreference(id,preference,focusValue,reason='') {
    if(saving)return;saving=true;revision++;
    const message=$('support-feedback-status');message.textContent='관심 선택을 저장하고 있습니다.';
    list.querySelectorAll('[data-preference],[data-edit-reason]').forEach(button=>{button.disabled=true;});
    if(reasonDialog?.open){$('support-reason-error').textContent=message.textContent;[...reasonForm.elements].forEach(field=>{field.disabled=true;});}
    let saved=false;
    try {
      const response=await fetch('/api/agency-news/support-preference',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({article_id:id,preference,reason}),signal:AbortSignal.timeout(20000)});
      if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||'관심 선택을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');}
      const result=await response.json();
      if(result.article_id!==id||result.preference!==preference)throw new Error('Invalid preference response');
      saved=true;
      // Keep the acknowledged choice visible even if the subsequent report refresh fails.
      const item=current.items.find(item=>item.id===id);item.preference=preference;item.preference_reasons=[];item.preference_feedback=result.feedback||{reason,summary:''};
      const summaryItem=current.support.items.find(item=>item.id===id);
      summaryItem.preference=preference;summaryItem.active=item.application_status.active&&preference!=='not_interested';
      current.support.active=current.support.items.filter(item=>item.active).length;
      current.article_ids=current.items.filter(item=>item.kind!=='support'||(item.application_status.active&&item.preference!=='not_interested')).map(item=>item.id);
      render(await loadReport());
      const effect=result.feedback?.summary||'추천에 반영했습니다.';
      message.textContent=preference==='neutral'?'관심 선택을 취소하고 추천에 반영했습니다.':preference==='interested'
        ?'관심있음으로 저장했습니다. 양식을 자동 수집합니다. 신청 준비에서 원본을 받고 초안을 만들 수 있습니다.'
        :'관심없음과 이유를 저장했습니다. '+effect+(effect.endsWith('.')?'':'.')+' 관심없음 목록에서 이유를 수정하거나 선택을 취소할 수 있습니다.';
    } catch(error) {
      message.textContent=saved?'관심 선택과 이유는 저장했습니다. 추천 목록을 갱신하지 못해 새로고침이 필요합니다.':
        (error.name==='Error'?error.message:'관심 선택의 저장을 확인하지 못했습니다. 입력한 이유를 유지했으니 다시 저장해주세요.');
    } finally {
      saving=false;drawStatus(current);drawList();newMark?.update(current.article_ids);
      if(reasonDialog?.open) {
        [...reasonForm.elements].forEach(field=>{field.disabled=false;});
        if(saved){reasonFocus=null;reasonDialog.close();reasonTarget=null;}
        else{$('support-reason-error').textContent=message.textContent;reasonInput.focus();return;}
      }
      const button=[...list.querySelectorAll('[data-preference]')].find(button=>button.dataset.articleId===id&&button.dataset.preference===focusValue);
      (button||message).focus({preventScroll:true});
    }
  }
  async function refresh() {
    if(loading||saving||reasonDialog?.open)return;loading=true;const started=revision;
    try {
      const data=await loadReport();if(started===revision)render(data);
    } catch {
      if(started!==revision)return;
      const message=$('agency-sync')||$('home-agency-update');message.textContent='연결 확인 필요 · 기존 자료와 원문 게시판을 확인해주세요.';message.classList.add('is-warning');
      const badge=$('home-agency-badge');if(badge){badge.querySelector('span').textContent='연결 확인 필요';badge.classList.add('is-warning');badge.title=message.textContent;badge.setAttribute('aria-label',message.textContent);}
    } finally {loading=false;}
  }
  reasonInput?.addEventListener('input',()=>{reasonInput.setCustomValidity('');updateReasonCount();});
  reasonForm?.addEventListener('submit',event=>{
    event.preventDefault();if(saving||!reasonTarget)return;
    const reason=reasonInput.value.trim();
    if(!reason){reasonInput.setCustomValidity('관심없는 이유를 입력해주세요.');reasonInput.reportValidity();return;}
    savePreference(reasonTarget,'not_interested','not_interested',reason);
  });
  reasonForm?.querySelectorAll('[data-reason-suggestion]').forEach(button=>button.addEventListener('click',()=>{
    // Suggestions are editable examples, never silent additional preferences.
    reasonInput.value=button.dataset.reasonSuggestion;reasonInput.setCustomValidity('');updateReasonCount();reasonInput.focus();
  }));
  $('support-reason-cancel')?.addEventListener('click',()=>{if(!saving)reasonDialog.close();});
  reasonDialog?.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  reasonDialog?.addEventListener('close',()=>{reasonTarget=null;if(reasonFocus?.isConnected)reasonFocus.focus({preventScroll:true});reasonFocus=null;});
  document.querySelectorAll('[data-support-info]').forEach(button=>{
    button.addEventListener('click',()=>openSupportInfo(button));
    button.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')showInfoTooltip(button);});
    button.addEventListener('pointerleave',()=>{tooltipTimer=setTimeout(hideInfoTooltip,150);});
    button.addEventListener('focus',()=>showInfoTooltip(button));
    button.addEventListener('blur',hideInfoTooltip);
  });
  infoTooltip?.addEventListener('pointerenter',()=>clearTimeout(tooltipTimer));
  infoTooltip?.addEventListener('pointerleave',hideInfoTooltip);
  $('support-info-close')?.addEventListener('click',()=>infoDialog.close());
  infoDialog?.addEventListener('close',()=>{if(infoFocus?.isConnected)infoFocus.focus({preventScroll:true});infoFocus=null;});
  infoDialog?.addEventListener('click',event=>{
    const rect=infoDialog.getBoundingClientRect();
    if(event.target===infoDialog&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))infoDialog.close();
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hideInfoTooltip();});
  window.addEventListener('scroll',hideInfoTooltip,{capture:true,passive:true});window.addEventListener('resize',hideInfoTooltip);
  ['agency-filter','agency-search','support-active-only','support-preference-filter'].forEach(id=>$(id)?.addEventListener(id==='agency-search'?'input':'change',()=>{visible=30;onlyUnread=false;if(id==='agency-filter')$('support-preference-filter').value='recommended';if(id==='support-preference-filter'&&['interested','not_interested'].includes($(id).value))$('agency-filter').value='bizinfo';drawList();}));
  $('support-show-new')?.addEventListener('click',()=>{onlyUnread=true;visible=30;$('agency-filter').value='bizinfo';$('support-preference-filter').value='recommended';$('agency-search').value='';drawList();showSupportList();});
  $('support-show-all')?.addEventListener('click',()=>{onlyUnread=false;visible=30;$('agency-filter').value='bizinfo';$('support-preference-filter').value='all';$('agency-search').value='';drawList();showSupportList();});
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
