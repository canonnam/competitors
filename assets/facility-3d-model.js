/* Geometry and portable project data for the facility viewer. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FacilityModel = api;
})(typeof window === 'undefined' ? globalThis : window, function() {
  'use strict';
  const TYPES = {living:'생활실', office:'사무·상담', common:'공용공간', service:'지원공간', core:'계단·승강기', corridor:'복도', unknown:'용도 미지정'};
  const COLORS = {living:'#dbe8f1', office:'#e8e4f3', common:'#e0eddf', service:'#f1e8d7', core:'#e1e5eb', corridor:'#edf0f3', unknown:'#e6eaf0'};
  const uid = () => 'space-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  const text = (value, fallback) => String(value ?? fallback).trim().slice(0,80) || fallback;
  function number(value, min, max, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(label + ' 범위를 확인해주세요.');
    return n;
  }
  function blank(options = {}) {
    const count = number(options.count ?? 5,1,12,'층 수');
    if (!Number.isInteger(count)) throw new Error('층 수는 정수로 입력해주세요.');
    return {version:1,id:uid(),name:text(options.name,'새 건물'),width:number(options.width ?? 24,4,120,'건물 가로'),
      depth:number(options.depth ?? 16,4,120,'건물 세로'),height:number(options.height ?? 3.2,2,6,'층 높이'),
      scale:options.scale === 'entered' ? 'entered' : 'estimated',example:false,nursingHomeId:null,
      floors:Array.from({length:count},(_,i)=>({id:uid(),level:i+1,name:(i+1)+'층',rooms:[],image:null}))};
  }
  function sample() {
    const project = blank({name:'5층 요양원 예시',count:5});
    project.example = true;
    const names = ['안내·행정','생활실 A','생활실 B','생활실 C','프로그램·지원'];
    project.floors.forEach((floor,i)=>{
      floor.name = names[i];
      const room = (name,type,x,z,w,d,beds=0) => ({id:uid(),name,type,x,z,w,d,beds});
      floor.rooms.push(room('계단','core',-10.1,0,3.4,3.6),room('승강기','core',10.1,0,3.4,3.6));
      if (i===0) {
        floor.rooms.push(room('상담실','office',-7.8,-4.6,7.4,5.8),room('사무실','office',0,-4.6,7.4,5.8),
          room('간호실','service',7.8,-4.6,7.4,5.8),room('로비·면회실','common',-5.4,4.6,11.8,5.8),
          room('식당','common',6.6,4.6,9.8,5.8));
      } else if (i===4) {
        floor.rooms.push(room('프로그램실','common',-5.6,-4.6,11.4,5.8),room('물리치료실','common',6.1,-4.6,10.4,5.8),
          room('휴게실','common',-7.8,4.6,7.4,5.8),room('주방','service',0,4.6,7.4,5.8),room('세탁·물품실','service',7.8,4.6,7.4,5.8));
      } else {
        for (let side=0;side<2;side++) for(let col=0;col<3;col++) {
          floor.rooms.push(room(`${floor.level}0${side*3+col+1}호`,'living',-7.8+col*7.8,side===0?-4.6:4.6,7.4,5.8,2));
        }
      }
    });
    return project;
  }
  function validate(raw) {
    if (!raw || raw.version!==1 || !Array.isArray(raw.floors) || raw.floors.length<1 || raw.floors.length>12) throw new Error('시설 3D 도면 파일 형식을 확인해주세요.');
    const out = blank({name:raw.name,count:raw.floors.length,width:raw.width,depth:raw.depth,height:raw.height,scale:raw.scale});
    out.id = text(raw.id,uid()); out.example = raw.example === true;
    const legacyName=out.name.replace(/\s+/g,'');
    out.nursingHomeId=raw.nursingHomeId===undefined?(/^(더비다요양원)?안양(점)?$/.test(legacyName)?2:/^(더비다요양원)?인천(점)?$/.test(legacyName)?3:null):raw.nursingHomeId;
    if(![null,2,3].includes(out.nursingHomeId))throw new Error('ERP 지점을 확인해주세요.');
    const roomIds = new Set(),floorIds = new Set();
    out.floors = raw.floors.map((floor,i)=>{
      if (!floor || !Array.isArray(floor.rooms) || floor.rooms.length>40) throw new Error('한 층에 공간은 최대 40개까지 구성할 수 있습니다.');
      const id=text(floor.id,uid());
      if (floorIds.has(id)) throw new Error('중복된 층 정보가 있습니다.');
      floorIds.add(id);
      const rooms = floor.rooms.map(room=>{
        if (!room) throw new Error('공간 정보를 확인해주세요.');
        const r={id:text(room.id,uid()),name:text(room.name,'새 공간'),type:Object.hasOwn(TYPES,room.type)?room.type:'common',
          x:number(room.x,-out.width/2,out.width/2,'공간 위치'),z:number(room.z,-out.depth/2,out.depth/2,'공간 위치'),
          w:number(room.w,0.5,out.width,'공간 가로'),d:number(room.d,0.5,out.depth,'공간 세로'),beds:number(room.beds ?? 0,0,8,'침대 수')};
        if (!Number.isInteger(r.beds) || roomIds.has(r.id)) throw new Error('공간 ID 또는 침대 수를 확인해주세요.');
        if (!inside(r,out)) throw new Error('건물 밖에 있는 공간이 있습니다.');
        roomIds.add(r.id); return r;
      });
      let image = null;
      if(floor.image) {
        if(typeof floor.image.src!=='string' || floor.image.src.length>1800000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(floor.image.src)) throw new Error('도면 이미지 형식을 확인해주세요.');
        image={src:floor.image.src,name:text(floor.image.name,'층 도면'),aspect:number(floor.image.aspect,0.05,20,'도면 비율')};
        if(floor.image.labels) {
          if(!Array.isArray(floor.image.labels)||floor.image.labels.length>500)throw new Error('도면 글자 정보를 확인해주세요.');
          image.labels=floor.image.labels.map(label=>({text:text(label.text,''),x:number(label.x,0,1,'글자 위치'),y:number(label.y,0,1,'글자 위치'),confidence:number(label.confidence,0,100,'글자 인식값')}));
        }
      }
      return {id,level:i+1,name:text(floor.name,(i+1)+'층'),rooms,image};
    });
    return out;
  }
  function inside(room,project) {
    return Math.abs(room.x)+room.w/2 <= project.width/2+0.001 && Math.abs(room.z)+room.d/2 <= project.depth/2+0.001;
  }
  function intersects(a,b) {
    return Math.abs(a.x-b.x)<(a.w+b.w)/2-0.01 && Math.abs(a.z-b.z)<(a.d+b.d)/2-0.01;
  }
  function rectangle(a,b,project) {
    const snap=n=>Math.round(n*4)/4;
    const clamp=(v,limit)=>Math.max(-limit/2+0.1,Math.min(limit/2-0.1,v));
    const ax=clamp(snap(a.x),project.width),az=clamp(snap(a.z),project.depth);
    const bx=clamp(snap(b.x),project.width),bz=clamp(snap(b.z),project.depth);
    return {id:uid(),name:'새 공간',type:'common',x:(ax+bx)/2,z:(az+bz)/2,w:Math.abs(ax-bx),d:Math.abs(az-bz),beds:0};
  }
  function addRoom(project,level,room) {
    const floor=project.floors.find(f=>f.level===level);
    if(!floor || floor.rooms.length>=40) throw new Error('한 층에 공간은 최대 40개까지 구성할 수 있습니다.');
    if(room.w<0.5 || room.d<0.5) throw new Error('공간의 두 모서리를 조금 더 넓게 지정해주세요.');
    if(!inside(room,project)) throw new Error('건물 범위 안에 공간을 지정해주세요.');
    if(floor.rooms.some(existing=>intersects(existing,room))) throw new Error('기존 공간과 겹칩니다. 비어 있는 위치를 지정해주세요.');
    floor.rooms.push(room); project.example=false;
    return room;
  }
  return {TYPES,COLORS,uid,blank,sample,validate,inside,intersects,rectangle,addRoom};
});
