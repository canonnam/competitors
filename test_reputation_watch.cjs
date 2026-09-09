const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const r=require('./assets/reputation-watch.js');
function data(){return {sync:{enabled:true,complete:true,running:false,checked_sources:6,expected_sources:6},counts:{concern:0,uncertain:0,reviewed:5,documents:5},analysis:{error:''},sources:[]};}
test('zero findings are explicitly scoped to checked public results',()=>{
  assert.match(r.headline(data()),/확인한 공개 검색 결과/);
  for(const patch of [{complete:false},{enabled:false},{complete:false,running:true}]){
    const value=data();Object.assign(value.sync,patch);
    assert.equal(r.state(value).warning,true);assert.doesNotMatch(r.headline(value),/찾지 못했습니다/);
  }
  const failed=data();failed.sync.complete=false;failed.analysis.error='분류 실패';
  assert.match(r.headline(failed),/점검 지연/);
});
test('uncertain and archived records are not counted as current negative claims',()=>{
  const items=[{active:true,verdict:'concern',identity:'incheon',title:'가상 자료',evidence:'가상 불만',publisher:'test'},
    {active:true,verdict:'uncertain',identity:'unknown'},{active:false,verdict:'concern',identity:'anyang'}];
  assert.equal(r.filterItems(items).length,2);
  assert.equal(r.filterItems(items,{filter:'concern'}).length,1);
  assert.equal(r.filterItems(items,{filter:'archived'}).length,1);
  assert.equal(r.filterItems(items,{branch:'incheon',query:'불만'}).length,1);
});
test('untrusted source text and links cannot become executable HTML',()=>{
  assert.equal(r.safeUrl('javascript:alert(1)'), '');assert.equal(r.safeUrl('https://user:password@example.com'), '');
  assert.equal(r.esc('<img src=x onerror=alert(1)>'),'&lt;img src=x onerror=alert(1)&gt;');
});
test('reputation card follows visibility and uses its own unseen-item marker',()=>{
  const html=fs.readFileSync('index.html','utf8');
  assert.ok(html.indexOf('<h2>검색노출 현황</h2>')<html.indexOf('<h2>더비다요양원 평판 점검</h2>'));
  assert.ok(html.includes('id="home-reputation-new"'));
  assert.ok(fs.readFileSync('assets/reputation-watch.js','utf8').includes("create('reputation'"));
});
