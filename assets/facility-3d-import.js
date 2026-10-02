/* PDF rendering, local OCR and review before adding proposed rooms. */
export function initImport(ctx) {
  const $=id=>document.getElementById(id),D=window.FacilityDetect,M=ctx.model;
  let ticket=0,busy=false,worker=null,pdf=null,pdfTask=null,pdfRevision=0,pdfCanvas=null,pdfLabels=[],source=null,draft=[];
  let targetProject,targetFloor;
  const preview=$('auto-preview'),dialog=$('auto-dialog');
  const progress=message=>{$('auto-status').textContent=message;};
  function setBusy(value){busy=value;$('upload-image').disabled=value;$('auto-analyze').disabled=value;$('auto-apply').disabled=value||!$('auto-list').querySelector('input[type=checkbox]:checked');$('demo-plan').disabled=value;}
  function imageCanvas(img,max=1500) {
    const scale=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));
    const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(img,0,0,c.width,c.height);return c;
  }
  async function decode(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('도면 이미지를 읽지 못했습니다.'));img.src=src;});}
  function encode(c,name,labels) {
    const src=c.toDataURL('image/jpeg',0.88),aspect=c.width/c.height;
    if(src.length>1800000||aspect<0.05||aspect>20)throw new Error('이미지를 더 작게 저장하거나 도면 부분만 잘라 등록해주세요.');
    return {src,aspect,name:name.slice(0,80),...(labels?.length?{labels}: {})};
  }
  async function ocr(c,myTicket) {
    if(!window.Tesseract) {
      await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/assets/vendor/tesseract/dist/tesseract.min.js';s.onload=resolve;s.onerror=()=>reject(new Error('글자 인식 도구를 불러오지 못했습니다.'));document.head.append(s);});
    }
    if(myTicket!==ticket)return [];
    progress('공간 이름을 읽는 중입니다. 처음 실행할 때는 글자 인식 자료를 준비합니다.');
    let rejectJob=()=>{};
    const active=await new Promise((resolve,reject)=>{rejectJob=reject;window.Tesseract.createWorker(['kor','eng'],1,{
      workerPath:'/assets/vendor/tesseract/dist/worker.min.js',corePath:'/assets/vendor/tesseract/core',langPath:'/assets/vendor/tesseract/tessdata',
      workerBlobURL:false,gzip:true,errorHandler:error=>rejectJob(new Error(String(error))),logger:message=>{if(myTicket===ticket&&message.status==='recognizing text')progress(`공간 이름 읽는 중 · ${Math.round(message.progress*100)}%`);}
    }).then(resolve,reject);});
    if(myTicket!==ticket){await active.terminate();return [];}
    worker=active;
    try {
      await active.setParameters({tessedit_pageseg_mode:'11',preserve_interword_spaces:'1',user_defined_dpi:'150'});
      const {data}=await new Promise((resolve,reject)=>{rejectJob=reject;active.recognize(c,{}, {text:true,blocks:true}).then(resolve,reject);}),labels=[];
      const add=(text,bbox,confidence)=>{if(bbox&&D.labelInfo(text,true))labels.push({text,x:(bbox.x0+bbox.x1)/2/c.width,y:(bbox.y0+bbox.y1)/2/c.height,confidence:confidence??60});};
      for(const block of data.blocks||[])for(const paragraph of block.paragraphs||[])for(const line of paragraph.lines||[]) {
        add(line.text,line.bbox,line.confidence);
        for(const word of line.words||[])add(word.text,word.bbox,word.confidence);
      }
      return labels;
    } finally {if(worker===active)worker=null;await active.terminate();}
  }
  function paint() {
    if(!source)return;
    preview.width=source.width;preview.height=source.height;const g=preview.getContext('2d');g.drawImage(source,0,0);
    draft.forEach((r,i)=>{
      const checked=$('auto-list').querySelector(`[data-index="${i}"] input[type=checkbox]`)?.checked;
      g.fillStyle=checked?'rgba(67,86,173,.15)':'rgba(120,130,150,.08)';g.strokeStyle=checked?'#4356ad':'#8c96a6';g.lineWidth=3;
      g.fillRect(r.left*preview.width,r.top*preview.height,r.width*preview.width,r.height*preview.height);g.strokeRect(r.left*preview.width,r.top*preview.height,r.width*preview.width,r.height*preview.height);
      const x=(r.left+r.width/2)*preview.width,y=(r.top+r.height/2)*preview.height;g.fillStyle=checked?'#4356ad':'#8c96a6';g.beginPath();g.arc(x,y,20,0,Math.PI*2);g.fill();g.fillStyle='#fff';g.font='bold 22px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(String(i+1),x,y);
    });
  }
  function review() {
    $('auto-replace-field').hidden=!targetFloor.rooms.length;$('auto-replace').checked=false;
    $('auto-apply').textContent='선택 공간 추가';
    $('auto-list').replaceChildren();
    draft.forEach((r,i)=>{
      const row=document.createElement('div');row.className='f3-auto-row';row.dataset.index=i;
      const choose=document.createElement('input');choose.type='checkbox';choose.checked=!r.blocked;choose.disabled=r.blocked;choose.setAttribute('aria-label',`공간 ${i+1} 추가`);
      const number=document.createElement('span');number.textContent=i+1;
      const name=document.createElement('input');name.value=r.name;name.maxLength=80;name.setAttribute('aria-label',`공간 ${i+1} 이름`);
      const type=document.createElement('select');type.setAttribute('aria-label',`공간 ${i+1} 용도`);
      for(const [value,label]of Object.entries(M.TYPES)){const option=document.createElement('option');option.value=value;option.textContent=label;type.append(option);}type.value=r.type;
      const note=document.createElement('small');note.textContent=r.blocked?'기존 공간과 겹침':r.original?`인식: ${r.original} → ${r.name} · 확인 필요`:r.named&&r.type!=='unknown'?'도면 이름 연결':'이름·용도 확인 필요';
      row.append(choose,number,name,type,note);$('auto-list').append(row);
    });
    paint();$('auto-apply').disabled=!draft.some(r=>!r.blocked);
  }
  async function analyze() {
    if(busy||!source)return;
    const myTicket=++ticket;draft=[];$('auto-list').replaceChildren();setBusy(true);progress('벽 경계에서 공간 후보를 찾는 중입니다.');
    try {
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const c=imageCanvas(source,800),result=D.detect(c.getContext('2d').getImageData(0,0,c.width,c.height),{gap:Number($('auto-gap').value)});
      if(!result.regions.length){progress('닫힌 공간 경계를 찾지 못했습니다. 문 틈 메우기를 바꿔 다시 분석하거나 평면 편집에서 공간을 지정하세요.');paint();return;}
      let labels=targetFloor.image?.labels||[],warning='';
      const mapped=D.mapLabels(result.regions,labels);
      if($('auto-names').checked&&mapped.some(r=>!r.named)) {
        try {labels=[...labels,...await ocr(source,myTicket)];}
        catch(error){if(myTicket!==ticket)return;warning=' 글자 인식을 완료하지 못해 이름은 직접 확인해주세요.';}
      }
      if(myTicket!==ticket)return;
      draft=D.mapLabels(result.regions,$('auto-names').checked?labels:[]).filter(r=>{
        const [room]=D.projectRooms([r],targetProject,targetFloor.image.aspect,M.uid);if(!room)return false;
        r.blocked=targetFloor.rooms.some(existing=>M.intersects(existing,room));return true;
      });
      review();const named=draft.filter(r=>r.named).length;
      progress(`${draft.length}개 공간 후보 · 이름 ${named}개 연결. 위치·이름·용도를 확인한 뒤 추가하세요.${result.overflow?' 후보가 많아 처음 40개를 표시합니다.':''}${warning}`);
    } catch(error){if(myTicket===ticket)progress(error.message||'도면 분석을 완료하지 못했습니다. 다시 시도해주세요.');}
    finally{if(myTicket===ticket)setBusy(false);}
  }
  async function begin(c,image) {
    ctx.onImage(image,targetProject,targetFloor);source=c;draft=[];preview.hidden=false;dialog.showModal();paint();await analyze();
  }
  async function closePdf() {
    pdfRevision++;pdfCanvas=null;pdfLabels=[];
    pdf=null;const old=pdfTask;pdfTask=null;if(old)await old.destroy();
  }
  async function renderPdf() {
    if(!pdf)return;
    const revision=++pdfRevision;$('pdf-use').disabled=true;$('pdf-page').disabled=true;$('pdf-status').textContent='선택 페이지를 준비하고 있습니다…';
    try {
      const page=await pdf.getPage(Number($('pdf-page').value)),original=page.getViewport({scale:1});
      const viewport=page.getViewport({scale:1500/Math.max(original.width,original.height)}),c=document.createElement('canvas');
      c.width=Math.ceil(viewport.width);c.height=Math.ceil(viewport.height);
      await page.render({canvasContext:c.getContext('2d'),viewport,background:'#fff'}).promise;
      const content=await page.getTextContent(),lib=await import('/assets/vendor/pdfjs/build/pdf.mjs'),labels=[];
      for(const item of content.items) {
        if(!item.str)continue;
        const t=lib.Util.transform(viewport.transform,item.transform),angle=Math.atan2(t[1],t[0]),height=Math.hypot(t[2],t[3]),width=item.width*viewport.scale;
        const x=(t[4]+Math.cos(angle)*width/2+Math.sin(angle)*height/2)/c.width,y=(t[5]+Math.sin(angle)*width/2-Math.cos(angle)*height/2)/c.height;
        if(x>=0&&x<=1&&y>=0&&y<=1&&D.labelInfo(item.str))labels.push({text:item.str.slice(0,80),x,y,confidence:100});
      }
      if(revision!==pdfRevision)return;
      pdfCanvas=c;pdfLabels=labels.slice(0,500);$('pdf-preview').src=c.toDataURL('image/jpeg',0.8);$('pdf-status').textContent=`${pdf.numPages}페이지 중 ${$('pdf-page').value}페이지 · ${M.floorName(targetFloor.level)}에 등록`;$('pdf-use').disabled=false;
    } catch(error){if(revision===pdfRevision)$('pdf-status').textContent='페이지를 표시하지 못했습니다. 다른 페이지나 이미지 파일을 선택해주세요.';}
    finally{if(revision===pdfRevision)$('pdf-page').disabled=false;}
  }
  async function openFile(file) {
    if(!file||busy)return;
    let passwordRequired=false;
    targetProject=ctx.getProject();targetFloor=ctx.getFloor();setBusy(true);
    ctx.status(/\.pdf$/i.test(file.name)?'PDF 도면을 읽고 있습니다. 페이지를 선택하면 자동 구성을 시작합니다.':'도면 이미지를 읽고 있습니다.');
    try {
      if(file.type==='application/pdf'||/\.pdf$/i.test(file.name)) {
        if(file.size>20000000)throw new Error('20MB 이하의 PDF를 선택해주세요.');
        const lib=await import('/assets/vendor/pdfjs/build/pdf.mjs');lib.GlobalWorkerOptions.workerSrc='/assets/vendor/pdfjs/build/pdf.worker.mjs';
        pdfTask=lib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,cMapUrl:'/assets/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/vendor/pdfjs/standard_fonts/',wasmUrl:'/assets/vendor/pdfjs/wasm/'});
        pdfTask.onPassword=()=>{passwordRequired=true;pdfTask.destroy();};
        pdf=await pdfTask.promise;
        if(pdf.numPages>200)throw new Error('등록할 층의 도면을 200페이지 이하 PDF로 나눠주세요.');
        $('pdf-page').replaceChildren(...Array.from({length:pdf.numPages},(_,i)=>{const o=document.createElement('option');o.value=i+1;o.textContent=(i+1)+'페이지';return o;}));
        $('pdf-name').textContent=file.name;$('pdf-dialog').showModal();await renderPdf();
      } else {
        if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10000000)throw new Error('JPG·PNG·WEBP는 10MB, PDF는 20MB까지 등록할 수 있습니다.');
        const url=URL.createObjectURL(file);let img;try{img=await decode(url);}finally{URL.revokeObjectURL(url);}
        const c=imageCanvas(img);setBusy(false);await begin(c,encode(c,file.name));
      }
    } catch(error){ctx.status(passwordRequired?'암호를 해제한 PDF 파일을 등록해주세요.':error.message||'도면 파일을 읽지 못했습니다.','error');await closePdf();}
    finally{if(!dialog.open)setBusy(false);}
  }
  $('upload-image').onclick=()=>$('image-file').click();
  $('image-file').onchange=event=>{const file=event.target.files[0];event.target.value='';openFile(file);};
  $('pdf-page').onchange=renderPdf;
  $('pdf-use').onclick=async()=>{
    const c=pdfCanvas;if(!c)return;
    try {
      const image=encode(c,`${$('pdf-name').textContent} · ${$('pdf-page').value}페이지`,pdfLabels);
      $('pdf-dialog').close();await closePdf();setBusy(false);await begin(c,image);
    } catch(error){ctx.status(error.message,'error');$('pdf-status').textContent=error.message;setBusy(false);}
  };
  $('pdf-close').onclick=()=>{$('pdf-dialog').close();closePdf();setBusy(false);};
  $('pdf-dialog').addEventListener('cancel',()=>{closePdf();setBusy(false);});
  $('auto-analyze').onclick=analyze;
  $('auto-replace').onchange=()=>{
    $('auto-apply').textContent=$('auto-replace').checked?'선택 공간으로 교체':'선택 공간 추가';
    draft.forEach((r,i)=>{
      const row=$('auto-list').querySelector(`[data-index="${i}"]`),choose=row.querySelector('input[type=checkbox]');
      const disabled=r.blocked&&!$('auto-replace').checked;
      if(choose.disabled&&!disabled)choose.checked=true;if(disabled)choose.checked=false;choose.disabled=disabled;
      row.querySelector('small').textContent=disabled?'기존 공간과 겹침':r.original?`인식: ${r.original} → ${r.name} · 확인 필요`:r.named&&r.type!=='unknown'?'도면 이름 연결':'이름·용도 확인 필요';
    });paint();$('auto-apply').disabled=busy||!$('auto-list').querySelector('input[type=checkbox]:checked');
  };
  $('auto-list').onchange=()=>{paint();$('auto-apply').disabled=busy||!$('auto-list').querySelector('input[type=checkbox]:checked');};
  $('auto-apply').onclick=()=>{
    try {
      const chosen=draft.filter((r,i)=>{
        const row=$('auto-list').querySelector(`[data-index="${i}"]`);if(!row.querySelector('input[type=checkbox]').checked)return false;
        r.name=row.querySelector('input:not([type=checkbox])').value.trim()||'새 공간';r.type=row.querySelector('select').value;return true;
      });
      ctx.onRooms(D.projectRooms(chosen,targetProject,targetFloor.image.aspect,M.uid),targetProject,targetFloor,$('auto-replace').checked);
      dialog.close();source=null;draft=[];
    } catch(error){progress(error.message);}
  };
  function cancel(){ticket++;worker?.terminate();worker=null;setBusy(false);source=null;draft=[];ctx.status('등록한 도면은 유지됩니다. 자동 구성은 도면 자동 구성을 눌러 다시 시작할 수 있습니다.');}
  $('auto-close').onclick=()=>{dialog.close();cancel();};dialog.addEventListener('cancel',cancel);
  $('auto-from-image').onclick=async()=>{
    targetProject=ctx.getProject();targetFloor=ctx.getFloor();if(!targetFloor.image)return;
    try{const img=await decode(targetFloor.image.src);source=imageCanvas(img);draft=[];dialog.showModal();paint();await analyze();}catch(error){ctx.status(error.message,'error');}
  };
  $('demo-plan').onclick=()=>$('demo-dialog').showModal();
  $('demo-close').onclick=()=>$('demo-dialog').close();
  for(const kind of ['image','pdf'])$('demo-'+kind).onclick=async()=>{
    $('demo-dialog').close();
    try {
      const name=kind==='pdf'?'example-floorplan.pdf':'example-floorplan.png',response=await fetch('/assets/facility-3d/'+name);
      if(!response.ok)throw new Error('예시 도면을 불러오지 못했습니다.');
      const file=new File([await response.blob()],name,{type:kind==='pdf'?'application/pdf':'image/png'});
      if(ctx.onExample(kind))await openFile(file);
    } catch(error){ctx.status(error.message,'error');}
  };
}
