/* Support resource list for /support-resources.html. Edit data/support_resources.json; see data/SUPPORT_RESOURCES.md. */
(function (root, factory) {
  const api = factory();
  root.SupportResources = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) api.mount(root);
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const TYPES = ['무료공연·문화', '재능기부', '후원품'];
  const FRESH_DAYS = 7;
  const TEXT_FIELDS = ['title', 'org', 'type', 'summary', 'target', 'region', 'how_to_apply', 'deadline_note', 'contact', 'event_date'];
  const dateOk = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
  function seoulToday(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(now);
    const get = type => parts.find(part => part.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function resolveToday(today) {
    return dateOk(today) ? today : seoulToday();
  }
  function dayNumber(value) {
    return Date.UTC(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8, 10));
  }
  function dayDiff(from, to) {
    return Math.round((dayNumber(to) - dayNumber(from)) / 86400000);
  }
  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
  function canonicalName(value) {
    return text(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');
  }
  function canonicalUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const path = parsed.pathname.replace(/\/+$/, '') || '/';
      const search = [...parsed.searchParams.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
        .map(([key, value]) => key + '=' + value)
        .join('&');
      return host + path + (search ? '?' + search : '');
    } catch {
      return '';
    }
  }
  function safeHref(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
      return '';
    }
  }
  function deadlineLabel(deadline, today) {
    const todayValue = resolveToday(today);
    if (!dateOk(deadline)) return {key:'open', text:'상시·미정'};
    const days = dayDiff(todayValue, deadline);
    if (days === 0) return {key:'today', text:'오늘 마감', days:0};
    if (days > 0) return {key:'soon', text:'D-' + days, days};
    return {key:'closed', text:'마감', days};
  }
  function scheduleText(item) {
    const label = (item.deadlineInfo && item.deadlineInfo.text) || deadlineLabel(item.deadline).text;
    const note = text(item.deadline_note);
    if (!item.deadline) {
      const start = item.apply_start ? '접수 시작 ' + item.apply_start + ' · ' : '';
      return start + (note || '상시·미정');
    }
    const when = item.deadline + (note ? ' ' + note : '');
    const range = item.apply_start ? '접수 ' + item.apply_start + ' ~ ' + when : '마감 ' + when;
    return range + ' · ' + label;
  }
  function sourceRecord(record) {
    const source = {
      id: typeof record.id === 'string' ? record.id : '',
      title: text(record.title),
      org: text(record.org),
      url: typeof record.url === 'string' ? record.url : '',
      collected_date: dateOk(record.collected_date) ? record.collected_date : null
    };
    return source.id || source.title || source.org || source.url ? source : null;
  }
  function sourceKey(source) {
    return canonicalUrl(source.url) + '\n' + source.id;
  }
  function mergeGroup(records) {
    const ranked = [...records].sort((a, b) => {
      const left = dateOk(a.record.collected_date) ? a.record.collected_date : '';
      const right = dateOk(b.record.collected_date) ? b.record.collected_date : '';
      return right.localeCompare(left) || a.index - b.index;
    });
    const primary = ranked[0].record;
    const item = {id: primary.id};
    for (const field of TEXT_FIELDS) {
      item[field] = '';
      for (const entry of ranked) {
        const value = text(entry.record[field]);
        if (value) { item[field] = entry.record[field].trim(); break; }
      }
    }
    item.url = '';
    for (const entry of ranked) {
      if (safeHref(entry.record.url)) { item.url = entry.record.url; break; }
    }
    if (!item.url) item.url = text(primary.url);
    item.apply_start = ranked.map(entry => entry.record.apply_start).find(dateOk) || null;
    item.deadline = ranked.map(entry => entry.record.deadline).find(dateOk) || null;
    item.collected_date = ranked.map(entry => entry.record.collected_date).find(dateOk) || '';
    const sources = [];
    const seen = new Set();
    function addSource(source) {
      if (!source) return;
      const key = sourceKey(source);
      if (seen.has(key)) return;
      if (canonicalUrl(source.url) && canonicalUrl(source.url) === canonicalUrl(item.url) && source.id === item.id) return;
      seen.add(key);
      sources.push(source);
    }
    ranked.slice(1).forEach(entry => addSource(sourceRecord(entry.record)));
    ranked.forEach(entry => {
      if (!Array.isArray(entry.record.sources)) return;
      entry.record.sources.forEach(source => { if (source && typeof source === 'object') addSource(sourceRecord(source)); });
    });
    if (sources.length) item.sources = sources;
    item.order = ranked[0].index;
    return item;
  }
  function prepareItems(data, today) {
    const todayValue = resolveToday(today);
    const raw = ((data && data.items) || [])
      .map((record, index) => ({record, index}))
      .filter(entry => entry.record && typeof entry.record === 'object' && typeof entry.record.id === 'string' && entry.record.id);
    const parent = raw.map((_, index) => index);
    function find(index) {
      while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
      return index;
    }
    function unite(left, right) {
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[b] = a;
    }
    const buckets = {url:new Map(), name:new Map(), id:new Map()};
    raw.forEach((entry, index) => {
      const record = entry.record;
      const keys = [['id', record.id]];
      const url = canonicalUrl(record.url);
      const org = canonicalName(record.org);
      const title = canonicalName(record.title);
      if (url) keys.push(['url', url]);
      if (org && title) keys.push(['name', org + '\n' + title]);
      keys.forEach(([kind, key]) => {
        const bucket = buckets[kind];
        if (bucket.has(key)) unite(index, bucket.get(key));
        else bucket.set(key, index);
      });
    });
    const groups = new Map();
    raw.forEach((entry, index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(entry);
    });
    const items = [...groups.values()].map(group => {
      const item = mergeGroup(group);
      const collectedDate = dateOk(item.collected_date) ? item.collected_date : '';
      const deadlineInfo = deadlineLabel(item.deadline, todayValue);
      return {
        ...item,
        collectedDate,
        deadlineInfo,
        fresh: !!collectedDate && dayDiff(collectedDate, todayValue) >= 0 && dayDiff(collectedDate, todayValue) <= FRESH_DAYS,
        closed: deadlineInfo.key === 'closed'
      };
    });
    items.sort((a, b) => Number(a.closed) - Number(b.closed) || b.collectedDate.localeCompare(a.collectedDate) || a.order - b.order);
    return items;
  }
  function filterItems(items, {type = '', includeClosed = true} = {}) {
    return items.filter(item => (!type || item.type === type) && (includeClosed || !item.closed));
  }
  function freshIds(data, today) {
    return prepareItems(data, today).filter(item => item.fresh).map(item => item.id);
  }
  function homeMeta(data, today) {
    const items = prepareItems(data, today);
    if (!items.length) return '아직 등록된 항목이 없어요';
    const latest = items.reduce((max, item) => item.collectedDate > max ? item.collectedDate : max, '');
    const shown = dateOk(latest) ? `${latest.slice(0, 4)}. ${latest.slice(5, 7)}. ${latest.slice(8, 10)}` : '확인 중';
    return `최근 수집 ${shown} · ${items.length}건`;
  }
  function mount(win) {
    const doc = win.document;
    const $ = id => doc.getElementById(id);
    const grid = $('support-grid');
    const homeMetaNode = $('home-support-resources-meta');
    const homeBadge = $('home-support-resources-new');
    const detail = !!grid;
    if (!detail && !homeMetaNode && !homeBadge) return;
    const tracker = win.NewsBadge?.create('support-resources', {detail:false, seenLabel:'후원·재능기부'});
    let loaded = null;
    function paintHomeBadge(count) {
      if (!homeBadge) return;
      homeBadge.hidden = count === 0;
      const label = '최근 7일 이내 신규 ' + count + '건';
      homeBadge.title = count ? label : '';
      homeBadge.setAttribute('aria-label', count ? label : '최근 7일 이내 신규 없음');
    }
    function sync(data) {
      loaded = data;
      const today = seoulToday();
      const ids = freshIds(data, today);
      tracker?.update(ids);
      paintHomeBadge(ids.length);
      if (homeMetaNode) homeMetaNode.textContent = homeMeta(data, today);
    }
    const status = $('support-status');
    const toolbar = $('support-toolbar');
    const types = $('support-types');
    const includeClosedInput = $('support-include-closed');
    const count = $('support-count');
    const empty = $('support-empty');
    const emptyText = $('support-empty-text');
    const reset = $('support-reset');
    const updated = $('support-updated');
    let items = [];
    let selectedType = '';
    let includeClosed = true;
    let ready = false;
    const el = (tagName, className, textValue) => {
      const node = doc.createElement(tagName);
      if (className) node.className = className;
      if (textValue !== undefined) node.textContent = textValue;
      return node;
    };
    function renderTypes() {
      if (!types) return;
      const present = new Set(items.map(item => item.type).filter(Boolean));
      if (selectedType && !present.has(selectedType)) selectedType = '';
      const names = [...TYPES.filter(type => present.has(type)), ...[...present].filter(type => !TYPES.includes(type)).sort((a, b) => a.localeCompare(b, 'ko'))];
      types.replaceChildren();
      [{id:'', label:'전체'}, ...names.map(name => ({id:name, label:name}))].forEach(item => {
        const button = el('button', 'ui-button', item.label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(selectedType === item.id));
        button.addEventListener('click', () => { selectedType = item.id; render(); });
        types.append(button);
      });
    }
    function fillCard(card, item) {
      const head = el('div', 'support-card-head');
      const title = el('h2');
      title.append(el('span', 'support-title', item.title || '제목 없음'));
      if (item.fresh) title.append(el('span', 'news-new-mark', 'N'));
      const freshMark = title.querySelector('.news-new-mark');
      if (freshMark) freshMark.setAttribute('aria-label', '최근 7일 이내 수집');
      head.append(title);
      if (item.type) head.append(el('span', 'ui-status', item.type));
      card.append(head);
      if (item.org) card.append(el('p', 'support-org', item.org));
      if (item.summary) card.append(el('p', '', item.summary));
      const placeParts = [item.target, item.region].filter(Boolean);
      const place = placeParts.length === 2 && placeParts[0] === placeParts[1] ? placeParts[0] : placeParts.join(' · ');
      if (place) card.append(el('p', 'support-place', place));
      if (item.event_date) card.append(el('p', 'support-event', '공연 ' + item.event_date));
      const schedule = el('p', 'support-schedule' + (item.closed ? ' is-closed' : item.deadlineInfo.key === 'today' ? ' is-today' : ''), scheduleText(item));
      card.append(schedule);
      if (item.how_to_apply) card.append(el('p', 'support-apply', '신청 ' + item.how_to_apply));
      if (item.contact) card.append(el('p', 'support-contact', '문의 ' + item.contact));
      if (item.collectedDate) card.append(el('p', 'support-collected', '수집 ' + item.collectedDate));
    }
    function render() {
      if (!detail) return;
      const visible = filterItems(items, {type:selectedType, includeClosed});
      count.textContent = '항목 ' + visible.length + '건';
      count.hidden = items.length === 0;
      grid.replaceChildren();
      visible.forEach(item => {
        const href = safeHref(item.url);
        const card = href ? el('a', 'support-card') : el('article', 'support-card');
        if (href) {
          card.href = href;
          card.target = '_blank';
          card.rel = 'noopener noreferrer';
          card.title = '원문을 새 탭에서 엽니다';
        }
        if (item.closed) card.classList.add('is-closed');
        fillCard(card, item);
        grid.append(card);
      });
      const catalogEmpty = ready && items.length === 0;
      const filterEmpty = ready && !catalogEmpty && visible.length === 0;
      if (toolbar) toolbar.hidden = catalogEmpty;
      empty.hidden = !catalogEmpty && !filterEmpty;
      if (catalogEmpty) {
        emptyText.textContent = '아직 등록된 항목이 없어요. 평일마다 새 항목이 추가됩니다.';
        reset.hidden = true;
      } else if (filterEmpty) {
        emptyText.textContent = '이 조건에 맞는 항목이 없습니다. 유형이나 마감 표시를 바꿔 보세요.';
        reset.hidden = false;
      }
      types.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String((button.textContent === '전체' && !selectedType) || button.textContent === selectedType)));
    }
    if (detail) {
      includeClosedInput.addEventListener('change', () => { includeClosed = includeClosedInput.checked; render(); });
      reset.addEventListener('click', () => {
        selectedType = '';
        includeClosed = true;
        includeClosedInput.checked = true;
        render();
        types.querySelector('button')?.focus();
      });
      status.textContent = '항목을 불러오는 중';
    }
    function refresh() {
      const today = seoulToday();
      return win.fetch('/data/support_resources.json', {cache:'no-store'}).then(response => {
        if (!response.ok) throw new Error('load');
        return response.json();
      }).then(data => {
        if (detail) {
          items = prepareItems(data, today);
          ready = true;
          if (updated) {
            if (dateOk(data.updated)) {
              updated.dateTime = data.updated;
              updated.textContent = data.updated;
            } else {
              updated.removeAttribute('datetime');
              updated.textContent = '아직 없음';
            }
          }
          status.textContent = '';
          renderTypes();
          render();
        }
        sync(data);
      }).catch(() => {
        if (detail && !ready) status.textContent = '항목을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.';
        if (homeMetaNode && !loaded) homeMetaNode.textContent = '최근 수집 연결 확인 필요';
      });
    }
    refresh();
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
    win.setInterval(() => { if (!doc.hidden) refresh(); }, 300000);
  }
  return {TYPES, FRESH_DAYS, prepareItems, filterItems, deadlineLabel, scheduleText, freshIds, homeMeta, safeHref, canonicalUrl, canonicalName, seoulToday, mount};
});
