const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {filterFacilities,toCsv}=require('./assets/nearby-facilities.js');
const data=JSON.parse(fs.readFileSync('./data/nearby_facilities.json','utf8'));
test('branch, radius, category and bath filters compose; results remain nearest first',()=>{
  assert.equal(filterFacilities(data.facilities,{branch:'안양',radius:5}).length,450);
  assert.equal(filterFacilities(data.facilities,{branch:'인천',radius:5}).length,362);
  assert.equal(filterFacilities(data.facilities,{branch:'인천',radius:5,kind:'주야간보호'}).length,17);
  const result=filterFacilities(data.facilities,{branch:'인천',radius:1,bathOnly:true,query:'  다사랑  '});
  assert.equal(result.length,1);assert.equal(result[0].phone,'032-887-0005');
  const nearby=filterFacilities(data.facilities,{branch:'안양',radius:1});
  assert.ok(nearby.length>0&&nearby.length<450);
  assert.ok(nearby.every((r,i)=>r.distanceKm<=1&&(!i||nearby[i-1].distanceKm<=r.distanceKm)));
  assert.equal(filterFacilities(data.facilities,{branch:'안양',radius:5,query:'없는시설zzzz'}).length,0);
});
test('nursing homes include elderly group homes while attached day care stays separate',()=>{
  const anyang=filterFacilities(data.facilities,{branch:'안양',radius:5,kind:'요양원'});
  const incheon=filterFacilities(data.facilities,{branch:'인천',radius:5,kind:'요양원'});
  assert.equal(anyang.length,39);assert.equal(incheon.length,49);
  assert.ok(anyang.some(r=>r.name==='임곡 사랑의집'&&r.services==='노인요양공동생활가정'));
  assert.ok(anyang.some(r=>r.name==='안양노인전문요양원'));
  assert.ok(filterFacilities(data.facilities,{branch:'안양',radius:5,kind:'주야간보호'}).some(r=>r.name==='안양노인전문요양원 부설 노인주간보호센터'));
  assert.ok([...anyang,...incheon].every(r=>!r.name.includes('더비다')&&!/장애인|아동청소년|정신재활/.test(r.services)));
  assert.ok(anyang.every(r=>!r.address.includes('전파로 19-1')));
  assert.ok(incheon.every(r=>!r.address.includes('제물량로4번길 34-33')));
  const csv=toCsv(incheon);
  assert.equal(csv.split('\r\n').length,50);assert.ok(csv.includes('햇살노인전문요양원'));assert.ok(!csv.includes('복수초요양원'));
});
test('radius includes its boundary and CSV exports only selected source records safely',()=>{
  const r={id:'x',branch:'안양',kind:'재가',name:'=1+1',distanceKm:1,address:'a,"b"\nc',phone:'010-1234-5678',bathListed:false,services:'',note:'',source:'https://example.com'};
  assert.equal(filterFacilities([r],{branch:'안양',radius:1}).length,1);
  assert.equal(filterFacilities([r],{branch:'안양',radius:.999}).length,0);
  const csv=toCsv([r]);assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("\"'=1+1\""));assert.ok(csv.includes('"a,""b""\nc"'));assert.ok(csv.includes('"010-1234-5678"'));
});
test('source dataset has distinct identifiers, valid coordinates, distance and provenance',()=>{
  assert.equal(new Set(data.facilities.map(r=>r.id)).size,812);
  for(const r of data.facilities){assert.ok(r.lat>37&&r.lat<38&&r.lng>126&&r.lng<128);assert.ok(r.distanceKm>=0&&r.distanceKm<=5);assert.ok(r.source.startsWith('https://'));}
});
