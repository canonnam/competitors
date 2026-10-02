const test=require('node:test'),assert=require('node:assert/strict');
const UI=require('./assets/liability-ui.js');
const branch={id:2,name:'안양점',status:'success',label:'양호',stale:false,daysRemaining:90,issues:[],occupancy:{total:34,checkedAt:'2026-10-02T14:00:00+09:00'},policy:{insuranceName:'배상책임보험',insuredCount:35,startDate:'2026-01-01',endDate:'2027-01-01'},certificate:{url:'/api/liability-insurance/2/certificate',name:'증서.pdf'}};
test('shared summary shows coverage and icon actions without the removed metadata',()=>{
  const html=UI.branch(branch);
  assert.ok(html.includes('35명'));assert.ok(html.includes('양호'));assert.ok(html.includes('data-li-edit="2"'));assert.ok(html.includes('href="/api/liability-insurance/2/certificate"'));
  const visible=html.replace(/<[^>]*>/g,'');
  for(const text of ['줄여주세요','전체 현원 확인','2026-10-02','증서.pdf','보험 증서 다운로드','보험 정보 등록·수정'])assert.ok(!visible.includes(text),text);
});
test('unknown and stale counts remain distinguishable and certificate names are escaped',()=>{
  const html=UI.branch({...branch,stale:true,occupancy:null,policy:null,certificate:{...branch.certificate,name:'"<img src=x onerror=alert(1)>'}});
  assert.ok(html.includes('이전 전체 현원'));assert.ok(html.includes('<dd>—</dd>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));
  assert.ok(UI.branch({...branch,certificate:null}).includes('disabled aria-label="안양점 등록된 보험 증서 없음"'));
});
test('automatic schedule remains available as an accessible tooltip',()=>{
  const html=UI.info({schedule:'매일 오전 9시 (한국시간)',nextCheckAt:'2026-10-03T09:00:00+09:00'});
  assert.ok(html.includes('aria-label="보험 자동 점검 안내"'));assert.ok(html.includes('data-li-tooltip="매일 오전 9시 (한국시간) 자동 점검 · 다음 점검'));
});
