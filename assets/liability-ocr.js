/* Reuse the site's bundled PDF.js and Korean OCR, without external document APIs. */
async function canvasForImage(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('이미지를 읽지 못했습니다.'));image.src=url;});
    const scale=Math.min(1,2200/Math.max(img.width,img.height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);return canvas;
  }finally{URL.revokeObjectURL(url);}
}
export async function extract(file,progress){
  let worker=null,pdf=null,task=null;
  async function ocr(canvas){
    if(!window.Tesseract){await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/assets/vendor/tesseract/dist/tesseract.min.js';script.onload=resolve;script.onerror=()=>reject(new Error('글자 인식 도구를 불러오지 못했습니다.'));document.head.append(script);});}
    if(!worker)worker=await window.Tesseract.createWorker(['kor','eng'],1,{workerPath:'/assets/vendor/tesseract/dist/worker.min.js',corePath:'/assets/vendor/tesseract/core',langPath:'/assets/vendor/tesseract/tessdata',workerBlobURL:false,gzip:true});
    const {data}=await worker.recognize(canvas);return data.text;
  }
  try{
    if(file.type!=='application/pdf')return await ocr(await canvasForImage(file));
    const lib=await import('/assets/vendor/pdfjs/build/pdf.mjs');lib.GlobalWorkerOptions.workerSrc='/assets/vendor/pdfjs/build/pdf.worker.mjs';
    task=lib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,cMapUrl:'/assets/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/vendor/pdfjs/standard_fonts/',wasmUrl:'/assets/vendor/pdfjs/wasm/'});
    task.onPassword=()=>task.destroy();pdf=await task.promise;
    if(pdf.numPages>20)throw new Error('자동 추출은 20페이지까지 지원합니다. 보험 정보를 직접 입력하거나 필요한 페이지만 선택한 PDF를 업로드해주세요.');
    const texts=[];
    for(let i=1;i<=pdf.numPages;i++){
      progress(`증서 ${i}/${pdf.numPages}페이지를 읽고 있습니다.`);
      const page=await pdf.getPage(i),content=await page.getTextContent();
      let text=content.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('');
      if(text.replace(/\s/g,'').length<80){
        const size=page.getViewport({scale:1}),view=page.getViewport({scale:2200/Math.max(size.width,size.height)}),canvas=document.createElement('canvas');canvas.width=Math.ceil(view.width);canvas.height=Math.ceil(view.height);
        await page.render({canvasContext:canvas.getContext('2d'),viewport:view,background:'#fff'}).promise;text=await ocr(canvas);
      }
      texts.push(text);page.cleanup();
    }
    return texts.join('\n');
  }finally{if(worker)await worker.terminate();if(task)await task.destroy();}
}
