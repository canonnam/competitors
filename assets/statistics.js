(function () {
  'use strict';
  const data = typeof module === 'object' && module.exports ? require('./statistics-data.js') : window.STATISTICS_LIBRARY;
  const docs = new Map(data.documents.map(doc => [doc.id, doc]));
  const validIds = new Set(data.bookmarks.map(item => item.id));
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ').trim();
  function readSaved(raw) {
    try { const parsed = JSON.parse(raw); return new Set(Array.isArray(parsed) ? parsed.filter(id => validIds.has(id)) : []); }
    catch { return new Set(); }
  }
  function filterItems({view='bookmarks', query='', topic='', savedOnly=false, saved=new Set(), documentId=''} = {}) {
    const words = normalize(query).split(' ').filter(Boolean);
    return (view === 'documents' ? data.documents : data.bookmarks).filter(item => {
      const doc = view === 'documents' ? item : docs.get(item.documentId);
      if (topic && !(view === 'documents' ? item.topics.includes(topic) : item.topic === topic)) return false;
      if (view === 'bookmarks' && ((savedOnly && !saved.has(item.id)) || (documentId && item.documentId !== documentId))) return false;
      const haystack = normalize([doc.title, doc.author, doc.survey, doc.published, doc.summary, ...(doc.topics || []), item.title, item.insight, item.action, item.figure, item.metric, item.metricLabel].join(' '));
      return words.every(word => haystack.includes(word));
    });
  }
  if (typeof module === 'object' && module.exports) { module.exports = {readSaved, filterItems}; return; }
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = '<svg width="15" height="17" viewBox="0 0 16 18" fill="none" aria-hidden="true"><path d="M3 2h10v14l-5-3-5 3V2Z" stroke="currentColor" stroke-width="1.5"/></svg>';
  const storageKey = 'vida.statistics.bookmarks.v1';
  let saved = new Set();
  try { saved = readSaved(localStorage.getItem(storageKey)); } catch { /* Private browsing still allows this session's bookmarks. */ }
  const state = {view:'bookmarks',query:'',topic:'',savedOnly:false,documentId:''};
  let activeBookmark = null, toastTimer;
  const saveButton = item => `<button class="save-button" data-save="${item.id}" aria-pressed="${saved.has(item.id)}" aria-label="${escape(item.title)} ${saved.has(item.id) ? '저장 해제' : '책갈피 저장'}">${icon}<span>${saved.has(item.id) ? '저장됨' : '저장'}</span></button>`;
  const pdfLink = item => docs.get(item.documentId).downloadUrl + '#page=' + item.pdfPage;
  const external = (url, label, cls='') => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer"${cls ? ` class="${cls}"` : ''}>${escape(label)}</a>`;
  function bookmarkCard(item) {
    const doc = docs.get(item.documentId);
    return `<article class="bookmark-card" id="${item.id}">
      <button class="capture-button" data-open="${item.id}" aria-label="${escape(item.title)} 원문 캡처 확대"><img src="${item.image}" alt="${escape(item.alt)}" width="${item.capture[2]-item.capture[0]}" height="${item.capture[3]-item.capture[1]}" loading="lazy"><span>원문 캡처 확대 ↗</span></button>
      <div class="bookmark-content"><div class="bookmark-top"><span class="topic-tag">${item.topic}</span>${saveButton(item)}</div>
      <h3><button data-open="${item.id}">${item.title}</button></h3><p class="insight">${item.insight}</p>
      <div class="application"><strong>현장에서 살펴볼 점</strong>${item.action}</div><p class="caveat">${item.caveat}</p>
      <div class="bookmark-source"><span>${doc.survey} · ${doc.author} · 발행 ${doc.published}</span>${external(pdfLink(item), `원문 ${item.printedPage}쪽 · ${item.figure} 보기 ↗`)}<span>PDF ${item.pdfPage}페이지 / ${doc.pdfPages} · 한국보건사회연구원</span></div></div></article>`;
  }
  function documentCard(doc) {
    const count = data.bookmarks.filter(item => item.documentId === doc.id).length;
    return `<article class="document-card"><div class="doc-number" aria-hidden="true">${String(data.documents.indexOf(doc)+1).padStart(2,'0')}</div><div>
      <div class="doc-meta">보건복지포럼 · 한국보건사회연구원 · ${doc.author}</div><h3>${doc.title}</h3><p>${doc.summary}</p>
      <div class="doc-meta">조사 ${doc.year}년 · 발행 ${doc.published} · 본문 ${doc.pages}쪽 · PDF ${doc.pdfPages}페이지</div><p>${doc.scope}</p>
      <div>${doc.topics.map(topic => `<span class="topic-tag">${topic}</span>`).join(' ')}</div></div><div class="doc-actions">
      ${external(doc.downloadUrl,'원문 PDF 다운로드 ↗','action-link primary')}${external(doc.sourceUrl,'발행기관 자료 페이지 ↗','action-link')}<button data-document="${doc.id}">선정한 책갈피 ${count}개 보기 →</button></div></article>`;
  }
  function updateSavedButtons() {
    document.querySelectorAll('[data-save]').forEach(button => {
      const item = data.bookmarks.find(entry => entry.id === button.dataset.save), isSaved = saved.has(item.id);
      button.setAttribute('aria-pressed', String(isSaved));
      button.setAttribute('aria-label', item.title + (isSaved ? ' 저장 해제' : ' 책갈피 저장'));
      button.querySelector('span').textContent = isSaved ? '저장됨' : '저장';
    });
    $('saved-count').textContent = saved.size;
  }
  function render() {
    const items = filterItems({...state,saved});
    const isBookmarks = state.view === 'bookmarks';
    $('bookmarks-view').hidden = !isBookmarks;
    $('documents-view').hidden = isBookmarks;
    $('saved-only').hidden = !isBookmarks;
    $('saved-only').setAttribute('aria-pressed',String(state.savedOnly));
    $('bookmarks-tab').setAttribute('aria-pressed',String(isBookmarks));
    $('documents-tab').setAttribute('aria-pressed',String(!isBookmarks));
    document.querySelectorAll('[data-topic]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.topic === state.topic)));
    $('results-count').textContent = `${state.documentId ? docs.get(state.documentId).title + ' · ' : ''}${isBookmarks ? '책갈피' : '문서'} ${items.length}개`;
    $('results-hint').textContent = isBookmarks ? '표·그래프를 누르면 크게 볼 수 있습니다.' : '원문은 한국보건사회연구원에서 열립니다.';
    $(isBookmarks ? 'bookmarks-view' : 'documents-view').innerHTML = items.map(isBookmarks ? bookmarkCard : documentCard).join('');
    $('empty-state').hidden = items.length !== 0;
    $('empty-message').textContent = state.savedOnly && !saved.size ? '마음에 드는 자료에서 저장 버튼을 눌러보세요. 이 브라우저에 보관됩니다.' : '검색어를 줄이거나 다른 주제를 선택해 보세요.';
    updateSavedButtons();
  }
  function openBookmark(id) {
    const item = data.bookmarks.find(entry => entry.id === id);
    if (!item) return;
    activeBookmark = item;
    const doc = docs.get(item.documentId);
    $('capture-title').textContent = item.title;
    $('capture-topic').textContent = `${item.topic} · 조사 ${doc.year}년`;
    $('capture-content').innerHTML = `<figure class="dialog-figure"><img src="${item.image}" alt="${escape(item.alt)}" width="${item.capture[2]-item.capture[0]}" height="${item.capture[3]-item.capture[1]}"><figcaption>${doc.author}, 「${doc.title}」, 보건복지포럼 ${doc.published}, 한국보건사회연구원.<br>본문 ${item.printedPage}쪽 ${item.figure} · PDF ${item.pdfPage}페이지 / ${doc.pdfPages}. 제목·단위·주석을 포함한 원문 발췌.</figcaption></figure>
      <div class="dialog-copy"><p class="insight">${item.insight}</p><div class="application"><strong>현장에서 살펴볼 점 · 더비다의 활용 아이디어</strong>${item.action}</div><p class="caveat">${item.caveat}</p><p class="dialog-document">${doc.scope}</p></div>
      <div class="dialog-actions">${external(pdfLink(item),'해당 페이지 원문 ↗','action-link primary')}${external(doc.downloadUrl,'원문 PDF 다운로드 ↗','action-link')}${external(item.image,'캡처 크게 열기 ↗','action-link')}${saveButton(item)}</div>`;
    const dialog = $('capture-dialog');
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }
  function notify(message) {
    clearTimeout(toastTimer); $('save-status').textContent = message;
    toastTimer = setTimeout(() => { $('save-status').textContent = ''; }, 3500);
  }
  function toggleSaved(id) {
    if (!validIds.has(id)) return;
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    let persistent = true;
    try { localStorage.setItem(storageKey, JSON.stringify([...saved])); } catch { persistent = false; }
    if (state.savedOnly && !$('capture-dialog').open) render(); else updateSavedButtons();
    notify(persistent ? (saved.has(id) ? '이 브라우저에 책갈피를 저장했습니다.' : '저장한 책갈피를 해제했습니다.') : '브라우저 저장이 제한되어 이번 화면에서만 유지됩니다.');
  }
  $('topics').innerHTML = ['',...data.topics].map(topic => `<button class="topic-button" data-topic="${topic}" aria-pressed="${!topic}">${topic || '전체'}</button>`).join('');
  $('highlights').innerHTML = ['choosing-a-home','family-priorities','housing-preference'].map(id => {
    const item = data.bookmarks.find(entry => entry.id === id), doc = docs.get(item.documentId);
    return `<button class="highlight" data-open="${id}"><small>${id === 'choosing-a-home' ? '입소 상담' : id === 'family-priorities' ? '보호자의 기대' : '주거 선택'}</small><strong>${item.metric}</strong><span>${item.metricLabel}</span><em>조사 ${doc.year}년 · 원문과 해석 보기 ↗</em></button>`;
  }).join('');
  $('statistics-search').addEventListener('input', event => {state.query = event.target.value; state.documentId = ''; render();});
  document.addEventListener('click', event => {
    const open = event.target.closest('[data-open]'), save = event.target.closest('[data-save]'), topic = event.target.closest('[data-topic]'), doc = event.target.closest('[data-document]');
    if (open) openBookmark(open.dataset.open);
    if (save) toggleSaved(save.dataset.save);
    if (topic) {state.topic = topic.dataset.topic; state.documentId = ''; render();}
    if (doc) {Object.assign(state,{view:'bookmarks',query:'',topic:'',savedOnly:false,documentId:doc.dataset.document}); $('statistics-search').value = ''; render(); $('library').scrollIntoView({block:'start'}); $('bookmarks-tab').focus({preventScroll:true});}
  });
  for (const view of ['bookmarks','documents']) $(view+'-tab').addEventListener('click', () => {state.view = view; state.documentId = ''; render();});
  $('saved-only').addEventListener('click', () => {state.savedOnly = !state.savedOnly; render();});
  $('reset-filters').addEventListener('click', () => {Object.assign(state,{query:'',topic:'',savedOnly:false,documentId:''}); $('statistics-search').value = ''; render(); $('statistics-search').focus();});
  $('close-capture').addEventListener('click', () => $('capture-dialog').close());
  $('capture-dialog').addEventListener('close', () => {
    document.body.style.overflow = '';
    if (state.savedOnly) {const id = activeBookmark && activeBookmark.id; render(); const opener = document.querySelector(`[data-open="${id}"]`); (opener || $('saved-only')).focus({preventScroll:true});}
    activeBookmark = null;
  });
  window.addEventListener('storage', event => {if (event.key === storageKey || event.key === null) {saved = readSaved(event.key === null ? null : event.newValue); render();}});
  render();
  const initialId = location.hash.slice(1);
  if (validIds.has(initialId)) openBookmark(initialId);
})();
