import {checkAccess} from './facility-access.js?v=20261009-viewer1';
/* The browser reads the authenticated hourly room and resident cache. */
export function initObservation(ctx){
  const $=id=>document.getElementById(id),O=window.FacilityObservation,M=window.FacilityModel;
  let data=null,sequence=0,controller=null,currentBranch=null,detailFloor=null,lastView='';
  const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
  const aggregate=()=>['building','exploded'].includes(ctx.getMode());
  const floorLabel=f=>`${M.floorName(f.level)}${f.name!==M.floorName(f.level)?' · '+f.name:''}`;
  function status(text,kind=''){$('observation-status').textContent=text;$('observation-status').dataset.status=kind;const button=$('collection-help-button');button.dataset.status=kind;button.setAttribute('aria-label',kind==='error'?'자동 수집 안내 · 조회 오류':kind==='warning'?'자동 수집 안내 · 이전 자료':'자동 수집 안내');}
  function mapped(){return O.operating(ctx.getProject(),data);}
  function metrics(parent,focus,watch){
    parent.append(make('span','집중 '+focus+'명','f3-risk '+(focus?'f3-risk-focus':'f3-risk-normal')),
      make('span','주의 '+watch+'명','f3-risk '+(watch?'f3-risk-watch':'f3-risk-normal')));
  }
  function residentNames(item,g){
    if(!Array.isArray(g.residents)){item.append(make('small','입소자 이름 자료 없음'));return;}
    const names=make('div',null,'f3-resident-list');
    for(const person of g.residents){
      const label=person.uncertain?'관찰 연결 확인 필요':person.tier==='focus'?'집중':person.tier==='watch'?'주의':'일상';
      const chip=make('span',null,'f3-resident');chip.title=label;chip.setAttribute('aria-label',person.name+' · '+label);
      if(person.tier){const dot=make('span',null,'f3-resident-dot');dot.dataset.tier=person.tier;dot.setAttribute('aria-hidden','true');chip.append(dot);}
      chip.append(make('span',person.name+(person.uncertain?' · 확인 필요':'')));names.append(chip);
    }
    if(!g.residents.length)names.append(make('small',g.occupancy===0?'현재 입소자 없음':'입소자 명단 확인 필요'));
    item.append(names);
    if(g.occupancy!==null&&g.residents.length!==g.occupancy)item.append(make('small',`명단 ${g.residents.length}명 · 현원과 차이가 있어 확인이 필요합니다.`));
  }
  function roomCard(g,choose=false){
    const item=make('div',null,'f3-observation-person');item.append(make('strong',g.roomName));
    item.append(make('small',g.occupancy==null?'현원 미연결':`현원 ${g.occupancy}명 / 정원 ${g.capacity}명 · 잔여 ${g.remaining}명`));metrics(item,g.focus,g.watch);residentNames(item,g);
    if(choose&&g.roomId){const b=make('button','생활실 보기','ui-button');b.type='button';b.onclick=()=>open({...g,kind:'room'});item.append(b);}
    return item;
  }
  function render(){
    const result=mapped(),floor=ctx.getFloor(),room=ctx.getRoom(),list=$('observation-list');
    const view=ctx.getProject().id+'|'+ctx.getMode()+'|'+(aggregate()?'all':floor.level);
    if(view!==lastView){detailFloor=null;$('observation-details').hidden=true;lastView=view;}
    $('observation-open').hidden=!$('observation-details').hidden;
    list.replaceChildren();$('observation-back').hidden=!aggregate()||detailFloor===null;
    $('observation-detail-title').textContent=aggregate()&&detailFloor===null?'층별 현황':room?`${M.floorName(floor.level)} · ${room.name}`:floorLabel(floor)+' 현황';
    if(!data){$('observation-summary').textContent='';list.append(make('p','생활실 자료를 불러오면 현원과 관찰 인원을 표시합니다.','f3-small'));return;}
    const pending=result.items.filter(r=>r.reason).reduce((n,r)=>n+r.focus+r.watch,0);
    $('observation-summary').textContent=`시설 전체 · 배정 ${result.assignedOccupancy}명 · 집중 ${result.focus} · 주의 ${result.watch}${data.stale?' · 이전 자료':''}`;
    if(aggregate()&&detailFloor===null){
      for(const f of [...result.floorSummaries].reverse()){
        const b=make('button',null,'ui-button f3-view-floor');b.type='button';
        b.append(make('strong',floorLabel(f)),make('small',f.occupancy==null?'생활실 현원 미연결':`현원 ${f.occupancy}명`));metrics(b,f.focus,f.watch);
        if(f.pending)b.append(make('small','위치 확인 '+f.pending+'명'));
        b.setAttribute('aria-label',`${floorLabel(f)} · ${f.occupancy==null?'현원 미연결':'현원 '+f.occupancy+'명'} · 집중 ${f.focus}명 · 주의 ${f.watch}명 · 층 정보 보기`);
        b.onclick=()=>open({kind:'floor',level:f.level,roomId:null});list.append(b);
      }
      if(pending)list.append(make('p','위치 확인이 필요한 관찰 인원 '+pending+'명','f3-small'));
    }else{
      const chosenRoom=aggregate()?null:room,summary=result.floorSummaries.find(f=>f.level===floor.level);
      if(!chosenRoom&&summary){
        const card=make('div',null,'f3-observation-person');card.append(make('strong',floorLabel(summary)),make('small',summary.occupancy==null?'생활실 현원 미연결':`현원 ${summary.occupancy}명 / 정원 ${summary.capacity}명`));metrics(card,summary.focus,summary.watch);list.append(card);
      }
      const groups=result.groups.filter(g=>g.level===floor.level&&(!chosenRoom||g.roomId===chosenRoom.id));
      groups.forEach(g=>list.append(roomCard(g,!chosenRoom&&!aggregate())));
      if(chosenRoom&&!groups.length)list.append(make('p','ERP 생활실과 일치하지 않습니다. 층과 생활실 이름을 확인해주세요.','f3-small'));
      if(!chosenRoom){
        for(const r of result.unmatchedRooms.filter(r=>r.level===floor.level||r.level===null))list.append(make('p',`${r.reportedLevel?M.floorName(r.reportedLevel)+' · ':''}${r.name} · 현원 ${r.occupancy}명 · ${r.reason}`,'f3-small'));
        for(const r of result.items.filter(r=>r.reason&&(r.level===floor.level||r.level===null)))list.append(make('p',`${r.reportedLevel?M.floorName(r.reportedLevel):'층 정보 없음'} · ${r.living_room_name||'생활실 정보 없음'} · 집중 ${r.focus} · 주의 ${r.watch} · ${r.reason}`,'f3-small'));
      }
    }
    const legend=make('p',null,'f3-small f3-resident-list');
    for(const [tier,label] of [['focus','집중'],['watch','주의']]){const text=make('span',null,'f3-resident');const dot=make('span',null,'f3-resident-dot');dot.dataset.tier=tier;dot.setAttribute('aria-hidden','true');text.append(dot,make('span',label));legend.append(text);}list.append(legend);
  }
  function open(target){
    ctx.select(target.level,target.roomId??null);
    detailFloor=aggregate()?target.level:null;$('observation-details').hidden=false;
    render();$('observation-details').focus({preventScroll:true});
  }
  function close(){$('observation-details').hidden=true;$('observation-open').hidden=false;$('space-canvas').focus({preventScroll:true});}
  $('observation-close').onclick=close;
  $('observation-open').onclick=()=>{$('observation-details').hidden=false;render();$('observation-details').focus({preventScroll:true});};
  $('observation-back').onclick=()=>{detailFloor=null;render();};
  $('observation-details').addEventListener('keydown',event=>{if(event.key==='Escape'){close();event.stopPropagation();}});
  async function load(){
    const branch=ctx.getProject().nursingHomeId,id=++sequence;controller?.abort();controller=new AbortController();const previous=data;currentBranch=branch;if(previous?.nursingHomeId!==branch){data=null;ctx.changed();}
    if(!branch){status('ERP 지점 미연결');$('observation-status').title='더보기 → 이름·지점 변경에서 ERP 지점을 선택하세요.';return;}status('자동 수집 확인 중');const active=controller,timeout=setTimeout(()=>active.abort(),15000);
    try{const response=await fetch('/api/facility-observation/residents?nursing_home_id='+branch,{cache:'no-store',credentials:'same-origin',signal:active.signal});checkAccess(response);const body=await response.json();if(!response.ok)throw new Error(body.error||'생활실 자료를 불러오지 못했습니다.');if(id!==sequence||ctx.getProject().nursingHomeId!==branch)return;data=body;if(JSON.stringify(previous)!==JSON.stringify(body))ctx.changed();else render();const checked=new Date(body.checkedAt),date=checked.toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}),time=checked.toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit'});status(`자동 수집 ${time} · 1시간 간격${body.stale?' · 이전 자료':''}`,body.stale?'warning':'success');$('observation-status').title=`${body.nursingHomeName} · ${date} 수집${body.stale?' · '+(body.collectionError||'갱신 대기'):''}`;}
    catch(error){if(id!==sequence)return;data=null;ctx.changed();status(error.name==='AbortError'?'자료 조회가 지연되고 있습니다.':error.message,'error');}finally{clearTimeout(timeout);}
  }
  window.addEventListener('pageshow',event=>{if(event.persisted)load();});window.addEventListener('pagehide',()=>{sequence++;controller?.abort();data=null;ctx.changed();});setInterval(()=>{if(ctx.active?ctx.active():!document.hidden)load();},60000);
  return {load,mapped,render,open,sync(){if(currentBranch!==ctx.getProject().nursingHomeId)load();else render();}};
}
