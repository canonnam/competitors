const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {prepare,render,start}=require('./assets/dashboard-operating.js');
const Cards=require('./assets/operating-cards.js');
const M=require('./assets/operating-model.js');
const report=JSON.parse(fs.readFileSync('data/operating_report.json','utf8'));
test('latest registered month and branch figures match the existing report cards',()=>{
  const view=prepare(report);assert.equal(view.month,'2026-08');
  const html=render({data:report});
  for(const expected of ['2,145.3만원','703.3만원','2,518.5만원','387.5만원','64.8%','65.7%','23.4%','6.4%','2026년 8월','2026-09-16','자동 수집하지 않습니다'])assert.ok(html.includes(expected),expected);
  for(const b of view.branches)assert.ok(html.includes(Cards.render(b,b.months.find(m=>m.month===view.month),b.months.find(m=>m.month===M.previousMonth(view.month)))));
  assert.match(html,/상환·자금 이동으로 실제 자금은 줄었습니다/);
});
test('a common latest month never mixes different periods or fills missing months with zero',()=>{
  const partial=structuredClone(report);partial.branches[1].months=partial.branches[1].months.filter(m=>m.month!=='2026-08');
  assert.equal(prepare(partial).month,'2026-08');
  const html=render({data:partial});assert.match(html,/이 달의 자료가 없습니다/);assert.doesNotMatch(html,/703.3만원/);
  assert.match(render({data:{schemaVersion:1,branches:[]}}),/아직 등록된/);
  const b=report.branches[0],m=b.months.at(-1);
  assert.match(Cards.render(b,m,b.months[0]),/전월 자료 없음/);
});
test('negative profit, zero revenue, repayment and refunds retain financial meaning',()=>{
  const b={id:'anyang',name:'안양점'},m={month:'2026-08',revenue:0,cost:10000,profit:-10000,cashChange:10000,accounts:[{group:'인건비',expense:-1000}]};
  const loss=Cards.render(b,m,null);
  assert.match(loss,/운영 적자/);assert.match(loss,/-1.0만원/);assert.match(loss,/차입·자금 유입이 운영 적자를 보완/);
  assert.doesNotMatch(loss,/Infinity|NaN/);
  assert.match(Cards.render(b,{...m,profit:0},null),/손익 균형/);
});
test('loading, failure, retained data and malformed reports remain distinct',()=>{
  assert.match(render(),/불러오는 중/);assert.match(render({error:true}),/불러오지 못했습니다/);
  assert.match(render({data:report,error:true}),/이전에 불러온 자료/);
  const bad=structuredClone(report);bad.branches[0].months.at(-1).profit=null;assert.throws(()=>prepare(bad));
  bad.branches[0].months.at(-1).profit=0;bad.branches[0].months.at(-1).month='2026-13';assert.throws(()=>prepare(bad));
  assert.throws(()=>prepare({...report,schemaVersion:2}));
  const unsafe=structuredClone(report);unsafe.branches[0].name='<img src=x>';unsafe.sourceDate='<script>';
  assert.doesNotMatch(render({data:unsafe}),/<img|<script/);
});
test('collector reads the existing endpoint without duplicate requests and signals failures',async()=>{
  let resolve,called=0;const updates=[];
  const win={document:{hidden:false,addEventListener(){}},addEventListener(){},setInterval(){},AbortSignal:{timeout(){}},fetch:async(url,options)=>{
    assert.equal(url,'/api/operating-report');assert.equal(options.cache,'no-store');called++;
    return new Promise(done=>resolve=done);
  }};
  const collector=start(win,{update:(id,data)=>updates.push({id,data}),fail:id=>updates.push({id,error:true})});
  await collector.refresh();assert.equal(called,1);
  resolve({ok:true,json:async()=>report});await new Promise(setImmediate);
  assert.equal(updates[0].id,'operating');assert.deepEqual(updates[0].data,report);
  const pending=collector.refresh();resolve({ok:false});await pending;assert.equal(updates.at(-1).error,true);
  win.document.hidden=true;await collector.refresh();assert.equal(called,2);
});
