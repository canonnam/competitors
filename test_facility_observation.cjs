const test=require('node:test'),assert=require('node:assert/strict');
const M=require('./assets/facility-3d-model.js'),O=require('./assets/facility-observation-model.js');
function project(){const p=M.blank({name:'안양점',count:5});p.nursingHomeId=2;p.floors[0].rooms=[{id:'a',name:'201',type:'living',x:1,z:1,w:3,d:3,beds:0}];p.floors[1].rooms=[{id:'b',name:'201호 생활실',type:'living',x:-3,z:1,w:3,d:3,beds:0}];return p;}
const row=(floor,room,tier='focus')=>({elderly_name:'가상 대상',living_room_floor:floor,living_room_name:room,risk_tier:tier,risk_tier_display:tier==='focus'?'집중관찰':'주의관찰'});

test('space labels join their exact floor summary once and keep unmapped spaces named',()=>{
  const p=project();p.floors[0].rooms.push({id:'office',name:'간호사실',type:'nursing',x:-5,z:0,w:3,d:3,beds:0});
  const result=O.operating(p,{nursingHomeId:2,rooms:[{floor:1,name:'201호',current_occupancy:0,capacity:4}],observations:[{living_room_floor:1,living_room_name:'999',focus:1,watch:0}]});
  for(const mode of ['floor','plan']){
    const labels=O.spaceMarkers(p,result,mode,1),living=labels.find(t=>t.roomId==='a'),office=labels.find(t=>t.roomId==='office');
    assert.equal(labels.filter(t=>t.roomId==='a').length,1);assert.equal(living.roomName,'201');assert.equal(living.hasSummary,true);assert.equal(living.occupancy,0);
    assert.equal(office.roomName,'간호사실');assert.equal(office.hasSummary,false);assert.equal(office.occupancy,undefined);assert.deepEqual([office.x,office.z],[-5,0]);
    assert.equal(labels.some(t=>t.roomId==='b'),false);assert.equal(labels.filter(t=>!t.roomId).length,1);
  }
  for(const mode of ['building','exploded'])assert.deepEqual(O.spaceMarkers(p,result,mode,1),O.markers(p,result,mode,1));
  const offline=O.spaceMarkers(p,O.operating(p,null),'floor',1);assert.equal(offline.length,2);assert.ok(offline.every(t=>!t.hasSummary&&t.occupancy===undefined));
});

test('label placement stays inside the viewport and avoids summaries and information panels',()=>{
  const used=[{left:180,right:300,top:0,bottom:150}],positions=[];
  for(const [x,y] of [[260,70],[260,70],[0,0],[320,420],[120,200]]){
    const r=O.markerPosition(x,y,100,60,320,420,used);
    assert.ok(r.left>=5&&r.right<=315&&r.top>=5&&r.bottom<=415);
    assert.ok(used.every(k=>r.right<=k.left-6||r.left>=k.right+6||r.bottom<=k.top-6||r.top>=k.bottom+6));
    used.push(r);positions.push(r);
  }
  assert.equal(positions.length,5);
  const crowded=O.markerPosition(10,10,100,60,80,40,[{left:0,right:80,top:0,bottom:40}]);
  assert.ok(Number.isFinite(crowded.cx)&&Number.isFinite(crowded.cy));
  const narrowGap=O.markerPosition(20,20,160,36,320,420,[{left:0,right:320,top:0,bottom:265},{left:5,right:85,top:271,bottom:420},{left:260,right:320,top:271,bottom:420}]);
  assert.ok(narrowGap.left>=91&&narrowGap.right<=254&&narrowGap.top>=271);
});

