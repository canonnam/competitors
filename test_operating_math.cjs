const assert=require('node:assert/strict');
const fs=require('node:fs');
const M=require('./assets/operating-model.js');
const report=JSON.parse(fs.readFileSync('data/operating_report.json','utf8'));
assert.equal(M.previousMonth('2026-01'),'2025-12');
assert.equal(M.combined([null,report.branches[1].months[0]]),null);
assert.equal(M.combined(report.branches.map(b=>b.months.at(-1))).profit,7176327);
for(const b of report.branches) for(const current of b.months) {
  const previous=b.months.find(m=>m.month===M.previousMonth(current.month));
  const drivers=M.drivers(current,previous);
  assert.equal(drivers.reduce((n,d)=>n+d.impact,0),previous?current.profit-previous.profit:0);
}
const a={month:'2026-02',accounts:[{group:'인건비',income:0,expense:100},{group:'기타 수입',income:50,expense:0}]};
const b={month:'2026-01',accounts:[{group:'인건비',income:0,expense:-50},{group:'기타 수입',income:100,expense:0}]};
assert.equal(M.drivers(a,b).reduce((n,d)=>n+d.impact,0),-200);
assert.deepEqual(M.drivers(a,{...b,month:'2025-12'}),[]);
const csv=M.csv(report,'2025');
assert.ok(csv.startsWith('\ufeff'));
assert.ok(csv.includes('자료 없음'));
assert.ok(!csv.includes('2026-'));
assert.equal(M.csv(report,'2026').split('\r\n').length,15);
console.log('Operating report arithmetic: all monthly changes reconcile; gaps, refunds and CSV verified.');
