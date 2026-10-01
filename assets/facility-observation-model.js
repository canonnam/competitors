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
  return {floorNumber,roomKey,registered,map};
});
