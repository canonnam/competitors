(function(root) {
  'use strict';
  const validIds=ids=>Array.isArray(ids)&&ids.every(id=>typeof id==='string'&&id.length>0);
  function createTracker(feed,storage) {
    const key='vida-news-seen-v1:'+feed;
    let memory=new Set();
    function read() {
      try {const ids=JSON.parse(storage.getItem(key)||'[]');if(validIds(ids))memory=new Set([...memory,...ids]);}catch{}
      return memory;
    }
    return {
      key,
      unread(ids) {const seen=read();return validIds(ids)?[...new Set(ids)].filter(id=>!seen.has(id)).length:0;},
      mark(ids) {
        if(!validIds(ids))return;
        memory=new Set([...read(),...ids]);
        try {storage.setItem(key,JSON.stringify([...memory]));}catch{}
      }
    };
  }
  function create(feed,{badge,detail=false}) {
    let storage;
    try {storage=root.localStorage;}catch{}
    const tracker=createTracker(feed,storage);
    let current=[];
    function draw() {
      if(!badge)return;
      const count=tracker.unread(current);
      badge.hidden=count===0;
      badge.title=`새로 수집된 글 ${count}건 · 뉴스 페이지를 확인하면 표시가 사라집니다`;
      badge.setAttribute('aria-label',`새로 수집된 글 ${count}건`);
    }
    root.addEventListener('storage',event=>{if(event.key===tracker.key||event.key===null)draw();});
    root.addEventListener('pageshow',draw);
    return {update(ids) {
      if(!validIds(ids))return;
      current=ids;
      if(detail&&!root.document.hidden)tracker.mark(ids);
      draw();
    }};
  }
  root.NewsBadge={create,createTracker};
  if(typeof module!=='undefined'&&module.exports)module.exports={create,createTracker};
})(globalThis);
