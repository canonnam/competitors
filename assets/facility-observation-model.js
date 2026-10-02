/* Map authenticated snapshot locations without guessing missing rooms or floors. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FacilityObservation=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  function floorNumber(value){const m=String(value??'').trim().match(/^(?:지상\s*)?(\d{1,2})\s*(?:층|F)?$/i);return m&&Number(m[1])>0?Number(m[1]):null;}
  function roomKey(value){return String(value??'').normalize('NFKC').replace(/\s+/g,'').replace(/생활실|침실/g,'').replace(/^제(?=\d)/,'').replace(/호실?$/,'');}
  function registered(floor){return !!floor.image||floor.rooms.length>0;}
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
      if(loc.room){const g=group(loc);g.occupancy=row.current_occupancy;g.capacity=row.capacity;g.remaining=row.remaining_capacity;g.occupancyStatus=row.occupancy_status;}else result.unmatchedRooms.push({name:row.name,occupancy:row.current_occupancy,...loc,room:undefined,floor:undefined});}
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
  return {floorNumber,roomKey,registered,map,operating,markers};
});
