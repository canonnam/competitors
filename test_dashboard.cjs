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
const visibility=(overrides={},data={})=>({enabled:true,keyword_source:{stale:false},providers:[{id:'naver',configured:true,expected:19,checked:1,first_page:0,items:[],...overrides},{id:'gemini_web',checked:6,mentioned:1}],...data});
test('search exposure replaces the claim metric and uses only the current measured denominator',()=>{
  const result=snapshot({visibility:record(visibility())}),card=metric(result,'visibility');
  assert.equal(metric(result,'claims'),undefined);assert.equal(result.metrics.length,4);
  assert.equal(card.title,'검색노출 현황');assert.equal(card.href,'/search-visibility.html');
  assert.equal(card.value,'0 / 1개');assert.match(card.note,/광고 제외.*점검 1\/19개 완료/);assert.equal(card.warning,true);
  const complete=metric(snapshot({visibility:record(visibility({expected:8,checked:8,first_page:3}))}),'visibility');
  assert.equal(complete.value,'3 / 8개');assert.equal(complete.warning,false);
});
test('pending, prior observations, invalid counts and failures never become zero exposure',()=>{
  for(const provider of [{checked:0,items:[{status:'pending',stale:true,first_page:1,observed_at:'2026-09-14'}]},
    {checked:0,items:[{status:'error'}]},{configured:false},{checked:null},{first_page:2},{checked:-1},{expected:0,checked:0}]) {
    const card=metric(snapshot({visibility:record(visibility(provider))}),'visibility');
    assert.equal(card.value,'—');assert.equal(card.warning,true);
  }
  const failed=metric(snapshot({visibility:{data:visibility(),error:true}}),'visibility');
  assert.equal(failed.value,'—');assert.match(failed.note,/연결 확인 필요/);
  assert.match(metric(snapshot({visibility:record(visibility({checked:0}))}),'visibility').note,/갱신 대기/);
});
test('stopped collection and old keyword sets retain explicit warnings',()=>{
  for(const [provider,data,reason] of [[{}, {enabled:false},'자동 점검 중지'],[{collection_paused:true},{},'수집 상태 확인 필요'],[{}, {keyword_source:{stale:true}},'키워드 갱신 대기']]) {
    const card=metric(snapshot({visibility:record(visibility({checked:19,first_page:3,...provider},data))}),'visibility');
    assert.equal(card.warning,true);assert.ok(card.note.includes(reason));
  }
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
