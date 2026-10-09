/* Reuse the saved map and renderer in the dashboard without mounting its editor. */
(function(win){
  const doc=win.document,readOnly=new URLSearchParams(win.location.search).get('viewer')==='dashboard';
  let visible=true;
  if(readOnly)doc.documentElement.classList.add('f3-readonly');
  if(readOnly)doc.addEventListener('DOMContentLoaded',()=>{
    const status=doc.getElementById('project-status');
    if(!status.dataset.viewerReady){status.textContent='시설 도면을 불러오는 중입니다.';status.dataset.viewerReady='true';status.hidden=false;}
  });
  const expanded=()=>!!doc.fullscreenElement||doc.querySelector('.f3-viewer.is-expanded')!==null;
  win.FacilityViewer={readOnly,active:()=>!doc.hidden&&(visible||expanded()),setExpanded(open){
    if(readOnly&&win.parent!==win)win.parent.postMessage({type:'facility-viewer-expanded',open},win.location.origin);
  },prepare(){
    if(!readOnly)return;
    doc.body.classList.add('ui-standalone');
    const row=doc.querySelector('.f3-project-row');
    row.append(doc.getElementById('collection-help-button'),doc.getElementById('collection-help-tooltip'));
    for(const node of doc.querySelectorAll('.kb-header,.kb-page-heading,.f3-panel,.f3-floor-tools,.f3-more,dialog,#save-project,#undo-project,#drawing-controls')){
      node.hidden=true;node.inert=true;
      for(const control of node.querySelectorAll('button,input,select,textarea'))control.disabled=true;
    }
    doc.querySelector('[data-mode="plan"]').textContent='평면 보기';
    if(win.parent!==win){
      const report=()=>{if(!expanded())win.parent.postMessage({type:'facility-viewer-size',height:Math.ceil(doc.querySelector('.facility3d-main').getBoundingClientRect().height)},win.location.origin);};
      new ResizeObserver(report).observe(doc.querySelector('.facility3d-main'));
      doc.addEventListener('fullscreenchange',report);
      win.addEventListener('message',event=>{
        if(event.origin!==win.location.origin||event.source!==win.parent||event.data?.type!=='facility-viewer-visibility')return;
        visible=event.data.visible===true;
      });
      report();
    }
  }};
})(window);
