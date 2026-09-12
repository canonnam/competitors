(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const drafts=new Map(),contexts=new Map(),pending=new Set();
  function render(item,provider){
    const key=provider+'-'+item.branch+'-'+encodeURIComponent(item.keyword),draft=drafts.get(key)||{};
    contexts.set(key,{provider,keyword:item.keyword,branch:item.branch});
    return `<div class="web-result-actions"><button type="button" data-copy-question="${esc(item.keyword)}">질문 복사</button><a href="${provider==='chatgpt_web'?'https://chatgpt.com/':'https://gemini.google.com/app'}" target="_blank" rel="noopener noreferrer">웹 서비스 열기 ↗</a><span class="web-copy-status" role="status"></span></div><details class="web-result-entry"${draft.status?' open':''}><summary>웹에서 확인한 결과 직접 등록</summary><p>같은 질문을 새 대화로 검색하고, 답변과 표시된 장소 카드를 확인하세요. 매일 자동 점검 결과도 이곳에 함께 기록됩니다.</p><form data-web-result="${esc(key)}"><fieldset><legend>실제 웹 확인 기록</legend>
      <label>확인 결과<select name="status" required><option value="ready"${draft.status!=='blocked'?' selected':''}>웹 검색 결과 확인</option><option value="blocked"${draft.status==='blocked'?' selected':''}>로그인·접근 제한 등 확인 불가</option></select></label>
      <label>확인 시각 (한국시간)<input type="datetime-local" name="observed_at" required value="${esc(draft.observed_at||new Date(Date.now()+9*3600000).toISOString().slice(0,16))}"></label>
      <div class="web-result-success"${draft.status==='blocked'?' hidden':''}><label>웹 답변 전체와 장소 카드 내용<textarea name="answer" rows="6" maxlength="50000"${draft.status==='blocked'?'':' required'} placeholder="웹 화면에서 확인한 답변 원문과 장소 카드의 시설명·지역을 붙여넣으세요.">${esc(draft.answer)}</textarea></label><label>검색 환경<input name="session_context" maxlength="300"${draft.status==='blocked'?'':' required'} value="${esc(draft.session_context)}" placeholder="예: 비로그인 · 새 대화 · 브라우저 기본 위치"></label><label>화면의 모드·모델 (선택)<input name="model" maxlength="100" value="${esc(draft.model)}" placeholder="예: Flash-Lite / 표시되지 않음"></label>
      <label class="web-confirm"><input type="checkbox" name="search_confirmed"${draft.search_confirmed?' checked':''}${draft.status==='blocked'?'':' required'}> 웹 검색 근거 또는 지도·장소 카드가 실제로 표시되었습니다.</label><label class="web-confirm"><input type="checkbox" name="complete_answer"${draft.complete_answer?' checked':''}${draft.status==='blocked'?'':' required'}> 생성 완료된 전체 답변을 확인했습니다.</label><label class="web-confirm"><input type="checkbox" name="places"${draft.places?' checked':''}> 지도·장소 카드도 확인했습니다.</label></div>
      <div class="web-result-blocked"${draft.status==='blocked'?'':' hidden'}><label>확인하지 못한 이유<textarea name="reason" rows="2" maxlength="1500"${draft.status==='blocked'?' required':''}>${esc(draft.reason)}</textarea></label></div>
      <label>대화·공유 주소 (선택)<input type="url" name="conversation_url" maxlength="2000" value="${esc(draft.conversation_url)}"></label><label>답변의 출처 주소 (선택·한 줄에 하나)<textarea name="sources" rows="2" placeholder="https://" maxlength="60000">${esc(draft.sources)}</textarea></label><button type="submit">웹 결과 저장</button></fieldset><p class="web-save-status" role="status"></p></form></details>`;
  }
  root.WebSearchResults={render,isEditing:()=>typeof document!=='undefined'&&(pending.size>0||Boolean(document.activeElement?.closest('.web-result-entry form')))};
  if(typeof module!=='undefined'&&module.exports)module.exports={render};
  if(typeof document==='undefined')return;
  const modelContext=document.modelContext||navigator.modelContext;
  if(modelContext?.registerTool){
    const properties={
      provider:{type:'string',enum:['chatgpt_web','gemini_web']},keyword:{type:'string'},branch:{type:'string',enum:['incheon','anyang']},
      request_id:{type:'string'},observed_at:{type:'string'},status:{type:'string',enum:['ready','blocked']},
      answer:{type:'string'},reason:{type:'string'},session_context:{type:'string'},model:{type:'string'},
      conversation_url:{type:'string'},capture_method:{type:'string',enum:['manual','browser']},
      search_confirmed:{type:'boolean'},complete_answer:{type:'boolean'},
      surfaces:{type:'array',items:{type:'string',enum:['answer','places']}},
      sources:{type:'array',items:{type:'object',properties:{url:{type:'string'},title:{type:'string'}},required:['url','title'],additionalProperties:false}}
    };
    try{modelContext.registerTool({name:'record_web_search_observation',description:'Save one actually observed ChatGPT or Gemini consumer-web result to this search-visibility dashboard. Use the unchanged registered question, full completed visible answer and any displayed place cards. Never submit an inference API answer. Record blocked status and reason if the web result could not be verified. This stores shared dashboard data and refreshes the visible results.',inputSchema:{type:'object',properties,required:['provider','keyword','branch','request_id','observed_at','status','capture_method','surfaces'],additionalProperties:false},annotations:{readOnlyHint:false},execute:async input=>{
      const response=await fetch('/api/search-visibility/web-results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(20000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'웹 결과 저장 실패');
      document.dispatchEvent(new CustomEvent('web-result-saved'));
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    }});}catch{}
  }
  document.addEventListener('click',async e=>{const button=e.target.closest('[data-copy-question]');if(!button)return;const status=button.parentElement.querySelector('.web-copy-status');try{await navigator.clipboard.writeText(button.dataset.copyQuestion);status.textContent='질문을 복사했습니다.';}catch{status.textContent='질문 제목을 직접 복사해주세요.';}});
  const remember=form=>{drafts.set(form.dataset.webResult,Object.fromEntries(new FormData(form)));};
  document.addEventListener('input',e=>{const form=e.target.closest('form[data-web-result]');if(form){delete form.dataset.requestId;remember(form);}});
  document.addEventListener('change',e=>{const form=e.target.closest('form[data-web-result]');if(!form)return;delete form.dataset.requestId;remember(form);const blocked=form.elements.status.value==='blocked';form.querySelector('.web-result-success').hidden=blocked;form.querySelector('.web-result-blocked').hidden=!blocked;for(const name of ['answer','session_context','search_confirmed','complete_answer'])form.elements[name].required=!blocked;form.elements.reason.required=blocked;});
  document.addEventListener('submit',async e=>{
    const form=e.target.closest('form[data-web-result]');if(!form)return;e.preventDefault();const key=form.dataset.webResult;if(pending.has(key))return;
    remember(form);const values=drafts.get(key),status=form.querySelector('.web-save-status');
    const body={...values,...contexts.get(key),request_id:(form.dataset.requestId ||= crypto.randomUUID()),capture_method:'manual',observed_at:values.observed_at+':00+09:00',search_confirmed:values.search_confirmed==='on',complete_answer:values.complete_answer==='on',surfaces:values.places?['answer','places']:['answer'],sources:(values.sources||'').split(/\n/).map(url=>url.trim()).filter(Boolean).map(url=>({url,title:url}))};
    pending.add(key);form.querySelector('fieldset').disabled=true;status.textContent='저장 중…';
    try{const response=await fetch('/api/search-visibility/web-results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const result=await response.json();if(!response.ok)throw new Error(result.error||'저장 실패');drafts.delete(key);pending.delete(key);status.textContent='웹 결과를 저장했습니다.';document.dispatchEvent(new CustomEvent('web-result-saved'));}
    catch(error){status.textContent=error.name==='TimeoutError'?'응답이 늦습니다. 새로고침으로 저장 여부를 확인해주세요.':error.message||'연결을 확인해주세요.';}
    finally{pending.delete(key);form.querySelector('fieldset').disabled=false;}
  });
})(globalThis);
