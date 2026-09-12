// Optional DOM flow test: npm install --prefix .local/dom-tests jsdom@26.1.0
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require(process.env.SUPPORT_JSDOM_MODULE||'../.local/dom-tests/node_modules/jsdom');
const html=fs.readFileSync('support-prep.html','utf8'),js=fs.readFileSync('assets/support-prep.js','utf8');
const clone=v=>JSON.parse(JSON.stringify(v));
const profile={revision:1,updated:'2026-09-12T00:00:00Z',data:{company:{name:'검증 회사'},branches:[{id:'branch',name:'인천점'}],members:[{id:'member',name:'검증 팀원'}],plans:[{id:'plan',name:'기준 사업계획'}],records:[]}};
const asset={id:'asset',name:'신청서.hwp',kind:'form',format:'hwpx',mode:'template',size:1000,characters:20,error:''};
const data={id:'case',announcement:{title:'검증 지원사업',url:'https://www.bizinfo.go.kr/',application_period:'2026.09.01~2026.09.30'},status:'ready',error:'',assets:[asset],drafts:[],jobs:[]};
const drafts={};let requestBody=null;
const models={default:'gpt-4.1-mini',prices_checked:'2026-09-12',models:[{id:'gpt-4.1-mini',label:'GPT-4.1 mini',description:'기본 모델',input_price:.4,cached_input_price:.1,output_price:1.6,price_url:'https://developers.openai.com/api/docs/models/gpt-4.1-mini'},{id:'gpt-5.4',label:'GPT-5.4',description:'추론 지원',input_price:2.5,cached_input_price:.25,output_price:15,price_url:'https://developers.openai.com/api/docs/models/gpt-5.4'}]};
const dom=new JSDOM(html,{url:'https://app.aivida.tech/support-prep.html#case=case',runScripts:'outside-only'});
const w=dom.window;w.setInterval=()=>0;w.confirm=()=>true;w.AbortSignal.timeout=()=>undefined;
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.fetch=async(url,options)=>{
 const route=url.replace('/api/support/','');let result;
 if(route==='session')result={authenticated:true,configured:true,ai_ready:true};
 else if(route==='models')result=models;
 else if(route==='profile'&&options.method==='GET')result=profile;
 else if(route==='profile'){const b=JSON.parse(options.body);profile.data=b.data;profile.revision++;result=profile;}
 else if(route==='assets')result={assets:[]};
 else if(route==='case?id=case')result=data;
 else if(route==='cases')result={cases:[]};
 else if(route==='draft/create'){
  requestBody=JSON.parse(options.body);
  drafts.one={id:'one',version:1,status:'ready',profile_revision:1,created:'2026-09-12T00:00:00Z',snapshot:{branch:{name:'인천점'},plan:{name:'기준계획'}},evidence:{'company.name':'검증 회사'},data:{documents:[{asset_id:'asset',name:'신청서.hwp',mode:'template',format:'hwpx',warnings:[],fields:[{id:'field',target_id:'target',label:'기업명',value:'검증 회사',kind:'fact',sources:['company.name'],note:'',edited:false}]}]}};
  drafts.one.model=requestBody.model;drafts.one.model_label=models.models.find(m=>m.id===requestBody.model).label;drafts.one.snapshot.model=requestBody.model;
  data.drafts=[drafts.one];result={id:'one',version:1};
 }else if(route.startsWith('draft?id='))result=drafts[route.slice(9)];
 else if(route==='draft/save'){
  const b=JSON.parse(options.body);drafts.two=clone(drafts.one);drafts.two.id='two';drafts.two.version=2;drafts.two.data.documents[0].fields[0].value=b.values.field;
  data.drafts.unshift(drafts.two);result=drafts.two;
 }else throw new Error('Unexpected request: '+route);
 return {ok:true,status:200,json:async()=>clone(result)};
};
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(setImmediate);}throw new Error('Condition not reached');}
function submit(id){w.document.getElementById(id).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));}
(async()=>{
 w.eval(js);await until(()=>w.document.getElementById('select-assets').querySelector('input'));
 assert.equal(w.document.getElementById('case-title').textContent,'검증 지원사업');
 const modelSelect=w.document.getElementById('select-model');assert.equal(modelSelect.value,'gpt-4.1-mini');
 modelSelect.value='gpt-5.4';modelSelect.dispatchEvent(new w.Event('change'));
 assert.ok(w.document.getElementById('model-pricing').textContent.includes('출력 $15'));
 assert.ok(w.document.getElementById('model-price-source').href.endsWith('/gpt-5.4'));assert.equal(requestBody,null);
 w.document.querySelector('#select-members input').checked=true;submit('generate-form');
 await until(()=>w.document.getElementById('field-field'));
 assert.deepEqual(requestBody.asset_ids,['asset']);assert.deepEqual(requestBody.member_ids,['member']);assert.equal(requestBody.branch_id,'branch');assert.equal(requestBody.plan_id,'plan');
 assert.equal(requestBody.model,'gpt-5.4');assert.equal(modelSelect.value,'gpt-5.4');assert.ok(w.document.getElementById('draft-status').textContent.includes('GPT-5.4'));
 modelSelect.value='gpt-4.1-mini';modelSelect.dispatchEvent(new w.Event('change'));w.document.querySelector('.sp-field-heading button').click();
 assert.ok(w.document.getElementById('rewrite-label').textContent.includes('GPT-5.4 모델'));w.document.getElementById('rewrite-dialog').close();
 const editor=w.document.getElementById('field-field');editor.value='수정 회사';editor.dispatchEvent(new w.Event('input',{bubbles:true}));w.document.getElementById('save-draft').click();
 await until(()=>w.document.getElementById('draft-bundle').href.includes('id=two'));
 assert.equal(w.document.getElementById('field-field').value,'수정 회사');assert.equal(w.document.getElementById('draft-version').value,'two');
 assert.equal(drafts.one.data.documents[0].fields[0].value,'검증 회사');
 assert.equal(modelSelect.value,'gpt-4.1-mini');assert.equal(drafts.two.snapshot.model,'gpt-5.4');
 assert.ok(w.document.getElementById('draft-status').textContent.includes('GPT-5.4'));
 w.location.hash='profile';await until(()=>w.document.querySelector('[data-field="representative"]'));
 const representative=w.document.querySelector('[data-field="representative"]');representative.value='테스트 담당자';representative.dispatchEvent(new w.Event('input',{bubbles:true}));submit('profile-form');
 await until(()=>w.document.getElementById('message').textContent==='기본 데이터를 저장했습니다.');assert.equal(profile.revision,2);assert.equal(profile.data.company.representative,'테스트 담당자');assert.equal(w.localStorage.length,0);
 console.log('PASS: model choice, pricing, no AI on selection, frozen draft/rewrite model, dataset form, editing, versions, download, no browser persistence');
 dom.window.close();
})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1;});
