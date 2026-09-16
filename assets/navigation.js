/* Shared feature directory and browser-local navigation preferences. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) api.mount(root);
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const categories = [
    {id:'operations', title:'운영·인사·회계'},
    {id:'marketing', title:'홍보·상담·영업'},
    {id:'support', title:'정책·지원사업'},
    {id:'market', title:'시장·경쟁'},
    {id:'research', title:'자료·AI'}
  ];
  const features = [
    {id:'support-projects', category:'support', title:'지원사업 준비·기록', description:'지원 조건·준비 현황·컨소시엄·예산 관리', keywords:'정부 과제 AX 실증밸리 공모 멀티모달'},
    {id:'website-requests', category:'marketing', title:'상담·무료체험 신청', description:'방문상담·무료체험 접수와 담당자 메모', keywords:'고객 문의 홈페이지 영업 리드'},
    {id:'payroll', category:'operations', title:'급여 계산·근로계약서', description:'근무조건별 급여 계산과 계약서 작성', keywords:'월급 인건비 직원 채용 인사 노무 PDF'},
    {id:'claim-check', category:'operations', title:'지점별 청구 점검', description:'급여 청구 여부와 처리상태 확인', keywords:'공단 장기근속장려금 접수 안양 인천'},
    {id:'competitors', category:'market', title:'경쟁사 분석', description:'ERP·AI·디지털 돌봄 서비스 비교', keywords:'시장 기능 가격 운영 모델'},
    {id:'competitor-news', category:'market', title:'경쟁사 및 요양원 뉴스', description:'업계 소식과 사건·안전·정책 기사', keywords:'경쟁 뉴스 낙상 제도 사고'},
    {id:'agency-news', category:'support', title:'건보공단·복지부 뉴스·지원사업', description:'공공기관 소식과 지원사업 공고', keywords:'정부 정책 공모 장기요양 제도'},
    {id:'ai-hub-data', category:'research', title:'AI 허브 활용데이터', description:'요양원 ERP와 연결할 데이터셋·활용안', keywords:'AI Hub 인공지능 연구 건강 간호'},
    {id:'naver-ads', category:'marketing', title:'네이버 광고분석', description:'월별 광고 추이와 소재별 성과', keywords:'마케팅 파워링크 플레이스 광고비 인천'},
    {id:'search-visibility', category:'marketing', title:'검색노출 현황', description:'네이버·ChatGPT·Gemini 검색노출 확인', keywords:'SEO AEO GEO 안양 인천 홍보'},
    {id:'reputation-watch', category:'marketing', title:'평판 점검', description:'공개 뉴스·검색의 부정적 언급 확인', keywords:'불만 리뷰 안양 인천'},
    {id:'operating-costs', category:'operations', title:'운영비 분석', description:'지점별 월별 수입·비용과 자금 흐름', keywords:'안양 인천 손익 매출 지출 회계'},
    {id:'nearby-facilities', category:'marketing', title:'주변 영업처 지도', description:'지점 주변 기관의 거리와 연락처', keywords:'안양 인천 요양병원 경로당 주야간보호 영업'},
    {id:'statistics', category:'research', title:'통계자료', description:'통계 문서와 표·그래프 책갈피', keywords:'입소 상담 돌봄 품질 직원 근무환경 연구'}
  ].map(item => ({...item, href:'/' + item.id + '.html'}));
  const key = 'vida-navigation-v1';
  const ids = new Set(features.map(item => item.id));
  const cleanIds = value => Array.isArray(value) ? [...new Set(value.filter(id => ids.has(id)))].slice(0, features.length) : [];
  const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
  function matchFeatures(query = '', category = 'all', favorites = []) {
    const terms = String(query).trim().split(/\s+/).filter(Boolean).map(normalize);
    return features.filter(item => {
      const label = categories.find(group => group.id === item.category).title;
      return (category === 'all' || (category === 'favorites' ? favorites.includes(item.id) : category === item.category)) &&
        terms.every(term => normalize(['더비다요양원', item.title, item.description, item.keywords, label].join(' ')).includes(term));
    });
  }
  function createPreferences(storage) {
    let state = {favorites:[], view:'list'};
    function read() {
      try {
        const saved = JSON.parse(storage.getItem(key));
        if (saved && typeof saved === 'object') {
          state = {favorites:cleanIds(saved.favorites), view:saved.layoutVersion===2&&saved.view==='cards'?'cards':'list'};
          if(saved.layoutVersion!==2||'recent' in saved)save();
        } else state = {favorites:[], view:'list'};
      } catch { /* Keep usable in-memory preferences when storage is blocked. */ }
    }
    function save() { try { storage.setItem(key, JSON.stringify({...state,layoutVersion:2})); } catch { /* Device-local storage is optional. */ } }
    read();
    return {
      get:() => ({...state, favorites:[...state.favorites]}),
      reload:read,
      toggle(id) { if (!ids.has(id)) return; state.favorites = state.favorites.includes(id) ? state.favorites.filter(value => value !== id) : [...state.favorites,id]; save(); },
      move(id, delta) { const index=state.favorites.indexOf(id), next=index+delta; if (index<0 || next<0 || next>=state.favorites.length) return; [state.favorites[index],state.favorites[next]]=[state.favorites[next],state.favorites[index]]; save(); },
      view(value) { state.view=value==='list'?'list':'cards'; save(); }
    };
  }
  function mount(win) {
    const doc = win.document;
    if (doc.body.dataset.shared === 'true' || doc.getElementById('kb-navigation')) return;
    const main = doc.querySelector('body > main');
    const header = doc.querySelector('body > header');
    if (!main || !header) return;
    let storage;
    try { storage=win.localStorage; } catch { storage=null; }
    const preferences=createPreferences(storage);
    const home=doc.body.classList.contains('kb-homepage');
    const current=features.find(item=>item.href===win.location.pathname);
    const params=new URLSearchParams(win.location.search);
    const allowedCategories=new Set(['all','favorites',...categories.map(item=>item.id)]);
    let category=allowedCategories.has(params.get('category'))?params.get('category'):'all';
    let query=home?(params.get('q')||''):'';
    let editing=false;
    const el=(tag, className, text)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
    const button=(text,className)=>{const node=el('button',className,text);node.type='button';return node;};
    const link=(item,className)=>{const node=el('a',className,item.title);node.href=item.href;if(current?.id===item.id)node.setAttribute('aria-current','page');return node;};
    const icon=(id)=>{const image=el('img','kb-clay-icon');image.src='/assets/icons/clay/'+id+'.png';image.alt='';image.width=32;image.height=32;image.setAttribute('aria-hidden','true');return image;};
    const feedItems={competitor:'competitor-news',agency:'agency-news',reputation:'reputation-watch'};
    let newsCounts=win.NewsBadge?.counts()||{};
    function countFor(id){
      const members=id==='all'?features:id==='favorites'?features.filter(item=>preferences.get().favorites.includes(item.id)):features.filter(item=>item.category===id||item.id===id);
      return Object.entries(feedItems).reduce((sum,[feed,itemId])=>sum+(members.some(item=>item.id===itemId)?newsCounts[feed]||0:0),0);
    }
    function newMark(id){const mark=el('span','news-new-mark kb-new-mark','N');mark.dataset.kbUnread=id;mark.hidden=true;return mark;}
    function syncNewsMarkers(counts=newsCounts){
      newsCounts=counts;
      doc.querySelectorAll('[data-kb-unread]').forEach(mark=>{const count=countFor(mark.dataset.kbUnread);mark.hidden=count===0;mark.setAttribute('aria-label','새 글 '+count+'건');mark.title='새 글 '+count+'건';});
      dialogFilters.querySelectorAll('option').forEach(option=>{const group=[{id:'all',title:'전체 업무'},{id:'favorites',title:'즐겨찾기'},...categories].find(item=>item.id===option.value);option.textContent=group.title+(countFor(group.id)?' · N':'');});
    }
    doc.body.classList.add('kb-navigable');
    main.id ||= 'kb-main-content';
    const skip=el('a','kb-skip','본문으로 건너뛰기');skip.href='#'+main.id;doc.body.prepend(skip);
    const sidebar=el('aside','kb-sidebar');sidebar.id='kb-navigation';sidebar.setAttribute('aria-label','업무별 메뉴');header.after(sidebar);
    if(typeof win.ResizeObserver==='function') {
      const observer=new win.ResizeObserver(()=>doc.body.style.setProperty('--kb-header-height',header.getBoundingClientRect().height+'px'));
      observer.observe(header);
    }
    const homeLink=el('a','kb-sidebar-home','지식 창고 홈');homeLink.href='/';sidebar.append(homeLink);
    const nav=el('nav','kb-feature-nav');nav.setAttribute('aria-label','업무별 기능');sidebar.append(nav);
    const status=el('p','kb-sr-only');status.setAttribute('role','status');doc.body.append(status);

    // A native modal provides focus trapping, Escape and focus restoration on all pages.
    const dialog=el('dialog','kb-feature-dialog');dialog.id='kb-feature-dialog';dialog.setAttribute('aria-labelledby','kb-feature-dialog-title');
    const dialogHead=el('div','kb-feature-dialog-head');const dialogTitle=el('h2','', '기능 찾기');dialogTitle.id='kb-feature-dialog-title';
    const close=button('닫기','kb-control');close.addEventListener('click',()=>dialog.close());dialogHead.append(dialogTitle,close);
    const dialogSearch=el('input','kb-search-input');dialogSearch.type='search';dialogSearch.placeholder='급여, 손익, 네이버…';dialogSearch.setAttribute('aria-label','전체 기능 검색');
    const dialogFilters=el('select','kb-category-select');dialogFilters.setAttribute('aria-label','검색할 업무');
    [{id:'all',title:'전체 업무'},{id:'favorites',title:'즐겨찾기'},...categories].forEach(item=>{const option=el('option','',item.title);option.value=item.id;dialogFilters.append(option);});
    const dialogCount=el('p','kb-search-count');dialogCount.setAttribute('role','status');
    const dialogResults=el('div','kb-dialog-results');dialog.append(dialogHead,dialogSearch,dialogFilters,dialogCount,dialogResults);doc.body.append(dialog);
    function renderDialog() {
      const matches=matchFeatures(dialogSearch.value,dialogFilters.value,preferences.get().favorites);
      dialogCount.textContent=matches.length+'개 기능';dialogResults.replaceChildren();
      matches.forEach(item=>{const row=link(item,'kb-dialog-result');row.replaceChildren(icon(item.category),el('span','kb-dialog-copy'));const copy=row.lastChild;copy.append(el('span','kb-dialog-name',item.title),el('span','kb-dialog-description',item.description));row.append(newMark(item.id));dialogResults.append(row);});
      if(!matches.length)dialogResults.append(el('p','kb-empty','검색 결과가 없습니다. 다른 검색어나 업무를 선택해 주세요.'));
      syncNewsMarkers();
    }
    function openDialog() {if(dialog.open)return;dialogSearch.value='';dialogFilters.value='all';renderDialog();dialog.showModal();dialogSearch.focus();}
    const open=button('기능 찾기','kb-search-trigger');open.setAttribute('aria-haspopup','dialog');open.setAttribute('aria-controls',dialog.id);open.addEventListener('click',openDialog);
    open.append(newMark('all'));
    const actions=header.querySelector('.kb-actions')||header.querySelector('nav')||header;actions.append(open);
    dialogSearch.addEventListener('input',renderDialog);dialogFilters.addEventListener('change',renderDialog);
    dialogSearch.addEventListener('keydown',event=>{if(event.key==='Enter'){const first=dialogResults.querySelector('a');if(first){event.preventDefault();first.click();}}if(event.key==='ArrowDown'){event.preventDefault();dialogResults.querySelector('a')?.focus();}});
    dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
    doc.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&!doc.querySelector('dialog[open], .modal.open')){event.preventDefault();openDialog();}});

    let homeSearch, mobileMenu, mobileSummary, mobileNav, favoritesSection, favoriteRows, editButton, resultCount, resultTitle, resultIcon, empty, grid;
    const cards=new Map();
    if(home) {
      grid=main.querySelector('.grid');
      const lead=main.querySelector('.lead');
      lead?.querySelector('.eyebrow')?.remove();
      if(lead?.querySelector('p'))lead.querySelector('p').textContent='필요한 업무를 검색하거나 즐겨찾기에서 바로 시작하세요.';
      const tools=el('section','kb-home-tools');tools.setAttribute('aria-label','기능 탐색');
      const searchLabel=el('label','kb-search-label','기능 검색');searchLabel.htmlFor='kb-home-search';
      homeSearch=el('input','kb-search-input');homeSearch.id='kb-home-search';homeSearch.type='search';homeSearch.placeholder='급여, 손익, 네이버…';homeSearch.value=query;
      mobileMenu=el('details','kb-mobile-menu');mobileSummary=el('summary');mobileNav=el('nav','kb-mobile-categories');mobileNav.setAttribute('aria-label','모바일 업무별 기능');mobileMenu.append(mobileSummary,mobileNav);
      tools.append(searchLabel,homeSearch,mobileMenu);
      favoritesSection=el('section','kb-shortcut-section');favoritesSection.setAttribute('aria-label','저장한 기능');
      const favoriteHead=el('div','kb-section-head');
      editButton=button('순서 편집','kb-text-button');editButton.setAttribute('aria-pressed','false');editButton.addEventListener('click',()=>{editing=!editing;render();});favoriteHead.append(editButton);
      favoriteRows=el('div','kb-shortcuts');favoritesSection.append(favoriteRows,favoriteHead);
      const toolbar=el('div','kb-results-toolbar');const heading=el('h2');resultIcon=icon('all');resultTitle=el('span');resultCount=el('span','kb-result-count');resultCount.setAttribute('role','status');heading.append(resultIcon,resultTitle,resultCount);
      const views=el('div','kb-view-controls');views.setAttribute('aria-label','표시 방식');['cards','list'].forEach(view=>{const control=button(view==='cards'?'카드':'목록','kb-control');control.dataset.kbView=view;control.addEventListener('click',()=>{preferences.view(view);render();});views.append(control);});toolbar.append(heading,views);
      grid.before(tools,favoritesSection,toolbar);
      empty=el('div','kb-empty');empty.hidden=true;const emptyText=el('p','', '검색 결과가 없습니다. 검색어나 선택한 업무를 확인해 주세요.');
      const reset=button('전체 기능 보기','kb-control');reset.addEventListener('click',()=>{category='all';query='';homeSearch.value='';updateHomeURL();render();homeSearch.focus();});empty.append(emptyText,reset);grid.after(empty);
      grid.querySelectorAll(':scope > article').forEach(card=>{
        const item=features.find(feature=>card.querySelector('a[href="'+feature.href+'"]'));
        if(!item)return;cards.set(item.id,card);card.classList.add('kb-feature-card');card.dataset.kbFeature=item.id;
        const heading=card.querySelector('h2'),titleLink=link(item,'kb-feature-title');titleLink.replaceChildren(icon(item.category),el('span','kb-feature-name',item.title));heading.replaceChildren(titleLink);
        const description=card.querySelector(':scope > p');if(description)description.textContent=item.description;
        const content=el('div','kb-card-content');content.append(heading);if(description)content.append(description);content.append(el('span','kb-card-category',categories.find(group=>group.id===item.category).title));
        const live=el('div','kb-card-status');live.hidden=true;
        // Move, never clone, live status nodes so existing collectors retain their IDs.
        [...card.children].forEach(node=>{
          if(node.classList.contains('icon')||node.tagName==='A')node.remove();
          else if(node.classList.contains('card-topline')){const badge=node.querySelector('.card-update-badge');if(badge)live.append(badge);node.remove();}
          else if(node.classList.contains('card-heading')){[...node.children].forEach(child=>live.append(child));node.remove();}
          else live.append(node);
        });
        const originalMark=live.querySelector('.news-new-mark');if(originalMark){originalMark.classList.add('kb-new-mark');heading.append(originalMark);}
        const pin=button('','kb-favorite-button');pin.append(icon('favorites'));pin.dataset.kbPin=item.id;pin.addEventListener('click',()=>{preferences.toggle(item.id);render();status.textContent=item.title+(preferences.get().favorites.includes(item.id)?' 즐겨찾기에 추가했습니다.':' 즐겨찾기에서 해제했습니다.');if(!card.hidden)pin.focus();else homeSearch.focus();});
        const summary=el('div','kb-card-summary');summary.setAttribute('role','status');
        card.append(content,summary,live,pin);
        function summarize(){
          const text=id=>doc.getElementById(id)?.textContent.trim().replace(/\s+/g,' ')||'';
          let value='';
          if(item.id==='claim-check')value=text('home-claim-status');
          else if(item.id==='competitor-news')value=text('home-news-update').includes('확인 중')?'뉴스 갱신 중':text('home-news-badge');
          else if(item.id==='agency-news')value=text('home-support-status').split(' · ')[0];
          else if(item.id==='naver-ads')value=text('home-keyword-status');
          else if(item.id==='search-visibility')value=/불가|실패|확인 필요/.test(text('home-visibility-status'))?'검색노출 확인 필요':text('home-visibility-next').replace(/\s*\(한국시간\)/,'');
          else if(item.id==='reputation-watch'){const state=text('home-reputation-status');value=/찾지 못했습니다/.test(state)?'부정적 언급 후보 없음':state;}
          summary.textContent=value;summary.title=value;summary.hidden=!value;
          summary.classList.toggle('is-warning',/필요|실패|지연|불가/.test(value));
        }
        if(typeof win.MutationObserver==='function')new win.MutationObserver(summarize).observe(live,{subtree:true,childList:true,characterData:true});
        summarize();
      });
      homeSearch.addEventListener('input',()=>{query=homeSearch.value;updateHomeURL();renderCards();});
    }
    function updateHomeURL() {
      const url=new URL(win.location.href);
      query?url.searchParams.set('q',query):url.searchParams.delete('q');
      category==='all'?url.searchParams.delete('category'):url.searchParams.set('category',category);
      win.history.replaceState(null,'',url.pathname+url.search+url.hash);
    }
    function renderNav() {
      const focused=doc.activeElement?.dataset.kbCategory;
      nav.replaceChildren();
      if(home) {
        mobileNav.replaceChildren();
        [{id:'all',title:'전체 기능'},{id:'favorites',title:'즐겨찾기'},...categories].forEach(group=>{
          [nav,mobileNav].forEach(target=>{
            const control=button('','kb-category-button');control.dataset.kbCategory=group.id;control.setAttribute('aria-pressed',String(category===group.id));
            control.append(icon(group.id),el('span','kb-category-label',group.title),newMark(group.id),el('span','kb-category-count',String(matchFeatures('',group.id,preferences.get().favorites).length)));
            control.addEventListener('click',()=>{category=group.id;updateHomeURL();mobileMenu.open=false;render();if(target===mobileNav)mobileSummary.focus();});target.append(control);
          });
          if(category===group.id){mobileSummary.replaceChildren(icon(group.id),el('span','kb-category-label',group.title),newMark('all'),el('span','kb-menu-chevron','⌄'));}
        });
        if(focused)nav.querySelector('[data-kb-category="'+focused+'"]')?.focus();
      } else {
        const pinned=preferences.get().favorites;
        const navLink=item=>{const anchor=link(item,'kb-nav-link');anchor.append(newMark(item.id));return anchor;};
        if(pinned.length){const group=el('div','kb-nav-group'),title=el('p');title.append(icon('favorites'),el('span','','즐겨찾기'),newMark('favorites'));group.append(title);pinned.forEach(id=>group.append(navLink(features.find(item=>item.id===id))));nav.append(group);}
        categories.forEach(category=>{const group=el('details','kb-nav-group');group.open=current?.category===category.id||(!current&&category.id==='operations');const summary=el('summary');summary.append(icon(category.id),el('span','kb-category-label',category.title),newMark(category.id));group.append(summary);features.filter(item=>item.category===category.id).forEach(item=>group.append(navLink(item)));nav.append(group);});
      }
    }
    function renderCards() {
      if(!home)return;
      const saved=preferences.get();const matches=matchFeatures(query,category,saved.favorites);const matching=new Set(matches.map(item=>item.id));
      cards.forEach((card,id)=>{card.hidden=!matching.has(id);const pin=card.querySelector('[data-kb-pin]');const item=features.find(item=>item.id===id);const active=saved.favorites.includes(id);pin.setAttribute('aria-pressed',String(active));pin.setAttribute('aria-label',item.title+' 즐겨찾기 '+(active?'해제':'추가'));});
      grid.classList.toggle('kb-list-view',saved.view==='list');
      resultTitle.textContent=category==='all'?'전체 기능':category==='favorites'?'즐겨찾기':categories.find(group=>group.id===category).title;
      resultIcon.src='/assets/icons/clay/'+category+'.png';
      resultCount.textContent=matches.length+'개';empty.hidden=matches.length>0;
      doc.querySelectorAll('[data-kb-view]').forEach(control=>control.setAttribute('aria-pressed',String(control.dataset.kbView===saved.view)));
    }
    function renderShortcuts() {
      if(!home)return;
      const saved=preferences.get();favoriteRows.replaceChildren();
      favoritesSection.hidden=!saved.favorites.length;
      editButton.hidden=saved.favorites.length<2;editButton.textContent=editing?'편집 완료':'순서 편집';editButton.setAttribute('aria-pressed',String(editing));
      saved.favorites.forEach((id,index)=>{const item=features.find(item=>item.id===id);const row=el('div','kb-shortcut');row.append(link(item,''));if(editing){[-1,1].forEach(delta=>{const control=button(delta<0?'←':'→','kb-reorder');control.disabled=delta<0?index===0:index===saved.favorites.length-1;control.setAttribute('aria-label',item.title+(delta<0?' 앞으로 이동':' 뒤로 이동'));control.addEventListener('click',()=>{preferences.move(id,delta);render();editButton.focus();status.textContent=item.title+' 순서를 변경했습니다.';});row.append(control);});}favoriteRows.append(row);});
    }
    function render(){renderNav();renderCards();renderShortcuts();if(dialog.open)renderDialog();syncNewsMarkers();}
    win.addEventListener('storage',event=>{if(event.key===key||event.key===null){preferences.reload();render();}});
    win.addEventListener('pageshow',()=>{preferences.reload();render();});
    render();
    win.NewsBadge?.subscribe(syncNewsMarkers);
    // Home collectors already fetch these feeds. On other pages load only missing summaries,
    // without acknowledging them as read; the actual feed page owns acknowledgement.
    if(!home&&typeof win.fetch==='function'&&win.NewsBadge){
      const feeds=[['competitor','competitor-news'],['agency','agency-news'],['reputation','reputation-watch']].filter(([,id])=>current?.id!==id);
      const trackers=feeds.map(([feed,id])=>({id,tracker:win.NewsBadge.create(feed,{detail:false})}));
      let loading=false;
      const refresh=async()=>{if(loading||doc.hidden)return;loading=true;try{await Promise.allSettled(trackers.map(async({id,tracker})=>{const response=await win.fetch('/api/'+id+'?summary=1',{cache:'no-store',signal:AbortSignal.timeout(15000)});if(response.ok)tracker.update((await response.json()).article_ids);}));}finally{loading=false;}};
      refresh();win.setInterval(refresh,300000);doc.addEventListener('visibilitychange',refresh);
    }
  }
  return {features,categories,matchFeatures,createPreferences,mount};
});
