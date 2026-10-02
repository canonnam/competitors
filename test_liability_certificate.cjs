const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('./assets/liability-certificate.js');
test('extract explicit certificate labels and ignore issuance date',()=>{
  assert.deepEqual(parse('발행일: 2026.10.02\n보험명: 시설소유자 배상책임보험\n가입인원: 34명\n보험기간: 2026년 1월 1일 ~ 2027년 1월 1일'),{insuranceName:'시설소유자 배상책임보험',insuredCount:34,startDate:'2026-01-01',endDate:'2027-01-01',missing:[]});
});
test('ambiguous count and unrelated staff count require manual review',()=>{
  const result=parse('가입인원: 34명\n가입인원: 38명\n직원수: 9명\n발행일 2026.10.02\n다음 납입일 2027.01.01');
  assert.equal(result.insuredCount,null);assert.equal(result.startDate,null);assert.ok(result.missing.includes('가입 인원'));
});
test('zero, leap years and malformed dates retain meaning',()=>{
  assert.equal(parse('피보험자 수: 0명').insuredCount,0);
  assert.equal(parse('보험기간 2026.02.30 ~ 2027.01.01').startDate,null);
  assert.equal(parse('보험기간 2028.02.29 ~ 2029.02.28').startDate,'2028-02-29');
});