test('authenticated room roster includes all occupants and links individual tiers by ID on the exact floor',()=>{
  const p=project(),room={floor:1,name:'201호',capacity:4,current_occupancy:3,remaining_capacity:1,elderly_residents:[{id:'10',name:'합성 A'},{id:'11',name:'합성 B'},{id:'12',name:'합성 C'}]};
  const payload={nursingHomeId:2,rooms:[room],observations:[{living_room_floor:1,living_room_name:'201',focus:1,watch:1}],residentObservations:[{elderly_id:10,elderly_name:'합성 A',living_room_floor:1,living_room_name:'201',risk_tier:'focus'},{elderly_id:11,elderly_name:'합성 B',living_room_floor:1,living_room_name:'201',risk_tier:'watch'},{elderly_id:12,elderly_name:'합성 C',living_room_floor:2,living_room_name:'201',risk_tier:'focus'}]};
  const g=O.operating(p,payload).groups[0];
  assert.deepEqual(g.residents,[{name:'합성 A',tier:'focus',uncertain:false},{name:'합성 B',tier:'watch',uncertain:false},{name:'합성 C',tier:null,uncertain:false}]);
  assert.equal(g.occupancy,3);assert.equal(g.capacity,4);assert.equal(g.residents.length,3);
  p.residentObservations=payload.residentObservations;assert.equal('residentObservations' in M.validate(p),false);
});
test('duplicate names, mismatched IDs and conflicting observations require review',()=>{
  const room={floor:1,name:'201',elderly_residents:[{id:'1',name:'동명이인'},{id:'2',name:'동명이인'},{id:'3',name:'합성 C'}]};
  const base={living_room_floor:1,living_room_name:'201',risk_tier:'watch'};
  let residents=O.residentsFor(room,{residentObservations:[{...base,elderly_name:'동명이인',elderly_id:null},{...base,elderly_name:'합성 C',elderly_id:'9'}]});
  assert.ok(residents.every(r=>r.tier===null&&r.uncertain));
  residents=O.residentsFor(room,{residentObservations:[{...base,elderly_name:'동명이인',elderly_id:'2'}]});
  assert.equal(residents[1].tier,'watch');assert.equal(residents[0].tier,null);assert.equal(residents[0].uncertain,true);
  residents=O.residentsFor(room,{residentObservations:[{...base,elderly_name:'合成',elderly_id:'3'},{...base,elderly_name:'合成',elderly_id:'3',risk_tier:'focus'}]});
  assert.equal(residents[2].uncertain,true);assert.equal(residents[2].tier,null);
  assert.equal(O.residentsFor({...room,elderly_residents:null},{residentObservations:[]}),null);
});
test('missing snapshot IDs match only a unique exact roster name, and absent snapshots do not imply routine',()=>{
  const room={floor:'B1',name:'101',elderly_residents:[{id:'1',name:'합성 A'}]};
  const observation={elderly_name:'합성 A',living_room_floor:-1,living_room_name:'101호',risk_tier:'focus'};
  assert.equal(O.residentsFor(room,{residentObservations:[observation]})[0].tier,'focus');
  assert.equal(O.residentsFor(room,{})[0].uncertain,true);
});
test('same room names on separate floors map to their exact registered floor',()=>{const result=O.map(project(),{nursingHomeId:2,rows:[row('1층','201호 생활실'),row(2,'201','watch')]});assert.deepEqual(result.groups.map(g=>[g.level,g.roomId]),[[1,'a'],[2,'b']]);assert.equal(result.focus,1);assert.equal(result.watch,1);});

