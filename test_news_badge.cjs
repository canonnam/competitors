const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createTracker}=require('./assets/news-badge.js');
function storage() {const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};}

test('N follows unseen identities, survives reload and keeps feeds independent',()=>{
  const saved=storage(), news=createTracker('competitor',saved), agency=createTracker('agency',saved);
  assert.equal(news.unread(['a','a','b']),2);
  news.mark(['a','b']);
  assert.equal(createTracker('competitor',saved).unread(['b','a']),0);
  assert.equal(news.unread(['a','c']),1); // Same count; one actual new article.
  assert.equal(agency.unread(['a','b']),2);
  news.mark(undefined);
  assert.equal(news.unread(['a','b']),0);
});

test('unavailable or malformed browser storage does not break the news page',()=>{
  const disabled=createTracker('agency',{getItem(){throw Error('disabled');},setItem(){throw Error('disabled');}});
  disabled.mark(['a']);assert.equal(disabled.unread(['a']),0);
  const readonly=createTracker('agency',{getItem(){return '[]';},setItem(){throw Error('full');}});
  readonly.mark(['a']);assert.equal(readonly.unread(['a']),0);
  const malformed=createTracker('agency',{getItem(){return '{}';},setItem(){}});
  assert.equal(malformed.unread(['a']),1);
});

test('only a successfully displayed visible detail page acknowledges a collection',()=>{
  const saved=storage(), listeners={}, badge={hidden:true,setAttribute(){}}, context={localStorage:saved,document:{hidden:false},addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
  vm.runInNewContext(fs.readFileSync('assets/news-badge.js','utf8'),context);
  const home=context.NewsBadge.create('competitor',{badge}), detail=context.NewsBadge.create('competitor',{detail:true});
  home.update(['a']);assert.equal(badge.hidden,false);
  detail.update(undefined);home.update(['a']);assert.equal(badge.hidden,false);
  context.document.hidden=true;detail.update(['a']);home.update(['a']);assert.equal(badge.hidden,false);
  context.document.hidden=false;detail.update(['a']);
  listeners.storage.forEach(fn=>fn({key:'vida-news-seen-v1:competitor'}));assert.equal(badge.hidden,true);
  home.update(['a','b']);assert.equal(badge.hidden,false);
  detail.update(['a','b']);listeners.pageshow.forEach(fn=>fn());assert.equal(badge.hidden,true);
});

test('trend unread counts stay on the shared menu until that page is read',()=>{
  const saved=storage(),listeners={},context={localStorage:saved,document:{hidden:false},addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
  vm.runInNewContext(fs.readFileSync('assets/news-badge.js','utf8'),context);
  const badge={hidden:true,title:'',setAttribute(){}};
  const home=context.NewsBadge.create('trend',{badge,seenLabel:'트렌드 페이지'});
  home.update(['idea\n2026-11-01\nhttps://example.com/a']);
  assert.equal(badge.hidden,false);
  assert.match(badge.title,/트렌드 페이지를 확인하면/);
  assert.equal(context.NewsBadge.counts().trend,1);
  context.document.hidden=true;
  context.NewsBadge.create('trend',{detail:true}).update(['idea\n2026-11-01\nhttps://example.com/a']);
  assert.equal(context.NewsBadge.counts().trend,1);
  context.document.hidden=false;
  context.NewsBadge.create('trend',{detail:true}).update(['idea\n2026-11-01\nhttps://example.com/a','idea\n2026-11-03\nhttps://example.com/b']);
  assert.equal(context.NewsBadge.counts().trend,0);
  home.update(['idea\n2026-11-01\nhttps://example.com/a','idea\n2026-11-03\nhttps://example.com/b']);
  assert.equal(badge.hidden,true);
  home.update(['idea\n2026-11-01\nhttps://example.com/a','idea\n2026-11-03\nhttps://example.com/b','idea\n2026-11-04\nhttps://example.com/c']);
  assert.equal(badge.hidden,false);
  assert.equal(context.NewsBadge.counts().trend,1);
});

test('shared menu counts survive navigation and clear only the feed successfully read',()=>{
  const saved=storage(),listeners={},context={localStorage:saved,document:{hidden:false},addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
  vm.runInNewContext(fs.readFileSync('assets/news-badge.js','utf8'),context);
  let latest;context.NewsBadge.subscribe(counts=>{latest=counts;});
  context.NewsBadge.create('competitor',{}).update(['news-a','news-b']);
  context.NewsBadge.create('agency',{}).update(['agency-a']);
  assert.equal(latest.competitor,2);assert.equal(latest.agency,1);
  const next={localStorage:saved,document:{hidden:false},addEventListener(){}};
  vm.runInNewContext(fs.readFileSync('assets/news-badge.js','utf8'),next);
  assert.equal(next.NewsBadge.counts().competitor,2);
  next.NewsBadge.create('competitor',{detail:true}).update(['news-a','news-b']);
  assert.equal(next.NewsBadge.counts().competitor,0);assert.equal(next.NewsBadge.counts().agency,1);
  listeners.storage.forEach(fn=>fn({key:'vida-news-seen-v1:competitor'}));
  assert.equal(latest.competitor,0);assert.equal(latest.agency,1);
});
