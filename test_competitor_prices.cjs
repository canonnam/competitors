// Source observations and derivations are documented in PRICE_RESEARCH.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(`${__dirname}/assets/competitors-data.js`, 'utf8'), context);
const data = context.window.competitorData;

test('50-person displayed totals include VAT exactly once', () => {
  // Independent official observations: Easy base/excess rate, Yoyangsys
  // base/per-recipient rate, Angel facility net price and Carefor gross quote.
  const observations = [
    ['easy', (10000 + (50 - 10) * 500) * 1.1],
    ['yoyangsys', (10000 + 50 * 1000) * 1.1],
    ['angel', 120000 * 1.1],
    ['carefor', 77000],
    ['ecm', 132000]
  ];
  for (const [key, total] of observations) {
    assert.equal(data[key].price50.m, `월 ${Math.round(total).toLocaleString('ko-KR')}원 (부가세 포함)`, key);
  }
});

test('50 recipients are not silently treated as employees or a smaller plan', () => {
  assert.match(data.carefor.price50.u, /41~50인/);
  assert.match(data.angel.price50.u, /정원 50명.*50~69인/);
  assert.match(data.ecm.price50.u, /정원 50명.*50~99명/);
  assert.match(data.allcare.price50.m, /산정 불가/);
  assert.match(data.jipangi.price50.m, /산정 불가/);
  assert.match(data.well.price50.m, /PRO.*120,000/);
  assert.match(data.well.price50.u, /정가 월 200,000원/);
  assert.match(data.planner.price50.u, /50명.*명시되지 않음/);
  assert.match(data.aicareplus.price50.m, /관련.*66,000/);
});

test('every record exposes dated evidence and one consistent price to search', () => {
  assert.equal(Object.keys(data).length, 20);
  for (const item of Object.values(data)) {
    const price = item.price50;
    assert.match(price.checked, /^2026-09-0[89]$/, item.n);
    for (const field of ['m','o','u','b','v','s']) assert.ok(price[field], `${item.n}: ${field}`);
    assert.equal(new URL(price.s).protocol, 'https:');
    const facts = item.facts.filter(([label]) => label === '가격');
    assert.equal(facts.length, 1, item.n);
    assert.ok(facts[0][1].includes(price.m), item.n);
  }
  assert.match(data.salary.price50.m, /부가세 표기 미확인/);
  assert.match(data.hyodol.price50.o, /80,000,000.*90,000,000/);
  assert.match(data.easy.price50.o, /2026-09-30/);
});
