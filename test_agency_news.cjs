const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {status,safeUrl}=require('./assets/agency-news.js');

test('the public agency card is third and preserves news and original icons',()=>{
  const home=fs.readFileSync('index.html','utf8');
  const titles=[...home.matchAll(/<article[^>]*>.*?<h2>(.*?)<\/h2>/g)].map(match=>match[1]);
  assert.deepEqual(titles.slice(0,4),['경쟁사 분석','경쟁사 뉴스','건보공단·복지부 뉴스','AI 허브 활용데이터']);
  assert.equal(titles.length,8);
  assert.ok(!fs.readFileSync('assets/site.css','utf8').includes('.card .icon{background:'));
});

test('badge reports incomplete, failed, disabled and overdue checks accurately',()=>{
  const data={updated_at:'2026-09-08T09:10:00+09:00',sync:{enabled:true,errors:[],stale:false,next_run:'2026-09-09T09:10:00+09:00'}};
  const now=Date.parse('2026-09-08T12:00:00+09:00');
  assert.equal(status(data,now).warning,false);
  assert.equal(status({...data,updated_at:null},now).warning,true);
  for(const sync of [{...data.sync,enabled:false},{...data.sync,errors:['수집 오류']},{...data.sync,stale:true}])assert.equal(status({...data,sync},now).warning,true);
  assert.equal(status(data,Date.parse(data.sync.next_run)).warning,true);
});

test('links can only open the requested official domains',()=>{
  for(const value of ['javascript:alert(1)','https://example.com','https://www.mohw.go.kr.evil.test/','https://user@www.mohw.go.kr/'])assert.equal(safeUrl(value),'');
  assert.equal(safeUrl('https://www.mohw.go.kr/board.es?bid=0027'),'https://www.mohw.go.kr/board.es?bid=0027');
});
