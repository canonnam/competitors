const test=require('node:test');
const assert=require('node:assert/strict');
const {snapshot}=require('./assets/dashboard.js');
const record=(data,status={})=>({data,status,error:false});
const metric=(view,id)=>view.metrics.find(item=>item.id===id);
test('loading and failed feeds cannot be reported as zero unread or a complete total',()=>{
  const loading=snapshot({});assert.equal(loading.pending,6);assert.ok(loading.metrics.every(item=>item.value==='—'));
  const partial=snapshot({competitor:record({}),agency:{error:true,status:{warning:true}}},{competitor:20,agency:8});
  assert.equal(metric(partial,'news').value,'—');assert.equal(partial.attention.length,1);
});
test('news totals use unread counts, exclude reputation, and disclose stale results',()=>{
  const result=snapshot({competitor:record({total:80},{warning:true,label:'수집 지연'}),agency:record({total:50})},{competitor:4,agency:2,reputation:9});
  assert.equal(metric(result,'news').value,'6건');assert.match(metric(result,'news').note,/이전 수집/);
});
test('support before first collection stays unknown, then uses only recommended active count',()=>{
  const data={support:{total:18,active:2},sources:[{id:'bizinfo'}]};
  assert.equal(metric(snapshot({agency:record(data)}),'support').value,'—');
  data.sources[0].last_success='2026-09-22T00:10:00Z';
  assert.equal(metric(snapshot({agency:record(data)}),'support').value,'2건');
});
test('accepted claims with a failed requery remain visible but still require attention',()=>{
  const claims={benefitMonth:'2026-08',branches:[{id:'anyang',name:'안양점',status:'accepted',lastQueryFailureAt:'2026-09-22'}, {id:'incheon',name:'인천점',status:'check',message:'청구 항목 확인 필요'}]};
  const result=snapshot({claims:record(claims)});
  assert.equal(metric(result,'claims').value,'1 / 2지점');assert.equal(result.attention.length,2);assert.equal(metric(result,'claims').warning,true);
});
test('incomplete reputation checks and previous keyword data are not labelled healthy',()=>{
  const result=snapshot({reputation:record({counts:{concern:0,uncertain:2}},{warning:true,label:'점검 지연'}),keywords:record({updated_at:'2026-09-20',top_count:6,eligible_top_count:0},{warning:true,label:'갱신 대기'})});
  assert.equal(result.attention.length,3);assert.equal(metric(result,'keywords').value,'6개');assert.match(metric(result,'keywords').note,/이전 집계/);
});
