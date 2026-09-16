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
    let state = {favorites:[], recent:[], view:'cards'};
    function read() {
      try {
        const saved = JSON.parse(storage.getItem(key));
        if (saved && typeof saved === 'object') state = {favorites:cleanIds(saved.favorites), recent:cleanIds(saved.recent).slice(0,3), view:saved.view === 'list' ? 'list' : 'cards'};
        else state = {favorites:[], recent:[], view:'cards'};
      } catch { /* Keep usable in-memory preferences when storage is blocked. */ }
    }
    function save() { try { storage.setItem(key, JSON.stringify(state)); } catch { /* Device-local storage is optional. */ } }
    read();
    return {
      get:() => ({...state, favorites:[...state.favorites], recent:[...state.recent]}),
      reload:read,
      toggle(id) { if (!ids.has(id)) return; state.favorites = state.favorites.includes(id) ? state.favorites.filter(value => value !== id) : [...state.favorites,id]; save(); },
      move(id, delta) { const index=state.favorites.indexOf(id), next=index+delta; if (index<0 || next<0 || next>=state.favorites.length) return; [state.favorites[index],state.favorites[next]]=[state.favorites[next],state.favorites[index]]; save(); },
      visit(id) { if (!ids.has(id)) return; state.recent=[id,...state.recent.filter(value=>value!==id)].slice(0,3); save(); },
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
    if (current) preferences.visit(current.id);
    const params=new URLSearchParams(win.location.search);
    const allowedCategories=new Set(['all','favorites',...categories.map(item=>item.id)]);
    let category=allowedCategories.has(params.get('category'))?params.get('category'):'all';
    let query=home?(params.get('q')||''):'';
    let editing=false;
    const el=(tag, className, text)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
    const button=(text,className)=>{const node=el('button',className,text);node.type='button';return node;};
    const link=(item,className)=>{const node=el('a',className,item.title);node.href=item.href;if(current?.id===item.id)node.setAttribute('aria-current','page');return node;};
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
      matches.forEach(item=>{const row=link(item,'kb-dialog-result');row.append(el('span','',item.description));dialogResults.append(row);});
      if(!matches.length)dialogResults.append(el('p','kb-empty','검색 결과가 없습니다. 다른 검색어나 업무를 선택해 주세요.'));
    }
    function openDialog() {if(dialog.open)return;dialogSearch.value='';dialogFilters.value='all';renderDialog();dialog.showModal();dialogSearch.focus();}
    const open=button('기능 찾기','kb-search-trigger');open.setAttribute('aria-haspopup','dialog');open.setAttribute('aria-controls',dialog.id);open.addEventListener('click',openDialog);
    const actions=header.querySelector('.kb-actions')||header.querySelector('nav')||header;actions.append(open);
    dialogSearch.addEventListener('input',renderDialog);dialogFilters.addEventListener('change',renderDialog);
    dialogSearch.addEventListener('keydown',event=>{if(event.key==='Enter'){const first=dialogResults.querySelector('a');if(first){event.preventDefault();first.click();}}if(event.key==='ArrowDown'){event.preventDefault();dialogResults.querySelector('a')?.focus();}});
    dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
    doc.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&!doc.querySelector('dialog[open], .modal.open')){event.preventDefault();openDialog();}});

    let homeSearch, homeFilter, favoriteRows, recentSection, recentRows, editButton, resultCount, resultTitle, empty, grid;
    const cards=new Map();
    if(home) {
      grid=main.querySelector('.grid');
      const lead=main.querySelector('.lead');
      lead?.querySelector('.eyebrow')?.remove();
      if(lead?.querySelector('p'))lead.querySelector('p').textContent='필요한 업무를 검색하거나 즐겨찾기에서 바로 시작하세요.';
      const tools=el('section','kb-home-tools');tools.setAttribute('aria-label','기능 탐색');
      const searchLabel=el('label','kb-search-label','기능 검색');searchLabel.htmlFor='kb-home-search';
      homeSearch=el('input','kb-search-input');homeSearch.id='kb-home-search';homeSearch.type='search';homeSearch.placeholder='급여, 손익, 네이버…';homeSearch.value=query;
      homeFilter=dialogFilters.cloneNode(true);homeFilter.classList.add('kb-mobile-filter');homeFilter.setAttribute('aria-label','업무별 기능 선택');homeFilter.value=category;
      tools.append(searchLabel,homeSearch,homeFilter);
      const favoritesSection=el('section','kb-shortcut-section');favoritesSection.setAttribute('aria-label','즐겨찾기');
      const favoriteHead=el('div','kb-section-head');favoriteHead.append(el('h2','','즐겨찾기'));
      editButton=button('순서 편집','kb-text-button');editButton.setAttribute('aria-pressed','false');editButton.addEventListener('click',()=>{editing=!editing;render();});favoriteHead.append(editButton);
      favoriteRows=el('div','kb-shortcuts');favoritesSection.append(favoriteHead,favoriteRows,el('p','kb-preference-note','즐겨찾기와 최근 사용은 이 브라우저에 저장됩니다.'));
      recentSection=el('section','kb-recent-section');recentSection.append(el('h2','','최근 사용'));recentRows=el('div','kb-shortcuts');recentSection.append(recentRows);
      const toolbar=el('div','kb-results-toolbar');const heading=el('h2');resultTitle=el('span');resultCount=el('span','kb-result-count');resultCount.setAttribute('role','status');heading.append(resultTitle,resultCount);
      const views=el('div','kb-view-controls');views.setAttribute('aria-label','표시 방식');['cards','list'].forEach(view=>{const control=button(view==='cards'?'카드':'목록','kb-control');control.dataset.kbView=view;control.addEventListener('click',()=>{preferences.view(view);render();});views.append(control);});toolbar.append(heading,views);
      grid.before(tools,favoritesSection,recentSection,toolbar);
      empty=el('div','kb-empty');empty.hidden=true;const emptyText=el('p','', '검색 결과가 없습니다. 검색어나 선택한 업무를 확인해 주세요.');
      const reset=button('전체 기능 보기','kb-control');reset.addEventListener('click',()=>{category='all';query='';homeSearch.value='';updateHomeURL();render();homeSearch.focus();});empty.append(emptyText,reset);grid.after(empty);
      grid.querySelectorAll(':scope > article').forEach(card=>{
        const item=features.find(feature=>card.querySelector('a[href="'+feature.href+'"]'));
        if(!item)return;cards.set(item.id,card);card.classList.add('kb-feature-card');card.dataset.kbFeature=item.id;
        const heading=card.querySelector('h2');heading.replaceChildren(link(item,'kb-feature-title'));
        const description=card.querySelector(':scope > p');if(description)description.textContent=item.description;
        const content=el('div','kb-card-content');content.append(heading);if(description)content.append(description);content.append(el('span','kb-card-category',categories.find(group=>group.id===item.category).title));
        const live=el('div','kb-card-status');
        // Move, never clone, live status nodes so existing collectors retain their IDs.
        [...card.children].forEach(node=>{
          if(node.classList.contains('icon')||node.tagName==='A')node.remove();
          else if(node.classList.contains('card-topline')){const badge=node.querySelector('.card-update-badge');if(badge)live.append(badge);node.remove();}
          else if(node.classList.contains('card-heading')){[...node.children].forEach(child=>live.append(child));node.remove();}
          else live.append(node);
        });
        const pin=button('☆','kb-favorite-button');pin.dataset.kbPin=item.id;pin.addEventListener('click',()=>{preferences.toggle(item.id);render();status.textContent=item.title+(preferences.get().favorites.includes(item.id)?' 즐겨찾기에 추가했습니다.':' 즐겨찾기에서 해제했습니다.');if(!card.hidden)pin.focus();else homeSearch.focus();});
        card.append(content,live,pin);
      });
      homeSearch.addEventListener('input',()=>{query=homeSearch.value;updateHomeURL();renderCards();});
      homeFilter.addEventListener('change',()=>{category=homeFilter.value;updateHomeURL();render();});
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
        [{id:'all',title:'전체 기능'},{id:'favorites',title:'즐겨찾기'},...categories].forEach(group=>{
          const control=button(group.title,'kb-category-button');control.dataset.kbCategory=group.id;control.setAttribute('aria-pressed',String(category===group.id));
          control.append(el('span','',String(matchFeatures('',group.id,preferences.get().favorites).length)));
          control.addEventListener('click',()=>{category=group.id;updateHomeURL();render();});nav.append(control);
        });
        if(focused)nav.querySelector('[data-kb-category="'+focused+'"]')?.focus();
      } else {
        const pinned=preferences.get().favorites;
        if(pinned.length){const group=el('div','kb-nav-group');group.append(el('p','','즐겨찾기'));pinned.forEach(id=>group.append(link(features.find(item=>item.id===id),'kb-nav-link')));nav.append(group);}
        categories.forEach(category=>{const group=el('details','kb-nav-group');group.open=current?.category===category.id||(!current&&category.id==='operations');group.append(el('summary','',category.title));features.filter(item=>item.category===category.id).forEach(item=>group.append(link(item,'kb-nav-link')));nav.append(group);});
      }
    }
    function renderCards() {
      if(!home)return;
      const saved=preferences.get();const matches=matchFeatures(query,category,saved.favorites);const matching=new Set(matches.map(item=>item.id));
      cards.forEach((card,id)=>{card.hidden=!matching.has(id);const pin=card.querySelector('[data-kb-pin]');const item=features.find(item=>item.id===id);const active=saved.favorites.includes(id);pin.textContent=active?'★':'☆';pin.setAttribute('aria-pressed',String(active));pin.setAttribute('aria-label',item.title+' 즐겨찾기 '+(active?'해제':'추가'));});
      grid.classList.toggle('kb-list-view',saved.view==='list');
      resultTitle.textContent=category==='all'?'전체 기능':category==='favorites'?'즐겨찾기':categories.find(group=>group.id===category).title;
      resultCount.textContent=matches.length+'개';empty.hidden=matches.length>0;homeFilter.value=category;
      doc.querySelectorAll('[data-kb-view]').forEach(control=>control.setAttribute('aria-pressed',String(control.dataset.kbView===saved.view)));
    }
    function renderShortcuts() {
      if(!home)return;
      const saved=preferences.get();favoriteRows.replaceChildren();
      editButton.hidden=saved.favorites.length<2;editButton.textContent=editing?'편집 완료':'순서 편집';editButton.setAttribute('aria-pressed',String(editing));
      if(!saved.favorites.length)favoriteRows.append(el('p','kb-empty-favorites','카드의 ☆를 누르면 자주 쓰는 기능이 여기에 모입니다.'));
      saved.favorites.forEach((id,index)=>{const item=features.find(item=>item.id===id);const row=el('div','kb-shortcut');row.append(link(item,''));if(editing){[-1,1].forEach(delta=>{const control=button(delta<0?'←':'→','kb-reorder');control.disabled=delta<0?index===0:index===saved.favorites.length-1;control.setAttribute('aria-label',item.title+(delta<0?' 앞으로 이동':' 뒤로 이동'));control.addEventListener('click',()=>{preferences.move(id,delta);render();editButton.focus();status.textContent=item.title+' 순서를 변경했습니다.';});row.append(control);});}favoriteRows.append(row);});
      recentSection.hidden=!saved.recent.length;recentRows.replaceChildren();saved.recent.forEach(id=>recentRows.append(link(features.find(item=>item.id===id),'kb-recent-link')));
    }
    function render(){renderNav();renderCards();renderShortcuts();if(dialog.open)renderDialog();}
    win.addEventListener('storage',event=>{if(event.key===key||event.key===null){preferences.reload();render();}});
    win.addEventListener('pageshow',()=>{preferences.reload();render();});
    render();
  }
  return {features,categories,matchFeatures,createPreferences,mount};
});
