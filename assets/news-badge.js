(function(root) {
  'use strict';
  const validIds=ids=>Array.isArray(ids)&&ids.every(id=>typeof id==='string'&&id.length>0);
  const feeds=['competitor','agency','reputation','trend','support-resources'], latest=new Map(), trackers=new Map(), subscribers=new Set();
  const currentKey=feed=>'vida-news-current-v1:'+feed;
  const dayMs=86_400_000;
  const koreaOffset=9*60*60*1000;
  const todayLabel='오늘 처음 수집되었거나 갱신됨 (한국시간)';
  const koreaDayStart=now=>Math.floor((now+koreaOffset)/dayMs)*dayMs-koreaOffset;
  function isToday(value, now=Date.now()) {
    if(typeof value!=='string')return false;
    const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(value);
    if(!dateOnly&&!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))return false;
    const at=Date.parse(dateOnly?value+'T00:00:00+09:00':value);
    if(!Number.isFinite(at))return false;
    if(dateOnly&&new Date(at+koreaOffset).toISOString().slice(0,10)!==value)return false;
    return koreaDayStart(now)<=at&&at<=now;
  }
  function todayMark(doc, ...dates) {
    const now=Date.now();
    if(!dates.some(date=>isToday(date,now)))return null;
    const mark=doc.createElement('span');
    mark.className='news-new-mark';
    mark.textContent='N';
    mark.title=todayLabel;
    mark.dataset.newsDay=String(koreaDayStart(now));
    mark.setAttribute('role','img');
    mark.setAttribute('aria-label',todayLabel);
    return mark;
  }
  if(root.document?.querySelectorAll&&root.setTimeout) {
    let day=koreaDayStart(Date.now()), timer;
    function syncDay() {
      const now=Date.now(), nextDay=koreaDayStart(now);
      if(day!==nextDay) {
        day=nextDay;
        root.document.querySelectorAll('[data-news-day]').forEach(mark=>{
          if(mark.dataset.newsDay!==String(day))mark.remove();
        });
        root.dispatchEvent(new Event('news-day-change'));
      }
      root.clearTimeout(timer);
      timer=root.setTimeout(syncDay,day+dayMs-now);
    }
    root.addEventListener('pageshow',syncDay);
    root.document.addEventListener('visibilitychange',()=>{if(!root.document.hidden)syncDay();});
    syncDay();
  }
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
    // This browser only. The site password is shared, so seen state is not an account and is not stored on the server.
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
  function create(feed,{detail=false}={}) {
    const tracker=trackerFor(feed);
    return {update(ids) {
      if(!validIds(ids))return;
      latest.set(feed,[...new Set(ids)]);
      try{storage()?.setItem(currentKey(feed),JSON.stringify(latest.get(feed)));}catch{}
      if(detail&&!root.document.hidden)tracker.mark(ids);
      publish();
    }};
  }
  if(typeof root.addEventListener==='function'){
    root.addEventListener('storage',event=>{if(event.key===null||event.key?.startsWith('vida-news-'))publish();});
    root.addEventListener('pageshow',publish);
  }
  const api={create,createTracker,counts,subscribe,isToday,todayMark,todayLabel};
  root.NewsBadge=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
