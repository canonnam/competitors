(function (root) {
  'use strict';
  function syncStatus(data, now = Date.now()) {
    const sync = data?.sync;
    if (!sync) return {label: '연결 확인 필요', warning: true};
    if (!sync.enabled) return {label: '자동 수집 중지', warning: true};
    if (sync.errors?.length) return {label: '일부 수집 지연', warning: true};
    if (!data.updated_at) return {label: '첫 수집 대기', warning: true};
    if (sync.stale || (sync.next_run && now >= Date.parse(sync.next_run))) return {label: '갱신 대기', warning: true};
    return {label: '매일 갱신', warning: false};
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  const api = {syncStatus, safeUrl};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CompetitorNews = api;
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const home = $('home-news-meta'), timeline = $('news-timeline');
  if (!home && !timeline) return;
  const date = value => value ? new Date(value).toLocaleDateString('ko-KR', {timeZone: 'Asia/Seoul'}) : '확인 중';
  const collected = value => value ? new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}) : '';
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let current, visibleCount = 30, loading = false;
  function drawStatus(data) {
    const status = syncStatus(data);
    const badge = $('home-news-badge');
    if (badge) {
      badge.classList.toggle('is-warning', status.warning);
      badge.querySelector('span').textContent = status.label;
      badge.title = `매일 오전 9시 (한국시간) 자동 수집 · ${data.updated_at ? '최근 수집 ' + collected(data.updated_at) : status.label}`;
      badge.setAttribute('aria-label', badge.title);
    }
    if (home) {
      home.textContent = `최근 기사 ${date(data.latest_published_at)} · 총 ${data.total}건`;
      $('home-news-update').textContent = data.updated_at ? `수집 ${collected(data.updated_at)} · ${status.warning ? status.label : '매일 오전 9시'}` : `${status.label} · 매일 오전 9시`;
    }
    if ($('news-sync-status')) {
      const failures = data.sync.errors || [];
      $('news-sync-status').classList.toggle('is-warning', status.warning);
      $('news-sync-status').textContent = `매일 오전 9시 (한국시간) 자동 수집 · ${data.updated_at ? '최근 전체 수집 ' + collected(data.updated_at) : status.label}`
        + (failures.length ? ` · ${failures.join(', ')} 수집 지연, 30분 간격 재시도` : status.warning && data.updated_at ? ` · ${status.label}` : '');
      $('news-count').textContent = `최근 기사 ${date(data.latest_published_at)} · 총 ${data.total}건 · 게시일 내림차순`;
    }
  }
  function drawList() {
    if (!timeline || !current) return;
    const selected = $('news-competitor').value;
    const items = current.items.filter(item => !selected || item.competitor_id === selected);
    const fragment = document.createDocumentFragment();
    for (const item of items.slice(0, visibleCount)) {
      const article = make('article', 'item');
      const dateLine = make('div', 'date');
      const time = make('time', '', date(item.published_at));
      time.dateTime = item.published_at; dateLine.append(time);
      article.append(dateLine, make('h2', '', item.title));
      if (item.reviewed && item.summary) article.append(make('p', '', item.summary));
      const labels = make('div', 'labels');
      labels.append(make('span', 'label', '대상 경쟁사: ' + item.competitor),
        make('span', item.kind === '공식 발표' ? 'label official' : 'label', item.kind));
      if (item.reviewed) labels.append(make('span', 'label reviewed', '검토한 요약'));
      const source = make('div', 'source');
      source.append(make('span', '', `출처: ${item.source} · ${item.reviewed ? '확인' : 'Google 뉴스 경유 · 수집'} ${date(item.collected_at)}`));
      const url = safeUrl(item.url);
      if (url) {
        const link = make('a', '', item.reviewed ? '원문 보기 ↗' : '기사 보기 ↗');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        source.append(link);
      }
      article.append(labels, source); fragment.append(article);
    }
    if (!items.length) fragment.append(make('p', 'news-empty', '최근 수집된 기사가 없습니다. 새 기사가 발견되면 여기에 표시됩니다.'));
    timeline.replaceChildren(fragment);
    $('news-visible-count').textContent = `${Math.min(visibleCount, items.length)} / ${items.length}건 표시`;
    $('news-more').hidden = visibleCount >= items.length;
  }
  function render(data) {
    if (!data || !data.sync || !Number.isInteger(data.total) || (timeline && !Array.isArray(data.items))) throw new Error('Invalid news response');
    current = data;
    drawStatus(data);
    if (timeline) {
      const filter = $('news-competitor'), selected = filter.value;
      const names = new Map(data.items.map(item => [item.competitor_id, item.competitor]));
      filter.replaceChildren(make('option', '', '전체 경쟁사'));
      filter.firstChild.value = '';
      [...names].sort((a, b) => a[1].localeCompare(b[1], 'ko')).forEach(([id, name]) => {
        const option = make('option', '', name); option.value = id; filter.append(option);
      });
      if (names.has(selected)) filter.value = selected;
      $('news-controls').hidden = false;
      drawList();
    }
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch('/api/competitor-news' + (timeline ? '' : '?summary=1'), {
        cache: 'no-store', signal: AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error('News request failed');
      render(await response.json());
    } catch {
      if (current) drawStatus({...current, sync: {...current.sync, stale: true, errors: ['뉴스 연결']}});
      else {
        const status = $('news-sync-status') || $('home-news-update');
        status.textContent = '뉴스 연결 확인 필요 · 기존 기사 유지';
        status.classList.add('is-warning');
        const badge = $('home-news-badge');
        if (badge) { badge.classList.add('is-warning'); badge.querySelector('span').textContent = '연결 확인 필요'; badge.title = '뉴스 연결 확인 필요 · 기존 기사 유지'; badge.setAttribute('aria-label', badge.title); }
      }
    } finally { loading = false; }
  }
  $('news-competitor')?.addEventListener('change', () => { visibleCount = 30; drawList(); });
  $('news-more')?.addEventListener('click', () => { visibleCount += 30; drawList(); });
  refresh();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 300000);
})(globalThis);
