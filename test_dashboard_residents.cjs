const test=require('node:test'),assert=require('node:assert/strict');
const {prepare,value,total,baseline,rate,summary,render,start}=require('./assets/dashboard-residents.js');
const data=()=>({schemaVersion:1,today:'2026-10-08',branches:[
  {id:2,name:'안양점',asOf:'2026-10-08',checkedAt:'2026-10-08T16:00:00+09:00',months:[{month:'2025-12',admitted:2,discharged:1},{month:'2026-09',admitted:3,discharged:2}],stale:false},
  {id:3,name:'인천점',asOf:null,months:null,stale:true,collectionError:'합성 조회 실패'}]});
test('current year ends at current month and previous year remains selectable',()=>{
  const view=prepare(data());assert.equal(view.year,2026);assert.equal(view.months.length,10);assert.deepEqual(view.years,[2026,2025]);
  assert.equal(prepare(data(),2025).months.length,12);assert.equal(prepare(data(),2027).year,2026);
  const html=render({data:data()});assert.match(html,/2025년/);assert.match(html,/10월은 8일까지/);assert.doesNotMatch(html,/>11월</);
});
test('known zero and unknown are distinct; failures retain warnings and historical counts',()=>{
  const d=data(),v=prepare(d);assert.equal(value(v.branches[0],'2026-08','admitted'),0);assert.equal(value(v.branches[1],'2026-08','admitted'),null);
  assert.equal(value({...v.branches[0],asOf:'2026-09-30'},'2026-10','admitted'),null);
  assert.match(render({data:d}),/9月|9월 입소 3명/);assert.match(render({data:d}),/인천점: 미조회/);
  assert.match(render({data:d,error:true}),/갱신 실패.*이전 조회/);assert.match(render({error:true}),/불러오지 못했습니다/);
  assert.match(render(),/확인 중/);d.branches[0].months[0].admitted=null;assert.throws(()=>prepare(d));
});
test('service messages are escaped and omitted admission dates remain visible',()=>{
  const d=data();d.branches[1].collectionError='<script>bad</script>';d.branches[0].missingAdmissionDates=2;
  const html=render({data:d});assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/안양점 입소일 미등록 2명/);
});
test('year totals and whole rates use summed year-start occupancy, not average percentages',()=>{
  const d=data();d.branches[0].yearStarts=[{year:2025,date:'2025-01-01',occupancy:0},{year:2026,date:'2026-01-01',occupancy:20}];
  d.branches[1]={id:3,name:'인천점',asOf:d.today,months:[{month:'2026-09',admitted:9,discharged:4}],yearStarts:[{year:2026,date:'2026-01-01',occupancy:10}]};
  const v=prepare(d),s=summary(v);assert.equal(s.admitted.people,12);assert.equal(s.discharged.people,6);assert.equal(s.occupancy,30);
  assert.equal(s.admitted.rate,'40.0%');assert.equal(s.discharged.rate,'20.0%');
  assert.equal(total(v.branches[0],prepare(d,2025).months,'admitted'),2);assert.equal(baseline(v.branches[0],2025),0);
  assert.equal(rate(2,0),null);assert.equal(rate(0,20),'0.0%');assert.equal(rate(25,20),'125.0%');
  const html=render({data:d});assert.match(html,/전체 입소 <strong>12명/);assert.match(html,/입소율 40\.0%/);
  assert.match(html,/안양점 2026년 입소 합계 3명, 입소율 15\.0%/);assert.match(html,/현원 대비 \(전체 30명\)/);
});
test('incomplete totals or missing/failed year-start occupancy never produce misleading zero rates',()=>{
  const d=data(),v=prepare(d);assert.equal(summary(v).admitted.people,null);assert.equal(summary(v).admitted.rate,null);
  assert.equal(total({...v.branches[0],asOf:'2026-09-30'},v.months,'admitted'),null);
  d.branches[1]={id:3,name:'인천점',asOf:d.today,months:[],yearStarts:[{year:2026,date:'2026-01-01',occupancy:null,error:'failed'}]};
  assert.equal(summary(prepare(d)).admitted.people,3);assert.equal(summary(prepare(d)).admitted.rate,null);
  assert.match(render({data:d}),/기준 현원 미조회/);assert.doesNotMatch(render({data:d}),/NaN|Infinity/);
  d.branches[1].yearStarts[0].occupancy=-1;assert.throws(()=>prepare(d));
});
test('fetch uses cached summary only and reports failures',async()=>{
  const events={},updates=[],failures=[],requests=[];
  const win={document:{hidden:false,addEventListener:(n,fn)=>events[n]=fn},addEventListener:(n,fn)=>events[n]=fn,setInterval:()=>0,AbortSignal,
    fetch:async url=>{requests.push(url);return {ok:true,json:async()=>data()};}};
  const api=start(win,{update:(...a)=>updates.push(a),fail:n=>failures.push(n),redraw:()=>{}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(updates[0][0],'residents');assert.deepEqual(requests,['/api/resident-movement']);
  win.fetch=async()=>({ok:false});await api.refresh();assert.deepEqual(failures,['residents']);
});
