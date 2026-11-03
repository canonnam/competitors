const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {prepareIdeas, filterIdeas, effectiveDate, safeHref} = require('./assets/trend.js');

const data = JSON.parse(fs.readFileSync('data/trend_ideas.json', 'utf8'));
const ideas = prepareIdeas(data);

test('merged trend ideas stay newest-first and keep blocked links', () => {
  assert.equal(data.updated, '2026-11-03');
  assert.equal(ideas.length, 48);
  assert.equal(ideas.reduce((sum, idea) => sum + idea.articles.length, 0), 84);
  assert.equal(ideas.filter(idea => idea.articles.length >= 2).length, 27);
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

test('tag and search filters narrow the same sorted list', () => {
  assert.equal(filterIdeas(ideas, {tag:'없는태그'}).length, 0);
  const award = filterIdeas(ideas, {query:'상장'});
  assert.ok(award.some(idea => idea.id === 'resident-award-certificate'));
  assert.ok(award.every(idea => idea.lastDate >= award.at(-1).lastDate));
  const tagged = filterIdeas(ideas, {tag:'홍보', query:'식단표'});
  assert.ok(tagged.some(idea => idea.id === 'menu-consult-phone'));
  assert.ok(tagged.every((idea, index) => index === 0 || idea.lastDate <= tagged[index - 1].lastDate));
});
