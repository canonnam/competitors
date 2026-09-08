const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {filterFacilities,toCsv}=require('./assets/nearby-facilities.js');
const data=JSON.parse(fs.readFileSync('./data/nearby_facilities.json','utf8'));
test('branch, radius, category and bath filters compose; results remain nearest first',()=>{
  assert.equal(filterFacilities(data.facilities,{branch:'안양',radius:5}).length,412);
  assert.equal(filterFacilities(data.facilities,{branch:'인천',radius:5}).length,313);
  assert.equal(filterFacilities(data.facilities,{branch:'인천',radius:5,kind:'주야간보호'}).length,17);
  const result=filterFacilities(data.facilities,{branch:'인천',radius:1,bathOnly:true,query:'  다사랑  '});
  assert.equal(result.length,1);assert.equal(result[0].phone,'032-887-0005');
  const nearby=filterFacilities(data.facilities,{branch:'안양',radius:1});
  assert.ok(nearby.length>0&&nearby.length<412);
  assert.ok(nearby.every((r,i)=>r.distanceKm<=1&&(!i||nearby[i-1].distanceKm<=r.distanceKm)));
  assert.equal(filterFacilities(data.facilities,{branch:'안양',radius:5,query:'없는시설zzzz'}).length,0);
});
test('radius includes its boundary and CSV exports only selected source records safely',()=>{
  const r={id:'x',branch:'안양',kind:'재가',name:'=1+1',distanceKm:1,address:'a,"b"\nc',phone:'010-1234-5678',bathListed:false,services:'',note:'',source:'https://example.com'};
  assert.equal(filterFacilities([r],{branch:'안양',radius:1}).length,1);
  assert.equal(filterFacilities([r],{branch:'안양',radius:.999}).length,0);
  const csv=toCsv([r]);assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("\"'=1+1\""));assert.ok(csv.includes('"a,""b""\nc"'));assert.ok(csv.includes('"010-1234-5678"'));
});
test('source dataset has distinct identifiers, valid coordinates, distance and provenance',()=>{
  assert.equal(new Set(data.facilities.map(r=>r.id)).size,725);
  for(const r of data.facilities){assert.ok(r.lat>37&&r.lat<38&&r.lng>126&&r.lng<128);assert.ok(r.distanceKm>=0&&r.distanceKm<=5);assert.ok(r.source.startsWith('https://'));}
});
