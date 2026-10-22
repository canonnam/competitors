(function(root){
  'use strict';
  // Keep automated observation tools independent of the removed manual-entry UI.
  root.WebSearchResults={render:()=>'',isEditing:()=>false};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.WebSearchResults;
  if(typeof document==='undefined')return;
  const modelContext=document.modelContext||navigator.modelContext;
  if(modelContext?.registerTool){
    try{modelContext.registerTool({name:'record_content_quality',description:'Save a verified branch-level website/blog quality report. Record actual checks or publicly verified fixes, next tasks and explicit approval needs. Do not infer indexing or change search observations. No credentials or private blog statistics.',inputSchema:{type:'object',additionalProperties:false,required:['request_id','branch','checked_at','status','summary','completed','next_tasks','approvals'],properties:{request_id:{type:'string'},branch:{type:'string',enum:['incheon','anyang']},checked_at:{type:'string'},status:{type:'string',enum:['checked','updated','needs_approval','blocked']},summary:{type:'string'},completed:{type:'array',items:{type:'object',additionalProperties:false,required:['note','url','verified_at'],properties:{note:{type:'string'},url:{type:'string'},verified_at:{type:'string'}}}},next_tasks:{type:'array',items:{type:'string'}},approvals:{type:'array',items:{type:'string'}}}},annotations:{readOnlyHint:false},execute:async input=>{
      const response=await fetch('/api/search-visibility/content-quality',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(20000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'콘텐츠 관리 기록 저장 실패');
      document.dispatchEvent(new CustomEvent('web-result-saved'));
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    }});}catch{}
    const naverProperties={provider:{type:'string',enum:['naver']},keyword:{type:'string'},branch:{type:'string',enum:['incheon','anyang']},request_id:{type:'string'},observed_at:{type:'string'},status:{type:'string',enum:['ready','blocked']},capture_method:{type:'string',enum:['browser']},session_context:{type:'string'},reason:{type:'string'},complete_search:{type:'boolean'},pages:{type:'array',items:{type:'object',properties:{page:{type:'integer'},url:{type:'string'},text:{type:'string'},has_next:{type:'boolean'},results:{type:'array',items:{type:'object',properties:{area:{type:'string',enum:['web','place','ad','place_ad']},position:{type:'integer'},title:{type:'string'},url:{type:'string'},snippet:{type:'string'}},required:['area','position','title','url'],additionalProperties:false}}},required:['page','url','text','has_next','results'],additionalProperties:false}}};
    try{modelContext.registerTool({name:'record_naver_web_observation',description:'Save one registered Naver keyword observed with Computer Use. Record the visible search-results body (exclude account header and private data), actual page URL and all brand/owned-site matching entries by area. Positions must use the complete area list, not just brand matches. The results list may be empty only when no brand/owned-site entry appears. Separate ads from organic results; never click ads. Visit pages 1 through the dashboard max_pages, or stop when no next page exists. Do not mark a partial range complete. Record blocked with the concrete reason when access or required pages cannot be verified. Use the current ON keywords and enabled regional keywords. This stores shared dashboard data.',inputSchema:{type:'object',properties:naverProperties,required:['provider','keyword','branch','request_id','observed_at','status','capture_method','session_context'],additionalProperties:false},annotations:{readOnlyHint:false},execute:async input=>{
      const response=await fetch('/api/search-visibility/web-results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(20000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'네이버 웹 결과 저장 실패');
      document.dispatchEvent(new CustomEvent('web-result-saved'));
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    }});}catch{}
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
})(globalThis);
