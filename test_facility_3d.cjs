const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./assets/facility-3d-model.js');

test('five-floor example survives a JSON round trip with stable floor and room IDs',()=>{
  const original=M.sample(),restored=M.validate(JSON.parse(JSON.stringify(original)));
  assert.equal(restored.floors.length,5);
  assert.deepEqual(restored,original);
  assert.ok(restored.floors.every(f=>f.rooms.length>0));
  assert.ok(restored.floors.flatMap(f=>f.rooms).every(r=>M.inside(r,restored)));
});
test('blank five-floor project accepts independent rooms on different floors',()=>{
  const p=M.blank({count:5});
  const first=M.rectangle({x:-4,z:-4},{x:0,z:0},p);
  const second=M.rectangle({x:-4,z:-4},{x:0,z:0},p);
  M.addRoom(p,1,first);M.addRoom(p,5,second);
  assert.equal(p.floors[0].rooms.length,1);
  assert.equal(p.floors[4].rooms.length,1);
  assert.equal(p.floors[2].rooms.length,0);
  assert.notEqual(first.id,second.id);
  assert.deepEqual(M.validate(p),p);
});
test('drawing in either direction creates the same room bounds',()=>{
  const p=M.blank(),a={x:-3.12,z:-2.61},b={x:2.12,z:3.21};
  const r=M.rectangle(a,b,p),reverse=M.rectangle(b,a,p);
  delete r.id;delete reverse.id;
  assert.deepEqual(r,reverse);
  assert.ok(M.inside(r,p));
});

test('deleting a middle floor preserves physical levels and restoring keeps its complete contents',()=>{
  const p=M.sample();p.floors[2].image={name:'합성 도면',src:'data:image/png;base64,aGVsbG8=',aspect:1};p.floors[2].staff=[{role:'care',count:2}];
  const original=structuredClone(p.floors),removed=M.removeFloor(p,3);
  assert.deepEqual(p.floors.map(f=>f.level),[1,2,4,5]);
  assert.deepEqual(p.floors,original.filter(f=>f.level!==3));
  assert.deepEqual(M.validate(JSON.parse(JSON.stringify(p))).floors,p.floors);
  p.floors.push(removed);
  assert.deepEqual(M.validate(p).floors,original);
});

test('new floors fill unused levels without renumbering and bounds prevent invalid floor mutations',()=>{
  const p=M.blank({count:5});M.removeFloor(p,3);
  const added=M.addFloor(p,{level:3,name:'생활층'});
  assert.equal(added.name,'생활층');assert.deepEqual(added.rooms,[]);assert.deepEqual(added.staff,[]);assert.equal(added.image,null);
  assert.deepEqual(p.floors.map(f=>f.level),[1,2,3,4,5]);
  const before=structuredClone(p);
  for(const level of [3,0,-2,13,1.5,true])assert.throws(()=>M.addFloor(p,{level}));
  assert.deepEqual(p,before);
  assert.throws(()=>M.removeFloor(M.blank({count:1}),1),/최소/);
  const full=M.blank({count:12});M.addFloor(full,{level:-1});
  assert.equal(M.validate(full).floors.length,13);
  assert.throws(()=>M.addFloor(full,{level:12}),/지하 1층과 지상 12층/);
  const invalid=structuredClone(p);invalid.floors[1].level=1;assert.throws(()=>M.validate(invalid),/중복/);
  const legacy=structuredClone(p);legacy.floors.forEach(f=>delete f.level);assert.deepEqual(M.validate(legacy).floors.map(f=>f.level),[1,2,3,4,5]);
});
test('basement rooms, plan and staff round-trip independently of ground floors and can be removed and restored',()=>{
  const p=M.sample(),ground=structuredClone(p.floors),b=M.addFloor(p,{level:-1});
  assert.equal(b.name,'지하 1층');assert.equal(M.floorCode(b.level),'B1');
  M.addRoom(p,-1,M.rectangle({x:-4,z:-4},{x:0,z:0},p));
  b.staff=[{role:'care',count:2},{role:'nurse',count:1}];
  b.image={name:'합성 지하 도면',src:'data:image/png;base64,aGVsbG8=',aspect:1};
  assert.deepEqual(p.floors.slice(1),ground);
  assert.deepEqual(M.validate(JSON.parse(JSON.stringify(p))),p);
  const before=structuredClone(p),removed=M.removeFloor(p,-1);
  assert.deepEqual(p.floors,ground);p.floors.push(removed);
  assert.deepEqual(M.validate(p),before);
});
test('basement occupies the next storey below 1F and viewing bounds cover both ground and basement',()=>{
  const p=M.blank({count:5}),h=p.height;
  assert.deepEqual(M.verticalBounds(p),{bottom:0,top:5*h,height:5*h});
  M.addFloor(p,{level:-1});
  assert.equal(M.floorIndex(-1),-1);assert.equal(M.floorIndex(1),0);assert.equal(M.floorIndex(5),4);
  const whole=M.verticalBounds(p);assert.equal(whole.bottom,-h);assert.equal(whole.top,5*h);assert.ok(Math.abs(whole.height-6*h)<1e-9);
  const step=h+3.8,bounds=M.verticalBounds(p,true);
  assert.equal(bounds.bottom,-step);assert.equal(bounds.top,4*step+h);
  p.floors=p.floors.filter(f=>f.level===-1);
  assert.deepEqual(M.verticalBounds(p),{bottom:-h,top:0,height:h});
  assert.deepEqual(M.validate(p),p);
});
test('overlapping rooms are rejected while shared edges and separate floors are allowed',()=>{
  const p=M.blank(),first=M.rectangle({x:-4,z:-4},{x:0,z:0},p);
  M.addRoom(p,1,first);
  assert.throws(()=>M.addRoom(p,1,M.rectangle({x:-2,z:-2},{x:2,z:2},p)),/겹칩니다/);
  M.addRoom(p,1,M.rectangle({x:0,z:-4},{x:4,z:0},p));
  assert.equal(p.floors[0].rooms.length,2);
});
test('invalid physical bounds and duplicate IDs cannot enter an imported project',()=>{
  const p=M.sample();p.floors[0].rooms[0].x=11;
  assert.throws(()=>M.validate(p),/건물 밖/);
  const duplicate=M.sample();duplicate.floors[1].id=duplicate.floors[0].id;
  assert.throws(()=>M.validate(duplicate),/중복된 층/);
  assert.throws(()=>M.blank({count:5.5}),/정수/);
  assert.throws(()=>M.blank({width:Infinity}),/가로/);
});
test('image imports only accept bounded embedded raster data',()=>{
  const p=M.blank();p.floors[0].image={name:'test',src:'https://example.com/tracker.png',aspect:1};
  assert.throws(()=>M.validate(p),/이미지 형식/);
  p.floors[0].image.src='data:image/svg+xml;base64,PHN2Zz4=';
  assert.throws(()=>M.validate(p),/이미지 형식/);
  p.floors[0].image.src='data:image/png;base64,aGVsbG8=';
  assert.equal(M.validate(p).floors[0].image.aspect,1);
});
