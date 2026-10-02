/* Dialog feedback and the site's shared, keyboard-accessible information tooltip. */
export function initFacilityUI(){
  const $=id=>document.getElementById(id),tips=[];
  for(const key of ['collection','floor']){
    const button=$(key+'-help-button'),panel=$(key+'-help-tooltip');
    let pinned=false,timer;
    function hide(){clearTimeout(timer);pinned=false;panel.hidden=true;button.setAttribute('aria-expanded','false');}
    function show(){
      clearTimeout(timer);panel.hidden=false;button.setAttribute('aria-expanded','true');
      const a=button.getBoundingClientRect(),p=panel.getBoundingClientRect(),w=document.documentElement.clientWidth,h=window.innerHeight;
      panel.style.left=Math.max(12,Math.min(a.left,w-p.width-12))+'px';
      const top=a.bottom+8+p.height<=h-12?a.bottom+8:a.top-p.height-8;
      panel.style.top=Math.max(12,Math.min(top,h-p.height-12))+'px';
    }
    function leave(){clearTimeout(timer);if(!pinned)timer=setTimeout(hide,180);}
    button.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse')show();});
    button.addEventListener('pointerleave',leave);
    button.addEventListener('focus',show);button.addEventListener('blur',hide);
    button.addEventListener('click',()=>{if(pinned)hide();else{pinned=true;show();}});
    panel.addEventListener('pointerenter',()=>clearTimeout(timer));panel.addEventListener('pointerleave',leave);
    document.addEventListener('pointerdown',e=>{if(!button.contains(e.target)&&!panel.contains(e.target))hide();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();});
    window.addEventListener('resize',hide);
    window.addEventListener('scroll',e=>{if(!panel.contains(e.target))hide();},true);
    tips.push(hide);
  }
  return {notify(message,error=false){
    tips.forEach(hide=>hide());
    $('save-result-title').textContent=error?'저장하지 못했습니다':'저장했습니다';
    $('save-result-message').textContent=message;
    $('save-result-message').dataset.status=error?'error':'success';
    if(!$('save-result-dialog').open)$('save-result-dialog').showModal();
  }};
}
