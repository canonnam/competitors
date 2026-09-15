(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const statuses = {new:'새 접수',contacted:'상담 중',completed:'상담 완료',archived:'보관함'};
  const kinds = {visit:'방문상담',trial:'무료체험 신청',pricing:'비용 문의'};
  const fields = {branch:'희망 지점',date:'희망 방문일',time:'희망 시간',elderName:'어르신 성함',guardianName:'보호자 성함',guardianPhone:'연락처',relationship:'관계',inquiryType:'상담 유형',message:'문의 내용',name:'신청자',organization:'기관명',phone:'연락처'};
  let page = 1, total = 0;
  const make = (tag, cls, text) => {const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
  function message(text, error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
  function auth(signedIn){$('workspace').hidden=!signedIn;$('login-section').hidden=signedIn;$('logout').hidden=!signedIn;if(!signedIn){$('cards').replaceChildren();$('counts').replaceChildren();$('result-count').textContent='';}}
  async function api(path, body){
    const response=await fetch('/api/support/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(20000)});
    const data=await response.json();if(!response.ok){if(response.status===401)auth(false);throw new Error(data.error||'요청을 처리하지 못했습니다.');}return data;
  }
  async function action(fn, button){if(button)button.disabled=true;try{message('');await fn();}catch(e){message(e.name==='TimeoutError'?'연결 시간이 초과되었습니다. 다시 시도해 주세요.':e.message,true);}finally{if(button)button.disabled=false;}}
  function card(item){
    const n=make('article','request-card'),meta=make('div','card-meta');
    meta.append(make('span','badge',kinds[item.kind]),make('span','badge',statuses[item.status]),make('span','badge '+item.environment,item.environment==='dev'?'개발 사이트':'운영 사이트'));
    n.append(meta,make('h2','',item.data.guardianName||item.data.name),make('p','muted',new Date(item.created).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' 접수'));
    const dl=make('dl');
    for(const [key,label] of Object.entries(fields))if(item.data[key]){let value=item.data[key];if(key==='branch')value={anyang:'더비다 안양점',incheon:'더비다 인천점'}[value];dl.append(make('dt','',label),make('dd','',value));}
    dl.append(make('dt','','수집 동의'),make('dd','','동의함'));n.append(dl);
    const controls=make('form','card-actions'),statusLabel=make('label','','처리 상태'),select=make('select');
    for(const [value,label] of Object.entries(statuses))select.add(new Option(label,value));select.value=item.status;statusLabel.append(select);
    const noteLabel=make('label','','담당자 메모'),note=make('textarea');note.maxLength=2000;note.value=item.note;noteLabel.append(note);
    const save=make('button','save','상태·메모 저장');save.type='submit';controls.append(statusLabel,noteLabel,save);
    controls.addEventListener('submit',e=>{e.preventDefault();action(async()=>{await api('website-requests/status',{id:item.id,status:select.value,note:note.value});await load();message('처리 상태와 메모를 저장했습니다.');},save);});
    n.append(controls);return n;
  }
  async function load(){
    const query=new URLSearchParams(new FormData($('filters')));query.set('page',String(page));const data=await api('website-requests?'+query);total=data.total;
    if(page>1&&!data.cards.length){page--;return load();}
    $('counts').replaceChildren(...Object.entries(statuses).map(([key,label])=>{const n=make('div','count',label);n.append(make('strong','',String(data.counts[key]||0)));return n;}));
    $('result-count').textContent=`검색 결과 ${total}건`;$('cards').replaceChildren(...data.cards.map(card));
    if(!total)$('cards').append(make('div','empty','해당하는 신청이 없습니다. 새 신청이 접수되면 이곳에 표시됩니다.'));
    $('page').textContent=`${page} / ${Math.max(1,Math.ceil(total/30))}`;$('previous').disabled=page<=1;$('next').disabled=page*30>=total;
  }
  $('login-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await api('login',{key:$('access-key').value});$('access-key').value='';auth(true);await load();},e.submitter);});
  $('logout').addEventListener('click',e=>action(async()=>{await api('logout',{});auth(false);message('로그아웃했습니다.');},e.currentTarget));
  $('filters').addEventListener('submit',e=>{e.preventDefault();page=1;action(load,e.submitter);});
  $('previous').addEventListener('click',()=>{page--;action(load);});$('next').addEventListener('click',()=>{page++;action(load);});
  action(async()=>{const session=await api('session');auth(session.authenticated);if(session.authenticated)await load();});
})();
