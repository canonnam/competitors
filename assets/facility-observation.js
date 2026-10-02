/* The browser reads only the server's hourly anonymous room cache. */
export function initObservation(ctx){
  const $=id=>document.getElementById(id),O=window.FacilityObservation;
  let data=null,sequence=0,controller=null,currentBranch=null;
  const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
  function status(text,kind=''){$('observation-status').textContent=text;$('observation-status').dataset.status=kind;}
  function mapped(){return O.operating(ctx.getProject(),data);}
  function render(){
    const result=mapped(),floor=ctx.getFloor(),room=ctx.getRoom();$('observation-list').replaceChildren();$('observation-detail-title').textContent=room?`${floor.level}층 · ${room.name}`:`${floor.level}층 생활실 현황`;
    if(!data){$('observation-summary').textContent='';$('observation-list').append(make('p','생활실 자료를 불러오면 현원과 관찰 인원을 표시합니다.','f3-small'));return;}
    const pending=result.items.filter(r=>r.reason).reduce((n,r)=>n+r.focus+r.watch,0);$('observation-summary').textContent=`생활실 배정 ${result.assignedOccupancy}명 · 집중 ${result.focus}명 · 주의 ${result.watch}명${pending?' · 위치 확인 '+pending+'명':''}`;
    const groups=room?result.groups.filter(g=>g.level===floor.level&&g.roomId===room.id):result.groups.filter(g=>g.level===floor.level);
    for(const g of groups){const item=make('div',null,'f3-observation-person');item.append(make('strong',g.roomName));item.append(make('small',g.occupancy===null?'현원 미연결':`현재 ${g.occupancy}명 / 정원 ${g.capacity}명 · 잔여 ${g.remaining}명`));if(g.focus)item.append(make('span','집중관찰 '+g.focus+'명','f3-risk f3-risk-focus'));if(g.watch)item.append(make('span','주의관찰 '+g.watch+'명','f3-risk f3-risk-watch'));if(!g.focus&&!g.watch)item.append(make('small','집중·주의관찰 대상자 없음'));if(g.roomId&&!room){const b=make('button','공간 선택','ui-button');b.type='button';b.onclick=()=>ctx.select(g.level,g.roomId);item.append(b);}$('observation-list').append(item);}
    if(room&&!groups.length)$('observation-list').append(make('p','이 공간과 일치하는 ERP 생활실 자료가 없습니다. 층과 공간 이름을 확인해주세요.','f3-small'));
    if(!room){for(const r of result.unmatchedRooms.filter(r=>r.level===floor.level||r.level===null))$('observation-list').append(make('p',`${r.reportedLevel?r.reportedLevel+'층 · ':''}${r.name} · 현재 ${r.occupancy}명 · ${r.reason}`,'f3-small'));for(const r of result.items.filter(r=>r.reason&&(r.level===floor.level||r.level===null)))$('observation-list').append(make('p',`${r.reportedLevel?r.reportedLevel+'층':'층 정보 없음'} · ${r.living_room_name||'생활실 정보 없음'} · 집중 ${r.focus} · 주의 ${r.watch} · ${r.reason}`,'f3-small'));if(!$('observation-list').childElementCount)$('observation-list').append(make('p','이 층에 연결된 생활실 자료가 없습니다.','f3-small'));}
    $('observation-list').append(make('p','현원은 생활실에 배정된 재원 인원입니다. 공개 화면에는 실명과 개인별 건강정보를 표시하지 않습니다.','f3-small'));
  }
  async function load(){
    const branch=ctx.getProject().nursingHomeId,id=++sequence;controller?.abort();controller=new AbortController();const previous=data;currentBranch=branch;if(previous?.nursingHomeId!==branch){data=null;ctx.changed();}
    if(!branch){status('이름·지점 변경에서 ERP 지점을 선택하면 생활실 현황을 표시합니다.');return;}status('최근 자동 수집한 생활실 자료를 불러오고 있습니다.');const active=controller,timeout=setTimeout(()=>active.abort(),15000);
    try{const response=await fetch('/api/facility-observation/data?nursing_home_id='+branch,{cache:'no-store',credentials:'same-origin',signal:active.signal});const body=await response.json();if(!response.ok)throw new Error(body.error||'생활실 자료를 불러오지 못했습니다.');if(id!==sequence||ctx.getProject().nursingHomeId!==branch)return;data=body;if(JSON.stringify(previous)!==JSON.stringify(body))ctx.changed();else render();const date=new Date(body.checkedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});status(`${body.nursingHomeName} · 1시간마다 자동 수집 · ${date} 수집${body.stale?' · 이전 자료: '+(body.collectionError||'갱신 대기'):''}`,body.stale?'warning':'success');}
    catch(error){if(id!==sequence)return;data=null;ctx.changed();status(error.name==='AbortError'?'자료 조회가 지연되고 있습니다.':error.message,'error');}finally{clearTimeout(timeout);}
  }
  window.addEventListener('pageshow',event=>{if(event.persisted)load();});window.addEventListener('pagehide',()=>{sequence++;controller?.abort();data=null;ctx.changed();});setInterval(()=>{if(!document.hidden)load();},60000);
  return {load,mapped,render,sync(){if(currentBranch!==ctx.getProject().nursingHomeId)load();else render();}};
}
