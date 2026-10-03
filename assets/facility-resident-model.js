/* Anonymous example activities; no resident identity or location is persisted. */
(function(root,factory){
  const api=factory(typeof require==='function'?require('./facility-3d-model.js'):root.FacilityModel,typeof require==='function'?require('./facility-staff-model.js'):root.FacilityStaff);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.FacilityResidents=api;
})(typeof window==='undefined'?globalThis:window,function(M,S){
  'use strict';
  const COLORS={normal:'#438b7e',focus:'#c64a4a',watch:'#c67a26',unknown:'#7b8490'};
  const bathroom=room=>/화장실|욕실|toilet|bathroom/i.test(room.name||'');
  const accessible=room=>room.type==='living'||bathroom(room);
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  function pointDistance(p,a,b){const dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz)));return distance(p,{x:a.x+t*dx,z:a.z+t*dz});}
  function meets(a,b,c,d){
    const cross=(p,q,r)=>(q.x-p.x)*(r.z-p.z)-(q.z-p.z)*(r.x-p.x),on=(p,q,r)=>Math.abs(cross(q,r,p))<1e-8&&p.x>=Math.min(q.x,r.x)-1e-8&&p.x<=Math.max(q.x,r.x)+1e-8&&p.z>=Math.min(q.z,r.z)-1e-8&&p.z<=Math.max(q.z,r.z)+1e-8;
    return cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0||on(a,c,d)||on(b,c,d)||on(c,a,b)||on(d,a,b);
  }
  function entrances(project,floor){
    const corridors=floor.rooms.filter(r=>r.type==='corridor'),doors=new Map();
    for(const room of floor.rooms.filter(accessible)){
      const vertices=M.vertices(room),choices=[];
      vertices.forEach((a,edge)=>{
        const b=vertices[(edge+1)%vertices.length],length=distance(a,b);if(length<.6)return;
        const ux=(b.x-a.x)/length,uz=(b.z-a.z)/length,width=Math.min(1.25,length-.25);
        for(const t of [.5,.25,.75]){
          if(t*length<width/2+.08||(1-t)*length<width/2+.08)continue;
          const middle={x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t};let nx=-uz,nz=ux;
          if(M.contains(room,{x:middle.x+nx*.24,z:middle.z+nz*.24})){nx=-nx;nz=-nz;}
          const inside={x:middle.x-nx*.25,z:middle.z-nz*.25};let outside={x:middle.x+nx*.25,z:middle.z+nz*.25};
          if(!M.contains(room,inside)||M.contains(room,outside)||Math.abs(outside.x)>project.width/2-.18||Math.abs(outside.z)>project.depth/2-.18)continue;
          if(floor.rooms.some(r=>r.id!==room.id&&r.type!=='corridor'&&M.contains(r,outside)))continue;
          if(corridors.length&&!corridors.some(r=>M.contains(r,outside))){
            const landing=[.45,.65,.85,1.05,1.25,1.45,1.65,1.85].map(length=>({x:middle.x+nx*length,z:middle.z+nz*length})).find(p=>corridors.some(r=>M.contains(r,p))&&!floor.rooms.some(r=>r.id!==room.id&&r.type!=='corridor'&&M.segmentHits(r,outside,p)));
            if(!landing)continue;outside=landing;
          }
          choices.push({edge,middle,inside,outside,start:{x:middle.x-ux*width/2,z:middle.z-uz*width/2},end:{x:middle.x+ux*width/2,z:middle.z+uz*width/2},cost:Math.hypot(outside.x,outside.z)});
        }
      });
      choices.sort((a,b)=>a.cost-b.cost);if(choices.length)doors.set(room.id,choices[0]);
    }
    return doors;
  }
  function walls(room,door){const vertices=M.vertices(room),out=[];vertices.forEach((a,i)=>{const b=vertices[(i+1)%vertices.length];if(door?.edge===i)out.push([a,door.start],[door.end,b]);else out.push([a,b]);});return out;}
  function bedLayout(room,count,door){
    if(!count)return [];
    let scale=Math.min(1,Math.sqrt(M.area(room)/(count*4.5)),(room.w-.25)/1.1,(room.d-.25)/2.1);
    const valid=(x,z,s)=>{
      const corners=[{x:x-.55*s,z:z-1.05*s},{x:x+.55*s,z:z-1.05*s},{x:x+.55*s,z:z+1.05*s},{x:x-.55*s,z:z+1.05*s}];
      if(!corners.every(p=>M.contains(room,p)))return false;
      if(M.vertices(room).some((a,i,v)=>corners.some((c,j)=>meets(a,v[(i+1)%v.length],c,corners[(j+1)%4]))))return false;
      return !door||Math.abs(x-door.inside.x)>.55*s+.38||Math.abs(z-door.inside.z)>1.05*s+.38;
    };
    for(let attempt=0;attempt<14;attempt++,scale*=.8){
      const cols=Math.max(1,Math.floor((room.w-.16)/(1.4*scale))),rows=Math.max(1,Math.floor((room.d-.16)/(2.5*scale))),candidates=[];
      for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
        const x=room.x+(i-(cols-1)/2)*1.4*scale,z=room.z+(j-(rows-1)/2)*2.5*scale;
        if(valid(x,z,scale))candidates.push({x,z,scale});
      }
      // Leave the area near the entrance free for activity inside the room.
      if(door)candidates.sort((a,b)=>distance(b,door.inside)-distance(a,door.inside));
      if(candidates.length>=count)return candidates.slice(0,count);
    }
    return [];
  }
  function network(project,floor,doors,beds){
    const corridors=floor.rooms.filter(r=>r.type==='corridor'),blocked=floor.rooms.filter(r=>r.type!=='corridor'&&!accessible(r));
    const boundaries=floor.rooms.filter(accessible).flatMap(r=>walls(r,doors.get(r.id))),obstacles=[...beds.values()].flat().map(b=>({x:b.x,z:b.z,w:1.1*b.scale,d:2.1*b.scale}));
    const approaches=[...doors.values()].map(d=>[d.middle,d.outside]);
    const zone=p=>{if(blocked.some(r=>M.contains(r,p)))return false;const room=floor.rooms.find(r=>accessible(r)&&M.contains(r,p));if(room)return room.id;return !corridors.length||corridors.some(r=>M.contains(r,p))||approaches.some(([a,b])=>pointDistance(p,a,b)<.3)?'corridor':false;};
    const free=p=>Math.abs(p.x)<project.width/2-.18&&Math.abs(p.z)<project.depth/2-.18&&zone(p)!==false&&!boundaries.some(([a,b])=>pointDistance(p,a,b)<.17)&&!obstacles.some(b=>Math.abs(p.x-b.x)<b.w/2+.18&&Math.abs(p.z-b.z)<b.d/2+.18);
    const clear=(a,b)=>[.25,.5,.75].every(t=>zone({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t})!==false)&&!blocked.some(r=>M.segmentHits(r,a,b))&&!obstacles.some(r=>M.segmentHits({...r,w:r.w+.34,d:r.d+.34},a,b))&&!boundaries.some(([c,d])=>meets(a,b,c,d)||Math.min(pointDistance(a,c,d),pointDistance(b,c,d),pointDistance(c,a,b),pointDistance(d,a,b))<.16);
    const nx=Math.min(96,Math.ceil(project.width/.42)),nz=Math.min(96,Math.ceil(project.depth/.42)),dx=(project.width-.4)/nx,dz=(project.depth-.4)/nz,nodes=new Map();
    for(let j=0;j<nz;j++)for(let i=0;i<nx;i++){
      const p={x:-project.width/2+.2+(i+.5)*dx,z:-project.depth/2+.2+(j+.5)*dz};
      if(free(p))nodes.set(j*nx+i,{...p,id:j*nx+i,zone:zone(p),links:[]});
    }
    const link=(a,b)=>{if(a&&b&&clear(a,b)){a.links.push(b.id);b.links.push(a.id);}};
    for(let j=0;j<nz;j++)for(let i=0;i<nx;i++){const a=nodes.get(j*nx+i);if(!a)continue;if(i+1<nx)link(a,nodes.get(j*nx+i+1));if(j+1<nz)link(a,nodes.get((j+1)*nx+i));}
    for(const [id,door]of doors){
      const pair=[];
      for(const part of ['inside','outside']){
        const p=door[part];if(!free(p))continue;
        const n={...p,id:'door-'+id+'-'+part,zone:zone(p),links:[]},near=[...nodes.values()].filter(q=>distance(n,q)<Math.max(dx,dz)*2.2&&q.zone===n.zone);nodes.set(n.id,n);near.forEach(q=>link(n,q));pair.push(n);
      }
      if(pair.length===2)link(...pair);
    }
    return {nodes,clear};
  }
  function signature(project,floor,result){return JSON.stringify([project.width,project.depth,floor.rooms,result.groups.filter(g=>g.level===floor.level).map(g=>[g.roomId,g.occupancy,(g.residents||[]).map(r=>[r.tier,r.uncertain])])]);}
  function create(project,floor,result){
    const groups=result.groups.filter(g=>g.level===floor.level&&g.roomId&&Number.isInteger(g.occupancy)&&g.occupancy>=0&&floor.rooms.some(r=>r.id===g.roomId&&r.type==='living'));
    const doors=entrances(project,floor),beds=new Map(),actors=[];
    for(const room of floor.rooms.filter(r=>r.type==='living')){const count=groups.find(g=>g.roomId===room.id)?.occupancy??0;beds.set(room.id,bedLayout(room,Math.max(room.beds||0,count),doors.get(room.id)));}
    const net=groups.some(g=>g.occupancy>0)?network(project,floor,doors,beds):{nodes:new Map()},connected=groups.length>0;
    let seed=83+floor.level*131;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const nodes=[...net.nodes.values()],homes=new Map(groups.map(g=>[g.roomId,nodes.filter(n=>n.zone===g.roomId)]));
    // Use the component attached to the room's entrance, or stay inside it.
    const reachable=new Map();for(const g of groups){const start=net.nodes.get('door-'+g.roomId+'-inside')||homes.get(g.roomId)?.[0],seen=new Set();if(start){const queue=[start.id];seen.add(start.id);for(let i=0;i<queue.length;i++)for(const id of net.nodes.get(queue[i]).links)if(!seen.has(id)){seen.add(id);queue.push(id);}}reachable.set(g.roomId,seen);}
    const choices=new Map(groups.map(g=>{const reach=reachable.get(g.roomId),valid=nodes.filter(n=>reach.has(n.id));return [g.roomId,{home:valid.filter(n=>n.zone===g.roomId),corridor:valid.filter(n=>n.zone==='corridor'),bathroom:valid.filter(n=>floor.rooms.some(r=>r.id===n.zone&&bathroom(r)))}];}));
    for(const g of groups){const room=floor.rooms.find(r=>r.id===g.roomId),home=choices.get(g.roomId).home;
      for(let i=0;i<g.occupancy;i++){
        const info=g.residents?.[i],tier=info?.tier,uncertain=!info||info.uncertain,bed=beds.get(g.roomId)?.[i],rest=!uncertain&&(tier==='focus'||tier==='watch');
        const node=home[Math.floor(random()*home.length)],p=rest&&bed?bed:node||bed||M.anchor(room);
        actors.push({roomId:g.roomId,number:i+1,tier:uncertain?'unknown':tier||'normal',bed:rest?bed:null,x:p.x,z:p.z,node:node?.id,route:[],phase:random()*6,heading:0,pose:rest&&bed?'lying':uncertain||!node?'idle':'walk',fixed:rest||uncertain||!node,wait:i*.4,step:0,walking:false});
      }
    }
    function target(a){
      const destinations=choices.get(a.roomId),steps=[['home','idle'],['corridor','seated'],['bathroom','bathroom'],['home','idle']];
      for(let i=0;i<4;i++){const [kind,pose]=steps[a.step++%4],options=destinations[kind];if(!options.length)continue;const n=options[Math.floor(random()*options.length)];a.route=S.path(net,a.node,n.id).slice(1);a.arrivalPose=pose;if(a.route.length)return;a.pose=pose;a.wait=2+random()*3;return;}
      a.pose='idle';a.wait=3;
    }
    function tick(dt,speed=1){
      dt=Math.min(.1,Math.max(0,dt))*speed;
      for(const a of actors){a.walking=false;if(a.fixed)continue;if(a.wait>0){a.wait-=dt;continue;}if(!a.route.length){target(a);if(!a.route.length)continue;}
        let travel=.48*dt;a.pose='walk';
        while(a.route.length&&travel>0){const next=net.nodes.get(a.route[0]),length=distance(a,next);a.heading=Math.atan2(next.x-a.x,next.z-a.z);a.walking=true;a.phase+=dt*7;
          if(length<=travel){a.x=next.x;a.z=next.z;a.node=a.route.shift();break;}else{a.x+=(next.x-a.x)*travel/length;a.z+=(next.z-a.z)*travel/length;travel=0;}}
        if(!a.route.length){a.walking=false;a.pose=a.arrivalPose;a.wait=3+random()*4;}
      }
    }
    return {actors,doors,beds,net,tick,connected,summary:{total:actors.length,lying:actors.filter(a=>a.pose==='lying').length,uncertain:actors.filter(a=>a.tier==='unknown').length,noRoute:actors.filter(a=>a.tier==='normal'&&(!choices.get(a.roomId).home.length||!choices.get(a.roomId).corridor.length)).length}};
  }
  return {COLORS,bathroom,entrances,walls,bedLayout,network,signature,create};
});
