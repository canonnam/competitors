const test=require('node:test');
const assert=require('node:assert/strict');
const {snapshot,laborStatus}=require('./assets/dashboard.js');
const record=(data,status={})=>({data,status,error:false});
const metric=(view,id)=>view.metrics.find(item=>item.id===id);
test('loading and failed feeds cannot be reported as zero unread or a complete total',()=>{
  const loading=snapshot({});assert.ok(loading.metrics.every(item=>item.value==='—'));
  const partial=snapshot({competitor:record({}),agency:{error:true,status:{warning:true}}},{competitor:20,agency:8});
  assert.equal(metric(partial,'news').value,'—');
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
test('claim summary warns only for unaccepted branches',()=>{
  const claims={benefitMonth:'2026-08',branches:[{id:'anyang',name:'안양점',status:'accepted',lastQueryFailureAt:'2026-09-22'}, {id:'incheon',name:'인천점',status:'check',message:'청구 항목 확인 필요'}]};
  const result=snapshot({claims:record(claims)});
  assert.equal(metric(result,'claims').value,'1 / 2지점');assert.equal(metric(result,'claims').warning,true);
});
test('all accepted claims remain complete without warnings after historical query failures',()=>{
  const claims={benefitMonth:'2026-08',branches:['anyang','incheon'].map(id=>({id,status:'accepted',lastQueryFailureAt:'2026-09-10T20:04:28+09:00'}))};
  const result=snapshot({claims:record(claims)});
  assert.equal(metric(result,'claims').value,'2 / 2지점');assert.equal(metric(result,'claims').warning,false);
  assert.ok(claims.branches.every(branch=>branch.lastQueryFailureAt),'failure history is preserved');
});
test('current claim feed failures remain unknown without changing saved acceptance',()=>{
  const claims={benefitMonth:'2026-08',branches:[{id:'anyang',status:'accepted'}]};
  const result=snapshot({claims:{data:claims,error:true,status:{label:'연결 확인 필요',warning:true}}});
  assert.equal(metric(result,'claims').value,'—');assert.equal(metric(result,'claims').warning,true);
  assert.equal(claims.branches[0].status,'accepted');
});
test('incomplete reputation checks and previous keyword data are not labelled healthy',()=>{
  const result=snapshot({reputation:record({counts:{concern:0,uncertain:2}},{warning:true,label:'점검 지연'}),keywords:record({updated_at:'2026-09-20',top_count:6,eligible_top_count:0},{warning:true,label:'갱신 대기'})});
  assert.equal(metric(result,'keywords').value,'6개');assert.match(metric(result,'keywords').note,/이전 집계/);
});
test('labor ratio preserves server assessment, zero, unknown and prior verified values',()=>{
  const base={status:'verified',annualRatio:'63.7',assessment:'stable'};
  assert.deepEqual(laborStatus(base),{value:'63.7%',label:'안정',tone:'success'});
  assert.deepEqual(laborStatus({...base,annualRatio:'62.5',assessment:'check'}),{value:'62.5%',label:'점검 필요',tone:'warning'});
  assert.equal(laborStatus({...base,annualRatio:'0',assessment:'check'}).value,'0%');
  assert.equal(laborStatus({...base,lastQueryFailureAt:'2026-09-22'}).label,'안정');
  assert.equal(laborStatus({...base,assessment:'no_benchmark'}).label,'운영 기준 미설정');
  for(const labor of [undefined,{status:'query_failed',annualRatio:null}, {...base,annualRatio:null},{...base,annualRatio:'<script>'}])assert.equal(laborStatus(labor).value,'—');
  assert.equal(laborStatus({status:'query_failed'}).label,'조회 실패');
});
