(function () {
  'use strict';
  const $ = id => document.getElementById('pi-' + id);
  const money = value => value == null ? '—' : new Intl.NumberFormat('ko-KR').format(value);
  const date = value => value ? new Date(value).toLocaleString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : '미확정';
  let report = null, requestId = 0;
  const node = (tag, text, cls) => {const el=document.createElement(tag); if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
  function status(text, type='') {$('status').textContent=text;$('status').dataset.status=type;}
  function clear() {report=null;$('data').hidden=true;$('download').disabled=true;$('source').textContent='';$('totals').replaceChildren();for(const id of ['groups','people','reconcile'])$(id).tBodies[0].replaceChildren();}
  async function api(path, options={}) {
    const response=await fetch('/api/support/'+path,{cache:'no-store',credentials:'same-origin',...options});
    const body=await response.json();
    if(!response.ok){throw Error(body.error||'조회에 실패했습니다.');}
    return body;
  }
  function appendRow(table, values, total=false) {
    const tr=node('tr',null,total?'pi-total':'');
    for(const value of values)tr.append(node('td',typeof value==='number'?money(value):value??'—',typeof value==='number'&&value<0?'pi-negative':''));
    $(table).tBodies[0].append(tr);
  }
  function branches() {return report?.branches.filter(b=>!$('branch').value||String(b.id)===$('branch').value)||[];}
  function renderPeople() {
    $('people').tBodies[0].replaceChildren();
    const search=$('search').value.trim().toLocaleLowerCase();let count=0;
    for(const b of branches())for(const r of b.rows){
      if(search&&!String(r.name+' '+r.position+' '+r.role).toLocaleLowerCase().includes(search))continue;
      const p=r.payroll||{};count++;
      appendRow('people',[b.name,r.name,r.position,p.work_days,p.basic_pay,p.gross_pay,p.total_deduction,p.net_pay,r.employeeDeductions,r.insurance.health,r.insurance.care,r.insurance.pension,r.insurance.employment,r.insurance.accident,r.insuranceTotal,r.match]);
    }
    $('count').textContent=count+'명 표시 · 이름 검색은 개인별 표에만 적용됩니다.';
  }
  function render() {
    if(!report)return;
    const selected=branches();
    for(const id of ['groups','reconcile'])$(id).tBodies[0].replaceChildren();
    $('totals').replaceChildren();
    const sum=k=>selected.reduce((s,b)=>s+(b.totals[k]||0),0);
    for(const [label,key,detail] of [['급여 지급총액','grossPay','급여대장 '+sum('payrollPeople')+'명'],['급여 보험공제','employeeDeductions','급여대장의 직원 공제액'],['보험료 총합','insuranceTotal','노사합산 기준 · 공단 자료 '+sum('insurancePeople')+'명']]){
      const card=node('div',null,'pi-stat');card.append(node('span',label),node('strong',money(sum(key))+'원'),node('small',detail));$('totals').append(card);
    }
    for(const b of selected){
      for(const g of b.groups){if(!g.people&&['기타','직책 미확인'].includes(g.role))continue;appendRow('groups',[b.name,g.role,g.payrollPeople+' / '+g.insurancePeople,g.grossPay,g.employeeDeductions,g.insuranceTotal]);}
      const t=b.totals;appendRow('groups',[b.name,'지점 합계',t.payrollPeople+' / '+t.insurancePeople,t.grossPay,t.employeeDeductions,t.insuranceTotal],true);
      for(const [key,label] of [['healthCare','건강·요양'],['pension','국민연금'],['employment','고용'],['accident','산재']]){
        const r=b.reconciliation[key];appendRow('reconcile',[b.name,label,r.individual,r.portal,r.difference]);
      }
    }
    if(selected.length>1)appendRow('groups',['전체','전체 합계',sum('payrollPeople')+' / '+sum('insurancePeople'),sum('grossPay'),sum('employeeDeductions'),sum('insuranceTotal')],true);
    $('source').textContent=report.month+' 귀속 · '+selected.map(b=>b.name+' 급여 '+(b.confirmedAt?'확정 '+date(b.confirmedAt):'미확정')+' / ERP 조회 '+date(b.payrollCheckedAt)+' / 공단 확인 '+date(b.insuranceCheckedAt)).join(' · ');
    renderPeople();$('data').hidden=false;$('download').disabled=false;
  }
  async function load(period='') {
    const id=++requestId;clear();$('refresh').disabled=true;status('저장 결과를 불러오는 중…');
    try{
      const data=await api('payroll-insurance'+(period?'?month='+encodeURIComponent(period):''));
      if(id!==requestId)return;

      const selected=period||data.report?.month||data.expectedMonth;
      const periods=[...new Set([...data.months,selected])].sort().reverse();
      $('month').replaceChildren(...periods.map(m=>{const o=node('option',m+(data.months.includes(m)?'':' (자료 없음)'));o.value=m;return o;}));$('month').value=selected;
      report=data.report;
      const failure=data.failure||data.latestFailure;
      if(!report){status(failure?failure.month+' 수집 실패 · '+date(failure.failedAt):selected+' 저장 결과가 없습니다. 다음 수집 후 확인해주세요.','warning');return;}
      render();
      const unconfirmed=report.branches.some(b=>!b.confirmedAt), stale=report.month<data.expectedMonth;
      const unmatched=report.branches.reduce((s,b)=>s+b.rows.filter(r=>!r.payroll||r.match.includes('확인 필요')).length,0);
      const differences=report.branches.some(b=>Object.values(b.reconciliation).some(r=>r.difference));
      status(failure?failure.month+' 수집 실패 ('+date(failure.failedAt)+') · 이전 성공 결과 표시':report.month+' 조회 완료'+(unconfirmed?' · 미확정 급여대장 포함':' · 두 지점 급여대장 확정')+(stale?' · 이번 전월분은 아직 없습니다':'')+(unmatched?' · 급여 미연결 '+unmatched+'명':'')+(differences?' · 사업장 고지액 차이 있음':''),(failure||unconfirmed||stale||unmatched||differences)?'warning':'success');
    }catch(error){if(id===requestId||$('workspace').hidden)status(error.message,'error');}
    finally{if(id===requestId)$('refresh').disabled=false;}
  }
  $('refresh').addEventListener('click',()=>load($('month').value));
  $('month').addEventListener('change',()=>load($('month').value));
  $('branch').addEventListener('change',render);
  $('search').addEventListener('input',renderPeople);
  $('download').addEventListener('click',()=>{if(report)window.location.href='/api/support/payroll-insurance?month='+encodeURIComponent(report.month)+'&branch='+encodeURIComponent($('branch').value)+'&format=csv';});
  window.addEventListener('pageshow',event=>{if(event.persisted)load($('month').value);});
  load();
})();
