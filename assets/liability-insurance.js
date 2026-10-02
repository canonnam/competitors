(function(){
  'use strict';
  const UI=window.LiabilityUI,esc=UI.esc,grid=document.getElementById('li-grid'),message=document.getElementById('li-message');
  const pending=new Map(),branches=new Map(),tips=UI.mountTooltips(document,window);
  let refreshing=false,noticeTimer;
  async function request(url,body){
    const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(body?120000:20000),...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'보험 현황을 불러오지 못했습니다.');return data;
  }
  function notify(value,error=false){
    let out=message||document.getElementById('li-notice');
    if(!out){out=document.createElement('p');out.id='li-notice';out.className='li-notice';out.setAttribute('role','status');document.body.append(out);}
    clearTimeout(noticeTimer);out.textContent=value;out.hidden=!value;out.classList.toggle('li-error',error);
    if(value&&!error)noticeTimer=setTimeout(()=>{out.hidden=true;},6000);
  }
  function formHtml(branch){const p=branch.policy||{};return `<div class="li-dialog-heading"><h2 id="li-edit-title-${branch.id}">${esc(branch.name)} 보험 정보</h2><button class="ui-button ui-info-button li-icon-button" type="button" data-close aria-label="보험 정보 창 닫기">${UI.icon('close')}</button></div><form data-id="${branch.id}" data-version="${branch.version}"><div class="li-fields"><label>보험 이름<input name="insuranceName" maxlength="150" value="${esc(p.insuranceName)}" autocomplete="off"></label><label>현재 보험 가입 인원<input name="insuredCount" type="number" min="0" max="10000" step="1" required value="${esc(p.insuredCount)}" inputmode="numeric"></label><div class="li-date-fields"><label>가입 시작일<input name="startDate" type="date" min="2000-01-01" max="2100-12-31" value="${esc(p.startDate)}"></label><label>가입 만료일<input name="endDate" type="date" min="2000-01-01" max="2100-12-31" value="${esc(p.endDate)}"></label></div><label>보험 증서 업로드<input name="certificate" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label><span class="li-muted">PDF·JPG·PNG·WEBP, 최대 10MB. 새 증서는 저장할 때 기존 증서를 교체합니다.</span></div><div class="li-actions"><button class="ui-button" type="button" data-extract disabled>증서에서 정보 추출</button><button class="ui-button ui-button--primary" type="submit">확인 후 저장</button></div><p class="li-message" role="status" aria-live="polite"></p><details data-original hidden><summary>증서에서 읽은 내용 확인</summary><pre class="li-original"></pre></details></form>`;}
  function draw(data,savedId){
    for(const branch of data.branches){
      branches.set(branch.id,branch);
      if(grid){
        let card=document.getElementById('li-branch-'+branch.id);
        if(!card){card=document.createElement('article');card.id='li-branch-'+branch.id;card.className='li-branch';grid.append(card);}
        const html=UI.branch(branch,2);if(card._html!==html){card.innerHTML=html;card._html=html;}
      }
      if(savedId===branch.id){
        const form=document.querySelector(`#li-edit-${branch.id} form`);form.dataset.version=branch.version;
        form.elements.certificate.value='';form.querySelector('[data-extract]').disabled=true;pending.delete(branch.id);
      }
    }
    const info=document.getElementById('li-schedule-info');if(info)info.dataset.liTooltip=UI.schedule(data);
    const home=document.getElementById('home-liability-status');if(home)home.textContent=`${data.normalCount===2?'두 지점 양호':`${2-data.normalCount}개 지점 확인 필요`} · 안양 ${data.branches[0].label} / 인천 ${data.branches[1].label}`;
    window.HomeDashboard?.update('liability',data);
  }
  function openEditor(id){
    const branch=branches.get(id);if(!branch)return;
    tips.hide();let dialog=document.getElementById('li-edit-'+id);
    if(dialog&&!dialog.open&&Number(dialog.querySelector('form').dataset.version)!==branch.version){dialog.remove();dialog=null;pending.delete(id);}
    if(!dialog){dialog=document.createElement('dialog');dialog.id='li-edit-'+id;dialog.className='li-dialog';dialog.setAttribute('aria-labelledby','li-edit-title-'+id);dialog.innerHTML=formHtml(branch);document.body.append(dialog);bind(dialog);}
    if(!dialog.open)dialog.showModal();
  }
  function bind(dialog){
    const form=dialog.querySelector('form'),id=Number(form.dataset.id),fileInput=form.elements.certificate,out=form.querySelector('.li-message'),extractButton=form.querySelector('[data-extract]');
    let busy=false;
    const setBusy=value=>{busy=value;form.querySelectorAll('input,button').forEach(el=>{el.disabled=value;});extractButton.disabled=value||!pending.has(id);};
    dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{document.querySelector(`[data-li-edit="${id}"]`)?.focus({preventScroll:true});tips.hide();});
    dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
    fileInput.addEventListener('change',()=>{
      const file=fileInput.files[0];pending.delete(id);out.classList.remove('li-error');out.textContent='';form.querySelector('[data-original]').hidden=true;
      if(file){if(file.size>10*1024*1024||!['application/pdf','image/jpeg','image/png','image/webp'].includes(file.type)){out.textContent='10MB 이하 PDF·JPG·PNG·WEBP 파일을 선택해주세요.';fileInput.value='';}else{pending.set(id,file);out.textContent='증서가 선택되었습니다. 내용을 추출하거나 직접 입력한 뒤 저장해주세요.';}}
      extractButton.disabled=!pending.has(id);
    });
    extractButton.addEventListener('click',async()=>{
      if(busy||!pending.has(id))return;setBusy(true);out.classList.remove('li-error');out.textContent='증서의 글자를 읽고 있습니다.';
      try{
        const {extract}=await import('/assets/liability-ocr.js?v=20261002-1'),text=await extract(pending.get(id),value=>{out.textContent=value;}),proposal=window.LiabilityCertificate.parse(text);
        for(const key of ['insuranceName','insuredCount','startDate','endDate'])if(proposal[key]!==null)form.elements[key].value=proposal[key];
        const original=form.querySelector('[data-original]');original.hidden=false;original.querySelector('pre').textContent=text.slice(0,50000);
        out.textContent=`추출한 값은 아직 저장되지 않았습니다. 증서 원문과 비교해 확인·수정해주세요.${proposal.missing.length?' 직접 확인할 항목: '+proposal.missing.join(', ')+'.':''}`;
      }catch(error){out.textContent=(/[가-힣]/.test(error.message||'')?error.message:'증서에서 글자를 읽지 못했습니다.')+' 보험 정보를 직접 입력해 증서와 함께 저장할 수 있습니다.';out.classList.add('li-error');}
      finally{setBusy(false);}
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;
      const body={insuranceName:form.elements.insuranceName.value,insuredCount:Number(form.elements.insuredCount.value),startDate:form.elements.startDate.value,endDate:form.elements.endDate.value,version:Number(form.dataset.version)};
      if(body.startDate&&body.endDate&&body.startDate>body.endDate){out.textContent='가입 시작일은 만료일보다 늦을 수 없습니다.';return;}
      setBusy(true);out.classList.remove('li-error');out.textContent='보험 정보를 저장하고 있습니다.';
      try{
        const file=pending.get(id);
        if(file){const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('증서 파일을 읽지 못했습니다.'));reader.readAsDataURL(file);});body.certificate={name:file.name,type:file.type,data:encoded};}
        draw(await request('/api/liability-insurance/'+id,body),id);out.textContent='보험 정보가 저장되었습니다.';dialog.close();notify('보험 정보가 저장되었습니다.');
      }catch(error){out.textContent=error.message;out.classList.add('li-error');}
      finally{setBusy(false);}
    });
  }
  async function load(){try{draw(await request('/api/liability-insurance'));}catch(error){notify(error.message,true);const home=document.getElementById('home-liability-status');if(home)home.textContent='보험 현황을 불러오지 못했습니다.';window.HomeDashboard?.fail('liability');}}
  document.addEventListener('click',event=>{const edit=event.target.closest('[data-li-edit]');if(edit)openEditor(Number(edit.dataset.liEdit));});
  document.getElementById('li-refresh')?.addEventListener('click',async event=>{
    if(refreshing)return;refreshing=true;event.currentTarget.disabled=true;notify('ERP 전체 현원을 확인하고 있습니다.');
    try{draw(await request('/api/liability-insurance/refresh',{}));notify('전체 현원을 확인했습니다.');}catch(error){notify(error.message,true);}finally{refreshing=false;document.getElementById('li-refresh').disabled=false;}
  });
  load();setInterval(()=>{if(!document.hidden&&!refreshing)load();},60000);
})();
