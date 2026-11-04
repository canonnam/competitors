/* Idea cards for /trend.html. Edit data/trend_ideas.json; see data/TREND_IDEAS.md. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) api.mount(root);
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const dateOk = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
  function effectiveDate(idea) {
    const dates = (idea.articles || []).map(article => article.date).filter(dateOk);
    return dates.reduce((max, date) => date > max ? date : max, '') || (dateOk(idea.last_date) ? idea.last_date : '');
  }
  function prepareIdeas(data) {
    const ideas = ((data && data.ideas) || []).map((idea, index) => ({
      ...idea,
      articles: [...(idea.articles || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      lastDate: effectiveDate(idea),
      order: index
    }));
    ideas.sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.order - b.order);
    return ideas;
  }
  function normalize(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, '');
  }
  function filterIdeas(ideas, {query = '', tag = ''} = {}) {
    const terms = String(query).trim().split(/\s+/).filter(Boolean).map(normalize);
    return ideas.filter(idea => {
      if (tag && !(idea.tags || []).includes(tag)) return false;
      if (!terms.length) return true;
      const haystack = normalize([idea.title, idea.summary, ...(idea.tags || []), ...(idea.articles || []).flatMap(article => [article.title, article.source, article.date])].join(' '));
      return terms.every(term => haystack.includes(term));
    });
  }
  function safeHref(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
    } catch { return ''; }
  }
  function ideaArticleIds(idea) {
    const ideaId = idea && typeof idea.id === 'string' ? idea.id : '';
    if (!ideaId) return [];
    const ids = [];
    for (const article of idea.articles || []) {
      if (!article || typeof article !== 'object') continue;
      const date = typeof article.date === 'string' ? article.date : '';
      const url = typeof article.url === 'string' ? article.url : '';
      if (!dateOk(date) || !url) continue;
      ids.push(ideaId + '\n' + date + '\n' + url);
    }
    return [...new Set(ids)];
  }
  function articleIds(data) {
    return [...new Set(((data && data.ideas) || []).flatMap(ideaArticleIds))];
  }
  function unseenIdeaIds(ideas, seenBefore) {
    const seen = new Set(Array.isArray(seenBefore) ? seenBefore.filter(id => typeof id === 'string' && id) : []);
    return (ideas || []).filter(idea => ideaArticleIds(idea).some(id => !seen.has(id))).map(idea => idea.id);
  }
  function homeMeta(data) {
    const ideas = prepareIdeas(data);
    const latest = ideas.reduce((max, idea) => idea.lastDate > max ? idea.lastDate : max, '');
    const shown = dateOk(latest) ? `${latest.slice(0, 4)}. ${latest.slice(5, 7)}. ${latest.slice(8, 10)}` : '확인 중';
    return `최근 기사 ${shown} · 아이디어 ${ideas.length}개`;
  }
  function mount(win) {
    const doc = win.document;
    const $ = id => doc.getElementById(id);
    const grid = $('trend-grid');
    const dialog = $('trend-dialog');
    const homeMetaNode = $('home-trend-meta');
    const detail = !!(grid && dialog);
    if (!detail && !homeMetaNode && !$('home-trend-new')) return;
    const tracker = win.NewsBadge?.create('trend', {badge:$('home-trend-new') || undefined, detail, seenLabel:'트렌드 페이지'});
    let loaded = null;
    let acknowledged = null;
    function readSeen() {
      try {
        const saved = JSON.parse(win.localStorage.getItem('vida-news-seen-v1:trend') || '[]');
        return new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string' && id) : []);
      } catch {
        return new Set();
      }
    }
    function sync(data) {
      loaded = data;
      if (detail && acknowledged === null) acknowledged = readSeen();
      if (homeMetaNode) homeMetaNode.textContent = homeMeta(data);
      tracker?.update(articleIds(data));
    }
    const status = $('trend-status');
    const search = $('trend-search');
    const tags = $('trend-tags');
    const count = $('trend-count');
    const empty = $('trend-empty');
    const updated = $('trend-updated');
    const dialogTitle = $('trend-dialog-title');
    const dialogSummary = $('trend-dialog-summary');
    const dialogList = $('trend-dialog-list');
    const closeButton = $('trend-dialog-close');
    let ideas = [];
    let tag = '';
    let ready = false;
    let lastFocus = null;
    const el = (tagName, className, text) => {
      const node = doc.createElement(tagName);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    function renderTags() {
      const names = [...new Set(ideas.flatMap(idea => idea.tags || []))].sort((a, b) => a.localeCompare(b, 'ko'));
      tags.replaceChildren();
      [{id:'', label:'전체'}, ...names.map(name => ({id:name, label:name}))].forEach(item => {
        const button = el('button', 'ui-button', item.label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(tag === item.id));
        button.addEventListener('click', () => { tag = item.id; render(); });
        tags.append(button);
      });
    }
    function fillCard(card, idea) {
      const head = el('div', 'trend-card-head');
      const title = el('h2');
      title.append(el('span', 'trend-title', idea.title));
      if (detail && acknowledged && ideaArticleIds(idea).some(id => !acknowledged.has(id))) {
        const mark = el('span', 'news-new-mark', 'N');
        mark.title = '이 브라우저에서 아직 확인하지 않은 기사';
        mark.setAttribute('aria-label', '확인하지 않은 기사');
        title.append(mark);
      }
      head.append(title);
      if (idea.articles.length >= 2) head.append(el('span', 'ui-status', '관련 기사 ' + idea.articles.length));
      const summary = el('p', '', idea.summary);
      const meta = el('p', 'trend-meta');
      const time = el('time', '', idea.lastDate);
      time.dateTime = idea.lastDate;
      meta.append(time);
      const tagList = el('span', 'trend-tag-list');
      (idea.tags || []).forEach(name => tagList.append(el('span', '', name)));
      meta.append(tagList);
      card.append(head, summary, meta);
    }
    function openArticles(idea, opener) {
      lastFocus = opener;
      dialogTitle.textContent = idea.title;
      dialogSummary.textContent = idea.summary;
      dialogList.replaceChildren();
      idea.articles.forEach(article => {
        const item = el('li');
        const href = safeHref(article.url);
        const link = el('a', '', article.title);
        if (href) {
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        const meta = el('span', 'trend-article-meta', [article.source, article.date].filter(Boolean).join(' · '));
        item.append(link, meta);
        dialogList.append(item);
      });
      if (!dialog.open) dialog.showModal();
      closeButton.focus();
    }
    function render() {
      const visible = filterIdeas(ideas, {query:search.value, tag});
      count.textContent = '아이디어 ' + visible.length + '개';
      grid.replaceChildren();
      visible.forEach(idea => {
        const single = idea.articles.length === 1 ? safeHref(idea.articles[0].url) : '';
        const card = single ? el('a', 'trend-card') : el('button', 'trend-card');
        if (single) {
          card.href = single;
          card.target = '_blank';
          card.rel = 'noopener noreferrer';
        } else {
          card.type = 'button';
          card.setAttribute('aria-haspopup', 'dialog');
          card.setAttribute('aria-controls', 'trend-dialog');
          card.addEventListener('click', () => openArticles(idea, card));
        }
        fillCard(card, idea);
        grid.append(card);
      });
      empty.hidden = !ready || visible.length > 0;
      tags.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String((button.textContent === '전체' && !tag) || button.textContent === tag)));
    }
    if (detail) {
      closeButton.addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      });
      dialog.addEventListener('close', () => {
        if (lastFocus && lastFocus.isConnected) lastFocus.focus();
        else search.focus();
      });
      search.addEventListener('input', render);
      $('trend-reset').addEventListener('click', () => { search.value = ''; tag = ''; render(); search.focus(); });
      status.textContent = '아이디어를 불러오는 중';
    }
    function refresh() {
      return win.fetch('/data/trend_ideas.json', {cache:'no-store'}).then(response => {
        if (!response.ok) throw new Error('load');
        return response.json();
      }).then(data => {
        if (detail) {
          ideas = prepareIdeas(data);
          if (acknowledged === null) acknowledged = readSeen();
          ready = true;
          if (updated && data.updated) {
            updated.dateTime = data.updated;
            updated.textContent = data.updated;
          }
          status.textContent = '';
          renderTags();
          render();
        }
        sync(data);
      }).catch(() => {
        if (detail && !ready) status.textContent = '아이디어를 불러오지 못했습니다. 잠시 후 다시 열어 주세요.';
        if (homeMetaNode && !loaded) homeMetaNode.textContent = '최근 기사 연결 확인 필요';
      });
    }
    refresh();
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
    win.setInterval(() => { if (!doc.hidden) refresh(); }, 300000);
  }
  return {prepareIdeas, filterIdeas, effectiveDate, safeHref, articleIds, ideaArticleIds, unseenIdeaIds, homeMeta, mount};
});
