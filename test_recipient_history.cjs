const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('./assets/recipient-history-ui.js');
const {prepare}=require('./scripts/recipient_history_capture.cjs');
test('unknown, failed, previous and genuine zero remain distinct',()=>{
  assert.equal(ui.label({available:false,status:'unqueried'}),'미조회');
  assert.equal(ui.label({available:false,status:'failed'}),'조회 실패');
  assert.equal(ui.label({available:true,status:'previous'}),'재조회 실패 · 이전 결과');
  assert.equal(ui.label({available:true,status:'ready',changedPeople:0,reviewPeople:0}),'확인된 자격 변경 없음');
  assert.equal(ui.label({available:true,status:'ready',reviewPeople:1}),'확인 필요');
});
test('summary escapes source strings and does not include personal detail arrays',()=>{
  const html=ui.summary({benefitMonth:'2026-10',branches:[{name:'<script>',status:'ready',available:true,changedPeople:1,scheduledPeople:0,periodOnlyPeople:1,reviewPeople:0,people:2,sourceRecords:4,records:[{name:'DO_NOT_RENDER'}]}]});
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('DO_NOT_RENDER'));assert.match(html,/자격 변경/);
});
test('capture verifies controls and hashes away identifiers before generated export',()=>{
  const raw={institutionNumber:'14117000625',benefitMonth:'2026-10',filter:'전체',headers:['수급자명','인정관리번호','자격','적용일자','종료일자'],queryCount:1,rows:[['테스트','RAW_PRIVATE_NUMBER','일반','2020-01-01','9999-12-31']]};
  const result=prepare(raw,'anyang','2026-10');assert.ok(!JSON.stringify(result).includes('RAW_PRIVATE_NUMBER'));
  assert.match(result.branches[0].records[0].personKey,/^[0-9a-f]{64}$/);
  for(const patch of [{queryCount:2},{filter:'일반'},{institutionNumber:'12817700685'}])assert.throws(()=>prepare({...raw,...patch},'anyang','2026-10'));
});
test('dashboard card is immediately above liability, and operations card is registered',()=>{
  const dash=fs.readFileSync('assets/dashboard.js','utf8');
  assert.match(dash,/data-dash-slot="recipients"[\s\S]*?<\/section>\s*<section class="dash-panel dash-liability-panel"/);
  assert.match(fs.readFileSync('assets/navigation.js','utf8'),/id:'recipient-history', category:'operations'/);
  assert.match(fs.readFileSync('index.html','utf8'),/id="home-recipient-history-status"/);
});
