const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('assets/claim-check.js', 'utf8');

async function render(laborCost, laborHistory = []) {
  const sections = [{html: '', insertAdjacentHTML(_, html) { this.html += html; }}, {html: '', insertAdjacentHTML(_, html) { this.html += html; }}];
  const nodes = Object.fromEntries(['claim-period', 'claim-deadline', 'claim-due-state', 'claim-sync', 'claim-refresh'].map(id => [id, {textContent: '', addEventListener() {}}]));
  nodes['claim-branches'] = {innerHTML: '', querySelectorAll: () => sections};
  const branch = {name: '안양점', status: 'accepted', label: '접수 완료', message: '필수 3개 항목 심사', checkedAt: '2026-09-10T13:52:10+09:00', claims: [], missing: [], laborCost, laborHistory};
  vm.runInNewContext(source, {
    document: {getElementById: id => nodes[id] || null, addEventListener() {}},
    fetch: async () => ({ok: true, json: async () => ({benefitMonth: '2026-08', deadline: '2026-09-10', allAccepted: true, branches: [branch, {...branch, name: '인천점'}]})}),
    AbortSignal: {timeout() {}}, Intl, Date, setInterval() {},
  });
  await new Promise(setImmediate);
  return {sections, nodes};
}

(async () => {
  const base = {benefitMonth: '2026-07', year: 2026, status: 'verified', annualRatio: '63.20', checkedAt: '2026-09-20T22:00:00+09:00', benchmarkRatio: '62.5', assessment: 'stable'};
  const verified = await render(base);
  assert.match(verified.sections[0].html, /63\.20<span>%/);
  assert.match(verified.sections[0].html, /2026년 7월/);
  assert.match(verified.sections[0].html, /16번 연간비율/);
  assert.match(verified.sections[0].html, /data-status="success">안정/);
  assert.match(verified.sections[1].html, /인천점 인건비 비율/);
  const equal = await render({...base, annualRatio: '62.50', assessment: 'check'});
  assert.match(equal.sections[0].html, /data-status="warning">점검 필요/);
  const zero = await render({...base, annualRatio: '0', assessment: 'check'});
  assert.match(zero.sections[0].html, /0<span>%/);
  const failed = await render({...base, status: 'query_failed', annualRatio: null, checkedAt: null, assessment: 'unverified', lastQueryFailureAt: '2026-09-20T22:00:00+09:00'});
  assert.match(failed.sections[0].html, /미확인/);
  assert.match(failed.sections[0].html, /인건비 조회 실패/);
  assert.doesNotMatch(failed.sections[0].html, /0<span>%/);
  assert.equal(failed.nodes['claim-due-state'].textContent, '두 지점 접수 완료');
  const escaped = await render({...base, annualRatio: '<img src=x>'});
  assert.doesNotMatch(escaped.sections[0].html, /<img/);
  assert.match(verified.sections[0].html, /금액 미수집/);
  const amounts = {status: 'verified', checkedAt: base.checkedAt, reflectedCost: '89801260', reflectedAddition: '3714100', unreflectedCost: '0', unreflectedAddition: '12345678901234567890'};
  const collected = await render({...base, amounts});
  for (const amount of ['89,801,260원', '3,714,100원', '0원', '12,345,678,901,234,567,890원']) assert.ok(collected.sections[0].html.includes(amount));
  assert.match(collected.sections[0].html, /② 반영 금액/);
  assert.match(collected.sections[0].html, /③ 미반영 금액/);
  const amountsFailed = await render({...base, amounts: {status: 'query_failed', lastQueryFailureAt: base.checkedAt}});
  assert.match(amountsFailed.sections[0].html, /금액 조회 실패/);
  assert.doesNotMatch(amountsFailed.sections[0].html, /0원/);
  const retained = await render({...base, amounts: {...amounts, lastQueryFailureAt: base.checkedAt}});
  assert.match(retained.sections[0].html, /이전에 확인한 금액을 유지/);
  const invalidAmount = await render({...base, amounts: {...amounts, reflectedCost: '<img src=x>'}});
  assert.doesNotMatch(invalidAmount.sections[0].html, /<img/);
  const history = await render(base, [{...base, benefitMonth: '2026-08', amounts}, {...base, benefitMonth: '2026-09', amounts: {...amounts, reflectedCost: '123'}}]);
  assert.match(history.sections[0].html, /월별 인건비 조회 이력 \(2개월\)/);
  assert.match(history.sections[0].html, /2026년 8월 조회 기준/);
  assert.match(history.sections[0].html, /2026년 9월 조회 기준/);
  assert.match(history.sections[0].html, /123원/);
  console.log('Claim ratio and four amount rendering passed, including exact zero, large integers, missing, retained and failed values.');
})().catch(error => { console.error(error); process.exitCode = 1; });
