/* Support resource list for /support-resources.html. Edit data/support_resources.json; see data/SUPPORT_RESOURCES.md. */
(function (root, factory) {
  const api = factory();
  root.SupportResources = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) api.mount(root);
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const TYPES = ['무료공연·문화', '재능기부', '후원품'];
  const SITES = ['인천', '안양', '전국'];
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
  function normalizeSites(value) {
    const names = new Set((Array.isArray(value) ? value : []).filter(site => SITES.includes(site)));
    if (names.has('전국')) return ['전국'];
    return SITES.filter(site => site !== '전국' && names.has(site));
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
    item.updated = ranked.map(entry => entry.record.updated).filter(dateOk).sort().at(-1) || '';
    item.sites = ranked.map(entry => normalizeSites(entry.record.sites)).find(list => list.length) || [];
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
        closed: deadlineInfo.key === 'closed'
      };
    });
    items.sort((a, b) => Number(a.closed) - Number(b.closed) || b.collectedDate.localeCompare(a.collectedDate) || a.order - b.order);
    return items;
  }
  const PAGE_SIZE = 10;
  function paginate(items, shown) {
    const list = items || [];
    const total = list.length;
    const count = Math.min(Math.max(0, shown || 0), total);
    return {items: list.slice(0, count), shown: count, total, hasMore: count < total};
  }
  function moreLabel(page) {
    return `더보기 (${page.shown}/${page.total})`;
  }
  function appliesToSite(item, site) {
    if (!site) return true;
    const sites = item.sites || [];
    if (site === '전국') return sites.includes('전국');
    return sites.includes(site) || sites.includes('전국');
  }
  function filterItems(items, {type = '', site = '', includeClosed = true} = {}) {
    return items.filter(item => (!type || item.type === type) && appliesToSite(item, site) && (includeClosed || !item.closed));
  }
  function selectionForCopy(matched, selectedIds) {
    const chosen = (matched || []).filter(item => selectedIds && selectedIds.has(item.id));
    return chosen.length ? chosen : (matched || []);
  }
  function siteLabel(sites) {
    const names = normalizeSites(sites);
    if (!names.length) return '';
    if (names.includes('인천') && names.includes('안양')) return '[인천·안양] ';
    return '[' + names[0] + '] ';
  }
  function copyDeadline(item) {
    const note = text(item && item.deadline_note);
    if (dateOk(item && item.deadline)) {
      const time = note.match(/\d{1,2}:\d{2}/);
      return '마감 ' + item.deadline + (time ? ' ' + time[0] : '');
    }
    return note || '상시모집';
  }
  function copyBlocks(items) {
    return (items || []).map(item => {
      const title = siteLabel(item.sites) + (text(item.title) || '제목 없음');
      const href = safeHref(item.url) || text(item.url) || '원문 미기재';
      return title + '\n' + href + '\n' + copyDeadline(item);
    }).join('\n\n');
  }
  function itemIds(data) {
    return prepareItems(data).map(item => item.id);
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
    const detail = !!grid;
    if (!detail && !homeMetaNode) return;
    const tracker = win.NewsBadge?.create('support-resources', {detail});
    let loaded = null;
    function sync(data) {
      loaded = data;
      const ids = itemIds(data);
      tracker?.update(ids);
      if (homeMetaNode) homeMetaNode.textContent = homeMeta(data, seoulToday());
    }
    const status = $('support-status');
    const toolbar = $('support-toolbar');
    const types = $('support-types');
    const siteFilters = $('support-sites');
    const includeClosedInput = $('support-include-closed');
    const count = $('support-count');
    const empty = $('support-empty');
    const emptyText = $('support-empty-text');
    const reset = $('support-reset');
    const updated = $('support-updated');
    let items = [];
    let selectedType = '';
    let selectedSite = '';
    let includeClosed = true;
    let ready = false;
    let shown = PAGE_SIZE;
    const more = $('support-more');
    const copyButton = $('support-copy');
    const copyStatus = $('support-copy-status');
    const selectedHint = $('support-selected');
    const selected = new Set();
    let copyTimer = 0;
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
        button.addEventListener('click', () => { selectedType = item.id; render({reset:true}); });
        types.append(button);
      });
    }
    function renderSites() {
      if (!siteFilters) return;
      const present = new Set(items.flatMap(item => item.sites || []));
      if (selectedSite && !present.has(selectedSite)) selectedSite = '';
      siteFilters.replaceChildren();
      [{id:'', label:'전체 지점'}, ...SITES.filter(site => present.has(site)).map(site => ({id:site, label:site}))].forEach(item => {
        const button = el('button', 'ui-button', item.label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(selectedSite === item.id));
        button.addEventListener('click', () => { selectedSite = item.id; render({reset:true}); });
        siteFilters.append(button);
      });
    }
    function chosenIn(matched) {
      return matched.filter(item => selected.has(item.id));
    }
    function updateCopyHint(matched) {
      const count = chosenIn(matched).length;
      if (!selectedHint) return;
      selectedHint.hidden = count === 0;
      selectedHint.textContent = count ? count + '개 선택' : '';
    }
    function showCopyStatus(message) {
      if (!copyStatus) return;
      copyStatus.textContent = message;
      win.clearTimeout(copyTimer);
      copyTimer = win.setTimeout(() => { copyStatus.textContent = ''; }, 2000);
    }
    function fillCard(card, item) {
      const head = el('div', 'support-card-head');
      const title = el('h2');
      title.append(el('span', 'support-title', item.title || '제목 없음'));
      const mark = win.NewsBadge?.todayMark(doc, item.collectedDate, item.updated);
      if (mark) title.append(mark);
      head.append(title);
      if (item.type) head.append(el('span', 'ui-status', item.type));
      card.append(head);
      if (item.sites && item.sites.length) {
        const badges = el('div', 'support-sites');
        badges.setAttribute('aria-label', '적용 지점');
        item.sites.forEach(site => {
          const kind = site === '인천' ? 'incheon' : site === '안양' ? 'anyang' : 'national';
          const badge = el('span', 'support-site support-site--' + kind, site);
          badges.append(badge);
        });
        card.append(badges);
      }
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
    function render(options = {}) {
      if (!detail) return;
      if (options.reset) shown = PAGE_SIZE;
      const matched = filterItems(items, {type:selectedType, site:selectedSite, includeClosed});
      const page = paginate(matched, shown);
      count.textContent = '항목 ' + matched.length + '건';
      count.hidden = items.length === 0;
      grid.replaceChildren();
      updateCopyHint(matched);
      page.items.forEach(item => {
        const href = safeHref(item.url);
        const card = el('article', 'support-card' + (item.closed ? ' is-closed' : ''));
        const pick = el('label', 'support-select');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = selected.has(item.id);
        box.setAttribute('aria-label', (item.title || '항목') + ' 선택');
        box.addEventListener('change', () => {
          if (box.checked) selected.add(item.id);
          else selected.delete(item.id);
          updateCopyHint(matched);
        });
        pick.append(box);
        const body = href ? el('a', 'support-card-body') : el('div', 'support-card-body');
        if (href) {
          body.href = href;
          body.target = '_blank';
          body.rel = 'noopener noreferrer';
          body.title = '원문을 새 탭에서 엽니다';
        }
        fillCard(body, item);
        card.append(pick, body);
        grid.append(card);
      });
      if (more) {
        more.hidden = !page.hasMore;
        more.textContent = moreLabel(page);
      }
      const catalogEmpty = ready && items.length === 0;
      const filterEmpty = ready && !catalogEmpty && matched.length === 0;
      if (toolbar) toolbar.hidden = catalogEmpty;
      empty.hidden = !catalogEmpty && !filterEmpty;
      if (catalogEmpty) {
        emptyText.textContent = '아직 등록된 항목이 없어요. 평일마다 새 항목이 추가됩니다.';
        reset.hidden = true;
      } else if (filterEmpty) {
        emptyText.textContent = '이 조건에 맞는 항목이 없습니다. 유형, 지점, 마감 표시를 바꿔 보세요.';
        reset.hidden = false;
      }
      types.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String((button.textContent === '전체' && !selectedType) || button.textContent === selectedType)));
      siteFilters?.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String((button.textContent === '전체 지점' && !selectedSite) || button.textContent === selectedSite)));
    }
    if (detail) {
      includeClosedInput.addEventListener('change', () => { includeClosed = includeClosedInput.checked; render({reset:true}); });
      reset.addEventListener('click', () => {
        selectedType = '';
        selectedSite = '';
        includeClosed = true;
        includeClosedInput.checked = true;
        render({reset:true});
        types.querySelector('button')?.focus();
      });
      function copyNow(payload) {
        const area = el('textarea');
        area.value = payload;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0';
        doc.body.append(area);
        area.focus();
        area.select();
        area.setSelectionRange(0, area.value.length);
        let ok = false;
        try { ok = doc.execCommand('copy'); } catch { ok = false; }
        area.remove();
        return ok;
      }
      copyButton?.addEventListener('click', () => {
        const matched = filterItems(items, {type:selectedType, site:selectedSite, includeClosed});
        const picked = selectionForCopy(matched, selected);
        if (!picked.length) { showCopyStatus('복사할 항목이 없습니다'); return; }
        const payload = copyBlocks(picked);
        const done = message => showCopyStatus(message);
        if (copyNow(payload)) { done(picked.length + '건 복사됨'); return; }
        const clipboard = win.navigator.clipboard;
        if (clipboard && win.isSecureContext) {
          clipboard.writeText(payload).then(() => done(picked.length + '건 복사됨'), () => done('복사하지 못했습니다'));
          return;
        }
        done('복사하지 못했습니다');
      });
      more?.addEventListener('click', () => {
        const before = grid.children.length;
        shown += PAGE_SIZE;
        render();
        if (more.hidden) grid.children[before]?.focus();
        else more.focus();
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
          renderSites();
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
  return {TYPES, SITES, prepareItems, filterItems, selectionForCopy, copyBlocks, copyDeadline, siteLabel, normalizeSites, deadlineLabel, scheduleText, itemIds, paginate, moreLabel, PAGE_SIZE, homeMeta, safeHref, canonicalUrl, canonicalName, seoulToday, mount};
});
