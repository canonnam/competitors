(function () {
  'use strict';
  const form = document.getElementById('contract-form');
  const get = name => form.elements.namedItem(name);
  const $ = id => document.getElementById(id);
  const branches = {
    anyang: {organization:'더비다요양원',representative:'임경애',organizationAddress:'경기도 안양시 만안구 전파로 19-1'},
    incheon: {organization:'더비다요양원',representative:'임경애',organizationAddress:'인천시 미추홀구 제물량로 4번길 34-33(숭의동)'},
  };
  const defaultShifts = () => ({
    D: {start:'09:00',end:'18:00',breaks:[{start:'12:00',end:'13:00',hours:1}]},
    N: {start:'18:00',end:'09:00',breaks:[{start:'18:00',end:'22:00',hours:.5},{start:'22:00',end:'06:00',hours:5},{start:'06:00',end:'09:00',hours:.5}]},
  });
  let pattern = ['D','D','N','N','O','O'], shifts=defaultShifts(), revision=0, model=null, lastURL=null, resources=null;
  const defaultExtras=()=>['식대','자가운전보조금','장기근속수당','기타수당','특별상여'].map(name=>({name,amount:'',ordinary:name!=='장기근속수당'}));
  let extras = defaultExtras();
  const money = n => n == null ? '미입력' : `${Math.round(n).toLocaleString('ko-KR')}원`;
  const dec = n => Number(n.toFixed(4)).toLocaleString('ko-KR');
  function el(tag, props={}, text) {
    const node=document.createElement(tag);
    for(const [key,value] of Object.entries(props)) {
      if(key==='dataset')Object.assign(node.dataset,value);else if(key==='className')node.className=value;else if(key in node)node[key]=value;else node.setAttribute(key,value);
    }
    if(text!=null)node.textContent=text;
    return node;
  }
  function label(title,input){const l=el('label',{},title);l.append(input);return l;}
  function iconButton(title,icon,handler){const b=el('button',{type:'button',title,'aria-label':title});b.append(el('img',{src:`/assets/icons/${icon}.svg`,alt:'',width:16,height:16}));b.onclick=handler;return b;}
  function renderPattern(){
    $('pattern').replaceChildren();const weekly=get('scheduleMode').value==='weekly';
    $('pattern-actions').hidden=weekly;
    pattern.forEach((id,i)=>{
      const day=el('div',{className:'pattern-day',dataset:{shift:id}});
      day.append(el('span',{},weekly?['월','화','수','목','금','토','일'][i]:`${i+1}일`));
      const select=el('select',{'aria-label':`${weekly?['월','화','수','목','금','토','일'][i]+'요일':(i+1)+'일차'} 근무`});
      for(const [value,text] of [['D','주'],['N','야'],['O','휴']])select.append(el('option',{value},text));
      select.value=id;select.onchange=()=>{pattern[i]=select.value;get('preset').value='custom';renderPattern();renderShifts();update();};day.append(select);
      if(!weekly)day.append(iconButton(`${i+1}일차 삭제`,'x',()=>{if(pattern.length>1){pattern.splice(i,1);get('preset').value='custom';renderPattern();renderShifts();update();}}));
      $('pattern').append(day);
    });
  }
  function renderShifts(){
    $('shift-editors').replaceChildren();
    for(const id of ['D','N']){
      if(!pattern.includes(id))continue;
      const spec=shifts[id],section=el('div',{className:'shift-editor'});section.append(el('h3',{},id==='D'?'주간근무':'야간근무'));
      const times=el('div',{className:'shift-times'});
      for(const [key,text] of [['start','출근'],['end','퇴근']]){
        const input=el('input',{type:'time',value:spec[key],required:true});input.oninput=()=>{spec[key]=input.value;update();};times.append(label(text,input));
      }
      section.append(times);
      spec.breaks.forEach((rest,i)=>{
        const row=el('div',{className:'break-row'});
        for(const [key,text] of [['start','휴게 시간대 시작'],['end','종료'],['hours','휴게(시간)']]){
          const input=el('input',{type:key==='hours'?'number':'time',value:rest[key],required:true,'aria-label':`${id==='D'?'주간':'야간'} 휴게 ${i+1} ${text}`});
          if(key==='hours'){input.min='0';input.max='24';input.step='0.25';}
          input.oninput=()=>{rest[key]=input.value;update();};row.append(label(text,input));
        }
        row.append(iconButton(`${id==='D'?'주간':'야간'} 휴게 ${i+1} 삭제`,'x',()=>{spec.breaks.splice(i,1);renderShifts();update();}));section.append(row);
      });
      const add=el('button',{type:'button',className:'text-button'},'+ 휴게 시간대');add.onclick=()=>{spec.breaks.push({start:'',end:'',hours:''});renderShifts();update();};section.append(add);$('shift-editors').append(section);
    }
  }
  function renderExtras(){
    $('allowances').replaceChildren();
    extras.forEach((item,i)=>{
      const row=el('div',{className:'allowance-row'}),name=el('input',{value:item.name,maxLength:30,'aria-label':`수당 ${i+1} 명칭`});
      const amount=el('input',{type:'number',min:0,max:100000000,step:1,value:item.amount,inputMode:'numeric','aria-label':`수당 ${i+1} 금액`});
      const ordinary=el('input',{type:'checkbox',checked:item.ordinary,'aria-label':`수당 ${i+1} 통상임금 포함`});
      name.oninput=()=>{item.name=name.value;update();};amount.oninput=()=>{item.amount=amount.value;update();};ordinary.onchange=()=>{item.ordinary=ordinary.checked;update();};
      row.append(name,amount,label('',ordinary),iconButton(`수당 ${i+1} 삭제`,'trash-2',()=>{extras.splice(i,1);renderExtras();update();}));row.children[2].className='ordinary-label';$('allowances').append(row);
    });
  }
  function fieldValues(){
    const fields=Object.fromEntries(new FormData(form));fields.includeFlexibleClause=get('includeFlexibleClause').checked;return fields;
  }
  function schedule(){return {mode:get('scheduleMode').value,pattern:pattern.slice(),shifts:structuredClone(shifts),weeklyPaidHours:get('weeklyPaidHours').value};}
  function inputErrors(f){
    if(f.residentNumber && !/^\d{6}-?\d{7}$/.test(f.residentNumber))throw Error('주민등록번호는 숫자 13자리로 입력하거나 공란으로 남겨주세요.');
    if(f.term==='fixed' && f.startDate && f.endDate && f.endDate<f.startDate)throw Error('계약 종료일은 시작일 이후여야 합니다.');
    if(f.paymentDay && (!Number.isInteger(Number(f.paymentDay)) || Number(f.paymentDay)<1 || Number(f.paymentDay)>31))throw Error('급여 지급일은 1~31일로 입력해주세요.');
    if(extras.some(x=>Number(x.amount)>0&&!x.name.trim()))throw Error('금액이 있는 수당의 명칭을 입력해주세요.');
    if(f.includeFlexibleClause && f.workingSystem!=='flexible')throw Error('탄력근로제 조항을 포함할 때는 근로시간제를 함께 선택해주세요.');
  }
  function readModel(){
    const fields=fieldValues(),s=schedule();inputErrors(fields);
    const computedHours=PayrollCore.hours(s);
    let result;
    if(fields.basis==='manual'){
      const number=(value)=>value===''?null:Number(value);
      const amounts=['manualBasic','manualHourly','manualOvertime','manualNight'].map(k=>number(fields[k]));
      if(amounts.some(x=>x!==null&&(!Number.isFinite(x)||x<0)))throw Error('급여는 0 이상의 숫자로 입력해주세요.');
      const items=extras.map(x=>({...x,amount:Number(x.amount||0)}));
      if(items.some(x=>!Number.isFinite(x.amount)||x.amount<0))throw Error('수당 금액을 확인해주세요.');
      const [basic,hourly,overtime,night]=amounts;
      result={basic,hourly,overtime,night,extras:items,pending:basic===null,total:basic===null?null:basic+(overtime||0)+(night||0)+items.reduce((s,x)=>s+x.amount,0),hours:fields.workingSystem==='flexible'?null:computedHours};
    }else result=PayrollCore.calculate({...s,extras,basis:fields.basis,amount:fields.amount});
    return {fields,schedule:s,result,workText:PayrollCore.workText(s)};
  }
  function dl(id,items){
    $(id).replaceChildren();for(const [term,value] of items)$(id).append(el('dt',{},term),el('dd',{},value));
  }
  function invalidate(){revision++;model=null;if(lastURL){URL.revokeObjectURL(lastURL);lastURL=null;$('pdf-preview').removeAttribute('src');}$('pdf-status').textContent='';}
  function update(){
    invalidate();$('input-errors').hidden=true;
    const manual=get('basis').value==='manual';$('manual-pay').hidden=!manual;$('auto-pay').hidden=manual;
    $('amount-label').firstChild.textContent=get('basis').value==='hourly'?'통상시급 (원)':'월 급여 총액 (세전·원)';
    $('end-date-field').hidden=get('term').value!=='fixed';
    try{
      model=readModel();const r=model.result,h=r.hours;
      $('total').textContent=money(r.total);
      dl('pay-breakdown',[['기본급',money(r.basic)],['고정연장수당',money(r.overtime)],['고정야간수당',money(r.night)],...r.extras.filter(x=>x.amount>0).map(x=>[x.name,money(x.amount)])]);
      dl('hour-breakdown',h?[
        ['월 기본시간 (주휴 포함)',`${dec(h.basic)}시간`],['월 연장근로',`${dec(h.overtime)}시간`],['월 야간근로',`${dec(h.night)}시간`],['통상시급',r.hourly==null?'미입력':`${dec(r.hourly)}원`],
      ]:[['근로시간·통상시급','별도 산정']]);
      $('formula-details').replaceChildren();
      if(h){
        const p=model.schedule.pattern;
        for(const id of ['D','N'])if(p.includes(id))$('formula-details').append(el('p',{},`${id==='D'?'주간':'야간'} 횟수: 365 ÷ ${p.length} × ${p.filter(x=>x===id).length} ÷ 12 = ${dec(h.counts[id])}회/월`));
        $('formula-details').append(el('p',{},`기본시간: 실근로 중 기본 ${dec(h.regular)} + 유급주휴 ${dec(h.paid)}시간`));
        if(!manual){
          $('formula-details').append(el('p',{},`급여 환산시간: ${dec(h.basic)} + ${dec(h.overtime)} × 1.5 + ${dec(h.night)} × 0.5 = ${dec(h.divisor)}시간`));
          $('formula-details').append(el('p',{},'연장수당 = 통상시급 × 연장시간 × 1.5\n야간수당 = 통상시급 × 야간시간 × 0.5'));
        }
      }
      $('calculation-status').textContent=model.fields.workingSystem==='flexible'?'탄력근로제는 별도로 산정한 급여를 직접 입력합니다.':h&&h.maxWeek>52?`반복주기 중 주 ${dec(h.maxWeek)}시간 근무가 있습니다. 근무조건을 확인해주세요.`:r.pending?'급여 미입력: 금액은 공란으로 출력됩니다.':'';
      $('preview-contract').disabled=false;$('download-contract').disabled=false;
    }catch(error){
      model=null;$('total').textContent='입력 확인';$('input-errors').hidden=false;$('input-errors').textContent=error.message;dl('pay-breakdown',[]);dl('hour-breakdown',[]);$('formula-details').replaceChildren();$('calculation-status').textContent='';$('preview-contract').disabled=true;$('download-contract').disabled=true;
    }
  }
  async function loadResources(){
    if(!resources)resources=Promise.all([
      fetch('/assets/contracts/templates.json').then(r=>{if(!r.ok)throw Error('계약서 양식을 불러오지 못했습니다.');return r.json();}),
      ...['Regular','Bold'].map(weight=>fetch(`/assets/contracts/NanumGothic-${weight}.ttf`).then(r=>{if(!r.ok)throw Error('한글 글꼴을 불러오지 못했습니다.');return r.arrayBuffer();})),
    ]).catch(error=>{resources=null;throw error;});
    return resources;
  }
  function filename(f){return `근로계약서_${(f.employee||'미기재').replace(/[\\/:*?"<>|]/g,'_')}.pdf`;}
  async function generate(preview){
    if(!form.reportValidity())return;
    try{
      const captured=readModel(),version=revision;
      $('pdf-status').textContent='계약서를 만드는 중입니다.';$('preview-contract').disabled=true;$('download-contract').disabled=true;
      const [templates,regular,bold]=await loadResources();
      if(!window.PDFLib||!window.fontkit)throw Error('PDF 구성요소를 불러오지 못했습니다. 페이지를 새로고침해주세요.');
      const bytes=await ContractPDF.create(captured,templates[captured.fields.template],regular,bold,{PDFLib:window.PDFLib,fontkit:window.fontkit});
      if(version!==revision){$('pdf-status').textContent='입력내용이 변경되었습니다. 다시 만들어주세요.';return;}
      if(lastURL)URL.revokeObjectURL(lastURL);lastURL=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      $('preview-download').href=lastURL;$('preview-download').download=filename(captured.fields);
      if(preview){$('pdf-preview').src=lastURL;$('preview-dialog').showModal();}
      else{const a=el('a',{href:lastURL,download:filename(captured.fields)});document.body.append(a);a.click();a.remove();}
      $('pdf-status').textContent='계약서가 생성되었습니다.';
    }catch(error){$('pdf-status').textContent=error.message||'PDF 생성에 실패했습니다. 입력내용을 확인해주세요.';}
    finally{$('preview-contract').disabled=!model;$('download-contract').disabled=!model;}
  }
  function setSystem(){
    const flex=get('workingSystem').value==='flexible';
    if(flex)get('basis').value='manual';
    form.querySelectorAll('[name=basis]').forEach(x=>{x.disabled=flex&&x.value!=='manual';});
    get('includeFlexibleClause').checked=flex;
  }
  form.addEventListener('submit',e=>e.preventDefault());
  form.addEventListener('input',event=>{if(event.target.name)update();});
  form.addEventListener('change',event=>{
    const name=event.target.name;
    if(name==='branch'&&branches[event.target.value])for(const [k,v] of Object.entries(branches[event.target.value]))get(k).value=v;
    if(name==='preset'){
      const p=event.target.value;
      if(p!=='custom'){
        get('template').value=p;get('scheduleMode').value=p==='care-cycle'?'cycle':'weekly';pattern=p==='care-cycle'?['D','D','N','N','O','O']:['D','D','D','D','D','O','O'];
        if(['요양보호사','사무직',''].includes(get('job').value))get('job').value=p==='office'?'사무직':'요양보호사';
        renderPattern();renderShifts();refreshClauses();
      }
    }
    if(name==='scheduleMode'){get('preset').value='custom';if(event.target.value==='weekly')pattern=['D','D','D','D','D','O','O'];renderPattern();renderShifts();}
    if(name==='workingSystem')setSystem();
    if(name==='includeFlexibleClause'){get('workingSystem').value=event.target.checked?'flexible':'standard';setSystem();}
    if(name==='template')refreshClauses();
    if(name)update();
  });
  get('residentNumber').addEventListener('blur',()=>{const digits=get('residentNumber').value.replace(/-/g,'');if(/^\d{13}$/.test(digits)){get('residentNumber').value=`${digits.slice(0,6)}-${digits.slice(6)}`;update();}});
  $('add-day').onclick=()=>{if(pattern.length<42){pattern.push('D');get('preset').value='custom';renderPattern();renderShifts();update();}};
  $('add-allowance').onclick=()=>{if(extras.length<15){extras.push({name:'',amount:'',ordinary:true});renderExtras();update();}};
  $('clear-form').onclick=()=>{if(!window.confirm('입력한 계약정보를 초기화할까요?'))return;form.reset();pattern=['D','D','N','N','O','O'];shifts=defaultShifts();extras=defaultExtras();renderPattern();renderShifts();renderExtras();setSystem();update();refreshClauses();};
  $('preview-contract').onclick=()=>generate(true);$('download-contract').onclick=()=>generate(false);$('close-preview').onclick=()=>$('preview-dialog').close();
  async function refreshClauses(){
    try{const r=await fetch('/assets/contracts/templates.json');if(!r.ok)return;const templates=await r.json();const selected=templates[get('template').value];$('clauses-text').textContent=selected.cells.filter(c=>c.c===2&&c.cols>5&&c.text).map(c=>c.text).join('\n\n');}catch{$('clauses-text').textContent='문구를 불러오지 못했습니다.';}
  }
  renderPattern();renderShifts();renderExtras();update();refreshClauses();
  window.addEventListener('pagehide',()=>{if(lastURL)URL.revokeObjectURL(lastURL);});
})();
