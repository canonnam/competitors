const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  prepareItems, filterItems, deadlineLabel, scheduleText, itemIds, freshIds, visitUnseen, paginate, moreLabel, PAGE_SIZE, homeMeta, safeHref, canonicalUrl, seoulToday
} = require('./assets/support-resources.js');
const {features, matchFeatures, supportResourceIds} = require('./assets/navigation.js');

const TODAY = '2026-11-03';
const stored = JSON.parse(fs.readFileSync('data/support_resources.json', 'utf8'));

function item(overrides) {
  return {
    id: 'id',
    title: '제목',
    org: '기관',
    type: '체험',
    summary: '요약',
    target: '노인요양시설',
    region: '전국',
    apply_start: null,
    deadline: null,
    how_to_apply: '원문에서 신청',
    url: 'https://example.com/item',
    collected_date: TODAY,
    ...overrides
  };
}

const sample = {updated: TODAY, items: [
  item({id:'performance', title:'음악 공연', org:'문화재단', type:'무료공연·문화프로그램', summary:'', deadline:'2026-11-10', apply_start:'2026-10-01', url:'https://www.Example.com/show/', collected_date:TODAY}),
  item({id:'performance-old', title:'음악  공연', org:'문화재단', type:'무료공연·문화프로그램', summary:'요양원 공연', deadline:null, url:'http://example.com/show', collected_date:'2026-10-01', sources:[{id:'clip', title:'음악 공연', org:'문화재단', url:'https://news.example.com/clip', collected_date:'2026-09-01'}]}),
  item({id:'bridge', title:'다른 제목', org:'다른 기관', type:'후원품·물품', summary:'', url:'http://example.com/show', collected_date:'2026-10-20'}),
  item({id:'goods', title:'물품 후원', org:'복지관', type:'후원품·물품', summary:'기저귀', deadline:null, url:'https://example.com/goods?b=2&a=1', collected_date:'2026-10-20'}),
  item({id:'goods-copy', title:'물품 후원', org:'복지관', type:'후원품·물품', summary:'', url:'https://example.com/goods?a=1&b=2', collected_date:'2026-10-02'}),
  item({id:'past', title:'지난 봉사', org:'대학', type:'재능기부·자원봉사', summary:'이미 마감', deadline:'2026-10-01', url:'https://example.com/past', collected_date:'2026-11-02'}),
  item({id:'today', title:'오늘 체험', org:'박물관', type:'체험', summary:'오늘 마감', deadline:TODAY, url:'https://example.com/today', collected_date:'2026-10-27'}),
  item({id:'older', title:'오래된 체험', org:'도서관', type:'체험', summary:'8일 전 수집', deadline:'2026-10-15', url:'https://example.com/older', collected_date:'2026-10-26'}),
  item({id:'script', title:'잘못된 주소', org:'기관', type:'체험', summary:'스크립트', url:'javascript:alert(1)', collected_date:TODAY}),
  {id:'', title:'빠진 id'},
  null
]};

