import {initImport} from './facility-3d-import.js?v=20261001-auto1';
import {initObservation} from './facility-observation.js?v=20261002-1';
/* Browser-local facility composition and Three.js building viewer. */
const M = window.FacilityModel;
const $ = id => document.getElementById(id);
const STORAGE = 'vida-facility-3d-v1';
let projects = [], loadError = '';
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE) || 'null');
  if (saved) {
    if(saved.version!==1 || !Array.isArray(saved.projects) || saved.projects.length>8) throw new Error('format');
    projects=saved.projects.map(M.validate);
  }
} catch { loadError='저장된 도면을 불러오지 못했습니다. 예시 건물로 시작합니다. 기존 저장 파일은 그대로 보관됩니다.'; }
let project = projects[0] ? structuredClone(projects[0]) : M.sample(), selectedFloor = 1, selectedRoom = null, mode = 'building', dirty = false;
let drawing = false, startPoint = null, downPoint = null, showNames = true, showWalls = true;
let THREE, OrbitControls, renderer, scene, camera, controls, root, grid, raycaster, preview;
let floorGroups = [], pickTargets = [], labelSprites = [], generation = 0, needsRender = true;
let fallback = false, fallbackCanvas = null, fallbackRevision = 0;
let observation=null,observationAnchors=[];
const canvas = $('space-canvas'), viewport = $('viewport');
const floor = () => project.floors[selectedFloor-1];
const currentRoom = () => floor().rooms.find(r=>r.id===selectedRoom);
function status(message,kind='') {
  $('project-status').textContent=message;
  if(kind) $('project-status').dataset.status=kind; else delete $('project-status').dataset.status;
}
function markDirty() {dirty=true;$('save-project').textContent='저장';}
function make(tag,className,text) {
  const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;
}
function renderUI() {
  const options=projects.some(p=>p.id===project.id)?projects.map(p=>p.id===project.id?project:p):[project,...projects];
  $('project-select').replaceChildren(...options.map(p=>{const option=make('option','',p.name);option.value=p.id;return option;}));
  $('project-select').value=project.id;
  const rooms=project.floors.reduce((n,f)=>n+f.rooms.length,0);
  $('project-summary').textContent=`${project.floors.length}개 층 · ${rooms}개 공간 · ${project.scale==='entered'?'입력 치수':'추정 크기'}${project.nursingHomeId?' · ERP '+(project.nursingHomeId===2?'안양점':'인천점'):''}`;
  $('floor-count').textContent=project.floors.length+'개 층';
  $('floor-list').replaceChildren(...[...project.floors].reverse().map(f=>{
    const button=make('button','f3-floor-button');button.type='button';button.dataset.level=f.level;
    button.setAttribute('aria-pressed',String(f.level===selectedFloor));
    button.setAttribute('aria-label',`${f.level}층 ${f.name}, 공간 ${f.rooms.length}개`);
    const info=make('span','f3-floor-info');info.append(make('strong','',f.name),make('small','',`공간 ${f.rooms.length}개${f.image?' · 도면 등록':''}`));
    const targets=observation?.mapped().items.filter(r=>r.level===f.level)||[];
    if(targets.length){const counts=`집중 ${targets.filter(r=>r.risk_tier==='focus').length} · 주의 ${targets.filter(r=>r.risk_tier==='watch').length}`;info.append(make('small','f3-floor-risk',counts));button.setAttribute('aria-label',`${f.level}층 ${f.name}, 공간 ${f.rooms.length}개, ${counts}`);}
    button.append(make('span','f3-floor-number',f.level+'F'),info);return button;
  }));
  $('rooms-heading').textContent=selectedFloor+'층 공간';
  $('room-list').replaceChildren(...floor().rooms.map(r=>{
    const button=make('button','f3-room-button');button.type='button';button.dataset.room=r.id;button.setAttribute('aria-pressed',String(r.id===selectedRoom));
    const dot=make('span','f3-room-dot');dot.style.setProperty('--room-color',M.COLORS[r.type]);dot.setAttribute('aria-hidden','true');
    button.append(dot,make('span','',r.name),make('small','',M.TYPES[r.type]));return button;
  }));
  if(!floor().rooms.length) $('room-list').append(make('p','f3-small','공간 추가를 눌러 생활실·복도·공용공간을 지정하세요.'));
  const room=currentRoom();$('room-details').hidden=!room;
  if(room) {
    $('room-name').value=room.name;$('room-type').value=room.type;$('room-beds').value=room.beds;
    $('beds-field').hidden=room.type!=='living';
    $('room-size').textContent=`${room.w.toFixed(1)} × ${room.d.toFixed(1)}m · ${(room.w*room.d).toFixed(1)}㎡ (${project.scale==='entered'?'입력 치수 기준':'추정 크기 기준'})`;
  }
  $('floor-name').value=floor().name;
  $('image-status').textContent=floor().image?floor().image.name:'등록한 이미지 없음';
  $('remove-image').hidden=!floor().image;$('auto-from-image').disabled=!floor().image;
  document.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===mode)));
  const titles={building:'건물 전체',exploded:'층별 펼치기',floor:selectedFloor+'층 · '+floor().name,plan:selectedFloor+'층 평면 편집'};
  $('view-title').textContent=titles[mode];
  $('view-description').textContent=mode==='building'?`${project.floors.length}개 층을 함께 살펴보세요.`:mode==='exploded'?'층 사이를 띄워 내부 공간을 비교하세요.':mode==='plan'?'도면을 기준으로 공간을 지정하고 수정하세요.':'공간을 클릭해 이름과 용도를 확인하세요.';
  $('add-room').textContent=drawing?'추가 취소':'공간 추가';
  $('view-help').textContent=drawing?'공간의 첫 모서리와 반대 모서리를 차례로 클릭 · Esc로 취소':mode==='plan'?'드래그로 이동 · 휠로 확대 · 공간을 클릭해 선택':'드래그로 회전 · 휠로 확대 · 오른쪽 드래그로 이동';
  canvas.setAttribute('aria-label',fallback?`${selectedFloor}층 평면 화면. 공간을 클릭하거나 목록에서 선택할 수 있습니다.`:`${project.floors.length}층 건물 ${titles[mode]} 화면. 방향키로 ${mode==='plan'?'이동':'회전'}하고 더하기·빼기로 확대·축소할 수 있습니다. 공간 선택은 목록에서도 가능합니다.`);
  viewport.classList.toggle('is-drawing',drawing);
  observation?.sync();
}
Object.entries(M.TYPES).forEach(([value,label])=>{const option=make('option','',label);option.value=value;$('room-type').append(option);});
function confirmLeave() {return !dirty || window.confirm('저장하지 않은 변경이 있습니다. 다른 건물로 이동할까요?');}
function setProject(next) {
  project=next;selectedFloor=1;selectedRoom=null;dirty=false;cancelDrawing();mode='building';renderUI();rebuild();fitCamera();
}
function save() {
  try {
    const clean=M.validate(project),next=[clean,...projects.filter(p=>p.id!==project.id)];
    if(next.length>8) throw new Error('브라우저에는 최대 8개 건물을 저장할 수 있습니다. 파일로 내보내기를 이용해주세요.');
    localStorage.setItem(STORAGE,JSON.stringify({version:1,projects:next}));
    projects=next;dirty=false;renderUI();
    status('현재 브라우저에 저장했습니다. 다른 기기에서는 내보낸 파일을 열어 사용할 수 있습니다.','success');
  } catch(error) {status(error.message.startsWith('브라우저')?error.message:'브라우저에 저장할 공간이 부족하거나 저장이 차단되어 있습니다. 파일로 내보내기를 이용해주세요.','error');}
}
function cancelDrawing() {
  drawing=false;startPoint=null;
  if(preview){scene?.remove(preview);dispose(preview);preview=null;}
  if(controls) controls.enabled=true;
  needsRender=true;
}
function changeMode(next) {cancelDrawing();mode=next;renderUI();rebuild();fitCamera();}
$('project-select').addEventListener('change',()=>{
  if(!confirmLeave()) {$('project-select').value=project.id;return;}
  const next=projects.find(p=>p.id===$('project-select').value);if(next)setProject(structuredClone(next));
});
$('save-project').onclick=save;
$('edit-project').onclick=()=>{
  $('edit-project-name').value=project.name;$('edit-project-branch').value=project.nursingHomeId??'';$('edit-project-error').textContent='';$('edit-project-dialog').showModal();
};
$('edit-project-cancel').onclick=()=>$('edit-project-dialog').close();
$('edit-project-form').onsubmit=event=>{
  event.preventDefault();const name=$('edit-project-name').value.trim();
  if(!name){$('edit-project-error').textContent='건물 이름을 입력해주세요.';return;}
  project.name=name;project.nursingHomeId=$('edit-project-branch').value?Number($('edit-project-branch').value):null;project.example=false;markDirty();renderUI();rebuild();$('edit-project-dialog').close();status('건물 이름과 ERP 지점을 적용했습니다. 저장을 눌러 보관하세요.');
};
$('new-project').onclick=()=>{
  if(!confirmLeave())return;
  $('new-building-form').reset();$('new-building-error').textContent='';$('new-building-dialog').showModal();
};
$('cancel-building').onclick=()=>$('new-building-dialog').close();
$('new-building-form').onsubmit=event=>{
  event.preventDefault();const data=new FormData(event.currentTarget);
  try {
    const entered=data.get('width')!=='' && data.get('depth')!=='';
    const next=M.blank({name:data.get('name'),count:data.get('count'),width:data.get('width')||24,depth:data.get('depth')||16,scale:entered?'entered':'estimated'});
    next.nursingHomeId=data.get('nursingHomeId')?Number(data.get('nursingHomeId')):null;
    setProject(next);markDirty();$('new-building-dialog').close();changeMode('exploded');
    status(`${next.floors.length}층 건물을 만들었습니다. 층을 선택해 도면 이미지를 등록하거나 공간을 추가하세요.`);
  } catch(error) {$('new-building-error').textContent=error.message;}
};
$('floor-list').onclick=event=>{
  const button=event.target.closest('[data-level]');if(!button)return;
  cancelDrawing();selectedFloor=Number(button.dataset.level);selectedRoom=null;
  if(mode==='building'||mode==='exploded')mode='floor';
  renderUI();rebuild();fitCamera();
};
$('room-list').onclick=event=>{const button=event.target.closest('[data-room]');if(button)selectRoom(selectedFloor,button.dataset.room);};
document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>changeMode(button.dataset.mode));
$('room-type').onchange=()=>{$('beds-field').hidden=$('room-type').value!=='living';};
$('room-form').onsubmit=event=>{
  event.preventDefault();const room=currentRoom();if(!room)return;
  const beds=Number($('room-beds').value);
  if(!Number.isInteger(beds)||beds<0||beds>8){status('침대 수는 0~8 사이의 정수로 입력해주세요.','error');return;}
  room.name=$('room-name').value.trim()||'새 공간';room.type=$('room-type').value;room.beds=room.type==='living'?beds:0;
  project.example=false;markDirty();renderUI();rebuild();status('공간 정보를 적용했습니다. 저장을 눌러 보관하세요.');
};
$('delete-room').onclick=()=>{
  const room=currentRoom();if(!room||!window.confirm(`‘${room.name}’ 공간을 삭제할까요?`))return;
  floor().rooms=floor().rooms.filter(r=>r.id!==room.id);selectedRoom=null;project.example=false;markDirty();renderUI();rebuild();status('공간을 삭제했습니다.');
};
$('apply-floor-name').onclick=()=>{
  floor().name=$('floor-name').value.trim()||selectedFloor+'층';project.example=false;markDirty();renderUI();rebuild();status('층 이름을 적용했습니다.');
};
$('add-room').onclick=()=>{
  if(drawing){cancelDrawing();renderUI();return;}
  if(floor().rooms.length>=40){status('한 층에 공간은 최대 40개까지 구성할 수 있습니다.','error');return;}
  changeMode('plan');drawing=true;if(controls)controls.enabled=false;renderUI();
  status('평면에서 공간의 첫 모서리와 반대 모서리를 차례로 클릭하세요.');
};
$('show-labels').onchange=()=>{showNames=$('show-labels').checked;labelSprites.forEach(s=>s.visible=showNames);needsRender=true;if(fallback)drawFallback();};
$('show-walls').onchange=()=>{showWalls=$('show-walls').checked;rebuild();};
$('reset-view').onclick=fitCamera;
$('fullscreen').onclick=async()=>{
  try {if(document.fullscreenElement)await document.exitFullscreen();else await document.querySelector('.f3-viewer').requestFullscreen();}
  catch {status('이 브라우저에서는 전체 화면을 열 수 없습니다.','error');}
};
document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'전체 화면 닫기':'전체 화면';resize();});
$('export-project').onclick=()=>{
  const blob=new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=(project.name.replace(/[<>:"/\\|?*]/g,'_')||'시설')+'-3D도면.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  status('건물과 층별 도면을 파일로 내보냈습니다.');
};
$('import-project').onclick=()=>$('project-file').click();
$('project-file').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file||!confirmLeave())return;
  try {
    if(file.size>25000000)throw new Error('25MB 이하의 도면 파일을 선택해주세요.');
    const next=M.validate(JSON.parse(await file.text()));next.id=M.uid();setProject(next);markDirty();status('도면 파일을 열었습니다. 저장을 눌러 현재 브라우저에 보관하세요.');
  } catch(error){status(error instanceof SyntaxError?'JSON 도면 파일 형식을 확인해주세요.':error.message,'error');}
};
initImport({model:M,getProject:()=>project,getFloor:floor,status,
  onImage(image,targetProject,targetFloor) {
    if(project!==targetProject)throw new Error('건물이 변경되었습니다. 현재 건물에서 다시 등록해주세요.');
    targetFloor.image=image;project.example=false;markDirty();selectedFloor=targetFloor.level;selectedRoom=null;changeMode('plan');status('도면을 등록했습니다. 자동 구성 초안을 확인하세요.');
  },
  onRooms(rooms,targetProject,targetFloor,replace) {
    if(project!==targetProject)throw new Error('건물이 변경되었습니다. 현재 건물에서 다시 분석해주세요.');
    if(!rooms.length)throw new Error('추가할 공간을 하나 이상 선택해주세요.');
    const next=structuredClone(project);if(replace)next.floors[targetFloor.level-1].rooms=[];
    rooms.forEach(room=>M.addRoom(next,targetFloor.level,room));M.validate(next);
    project=next;selectedFloor=targetFloor.level;selectedRoom=rooms[0].id;markDirty();renderUI();rebuild();status(rooms.length+(replace?'개 공간으로 교체했습니다.':'개 공간을 추가했습니다.')+' 3D에서 배치를 확인하고 저장하세요.','success');
  },
  onExample(kind) {
    if(!confirmLeave())return false;
    setProject(M.blank({name:(kind==='pdf'?'PDF':'이미지')+' 자동 구성 예시',count:1}));markDirty();return true;
  }
});
let deletedProject=null;
$('delete-project').onclick=()=>{
  $('delete-building-name').textContent=`${project.name} · ${project.floors.length}개 층 · ${project.floors.reduce((sum,f)=>sum+f.rooms.length,0)}개 공간`;
  $('delete-building-dialog').showModal();
};
$('cancel-delete-building').onclick=()=>$('delete-building-dialog').close();
$('confirm-delete-building').onclick=()=>{
  try {
    const saved=projects.some(p=>p.id===project.id),next=projects.filter(p=>p.id!==project.id);
    if(saved)localStorage.setItem(STORAGE,JSON.stringify({version:1,projects:next}));
    deletedProject={project:structuredClone(project),saved,dirty,savedSnapshot:saved?structuredClone(projects.find(p=>p.id===project.id)):null};const name=project.name;projects=next;
    setProject(projects.length?structuredClone(projects[0]):M.blank());$('delete-building-dialog').close();$('undo-project').hidden=false;
    status(name+' 건물을 삭제했습니다. 새로고침 전까지 삭제 되돌리기를 사용할 수 있습니다.');
  } catch{status('저장소에 접근할 수 없어 삭제하지 못했습니다.','error');}
};
$('undo-project').onclick=()=>{
  if(!deletedProject||!confirmLeave())return;
  try {
    const old=deletedProject,next=old.saved?[old.savedSnapshot,...projects.filter(p=>p.id!==old.project.id)]:projects;
    if(old.saved){if(next.length>8)throw new Error('저장 건물 수 초과');localStorage.setItem(STORAGE,JSON.stringify({version:1,projects:next}));}
    projects=next;setProject(structuredClone(old.project));dirty=old.dirty;deletedProject=null;$('undo-project').hidden=true;status('삭제한 건물을 복구했습니다.','success');
  } catch{status('복구할 저장 공간이 부족합니다. 다른 건물을 파일로 내보낸 뒤 다시 시도해주세요.','error');}
};
$('remove-image').onclick=()=>{floor().image=null;project.example=false;markDirty();renderUI();rebuild();status('선택 층의 도면 이미지를 제거했습니다. 공간 구성은 유지됩니다.');};
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
observation=initObservation({getProject:()=>project,getFloor:floor,changed:()=>{renderUI();rebuild();},select:(level,id)=>{if(!fallback)mode='floor';selectRoom(level,id);fitCamera();}});
function selectRoom(level,id) {
  selectedFloor=level;selectedRoom=id;renderUI();rebuild();const room=currentRoom();if(room)status(`${level}층 ${room.name} · ${M.TYPES[room.type]}`);
}
function dispose(object) {
  const disposed=new Set();
  object?.traverse(child=>{
    child.geometry?.dispose();
    for(const mat of (Array.isArray(child.material)?child.material:[child.material]).filter(Boolean)) {
      if(disposed.has(mat))continue;disposed.add(mat);mat.map?.dispose();mat.dispose();
    }
  });
}
function box(parent,w,h,d,x,y,z,color,opacity=1) {
  const material=new THREE.MeshStandardMaterial({color,roughness:0.75,metalness:0.04,transparent:opacity<1,opacity});
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;
}
function nameSprite(parent,name,x,y,z) {
  const buffer=document.createElement('canvas');buffer.width=512;buffer.height=100;
  const ctx=buffer.getContext('2d');ctx.font='600 32px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle='rgba(255,255,255,0.90)';ctx.roundRect(6,8,500,84,16);ctx.fill();ctx.fillStyle='#35445b';ctx.fillText(name.length>14?name.slice(0,13)+'…':name,256,50,480);
  const texture=new THREE.CanvasTexture(buffer);texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:true,transparent:true}));
  sprite.position.set(x,y,z);sprite.scale.set(4.3,0.84,1);sprite.visible=showNames;parent.add(sprite);labelSprites.push(sprite);
}
function roomWalls(group,room,height) {
  if(!showWalls||mode==='plan')return;
  const t=0.14,{x,z,w,d}=room,c='#f6f7f8';
  box(group,t,height,d,x-w/2,height/2+0.08,z,c);box(group,t,height,d,x+w/2,height/2+0.08,z,c);
  const entryZ=z<0?z+d/2:z-d/2,backZ=z<0?z-d/2:z+d/2,gap=Math.min(1.25,w*0.45),part=(w-gap)/2;
  box(group,w,height,t,x,height/2+0.08,backZ,c);
  box(group,part,height,t,x-(gap+part)/2,height/2+0.08,entryZ,c);box(group,part,height,t,x+(gap+part)/2,height/2+0.08,entryZ,c);
}
function furnishings(group,room) {
  if(mode==='plan'||room.type==='unknown'||room.type==='corridor')return;
  const furniture=new THREE.Group();group.add(furniture);group=furniture;
  const {w,d,type,beds,name}=room,x=0,z=0;
  if(type==='living') {
    const columns=Math.min(4,Math.max(1,beds)),rows=Math.ceil(beds/columns);
    for(let i=0;i<beds;i++) {
      const bx=x+(i%columns-(columns-1)/2)*Math.min(1.7,(w-0.8)/columns),bz=z+(Math.floor(i/columns)-(rows-1)/2)*2.15;
      box(group,1.08,0.25,2.05,bx,0.37,bz,'#a6b6c6');box(group,1.03,0.2,1.98,bx,0.60,bz,'#fffefd');
      box(group,0.98,0.05,1.15,bx,0.73,bz+0.28,'#bfd1df');box(group,0.74,0.1,0.38,bx,0.76,bz-0.67,'#ffffff');
      box(group,1.1,0.8,0.12,bx,0.47,bz-1,'#96a9b9');
    }
  } else if(type==='core') {
    if(name.includes('계단'))for(let i=0;i<7;i++)box(group,Math.min(Math.max(0.5,w-0.5),2.1),0.12+i*0.15,0.40,x,0.08+(0.12+i*0.15)/2,z-1.2+i*0.4,'#b2bdc9');
    else box(group,Math.min(Math.max(0.5,w-0.7),2.4),1.45,0.14,x,0.80,z-d/2+0.25,'#aab8c9');
  } else if(type==='office') {
    box(group,2,0.12,0.9,x,0.85,z,'#c8b8a2');box(group,0.16,0.75,0.75,x-0.80,0.43,z,'#bec8d0');box(group,0.16,0.75,0.75,x+0.80,0.43,z,'#bec8d0');
    box(group,0.55,0.40,0.06,x,1.10,z-0.15,'#53677d');box(group,0.6,0.45,0.6,x,0.31,z+1.1,'#b2bfce');
  } else if(type==='common') {
    box(group,Math.min(Math.max(0.5,w-1),3.2),0.12,1.3,x,0.75,z,'#ccbca4');box(group,0.45,0.62,0.45,x-1,0.39,z,'#aebbc5');box(group,0.45,0.62,0.45,x+1,0.39,z,'#aebbc5');
    for(const sign of [-1,1]) box(group,2.4,0.40,0.62,x,0.33,z+sign*1.3,'#b7c5b4');
  } else {
    for(let i=0;i<3;i++)box(group,0.9,1.25,0.6,x+(i-1)*1.0,0.69,z-d/2+0.65,'#c7cbd1');
  }
  const bounds=new THREE.Box3().setFromObject(furniture);
  if(!bounds.isEmpty()) {
    const spanX=2*Math.max(Math.abs(bounds.min.x),Math.abs(bounds.max.x)),spanZ=2*Math.max(Math.abs(bounds.min.z),Math.abs(bounds.max.z));
    const scale=Math.min(1,(w-0.2)/spanX,(d-0.2)/spanZ);furniture.scale.setScalar(scale);
  }
  furniture.position.set(room.x,0,room.z);
}
function exterior(group,level) {
  if(!showWalls||mode==='plan')return;
  const w=project.width,d=project.depth,h=project.height;
  for(const z of [-d/2,d/2]) {
    box(group,w,0.68,0.18,0,0.42,z,'#f9fafb');box(group,w,0.32,0.18,0,h-0.25,z,'#fafbfc');
    const sections=Math.ceil(w/4);
    for(let i=0;i<=sections;i++)box(group,0.22,h-0.65,0.22,-w/2+i*w/sections,h/2,z,'#f8fafb');
    for(let i=0;i<sections;i++)box(group,w/sections-0.28,h-1.15,0.06,-w/2+(i+0.5)*w/sections,h/2+0.02,z,'#a8c5d6',0.28);
  }
  for(const x of [-w/2,w/2]) {
    box(group,0.18,0.68,d,x,0.42,0,'#f9fafb');box(group,0.18,0.32,d,x,h-0.25,0,'#fafbfc');
    const sections=Math.ceil(d/4);
    for(let i=0;i<=sections;i++)box(group,0.22,h-0.65,0.22,x,h/2,-d/2+i*d/sections,'#f8fafb');
    for(let i=0;i<sections;i++)box(group,0.06,h-1.15,d/sections-0.28,x,h/2+0.02,-d/2+(i+0.5)*d/sections,'#a8c5d6',0.28);
  }
  if(level===1)box(group,2.5,2.5,0.08,0,1.25,d/2+0.14,'#637d91',0.5);
}
function rebuild() {
  needsRender=true;
  if(fallback){drawFallback();return;}
  if(!scene)return;
  generation++;const revision=generation;
  if(root){scene.remove(root);dispose(root);}if(preview){scene.remove(preview);dispose(preview);preview=null;}
  root=new THREE.Group();scene.add(root);floorGroups=[];pickTargets=[];labelSprites=[];$('floor-labels').replaceChildren();$('observation-markers').replaceChildren();$('observation-lines').replaceChildren();observationAnchors=[];
  const visible=(mode==='floor'||mode==='plan')?[floor()]:project.floors;
  visible.forEach(f=>{
    const group=new THREE.Group(),elevation=(mode==='floor'||mode==='plan')?0:(f.level-1)*(project.height+(mode==='exploded'?3.8:0));
    group.position.y=elevation;root.add(group);floorGroups.push({floor:f,group});
    box(group,project.width+0.45,0.24,project.depth+0.45,0,-0.12,0,f.level===selectedFloor?'#c6d0e0':'#d4dce6');
    const surface=new THREE.Mesh(new THREE.PlaneGeometry(project.width,project.depth),new THREE.MeshStandardMaterial({color:'#f9f9f5',roughness:0.95}));
    surface.rotation.x=-Math.PI/2;surface.position.y=0.018;surface.receiveShadow=true;group.add(surface);
    if(f.image) {
      let width=project.width,depth=width/f.image.aspect;if(depth>project.depth){depth=project.depth;width=depth*f.image.aspect;}
      new THREE.TextureLoader().load(f.image.src,texture=>{
        if(revision!==generation){texture.dispose();return;}
        texture.colorSpace=THREE.SRGBColorSpace;
        const plane=new THREE.Mesh(new THREE.PlaneGeometry(width,depth),new THREE.MeshBasicMaterial({map:texture,transparent:true,opacity:mode==='plan'?1:0.45}));
        plane.rotation.x=-Math.PI/2;plane.position.y=0.032;group.add(plane);needsRender=true;
      },undefined,()=>{if(revision===generation)status('층 도면 이미지를 표시하지 못했습니다. 이미지를 다시 등록해주세요.','error');});
    }
    f.rooms.forEach(r=>{
      const chosen=r.id===selectedRoom && f.level===selectedFloor;
      const tile=new THREE.Mesh(new THREE.PlaneGeometry(r.w-0.07,r.d-0.07),new THREE.MeshStandardMaterial({color:chosen?'#aebce4':M.COLORS[r.type],roughness:0.9,transparent:mode==='plan'&&!!f.image,opacity:mode==='plan'&&f.image?0.42:1}));
      tile.rotation.x=-Math.PI/2;tile.position.set(r.x,0.065,r.z);tile.receiveShadow=true;tile.userData={level:f.level,id:r.id};group.add(tile);pickTargets.push(tile);
      roomWalls(group,r,mode==='building'?1.5:1.0);furnishings(group,r);
      nameSprite(group,r.name,r.x,mode==='plan'?0.25:1.22,r.z);
      if(chosen) {
        const points=[[-r.w/2,-r.d/2],[r.w/2,-r.d/2],[r.w/2,r.d/2],[-r.w/2,r.d/2]].map(([x,z])=>new THREE.Vector3(x+r.x,0.11,z+r.z));
        group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:'#4356ad'})));
      }
    });
    if(mode==='building')exterior(group,f.level);
    const marker=make('div','f3-floor-marker'+(f.level===selectedFloor?' is-selected':''));marker.append(make('b','',f.level+'F'),make('span','',f.name));$('floor-labels').append(marker);
    group.userData.marker=marker;
    for(const targets of observation?.mapped().groups.filter(t=>t.level===f.level)||[]){
      const badge=observationBadge(targets);$('observation-markers').append(badge);
      observationAnchors.push({group,x:targets.x,z:targets.z,y:mode==='plan'?.3:1.8,badge,line:observationLine(targets)});
    }
  });
  if(mode==='building'&&showWalls) {
    const y=project.floors.length*project.height;
    box(root,project.width+0.6,0.28,project.depth+0.6,0,y-0.1,0,'#d7e0e7');
    box(root,project.width+0.6,0.5,0.16,0,y+0.15,-project.depth/2,'#e7ecf0');
    box(root,0.16,0.5,project.depth+0.6,-project.width/2,y+0.15,0,'#e7ecf0');
    box(root,3.2,1.1,3.2,project.width/2-3,y+0.6,0,'#e6ebef');
  }
  if(mode!=='plan')box(root,project.width+4,0.3,project.depth+4,0,-0.45,0,'#e2e8e6');
  if(grid){scene.remove(grid);grid.geometry.dispose();grid.material.dispose();}
  const gridSize=Math.max(project.width,project.depth)*2;
  grid=new THREE.GridHelper(gridSize,Math.round(gridSize/2),'#d3dce6','#dce4eb');grid.position.y=-0.62;grid.material.transparent=true;grid.material.opacity=0.6;scene.add(grid);
}
function fitCamera() {
  if(!camera){if(fallback)drawFallback();return;}
  const height=mode==='building'?project.floors.length*project.height:mode==='exploded'?(project.floors.length-1)*(project.height+3.8)+project.height:1;
  const targetY=(mode==='floor'||mode==='plan')?0:height*0.48,aspect=viewport.clientWidth/viewport.clientHeight;
  const size=mode==='plan'?Math.max(project.depth+7,(project.width+7)/aspect):Math.max(project.depth+12,height+12,(project.width+18)/aspect);
  camera.left=-size*aspect/2;camera.right=size*aspect/2;camera.top=size/2;camera.bottom=-size/2;camera.zoom=1;
  if(mode==='plan'){camera.up.set(0,0,-1);camera.position.set(0,100,0.001);controls.enableRotate=false;controls.mouseButtons.LEFT=THREE.MOUSE.PAN;}
  else{const distance=Math.max(project.width,project.depth,height)*1.8+20;camera.up.set(0,1,0);camera.position.set(-distance*0.6,targetY+distance*0.62,distance*0.75);controls.enableRotate=true;controls.mouseButtons.LEFT=THREE.MOUSE.ROTATE;}
  controls.target.set(0,targetY,0);controls.enabled=!drawing;controls.update();camera.updateProjectionMatrix();needsRender=true;
}
function resize() {
  if(renderer&&camera){const w=viewport.clientWidth,h=viewport.clientHeight;renderer.setSize(w,h,false);fitCamera();needsRender=true;}
  else if(fallback)drawFallback();
}
function observationBadge(targets){
  const badge=make('button','f3-observation-marker f3-risk-'+(targets.focus?'focus':'watch'));badge.type='button';
  const summary=targets.roomId?`집중 ${targets.focus} · 주의 ${targets.watch}`:`위치 확인 ${targets.rows.length}명`;
  const names=targets.rows.slice(0,2).map(r=>r.elderly_name).join(', ')+(targets.rows.length>2?` 외 ${targets.rows.length-2}명`:'');
  badge.append(make('strong','',summary));targets.rows.slice(0,2).forEach(r=>badge.append(make('small','',`${r.risk_tier==='focus'?'집중':'주의'} ${r.elderly_name}`)));
  if(targets.rows.length>2)badge.append(make('small','',`외 ${targets.rows.length-2}명`));badge.title=targets.roomName+' · '+targets.rows.map(r=>r.elderly_name+' '+r.risk_tier_display).join(', ');
  badge.setAttribute('aria-label',`${targets.level}층 ${targets.roomName} · ${summary} · ${names}`);
  badge.onclick=()=>{if(!fallback)mode='floor';selectRoom(targets.level,targets.roomId);fitCamera();};return badge;
}
function observationLine(targets){const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.dataset.tier=targets.focus?'focus':'watch';$('observation-lines').append(line);return line;}
function placeObservation(a,x,y,w,h,used){
  const bw=a.badge.offsetWidth||140,bh=a.badge.offsetHeight||60,pad=5,clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  let chosen=null;
  const offsets=[[0,0],[0,-bh-10],[0,bh+10],[-bw-10,0],[bw+10,0],[0,-2*(bh+10)],[0,2*(bh+10)],[-bw-10,-bh-10],[bw+10,-bh-10],[-bw-10,bh+10],[bw+10,bh+10]];
  for(const [dx,dy]of offsets){const cx=clamp(x+dx,bw/2+pad,w-bw/2-pad),cy=clamp(y+dy,bh/2+pad,h-bh/2-pad),r={left:cx-bw/2,right:cx+bw/2,top:cy-bh/2,bottom:cy+bh/2,cx,cy};
    if(!chosen)chosen=r;if(!used.some(k=>r.left<k.right+6&&r.right>k.left-6&&r.top<k.bottom+6&&r.bottom>k.top-6)){chosen=r;break;}
  }
  used.push(chosen);a.badge.style.left=chosen.cx+'px';a.badge.style.top=chosen.cy+'px';
  a.line.setAttribute('x1',x);a.line.setAttribute('y1',y);a.line.setAttribute('x2',chosen.cx);a.line.setAttribute('y2',chosen.cy);
}
function updateMarkers() {
  const w=viewport.clientWidth,h=viewport.clientHeight;
  for(const {group} of floorGroups) {
    const p=group.localToWorld(new THREE.Vector3(-project.width/2-0.8,0.55,project.depth/2+0.9)).project(camera),marker=group.userData.marker;
    const x=(p.x+1)*w/2,y=(1-p.y)*h/2;
    marker.hidden=p.z>1||p.z<-1||x<10||x>w-10||y<10||y>h-10;
    marker.style.left=x+'px';marker.style.top=y+'px';
  }
  const used=[];
  for(const a of observationAnchors){
    const p=a.group.localToWorld(new THREE.Vector3(a.x,a.y,a.z)).project(camera),x=(p.x+1)*w/2,y=(1-p.y)*h/2;
    a.badge.hidden=drawing||p.z>1||p.z<-1||x<0||x>w||y<0||y>h;
    a.line.style.display=a.badge.hidden?'none':'';if(!a.badge.hidden)placeObservation(a,x,y,w,h,used);
  }
}
function pointer(event) {
  const bounds=canvas.getBoundingClientRect();return {x:((event.clientX-bounds.left)/bounds.width)*2-1,y:1-((event.clientY-bounds.top)/bounds.height)*2};
}
function groundPoint(event) {
  if(fallback){const p=fallbackPoint(event);return p;}
  raycaster.setFromCamera(pointer(event),camera);const p=new THREE.Vector3();
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-0.08),p)?{x:p.x,z:p.z}:null;
}
function drawPreview(end) {
  if(fallback){drawFallback(end);return;}
  if(preview){scene.remove(preview);dispose(preview);}
  const r=M.rectangle(startPoint,end,project),pts=[[-r.w/2,-r.d/2],[r.w/2,-r.d/2],[r.w/2,r.d/2],[-r.w/2,r.d/2]].map(([x,z])=>new THREE.Vector3(x+r.x,0.16,z+r.z));
  preview=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:'#4356ad',depthTest:false}));scene.add(preview);needsRender=true;
}
canvas.addEventListener('pointerdown',event=>{downPoint={x:event.clientX,y:event.clientY};});
canvas.addEventListener('pointerup',event=>{
  if(!downPoint||Math.hypot(event.clientX-downPoint.x,event.clientY-downPoint.y)>6)return;
  downPoint=null;
  if(drawing) {
    const point=groundPoint(event);if(!point)return;
    if(Math.abs(point.x)>project.width/2||Math.abs(point.z)>project.depth/2){status('건물 바닥 안에 모서리를 지정해주세요.','error');return;}
    if(!startPoint){startPoint=point;status('반대쪽 모서리를 클릭하면 공간이 만들어집니다.');return;}
    try {const room=M.addRoom(project,selectedFloor,M.rectangle(startPoint,point,project));cancelDrawing();selectedRoom=room.id;markDirty();renderUI();rebuild();status('공간을 추가했습니다. 오른쪽에서 이름과 용도를 지정하세요.');}
    catch(error){startPoint=null;if(preview){scene?.remove(preview);dispose(preview);preview=null;}status(error.message,'error');needsRender=true;}
    return;
  }
  if(fallback) {
    const p=fallbackPoint(event),room=floor().rooms.find(r=>Math.abs(r.x-p.x)<r.w/2&&Math.abs(r.z-p.z)<r.d/2);if(room)selectRoom(selectedFloor,room.id);return;
  }
  raycaster.setFromCamera(pointer(event),camera);const hit=raycaster.intersectObjects(pickTargets)[0];if(hit)selectRoom(hit.object.userData.level,hit.object.userData.id);
});
canvas.addEventListener('pointermove',event=>{
  if(drawing&&startPoint){const p=groundPoint(event);if(p)drawPreview(p);return;}
  if(fallback||!raycaster)return;
  raycaster.setFromCamera(pointer(event),camera);const hit=raycaster.intersectObjects(pickTargets)[0],label=$('hover-label');
  if(!hit){label.hidden=true;return;}
  const data=hit.object.userData,room=project.floors[data.level-1].rooms.find(r=>r.id===data.id);const bounds=canvas.getBoundingClientRect();
  label.textContent=data.level+'층 · '+room.name;label.hidden=false;label.style.left=Math.max(8,Math.min(bounds.width-150,event.clientX-bounds.left+12))+'px';label.style.top=Math.max(8,event.clientY-bounds.top-35)+'px';
});
canvas.addEventListener('pointerleave',()=>{$('hover-label').hidden=true;});
canvas.addEventListener('keydown',event=>{
  if(event.key==='Escape'){cancelDrawing();renderUI();return;}
  if(!controls)return;
  const directions={ArrowLeft:1,ArrowRight:-1,ArrowUp:1,ArrowDown:-1};
  if(event.key in directions){event.preventDefault();if(mode==='plan')controls.pan(event.key==='ArrowLeft'?30:event.key==='ArrowRight'?-30:0,event.key==='ArrowUp'?30:event.key==='ArrowDown'?-30:0);else if(event.key==='ArrowLeft'||event.key==='ArrowRight')controls.rotateLeft(directions[event.key]*0.12);else controls.rotateUp(directions[event.key]*0.10);}
  if(event.key==='+'||event.key==='='){event.preventDefault();camera.zoom=Math.min(6,camera.zoom*1.12);camera.updateProjectionMatrix();}
  if(event.key==='-'){event.preventDefault();camera.zoom=Math.max(0.35,camera.zoom/1.12);camera.updateProjectionMatrix();}
  controls.update();needsRender=true;
});
let fallbackBounds=null;
function fallbackPoint(event) {const bounds=canvas.getBoundingClientRect(),b=fallbackBounds;return {x:(event.clientX-bounds.left-b.left)/b.scale-project.width/2,z:(event.clientY-bounds.top-b.top)/b.scale-project.depth/2};}
function drawFallback(end) {
  const revision=++fallbackRevision;
  const w=viewport.clientWidth,h=viewport.clientHeight,scale=Math.min((w-40)/project.width,(h-110)/project.depth),left=(w-project.width*scale)/2,top=(h-project.depth*scale)/2+20;
  const surface=fallbackCanvas||canvas;
  surface.width=w*devicePixelRatio;surface.height=h*devicePixelRatio;const ctx=surface.getContext('2d');if(!ctx)return;
  ctx.scale(devicePixelRatio,devicePixelRatio);ctx.fillStyle='#f0f4f8';ctx.fillRect(0,0,w,h);fallbackBounds={left,top,scale};
  ctx.fillStyle='#fff';ctx.fillRect(left,top,project.width*scale,project.depth*scale);ctx.strokeStyle='#b9c6d6';ctx.strokeRect(left,top,project.width*scale,project.depth*scale);
  const rooms=floor().rooms;
  const paint=()=>{
    rooms.forEach(r=>{
      const x=left+(r.x+project.width/2-r.w/2)*scale,y=top+(r.z+project.depth/2-r.d/2)*scale;
      ctx.globalAlpha=floor().image?0.55:1;ctx.fillStyle=r.id===selectedRoom?'#aebce4':M.COLORS[r.type];ctx.fillRect(x,y,r.w*scale,r.d*scale);ctx.globalAlpha=1;
      if(showWalls){ctx.strokeStyle='#8293a8';ctx.strokeRect(x,y,r.w*scale,r.d*scale);}if(showNames){ctx.fillStyle='#35445b';ctx.font='11px system-ui';ctx.textAlign='center';ctx.fillText(r.name,x+r.w*scale/2,y+r.d*scale/2,Math.max(5,r.w*scale-4));}
    });
    if(startPoint&&end){const r=M.rectangle(startPoint,end,project);ctx.strokeStyle='#4356ad';ctx.lineWidth=2;ctx.strokeRect(left+(r.x+project.width/2-r.w/2)*scale,top+(r.z+project.depth/2-r.d/2)*scale,r.w*scale,r.d*scale);}
  };
  if(floor().image){const image=floor().image,img=new Image();img.onload=()=>{if(revision!==fallbackRevision)return;let iw=project.width*scale,ih=iw/image.aspect;if(ih>project.depth*scale){ih=project.depth*scale;iw=ih*image.aspect;}ctx.drawImage(img,left+(project.width*scale-iw)/2,top+(project.depth*scale-ih)/2,iw,ih);paint();};img.src=image.src;}else paint();
  $('floor-labels').replaceChildren();
  $('observation-markers').replaceChildren();$('observation-lines').replaceChildren();const used=[];
  if(!drawing)for(const targets of observation?.mapped().groups.filter(t=>t.level===selectedFloor)||[]){const badge=observationBadge(targets);$('observation-markers').append(badge);placeObservation({badge,line:observationLine(targets)},left+(targets.x+project.width/2)*scale,top+(targets.z+project.depth/2)*scale,w,h,used);}
}
renderUI();if(loadError)status(loadError,'error');else if(projects.length)status('저장한 건물을 불러왔습니다. 층을 선택해 공간을 확인하거나 수정하세요.');
try {
  [THREE,{OrbitControls}]=await Promise.all([import('three'),import('/assets/vendor/three/OrbitControls.js')]);
  const context=canvas.getContext('webgl2',{antialias:true,alpha:false});if(!context)throw new Error('WebGL2 unavailable');
  renderer=new THREE.WebGLRenderer({canvas,context,antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor('#eef2f7');
  scene=new THREE.Scene();camera=new THREE.OrthographicCamera(-30,30,30,-30,0.1,500);raycaster=new THREE.Raycaster();
  scene.add(new THREE.HemisphereLight('#ffffff','#b2bdcc',1.6));
  const sun=new THREE.DirectionalLight('#fff5e8',1.9);sun.position.set(-30,60,35);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-70;sun.shadow.camera.right=70;sun.shadow.camera.top=70;sun.shadow.camera.bottom=-70;sun.shadow.camera.far=180;sun.shadow.bias=-0.0004;scene.add(sun);
  controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.dampingFactor=0.12;controls.minZoom=0.35;controls.maxZoom=6;controls.maxPolarAngle=Math.PI/2-0.04;
  controls.addEventListener('change',()=>{needsRender=true;});
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();$('viewer-loading').hidden=false;$('viewer-loading').textContent='3D 표시 연결이 중단되었습니다. 페이지를 새로고침하면 저장한 도면을 다시 열 수 있습니다.';});
  rebuild();fitCamera();resize();$('viewer-loading').hidden=true;
  let visible=true;document.addEventListener('visibilitychange',()=>{visible=!document.hidden;needsRender=true;});
  function animate(){requestAnimationFrame(animate);if(!visible)return;controls.update();if(needsRender){renderer.render(scene,camera);updateMarkers();needsRender=false;}}
  animate();
} catch(error) {
  renderer?.dispose();renderer=null;camera=null;controls=null;
  fallback=true;mode='plan';$('viewer-loading').hidden=true;
  if(canvas.getContext('2d')===null){fallbackCanvas=document.createElement('canvas');fallbackCanvas.className='f3-fallback-canvas';fallbackCanvas.setAttribute('aria-hidden','true');viewport.append(fallbackCanvas);}
  status('이 브라우저는 3D 표시를 지원하지 않아 선택 층을 2D 평면으로 표시합니다.','warning');
  document.querySelectorAll('[data-mode]').forEach(button=>{if(button.dataset.mode!=='plan')button.disabled=true;});
  renderUI();drawFallback();
}
new ResizeObserver(resize).observe(viewport);
observation.load();
