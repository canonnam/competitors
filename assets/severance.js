(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('sv-form');
  const field = name => form.elements.namedItem(name);
  const fmt = n => Number(n).toLocaleString('ko-KR', {maximumFractionDigits:2});
  const node = (tag, text, cls) => {const n=document.createElement(tag); if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  let schedule=[], saved=null, calculated=null, loadSequence=0, peopleSequence=0, historySequence=0, historyView='active', busy=false, autoTimer;
  const api = async (route, body) => {
    const response=await fetch('/api/severance/'+route,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {cache:'no-store'});
    let value;try{value=await response.json();}catch{throw Error('응답을 읽지 못했습니다. 로그인 상태와 연결을 확인해주세요.');}
    if(!response.ok)throw Error(value.error||'요청을 처리하지 못했습니다.');return value;
  };
  const status=(message,error=false)=>{ $('sv-status').textContent=message;$('sv-status').dataset.status=error?'error':'success';if(error)$('sv-status').scrollIntoView({behavior:'smooth',block:'center'}); };
  const setBusy=value=>{busy=value;form.inert=value;['sv-load','sv-calculate','sv-save','sv-new','sv-refresh','sv-view-active','sv-view-deleted'].forEach(id=>$(id).disabled=value);$('sv-records').querySelectorAll('button').forEach(button=>button.disabled=value);};
  const dirty=()=>{calculated=null;$('sv-result').hidden=true;};
  const clearWages=()=>{clearTimeout(autoTimer);loadSequence++;schedule=[];$('sv-wages').replaceChildren();$('sv-wage-wrap').hidden=true;$('sv-wage-empty').hidden=false;$('sv-period').textContent='직원과 날짜를 입력하면 급여가 자동으로 연결됩니다.';dirty();};
  const sealLabel=()=>{$('sv-seal-label').textContent=(field('branch').value==='2'?'안양점':'인천점')+' 직인 포함';};
  async function people(){
    const seq=++peopleSequence;$('sv-employees').replaceChildren();
    try{const r=await api('employees?branch='+field('branch').value);if(seq!==peopleSequence)return;
      r.employees.forEach(p=>{const option=node('option');option.value=p.name;option.label=[p.position,p.lastMonth].filter(Boolean).join(' · ');$('sv-employees').append(option);});
      if(!schedule.length&&!busy)status(r.employees.length+'명의 급여 명단을 불러왔습니다. 재직기간을 입력해주세요.');
    }catch(e){if(seq===peopleSequence)status(e.message,true);}
  }
  function input(type,value,label,key){const n=node('input');n.type=type;n.value=value??'';n.setAttribute('aria-label',label);n.dataset.field=key;return n;}
  function renderWages(rows, values=[]){
    schedule=rows;$('sv-wages').replaceChildren();
    rows.forEach((p,i)=>{
      const v=values[i], tr=node('tr');tr.dataset.index=i;
      const period=node('td',p.month);period.append(node('small',p.start.slice(5)+' ~ '+p.end.slice(5)+' · '+p.days+'일'));tr.append(period);
      const source=node('td'), choice=node('select');choice.dataset.field='sourceKey';choice.setAttribute('aria-label',p.month+' 원본 급여');
      choice.append(new Option('원본 선택',''));
      p.candidates.forEach((c,j)=>choice.append(new Option((c.position||'직책 미확인')+' · '+(c.gross===null?'세전금액 없음':fmt(c.gross)+'원')+(p.candidates.length>1?' ('+(j+1)+')':''),c.key)));
      choice.value=v?.sourceKey||(p.candidates.length===1?p.candidates[0].key:'');
      choice.required=p.candidates.length>1;
      if(!p.candidates.length){source.append(node('span','급여 원본 없음'));choice.hidden=true;}
      else if(p.candidates.length===1){source.append(node('span',p.candidates[0].gross===null?'세전금액 없음':fmt(p.candidates[0].gross)+'원'));choice.hidden=true;}
      source.append(choice);if(p.candidates.length>1)source.append(node('small','동일 이름의 행이 여러 개입니다. 해당 직원을 선택해주세요.'));
      const files=p.sources.map(s=>s.file+(s.sheet?' · '+s.sheet:'')).join('\n');if(files){const d=node('details');d.append(node('summary','급여 출처'),node('small',files));source.append(d);}
      const sourceNote=node('small');source.append(sourceNote);tr.append(source);
      const treatment=node('td'), amount=input('number','',p.month+' 기간 급여','amount');amount.min='0';amount.step='1';amount.required=true;amount.placeholder='확인한 금액 입력';
      const basis=node('small'),quick=node('div',undefined,'sv-quick'),effective=node('small');treatment.append(amount,basis,quick,effective);tr.append(treatment);
      const adjust=node('td'),details=node('details');details.append(node('summary','금액 조정'));
      const excluded=input('number',v?.mode==='period'?v.excluded:0,p.month+' 제외액','excluded');excluded.min='0';excluded.step='1';excluded.required=true;
      const exLabel=node('label','이 기간에서 제외할 금액');exLabel.append(excluded);details.append(exLabel);
      const reason=input('text',v?.reason||'',p.month+' 메모','reason');reason.maxLength=180;reason.placeholder='메모 (선택)';const memoLabel=node('label','참고 메모');memoLabel.append(reason);details.append(memoLabel);
      adjust.append(details);tr.append(adjust);
      const showEffective=()=>{effective.textContent=Number(excluded.value)?'최종 산입 '+fmt(Number(amount.value)-Number(excluded.value))+'원':'';};
      const setAmount=(value,label)=>{amount.value=value??'';basis.textContent=label;basis.className=value==null?'sv-confirm-amount':'';tr.dataset.basis=label;showEffective();};
      const updateSource=()=>{
        const selected=p.candidates.find(c=>c.key===choice.value);quick.replaceChildren();excluded.value='0';reason.value='';
        sourceNote.textContent=selected?(selected.workDays!=null?'원본 근무일수 '+selected.workDays+'일. ':'')+(selected.note||''):'';
        setAmount(selected?.suggested??null,selected?.suggestion||'급여 자료가 없어 해당 기간 금액을 입력해주세요.');
        if(selected?.gross!=null&&selected.gross>=0&&p.days!==p.calendarDays){
          [['원본 금액 사용',selected.gross,'원본 정산액 반영'],['일할 금액 사용',selected.prorated,'월 급여를 기간 일수로 배분']].forEach(([label,value,description])=>{
            if(value==null)return;const button=node('button',label,'ui-button');button.type='button';button.addEventListener('click',()=>{dirty();setAmount(value,description);});quick.append(button);
          });
        }
      };
      choice.addEventListener('change',updateSource);updateSource();
      if(v){setAmount(v.mode==='period'?v.amount:p.included,'저장된 기간 급여 반영');excluded.value=v.mode==='period'?v.excluded:0;reason.value=v.reason||'';details.open=Number(excluded.value)>0;showEffective();}
      amount.addEventListener('input',()=>{basis.textContent='수정한 기간 급여 반영';basis.className='';tr.dataset.basis=basis.textContent;showEffective();});excluded.addEventListener('input',showEffective);
      $('sv-wages').append(tr);
    });
    $('sv-wage-wrap').hidden=false;$('sv-wage-empty').hidden=true;
    $('sv-period').textContent=rows.length?rows[0].start+' ~ '+rows.at(-1).end+' · '+rows.reduce((sum,r)=>sum+r.days,0)+'일':'';
  }
  function payload(){
    const data=Object.fromEntries(new FormData(form));
    data.includeSeal=field('includeSeal').checked;data.standardPeriodConfirmed=!field('hasExcludedPeriod').checked;data.payItemsConfirmed=true;delete data.hasExcludedPeriod;
    data.wages=[...$('sv-wages').children].map((tr,i)=>{
      const row=Object.fromEntries([...tr.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.value]));
      return {...row,mode:'period',reason:row.reason||tr.dataset.basis+(Number(row.excluded)?' · 해당 기간 제외액 적용':''),month:schedule[i].month,sourceHash:schedule[i].sourceHash};
    });
    if(saved){data.id=saved.id;data.revision=saved.revision;}return data;
  }
  function renderResult(record){
    calculated=record;const r=record.result;$('sv-totals').replaceChildren();
    [['퇴직금 (세전)',r.severance],['추가 지급 연차수당',r.leaveDue],['세전 지급합계',r.totalBeforeTax]].forEach(([label,value])=>{const item=node('div');item.append(node('span',label),node('strong',fmt(value)+'원'));$('sv-totals').append(item);});
    let detail=`퇴직일 ${r.retirementDate} · 계속근로 ${r.tenureDays}일 · 평균임금 산정 ${r.periodDays}일\n3개월 임금 ${fmt(r.wageTotal)}원 + 상여 산입 ${fmt(r.bonusIncluded)}원 + 연차 산입 ${fmt(r.priorLeaveIncluded)}원\n1일 평균임금 ${fmt(r.averageDaily)}원 · 적용 임금 ${fmt(r.appliedDaily)}원 (${r.ordinaryApplied?'통상임금':'평균임금'})\n퇴직 시 연차수당 ${fmt(r.unusedLeavePay)}원 중 기지급 ${fmt(record.input.leaveAlreadyPaid)}원 · 지급기한 ${r.paymentDue}`;
    $('sv-result-detail').textContent=detail;$('sv-warnings').replaceChildren(...r.warnings.map(w=>node('li',w)));
    $('sv-save').textContent=saved?'변경 내용 저장':'산정 내역 저장';$('sv-download').hidden=!record.id;
    if(record.id)$('sv-download').href='/api/severance/export?id='+encodeURIComponent(record.id);
    $('sv-result').hidden=false;
  }
  async function history(){
    const seq=++historySequence, deleted=historyView==='deleted';
    $('sv-history-status').textContent=(deleted?'휴지통':'저장 내역')+'을 불러오는 중…';$('sv-history-status').removeAttribute('data-status');$('sv-records').replaceChildren();
    try{const r=await api('records?view='+historyView);if(seq!==historySequence)return;
      $('sv-history-status').textContent=r.records.length?'총 '+r.records.length+'건'+(deleted?' · 복구하면 저장 당시 금액으로 돌아갑니다.':''):(deleted?'휴지통이 비어 있습니다.':'저장한 산정 내역이 없습니다. 산정 후 저장해주세요.');
      r.records.forEach(item=>{const tr=node('tr');[item.branch===2?'안양점':'인천점',item.name,item.lastDay,fmt(item.severance)+'원',fmt(item.totalBeforeTax)+'원'].forEach(v=>tr.append(node('td',v)));
        const actions=node('td'), buttons=node('div',undefined,'sv-record-actions');
        if(!deleted){const open=node('button','열기','ui-button');open.type='button';open.disabled=busy;open.addEventListener('click',()=>openRecord(item.id));buttons.append(open);}
        const action=node('button',deleted?'복구':'삭제','ui-button');action.type='button';action.disabled=busy;action.addEventListener('click',()=>changeRecordState(item,deleted?'restore':'delete'));buttons.append(action);actions.append(buttons);tr.append(actions);$('sv-records').append(tr);});
    }catch(e){if(seq!==historySequence)return;$('sv-history-status').textContent=e.message;$('sv-history-status').dataset.status='error';}
  }
  async function changeRecordState(item,action){
    if(busy)return;
    clearTimeout(autoTimer);
    if(action==='delete'){
      const dialog=$('sv-delete-dialog');$('sv-delete-record').textContent=`${item.branch===2?'안양점':'인천점'} ${item.name} · 마지막 근무일 ${item.lastDay}`;
      dialog.returnValue='cancel';
      const confirmed=new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='delete'),{once:true}));dialog.showModal();
      if(!await confirmed)return;
    }
    setBusy(true);
    let message,error=false;
    try{await api(action,{id:item.id,revision:item.revision});message=action==='delete'?'삭제했습니다. 휴지통에서 복구할 수 있습니다.':'복구했습니다. 저장 내역에서 다시 열 수 있습니다.';
      if(action==='delete'&&saved?.id===item.id){saved=null;dirty();$('sv-record-label').textContent='';status('열려 있던 저장 내역을 삭제했습니다. 현재 입력값은 화면에 남겨두었습니다.');}
    }catch(e){message=e.message;error=true;}
    finally{await history();setBusy(false);const listError=$('sv-history-status').dataset.status==='error';$('sv-history-status').textContent=message+' '+$('sv-history-status').textContent;$('sv-history-status').dataset.status=error||listError?'error':'success';$('sv-view-'+historyView).focus();}
  }
  async function openRecord(id){
    if(busy)return;if(calculated&&!calculated.id&&!window.confirm('저장하지 않은 산정 결과가 있습니다. 다른 기록을 여시겠습니까?'))return;
    clearTimeout(autoTimer);setBusy(true);loadSequence++;
    try{const record=await api('record?id='+encodeURIComponent(id));saved=record;form.reset();
      for(const [key,value] of Object.entries(record.input)){const el=field(key);if(!el)continue;if(el.type==='checkbox')el.checked=value;else el.value=value;}
      field('hasExcludedPeriod').checked=record.input.standardPeriodConfirmed===false;renderWages(record.result.wages,record.input.wages);sealLabel();extraSummary();renderResult(record);$('sv-record-label').textContent='저장 내역 · 수정 '+record.revision+'회';status('저장 당시 입력값과 계산 결과를 열었습니다.');$('sv-form').scrollIntoView({behavior:'smooth'});
    }catch(e){status(e.message,true);}finally{setBusy(false);}
  }
  async function loadWages(automatic=false){
    clearTimeout(autoTimer);if(busy)return false;
    for(const name of ['name','hireDate','lastDay'])if(automatic?!field(name).value||!field(name).validity.valid:!field(name).reportValidity())return false;
    const seq=++loadSequence;const params=Object.fromEntries(['branch','name','hireDate','lastDay'].map(k=>[k,field(k).value]));setBusy(true);dirty();status('저장된 월별 급여를 확인하고 있습니다.');
    try{const r=await api('wages',params);if(seq!==loadSequence)return false;renderWages(r.wages);const missing=[...$('sv-wages').querySelectorAll('[data-field=amount]')].filter(el=>el.value==='').length;status(missing?`급여를 연결했습니다. ${missing}개월의 금액만 확인해주세요.`:'급여를 자동으로 채웠습니다. 필요한 금액만 수정해주세요.');return true;}
    catch(e){status(e.message,true);return false;}finally{setBusy(false);}
  }
  function extraSummary(){
    const extras=[];if(Number(field('annualBonus').value))extras.push('상여금');if(Number(field('priorLeavePay').value))extras.push('기지급 연차');if(Number(field('unusedDays').value))extras.push('잔여 연차 '+field('unusedDays').value+'일');if(Number(field('leaveAlreadyPaid').value))extras.push('연차 기지급액');if(Number(field('weeklyHours').value)!==40)extras.push('주 '+field('weeklyHours').value+'시간');if(field('hasExcludedPeriod').checked)extras.push('제외기간 있음');
    $('sv-extra-summary').textContent=extras.length?extras.join(' · '):'상여·연차 0원 · 주 40시간';
  }
  $('sv-load').addEventListener('click',()=>loadWages());
  form.addEventListener('invalid',event=>{const detail=event.target.closest('details');if(detail)detail.open=true;},true);
  form.addEventListener('input',event=>{dirty();extraSummary();if(['branch','name','hireDate','lastDay'].includes(event.target.name))clearWages();});
  form.addEventListener('change',event=>{dirty();extraSummary();if(event.target.name==='branch'){clearWages();sealLabel();people();}if(['branch','name','hireDate','lastDay'].includes(event.target.name)){clearTimeout(autoTimer);autoTimer=setTimeout(()=>loadWages(true),300);}});
  form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;if(!schedule.length&&!await loadWages())return;if(!form.reportValidity())return;setBusy(true);
    try{const r=await api('calculate',payload());renderResult(r);status('산정이 완료되었습니다. 금액을 확인하고 저장해주세요.');$('sv-result').scrollIntoView({behavior:'smooth',block:'start'});}catch(e){status(e.message,true);}finally{setBusy(false);}
  });
  $('sv-save').addEventListener('click',async()=>{if(!calculated||busy)return;setBusy(true);
    try{const record=await api('save',payload());saved=record;renderResult(record);$('sv-record-label').textContent='저장 내역 · 수정 '+record.revision+'회';status('산정 내역을 저장했습니다. 엑셀 내역서를 내려받을 수 있습니다.');await history();}catch(e){status(e.message,true);}finally{setBusy(false);}
  });
  $('sv-new').addEventListener('click',()=>{if(calculated&&!calculated.id&&!window.confirm('저장하지 않은 산정 결과를 비우고 새로 시작하시겠습니까?'))return;form.reset();saved=null;clearWages();sealLabel();extraSummary();$('sv-extra').open=false;$('sv-record-label').textContent='';people();});
  $('sv-refresh').addEventListener('click',history);
  $('sv-delete-dialog').addEventListener('click',event=>{if(event.target===$('sv-delete-dialog'))$('sv-delete-dialog').close('cancel');});
  ['active','deleted'].forEach(view=>$('sv-view-'+view).addEventListener('click',()=>{if(busy)return;historyView=view;['active','deleted'].forEach(key=>$('sv-view-'+key).setAttribute('aria-pressed',String(key===view)));history();}));
  Promise.all([people(),history()]);
})();
