const test=require('node:test');
const assert=require('node:assert/strict');
const {start}=require('./assets/dashboard-requests.js');
const flush=()=>new Promise(setImmediate);
const totals={environment:'production',counts:{new:1,contacted:0,completed:2,archived:0},kinds:{visit:1,trial:2,pricing:0},total:3};
function fixture(fetch) {
  const events={},documentEvents={},calls=[];
  const win={AbortController,fetch,setTimeout,clearTimeout,setInterval(){},
    addEventListener:(event,fn)=>events[event]=fn,
    document:{hidden:false,addEventListener:(event,fn)=>documentEvents[event]=fn}};
  const dashboard={update:(id,data,status={})=>calls.push({id,data,status}),fail:id=>calls.push({id,error:true})};
  const collector=start(win,dashboard);
  return {win,events,documentEvents,calls,collector};
}
test('requests only aggregate endpoint with existing cookies, no cache, and no private list fetch',async()=>{
  const requested=[];
  const f=fixture(async(url,options)=>{requested.push({url,options});return {ok:true,json:async()=>totals};});
  await flush();
  assert.equal(requested.length,1);
  assert.equal(requested[0].url,'/api/support/website-requests/summary');
  assert.equal(requested[0].options.credentials,'same-origin');
  assert.equal(requested[0].options.cache,'no-store');
  assert.deepEqual(f.calls.at(-1).data,totals);
});
test('unexpected authorization failures clear previous totals without requesting a key',async()=>{
  let authenticated=true;
  const f=fixture(async()=>authenticated?{ok:true,json:async()=>totals}:{status:401});
  await flush();authenticated=false;
  await f.collector.refresh();
  assert.equal(f.calls.at(-1).data,undefined);
  assert.equal(f.calls.at(-1).status,undefined);
  assert.equal(f.calls.at(-1).error,true);
});
test('network failures and incomplete counts cannot render healthy or zero totals',async()=>{
  for(const response of [{ok:false,status:503},{ok:true,json:async()=>({...totals,counts:{new:0}})}]) {
    const f=fixture(async()=>response);await flush();
    assert.equal(f.calls.at(-1).error,true);
  }
  const f=fixture(async()=>{throw new Error('offline');});await flush();
  assert.equal(f.calls.at(-1).error,true);
});
test('hiding the page clears totals and blocks stale responses after navigation',async()=>{
  let resolve;
  const f=fixture(()=>new Promise(done=>resolve=done));
  f.win.document.hidden=true;f.documentEvents.visibilitychange();
  resolve({ok:true,json:async()=>totals});await flush();
  assert.equal(f.calls.at(-1).data,null);
  assert.equal(f.calls.some(call=>call.data===totals),false);
});
test('duplicate refreshes are coalesced and returning to the page refreshes totals',async()=>{
  let resolve,requests=0;
  const f=fixture(()=>{requests++;return new Promise(done=>resolve=done);});
  f.events.focus();f.events.pageshow();await f.collector.refresh();
  assert.equal(requests,1);
  resolve({ok:true,json:async()=>totals});await flush();
  f.events.pagehide();assert.equal(f.calls.at(-1).data,null);
  f.events.pageshow();assert.equal(requests,2);
  resolve({ok:true,json:async()=>totals});await flush();
  assert.deepEqual(f.calls.at(-1).data,totals);
});
