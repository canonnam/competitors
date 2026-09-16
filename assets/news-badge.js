(function(root) {
  'use strict';
  const validIds=ids=>Array.isArray(ids)&&ids.every(id=>typeof id==='string'&&id.length>0);
  const feeds=['competitor','agency','reputation'], latest=new Map(), trackers=new Map(), subscribers=new Set();
  const currentKey=feed=>'vida-news-current-v1:'+feed;
  function storage(){try{return root.localStorage;}catch{return undefined;}}
  function trackerFor(feed){if(!trackers.has(feed))trackers.set(feed,createTracker(feed,storage()));return trackers.get(feed);}
  function currentIds(feed){
    try{const saved=JSON.parse(storage()?.getItem(currentKey(feed))||'null');if(validIds(saved))latest.set(feed,saved);}catch{}
    return latest.get(feed)||[];
  }
  function counts(){return Object.fromEntries(feeds.map(feed=>[feed,trackerFor(feed).unread(currentIds(feed))]));}
  function publish(){const state=counts();subscribers.forEach(callback=>callback(state));}
  function subscribe(callback){subscribers.add(callback);callback(counts());return ()=>subscribers.delete(callback);}
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
    const tracker=trackerFor(feed);
    let current=[];
    function draw() {
      const count=tracker.unread(current);
      if(badge){
        badge.hidden=count===0;
        badge.title=`새로 수집된 글 ${count}건 · 뉴스 페이지를 확인하면 표시가 사라집니다`;
        badge.setAttribute('aria-label',`새로 수집된 글 ${count}건`);
      }
      publish();
    }
    root.addEventListener('storage',event=>{if(event.key===tracker.key||event.key===null)draw();});
    root.addEventListener('pageshow',draw);
    return {update(ids) {
      if(!validIds(ids))return;
      current=ids;
      latest.set(feed,[...new Set(ids)]);
      try{storage()?.setItem(currentKey(feed),JSON.stringify(latest.get(feed)));}catch{}
      if(detail&&!root.document.hidden)tracker.mark(ids);
      draw();
    }};
  }
  if(typeof root.addEventListener==='function')root.addEventListener('storage',event=>{if(event.key===null||event.key?.startsWith('vida-news-'))publish();});
  root.NewsBadge={create,createTracker,counts,subscribe};
  if(typeof module!=='undefined'&&module.exports)module.exports={create,createTracker,counts,subscribe};
})(globalThis);
