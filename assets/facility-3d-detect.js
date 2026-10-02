/* Conservative raster room proposals and spatial label mapping. No network calls. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FacilityDetect=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  function detect(image,options={}) {
    const {width:w,height:h,data}=image,n=w*h;
    if(!Number.isInteger(w)||!Number.isInteger(h)||w<16||h<16||w>900||h>900||data.length!==n*4)throw new Error('분석 이미지 크기를 확인해주세요.');
    const dark=new Uint8Array(n),horizontal=new Uint8Array(n),vertical=new Uint8Array(n);
    const threshold=options.threshold??170,minRun=Math.max(12,Math.round(Math.min(w,h)*0.045));
    const gap=Math.max(0,Math.round(Math.max(w,h)*(options.gap??0.035)));
    for(let i=0;i<n;i++) {
      const a=data[i*4+3]/255;
      dark[i]=(data[i*4]*0.299+data[i*4+1]*0.587+data[i*4+2]*0.114)*a+255*(1-a)<threshold?1:0;
    }
    // Remove short marks (most letters), retaining horizontal/vertical wall segments.
    function lines(length,count,stride,offsetFor,output) {
      for(let line=0;line<count;line++) {
        const offset=offsetFor(line);let start=-1;
        for(let p=0;p<=length;p++) {
          if(p<length&&dark[offset+p*stride]){if(start<0)start=p;}
          else if(start>=0){if(p-start>=minRun)for(let q=start;q<p;q++)output[offset+q*stride]=1;start=-1;}
        }
        let end=-1;
        for(let p=0;p<length;p++)if(output[offset+p*stride]) {
          if(end>=0&&p-end-1<=gap)for(let q=end+1;q<p;q++)output[offset+q*stride]=1;
          end=p;
        }
      }
    }
    lines(w,h,1,row=>row*w,horizontal);lines(h,w,w,col=>col,vertical);
    const walls=new Uint8Array(n);
    for(let i=0;i<n;i++)if(horizontal[i]||vertical[i]) {
      walls[i]=1;const x=i%w,y=Math.floor(i/w);
      if(x>0)walls[i-1]=1;if(x<w-1)walls[i+1]=1;if(y>0)walls[i-w]=1;if(y<h-1)walls[i+w]=1;
    }
    const visited=new Uint8Array(n),queue=new Int32Array(n),regions=[];
    for(let seed=0;seed<n;seed++) {
      if(walls[seed]||visited[seed])continue;
      let head=0,tail=1,count=0,minX=w,minY=h,maxX=0,maxY=0,edge=false;queue[0]=seed;visited[seed]=1;
      while(head<tail) {
        const p=queue[head++],x=p%w,y=Math.floor(p/w);count++;
        minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        if(x===0||y===0||x===w-1||y===h-1)edge=true;
        const add=q=>{if(!walls[q]&&!visited[q]){visited[q]=1;queue[tail++]=q;}};
        if(x>0)add(p-1);if(x<w-1)add(p+1);if(y>0)add(p-w);if(y<h-1)add(p+w);
      }
      const rw=maxX-minX+1,rh=maxY-minY+1;
      if(!edge&&count>=n*0.0035&&rw>=w*0.025&&rh>=h*0.025&&count/(rw*rh)>=0.72)
        regions.push({left:minX/w,top:minY/h,width:rw/w,height:rh/h,area:count/n});
    }
    // Furniture outlines inside a room must not become overlapping rooms.
    const kept=[];
    regions.sort((a,b)=>b.area-a.area).forEach(r=>{
      if(!kept.some(k=>Math.min(k.left+k.width,r.left+r.width)>Math.max(k.left,r.left)&&Math.min(k.top+k.height,r.top+r.height)>Math.max(k.top,r.top)))kept.push(r);
    });
    const overflow=kept.length>40;
    kept.sort((a,b)=>Math.abs(a.top-b.top)<0.03?a.left-b.left:a.top-b.top);
    return {regions:kept.slice(0,40),overflow};
  }
  function labelInfo(raw,correct=false) {
    const name=String(raw||'').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,40);
    const compact=name.replace(/\s/g,'');
    if(!compact||compact.length>25||/^[\d.,×xX+\-\s]+$/.test(compact)||/(축척|평면도|배치도|면적|설계|SCALE|㎡|\bmm\b)/i.test(name))return null;
    const rules=[['core',/계단|승강기|엘리베이터|ELEV|STAIR/i],['corridor',/복도|CORRIDOR/i],
      ['program',/프로그램|PROGRAM/i],['kitchen',/주방|조리실|KITCHEN/i],['lounge',/휴게|LOUNGE/i],
      ['changing',/탈의|LOCKER/i],['garden',/^(?:(?:옥상|실내|야외|외부)?정원|GARDEN)$/i],
      ['therapy',/물리치료|작업치료|PHYSIOTHERAPY/i],['nursing',/간호|보건|NURSING/i],
      ['service',/화장실|욕실|세탁|창고|물품|기계실|전기실|TOILET/i],
      ['office',/사무|상담|원장|회의|OFFICE/i],['living',/생활실|침실|병실|\d{1,4}호|BEDROOM/i],
      ['common',/식당|치료|면회|로비|강당|홀|DINING|LOBBY/i]];
    for(const [type,pattern]of rules)if(pattern.test(compact))return {name,type,rank:3};
    if(correct&&/^[가-힣]{3,8}$/.test(compact)) {
      const known=['상담실','사무실','원장실','회의실','간호실','간호사실','생활실','프로그램실','물리치료실','휴게실','탈의실','정원','주방','면회실','화장실','세탁실','조리실','기계실','전기실'];
      const distance=(a,b)=>{let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}return row[b.length];};
      const near=known.filter(word=>distance(compact,word)===1);
      if(near.length===1)return {...labelInfo(near[0]),original:name};
    }
    if(/[가-힣]{2,}(실|방|관)$/.test(compact)||/^ROOM\s*\d+/i.test(name))return {name,type:'unknown',rank:1};
    return null;
  }
  function mapLabels(regions,labels) {
    return regions.map((region,i)=>{
      const matches=labels.map(label=>({label,info:labelInfo(label.text,label.confidence<95)})).filter(({label,info})=>info&&label.confidence>=45&&label.x>=region.left&&label.x<=region.left+region.width&&label.y>=region.top&&label.y<=region.top+region.height);
      matches.sort((a,b)=>b.info.rank-a.info.rank||b.info.name.length-a.info.name.length||b.label.confidence-a.label.confidence);
      const best=matches[0];
      return {...region,name:best?best.info.name:'공간 '+(i+1),type:best?best.info.type:'unknown',named:!!best,original:best?.info.original};
    });
  }
  function projectRooms(regions,project,aspect,uid) {
    let width=project.width,depth=width/aspect;
    if(depth>project.depth){depth=project.depth;width=depth*aspect;}
    return regions.map(r=>({id:uid(),name:r.name,type:r.type,beds:0,x:(r.left+r.width/2-0.5)*width,z:(r.top+r.height/2-0.5)*depth,w:r.width*width,d:r.height*depth})).filter(r=>r.w>=0.5&&r.d>=0.5);
  }
  return {detect,labelInfo,mapLabels,projectRooms};
});
