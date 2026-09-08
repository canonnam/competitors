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