test('removing a lower floor keeps ERP observations on their declared physical floor',()=>{
  const p=project();p.floors[3].rooms=[{...p.floors[0].rooms[0],id:'four',name:'401'}];
  M.removeFloor(p,3);const restored=M.validate(JSON.parse(JSON.stringify(p)));
  const result=O.map(restored,{nursingHomeId:2,rows:[row(4,'401')]});
  assert.deepEqual(result.groups.map(g=>[g.level,g.roomId]),[[4,'four']]);assert.equal(result.items[0].reason,'');
});
test('missing floors or rooms never infer an elderly location from room digits',()=>{const r=O.map(project(),{nursingHomeId:2,rows:[row(null,'201'),row('5','501'),row('1',null),row('1','999')]});assert.deepEqual(r.items.map(x=>x.reason),['생활실 정보 없음','생활실 미연결','도면 미등록','층 정보 없음']);assert.equal(r.groups.length,1);assert.equal(r.groups[0].roomId,null);assert.equal(r.groups[0].rows.length,2);});
test('ambiguous room names require review instead of silently choosing a room',()=>{const p=project();p.floors[0].rooms.push({...p.floors[0].rooms[0],id:'duplicate',name:'201호'});const r=O.map(p,{nursingHomeId:2,rows:[row(1,'201')]});assert.equal(r.items[0].reason,'생활실 이름 중복');assert.equal(r.groups[0].roomId,null);});
test('data from another ERP branch and ordinary observations cannot appear',()=>{assert.equal(O.map(project(),{nursingHomeId:3,rows:[row(1,'201')]}).items.length,0);assert.equal(O.map(project(),{nursingHomeId:2,rows:[row(1,'201','routine')]}).items.length,0);});
test('building rename and explicit ERP mapping survive save/export with health data excluded',()=>{const p=project();p.name='안양점 새 이름';p.healthRows=[row(1,'201')];const clean=M.validate(p);assert.equal(clean.name,'안양점 새 이름');assert.equal(clean.nursingHomeId,2);assert.equal('healthRows' in clean,false);assert.deepEqual(M.validate(JSON.parse(JSON.stringify(clean))),clean);});
test('existing named branches migrate, explicit disconnection remains and invalid ERP IDs fail',()=>{const p=project();delete p.nursingHomeId;p.name='인천점';assert.equal(M.validate(p).nursingHomeId,3);p.nursingHomeId=null;assert.equal(M.validate(p).nursingHomeId,null);p.nursingHomeId=1;assert.throws(()=>M.validate(p),/ERP/);});
test('floor parsing accepts explicit basement and ground floors and room formatting preserves distinct numbers',()=>{assert.equal(O.floorNumber('지상 2층'),2);assert.equal(O.floorNumber('2F'),2);for(const floor of ['지하 1층','B1','B1F','b1','-1층',-1])assert.equal(O.floorNumber(floor),-1);for(const floor of [null,0,'B0','지하','지상'])assert.equal(O.floorNumber(floor),null);assert.equal(O.floorNumber('B2'),-2);assert.equal(O.roomKey('201호 생활실'),'201');assert.notEqual(O.roomKey('201'),O.roomKey('202'));});
test('basement occupants and observations stay separate from identically named rooms on 1F',()=>{
  const p=project(),b=M.addFloor(p,{level:-1});b.rooms=[{...p.floors.find(f=>f.level===1).rooms[0],id:'basement'}];
  const personal=O.map(p,{nursingHomeId:2,rows:[row('지하 1층','201'),row('1층','201','watch'),row('B2','201')]});
  assert.deepEqual(personal.groups.map(g=>[g.level,g.roomId]),[[-1,'basement'],[1,'a']]);
  assert.equal(personal.items.find(r=>r.reportedLevel===-2).reason,'건물에 없는 층');
  const payload={nursingHomeId:2,rooms:[{floor:'B1',name:'201',current_occupancy:3,capacity:4,remaining_capacity:1},{floor:1,name:'201',current_occupancy:2,capacity:4,remaining_capacity:2}],observations:[{living_room_floor:-1,living_room_name:'201',focus:1,watch:2},{living_room_floor:'1층',living_room_name:'201',focus:0,watch:1}]};
  const result=O.operating(p,payload);
  assert.deepEqual(result.groups.map(g=>[g.level,g.roomId,g.occupancy,g.focus,g.watch]),[[-1,'basement',3,1,2],[1,'a',2,0,1]]);
  const marker=O.markers(p,result,'exploded',1).find(g=>g.level===-1);
  assert.deepEqual([marker.occupancy,marker.focus,marker.watch],[3,1,2]);
  assert.deepEqual(O.markers(p,result,'floor',-1).map(g=>g.roomId),['basement']);
});
