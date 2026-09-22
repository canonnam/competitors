const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {prepare,profitScale,barGeometry,render,start}=require('./assets/dashboard-operating.js');
const Cards=require('./assets/operating-cards.js');
const report=JSON.parse(fs.readFileSync('data/operating_report.json','utf8'));
test('latest registered year shows chronological branch profit bars from the actual report',()=>{
  const view=prepare(report);assert.equal(view.month,'2026-08');
  assert.equal(view.year,'2026');assert.equal(view.rows.length,8);
  assert.deepEqual(view.rows.map(row=>row.month),Array.from({length:8},(_,i)=>'2026-0'+(i+1)));
  const html=render({data:report});
  for(const expected of ['2,145.3만원','703.3만원','-2,526.2만원','2026년','2026-09-16','자동 수집하지 않습니다'])assert.ok(html.includes(expected),expected);
  assert.doesNotMatch(html,/branch-card|profit-line|수입 대비 인건비/);
  for(const row of view.rows)for(const [i,branch] of view.branches.entries()) {
    assert.equal(row.profits[i],branch.months.find(m=>m.month===row.month).profit);
    assert.ok(html.includes(`data-profit="${row.profits[i]}"`));
    assert.ok(html.includes(`href="/operating-costs.html?year=2026&month=${row.month}"`));
  }
  assert.equal((html.match(/class="dash-profit-bar /g)||[]).length,16);
  assert.equal((html.match(/ is-latest/g)||[]).length,2);
  const reordered=structuredClone(report);reordered.branches.reverse();reordered.branches.forEach(b=>b.months.reverse());
  assert.deepEqual(prepare(reordered).rows,view.rows);
});
test('missing branches and months stay gaps, including months absent from both branches',()=>{
  const partial=structuredClone(report);partial.branches[1].months=partial.branches[1].months.filter(m=>m.month!=='2026-08');
  partial.branches.forEach(b=>b.months=b.months.filter(m=>m.month!=='2026-04'));
  assert.equal(prepare(partial).month,'2026-08');
  assert.deepEqual(prepare(partial).rows[3],{month:'2026-04',profits:[null,null]});
  assert.equal(prepare(partial).rows.at(-1).profits[1],null);
  const html=render({data:partial});assert.match(html,/자료 없음/);assert.doesNotMatch(html,/703.3만원/);
  assert.equal((html.match(/class="dash-profit-bar /g)||[]).length,13);
  assert.equal((html.match(/class="dash-profit-missing"/g)||[]).length,3);
  assert.match(render({data:{schemaVersion:1,branches:[]}}),/아직 등록된/);
  assert.ok(prepare({...partial,branches:[partial.branches[0]]}).rows.every(row=>row.profits[1]===null));
  const b=report.branches[0],m=b.months.at(-1);
  assert.match(Cards.render(b,m,b.months[0]),/전월 자료 없음/);
});

test('year rollover selects the latest data year without filling unreported future months',()=>{
  const next=structuredClone(report);next.branches[0].months.push({...next.branches[0].months.at(-1),month:'2027-02'});
  const view=prepare(next);assert.equal(view.year,'2027');assert.deepEqual(view.rows.map(r=>r.month),['2027-02']);
  assert.equal(view.rows[0].profits[1],null);
  assert.match(render({data:next}),/year=2027&month=2027-02/);
  assert.doesNotMatch(render({data:next}),/year=2026&month=/);
});

test('positive, negative, mixed, zero and small values use a finite shared zero baseline',()=>{
  const scale=profitScale(prepare(report).rows.flatMap(row=>row.profits.map(v=>v/10000)));
  assert.deepEqual(scale.ticks,[4000,3000,2000,1000,0,-1000,-2000,-3000]);
  for(const values of [[100,200],[-100,-200],[100,-200],[0,0],[.0001,-.0002],[]]) {
    const s=profitScale(values);assert.ok(s.max>s.min);assert.ok(s.zero>=0&&s.zero<=100);
    assert.ok(s.ticks.includes(0));
    for(const value of values) {
      const bar=barGeometry(value,s);
      assert.ok(Number.isFinite(bar.top)&&Number.isFinite(bar.height));
      assert.ok(bar.top>=-1e-10&&bar.top+bar.height<=100+1e-10);
      assert.ok(Math.abs((value>0?bar.top+bar.height:bar.top)-s.zero)<1e-10);
      if(value===0)assert.equal(bar.height,0);
    }
  }
  const zeros=structuredClone(report);zeros.branches.forEach(b=>b.months.forEach(m=>m.profit=0));
  const html=render({data:zeros});assert.doesNotMatch(html,/NaN|Infinity|dash-profit-missing/);assert.match(html,/0.0만원/);
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
