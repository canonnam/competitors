const test=require('node:test');
const assert=require('node:assert/strict');
const {dailyRows,value}=require('./assets/clarity-report.js');
test('missing observation dates and event failures remain unknown',()=>{
  const history=[{day:'2026-10-07',sessions:8,incheon:null},{day:'2026-10-09',sessions:0,incheon:0}];
  const rows=dailyRows(history,7);
  assert.deepEqual(rows.map(row=>row.day),['2026-10-07','2026-10-08','2026-10-09']);
  assert.equal(value(rows[1].sessions),'미조회');
  assert.equal(value(rows[2].sessions),'0');
  assert.equal(value(rows[0].incheon),'미조회');
  assert.equal(value(NaN),'미조회');
});
test('history windows do not add overlapping 24-hour observations',()=>{
  const history=Array.from({length:15},(_,i)=>({day:'2026-10-'+String(i+1).padStart(2,'0'),sessions:i}));
  const rows=dailyRows(history,7);
  assert.equal(rows.length,7);
  assert.equal(rows[0].sessions,8);
  assert.equal(rows[6].sessions,14);
  assert.deepEqual(dailyRows([],30),[]);
});