test('the stored notices keep both collection days without merging duplicates', () => {
  const rows = prepareItems(stored, TODAY);
  const byId = Object.fromEntries(rows.map(entry => [entry.id, entry]));
  const added = ['anyang-lifelong-donate', 'munhwabapsang-2026', 'handon-kimchi-2026', 'coad-autodoor'];
  assert.equal(stored.updated, '2026-11-05');
  assert.equal(stored.items.length, 11);
  assert.equal(rows.length, 11);
  assert.deepEqual(rows.map(entry => entry.id).slice(0, 4), added);
  assert.deepEqual(rows.map(entry => entry.id).slice(4), [
    'happygiver-donghaeng-2026', 'anyang-city-choir', 'ggac-welfare-performance',
    'kepco-happy-share', 'anyang-volunteer-1365', 'anyang-foodbank', 'gf-sponsor-activity'
  ]);
  assert.ok(rows.filter(entry => entry.collectedDate === TODAY).every(entry => entry.fresh && !entry.closed));
  assert.equal(byId['anyang-lifelong-donate'].collectedDate, '2026-11-05');
  assert.equal(byId['anyang-lifelong-donate'].closed, false);
  assert.ok(['munhwabapsang-2026', 'handon-kimchi-2026', 'coad-autodoor'].every(id => byId[id].collectedDate === '2026-11-04' && !byId[id].closed));
  assert.equal(rows.filter(entry => entry.type === '무료공연·문화').length, 5);
  assert.equal(rows.filter(entry => entry.type === '재능기부').length, 3);
  assert.equal(rows.filter(entry => entry.type === '후원품').length, 3);
  assert.equal(rows.filter(entry => entry.deadline === null).length, 7);
  assert.equal(rows.some(entry => entry.id === 'bupyeong-handbell-yeowoo'), false);
  assert.equal(scheduleText(byId['happygiver-donghaeng-2026']), '마감 2026-11-06 18:00 · D-3');
  assert.equal(byId['happygiver-donghaeng-2026'].event_date, '2026-11-28 15:00');
  assert.equal(byId['happygiver-donghaeng-2026'].contact, '070-4432-5155');
  assert.equal(scheduleText(byId['kepco-happy-share']), '작품별, 공연일 2~20일 전 신청 가능');
  assert.equal(scheduleText(byId['gf-sponsor-activity']), '접수 2026-10-27 ~ 2026-11-04 · D-1');
  assert.equal(byId['gf-sponsor-activity'].target, byId['gf-sponsor-activity'].region);
  assert.equal(scheduleText(byId['munhwabapsang-2026']), '마감 2026-11-10 모집 마감, 11/20 선정 발표(개별 통보) · D-7');
  assert.equal(scheduleText(byId['handon-kimchi-2026']), '접수 2026-10-23 ~ 2026-11-05 (목) · D-2');
  assert.equal(byId['handon-kimchi-2026'].contact, '원문 미기재');
  assert.match(byId['handon-kimchi-2026'].summary, /노인/);
  assert.equal(scheduleText(byId['coad-autodoor']), byId['coad-autodoor'].deadline_note);
  assert.equal(byId['coad-autodoor'].contact, '원문 미기재');
  assert.equal(byId['anyang-lifelong-donate'].deadline, null);
  assert.equal(scheduleText(byId['anyang-lifelong-donate']), '연 2회, 수시 신청');
  assert.equal(byId['anyang-lifelong-donate'].contact, '원문 미기재');
  assert.equal(new Set(rows.map(entry => canonicalUrl(entry.url))).size, 11);
  assert.ok(rows.every(entry => safeHref(entry.url)));
  assert.equal(homeMeta(stored, TODAY), '최근 수집 2026. 11. 05 · 11건');
  assert.deepEqual(supportResourceIds(stored), itemIds(stored));
  assert.deepEqual(new Set(itemIds(stored)), new Set(rows.map(entry => entry.id)));
  assert.deepEqual(visitUnseen(itemIds(stored), itemIds(stored).filter(id => !added.includes(id))).sort(), [...added].sort());
  assert.equal(homeMeta({items: []}, TODAY), '아직 등록된 항목이 없어요');
  const page = fs.readFileSync('support-resources.html', 'utf8');
  assert.match(page, /아직 등록된 항목이 없어요\. 평일마다 새 항목이 추가됩니다\./);
  assert.match(fs.readFileSync('assets/support-resources.js', 'utf8'), /noopener noreferrer/);
  assert.ok(fs.readFileSync('app.py', 'utf8').includes("support-resources.html"));
  assert.ok(fs.readFileSync('app.py', 'utf8').includes('support_resources.json'));
  assert.match(fs.readFileSync('data/SUPPORT_RESOURCES.md', 'utf8'), /deadline_note/);
});

test('the same url, organization and title, or id collapse into one newest record', () => {
  const items = prepareItems(sample, TODAY);
  const performance = items.find(entry => entry.id === 'performance');
  assert.equal(items.filter(entry => entry.title.replace(/\s+/g, ' ') === '음악 공연' || entry.id === 'bridge').length, 1);
  assert.equal(performance.summary, '요양원 공연');
  assert.equal(performance.collectedDate, TODAY);
  assert.equal(canonicalUrl(performance.url), 'example.com/show');
  assert.ok(performance.sources.some(source => source.id === 'performance-old'));
  assert.ok(performance.sources.some(source => source.id === 'bridge'));
  assert.ok(performance.sources.some(source => source.id === 'clip'));
  const goods = items.find(entry => entry.id === 'goods');
  assert.equal(items.filter(entry => entry.org === '복지관').length, 1);
  assert.equal(goods.sources.filter(source => source.id === 'goods-copy').length, 1);
  assert.equal(items.some(entry => entry.id === ''), false);
  assert.equal(safeHref(items.find(entry => entry.id === 'script').url), '');
  assert.equal(safeHref('https://example.com/today'), 'https://example.com/today');
});

