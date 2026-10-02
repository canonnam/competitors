export function initStaff(ctx){
  const M=window.FacilityModel,S=window.FacilityStaff,$=id=>document.getElementById(id);let floorId=null,last='',running=!matchMedia('(prefers-reduced-motion: reduce)').matches;
  for(const [role,name]of Object.entries(M.STAFF_ROLES)){const label=document.createElement('label');label.textContent=name;const input=document.createElement('input');input.type='number';input.min='0';input.max='20';input.step='1';input.value='0';input.id='staff-count-'+role;label.append(input);$('staff-fields').append(label);}
  function render(){const f=ctx.getFloor(),stamp=JSON.stringify(f.staff||[]);$('staff-heading').textContent=M.floorName(f.level)+' 종사자 배치';if(floorId!==f.id||last!==stamp){floorId=f.id;last=stamp;for(const role of Object.keys(M.STAFF_ROLES))$('staff-count-'+role).value=(f.staff||[]).find(r=>r.role===role)?.count??0;}
    $('staff-legend').replaceChildren();for(const r of f.staff||[]){if(!r.count)continue;const item=document.createElement('span');item.textContent=M.STAFF_ROLES[r.role]+' '+r.count+'명';item.style.setProperty('--staff-color',S.COLORS[r.role]);$('staff-legend').append(item);}button();}
  function button(){$('staff-toggle').textContent=running?'직원 이동 일시정지':'직원 이동 재생';$('staff-toggle').setAttribute('aria-pressed',String(running));}
  $('staff-form').onsubmit=event=>{event.preventDefault();try{const next=structuredClone(ctx.getProject()),f=next.floors.find(f=>f.id===ctx.getFloor().id);f.staff=M.validateStaff(Object.keys(M.STAFF_ROLES).map(role=>({role,count:Number($('staff-count-'+role).value)})).filter(r=>r.count));M.validate(next);ctx.getFloor().staff=f.staff;$('staff-error').textContent='';ctx.applied();render();}catch(error){$('staff-error').textContent=error.message;}};
  $('staff-toggle').onclick=()=>{running=!running;button();ctx.updated();};$('staff-speed').onchange=()=>ctx.updated();
  return {render,active:()=>running,speed:()=>Number($('staff-speed').value)};
}
