const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const missions=require('./assets/aeo-missions.js');
const q={checked_at:new Date().toISOString(),status:'checked',summary:'실제 점검',completed:[],next_tasks:['사이트맵 확인'],approvals:[]};
test('records are read-only and missing records never imply completion',()=>{
 const missing=missions.render({branch:'incheon',keyword:'추천'},'chatgpt_web');
 assert.match(missing,/점검 기록 대기/);assert.ok(!missing.includes('<form'));
 const html=missions.render({branch:'incheon',keyword:'추천',content_quality:q},'chatgpt_web');
 assert.match(html,/점검 완료/);assert.match(html,/사이트맵 확인/);assert.ok(!html.includes('완료했습니다'));
});
test('old records retain their dates and unsafe content is escaped',()=>{
 const html=missions.render({branch:'anyang',keyword:'추천',content_quality:{...q,checked_at:'2020-01-01T00:00:00+09:00',summary:'<img src=x>',completed:[{note:'<script>',url:'javascript:alert(1)',verified_at:q.checked_at}]}},'gemini_web');
 assert.match(html,/갱신 대기/);assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('javascript:'));
});
test('removing manual UI preserves automated observation and quality tools',()=>{
 const names=[];const context={document:{modelContext:{registerTool:t=>names.push(t.name)}}};
 vm.runInNewContext(fs.readFileSync('./assets/web-search-results.js','utf8'),context);
 assert.equal(context.WebSearchResults.render({},'chatgpt_web'),'');
 assert.deepEqual(names.sort(),['record_content_quality','record_naver_web_observation','record_web_search_observation'].sort());
});
