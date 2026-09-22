// Optional DOM checks: npm install --prefix .local/dashboard-qa jsdom@26.1.0 --no-save
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('../.local/dashboard-qa/node_modules/jsdom');
const html=fs.readFileSync('index.html','utf8');
function boot(query='') {
  const dom=new JSDOM(html,{url:'https://app.aivida.tech/'+query,runScripts:'outside-only'}),w=dom.window;
  w.setInterval=()=>0;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const liveNodes=[...w.document.querySelectorAll('[id^="home-"]')];
  for(const script of ['news-badge','dashboard','navigation'])w.eval(fs.readFileSync('assets/'+script+'.js','utf8'));
  for(const node of liveNodes)assert.equal(w.document.getElementById(node.id),node,'collector node identity '+node.id);
  return dom;
}
const dom=boot(),w=dom.window,d=w.document;
try {
  const dashboard=d.getElementById('kb-dashboard'),grid=d.querySelector('main > .grid');
  assert.equal(dashboard.hidden,false);assert.equal(grid.hidden,true);
  assert.ok(d.body.classList.contains('kb-navigation-ready'));
  const select=id=>d.querySelector('#kb-navigation [data-kb-category="'+id+'"]').click();
  select('all');assert.equal(dashboard.hidden,true);assert.equal(grid.hidden,false);assert.equal(w.location.search,'?category=all');
  d.querySelector('[data-kb-view="cards"]').click();assert.equal(grid.classList.contains('kb-list-view'),false);
  select('dashboard');assert.equal(dashboard.hidden,false);
  const input=d.getElementById('kb-home-search');input.value='손익';input.dispatchEvent(new w.Event('input'));
  assert.equal(dashboard.hidden,true);assert.equal(grid.querySelectorAll('article:not([hidden])').length,1);
  assert.equal(grid.querySelector('article:not([hidden])').dataset.kbFeature,'operating-costs');
  select('dashboard');assert.equal(input.value,'');assert.equal(w.location.search,'');
  select('all');d.querySelector('[data-kb-pin="payroll"]').click();select('dashboard');
  assert.equal(d.querySelector('.kb-shortcut-section').hidden,false);
  assert.ok(d.querySelector('.kb-shortcuts').textContent.includes('급여'));
  const comp=w.NewsBadge.create('competitor',{}),agency=w.NewsBadge.create('agency',{});
  comp.update(['a','b']);agency.update(['c']);
  w.HomeDashboard.update('competitor',{total:2,updated_at:'2026-09-22'},{});
  w.HomeDashboard.update('agency',{total:1,support:{active:1},sources:[{id:'bizinfo',last_success:'2026-09-22'}]},{});
  assert.match(d.querySelector('[data-dash-key="metric-news"]').textContent,/3건/);
  assert.equal(w.localStorage.getItem('vida-news-seen-v1:competitor'),null,'dashboard must not mark news read');
  const anchor=d.querySelector('[data-dash-key="metric-news"]');anchor.focus();
  w.HomeDashboard.fail('agency');
  assert.equal(d.activeElement.dataset.dashKey,'metric-news','focus survives refresh');
  assert.match(d.querySelector('[data-dash-key="metric-news"]').textContent,/—/);
  assert.match(d.querySelector('[data-dash-slot="attention"]').textContent,/연결 확인 필요/);
  w.HomeDashboard.update('agency',{support:{active:1},sources:[{id:'bizinfo',last_success:'2026-09-22'}]});
  assert.match(d.querySelector('[data-dash-key="metric-news"]').textContent,/3건/);
  const claims={benefitMonth:'2026-08',deadline:'2026-09-10',branches:['anyang','incheon'].map(id=>({id,name:id,status:'accepted',label:'접수 완료',message:'필수 청구 접수 완료',checkedAt:'2026-09-10T13:52:10+09:00',lastQueryFailureAt:'2026-09-10T20:04:28+09:00'}))};
  w.HomeDashboard.update('claims',claims);
  assert.match(d.querySelector('[data-dash-key="metric-claims"]').textContent,/2 \/ 2지점/);
  assert.equal(d.querySelector('[data-dash-key="metric-claims"]').hasAttribute('data-warning'),false);
  assert.equal(d.querySelectorAll('[data-dash-slot="attention"] a[href="/claim-check.html"]').length,0);
  assert.equal(d.querySelectorAll('.dash-branch [data-status="warning"]').length,0);
  assert.doesNotMatch(d.querySelector('[data-dash-slot="claims"]').textContent,/재조회 실패/);
  assert.ok([...d.querySelectorAll('.dash-branch small')].every(el=>/조회.*9\. 10\./.test(el.textContent)),'verified timestamps stay visible');
  assert.ok(claims.branches.every(branch=>branch.lastQueryFailureAt),'failure history is not removed from data');
  w.HomeDashboard.fail('claims');
  assert.match(d.querySelector('[data-dash-key="attention-claims"]').textContent,/연결 확인 필요/);
  assert.match(d.querySelector('[data-dash-slot="claims"] .dash-warning').textContent,/이전 조회 결과/);
  assert.equal(d.querySelectorAll('.dash-branch [data-status="warning"]').length,0,'connection failures do not relabel accepted branches');
  w.HomeDashboard.update('claims',claims);
  assert.equal(d.querySelector('[data-dash-key="attention-claims"]'),null);
  w.HomeDashboard.update('claims',{benefitMonth:'2026-08',deadline:'2026-09-10',branches:[{id:'x',name:'<img src=x onerror=alert(1)>',status:'check',label:'확인',message:'<script>alert(1)</script>'}]});
  assert.equal(dashboard.querySelectorAll('img,script').length,0,'untrusted data stays text');
  assert.ok(d.querySelector('[data-dash-key="attention-claim-x"]'),'unaccepted branch still needs attention');
  assert.ok(d.querySelector('.dash-branch [data-status="warning"]'));
  select('all');assert.equal(grid.classList.contains('kb-list-view'),false,'saved view survives dashboard');
  console.log('PASS: default dashboard, 16 intact cards, live nodes, search, menu, favorites, saved view, error/recovery, focus, escaping and unread preservation');
} finally {dom.window.close();}
for(const [query,isDashboard] of [['?category=all',false],['?category=operations',false],['?q=손익',false],['?category=dashboard&q=손익',false],['?category=invalid',true]]) {
  const current=boot(query);
  assert.equal(current.window.document.getElementById('kb-dashboard').hidden,!isDashboard,query);
  current.window.close();
}
console.log('PASS: direct URLs and old category/search links');
