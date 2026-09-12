const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {status,safeUrl,unreadSupport,filterItems}=require('./assets/agency-news.js');

test('the public agency card follows competitor news and precedes AI Hub',()=>{
  const home=fs.readFileSync('index.html','utf8');
  const titles=[...home.matchAll(/<article[^>]*>.*?<h2>(.*?)<\/h2>/g)].map(match=>match[1]);
  const start=titles.indexOf('경쟁사 분석');
  assert.ok(start>=0);
  assert.deepEqual(titles.slice(start,start+4),['경쟁사 분석','경쟁사 및 요양원 뉴스','건보공단·복지부 뉴스·지원사업','AI 허브 활용데이터']);
  assert.equal(titles.length,12);
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
  assert.ok(safeUrl('https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do'));
});

test('support alerts ignore read and expired items and preserve public news filtering',()=>{
  const support={id:'new',kind:'support',source_id:'bizinfo',title:'SaaS 지원사업',topics:['연구개발'],department:'경기도',target:'창업기업',reasons:['연구소 활용'],application_status:{active:true}};
  const expired={...support,id:'expired',application_status:{active:false}};
  const news={id:'news',source_id:'nhis_B0152',title:'평가 안내',topics:['평가'],department:'공단'};
  const items=[support,expired,news], read=new Set(['old']);
  assert.deepEqual(unreadSupport({support:{items:[{id:'new',active:true},{id:'old',active:true},{id:'expired',active:false}]}},read).map(x=>x.id),['new']);
  assert.deepEqual(filterItems(items,{source:'bizinfo'}).map(x=>x.id),['new']);
  assert.deepEqual(filterItems(items,{source:'public-news'}).map(x=>x.id),['news']);
  assert.equal(filterItems(items,{source:'bizinfo',activeOnly:false}).length,2);
  assert.equal(filterItems(items,{onlyUnread:true,readIds:new Set(['new'])}).length,0);
  assert.equal(filterItems(items,{query:'연구소'}).length,1);
});

test('interest filters hide disliked support by default and allow restoring every choice',()=>{
  const base={kind:'support',source_id:'bizinfo',title:'지원사업',topics:[],application_status:{active:true}};
  const items=[{...base,id:'yes',preference:'interested'},{...base,id:'no',preference:'not_interested',preference_feedback:{reason:'입주 공간은 필요 없습니다.'}},{...base,id:'new'},
    {...base,id:'expired',preference:'interested',application_status:{active:false}},
    {id:'news',source_id:'mohw',title:'뉴스',topics:[]}];
  const ids=options=>filterItems(items,options).map(item=>item.id);
  assert.deepEqual(ids({}),['yes','new','news']);
  assert.deepEqual(ids({preference:'interested'}),['yes']);
  assert.deepEqual(ids({preference:'not_interested'}),['no']);
  assert.deepEqual(ids({preference:'not_interested',query:'입주 공간'}),['no']);
  assert.deepEqual(ids({preference:'all'}),['yes','no','new','news']);
  assert.deepEqual(ids({preference:'interested',activeOnly:false}),['yes','expired']);
  assert.deepEqual(ids({source:'public-news'}),['news']);
  assert.deepEqual(unreadSupport({support:{items:[{id:'yes',active:true},{id:'no',active:true,preference:'not_interested'}]}},new Set()).map(item=>item.id),['yes']);
});
