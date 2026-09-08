const assert = require('node:assert/strict');
const {test} = require('node:test');
const {sum, shift, selection, wilson, change} = require('./assets/naver-ads.js');

test('CTR and CPC are weighted from underlying counts, not averages', () => {
  const total = sum([{impressions:100,clicks:10,cost:1000},{impressions:900,clicks:9,cost:4500}]);
  assert.equal(total.ctr,1.9);
  assert.equal(total.cpc,5500/19);
  assert.equal(sum([]).cpc,null);
  assert.equal(sum([]).ctr,null);
  assert.equal(change(10,0),null);
});
test('date arithmetic crosses month, year and leap-year boundaries', () => {
  assert.equal(shift('2026-01-01',-1),'2025-12-31');
  assert.equal(shift('2024-03-01',-1),'2024-02-29');
});
test('selection excludes creatives from campaign totals and uses equal previous periods', () => {
  const data={since:'2026-08-01',daily:[
    {date:'2026-09-01',level:'campaign',channel:'PLACE',impressions:100,clicks:5,cost:100},
    {date:'2026-09-01',level:'creative',entity:'a',channel:'PLACE',impressions:100,clicks:5,cost:100},
    {date:'2026-08-31',level:'campaign',channel:'PLACE',impressions:100,clicks:2,cost:200},
    {date:'2026-09-02',level:'campaign',channel:'PLACE',impressions:100,clicks:90,cost:999}
  ]};
  const result=selection(data,'2026-09-01','2026-09-01');
  assert.equal(result.total.clicks,5);
  assert.equal(result.previous.clicks,2);
  assert.equal(result.prevStart,'2026-08-31');
  assert.equal(result.creatives.length,1);
  assert.equal(result.comparable,true);
  assert.equal(selection(data,'2026-08-01','2026-09-01').comparable,false);
});
test('Wilson intervals represent zero-click uncertainty, not certain failure', () => {
  assert.equal(wilson(0,0),null);
  const zero=wilson(0,100);
  assert.ok(zero[0]<1e-10);
  assert.ok(zero[1]>3 && zero[1]<4);
  const full=wilson(100,100);
  assert.ok(full[0]>96 && full[0]<97);
  assert.ok(Math.abs(full[1]-100)<1e-10);
});
