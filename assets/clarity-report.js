(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root.document)api.mount(root);})(typeof window==='undefined'?globalThis:window,function(){
'use strict';
const eventLabels={phone_click_incheon:'인천점 전화 클릭',phone_click_anyang:'안양점 전화 클릭',consultation_submitted:'상담 신청 완료'};
const pageLabels={'/':'홈페이지','/contact':'방문상담 신청','/system':'시설 운영시스템','/locations/incheon':'인천점 소개','/locations/anyang':'안양점 소개','/services-guide':'서비스 안내','/rehabilitation':'재활프로그램','/cognitive':'인지프로그램','/birthday':'생신잔치','/facility-dashboard':'시설 맞춤 대시보드'};
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const value=(n,suffix='')=>valid(n)?n.toLocaleString('ko-KR',{maximumFractionDigits:2})+suffix:'미조회';
function dailyRows(history,days){
  if(!history.length)return[];
  const latest=history[history.length-1].day,byDay=new Map(history.map(row=>[row.day,row]));
  const count=Math.min(days,Math.floor((Date.parse(latest+'T00:00:00Z')-Date.parse(history[0].day+'T00:00:00Z'))/86400000)+1);
  return Array.from({length:count},(_,i)=>{const day=new Date(Date.parse(latest+'T00:00:00Z')-(count-i-1)*86400000).toISOString().slice(0,10);return byDay.get(day)||{day};});
}
function mount(win){
  const doc=win.document,$=id=>doc.getElementById(id);if(!$('clarity-status'))return;
  let payload=null;
  const el=(tag,text,cls)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  const stamp=raw=>new Date(raw).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  function rows(id,list){const body=$(id);body.replaceChildren();for(const cells of list){const tr=el('tr');for(const cell of cells){const td=el('td');if(cell&&typeof cell==='object')td.append(cell);else td.textContent=cell;tr.append(td);}body.append(tr);}if(!list.length){const td=el('td','이 구간에 조회된 항목이 없습니다.');td.colSpan=2;const tr=el('tr');tr.append(td);body.append(tr);}}
  function metric(key,field){return payload.latest.metrics[key]?.[0]?.[field];}
  function distribution(id,list,labels={}){const container=$(id);container.replaceChildren();for(const item of list){const row=el('div');row.append(el('span',labels[item.name]||item.name),el('strong',value(item.sessionsCount,' 세션')));container.append(row);}if(!list.length)container.append(el('p','조회된 항목이 없습니다.','cr-caption'));}
  function history(){
    const data=dailyRows(payload.history,Number($('clarity-history-range').value));
    rows('clarity-history',data.map(item=>[item.day,value(item.sessions),value(item.incheon),value(item.anyang),value(item.consultation),value(item.intake)]));
    const box=$('clarity-chart');box.replaceChildren();if(!data.length)return;
    const ns='http://www.w3.org/2000/svg',svg=doc.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 760 180');svg.setAttribute('role','img');svg.setAttribute('aria-label','관측일별 최근 24시간 Clarity 세션 추이. 아래 표에 같은 수치가 있습니다.');
    const shape=(tag,attrs,text)=>{const n=doc.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text)n.textContent=text;svg.append(n);return n;};
    const max=Math.max(1,...data.filter(x=>valid(x.sessions)).map(x=>x.sessions)),x=i=>48+(data.length===1?330:i*660/(data.length-1)),y=n=>132-n/max*106;
    shape('line',{x1:48,y1:132,x2:718,y2:132,class:'cr-axis'});shape('text',{x:8,y:30},value(max));shape('text',{x:8,y:136},'0');
    let segment=[];const flush=()=>{if(segment.length>1)shape('polyline',{points:segment.join(' '),class:'cr-line'});segment=[];};
    data.forEach((item,i)=>{if(!valid(item.sessions)){flush();return;}segment.push(x(i)+','+y(item.sessions));const circle=shape('circle',{cx:x(i),cy:y(item.sessions),r:4});const title=doc.createElementNS(ns,'title');title.textContent=item.day+' · '+value(item.sessions,' 세션');circle.append(title);});flush();
    shape('text',{x:48,y:160},data[0].day);if(data.length>1)shape('text',{x:718,y:160,'text-anchor':'end'},data[data.length-1].day);box.append(svg);
  }
  function render(){
    const latest=payload.latest,sync=payload.sync,status=$('clarity-status');
    $('clarity-content').hidden=!latest;
    if(!latest){status.dataset.status=sync.error?'error':'warning';status.textContent=sync.error||(!sync.configured?'Clarity 연결 설정을 확인해 주세요.':'첫 분석 결과를 수집 중입니다. 잠시 후 저장 결과를 새로고침해 주세요.');$('clarity-window').textContent='';return;}
    status.dataset.status=sync.error||sync.stale?'warning':'success';status.textContent=(sync.error?'이전 저장 결과 · '+sync.error:sync.stale?'이전 저장 결과 · 갱신이 지연되고 있습니다.':'분석 결과 저장 완료')+' · '+stamp(latest.collected);
    $('clarity-window').textContent='조회 구간 '+stamp(latest.window_start)+' ~ '+stamp(latest.window_end)+' (한국시간 · 최근 24시간)';
    const cards=[['Clarity 세션',metric('Traffic','totalSessionCount'),'개','Clarity 방문 통계 기준'],['방문자',metric('Traffic','distinctUserCount'),'명','Clarity에서 구분한 방문자'],['평균 스크롤 깊이',metric('ScrollDepth','averageScrollDepth'),'%','페이지 아래까지 본 정도'],['활성시간',metric('EngagementTime','activeTime'),'초','Clarity 활성시간 지표']];
    $('clarity-metrics').replaceChildren(...cards.map(([label,n,suffix,note])=>{const article=el('article',undefined,'cr-metric');article.append(el('span',label),el('strong',value(n,suffix)),el('small',note));return article;}));
    $('clarity-insights').replaceChildren(...payload.insights.map(text=>el('li',text)));
    $('clarity-event-base').textContent='봇 제외 방문 '+value(latest.event_sessions.all_non_bot,' 세션')+' · 여러 번 클릭해도 같은 세션은 한 번 집계';
    rows('clarity-events',Object.entries(eventLabels).map(([key,label])=>[label,value(latest.event_sessions[key],' 세션')]));
    $('clarity-event-errors').textContent=Object.values(latest.event_errors).length?'일부 이벤트가 미조회 상태입니다. 이전 관측 기록과 Clarity 상세를 확인하세요.':'';
    rows('clarity-intake',[['방문상담',value(latest.intake.visit,'건')],['무료체험',value(latest.intake.trial,'건')],['비용 문의',value(latest.intake.pricing,'건')],['전체 접수',value(latest.intake.total,'건')]]);
    $('clarity-intake-branches').textContent=latest.intake.status==='ok'?'방문상담 지점 · 인천 '+value(latest.intake.incheon,'건')+' / 안양 '+value(latest.intake.anyang,'건'):'실제 접수 집계를 불러오지 못했습니다.';
    const pages=new Map();for(const item of latest.metrics.PopularPages||[]){try{const url=new URL(item.url);if(!['www.thevida.co.kr','thevida.co.kr'].includes(url.hostname))continue;const n=pages.get(url.pathname)||0;pages.set(url.pathname,n+(valid(item.visitsCount)?item.visitsCount:0));}catch{/* Invalid links are never rendered. */}}
    rows('clarity-pages',[...pages].sort((a,b)=>b[1]-a[1]).map(([path,n])=>{const a=el('a',pageLabels[path]||path);a.href='https://www.thevida.co.kr'+path;a.target='_blank';a.rel='noopener noreferrer';return[a,value(n)];}));
    distribution('clarity-devices',latest.metrics.Device||[],{Mobile:'모바일',PC:'PC',Tablet:'태블릿',Other:'기타'});distribution('clarity-referrers',latest.metrics.ReferrerUrl||[],{Direct:'직접 방문'});
    rows('clarity-friction',[['DeadClickCount','반응 없는 클릭'],['RageClickCount','짧은 시간 반복 클릭'],['QuickbackClick','빠른 뒤로 가기'],['ExcessiveScroll','과도한 스크롤'],['ScriptErrorCount','스크립트 오류'],['ErrorClickCount','오류 클릭']].map(([key,label])=>[label,value(metric(key,'sessionsWithMetricPercentage'),'%')]));
    history();
  }
  async function load(){const btn=$('clarity-reload');btn.disabled=true;try{const response=await win.fetch('/api/clarity-report',{cache:'no-store'});if(!response.ok)throw Error(response.status===401?'로그인이 만료되었습니다. 페이지를 다시 열어 주세요.':'분석 결과 조회에 실패했습니다.');const data=await response.json();if(!data.sync||!Array.isArray(data.history)||!Array.isArray(data.insights))throw Error('분석 응답을 확인하지 못했습니다.');payload=data;render();}catch(error){$('clarity-status').dataset.status='error';$('clarity-status').textContent=payload?.latest?'이전 표시 결과 · '+error.message:error.message;}finally{btn.disabled=false;}}
  $('clarity-reload').addEventListener('click',load);$('clarity-history-range').addEventListener('change',()=>{if(payload)history();});
  doc.querySelectorAll('.cr-scroll').forEach(node=>{node.tabIndex=0;node.setAttribute('role','region');node.setAttribute('aria-label',node.closest('section')?.querySelector('h2')?.textContent||'분석 표');});
  load();
}
return{dailyRows,value,mount};
});
