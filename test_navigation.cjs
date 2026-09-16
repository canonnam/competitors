const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {features, categories, matchFeatures, createPreferences} = require('./assets/navigation.js');
const memory = () => {const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};};

test('directory covers every existing home card and deployable destination',()=>{
  const home=fs.readFileSync('index.html','utf8');
  const destinations=[...home.matchAll(/href="\/(.*?\.html)"/g)].map(match=>match[1]);
  assert.deepEqual(new Set(features.map(item=>item.href.slice(1))),new Set(destinations));
  assert.equal(new Set(features.map(item=>item.id)).size,features.length);
  for(const item of features){assert.ok(fs.existsSync(item.href.slice(1)));assert.ok(categories.some(group=>group.id===item.category));}
});
test('aliases, Korean spacing and case insensitive multiword searches identify the right tool',()=>{
  for(const [query,id] of [['손익','operating-costs'],['월급','payroll'],['SEO','search-visibility'],['근로 계약서','payroll'],['ｓｅｏ','search-visibility'],['네이버 광고','naver-ads']]) {
    assert.ok(matchFeatures(query).some(item=>item.id===id),query);
  }
  assert.deepEqual(matchFeatures('손익','marketing'),[]);
  assert.deepEqual(matchFeatures('월급','favorites',[]),[]);
  assert.equal(matchFeatures('월급','favorites',['payroll'])[0].id,'payroll');
  assert.deepEqual(matchFeatures('<script>alert(1)</script>'),[]);
});
test('favorites keep chosen order after reload, with list as the initial view',()=>{
  const saved=memory(),first=createPreferences(saved);
  assert.equal(first.get().view,'list');
  first.toggle('payroll');first.toggle('naver-ads');first.toggle('statistics');first.move('statistics',-1);first.view('list');
  const next=createPreferences(saved);
  assert.deepEqual(next.get(),{favorites:['payroll','statistics','naver-ads'],view:'list'});
  next.toggle('statistics');assert.deepEqual(next.get().favorites,['payroll','naver-ads']);
  next.move('payroll',-1);next.move('naver-ads',1);next.toggle('not-a-feature');
  assert.deepEqual(next.get().favorites,['payroll','naver-ads']);
  next.view('cards');assert.equal(createPreferences(saved).get().view,'cards');
});
test('the previous card preference migrates to list without losing favorites or retaining recent use',()=>{
  const saved=memory();saved.setItem('vida-navigation-v1',JSON.stringify({favorites:['payroll'],recent:['statistics'],view:'cards'}));
  const preferences=createPreferences(saved);assert.deepEqual(preferences.get(),{favorites:['payroll'],view:'list'});
  assert.deepEqual(JSON.parse(saved.getItem('vida-navigation-v1')),{favorites:['payroll'],view:'list',layoutVersion:2});
});
test('storage corruption, obsolete IDs and unavailable storage do not break navigation',()=>{
  for(const raw of ['broken','null','[]','42','{"favorites":["payroll","payroll","removed"],"recent":"wrong","view":"unknown"}']) {
    const state=createPreferences({getItem:()=>raw,setItem(){}}).get();
    assert.equal(state.view,'list');assert.ok(!('recent' in state));assert.ok(state.favorites.length<=1);
  }
  const blocked=createPreferences({getItem(){throw Error('blocked');},setItem(){throw Error('full');}});
  blocked.toggle('payroll');blocked.view('list');
  assert.deepEqual(blocked.get(),{favorites:['payroll'],view:'list'});
  const noStorage=createPreferences(null);noStorage.toggle('payroll');assert.deepEqual(noStorage.get().favorites,['payroll']);
});
test('every internal page loads shared navigation; external share links stay scoped',()=>{
  for(const file of fs.readdirSync('.').filter(name=>name.endsWith('.html'))){
    const html=fs.readFileSync(file,'utf8');
    if(file==='support-share.html'){assert.ok(!html.includes('/assets/navigation.js'));continue;}
    assert.ok(html.includes('/assets/navigation.js'),file);assert.ok(html.includes('/assets/navigation.css'),file);
    assert.equal((html.match(/\/assets\/navigation.js/g)||[]).length,1,file);
  }
});
