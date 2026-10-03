const test=require('node:test'),assert=require('node:assert/strict');
const M=require('./assets/facility-3d-model.js'),R=require('./assets/facility-resident-model.js');
function fixture(){
  const p=M.blank({count:2,width:18,depth:14}),f=p.floors[0];
  f.rooms=[{id:'living',name:'101호',type:'living',x:-4,z:-3,w:6,d:6,beds:4},{id:'bath',name:'화장실',type:'common',x:4,z:-4,w:4,d:4,beds:0},{id:'office',name:'사무실',type:'office',x:4,z:3,w:4,d:4,beds:0}];
  const result={groups:[{level:1,roomId:'living',occupancy:4,residents:[{name:'DO-NOT-PERSIST',tier:'focus',uncertain:false},{tier:'watch',uncertain:false},{tier:null,uncertain:false},{tier:null,uncertain:false}]}]};
  return {p,f,result};
}
test('actor count follows mapped occupancy rather than beds, capacity or another floor',()=>{
  const {p,f,result}=fixture(),before=structuredClone(p),m=R.create(p,f,result);assert.deepEqual(p,before);assert.equal(m.actors.length,4);assert.equal(m.actors.filter(a=>a.pose==='lying').length,2);
  assert.equal(JSON.stringify(m.actors).includes('DO-NOT-PERSIST'),false);assert.equal(JSON.stringify(M.validate(p)).includes('DO-NOT-PERSIST'),false);
  assert.equal(R.create(p,p.floors[1],result).actors.length,0);
  for(const occupancy of [0,null,undefined]){const data={groups:[{...result.groups[0],occupancy}]};assert.equal(R.create(p,f,data).actors.length,0);}
});
test('registered polygon corridors constrain movements and connect the room to its bathroom',()=>{
  const {p,f,result}=fixture(),corridor=M.polygon([{x:-7,z:0},{x:-1,z:0},{x:-1,z:-1},{x:2,z:-1},{x:2,z:-2},{x:6,z:-2},{x:6,z:0},{x:7,z:0},{x:7,z:1},{x:-7,z:1}],p);
  Object.assign(corridor,{id:'corridor',name:'복도',type:'corridor'});f.rooms.push(corridor);
  const m=R.create(p,f,result),visited=new Set();assert.equal(m.summary.noRoute,0);
  for(let i=0;i<3500;i++){m.tick(.1,4);for(const a of m.actors.filter(a=>!a.fixed)){assert.ok([f.rooms[0],f.rooms[1],corridor].some(r=>M.contains(r,a)));visited.add(a.pose);}}
  assert.ok(visited.has('bathroom'));assert.ok(visited.has('seated'));
});
test('a short gap between traced rooms and a corridor becomes a doorway approach',()=>{
  const p=M.blank({count:1,width:12,depth:10}),f=p.floors[0];
  f.rooms=[{id:'living',name:'101',type:'living',x:0,z:-2.5,w:6,d:4,beds:1},{id:'corridor',name:'복도',type:'corridor',x:0,z:1,w:6,d:2,beds:0}];
  const m=R.create(p,f,{groups:[{level:1,roomId:'living',occupancy:1,residents:[{tier:null,uncertain:false}]}]}),visited=new Set();assert.equal(m.summary.noRoute,0);
  for(let i=0;i<800;i++){const before={x:m.actors[0].x,z:m.actors[0].z};m.tick(.1,4);assert.ok(m.net.clear(before,m.actors[0]));visited.add(m.actors[0].pose);}
  assert.ok(visited.has('seated'));
});
test('focus and watch stay on distinct beds while others visit the bathroom, sit in the corridor and return home',()=>{
  const {p,f,result}=fixture(),m=R.create(p,f,result),rest=m.actors.filter(a=>a.fixed).map(a=>({x:a.x,z:a.z,pose:a.pose})),poses=new Set(),zones=new Set();
  assert.ok(m.actors.slice(0,2).every(a=>a.bed&&M.contains(f.rooms[0],a.bed)));assert.notDeepEqual(rest[0],rest[1]);
  for(let i=0;i<3500;i++){
    const before=m.actors.map(a=>({x:a.x,z:a.z}));m.tick(.1,4);
    for(let j=2;j<4;j++){const a=m.actors[j];assert.ok(m.net.clear(before[j],a));assert.equal(M.contains(f.rooms[2],a),false);poses.add(a.pose);zones.add(m.net.nodes.get(a.node).zone);}
  }
  assert.deepEqual(m.actors.filter(a=>a.fixed).map(a=>({x:a.x,z:a.z,pose:a.pose})),rest);
  for(const pose of ['walk','seated','bathroom','idle'])assert.ok(poses.has(pose),pose);
  for(const zone of ['living','corridor','bath'])assert.ok(zones.has(zone),zone);
});
test('unresolved observation matching stays neutral and missing roster does not fabricate grades',()=>{
  const {p,f,result}=fixture();result.groups[0].residents=[{tier:null,uncertain:true}];
  const m=R.create(p,f,result);assert.equal(m.actors.length,4);assert.ok(m.actors.every(a=>a.tier==='unknown'&&a.fixed&&a.pose==='idle'));assert.equal(m.summary.uncertain,4);
});
test('enclosed living rooms do not invent an exit or a bathroom visit',()=>{
  const p=M.blank({count:1,width:6,depth:6}),f=p.floors[0];f.rooms=[{id:'only',name:'101',type:'living',x:0,z:0,w:6,d:6,beds:1}];
  const m=R.create(p,f,{groups:[{level:1,roomId:'only',occupancy:1,residents:[{tier:null,uncertain:false}]}]});
  assert.equal(m.doors.size,0);assert.equal(m.summary.noRoute,1);
  for(let i=0;i<500;i++){m.tick(.1,4);assert.ok(M.contains(f.rooms[0],m.actors[0]));assert.ok(!['seated','bathroom'].includes(m.actors[0].pose));}
});
test('concave room beds fit within their polygon and movements use only door openings',()=>{
  const {p,f,result}=fixture(),poly=M.polygon([{x:-8,z:-6},{x:-1,z:-6},{x:-1,z:-2},{x:-4,z:-2},{x:-4,z:0},{x:-8,z:0}],p);
  Object.assign(poly,{id:'living',name:'101',type:'living',beds:4});f.rooms[0]=poly;
  const m=R.create(p,f,result);assert.equal(m.beds.get(poly.id).length,4);
  for(const b of m.beds.get(poly.id))for(const dx of [-.55,.55])for(const dz of [-1.05,1.05])assert.ok(M.contains(poly,{x:b.x+dx*b.scale,z:b.z+dz*b.scale}));
  for(let i=0;i<800;i++){const before=m.actors.map(a=>({x:a.x,z:a.z}));m.tick(.1,4);for(let j=2;j<4;j++)assert.ok(m.net.clear(before[j],m.actors[j]));}
});
test('animation reuse excludes resident names and resets for occupancy, grade or geometry changes',()=>{
  const {p,f,result}=fixture(),stamp=R.signature(p,f,result);result.groups[0].residents[0].name='ANOTHER-PRIVATE-NAME';assert.equal(R.signature(p,f,result),stamp);
  result.groups[0].residents[0].tier='watch';assert.notEqual(R.signature(p,f,result),stamp);result.groups[0].residents[0].tier='focus';result.groups[0].occupancy=3;assert.notEqual(R.signature(p,f,result),stamp);
  result.groups[0].occupancy=4;f.rooms[0].beds=3;assert.notEqual(R.signature(p,f,result),stamp);
});
test('zero time pauses activity and a long frame cannot teleport an actor',()=>{
  const {p,f,result}=fixture(),m=R.create(p,f,result),initial=m.actors.map(a=>[a.x,a.z]);m.tick(0,4);assert.deepEqual(m.actors.map(a=>[a.x,a.z]),initial);
  m.tick(100,4);for(let i=0;i<m.actors.length;i++)assert.ok(Math.hypot(m.actors[i].x-initial[i][0],m.actors[i].z-initial[i][1])<=.193);
});
