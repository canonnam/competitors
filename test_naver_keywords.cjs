const test = require('node:test');
const assert = require('node:assert/strict');
const {signal, summary, isTop} = require('./assets/naver-keywords.js');
const data = {threshold:3, stale:false, error:'', updated_at:'2026-09-08', total:24, top_count:6, eligible_top_count:1};

test('only reported top-three, eligible, fresh ranks pulse', () => {
  assert.equal(signal({average_rank:3,eligible:true},data).tone,'is-top');
  for (const average_rank of [null,0,NaN,Infinity,3.1]) assert.notEqual(signal({average_rank,eligible:true},data).tone,'is-top');
  assert.equal(isTop({average_rank:3},data),true);
  assert.notEqual(signal({average_rank:2,eligible:false},data).tone,'is-top');
  assert.notEqual(signal({average_rank:2,eligible:true},{...data,stale:true}).tone,'is-top');
  assert.notEqual(signal({average_rank:2,eligible:true},{...data,error:'failed'}).tone,'is-top');
});

test('homepage cannot indicate live exposure from paused or stale history', () => {
  assert.equal(summary(data).tone,'is-top');
  assert.notEqual(summary({...data,eligible_top_count:0}).tone,'is-top');
  assert.notEqual(summary({...data,stale:true}).tone,'is-top');
  assert.match(summary(data).text,/최근 7일 평균/);
  assert.notEqual(summary(null).tone,'is-top');
});
