const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {prepareIdeas, filterIdeas, effectiveDate, safeHref, articleIds, ideaArticleIds, unseenIdeaIds, homeMeta} = require('./assets/trend.js');
const {trendArticleIds} = require('./assets/navigation.js');

const data = JSON.parse(fs.readFileSync('data/trend_ideas.json', 'utf8'));
const ideas = prepareIdeas(data);

test('merged trend ideas stay newest-first and keep blocked links', () => {
  assert.equal(data.updated, '2026-11-04');
  assert.equal(ideas.length, 53);
  assert.equal(ideas.reduce((sum, idea) => sum + idea.articles.length, 0), 89);
  assert.equal(ideas.filter(idea => idea.articles.length >= 2).length, 27);
  assert.equal(ideas[0].id, 'nursing-staff-share');
  assert.equal(ideas[0].lastDate, '2026-11-03');
  assert.deepEqual(ideas.map(idea => idea.lastDate), [...ideas.map(idea => idea.lastDate)].sort((a, b) => b.localeCompare(a)));
  for (const idea of ideas) {
    assert.equal(idea.lastDate, effectiveDate(idea));
    assert.deepEqual(idea.articles.map(article => article.date), [...idea.articles.map(article => article.date)].sort((a, b) => b.localeCompare(a)));
    assert.ok(idea.title && idea.summary);
  }
  const blocked = ideas.flatMap(idea => idea.articles).find(article => article.url.includes('kanghwa.or.kr'));
  assert.equal(blocked.verified, 'blocked');
  assert.equal(safeHref(blocked.url), blocked.url);
  const coffee = ideas.find(idea => idea.id === 'coffee-cart-event');
  assert.equal(coffee.articles.filter(article => article.url.includes('hshospi.com')).length, 2);
  assert.equal(ideas.find(idea => idea.id === 'garden-party-openday').articles.some(article => article.url.includes('/notices/')), true);
  assert.equal(ideas.find(idea => idea.id === 'external-performance-invite').articles.some(article => article.url.includes('pbsnews.kr')), true);
  assert.equal(ideas.filter(idea => idea.articles.some(article => article.url.includes('ptcsw.or.kr'))).length, 1);
  const created = ideas.find(idea => idea.id === 'menu-consult-phone');
  assert.equal(created.articles.length, 1);
  assert.match(created.summary, /아이디어$/);
  assert.equal(ideas[0].lastDate >= ideas.at(-1).lastDate, true);
});

test('a newer article on an old idea moves that card first', () => {
  const sample = {ideas: [
    {id:'old', title:'예전', summary:'예전 방식', tags:['홍보'], last_date:'2020-01-01', articles:[{title:'새 기사', source:'예', date:'2026-11-03', url:'https://example.com/new', verified:'ok'}]},
    {id:'recent', title:'최근', summary:'최근 방식', tags:['프로그램'], last_date:'2026-10-01', articles:[{title:'기존', source:'예', date:'2026-10-01', url:'https://example.com/old', verified:'ok'}]}
  ]};
  assert.equal(prepareIdeas(sample)[0].id, 'old');
  assert.equal(prepareIdeas(sample)[0].lastDate, '2026-11-03');
});

test('article identities follow each idea article and match the menu loader', () => {
  const ids = articleIds(data);
  assert.equal(ids.length, 89);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(trendArticleIds(data), ids);
  const sample = {ideas: [
    {id:'old', articles:[{date:'2026-11-03', url:'https://example.com/new'}, {date:'2020-01-01', url:'https://example.com/old'}]},
    {id:'recent', articles:[{date:'2026-10-01', url:'https://example.com/old'}]},
    {id:'', articles:[{date:'2026-11-03', url:'https://example.com/skip'}]},
    {id:'broken', articles:[null, {date:'어제', url:'https://example.com/bad'}, {date:'2026-01-02'}]}
  ]};
  assert.deepEqual(articleIds(sample), [
    'old\n2026-11-03\nhttps://example.com/new',
    'old\n2020-01-01\nhttps://example.com/old',
    'recent\n2026-10-01\nhttps://example.com/old'
  ]);
  assert.deepEqual(trendArticleIds(sample), articleIds(sample));
  assert.equal(homeMeta(data), '최근 기사 2026. 11. 03 · 아이디어 53개');
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /<div class="card-heading"><h2>트렌드<\/h2><span id="home-trend-new" class="news-new-mark"/);
  assert.match(html, /id="home-trend-meta" class="meta">최근 기사 확인 중/);
  assert.ok(html.includes('/assets/trend.js?v=20261104-cardn'));
  assert.ok(html.indexOf('/assets/news-badge.js') < html.indexOf('/assets/trend.js'));
  assert.ok(html.indexOf('/assets/trend.js') < html.indexOf('/assets/navigation.js'));
});

test('a trend card is new only while one of its articles is unseen at page open', () => {
  const ideas = prepareIdeas(data);
  assert.equal(unseenIdeaIds(ideas, []).length, ideas.filter(idea => ideaArticleIds(idea).length).length);
  const seen = articleIds(data);
  assert.deepEqual(unseenIdeaIds(ideas, seen), []);
  const withoutNursing = seen.filter(id => !id.startsWith('nursing-staff-share\n'));
  assert.deepEqual(unseenIdeaIds(ideas, withoutNursing), ['nursing-staff-share']);
  const merged = prepareIdeas({ideas: [
    {id:'old', title:'예전', summary:'예전 방식', tags:['프로그램'], last_date:'2020-01-01', articles:[
      {title:'기존', source:'예', date:'2020-01-01', url:'https://example.com/old', verified:'ok'},
      {title:'새 기사', source:'예', date:'2026-11-04', url:'https://example.com/new', verified:'ok'}
    ]}
  ]});
  assert.equal(merged[0].lastDate, '2026-11-04');
  assert.deepEqual(unseenIdeaIds(merged, ideaArticleIds(merged[0]).slice(1)), ['old']);
  assert.deepEqual(unseenIdeaIds(merged, ideaArticleIds(merged[0])), []);
});

test('tag and search filters narrow the same sorted list', () => {
  assert.equal(filterIdeas(ideas, {tag:'없는태그'}).length, 0);
  const award = filterIdeas(ideas, {query:'상장'});
  assert.ok(award.some(idea => idea.id === 'resident-award-certificate'));
  assert.ok(award.every(idea => idea.lastDate >= award.at(-1).lastDate));
  const tagged = filterIdeas(ideas, {tag:'홍보', query:'식단표'});
  assert.ok(tagged.some(idea => idea.id === 'menu-consult-phone'));
  assert.ok(tagged.every((idea, index) => index === 0 || idea.lastDate <= tagged[index - 1].lastDate));
});
