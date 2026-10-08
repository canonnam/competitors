/* Passwords are verified by the server and are never saved in browser storage. */
const form=document.getElementById('map-access-form'),button=document.getElementById('map-access-submit'),error=document.getElementById('map-access-error');
form.addEventListener('submit',async event=>{
  event.preventDefault();button.disabled=true;error.hidden=true;
  const field=document.getElementById('map-access-password'),password=field.value;
  field.value='';
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch('/api/site-access/session',{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'비밀번호를 확인하지 못했습니다.');
    location.reload();
  }catch(e){error.textContent=e.name==='AbortError'?'응답이 지연되고 있습니다. 다시 시도해주세요.':e.message;error.dataset.status='error';error.hidden=false;field.focus();}
  finally{clearTimeout(timeout);button.disabled=false;}
});
