/* Fetch only authenticated totals, never applicant details. No browser storage. */
(function(root,factory) {
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root.document?.body.classList.contains('kb-homepage'))api.start(root,root.HomeDashboard);
})(typeof window==='undefined'?globalThis:window,function() {
  'use strict';
  function start(win,dashboard) {
    if(!dashboard)return;
    let controller=null;
    async function refresh() {
      if(win.document.hidden||controller)return;
      const request=new win.AbortController();controller=request;
      const timeout=win.setTimeout(()=>request.abort(),15000);
      dashboard.update('requests',null);
      try {
        const response=await win.fetch('/api/support/website-requests/summary',{
          credentials:'same-origin',cache:'no-store',signal:request.signal
        });
        if(controller!==request)return;
        if(response.status===401) {dashboard.update('requests',null,{locked:true});return;}
        if(!response.ok)throw new Error('request');
        const data=await response.json();
        if(controller!==request)return;
        const valid=group=>group&&Object.values(group).every(value=>Number.isInteger(value)&&value>=0);
        if(data.environment!=='production'||!valid(data.counts)||!valid(data.kinds)||
          !['new','contacted','completed','archived'].every(key=>Number.isInteger(data.counts[key]))||
          !['visit','trial','pricing'].every(key=>Number.isInteger(data.kinds[key]))||
          !Number.isInteger(data.total)||data.total!==Object.values(data.counts).reduce((sum,n)=>sum+n,0)||
          data.total!==Object.values(data.kinds).reduce((sum,n)=>sum+n,0))throw new Error('format');
        dashboard.update('requests',data);
      } catch (_) {
        if(controller===request)dashboard.fail('requests');
      } finally {
        win.clearTimeout(timeout);
        if(controller===request)controller=null;
      }
    }
    function clear() {
      const previous=controller;controller=null;previous?.abort();
      dashboard.update('requests',null);
    }
    win.addEventListener('pagehide',clear);
    win.addEventListener('pageshow',refresh);
    win.addEventListener('focus',refresh);
    win.document.addEventListener('visibilitychange',()=>win.document.hidden?clear():refresh());
    win.document.addEventListener('click',event=>{
      if(event.target.closest('[data-dash-refresh="requests"]'))refresh();
    });
    win.setInterval(refresh,60000);
    refresh();
    return {refresh,clear};
  }
  return {start};
});
