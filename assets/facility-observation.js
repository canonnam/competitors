export function initObservation(ctx){
  const $=id=>document.getElementById(id),O=window.FacilityObservation;
  let data=null,connected=false,sequence=0,controller=null,currentBranch=null;
  const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
  function status(text,kind=''){$('observation-status').textContent=text;$('observation-status').dataset.status=kind;}
  function clear(){data=null;ctx.changed();$('observation-list').replaceChildren();$('observation-summary').textContent='';}
  async function api(path,options={}){
    const response=await fetch('/api/facility-observation/'+path,{cache:'no-store',credentials:'same-origin',...options});
    const body=await response.json();if(!response.ok){const error=new Error(body.error||'ERP 조회에 실패했습니다.');error.status=response.status;throw error;}return body;
  }
  function connection(value){connected=value;$('observation-connect').textContent=value?'ERP 다시 연결':'ERP 로그인';$('observation-disconnect').hidden=!value;}
  function mapped(){return O.map(ctx.getProject(),data);}
  function render(){
    const project=ctx.getProject(),result=mapped(),floor=ctx.getFloor();
    $('observation-list').replaceChildren();
    if(!data)return;
    const pending=result.items.filter(r=>r.reason).length;
    $('observation-summary').textContent=`집중 ${result.focus}명 · 주의 ${result.watch}명${pending?' · 위치 확인 '+pending+'명':''}`;
    const relevant=result.items.filter(r=>r.level===floor.level||r.level===null);
    for(const row of relevant){
      const item=make('div',null,'f3-observation-person'),name=make('strong',row.elderly_name),tier=make('span',row.risk_tier_display,'f3-risk f3-risk-'+row.risk_tier);
      const location=row.reportedLevel?`${row.reportedLevel}층 · ${row.living_room_name||'생활실 정보 없음'}`:'층 정보 없음';
      const info=make('small',location+(row.reason?' · '+row.reason:''));item.append(name,tier,info);
      if(row.roomId){const button=make('button','도면에서 보기','ui-button');button.type='button';button.onclick=()=>ctx.select(row.level,row.roomId);item.append(button);}
      $('observation-list').append(item);
    }
    if(!relevant.length)$('observation-list').append(make('p',`${floor.level}층의 집중·주의관찰 대상자가 없습니다.`,'f3-small'));
    if(!O.registered(floor)&&relevant.length)$('observation-list').prepend(make('p','이 층에 도면을 등록하면 위치를 표시합니다.','f3-small'));
  }
  async function load(){
    const branch=ctx.getProject().nursingHomeId,id=++sequence;controller?.abort();controller=new AbortController();currentBranch=branch;clear();
    $('observation-refresh').disabled=true;
    if(!branch){status('이름·지점 변경에서 ERP 지점을 선택하면 관찰 대상자를 연결합니다.');$('observation-refresh').disabled=false;return;}
    status('ERP에서 오늘의 집중·주의관찰 대상자를 조회하고 있습니다.');
    const active=controller,timeout=setTimeout(()=>active.abort(),60000);
    try{
      const session=await api('session',{signal:controller.signal});if(id!==sequence)return;connection(session.connected);
      if(!session.connected){status('ERP 로그인으로 연결하면 페이지를 열 때 관찰 대상자를 갱신합니다.');return;}
      const result=await api('targets?nursing_home_id='+branch,{signal:controller.signal});
      if(id!==sequence||ctx.getProject().nursingHomeId!==branch)return;
      data=result;render();ctx.changed();
      const date=new Date(result.checkedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
      status(`${result.nursingHomeName} · ${result.snapshotDate} 관찰 자료 · ${date} 조회 완료`,'success');
    }catch(error){
      if(id!==sequence)return;clear();if(error.status===401)connection(false);
      status(error.name==='AbortError'?'조회 시간이 길어졌습니다. 다시 조회해주세요.':error.message,'error');
    }finally{clearTimeout(timeout);if(id===sequence)$('observation-refresh').disabled=false;}
  }
  $('observation-refresh').onclick=load;
  $('observation-connect').onclick=()=>{$('erp-login-form').reset();$('erp-login-status').textContent='';$('erp-login-dialog').showModal();};
  $('erp-login-cancel').onclick=()=>$('erp-login-dialog').close();
  $('erp-login-dialog').addEventListener('close',()=>{$('erp-password').value='';});
  $('erp-login-dialog').addEventListener('cancel',event=>{if($('erp-login-submit').disabled)event.preventDefault();});
  $('erp-login-form').onsubmit=async event=>{
    event.preventDefault();$('erp-login-submit').disabled=true;$('erp-login-cancel').disabled=true;$('erp-login-status').textContent='ERP에 연결하고 있습니다.';
    const credentials={username:$('erp-username').value.trim(),password:$('erp-password').value};$('erp-password').value='';
    try{
      await api('session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
      connection(true);$('erp-login-dialog').close();await load();
    }catch(error){$('erp-login-status').textContent=error.message;}
    finally{$('erp-login-submit').disabled=false;$('erp-login-cancel').disabled=false;credentials.password='';}
  };
  $('observation-disconnect').onclick=async()=>{
    sequence++;controller?.abort();clear();
    try{await api('session',{method:'DELETE'});connection(false);status('ERP 연결을 해제했습니다.');}
    catch(error){status(error.message,'error');}
    $('observation-refresh').disabled=false;
  };
  window.addEventListener('pageshow',event=>{if(event.persisted)load();});
  window.addEventListener('pagehide',()=>{sequence++;controller?.abort();clear();});
  return {load,mapped,render,sync(){if(currentBranch!==ctx.getProject().nursingHomeId)load();else render();}};
}
