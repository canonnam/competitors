/* Deterministic example walking in connected, unoccupied floor areas. */
(function(root,factory){const api=factory(typeof require==='function'?require('./facility-3d-model.js'):root.FacilityModel);if(typeof module==='object'&&module.exports)module.exports=api;else root.FacilityStaff=api;})(typeof window==='undefined'?globalThis:window,function(M){
  const COLORS={care:'#4356ad',social:'#40875d',nurse:'#bd5656',therapy:'#aa793c',admin:'#65768e',director:'#826096',kitchen:'#5a9b99',other:'#7b7b7b'};
  function network(project,floor){
    const nx=Math.min(64,Math.ceil(project.width/.45)),nz=Math.min(64,Math.ceil(project.depth/.45)),dx=(project.width-.7)/nx,dz=(project.depth-.7)/nz;
    const blocked=floor.rooms.filter(r=>r.type!=='corridor'),nodes=new Map();
    const close=(r,p)=>M.contains(r,p)||M.vertices(r).some((a,i,v)=>{const b=v[(i+1)%v.length],dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz)));return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz)<.25;});
    for(let j=0;j<nz;j++)for(let i=0;i<nx;i++){const p={x:-project.width/2+.35+(i+.5)*dx,z:-project.depth/2+.35+(j+.5)*dz};if(blocked.some(r=>close(r,p)))continue;nodes.set(j*nx+i,{...p,i,j,id:j*nx+i,links:[]});}
    for(const n of nodes.values())for(const [di,dj]of [[1,0],[-1,0],[0,1],[0,-1]]){const i=n.i+di,j=n.j+dj,next=nodes.get(j*nx+i);if(i<0||i>=nx||j<0||j>=nz||!next||blocked.some(r=>M.segmentHits(r,n,next)))continue;n.links.push(next.id);}
    const seen=new Set(),components=[];for(const n of nodes.values()){if(seen.has(n.id))continue;const queue=[n.id],group=[];seen.add(n.id);for(let k=0;k<queue.length;k++){const id=queue[k];group.push(id);for(const next of nodes.get(id).links)if(!seen.has(next)){seen.add(next);queue.push(next);}}components.push(group);}components.sort((a,b)=>b.length-a.length);
    return {nodes,component:components[0]||[]};
  }
  function path(net,from,to){if(from===to)return [from];const parent=new Map([[from,null]]),queue=[from];for(let k=0;k<queue.length;k++){const id=queue[k];for(const next of net.nodes.get(id)?.links||[]){if(parent.has(next))continue;parent.set(next,id);if(next===to){const out=[to];let p=id;while(p!==null){out.unshift(p);p=parent.get(p);}return out;}queue.push(next);}}return [];}
  function create(project,floor){const count=(floor.staff||[]).reduce((n,r)=>n+r.count,0);if(!count)return {net:null,actors:[]};const net=network(project,floor);if(!net.component.length)return {net,actors:[]};let seed=17+floor.level*117;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};const actors=[];
    for(const row of floor.staff||[])for(let i=0;i<row.count;i++){const id=net.component[Math.floor(rnd()*net.component.length)],p=net.nodes.get(id);actors.push({role:row.role,number:i+1,x:p.x,z:p.z,node:id,route:[],wait:rnd()*2,heading:0,phase:rnd()*6,walking:false});}
    function tick(dt,speed=1){dt=Math.min(.1,Math.max(0,dt))*speed;for(const a of actors){a.walking=false;if(a.wait>0){a.wait-=dt;continue;}if(!a.route.length){const target=net.component[Math.floor(rnd()*net.component.length)];a.route=path(net,a.node,target).slice(1);if(!a.route.length){a.wait=1;continue;}}
      let travel=.75*dt;while(a.route.length&&travel>0){const next=net.nodes.get(a.route[0]),distance=Math.hypot(next.x-a.x,next.z-a.z);a.heading=Math.atan2(next.x-a.x,next.z-a.z);a.walking=true;a.phase+=dt*8;if(distance<=travel){a.x=next.x;a.z=next.z;a.node=a.route.shift();travel-=distance;}else{a.x+=(next.x-a.x)*travel/distance;a.z+=(next.z-a.z)*travel/distance;travel=0;}}if(!a.route.length)a.wait=.8+rnd()*2;}}
    return {net,actors,tick};
  }
  return {COLORS,network,path,create};
});
