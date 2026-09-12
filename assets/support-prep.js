/* Private support applications: no business data or credentials in browser storage. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const labels = {name:'이름·명칭',business_number:'사업자등록번호',corporate_number:'법인등록번호',established_date:'설립일',industry:'업종',business_type:'업태',website:'홈페이지',representative:'대표자명',representative_career:'대표자 경력',contact_name:'신청 담당자',email:'이메일',phone:'연락처',address:'주소',postal_code:'우편번호',type:'구분',facility_number:'기관 기호',notes:'비고·근거',organization:'소속',position:'직책',expertise:'전문분야',career:'주요 경력',role:'참여 역할',period:'참여 기간',participation:'참여율',overview:'사업 개요',problem:'해결하려는 문제',customers:'대상 고객',product:'제품·서비스',technology:'보유 기술',difference:'차별성',business_model:'수익모델',schedule:'추진 일정',goals:'성과 목표',budget:'예산·자부담 계획',content:'기준 사업계획 상세 내용',value:'수치·내용',unit:'단위',as_of:'기준연도·기준일',expires:'유효기간',source:'근거·출처'};
  const groups = {
    company:{title:'회사·대표자·담당자',fields:['name','business_number','corporate_number','established_date','industry','business_type','representative','contact_name','phone','email','website','postal_code','address','representative_career']},
    branches:{title:'사업장',fields:['name','type','business_number','facility_number','postal_code','address','notes'],add:'사업장 추가'},
    members:{title:'팀원·참여 인력',fields:['name','organization','position','expertise','career','role','period','participation'],add:'팀원 추가'},
    plans:{title:'기준 사업계획',fields:['name','overview','problem','customers','product','technology','difference','business_model','schedule','goals','budget','content'],add:'사업계획 추가'},
    records:{title:'실적·예산·인증',fields:['name','type','value','unit','as_of','expires','source','notes'],add:'실적·인증 추가'}
  };
  const longFields = new Set(['representative_career','career','notes','overview','problem','customers','product','technology','difference','business_model','schedule','goals','budget','content']);
  const stateLabels = {queued:'대기 중',collecting:'양식 수집 중',running:'초안 작성 중',ready:'준비 완료',needs_review:'확인 필요',failed:'처리 확인 필요'};
  const kindLabels = {form:'신청 양식',consent:'동의·확약',notice:'공고·안내',reference:'참고 자료'};
  let signedIn = false, p = null, references = [], currentCase = null, currentDraft = null, profileDirty = false, draftDirty = false, view = 'cases', reference = null, rewriteId = '', polling = false, busy = false;
  let modelCatalog = null;
  const make = (tag, cls='', text='') => { const n=document.createElement(tag); if(cls)n.className=cls; if(text)n.textContent=text; return n; };
  const button = (text, action, cls='') => { const b=make('button',cls,text);b.type='button';b.addEventListener('click',action);return b; };
  const link = (text, href, cls='') => { const a=make('a',cls,text);a.href=href;return a; };
  const fileURL = id => '/api/support/assets/file?id='+encodeURIComponent(id);
  const date = v => v ? new Date(v).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
  function message(text, error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
  async function api(route, body){
    const response=await fetch('/api/support/'+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(180000)});
    const data=await response.json();
    if(!response.ok){if(response.status===401&&route!=='login'){signedIn=false;showAuth();}throw new Error(data.error||'요청을 처리하지 못했습니다.');}return data;
  }
  async function action(fn, node){
    if(node)node.disabled=true;
    try{await fn();}catch(e){message(e.name==='TimeoutError'?'처리 시간이 길어졌습니다. 잠시 후 상태를 확인해주세요.':e.message,true);}finally{if(node)node.disabled=false;}
  }
  function showAuth(){ $('workspace').hidden=!signedIn;$('login-section').hidden=signedIn;$('logout').hidden=!signedIn; }
  function checkDirty(){return !(profileDirty||draftDirty)||window.confirm('저장하지 않은 수정 내용이 있습니다. 저장하지 않고 이동할까요?');}
  function selectOptions(node, items, placeholder, selected){
    const old=selected??node.value;node.replaceChildren(new Option(placeholder,''));for(const item of items)node.add(new Option(item.name,item.id));node.value=old;if(!node.value&&items.length===1)node.value=items[0].id;
  }
  function checks(node,items,selected=[]){
    node.replaceChildren();if(!items.length){node.append(make('p','muted','등록된 항목이 없습니다.'));return;}
    for(const item of items){const label=make('label','sp-check'),input=make('input');input.type='checkbox';input.value=item.id;input.checked=selected.includes(item.id);label.append(input,document.createTextNode(item.name));node.append(label);}
  }
  const checked = id => [...$(id).querySelectorAll('input:checked')].map(x=>x.value);
  function sourceLabel(key){const parts=key.split('.'),section={company:'회사',branch:'신청 사업장',members:'참여 팀원',plan:'기준 사업계획',records:'실적·인증',references:'참고 문서'}[parts[0]]||'등록 자료';return section+' · '+(labels[parts.at(-1)]||'문서 내용');}
  async function route(){
    if(!signedIn)return;
    const hash=location.hash.slice(1)||'cases';
    view=hash.startsWith('case=')?'case':hash==='profile'?'profile':'cases';
    for(const name of ['cases','profile','case'])$(name+'-view').hidden=name!==view;
    for(const a of document.querySelectorAll('[data-view]')){if(a.dataset.view===(view==='case'?'cases':view))a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
    message('');
    if(view==='profile'){if(!p)p=await api('profile');renderProfile();await loadReferences();}
    else if(view==='cases')await loadCases();
    else await loadCase(decodeURIComponent(hash.slice(5)),true);
  }
  async function loadCases(){
    const data=await api('cases'),host=$('case-list');host.replaceChildren();
    if(!data.cases.length){const empty=make('div','sp-empty');empty.append(make('h3','','아직 신청 준비 중인 사업이 없습니다.'),make('p','','지원사업에서 관심있음을 선택하면 양식을 모아드립니다.'),link('지원사업 살펴보기','/agency-news.html','button'));host.append(empty);return;}
    for(const item of data.cases){
      const card=make('article','sp-case-card'),meta=make('div','sp-card-meta');meta.append(make('span','sp-badge '+item.status,stateLabels[item.status]||item.status),make('span','sp-badge',`원본 ${item.files}개`));
      if(item.draft)meta.append(make('span','sp-badge '+item.draft.status,`초안 v${item.draft.version} · ${stateLabels[item.draft.status]}`));
      card.append(meta,make('h3','',item.title),make('p','muted',item.period));
      if(item.error)card.append(make('p','sp-field-note',item.error));
      const actions=make('div','sp-actions');actions.append(link('신청 준비 열기','#case='+encodeURIComponent(item.id),'button'));
      if(item.files)actions.append(link('원본 받기','/api/support/case/export?id='+encodeURIComponent(item.id),'button'));
      card.append(actions);host.append(card);
    }
  }
  function gatherProfile(){
    if(!p)return;
    for(const input of $('profile-form').querySelectorAll('[data-field]')){
      const group=input.dataset.group;const item=group==='company'?p.data.company:p.data[group].find(i=>i.id===input.dataset.record);
      if(item)item[input.dataset.field]=input.value;
    }
  }
  function formField(group,item,key){
    const title=key==='name'&&group==='company'?'정식 회사명':key==='name'&&group==='plans'?'사업계획 이름':labels[key];
    const label=make('label',longFields.has(key)||key==='address'?'wide':'',title);
    let input;
    if(key==='type'&&group==='branches'){input=make('select');for(const v of ['본사','연구소','요양원','지점','기타'])input.add(new Option(v,v));}
    else if(longFields.has(key)){input=make('textarea');input.rows=key==='content'?10:3;input.maxLength=key==='content'?40000:6000;}
    else{input=make('input');input.type=key==='email'?'email':'text';input.maxLength=6000;}
    input.value=item[key]||'';input.dataset.field=key;input.dataset.group=group;if(item.id)input.dataset.record=item.id;
    if(key==='business_number')input.placeholder='000-00-00000';if(key==='as_of')input.placeholder='예: 2025년 / 2026-09-12';
    input.addEventListener('input',()=>{profileDirty=true;});label.append(input);return label;
  }
  function renderProfile(openGroup){
    const host=$('profile-sections');host.replaceChildren();
    $('profile-revision').textContent=`기본 자료 v${p.revision} · 저장 ${date(p.updated)} · 기존 초안에는 자동으로 덮어쓰지 않습니다.`;
    for(const [group,config] of Object.entries(groups)){
      const section=make('details','sp-section');section.open=group==='company'||group==='branches'||group===openGroup;
      section.append(make('summary','',config.title+(group==='company'?'':` (${p.data[group].length})`)));
      const items=group==='company'?[p.data.company]:p.data[group];
      for(const [index,item] of items.entries()){
        const record=make('div',group==='company'?'':'sp-record');
        if(group!=='company'){
          const head=make('div','sp-record-head');head.append(make('h4','',item.name||`${config.title} ${index+1}`),button('제거',()=>{gatherProfile();p.data[group]=p.data[group].filter(i=>i.id!==item.id);profileDirty=true;renderProfile(group);}));record.append(head);
        }
        const grid=make('div','sp-grid');for(const key of config.fields)grid.append(formField(group,item,key));record.append(grid);section.append(record);
      }
      if(config.add)section.append(button(config.add,()=>{gatherProfile();p.data[group].push({id:crypto.randomUUID().replaceAll('-',''),name:''});profileDirty=true;renderProfile(group);}));
      host.append(section);
    }
  }
  async function loadReferences(){
    references=(await api('assets')).assets;$('reference-list').replaceChildren();
    if(!references.length)$('reference-list').append(make('p','muted','등록한 자료가 없습니다. 기존 사업계획서나 회사소개서를 추가해보세요.'));
    for(const asset of references)$('reference-list').append(fileRow(asset,true));
  }
  function fileRow(asset,common=false){
    const row=make('div','sp-file'),info=make('div');info.append(make('div','sp-file-name',asset.name),make('p','muted',`${kindLabels[asset.kind]} · ${(asset.size/1024).toFixed(0)}KB · ${asset.characters.toLocaleString()}자 인식`));
    if(asset.error)info.append(make('p','sp-field-note',asset.error));
    const actions=make('div','sp-actions');actions.append(link('원본 받기',fileURL(asset.id),'button'));
    if(common)actions.append(button('내용·정보 가져오기',()=>action(()=>openReference(asset))));
    row.append(info,actions);return row;
  }
  async function uploadFiles(files,caseId,input){
    busy=true;
    try{
      for(const [index,file] of [...files].entries()){
        if(file.size>12*1024*1024)throw new Error(`${file.name}: 파일당 최대 12MB입니다.`);
        message(`${index+1}/${files.length} · ${file.name} 등록 및 내용 확인 중…`);
        const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
        await api('assets/upload',{case_id:caseId,name:file.name,kind:caseId?'form':'reference',base64:btoa(binary)});
      }
      if(caseId)await loadCase(caseId,true);else await loadReferences();message('파일을 등록했습니다. 인식된 내용을 확인해주세요.');
    }finally{busy=false;input.value='';}
  }
  async function openReference(asset){
    reference=asset;const data=await api('assets/text?id='+asset.id);reference.text=data.text;
    $('reference-title').textContent=asset.name;$('reference-text').textContent=data.text||'인식된 텍스트가 없습니다. 원본을 확인해주세요.';
    $('extract-suggestions').replaceChildren();$('extract-status').textContent='';$('reference-dialog').showModal();
  }
  async function extractCompany(){
    $('extract-status').textContent='문서에서 회사 정보를 찾고 있습니다…';
    const result=await api('profile/extract',{asset_id:reference.id}),host=$('extract-suggestions');host.replaceChildren();
    for(const s of result.suggestions){const label=make('label','sp-check sp-suggestion'),check=make('input');check.type='checkbox';check.checked=!p.data.company[s.field];check.dataset.field=s.field;check.dataset.value=s.value;const content=make('span','',`${labels[s.field]}: ${s.value}`);content.append(make('small','',`근거: ${s.quote}`));label.append(check,content);host.append(label);}
    if(result.suggestions.length)host.append(button('선택한 정보를 입력란에 반영',()=>{gatherProfile();for(const input of host.querySelectorAll('input:checked'))p.data.company[input.dataset.field]=input.dataset.value;profileDirty=true;renderProfile('company');$('reference-dialog').close();message('선택한 정보를 입력란에 반영했습니다. 내용을 확인한 뒤 기본 데이터를 저장해주세요.');},'primary'));
    $('extract-status').textContent=result.suggestions.length?'반영할 정보를 선택해주세요. 기존 값은 선택해야 변경됩니다.':'회사 기본정보를 확실히 찾지 못했습니다. 직접 입력해주세요.';
  }
  function renderModelInfo(){
    const model=modelCatalog?.models.find(m=>m.id===$('select-model').value);
    if(!model)return;
    $('model-description').textContent=model.description;
    $('model-pricing').textContent=`100만 토큰당 · USD\n입력 $${model.input_price} · 출력 $${model.output_price}\n캐시 입력 $${model.cached_input_price}\n표준 단가 (${modelCatalog.prices_checked}). 긴 입력 등 조건별 요금은 공식 요금을 확인해주세요.`;
    $('model-price-source').href=model.price_url;
  }
  async function loadModels(){
    if(!modelCatalog)modelCatalog=await api('models');
    const selected=$('select-model').value;
    $('select-model').replaceChildren(...modelCatalog.models.map(m=>new Option(m.label+(m.id===modelCatalog.default?' · 기본':''),m.id)));
    $('select-model').value=modelCatalog.models.some(m=>m.id===selected)?selected:modelCatalog.default;
    renderModelInfo();
  }
  async function loadCase(id,first=false){
    const data=await api('case?id='+encodeURIComponent(id));currentCase=data;
    $('case-title').textContent=data.announcement.title;$('case-period').textContent=data.announcement.application_period||'';$('case-source').href=data.announcement.url;
    $('case-notice').hidden=!data.error;$('case-notice').textContent=data.error;
    $('original-bundle').href='/api/support/case/export?id='+encodeURIComponent(id);
    $('case-files').replaceChildren(...data.assets.map(a=>fileRow(a)));
    if(!data.assets.length)$('case-files').append(make('p','muted',data.status==='collecting'||data.status==='queued'?'공식 공고에서 양식을 수집하고 있습니다.':'원본 양식을 추가해주세요.'));
    if(first){
      await loadModels();
      if(!p)p=await api('profile');references=(await api('assets')).assets;
      selectOptions($('select-branch'),p.data.branches,'사업장 선택');selectOptions($('select-plan'),p.data.plans,'사업계획 선택');
      checks($('select-members'),p.data.members);checks($('select-references'),references);
      checks($('select-assets'),data.assets.filter(a=>!a.error),data.assets.filter(a=>['form','consent'].includes(a.kind)&&!a.error).map(a=>a.id));
    }
    const active=data.jobs.some(j=>['queued','running'].includes(j.state));
    $('generate-button').disabled=active||!modelCatalog;$('generate-button').textContent=active?'자료 처리 중…':'초안 만들기';$('recollect').disabled=active;
    const latest=data.drafts[0],selected=$('draft-version').value;
    $('draft-version').replaceChildren();for(const draft of data.drafts)$('draft-version').add(new Option(`v${draft.version} · ${stateLabels[draft.status]} · ${date(draft.created)}`,draft.id));
    if(!first&&selected&&data.drafts.some(d=>d.id===selected)&&!['running','queued'].includes(currentDraft?.status))$('draft-version').value=selected;
    if(!data.drafts.length){currentDraft=null;$('draft-status').textContent='아직 작성한 초안이 없습니다.';$('draft-editor').replaceChildren(make('div','sp-empty','왼쪽에서 자료를 선택한 뒤 초안 만들기를 눌러주세요.'));$('draft-bundle').hidden=true;$('save-draft').disabled=true;}
    else if(!draftDirty&&(!currentDraft||first||currentDraft.id!==$('draft-version').value||currentDraft.status!==(data.drafts.find(d=>d.id===currentDraft.id)?.status))){
      currentDraft=await api('draft?id='+encodeURIComponent($('draft-version').value||latest.id));renderDraft();
    }
  }
  function renderDraft(){
    const draft=currentDraft,host=$('draft-editor');host.replaceChildren();draftDirty=false;
    $('save-draft').disabled=draft.status!=='ready';$('draft-bundle').hidden=draft.status!=='ready';$('draft-bundle').href='/api/support/draft/export?id='+draft.id;
    const selection=draft.snapshot;
    const usedModel=draft.model_label||draft.model||selection.model||'GPT-4.1 mini';
    $('draft-status').textContent=`v${draft.version} · 작성 모델 ${usedModel} · 기본 자료 v${draft.profile_revision} · ${selection.branch?.name||''} · ${selection.plan?.name||''}`;
    if(draft.status!=='ready'){host.append(make('div','sp-busy',draft.status==='failed'?draft.error:'선택한 양식에 맞춰 초안을 작성하고 있습니다. 화면을 닫아도 작업은 계속됩니다.'));return;}
    for(const document of draft.data.documents){
      const section=make('section','sp-draft-document'),head=make('div','sp-toolbar');head.append(make('h4','',document.name),link(document.mode==='manual'?'직접 확인용 받기':document.mode==='outline'?'항목별 초안 받기':document.format==='hwpx'?'HWPX 초안 받기':'초안 받기','/api/support/draft/export?id='+draft.id+'&asset='+document.asset_id,'button'));section.append(head);
      if(document.format==='hwpx')section.append(make('p','muted','한글에서 편집할 수 있는 HWPX 작성본입니다. 원본과 페이지 배치를 대조해주세요.'));
      if(document.mode==='outline')section.append(make('p','sp-notice','자동 입력칸이 없는 문서입니다. 항목별 작성문을 원본 양식에 옮겨주세요.'));
      for(const warning of document.warnings)section.append(make('p','sp-field-note',warning));
      for(const field of document.fields){
        const item=make('div','sp-field');item.dataset.kind=field.kind;const heading=make('div','sp-field-heading');const label=make('label','',field.label);label.htmlFor='field-'+field.id;
        const redo=button('다시 작성',()=>{rewriteId=field.id;$('rewrite-label').textContent=`${field.label} · 이 초안의 ${usedModel} 모델로 다시 작성합니다. API 사용 비용이 발생합니다.`;$('rewrite-instruction').value='';$('rewrite-dialog').showModal();});heading.append(label,redo);
        const input=make('textarea');input.id='field-'+field.id;input.dataset.fieldId=field.id;input.value=field.value;input.maxLength=16000;input.rows=Math.min(16,Math.max(2,Math.ceil(field.value.length/65)));input.placeholder='보완할 내용을 입력해주세요.';
        input.addEventListener('input',()=>{draftDirty=true;$('draft-status').textContent=`v${draft.version} · 작성 모델 ${usedModel} · 저장하지 않은 수정 내용이 있습니다.`;});item.append(heading,input);
        if(field.note)item.append(make('p','sp-field-note',field.note));
        const sources=make('details');sources.append(make('summary','',field.edited?'사용자 수정 · 작성 근거 보기':'작성 근거 보기'));const list=make('ul');
        for(const source of field.sources)list.append(make('li','',`${sourceLabel(source)}: ${draft.evidence[source]||'근거 확인 필요'}`));
        if(!field.sources.length)list.append(make('li','','등록 근거가 없어 직접 확인이 필요한 항목입니다.'));sources.append(list);item.append(sources);section.append(item);
      }
      host.append(section);
    }
  }
  function draftValues(){return Object.fromEntries([...$('draft-editor').querySelectorAll('[data-field-id]')].map(i=>[i.dataset.fieldId,i.value]));}
  async function saveCurrentDraft(){
    const saved=await api('draft/save',{id:currentDraft.id,values:draftValues()});draftDirty=false;
    await loadCase(currentCase.id,false);currentDraft=saved;$('draft-version').value=saved.id;renderDraft();message('수정본을 새 버전으로 저장했습니다. 이전 초안도 보관되어 있습니다.');
  }
  $('login-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await api('login',{key:$('access-key').value});$('access-key').value='';signedIn=true;showAuth();await route();},e.submitter);});
  $('logout').addEventListener('click',()=>{if(!checkDirty())return;action(async()=>{await api('logout',{});signedIn=false;p=null;currentDraft=null;profileDirty=draftDirty=false;$('profile-sections').replaceChildren();$('draft-editor').replaceChildren();$('reference-list').replaceChildren();references=[];showAuth();message('신청 자료를 잠갔습니다.');});});
  $('profile-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{gatherProfile();p=await api('profile',{revision:p.revision,data:p.data});profileDirty=false;$('profile-revision').textContent=`기본 자료 v${p.revision} · 저장 ${date(p.updated)}`;message('기본 데이터를 저장했습니다.');},e.submitter);});
  $('sync-interests').addEventListener('click',e=>action(async()=>{const r=await api('cases/sync',{});await loadCases();message(r.added?`${r.added}개 관심 사업의 양식 수집을 시작했습니다.`:'관심 사업이 모두 연결되어 있습니다.');},e.currentTarget));
  $('reference-upload').addEventListener('change',e=>action(()=>uploadFiles(e.target.files,'',e.target)));
  $('case-upload').addEventListener('change',e=>{if(draftDirty&&!checkDirty()){e.target.value='';return;}action(()=>uploadFiles(e.target.files,currentCase.id,e.target));});
  $('back-cases').addEventListener('click',()=>{if(checkDirty()){draftDirty=false;location.hash='cases';}});
  $('recollect').addEventListener('click',e=>action(async()=>{await api('case/collect',{case_id:currentCase.id});await loadCase(currentCase.id);message('공고와 양식을 다시 확인하고 있습니다. 기존 원본과 초안은 보관합니다.');},e.currentTarget));
  $('generate-form').addEventListener('submit',e=>{e.preventDefault();if(!checkDirty())return;action(async()=>{
    if(!$('select-model').value)throw new Error('작성 모델을 목록에서 선택해주세요.');
    const result=await api('draft/create',{case_id:currentCase.id,model:$('select-model').value,branch_id:$('select-branch').value,plan_id:$('select-plan').value,member_ids:checked('select-members'),reference_ids:checked('select-references'),asset_ids:checked('select-assets'),instructions:$('draft-instructions').value});
    draftDirty=false;currentDraft=await api('draft?id='+result.id);await loadCase(currentCase.id);$('draft-version').value=result.id;renderDraft();message('초안 작성을 시작했습니다. 완료되면 이 화면에 표시됩니다.');
  },e.submitter);});
  $('select-model').addEventListener('change',renderModelInfo);
  $('draft-version').addEventListener('change',e=>{if(draftDirty&&!checkDirty()){e.target.value=currentDraft.id;return;}action(async()=>{currentDraft=await api('draft?id='+e.target.value);renderDraft();});});
  $('save-draft').addEventListener('click',e=>action(saveCurrentDraft,e.currentTarget));
  $('extract-company').addEventListener('click',e=>action(extractCompany,e.currentTarget));
  $('import-plan').addEventListener('click',()=>{gatherProfile();p.data.plans.push({id:crypto.randomUUID().replaceAll('-',''),name:reference.name.replace(/\.[^.]+$/,''),content:reference.text.slice(0,40000)});profileDirty=true;renderProfile('plans');$('reference-dialog').close();message('기준 사업계획에 문서 내용을 가져왔습니다. 내용을 확인하고 저장해주세요.');});
  $('rewrite-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{if(draftDirty)await saveCurrentDraft();busy=true;$('rewrite-dialog').close();message('선택한 항목을 다시 작성하고 있습니다…');try{const saved=await api('draft/rewrite',{id:currentDraft.id,field_id:rewriteId,instruction:$('rewrite-instruction').value});await loadCase(currentCase.id);currentDraft=saved;$('draft-version').value=saved.id;renderDraft();message('선택한 항목을 새 버전으로 작성했습니다.');}finally{busy=false;}},e.submitter);});
  for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$(b.dataset.close).close());
  document.addEventListener('click',e=>{const a=e.target.closest('a');if(!a||!a.getAttribute('href')?.startsWith('#'))return;if((profileDirty||draftDirty)&&!checkDirty()){e.preventDefault();return;}if(profileDirty)p=null;profileDirty=draftDirty=false;});
  window.addEventListener('beforeunload',e=>{if(profileDirty||draftDirty){e.preventDefault();e.returnValue='';}});
  window.addEventListener('hashchange',()=>action(route));
  setInterval(async()=>{if(!signedIn||polling||busy||document.hidden)return;polling=true;try{if(view==='cases')await loadCases();else if(view==='case'&&currentCase?.jobs.some(j=>['queued','running'].includes(j.state)))await loadCase(currentCase.id);}catch{/* Retain the visible result on background refresh failure. */}finally{polling=false;}},5000);
  action(async()=>{const session=await api('session');signedIn=session.authenticated;$('login-status').textContent=session.configured?'접근 키는 담당자에게 제공된 키를 사용하세요.':'담당자 접근 키 설정이 필요합니다.';showAuth();if(signedIn)await route();});
})();