test('collected dates lead, closed notices sink, and deadlines keep D-day labels', () => {
  const items = prepareItems(sample, TODAY);
  assert.deepEqual(items.map(entry => entry.id), ['performance', 'script', 'today', 'goods', 'past', 'older']);
  assert.equal(items.at(-1).id, 'older');
  assert.deepEqual(items.filter(entry => entry.closed).map(entry => entry.id), ['past', 'older']);
  assert.deepEqual(items.find(entry => entry.id === 'performance').deadlineInfo, {key:'soon', text:'D-7', days:7});
  assert.equal(deadlineLabel(TODAY, TODAY).text, '오늘 마감');
  assert.equal(deadlineLabel(null, TODAY).text, '상시·미정');
  assert.equal(deadlineLabel('2026-11-02', TODAY).key, 'closed');
  assert.match(scheduleText(items.find(entry => entry.id === 'performance')), /접수 2026-10-01 ~ 2026-11-10 · D-7/);
  assert.equal(scheduleText(items.find(entry => entry.id === 'goods')), '상시·미정');
  assert.equal(scheduleText(items.find(entry => entry.id === 'today')), '마감 2026-11-03 · 오늘 마감');
  const open = items.filter(entry => !entry.closed);
  assert.deepEqual(open.map(entry => entry.collectedDate), [...open.map(entry => entry.collectedDate)].sort((a, b) => b.localeCompare(a)));
});

test('menu identities are every merged notice and this visit still lists unseen ids', () => {
  const items = prepareItems(sample, TODAY);
  assert.deepEqual(new Set(itemIds(sample)), new Set(items.map(entry => entry.id)));
  assert.deepEqual(supportResourceIds(sample), itemIds(sample));
  assert.ok(supportResourceIds(sample).includes('older'));
  assert.equal(items.find(entry => entry.id === 'older').fresh, false);
  assert.deepEqual(items.filter(entry => entry.fresh).map(entry => entry.id), ['performance', 'script', 'today', 'past']);
  assert.deepEqual(visitUnseen(itemIds(sample), ['performance', 'script']), itemIds(sample).filter(id => id !== 'performance' && id !== 'script'));
  assert.deepEqual(visitUnseen(['a'], ['a']), []);
  assert.equal(homeMeta(sample, TODAY), '최근 수집 2026. 11. 03 · 6건');
  assert.equal(seoulToday(new Date('2026-11-02T15:30:00Z')), '2026-11-03');
  assert.equal(seoulToday(new Date('2026-11-02T14:30:00Z')), '2026-11-02');
  const aged = prepareItems({items:[item({id:'edge', collected_date:'2026-10-27', deadline:'2026-11-20'})]}, TODAY);
  assert.equal(aged[0].fresh, true);
  assert.equal(prepareItems({items:[item({id:'late', collected_date:'2026-10-26'})]}, TODAY)[0].fresh, false);
});

test('type chips and the closed toggle narrow the same sorted list', () => {
  const items = prepareItems(sample, TODAY);
  assert.equal(filterItems(items, {type:'없는유형'}).length, 0);
  const talent = filterItems(items, {type:'재능기부·자원봉사'});
  assert.deepEqual(talent.map(entry => entry.id), ['past']);
  const hidden = filterItems(items, {includeClosed:false});
  assert.equal(hidden.some(entry => entry.closed), false);
  assert.equal(hidden.at(-1).collectedDate <= hidden[0].collectedDate, true);
  assert.equal(filterItems(items, {type:'체험', includeClosed:false}).some(entry => entry.id === 'older'), false);
  assert.equal(filterItems(items, {type:'체험', includeClosed:true}).some(entry => entry.id === 'older'), true);
});

