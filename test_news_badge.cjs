const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createTracker,isToday}=require('./assets/news-badge.js');
function storage() {const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};}

test('timestamp and Korean date both expire at midnight, including future and invalid inputs',()=>{
  const midnight=Date.parse('2026-11-12T00:00:00+09:00');
  assert.equal(isToday('2026-11-11T14:59:59Z',midnight-1),true);
  assert.equal(isToday('2026-11-11T14:59:59Z',midnight),false);
  assert.equal(isToday('2026-11-11T15:00:00Z',midnight),true);
  assert.equal(isToday('2026-11-12',midnight),true);
  assert.equal(isToday('2026-11-11',midnight),false);
  for(const value of [null,'invalid','2026-11-12T00:00:00','2026-11-12T00:00:01+09:00','2026-11-13']) {
    assert.equal(isToday(value,midnight),false);
  }
});

test('an open page expires visible marks at Korean midnight even after reading or without a fetch',()=>{
  const midnight=Date.parse('2026-11-12T00:00:00+09:00');
  let now=midnight-2000, callback, delay;
  const marks=[], events=[], listeners={};
  const document={
    hidden:false,
    addEventListener(name,fn){listeners[name]=fn;},
    createElement(){
      return {dataset:{},setAttribute(){},remove(){marks.splice(marks.indexOf(this),1);}};
    },
    querySelectorAll(){return [...marks];}
  };
  const context={
    localStorage:storage(),document,Date:class extends Date {static now(){return now;}},
    addEventListener(){},dispatchEvent(event){events.push(event.type);},
    Event:class {constructor(type){this.type=type;}},
    setTimeout(fn,ms){callback=fn;delay=ms;return 1;},clearTimeout(){}
  };
  vm.runInNewContext(fs.readFileSync('assets/news-badge.js','utf8'),context);
  const api=context.NewsBadge;
  api.create('agency',{detail:true}).update(['read']);
  assert.equal(api.counts().agency,0);
  assert.equal(api.todayMark(document,'2026-11-10'),null);
  marks.push(api.todayMark(document,'2026-11-10','2026-11-11T14:59:57Z'));
  assert.equal(marks[0].textContent,'N');
  assert.equal(delay,2000);
  now=midnight;
  callback();
  assert.deepEqual(marks,[]);
  assert.deepEqual(events,['news-day-change']);
  marks.push(api.todayMark(document,'2026-11-12'));
  now=midnight+86400000;
  listeners.visibilitychange();
  assert.deepEqual(marks,[]);
  assert.deepEqual(events,['news-day-change','news-day-change']);
});

test('unread count follows unseen identities, survives reload and keeps feeds independent',()=>{
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
  const saved=storage(), listeners={}, context={localStorage:saved,document:{hidden:false},addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
  vm.runInNewContext(fs.readFileSync('assets/news-badge.js','utf8'),context);
  const home=context.NewsBadge.create('competitor',{}), detail=context.NewsBadge.create('competitor',{detail:true});
  home.update(['a']);assert.ok(context.NewsBadge.counts().competitor>0);
  detail.update(undefined);home.update(['a']);assert.ok(context.NewsBadge.counts().competitor>0);
  context.document.hidden=true;detail.update(['a']);home.update(['a']);assert.ok(context.NewsBadge.counts().competitor>0);
  context.document.hidden=false;detail.update(['a']);
  listeners.storage.forEach(fn=>fn({key:'vida-news-seen-v1:competitor'}));assert.equal(context.NewsBadge.counts().competitor,0);
  home.update(['a','b']);assert.ok(context.NewsBadge.counts().competitor>0);
  detail.update(['a','b']);listeners.pageshow.forEach(fn=>fn());assert.equal(context.NewsBadge.counts().competitor,0);
});

test('trend unread count tracks the browser independently of date-based marks',()=>{
  const saved=storage(),listeners={},context={localStorage:saved,document:{hidden:false},addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
  vm.runInNewContext(fs.readFileSync('assets/news-badge.js','utf8'),context);
  const home=context.NewsBadge.create('trend',{});
  home.update(['idea\n2026-11-01\nhttps://example.com/a']);
  assert.equal(context.NewsBadge.counts().trend,1);
  context.document.hidden=true;
  context.NewsBadge.create('trend',{detail:true}).update(['idea\n2026-11-01\nhttps://example.com/a']);
  assert.equal(context.NewsBadge.counts().trend,1);
  context.document.hidden=false;
  context.NewsBadge.create('trend',{detail:true}).update(['idea\n2026-11-01\nhttps://example.com/a','idea\n2026-11-03\nhttps://example.com/b']);
  assert.equal(context.NewsBadge.counts().trend,0);
  home.update(['idea\n2026-11-01\nhttps://example.com/a','idea\n2026-11-03\nhttps://example.com/b']);
  home.update(['idea\n2026-11-01\nhttps://example.com/a','idea\n2026-11-03\nhttps://example.com/b','idea\n2026-11-04\nhttps://example.com/c']);
  assert.equal(context.NewsBadge.counts().trend,1);
});

test('dashboard unread counts survive navigation and clear only the feed successfully read',()=>{
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
