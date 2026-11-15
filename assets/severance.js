(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('sv-form');
  const field = name => form.elements.namedItem(name);
  const fmt = n => Number(n).toLocaleString('ko-KR', {maximumFractionDigits:2});
  const node = (tag, text, cls) => {const n=document.createElement(tag); if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  let schedule=[], saved=null, calculated=null, loadSequence=0, peopleSequence=0, busy=false;
  const api = async (route, body) => {
    const response=await fetch('/api/severance/'+route,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {cache:'no-store'});
    let value;try{value=await response.json();}catch{throw Error('응답을 읽지 못했습니다. 로그인 상태와 연결을 확인해주세요.');}
    if(!response.ok)throw Error(value.error||'요청을 처리하지 못했습니다.');return value;
  };
  const status=(message,error=false)=>{ $('sv-status').textContent=message;$('sv-status').dataset.status=error?'error':'success';if(error)$('sv-status').scrollIntoView({behavior:'smooth',block:'center'}); };
  const setBusy=value=>{busy=value;form.inert=value;['sv-load','sv-calculate','sv-save','sv-new','sv-refresh'].forEach(id=>$(id).disabled=value);};
  const dirty=()=>{calculated=null;$('sv-result').hidden=true;};
  const clearWages=()=>{loadSequence++;schedule=[];$('sv-wages').replaceChildren();$('sv-wage-wrap').hidden=true;$('sv-wage-empty').hidden=false;$('sv-period').textContent='';dirty();};
  const sealLabel=()=>{$('sv-seal-label').textContent=(field('branch').value==='2'?'안양점':'인천점')+' 직인 포함';};
  async function people(){
    const seq=++peopleSequence;$('sv-employees').replaceChildren();
    try{const r=await api('employees?branch='+field('branch').value);if(seq!==peopleSequence)return;
      r.employees.forEach(p=>{const option=node('option');option.value=p.name;option.label=[p.position,p.lastMonth].filter(Boolean).join(' · ');$('sv-employees').append(option);});
      status(r.employees.length+'명의 급여 명단을 불러왔습니다. 재직기간을 입력해주세요.');
    }catch(e){if(seq===peopleSequence)status(e.message,true);}
  }
  function input(type,value,label,key){const n=node('input');n.type=type;n.value=value??'';n.setAttribute('aria-label',label);n.dataset.field=key;return n;}
  function renderWages(rows, values=[]){
    schedule=rows;$('sv-wages').replaceChildren();
    rows.forEach((p,i)=>{
      const v=values[i], tr=node('tr');tr.dataset.index=i;
      const period=node('td',p.start+' ~ '+p.end);period.append(node('small',p.days+'일 / 월 '+p.calendarDays+'일'));tr.append(period);
      const source=node('td'), choice=node('select');choice.dataset.field='sourceKey';choice.setAttribute('aria-label',p.month+' 원본 급여');
      choice.append(new Option('원본 선택',''));
      p.candidates.forEach((c,j)=>choice.append(new Option((c.position||'직책 미확인')+' · '+(c.gross===null?'세전금액 없음':fmt(c.gross)+'원')+(p.candidates.length>1?' ('+(j+1)+')':''),c.key)));
      choice.value=v?.sourceKey||(p.candidates.length===1?p.candidates[0].key:'');
      if(!p.candidates.length){source.append(node('span','급여 원본 없음'));choice.hidden=true;}
      else if(p.candidates.length===1){source.append(node('span',p.candidates[0].gross===null?'세전금액 없음':fmt(p.candidates[0].gross)+'원'));choice.hidden=true;}
      source.append(choice);if(p.candidates.length>1)source.append(node('small','동일 이름의 행이 여러 개입니다. 해당 직원을 선택해주세요.'));
      const files=p.sources.map(s=>s.file+(s.sheet?' · '+s.sheet:'')).join('\n');if(files){const d=node('details');d.append(node('summary','급여 출처'),node('small',files));source.append(d);}
      const sourceNote=node('small');source.append(sourceNote);tr.append(source);
      const treatment=node('td'), mode=node('select');mode.dataset.field='mode';mode.setAttribute('aria-label',p.month+' 적용 방식');
      [['','적용 방식 선택'],['monthly','월급 일할 적용'],['actual','해당 기간 정산액'],['manual','직접 입력']].forEach(([value,label])=>mode.append(new Option(label,value)));
      mode.value=v?.mode||(p.days===p.calendarDays&&p.candidates.length===1&&p.candidates[0].gross!==null?'actual':'');mode.required=true;
      const amount=input('number',v?.amount,p.month+' 직접 입력 임금','amount');amount.min='0';amount.step='1';amount.placeholder='해당 기간 세전 임금';
      treatment.append(mode,amount);tr.append(treatment);
      const excluded=input('number',v?.excluded??0,p.month+' 제외액','excluded');excluded.min='0';excluded.step='1';excluded.required=true;const ex=node('td');ex.append(excluded);tr.append(ex);
      const reason=input('text',v?.reason||'',p.month+' 확인 메모','reason');reason.maxLength=180;reason.placeholder='직접 입력·제외액 근거';const memo=node('td');memo.append(reason);tr.append(memo);
      const update=()=>{amount.hidden=mode.value!=='manual';amount.required=mode.value==='manual';const selected=p.candidates.find(c=>c.key===choice.value);sourceNote.textContent=selected?(selected.workDays!=null?'원본 근무일수 '+selected.workDays+'일. ':'')+(selected.note||''):'';};
      mode.addEventListener('change',update);choice.addEventListener('change',update);update();$('sv-wages').append(tr);
    });
    $('sv-wage-wrap').hidden=false;$('sv-wage-empty').hidden=true;
    $('sv-period').textContent=rows.length?rows[0].start+' ~ '+rows.at(-1).end+' · '+rows.reduce((sum,r)=>sum+r.days,0)+'일':'';
  }
  function payload(){
    const data=Object.fromEntries(new FormData(form));
    ['includeSeal','standardPeriodConfirmed','payItemsConfirmed'].forEach(k=>data[k]=field(k).checked);
    data.wages=[...$('sv-wages').children].map((tr,i)=>({...Object.fromEntries([...tr.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.value])),month:schedule[i].month,sourceHash:schedule[i].sourceHash}));
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
    try{const r=await api('records');$('sv-records').replaceChildren();$('sv-history-status').textContent=r.records.length?'총 '+r.records.length+'건':'저장한 산정 내역이 없습니다. 산정 후 저장해주세요.';
      r.records.forEach(item=>{const tr=node('tr');[item.branch===2?'안양점':'인천점',item.name,item.lastDay,fmt(item.severance)+'원',fmt(item.totalBeforeTax)+'원'].forEach(v=>tr.append(node('td',v)));
        const actions=node('td'), open=node('button','열기','ui-button');open.type='button';open.addEventListener('click',()=>openRecord(item.id));actions.append(open);tr.append(actions);$('sv-records').append(tr);});
    }catch(e){$('sv-history-status').textContent=e.message;}
  }
  async function openRecord(id){
    if(busy)return;if(calculated&&!calculated.id&&!window.confirm('저장하지 않은 산정 결과가 있습니다. 다른 기록을 여시겠습니까?'))return;
    setBusy(true);loadSequence++;
    try{const record=await api('record?id='+encodeURIComponent(id));saved=record;form.reset();
      for(const [key,value] of Object.entries(record.input)){const el=field(key);if(!el)continue;if(el.type==='checkbox')el.checked=value;else el.value=value;}
      field('payItemsConfirmed').checked=true;renderWages(record.result.wages,record.input.wages);sealLabel();renderResult(record);$('sv-record-label').textContent='저장 내역 · 수정 '+record.revision+'회';status('저장 당시 입력값과 계산 결과를 열었습니다.');$('sv-form').scrollIntoView({behavior:'smooth'});
    }catch(e){status(e.message,true);}finally{setBusy(false);}
  }
  $('sv-load').addEventListener('click',async()=>{
    for(const name of ['name','hireDate','lastDay'])if(!field(name).reportValidity())return;
    const seq=++loadSequence;const params=Object.fromEntries(['branch','name','hireDate','lastDay'].map(k=>[k,field(k).value]));setBusy(true);dirty();status('저장된 월별 급여를 확인하고 있습니다.');
    try{const r=await api('wages',params);if(seq!==loadSequence)return;renderWages(r.wages);status('급여를 불러왔습니다. 부분월 적용 방식과 제외액을 확인해주세요.');}
    catch(e){status(e.message,true);}finally{setBusy(false);}
  });
  form.addEventListener('input',event=>{dirty();if(['branch','name','hireDate','lastDay'].includes(event.target.name))clearWages();});
  form.addEventListener('change',event=>{dirty();if(event.target.name==='branch'){clearWages();sealLabel();people();}});
  form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;if(!schedule.length){status('먼저 급여를 불러와주세요.',true);return;}setBusy(true);
    try{const r=await api('calculate',payload());renderResult(r);status('산정이 완료되었습니다. 금액을 확인하고 저장해주세요.');$('sv-result').scrollIntoView({behavior:'smooth',block:'start'});}catch(e){status(e.message,true);}finally{setBusy(false);}
  });
  $('sv-save').addEventListener('click',async()=>{if(!calculated||busy)return;setBusy(true);
    try{const record=await api('save',payload());saved=record;renderResult(record);$('sv-record-label').textContent='저장 내역 · 수정 '+record.revision+'회';status('산정 내역을 저장했습니다. 엑셀 내역서를 내려받을 수 있습니다.');await history();}catch(e){status(e.message,true);}finally{setBusy(false);}
  });
  $('sv-new').addEventListener('click',()=>{if(calculated&&!calculated.id&&!window.confirm('저장하지 않은 산정 결과를 비우고 새로 시작하시겠습니까?'))return;form.reset();saved=null;clearWages();sealLabel();$('sv-record-label').textContent='';people();});
  $('sv-refresh').addEventListener('click',history);
  Promise.all([people(),history()]);
})();