test('home, menu and cache keys expose the support resource list', () => {
  const feature = features.find(entry => entry.id === 'support-resources');
  assert.equal(feature.category, 'support');
  assert.equal(feature.href, '/support-resources.html');
  assert.equal(matchFeatures('재능기부', 'support')[0].id, 'support-resources');
  assert.equal(matchFeatures('무료 공연').some(entry => entry.id === 'support-resources'), true);
  assert.ok(fs.existsSync('support-resources.html'));
  const home = fs.readFileSync('index.html', 'utf8');
  assert.match(home, /<div class="card-heading"><h2>후원·재능기부<\/h2><span id="home-support-resources-new" class="news-new-mark"/);
  assert.match(home, /id="home-support-resources-meta" class="meta">최근 수집 확인 중/);
  assert.ok(home.includes('/assets/support-resources.js?v=20261105-more'));
  assert.ok(home.indexOf('/assets/news-badge.js') < home.indexOf('/assets/support-resources.js'));
  assert.ok(home.indexOf('/assets/support-resources.js') < home.indexOf('/assets/navigation.js'));
  for (const file of fs.readdirSync('.').filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(file, 'utf8');
    if (file === 'support-share.html' || file === 'staff-eval-session.html' || file === 'facility-map-login.html') {
      assert.equal(html.includes('/assets/support-resources.js'), false, file);
      continue;
    }
    assert.equal((html.match(/\/assets\/support-resources\.js/g) || []).length, 1, file);
    assert.ok(html.indexOf('/assets/support-resources.js') < html.indexOf('/assets/navigation.js'), file);
    assert.ok(html.includes('/assets/navigation.js?v=20261104-seen'), file);
    assert.ok(html.includes('/assets/news-badge.js?v=20261104-seen'), file);
  }
});

test('confirming support notices clears only that browser and a new id returns', () => {
  const vm = require('node:vm');
  function memory() {const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};}
  function boot(saved) {
    const listeners={};
    const context={localStorage:saved,document:{hidden:false},addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
    vm.runInNewContext(fs.readFileSync('assets/news-badge.js','utf8'), context);
    return {context, listeners};
  }
  const ids = itemIds(stored);
  const browserA = memory();
  const first = boot(browserA);
  const badge={hidden:true,title:'',setAttribute(){}};
  const home=first.context.NewsBadge.create('support-resources',{badge,seenLabel:'후원·재능기부 페이지'});
  home.update(ids);
  assert.equal(badge.hidden, false);
  assert.equal(first.context.NewsBadge.counts()['support-resources'], ids.length);
  const browserB = memory();
  const other = boot(browserB);
  other.context.NewsBadge.create('support-resources',{}).update(ids);
  assert.equal(other.context.NewsBadge.counts()['support-resources'], ids.length);
  first.context.NewsBadge.create('support-resources',{detail:true}).update(ids);
  home.update(ids);
  assert.equal(badge.hidden, true);
  assert.equal(first.context.NewsBadge.counts()['support-resources'], 0);
  assert.equal(other.context.NewsBadge.counts()['support-resources'], ids.length);
  const added = ids.concat(['new-notice']);
  home.update(added);
  assert.equal(badge.hidden, false);
  assert.equal(first.context.NewsBadge.counts()['support-resources'], 1);
  assert.deepEqual(visitUnseen(added, JSON.parse(browserA.getItem('vida-news-seen-v1:support-resources'))), ['new-notice']);
  other.context.NewsBadge.create('support-resources',{}).update(added);
  assert.equal(other.context.NewsBadge.counts()['support-resources'], added.length);
});

test('more button pages the filtered support list and a filter starts over', () => {
  assert.equal(PAGE_SIZE, 10);
  const items = prepareItems(stored, '2026-11-05');
  assert.ok(items.length > PAGE_SIZE);
  let shown = PAGE_SIZE;
  const first = paginate(items, shown);
  assert.equal(first.shown, 10);
  assert.equal(first.hasMore, true);
  assert.equal(moreLabel(first), `더보기 (10/${items.length})`);
  assert.equal(first.items[0].id, items[0].id);
  shown += PAGE_SIZE;
  const second = paginate(items, shown);
  assert.equal(second.shown, items.length);
  assert.equal(second.hasMore, false);
  assert.ok(second.items.filter(item => item.closed).every(item => item.deadlineInfo));
  const open = filterItems(items, {includeClosed:false});
  shown = PAGE_SIZE;
  const reset = paginate(open, shown);
  assert.equal(reset.total, open.length);
  assert.ok(reset.items.every(item => !item.closed));
  const typed = filterItems(items, {type: items[0].type});
  const typedPage = paginate(typed, PAGE_SIZE);
  assert.equal(typedPage.total, typed.length);
  assert.ok(typedPage.items.every(item => item.type === items[0].type));
  assert.deepEqual(visitUnseen(itemIds(stored), []), itemIds(stored));
  assert.ok(fs.readFileSync('support-resources.html', 'utf8').includes('id="support-more"'));
});
