const test=require('node:test');
const assert=require('node:assert/strict');
const missions=require('./assets/aeo-missions.js');
const plan={id:'test-plan',track_label:'미언급 개선',revision:0,completed:0,total:2,history:[],reason_options:{access:'권한 없음'},roadmap:[{id:'access',title:'공개 페이지 확인'}],current:{id:'access',title:'공개 페이지 확인',minutes:15,why:'공개 정보 확인',steps:['정보 확인'],done:'확인 결과 기록',source:{title:'공식 안내',url:'https://example.com'}}};
test('mission form offers explicit completion and a required reason for blocked work',()=>{
  const html=missions.render({keyword:'인천 요양원 추천',branch:'incheon',mission:plan},'openai');
  assert.match(html,/name="action" value="complete" required/);
  assert.match(html,/name="action" value="blocked" required/);
  assert.match(html,/name="reason"/);
  assert.match(html,/진행 중 · 공개 페이지 확인/);
  assert.match(html,/0 \/ 2단계 완료/);
});
test('stored reasons, work notes and links are rendered without executable content',()=>{
  const unsafe='<img src=x onerror=alert(1)>';
  const html=missions.render({keyword:unsafe,branch:'incheon',mission:{...plan,history:[{title:unsafe,action:'blocked',reason_code:'access',reason:unsafe,note:unsafe,evidence_url:'javascript:alert(1)',created_at:'2026-09-11'}],current:{...plan.current,blocker:{reason:unsafe},retry:'권한 요청 초안 작성'}}},'openai');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('권한 요청 초안 작성'));
});
test('finished plans retain history and stop offering another submission',()=>{
  const html=missions.render({keyword:'질문',mission:{...plan,completed:2,current:null}},'openai');
  assert.ok(html.includes('모든 미션을 완료했습니다.'));
  assert.ok(!html.includes('<form'));
});
