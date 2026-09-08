(function(root){
  'use strict';
  const clean=value=>String(value??'').toLocaleLowerCase().replace(/\s+/g,' ').trim();
  function filterFacilities(rows,filters){
    const q=clean(filters.query);
    return rows.filter(r=>r.branch===filters.branch && Number.isFinite(r.distanceKm) && r.distanceKm<=filters.radius && (!filters.kind||r.kind===filters.kind) && (!filters.bathOnly||r.bathListed) && (!q||clean(`${r.name} ${r.address} ${r.phone}`).includes(q))).sort((a,b)=>a.distanceKm-b.distanceKm||a.name.localeCompare(b.name,'ko'));
  }
  function csvCell(value){
    let text=String(value??'');
    // Spreadsheet applications must treat exported facility data as text, not formulas.
    if(/^[\s]*[=+@-]/.test(text))text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
  }
  function toCsv(rows){
    const matrix=[['지점','시설유형','시설명','직선거리(km)','주소','공개 전화번호','방문목욕','제공서비스','확인할 사항','출처'],...rows.map(r=>[r.branch,r.kind,r.name,r.distanceKm.toFixed(2),r.address,r.phone,r.bathListed?'공개자료 기재':'미확인',r.services,r.note,r.source])];
    return '\uFEFF'+matrix.map(row=>row.map(csvCell).join(',')).join('\r\n');
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={filterFacilities,toCsv,csvCell};
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);
  let dataset=null,filtered=[],limit=40,map=null,clusterer=null,homeOverlay=null,radiusCircle=null,infoWindow=null,selectedMarker=null,mapPromise=null,selectedId=null;
  const filters=()=>({branch:$('branch').value,kind:$('kind').value,radius:Number($('radius').value),query:$('query').value,bathOnly:$('bath-only').checked});
  const branch=()=>dataset.branches.find(b=>b.id===$('branch').value);
  function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
  function safeLink(text,url){const a=node('a',text);const u=new URL(url,location.origin);if(!['https:','http:','tel:'].includes(u.protocol))return a;a.href=u.href;if(u.protocol!=='tel:'){a.target='_blank';a.rel='noopener noreferrer';}return a;}
  function selectedCard(r,moveMap=true){
    selectedId=r.id;
    const panel=$('selected-detail');panel.replaceChildren(node('h2',r.name),node('p',`${r.kind} · 직선거리 ${r.distanceKm.toFixed(2)}km`),node('p',r.address),node('p',r.services),node('p',r.note));
    const actions=node('div',undefined,'detail-actions');
    if(r.phone)actions.append(safeLink(r.phone,'tel:'+r.phone.replace(/[^\d+]/g,'')));
    actions.append(safeLink('카카오맵에서 보기',`https://map.kakao.com/link/map/${encodeURIComponent(r.name)},${r.lat},${r.lng}`),safeLink('자료 출처',r.source));
    if(r.extraSource)actions.append(safeLink('서비스 보조 출처',r.extraSource));
    panel.append(actions);
    document.querySelectorAll('.facility-select').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.id===r.id)));
    if(!map)return;
    const point=new kakao.maps.LatLng(r.lat,r.lng);
    if(selectedMarker)selectedMarker.setMap(null);
    selectedMarker=new kakao.maps.Marker({position:point,map,zIndex:20});
    const popup=node('div',undefined,'popup');popup.append(node('strong',r.name),node('span',`${r.kind} · ${r.distanceKm.toFixed(2)}km`));
    infoWindow.setContent(popup);infoWindow.open(map,selectedMarker);
    if(moveMap){map.setLevel(4);map.panTo(point);}
  }
  function resetSelection(){
    selectedId=null;
    if(selectedMarker){selectedMarker.setMap(null);selectedMarker=null;}
    if(infoWindow)infoWindow.close();
    $('selected-detail').replaceChildren(node('h2','시설을 선택해 주세요'),node('p','지도 마커나 목록을 누르면 주소, 연락처와 자료 출처를 볼 수 있습니다.'));
  }
  function renderList(){
    const list=$('facility-list');list.replaceChildren();
    if(!filtered.length)list.append(node('li','조건에 맞는 시설이 없습니다. 검색어나 필터를 바꿔보세요.','empty'));
    const fragment=document.createDocumentFragment();
    for(const r of filtered.slice(0,limit)){
      const li=node('li',undefined,'facility-item'),button=node('button',undefined,'facility-select');button.type='button';button.dataset.id=r.id;button.setAttribute('aria-pressed',String(r.id===selectedId));
      const meta=node('span',undefined,'facility-meta');meta.append(node('span',r.kind,'badge'),node('span',r.distanceKm.toFixed(2)+'km'));
      button.append(meta,node('strong',r.name),node('span',r.address,'facility-address'));button.addEventListener('click',()=>selectedCard(r));li.append(button);fragment.append(li);
    }
    list.append(fragment);$('load-more').hidden=limit>=filtered.length;
    $('load-more').textContent=`더 보기 (${Math.min(limit,filtered.length)} / ${filtered.length})`;
  }
  function showRange(){
    if(!map||!dataset)return;
    const b=branch(),center=new kakao.maps.LatLng(b.lat,b.lng),km=Number($('radius').value);
    radiusCircle.setPosition(center);radiusCircle.setRadius(km*1000);
    homeOverlay.setPosition(center);homeOverlay.setContent(node('div',b.name,'branch-marker'));
    const bounds=new kakao.maps.LatLngBounds();
    bounds.extend(new kakao.maps.LatLng(b.lat-km/111.2,b.lng-km/(111.2*Math.cos(b.lat*Math.PI/180))));
    bounds.extend(new kakao.maps.LatLng(b.lat+km/111.2,b.lng+km/(111.2*Math.cos(b.lat*Math.PI/180))));
    map.setBounds(bounds,30,30,30,30);
  }
  function renderMarkers(){
    if(!map)return;
    clusterer.clear();
    const markers=filtered.map(r=>{const marker=new kakao.maps.Marker({position:new kakao.maps.LatLng(r.lat,r.lng),title:r.name});kakao.maps.event.addListener(marker,'click',()=>selectedCard(r));return marker;});
    clusterer.addMarkers(markers);
  }
  function update(recenter=false){
    if(!dataset)return;
    filtered=filterFacilities(dataset.facilities,filters());limit=40;resetSelection();renderList();renderMarkers();if(recenter)showRange();
    const b=branch();$('branch-name').textContent=b.name;$('branch-address').textContent=b.address;
    $('result-count').textContent=`직선 ${$('radius').value}km 이내 · ${filtered.length.toLocaleString('ko-KR')}건`;
    $('download').disabled=!filtered.length;
  }
  async function getJson(url){const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Request failed');return response.json();}
  function loadSdk(key){
    return new Promise((resolve,reject)=>{
      const script=document.createElement('script');let done=false;
      const timer=setTimeout(()=>finish(new Error('Map timeout')),20000);
      function finish(error){if(done)return;done=true;clearTimeout(timer);if(error){script.remove();reject(error);}else resolve();}
      script.src=`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false&libraries=clusterer`;
      script.onerror=()=>finish(new Error('Map unavailable'));
      script.onload=()=>{if(!root.kakao?.maps?.load)return finish(new Error('Map unavailable'));root.kakao.maps.load(()=>finish());};
      document.head.append(script);
    });
  }
  async function startMap(){
    if(mapPromise)return mapPromise;
    $('retry-map').hidden=true;$('map-status').textContent='카카오맵을 불러오고 있습니다.';
    mapPromise=(async()=>{
      const config=await getJson('/api/maps-config');await loadSdk(config.kakaoJavascriptKey);
      const b=branch();map=new kakao.maps.Map($('map'),{center:new kakao.maps.LatLng(b.lat,b.lng),level:7});
      map.addControl(new kakao.maps.ZoomControl(),kakao.maps.ControlPosition.RIGHT);
      clusterer=new kakao.maps.MarkerClusterer({map,averageCenter:true,minLevel:6});
      homeOverlay=new kakao.maps.CustomOverlay({map,zIndex:10,yAnchor:1.4});
      radiusCircle=new kakao.maps.Circle({map,center:new kakao.maps.LatLng(b.lat,b.lng),radius:5000,strokeWeight:2,strokeColor:'#2874c6',strokeOpacity:.65,strokeStyle:'dash',fillColor:'#3a83cd',fillOpacity:.06});
      infoWindow=new kakao.maps.InfoWindow({removable:true,zIndex:21});
      $('map-message').hidden=true;renderMarkers();showRange();
      new ResizeObserver(()=>{if(map){const center=map.getCenter();map.relayout();map.setCenter(center);}}).observe($('map'));
    })().catch(()=>{map=null;clusterer=null;homeOverlay=null;radiusCircle=null;infoWindow=null;selectedMarker=null;$('map').replaceChildren();$('map-message').hidden=false;$('map-status').textContent='지도를 불러오지 못했습니다. 시설목록과 카카오맵 링크는 이용할 수 있습니다.';$('retry-map').hidden=false;}).finally(()=>{mapPromise=null;});
    return mapPromise;
  }
  async function start(){
    try{
      dataset=await getJson('/api/nearby-facilities');
      if(!Array.isArray(dataset.facilities)||!dataset.branches?.length)throw new Error('Invalid data');
      $('data-error').hidden=true;
      for(const b of dataset.branches){const option=node('option',b.name);option.value=b.id;$('branch').append(option);}
      for(const kind of [...new Set(dataset.facilities.map(r=>r.kind))]){const option=node('option',kind);option.value=kind;$('kind').append(option);}
      $('branch').disabled=false;$('kind').disabled=false;
      update(true);await startMap();
    }catch{$('data-error').hidden=false;$('map-status').textContent='시설목록을 불러오지 못했습니다.';}
  }
  $('branch').addEventListener('change',()=>update(true));$('radius').addEventListener('change',()=>update(true));
  $('kind').addEventListener('change',()=>update());$('bath-only').addEventListener('change',()=>update());
  let debounce;$('query').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>update(),150);});
  $('reset-view').addEventListener('click',showRange);$('retry-map').addEventListener('click',startMap);
  $('retry-data').addEventListener('click',()=>location.reload());
  $('load-more').addEventListener('click',()=>{limit+=40;renderList();});
  $('download').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([toCsv(filtered)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`더비다_${$('branch').value}_영업후보_${dataset.asOf}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  start();
})(typeof window==='undefined'?globalThis:window);
