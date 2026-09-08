const test=require('node:test');
const assert=require('node:assert/strict');
const v=require('./assets/search-visibility.js');

test('search page numbers use observed result pages, never average ad ranks',()=>{
  const row={status:'ready',stale:false,query:{average_ad_rank:2.1},matches:[{area:'web',page:4,position:2},{area:'ad',page:1,position:1}]};
  assert.equal(v.matchLabel(row,['web']),'4페이지 · 2번째');
  assert.equal(v.matchLabel(row,['place']),'측정 범위 내 미확인');
  assert.equal(v.matchLabel({...row,status:'error',stale:true},['web']),'측정 불가');
});
test('unmeasured and failed probes never appear as non-exposure findings',()=>{
  const items=[{keyword:'인천',status:'pending'},{keyword:'인천',status:'error'},
    {keyword:'인천',status:'ready',stale:false,mentioned:false},{keyword:'안양',status:'ready',stale:false,mentioned:true}];
  assert.equal(v.filterRows(items,'','absent').length,1);
  assert.equal(v.filterRows(items,'인천','pending').length,2);
  assert.equal(v.filterRows(items,'','found').length,1);
});
test('AI excerpts escape untrusted text while linking safe inline citations',()=>{
  const html=v.citedAnswer({answer:'<img src=x onerror=alert(1)> 더비다',citations:[
    {url:'https://example.com/?a=1&b=2',title:'원문',end:30},{url:'javascript:alert(1)',title:'unsafe',end:2}]});
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));
  assert.ok(html.includes('https://example.com/?a=1&amp;b=2'));assert.ok(!html.includes('javascript:'));
  assert.equal(v.safeUrl('https://user:pass@example.com'),'');
});
test('home reports measured denominators and exposes partial setup',()=>{
  const data={enabled:true,keyword_source:{stale:false},providers:[
    {id:'naver',kind:'search',configured:true,expected:24,checked:10,first_page:3},
    {id:'openai',kind:'ai',configured:true,expected:6,checked:4,mentioned:1},
    {id:'gemini',kind:'ai',configured:false,expected:6,checked:0,mentioned:0}]};
  assert.equal(v.homeSummary(data).text,'네이버 첫 페이지 3/10개 · AI 언급 1/4건');
  assert.equal(v.homeSummary(data).warning,true);
});
