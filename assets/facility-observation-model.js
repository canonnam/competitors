/* Map authenticated snapshot locations without guessing missing rooms or floors. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FacilityObservation=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  function floorNumber(value){const text=String(value??'').trim(),basement=text.match(/^(?:지하\s*|B\s*|-)(\d{1,2})\s*(?:층|F)?$/i);if(basement)return Number(basement[1])>0?-Number(basement[1]):null;const m=text.match(/^(?:지상\s*)?(\d{1,2})\s*(?:층|F)?$/i);return m&&Number(m[1])>0?Number(m[1]):null;}
  function roomKey(value){return String(value??'').normalize('NFKC').replace(/\s+/g,'').replace(/생활실|침실/g,'').replace(/^제(?=\d)/,'').replace(/호실?$/,'');}
  function registered(floor){return !!floor.image||floor.rooms.length>0;}
  function residentsFor(room,payload){
    if(!Array.isArray(room.elderly_residents))return null;
    const nameKey=n=>String(n??'').normalize('NFKC').replace(/\s+/g,''),hasObservations=Array.isArray(payload.residentObservations);
    const targets=(payload.residentObservations||[]).filter(t=>floorNumber(t.living_room_floor)===floorNumber(room.floor)&&roomKey(t.living_room_name)===roomKey(room.name));
    return room.elderly_residents.map(person=>{
      const unique=room.elderly_residents.filter(p=>nameKey(p.name)===nameKey(person.name)).length===1;
      const matches=targets.filter(t=>t.elderly_id!=null&&person.id!=null?String(t.elderly_id)===String(person.id):unique&&nameKey(t.elderly_name)===nameKey(person.name)&&person.name!=='이름 미확인');
      const tiers=[...new Set(matches.map(t=>t.risk_tier).filter(t=>['focus','watch'].includes(t)))];
      const uncertain=!hasObservations||tiers.length>1||(!matches.length&&targets.some(t=>nameKey(t.elderly_name)===nameKey(person.name)));
      return {name:person.name,tier:uncertain?null:tiers[0]??null,uncertain};
    });
  }
  function map(project,payload){
    const groups=[],items=[];
    if(!payload||payload.nursingHomeId!==project.nursingHomeId||!Array.isArray(payload.rows))return {groups,items,focus:0,watch:0};
    for(const row of payload.rows){
      if(!['focus','watch'].includes(row.risk_tier))continue;
      const level=floorNumber(row.living_room_floor),floor=project.floors.find(f=>f.level===level);
      let room=null,reason='';
      if(!floor)reason=level?'건물에 없는 층':'층 정보 없음';
      else if(!registered(floor))reason='도면 미등록';
      else{
        const key=roomKey(row.living_room_name),matches=key?floor.rooms.filter(r=>roomKey(r.name)===key):[];
        if(matches.length===1)room=matches[0];
        else reason=matches.length>1?'생활실 이름 중복':row.living_room_name?'생활실 미연결':'생활실 정보 없음';
      }
      const item={...row,reportedLevel:level,level:floor?.level??null,roomId:room?.id??null,reason};items.push(item);
      if(floor&&registered(floor)){
        let group=groups.find(g=>g.level===floor.level&&g.roomId===item.roomId);
        if(!group){group={level:floor.level,roomId:item.roomId,roomName:room?.name??'생활실 위치 확인',x:room?.x??(-project.width/2+2.5),z:room?.z??(project.depth/2-1.5),rows:[],focus:0,watch:0};groups.push(group);}
        group.rows.push(item);group[row.risk_tier]++;
      }
    }
    items.sort((a,b)=>(a.risk_tier==='focus'?0:1)-(b.risk_tier==='focus'?0:1)||(a.level??99)-(b.level??99));
    return {groups,items,focus:items.filter(r=>r.risk_tier==='focus').length,watch:items.filter(r=>r.risk_tier==='watch').length};
  }
  function operating(project,payload){
    const result={groups:[],items:[],focus:0,watch:0,assignedOccupancy:null,floorTotals:[],floorSummaries:[],unmatchedRooms:[]};
    if(!payload||payload.nursingHomeId!==project.nursingHomeId||!Array.isArray(payload.rooms)||!Array.isArray(payload.observations))return result;
    const M=typeof require==='function'?require('./facility-3d-model.js'):window.FacilityModel;
    const locate=(value,name)=>{const reportedLevel=floorNumber(value),floor=project.floors.find(f=>f.level===reportedLevel);let room=null,reason='';if(!floor)reason=reportedLevel?'건물에 없는 층':'층 정보 없음';else if(!registered(floor))reason='도면 미등록';else{const key=roomKey(name),matches=key?floor.rooms.filter(r=>roomKey(r.name)===key):[];if(matches.length===1)room=matches[0];else reason=matches.length>1?'생활실 이름 중복':name?'생활실 미연결':'생활실 정보 없음';}return {reportedLevel,level:floor?.level??null,floor,room,reason};};
    function group(loc){let g=result.groups.find(k=>k.level===loc.level&&k.roomId===(loc.room?.id??null));if(!g){const point=loc.room?M.anchor(loc.room):{x:-project.width/2+2.5,z:project.depth/2-1.5};g={level:loc.level,roomId:loc.room?.id??null,roomName:loc.room?.name??'생활실 위치 확인',...point,focus:0,watch:0,occupancy:null,capacity:null,rows:[]};result.groups.push(g);}return g;}
    result.assignedOccupancy=payload.rooms.reduce((n,r)=>n+r.current_occupancy,0);
    const duplicates=new Set();for(const r of payload.rooms){const key=floorNumber(r.floor)+'|'+roomKey(r.name);if(payload.rooms.filter(k=>floorNumber(k.floor)+'|'+roomKey(k.name)===key).length>1)duplicates.add(key);}
    for(const row of payload.rooms){const loc=locate(row.floor,row.name);if(duplicates.has(loc.reportedLevel+'|'+roomKey(row.name))){loc.room=null;loc.reason='ERP 생활실 이름 중복';}let total=result.floorTotals.find(k=>k.level===loc.reportedLevel);if(!total){total={level:loc.reportedLevel,occupancy:0};result.floorTotals.push(total);}total.occupancy+=row.current_occupancy;
      if(loc.room){const g=group(loc);g.occupancy=row.current_occupancy;g.capacity=row.capacity;g.remaining=row.remaining_capacity;g.occupancyStatus=row.occupancy_status;g.residents=residentsFor(row,payload);}else result.unmatchedRooms.push({name:row.name,occupancy:row.current_occupancy,...loc,room:undefined,floor:undefined});}
    for(const row of payload.observations){if(!Number.isInteger(row.focus)||!Number.isInteger(row.watch)||row.focus<0||row.watch<0)continue;const loc=locate(row.living_room_floor,row.living_room_name);result.focus+=row.focus;result.watch+=row.watch;result.items.push({...loc,room:undefined,floor:undefined,living_room_name:row.living_room_name,focus:row.focus,watch:row.watch});if(loc.floor&&registered(loc.floor)){const g=group(loc);g.focus+=row.focus;g.watch+=row.watch;}}
    result.floorSummaries=project.floors.map(f=>({level:f.level,name:f.name,
      occupancy:result.floorTotals.find(t=>t.level===f.level)?.occupancy??null,
      capacity:payload.rooms.filter(r=>floorNumber(r.floor)===f.level).reduce((n,r)=>n+(r.capacity??0),0),
      focus:result.items.filter(r=>r.reportedLevel===f.level).reduce((n,r)=>n+r.focus,0),
      watch:result.items.filter(r=>r.reportedLevel===f.level).reduce((n,r)=>n+r.watch,0),
      pending:result.items.filter(r=>r.reportedLevel===f.level&&r.reason).reduce((n,r)=>n+r.focus+r.watch,0)}));
    return result;
  }
  function markers(project,result,mode,selectedFloor){
    if(mode==='building'||mode==='exploded')return result.floorSummaries.map(f=>({
      ...f,kind:'floor',roomId:null,roomName:f.name,x:project.width/2+.5,z:0}));
    return result.groups.filter(g=>g.level===selectedFloor).map(g=>({...g,kind:'room'}));
  }
  function spaceMarkers(project,result,mode,selectedFloor){
    const summaries=markers(project,result,mode,selectedFloor);
    if(mode==='building'||mode==='exploded')return summaries;
    const M=typeof require==='function'?require('./facility-3d-model.js'):window.FacilityModel,floor=project.floors.find(f=>f.level===selectedFloor);
    return [...(floor?.rooms||[]).map(room=>{const summary=summaries.find(g=>g.roomId===room.id);return {...summary,...M.anchor(room),level:selectedFloor,roomId:room.id,roomName:room.name,kind:'space',hasSummary:!!summary};}),...summaries.filter(g=>!g.roomId)];
  }
  function markerPosition(x,y,bw,bh,w,h,used){
    const pad=5,clamp=(v,min,max)=>max<min?(min+max)/2:Math.max(min,Math.min(max,v));
    const rect=(cx,cy)=>{cx=clamp(cx,bw/2+pad,w-bw/2-pad);cy=clamp(cy,bh/2+pad,h-bh/2-pad);return {left:cx-bw/2,right:cx+bw/2,top:cy-bh/2,bottom:cy+bh/2,cx,cy};};
    const free=r=>!used.some(k=>r.left<k.right+6&&r.right>k.left-6&&r.top<k.bottom+6&&r.bottom>k.top-6);
    const near=[[0,0],[0,-bh-10],[0,bh+10],[-bw-10,0],[bw+10,0],[0,-2*(bh+10)],[0,2*(bh+10)],[-bw-10,-bh-10],[bw+10,-bh-10],[-bw-10,bh+10],[bw+10,bh+10]].map(([dx,dy])=>rect(x+dx,y+dy));
    const nearby=near.find(free);if(nearby)return nearby;
    const xs=[x,bw/2+pad,w-bw/2-pad,...used.flatMap(k=>[k.left-bw/2-6,k.right+bw/2+6])],ys=[y,bh/2+pad,h-bh/2-pad,...used.flatMap(k=>[k.top-bh/2-6,k.bottom+bh/2+6])];
    const candidates=xs.flatMap(cx=>ys.map(cy=>rect(cx,cy))).filter(free);
    candidates.sort((a,b)=>Math.hypot(a.cx-x,a.cy-y)-Math.hypot(b.cx-x,b.cy-y));return candidates[0]||near[0];
  }
  return {floorNumber,roomKey,registered,residentsFor,map,operating,markers,spaceMarkers,markerPosition};
});
