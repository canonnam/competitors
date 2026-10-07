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

test('Powerlink campaigns stay separate while channel and overall totals include both exactly once', () => {
  const row=(entity,title,impressions,clicks,cost,date='2026-09-06',level='campaign')=>({entity,title,channel:'파워링크',date,level,impressions,clicks,cost});
  const data={since:'2025-02-01',daily:[
    row('power-2','파워링크#2',100,5,900),row('power-3','파워링크#3',900,9,2700),
    row('creative-3','소재',900,9,2700,'2026-09-06','creative'),
    row('power-3','파워링크#3',10,1,20,'2026-09-05'),
    row('power-1','파워링크#1',0,0,0),row('old-3','파워링크#3',0,0,0)
  ]};
  const result=selection(data,'2026-09-06','2026-09-06');
  assert.equal(result.campaigns.length,4);
  assert.equal(result.campaigns.find(r=>r.key==='power-2').clicks,5);
  assert.equal(result.campaigns.find(r=>r.key==='power-3').clicks,9);
  assert.equal(result.channels.length,1);
  assert.deepEqual(result.channels.map(r=>[r.key,r.impressions,r.clicks,r.cost]),[['파워링크',1000,14,3600]]);
  assert.equal(result.total.clicks,14);
  assert.ok(Math.abs(result.total.ctr-1.4)<1e-12);
  assert.equal(result.total.cpc,3600/14);
  assert.equal(result.previous.clicks,1);
  assert.equal(result.campaigns.find(r=>r.key==='power-1').cpc,null);
});
