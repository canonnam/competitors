const test=require('node:test');
const assert=require('node:assert/strict');
const {prepare,pathFor,render,start}=require('./assets/dashboard-ads.js');
const row=(date,impressions,clicks,level='campaign')=>({date,impressions,clicks,level});
const report={branch:'인천점',through:'2026-09-21',updated_at:'2026-09-22T10:30:00+09:00',sync:{enabled:true,stale:false},daily:[row('2026-09-08',100,2),row('2026-09-08',50,1),row('2026-09-08',999,88,'creative'),row('2026-09-21',0,0),row('2026-09-07',800,8),row('2026-09-22',700,7)]};
test('recent 14 day campaign totals exclude creatives and dates outside the report window',()=>{
  const view=prepare(report);
  assert.equal(view.rows.length,14);assert.equal(view.start,'2026-09-08');assert.equal(view.end,'2026-09-21');
  assert.deepEqual(view.total,{impressions:150,clicks:3});
  assert.equal(view.known,2);assert.equal(view.rows[0].impressions,150);
});
test('missing observations are gaps, whereas a verified zero remains a plotted value',()=>{
  const view=prepare(report);
  assert.equal(view.rows[1].impressions,null);assert.equal(view.rows[13].impressions,0);
  const path=pathFor(view.rows,'impressions',150);
  assert.equal((path.match(/M/g)||[]).length,2);assert.equal((path.match(/L/g)||[]).length,0);
  assert.doesNotMatch(path,/NaN|Infinity/);
  assert.match(render({data:report}),/14일 중 2일 확인/);
});
test('zero delivery is distinct from initial loading, no data and failure',()=>{
  const data={...report,daily:Array.from({length:14},(_,i)=>row(`2026-09-${String(i+8).padStart(2,'0')}`,0,0))};
  const view=prepare(data);assert.equal(view.known,14);assert.equal(view.total.clicks,0);
  assert.match(render({data}),/기록된 노출·클릭이 없습니다/);
  assert.doesNotMatch(render({data}),/NaN|Infinity/);
  assert.match(render(),/불러오는 중/);
  assert.match(render({error:true}),/불러오지 못했습니다/);
  assert.match(render({data:{daily:[],through:null}}),/아직 수집된/);
  assert.equal(prepare({daily:[],through:'2026-09-21'}).total.clicks,null);
});
test('stale, disconnected and retained results are disclosed and labels escaped',()=>{
  assert.match(render({data:{...report,sync:{stale:true}}}),/갱신 지연/);
  assert.match(render({data:{...report,sync:{enabled:false}}}),/자동 갱신 연결 대기/);
  assert.match(render({data:report,error:true}),/이전에 불러온 결과/);
  assert.match(render({data:report},true),/<details open>/);
  assert.doesNotMatch(render({data:{...report,branch:'<img src=x>'}}),/<img/);
  assert.equal((render({data:report}).match(/<svg /g)||[]).length,2);
});
test('invalid dates and unknown or negative metrics are rejected, not coerced to zero',()=>{
  for(const invalid of [{daily:null},{...report,through:'2026-02-30'},{...report,daily:[row('2026-09-21',null,1)]},{...report,daily:[row('2026-09-21',100,-1)]}])assert.throws(()=>prepare(invalid));
});
test('collector reads the summary, prevents duplicate calls and preserves prior data on failure',async()=>{
  let resolve,called=0;
  const updates=[],events={};
  const win={document:{hidden:false,addEventListener(){}},addEventListener:(name,fn)=>events[name]=fn,setInterval(){},AbortSignal:{timeout(){}},fetch:async(url,options)=>{
    assert.equal(url,'/api/naver-ads?summary=1');assert.equal(options.cache,'no-store');called++;
    return new Promise(done=>resolve=done);
  }};
  const collector=start(win,{update:(id,data)=>updates.push({id,data}),fail:id=>updates.push({id,error:true})});
  await collector.refresh();assert.equal(called,1);
  resolve({ok:true,json:async()=>report});await new Promise(setImmediate);
  assert.equal(updates[0].id,'ads');assert.deepEqual(updates[0].data,report);
  const pending=collector.refresh();resolve({ok:false});await pending;
  assert.equal(updates.at(-1).error,true);
});
