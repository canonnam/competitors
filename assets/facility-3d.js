import {checkAccess} from './facility-access.js?v=20261002-access1';
import {initImport} from './facility-3d-import.js?v=20261002-b1';
import {initObservation} from './facility-observation.js?v=20261002-access1';
import {initStaff} from './facility-staff.js?v=20261003-residents1';
import {initResidents} from './facility-residents.js?v=20261003-residents1';
import {initFacilityUI} from './facility-3d-ui.js?v=20261003-residents1';
/* Shared facility composition and Three.js building viewer. */
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
let project = projects[0] ? structuredClone(projects[0]) : M.sample(), selectedFloor = project.floors.some(f=>f.level===1)?1:project.floors[0].level, selectedRoom = null, mode = 'building', dirty = false;
let removedFloor=null;
const ui=initFacilityUI();
const revisions=new Map();let sharedReady=false,saving=false,editVersion=0;
async function sharedRequest(path='',method='GET',body){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
  try {
    const response=await fetch('/api/facility-projects/'+path,{method,cache:'no-store',credentials:'same-origin',signal:controller.signal,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    checkAccess(response);const data=await response.json();if(!response.ok)throw new Error(data.error||'공유 도면을 불러오지 못했습니다.');return data;
  } catch(error){if(error.name==='AbortError')throw new Error('서버 응답이 지연되고 있습니다. 다시 저장해주세요.');throw error;}
  finally {clearTimeout(timeout);}
}
function cacheBackup(){try{localStorage.setItem(STORAGE,JSON.stringify({version:1,projects}));}catch{/* A failed browser backup does not invalidate the committed server save. */}}
function saveControls(){for(const id of ['save-project','project-select','new-project','delete-project','undo-project'])$(id).disabled=!sharedReady||saving;}
async function loadShared(initial=false){
  if(saving||(!initial&&(dirty||document.querySelector('dialog[open]')||document.activeElement?.matches('input,select,textarea'))))return;
  try {
    const result=await sharedRequest(),entries=result.projects.map(row=>({...row,project:M.validate(row.project)}));
    sharedReady=true;saveControls();
    if(!initial&&(dirty||document.querySelector('dialog[open]')))return;
    if(initial&&!entries.length){status(projects.length?'기존 도면을 불러왔습니다. 저장을 누르면 다른 사람과 공유됩니다.':'새 건물을 저장하면 다른 사람도 같은 도면과 종사자 배치를 볼 수 있습니다.');return;}
    if(!entries.length&&!revisions.size&&projects.length)return;
    const next=entries.find(row=>row.project.id===project.id)||entries[0];
    const changed=next?revisions.get(next.project.id)!==next.revision:projects.length>0;
    projects=entries.map(row=>row.project);revisions.clear();entries.forEach(row=>revisions.set(row.project.id,row.revision));
    if(initial){if(next)setProject(structuredClone(next.project));status('공유 도면을 불러왔습니다.');}
    else if(changed&&!dirty){
      if(next){const same=next.project.id===project.id;if(same){project=structuredClone(next.project);if(!project.floors.some(f=>f.level===selectedFloor))selectedFloor=project.floors[0].level;if(!currentRoom())selectedRoom=null;cancelDrawing();renderUI();rebuild();}else setProject(structuredClone(next.project));}
      else setProject(M.blank());
      status('최신 공유 도면과 종사자 배치를 반영했습니다.');
    }
    else renderProjectSelect();
    cacheBackup();
  } catch(error){if(initial){sharedReady=false;saveControls();status('공유 도면을 불러오지 못했습니다. 새로고침 후 다시 연결해주세요. 브라우저 보관본은 파일로 내보낼 수 있습니다.','error');}}
}
let drawing = false, startPoint = null, downPoint = null, showNames = true, showWalls = true;
let THREE, OrbitControls, renderer, scene, camera, controls, root, grid, raycaster, preview;
let floorGroups = [], pickTargets = [], labelSprites = [], generation = 0, needsRender = true;
let fallback = false, fallbackCanvas = null, fallbackRevision = 0;
let observation=null,observationAnchors=[];
let staff=null,residents=null,staffFloors=[],drawingPoints=[],drawingShape='polygon',previewEnd=null;
const canvas = $('space-canvas'), viewport = $('viewport');
const floor = () => project.floors.find(f=>f.level===selectedFloor);
const currentRoom = () => floor().rooms.find(r=>r.id===selectedRoom);
function status(message,kind='') {
  $('project-status').textContent=message;
  $('project-status').hidden=!message;
  if(kind) $('project-status').dataset.status=kind; else delete $('project-status').dataset.status;
}
function markDirty() {dirty=true;editVersion++;$('save-project').textContent='저장';}
function make(tag,className,text) {
  const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;
}
function renderProjectSelect(){
  const options=projects.some(p=>p.id===project.id)?projects.map(p=>p.id===project.id?project:p):[project,...projects];
  $('project-select').replaceChildren(...options.map(p=>{const option=make('option','',p.name);option.value=p.id;return option;}));
  $('project-select').value=project.id;
}
function renderUI() {
  renderProjectSelect();
  $('project-summary').textContent='';
  $('project-scale-note').textContent=project.scale==='entered'?'입력한 치수 기준으로 공간을 구성합니다.':'크기는 추정값입니다. 정확한 면적이 필요하면 실제 치수를 입력하세요.';
  $('floor-count').textContent=project.floors.length+'개 층';
  $('add-floor').disabled=project.floors.length>=M.FLOOR_LEVELS.length;
  $('delete-floor').disabled=project.floors.length<=1;
  $('undo-floor').hidden=!removedFloor||removedFloor.projectId!==project.id;
  $('view-floor-select').replaceChildren(...project.floors.map(f=>{const option=make('option','',f.name===M.floorName(f.level)?f.name:`${M.floorName(f.level)} · ${f.name}`);option.value=f.level;return option;}));
  $('view-floor-select').value=selectedFloor;
  $('floor-list').replaceChildren(...[...project.floors].reverse().map(f=>{
    const button=make('button','f3-floor-button');button.type='button';button.dataset.level=f.level;
    button.setAttribute('aria-pressed',String(f.level===selectedFloor));
    button.setAttribute('aria-label',`${M.floorName(f.level)} ${f.name}, 공간 ${f.rooms.length}개`);
    const info=make('span','f3-floor-info');info.append(make('strong','',f.name),make('small','',`공간 ${f.rooms.length}개${f.image?' · 도면 등록':''}`));
    const total=observation?.mapped().floorTotals.find(r=>r.level===f.level);
    if(total)info.append(make('small','',`생활실 현원 ${total.occupancy}명`));
    const employees=(f.staff||[]).reduce((n,r)=>n+r.count,0);if(employees)info.append(make('small','',`종사자 ${employees}명`));
    button.append(make('span','f3-floor-number',M.floorCode(f.level)),info);return button;
  }));
  $('rooms-heading').textContent=M.floorName(selectedFloor)+' 공간';
  $('room-list').replaceChildren(...floor().rooms.map(r=>{
    const button=make('button','f3-room-button');button.type='button';button.dataset.room=r.id;button.setAttribute('aria-pressed',String(r.id===selectedRoom));
    const dot=make('span','f3-room-dot');dot.style.setProperty('--room-color',M.COLORS[r.type]);dot.setAttribute('aria-hidden','true');
    const g=observation?.mapped().groups.find(g=>g.level===selectedFloor&&g.roomId===r.id);button.append(dot,make('span','',r.name),make('small','',g?.occupancy!=null?`현재 ${g.occupancy}명`:M.TYPES[r.type]));return button;
  }));
  if(!floor().rooms.length) $('room-list').append(make('p','f3-small','공간 추가를 눌러 생활실·복도·공용공간을 지정하세요.'));
  const room=currentRoom();$('room-details').hidden=!room;
  if(room) {
    $('room-name').value=room.name;$('room-type').value=room.type;$('room-beds').value=room.beds;
    $('beds-field').hidden=room.type!=='living';
    $('room-size').textContent=`${room.points?'다각형 '+room.points.length+'개 점 · ':''}${M.area(room).toFixed(1)}㎡ (${project.scale==='entered'?'입력 치수 기준':'추정 크기 기준'})`;
  }
  $('floor-name').value=floor().name;
  $('image-status').textContent=floor().image?floor().image.name:'등록한 이미지 없음';
  $('remove-image').hidden=!floor().image;$('auto-from-image').disabled=!floor().image;
  document.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===mode)));
  const titles={building:'건물 전체',exploded:'층별 펼치기',floor:M.floorName(selectedFloor)+' · '+floor().name,plan:M.floorName(selectedFloor)+' 평면 편집'};
  $('view-title').textContent=titles[mode];
  $('view-description').textContent=mode==='building'?`${project.floors.length}개 층을 함께 살펴보세요.`:mode==='exploded'?'층 사이를 띄워 내부 공간을 비교하세요.':mode==='plan'?'도면을 기준으로 공간을 지정하고 수정하세요.':'공간을 클릭해 이름과 용도를 확인하세요.';
  $('add-room').textContent=drawing?'추가 취소':'공간 추가';
  $('view-help').textContent=drawing?(drawingShape==='polygon'?'모서리를 차례로 클릭 · 첫 점 클릭/Enter로 완성 · Backspace로 한 점 취소 · Esc로 종료':'첫 모서리와 반대 모서리를 클릭 · Esc로 취소'):mode==='plan'?'드래그로 이동 · 휠로 확대 · 공간을 클릭해 선택':'드래그로 회전 · 휠로 확대 · 오른쪽 드래그로 이동';
  $('drawing-controls').hidden=!drawing;$('drawing-count').textContent='점 '+drawingPoints.length+'개';$('drawing-finish').disabled=drawingShape!=='polygon'||drawingPoints.length<3;$('drawing-undo').disabled=!drawingPoints.length;$('drawing-finish').hidden=drawingShape!=='polygon';$('drawing-undo').hidden=drawingShape!=='polygon';
  canvas.setAttribute('aria-label',fallback?`${M.floorName(selectedFloor)} 평면 화면. 공간을 클릭하거나 목록에서 선택할 수 있습니다.`:`${project.floors.length}개 층의 ${titles[mode]} 화면. 방향키로 ${mode==='plan'?'이동':'회전'}하고 더하기·빼기로 확대·축소할 수 있습니다. 공간 선택은 목록에서도 가능합니다.`);
  viewport.classList.toggle('is-drawing',drawing);
  observation?.sync();
  staff?.render();
}
Object.entries(M.TYPES).forEach(([value,label])=>{const option=make('option','',label);option.value=value;$('room-type').append(option);});
function confirmLeave() {return !dirty || window.confirm('저장하지 않은 변경이 있습니다. 다른 건물로 이동할까요?');}
function setProject(next) {
  project=next;selectedFloor=next.floors.some(f=>f.level===1)?1:next.floors[0].level;selectedRoom=null;removedFloor=null;dirty=false;cancelDrawing();mode='building';renderUI();rebuild();fitCamera();
}
async function save() {
  if(saving||!sharedReady)return;
  saving=true;saveControls();status('');const version=editVersion;
  try {
    const clean=M.validate(project),row=await sharedRequest('','POST',{project:clean,revision:revisions.get(clean.id)||0});
    revisions.set(clean.id,row.revision);projects=[M.validate(row.project),...projects.filter(p=>p.id!==clean.id)];
    if(editVersion===version)dirty=false;cacheBackup();renderUI();
    ui.notify(dirty?'공유 저장했습니다. 추가로 편집한 내용은 다시 저장해주세요.':'도면과 종사자 배치를 저장했습니다. 다른 사람도 같은 구성을 볼 수 있습니다.');
  } catch(error) {ui.notify(error.message,true);}
  finally {saving=false;saveControls();}
}
function closeMore(focus=false){$('project-menu').hidden=true;$('project-more').setAttribute('aria-expanded','false');if(focus)$('project-more').focus();}
$('project-more').onclick=()=>{const opening=$('project-menu').hidden;$('project-menu').hidden=!opening;$('project-more').setAttribute('aria-expanded',String(opening));if(opening)$('edit-project').focus();};
$('project-menu').addEventListener('click',event=>{if(event.target.closest('button'))closeMore();});
document.addEventListener('click',event=>{if(!event.target.closest('.f3-more'))closeMore();});
$('project-menu').addEventListener('keydown',event=>{if(event.key==='Escape'){closeMore(true);event.preventDefault();}});
function cancelDrawing() {
  drawing=false;startPoint=null;drawingPoints=[];previewEnd=null;
  if(preview){scene?.remove(preview);dispose(preview);preview=null;}
  if(controls) controls.enabled=true;
  if(fallback)drawFallback();
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
$('lock-map').onclick=async()=>{
  if(dirty&&!window.confirm('저장하지 않은 변경이 있습니다. 저장하지 않고 지도를 잠글까요?'))return;
  try{const response=await fetch('/api/facility-map-access/session',{method:'DELETE',credentials:'same-origin'});if(!response.ok)throw new Error('지도를 잠그지 못했습니다.');dirty=false;location.replace('/facility-3d.html');}
  catch(error){ui.notify(error.message,true);}
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
  chooseFloor(Number(button.dataset.level));
};
function chooseFloor(level){
  if(!project.floors.some(f=>f.level===level))return;
  cancelDrawing();selectedFloor=level;selectedRoom=null;
  if(mode==='building'||mode==='exploded')mode='floor';
  renderUI();rebuild();fitCamera();
}
$('view-floor-select').onchange=()=>chooseFloor(Number($('view-floor-select').value));
$('add-floor').onclick=()=>{
  const used=new Set(project.floors.map(f=>f.level)),available=M.FLOOR_LEVELS.filter(level=>!used.has(level));
  if(!available.length)return;
  $('new-floor-form').reset();$('new-floor-error').textContent='';
  $('new-floor-level').replaceChildren(...available.map(level=>{const option=make('option','',M.floorName(level));option.value=level;return option;}));
  const next=Math.max(...used)+1;$('new-floor-level').value=available.includes(next)?next:available[0];
  $('new-floor-dialog').showModal();
};
$('cancel-new-floor').onclick=()=>$('new-floor-dialog').close();
$('new-floor-form').onsubmit=event=>{
  event.preventDefault();
  try{const added=M.addFloor(project,{level:Number($('new-floor-level').value),name:$('new-floor-name').value});markDirty();$('new-floor-dialog').close();chooseFloor(added.level);status('층을 추가했습니다. 저장하면 다른 사람에게도 반영됩니다.');}
  catch(error){$('new-floor-error').textContent=error.message;}
};
$('delete-floor').onclick=()=>{
  if(project.floors.length<=1)return;
  const f=floor(),count=(f.staff||[]).reduce((n,row)=>n+row.count,0);
  $('delete-floor-summary').textContent=`${M.floorName(f.level)} · ${f.name} — 공간 ${f.rooms.length}개, 도면 ${f.image?'1개':'없음'}, 종사자 ${count}명`;
  $('delete-floor-dialog').showModal();
};
$('cancel-delete-floor').onclick=()=>$('delete-floor-dialog').close();
$('confirm-delete-floor').onclick=()=>{
  try{
    const f=M.removeFloor(project,selectedFloor);removedFloor={projectId:project.id,floor:structuredClone(f)};
    $('delete-floor-dialog').close();markDirty();chooseFloor((project.floors.filter(row=>row.level<f.level).at(-1)||project.floors[0]).level);
    status(`${M.floorName(f.level)}을 삭제했습니다. 저장하면 공유됩니다. 삭제 되돌리기로 복구할 수 있습니다.`);
  }catch(error){$('delete-floor-dialog').close();status(error.message,'error');}
};
$('undo-floor').onclick=()=>{
  if(!removedFloor||removedFloor.projectId!==project.id)return;
  try{
    const next=structuredClone(project);next.floors.push(structuredClone(removedFloor.floor));project=M.validate(next);
    const level=removedFloor.floor.level;removedFloor=null;markDirty();chooseFloor(level);status('층과 도면·공간·종사자 배치를 복구했습니다. 저장하면 공유됩니다.');
  }catch(error){status(error.message,'error');}
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
  floor().name=$('floor-name').value.trim()||M.floorName(selectedFloor);project.example=false;markDirty();renderUI();rebuild();status('층 이름을 적용했습니다.');
};
$('add-room').onclick=()=>{
  if(drawing){cancelDrawing();renderUI();return;}
  if(floor().rooms.length>=40){status('한 층에 공간은 최대 40개까지 구성할 수 있습니다.','error');return;}
  changeMode('plan');drawing=true;if(controls)controls.enabled=false;renderUI();
  status('모서리를 차례로 클릭해 영역을 그리세요. 첫 점을 다시 클릭하거나 공간 완성을 눌러 마무리합니다.');
};
$('drawing-shape').onchange=()=>{drawingShape=$('drawing-shape').value;startPoint=null;drawingPoints=[];previewEnd=null;if(preview){scene?.remove(preview);dispose(preview);preview=null;}renderUI();if(fallback)drawFallback();needsRender=true;};
$('drawing-finish').onclick=finishPolygon;
$('drawing-undo').onclick=()=>{drawingPoints.pop();previewEnd=null;drawPreview(null);renderUI();};
function finishPolygon(){if(!drawing||drawingShape!=='polygon')return;try{finishRoom(M.polygon(drawingPoints,project));}catch(error){status(error.message+' 마지막 점 취소로 수정할 수 있습니다.','error');}}
function finishRoom(shape){const room=M.addRoom(project,selectedFloor,shape);cancelDrawing();selectedRoom=room.id;markDirty();renderUI();rebuild();status('공간을 추가했습니다. 오른쪽에서 이름과 용도를 지정한 뒤 저장하세요.','success');}
$('show-labels').onclick=()=>{showNames=!showNames;$('show-labels').setAttribute('aria-pressed',String(showNames));labelSprites.forEach(s=>s.visible=showNames);document.querySelectorAll('.f3-space-name').forEach(name=>name.hidden=!showNames);needsRender=true;if(fallback)drawFallback();};
$('show-walls').onclick=()=>{showWalls=!showWalls;$('show-walls').setAttribute('aria-pressed',String(showWalls));rebuild();};
$('reset-view').onclick=fitCamera;
let expandedInert=[];
function expandViewer(open){
  const viewer=document.querySelector('.f3-viewer');viewer.classList.toggle('is-expanded',open);document.body.classList.toggle('f3-expanded-body',open);
  if(open){for(let node=viewer;node.parentElement&&node!==document.body;node=node.parentElement){for(const sibling of node.parentElement.children){if(sibling!==node&&!sibling.inert){sibling.inert=true;expandedInert.push(sibling);}}}}
  else{expandedInert.forEach(node=>node.inert=false);expandedInert=[];}
  $('fullscreen').textContent=open?'전체 화면 닫기':'전체 화면';$('fullscreen').focus();resize();
}
$('fullscreen').onclick=async()=>{
  if(document.querySelector('.f3-viewer').classList.contains('is-expanded')){expandViewer(false);return;}
  try {if(document.fullscreenElement)await document.exitFullscreen();else await document.querySelector('.f3-viewer').requestFullscreen();}
  catch {expandViewer(true);}
};
document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'전체 화면 닫기':'전체 화면';resize();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.querySelector('.f3-viewer').classList.contains('is-expanded'))expandViewer(false);});
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
    const next=M.validate(JSON.parse(await file.text()));next.id=M.uid();setProject(next);markDirty();status('도면 파일을 열었습니다. 저장을 눌러 다른 사람과 공유하세요.');
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
    const next=structuredClone(project);if(replace)next.floors.find(f=>f.id===targetFloor.id).rooms=[];
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
$('confirm-delete-building').onclick=async()=>{
  if(saving)return;saving=true;saveControls();$('confirm-delete-building').disabled=true;
  try {
    const snapshot={project:structuredClone(project),saved:revisions.has(project.id),dirty};
    if(snapshot.saved){const result=await sharedRequest(encodeURIComponent(project.id)+'/','DELETE',{revision:revisions.get(project.id)});snapshot.revision=result.revision;revisions.delete(project.id);}
    deletedProject=snapshot;const name=project.name;projects=projects.filter(p=>p.id!==project.id);cacheBackup();
    setProject(projects.length?structuredClone(projects[0]):M.blank());$('delete-building-dialog').close();$('undo-project').hidden=false;
    status(name+' 건물을 삭제했습니다. 새로고침 전까지 삭제 되돌리기를 사용할 수 있습니다.');
  } catch(error){$('delete-building-dialog').close();status(error.message,'error');}
  finally{saving=false;saveControls();$('confirm-delete-building').disabled=false;}
};
$('undo-project').onclick=async()=>{
  if(!deletedProject||!confirmLeave())return;
  saving=true;saveControls();
  try {
    const old=deletedProject;
    if(old.saved){const row=await sharedRequest(encodeURIComponent(old.project.id)+'/restore/','POST',{revision:old.revision});revisions.set(old.project.id,row.revision);projects=[M.validate(row.project),...projects.filter(p=>p.id!==old.project.id)];}
    if(old.saved)cacheBackup();setProject(structuredClone(old.project));dirty=old.dirty;deletedProject=null;$('undo-project').hidden=true;status('삭제한 건물을 복구했습니다.','success');
  } catch(error){status(error.message,'error');}
  finally{saving=false;saveControls();}
};
$('remove-image').onclick=()=>{floor().image=null;project.example=false;markDirty();renderUI();rebuild();status('선택 층의 도면 이미지를 제거했습니다. 공간 구성은 유지됩니다.');};
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
observation=initObservation({getProject:()=>project,getFloor:floor,getRoom:currentRoom,getMode:()=>mode,changed:()=>{renderUI();rebuild();},select:(level,id)=>selectRoom(level,id)});
staff=initStaff({getProject:()=>project,getFloor:floor,updated:()=>{needsRender=true;},applied:()=>{project.example=false;markDirty();renderUI();rebuild();status('선택 층에 종사자를 배치했습니다. 저장을 눌러 보관하세요.','success');}});
residents=initResidents({project:()=>project,observations:()=>observation.mapped(),three:()=>THREE,playing:()=>staff.active(),speed:()=>staff.speed(),drawing:()=>drawing,updated:()=>{needsRender=true;updateStaff(0);}});
function selectRoom(level,id) {
  selectedFloor=level;selectedRoom=id;renderUI();rebuild();const room=currentRoom();if(room)status(`${M.floorName(level)} ${room.name} · ${M.TYPES[room.type]}`);
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
  const style=getComputedStyle(document.body);ctx.fillStyle=style.getPropertyValue('--ui-surface').trim()||'#fff';ctx.roundRect(6,8,500,84,16);ctx.fill();ctx.strokeStyle=style.getPropertyValue('--ui-border').trim()||'#dce3ed';ctx.lineWidth=4;ctx.stroke();ctx.fillStyle=style.getPropertyValue('--ui-text').trim()||'#35445b';ctx.fillText(name.length>14?name.slice(0,13)+'…':name,256,50,480);
  const texture=new THREE.CanvasTexture(buffer);texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:true,transparent:true}));
  sprite.position.set(x,y,z);sprite.scale.set(4.3,0.84,1);sprite.visible=showNames;parent.add(sprite);labelSprites.push(sprite);
}
function polygonSurface(room,color,opacity=1){const shape=new THREE.Shape(),points=M.vertices(room);shape.moveTo(points[0].x,-points[0].z);points.slice(1).forEach(p=>shape.lineTo(p.x,-p.z));shape.closePath();const mesh=new THREE.Mesh(new THREE.ShapeGeometry(shape),new THREE.MeshStandardMaterial({color,roughness:.9,transparent:opacity<1,opacity,side:THREE.DoubleSide}));mesh.rotation.x=-Math.PI/2;return mesh;}
function staffFigure(parent,actor){
  const figure=new THREE.Group(),color=window.FacilityStaff.COLORS[actor.role];
  const body=new THREE.Mesh(new THREE.CylinderGeometry(.16,.22,.62,6),new THREE.MeshStandardMaterial({color,roughness:.8}));body.position.y=.72;figure.add(body);
  const head=new THREE.Mesh(new THREE.SphereGeometry(.17,8,6),new THREE.MeshStandardMaterial({color:'#e6c8b0',roughness:.8}));head.position.y=1.2;figure.add(head);
  const legs=[];for(const sign of [-1,1]){const leg=new THREE.Mesh(new THREE.BoxGeometry(.12,.43,.15),new THREE.MeshStandardMaterial({color:'#536171'}));leg.position.set(sign*.11,.25,0);figure.add(leg);legs.push(leg);}
  const arm=new THREE.Mesh(new THREE.BoxGeometry(.48,.1,.13),new THREE.MeshStandardMaterial({color}));arm.position.y=.86;figure.add(arm);parent.add(figure);figure.userData.legs=legs;return figure;
}
function prepareStaff(f,group){const motion=window.FacilityStaff.create(project,f);for(const actor of motion.actors)actor.mesh=group?staffFigure(group,actor):null;staffFloors.push({floor:f,group,motion});}
function updateStaff(dt){
  const active=staff?.active()&&!drawing&&!document.hidden;let moved=false;
  for(const entry of staffFloors){if(active&&entry.motion.actors.length){entry.motion.tick?.(dt,staff.speed());moved=true;}for(const a of entry.motion.actors){if(!a.mesh)continue;a.mesh.position.set(a.x,.08+(a.walking&&active?Math.sin(a.phase*2)*.025:0),a.z);a.mesh.rotation.y=a.heading;a.mesh.userData.legs.forEach((leg,i)=>leg.rotation.x=a.walking&&active?Math.sin(a.phase+i*Math.PI)*.45:0);}}
  const residentMoved=residents?.update(dt),total=staffFloors.reduce((n,f)=>n+f.motion.actors.length,0),configured=staffFloors.reduce((n,{floor:f})=>n+(f.staff||[]).reduce((s,r)=>s+r.count,0),0),text=`예시 · 직원 ${total}명${total<configured?' · 이동 공간 없음 '+(configured-total)+'명':''} · ${residents?.summary()||'어르신 자료 미연결'}`;
  if($('staff-status').textContent!==text)$('staff-status').textContent=text;
  if(fallback)drawStaffFallback();return moved||residentMoved;
}
function drawStaffFallback(){const layer=$('staff-canvas');layer.hidden=false;const w=viewport.clientWidth,h=viewport.clientHeight;layer.width=w*devicePixelRatio;layer.height=h*devicePixelRatio;const ctx=layer.getContext('2d');ctx.scale(devicePixelRatio,devicePixelRatio);if(!fallbackBounds||drawing)return;const {left,top,scale}=fallbackBounds;for(const entry of staffFloors)for(const a of entry.motion.actors){const x=left+(a.x+project.width/2)*scale,y=top+(a.z+project.depth/2)*scale;ctx.fillStyle=window.FacilityStaff.COLORS[a.role];ctx.beginPath();ctx.arc(x,y,4.5,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.stroke();}residents?.fallback(ctx,fallbackBounds);}
function roomWalls(group,room,height,door) {
  if(!showWalls||mode==='plan'||room.type==='corridor'||room.type==='garden')return;
  if(room.type==='living'||window.FacilityResidents.bathroom(room)){for(const [a,b]of window.FacilityResidents.walls(room,door)){const wall=box(group,Math.hypot(b.x-a.x,b.z-a.z),height,.14,(a.x+b.x)/2,height/2+.08,(a.z+b.z)/2,'#f6f7f8');wall.rotation.y=-Math.atan2(b.z-a.z,b.x-a.x);}return;}
  if(room.points){const v=M.vertices(room);v.forEach((a,i)=>{const b=v[(i+1)%v.length],wall=box(group,Math.hypot(b.x-a.x,b.z-a.z),height,.14,(a.x+b.x)/2,height/2+.08,(a.z+b.z)/2,'#f6f7f8');wall.rotation.y=-Math.atan2(b.z-a.z,b.x-a.x);});return;}
  const t=0.14,{x,z,w,d}=room,c='#f6f7f8';
  box(group,t,height,d,x-w/2,height/2+0.08,z,c);box(group,t,height,d,x+w/2,height/2+0.08,z,c);
  const entryZ=z<0?z+d/2:z-d/2,backZ=z<0?z-d/2:z+d/2,gap=Math.min(1.25,w*0.45),part=(w-gap)/2;
  box(group,w,height,t,x,height/2+0.08,backZ,c);
  box(group,part,height,t,x-(gap+part)/2,height/2+0.08,entryZ,c);box(group,part,height,t,x+(gap+part)/2,height/2+0.08,entryZ,c);
}
function furnishings(group,room,beds) {
  if(window.FacilityResidents.bathroom(room))return;
  if(room.type==='living'){
    if(mode==='plan')return;
    for(const bed of beds||[]){const furniture=new THREE.Group();group.add(furniture);furniture.position.set(bed.x,0,bed.z);furniture.scale.setScalar(bed.scale);
      box(furniture,1.08,.25,2.05,0,.37,0,'#a6b6c6');box(furniture,1.03,.2,1.98,0,.60,0,'#fffefd');
      box(furniture,.98,.05,1.15,0,.73,.28,'#bfd1df');box(furniture,.74,.1,.38,0,.76,-.67,'#ffffff');box(furniture,1.1,.8,.12,0,.47,-1,'#96a9b9');}
    return;
  }
  if(mode==='plan'||room.type==='unknown'||room.type==='corridor'||room.type==='garden'||room.points)return;
  const furniture=new THREE.Group();group.add(furniture);group=furniture;
  const {w,d,type,name}=room,x=0,z=0;
  if(type==='core') {
    if(name.includes('계단'))for(let i=0;i<7;i++)box(group,Math.min(Math.max(0.5,w-0.5),2.1),0.12+i*0.15,0.40,x,0.08+(0.12+i*0.15)/2,z-1.2+i*0.4,'#b2bdc9');
    else box(group,Math.min(Math.max(0.5,w-0.7),2.4),1.45,0.14,x,0.80,z-d/2+0.25,'#aab8c9');
  } else if(type==='office'||type==='nursing') {
    box(group,2,0.12,0.9,x,0.85,z,'#c8b8a2');box(group,0.16,0.75,0.75,x-0.80,0.43,z,'#bec8d0');box(group,0.16,0.75,0.75,x+0.80,0.43,z,'#bec8d0');
    box(group,0.55,0.40,0.06,x,1.10,z-0.15,'#53677d');box(group,0.6,0.45,0.6,x,0.31,z+1.1,'#b2bfce');
  } else if(['common','program','lounge','therapy'].includes(type)) {
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
  residents?.begin();
  if(fallback){staffFloors=[];prepareStaff(floor(),null);residents?.prepare(floor(),null);drawFallback();updateStaff(0);return;}
  if(!scene)return;
  generation++;const revision=generation;
  if(root){scene.remove(root);dispose(root);}if(preview){scene.remove(preview);dispose(preview);preview=null;}
  root=new THREE.Group();scene.add(root);floorGroups=[];pickTargets=[];labelSprites=[];staffFloors=[];$('floor-labels').replaceChildren();$('observation-markers').replaceChildren();$('observation-lines').replaceChildren();observationAnchors=[];
  const visible=(mode==='floor'||mode==='plan')?[floor()]:project.floors;
  const observationMarkers=window.FacilityObservation.spaceMarkers(project,observation.mapped(),mode,selectedFloor);
  visible.forEach(f=>{
    const group=new THREE.Group(),elevation=(mode==='floor'||mode==='plan')?0:M.floorIndex(f.level)*(project.height+(mode==='exploded'?3.8:0));
    group.position.y=elevation;root.add(group);floorGroups.push({floor:f,group});
    const activity=residents.motion(f);
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
      const tile=polygonSurface(r,chosen?'#aebce4':M.COLORS[r.type],(mode==='plan'&&f.image)?0.42:1);
      tile.position.y=.065;tile.receiveShadow=true;tile.userData={level:f.level,id:r.id};group.add(tile);pickTargets.push(tile);
      roomWalls(group,r,mode==='building'?1.5:1.0,activity.doors.get(r.id));furnishings(group,r,activity.beds.get(r.id));
      if(mode==='building'||mode==='exploded'){const anchor=M.anchor(r);nameSprite(group,r.name,anchor.x,1.22,anchor.z);}
      if(chosen) {
        const points=M.vertices(r).map(p=>new THREE.Vector3(p.x,0.11,p.z));
        group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:'#4356ad'})));
      }
    });
    prepareStaff(f,group);
    residents.prepare(f,group);
    if(mode==='building')exterior(group,f.level);
    const marker=make('div','f3-floor-marker'+(f.level===selectedFloor?' is-selected':''));marker.append(make('b','',M.floorCode(f.level)),make('span','',f.name));$('floor-labels').append(marker);
    group.userData.marker=marker;
    for(const targets of observationMarkers.filter(t=>t.level===f.level).sort((a,b)=>Number(b.hasSummary??true)-Number(a.hasSummary??true))){
      const badge=observationBadge(targets);$('observation-markers').append(badge);
      observationAnchors.push({group,x:targets.x,z:targets.z,y:targets.kind==='floor'?.55:mode==='plan'?.3:1.8,badge,line:observationLine(targets),kind:targets.kind,hasSummary:targets.hasSummary});
    }
  });
  if(mode==='building'&&showWalls) {
    const y=M.verticalBounds(project).top;
    box(root,project.width+0.6,0.28,project.depth+0.6,0,y-0.1,0,'#d7e0e7');
    box(root,project.width+0.6,0.5,0.16,0,y+0.15,-project.depth/2,'#e7ecf0');
    box(root,0.16,0.5,project.depth+0.6,-project.width/2,y+0.15,0,'#e7ecf0');
    box(root,3.2,1.1,3.2,project.width/2-3,y+0.6,0,'#e6ebef');
  }
  const baseElevation=(mode==='building'||mode==='exploded')?M.verticalBounds(project,mode==='exploded').bottom:0;
  if(mode!=='plan')box(root,project.width+4,0.3,project.depth+4,0,baseElevation-0.45,0,'#e2e8e6');updateStaff(0);
  if(grid){scene.remove(grid);grid.geometry.dispose();grid.material.dispose();}
  const gridSize=Math.max(project.width,project.depth)*2;
  grid=new THREE.GridHelper(gridSize,Math.round(gridSize/2),'#d3dce6','#dce4eb');grid.position.y=baseElevation-0.62;grid.material.transparent=true;grid.material.opacity=0.6;scene.add(grid);
  if(drawing)drawPreview(previewEnd);
}
function fitCamera() {
  if(!camera){if(fallback)drawFallback();return;}
  const aggregate=mode==='building'||mode==='exploded',bounds=M.verticalBounds(project,mode==='exploded');
  const height=aggregate?bounds.height:1;
  const targetY=aggregate?bounds.bottom+height*0.48:0,aspect=viewport.clientWidth/viewport.clientHeight;
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
  if(targets.kind==='floor'){
    const badge=make('button','f3-observation-marker f3-floor-summary-marker f3-risk-normal');badge.type='button';
    badge.append(make('strong','',`${M.floorCode(targets.level)} · ${targets.roomName}`));
    const row=make('span','f3-floor-summary-counts');row.append(occupancyIcon(),make('b','',targets.occupancy==null?'—':String(targets.occupancy)),make('span',targets.focus?'f3-risk-focus':'',`집중 ${targets.focus}`),make('span',targets.watch?'f3-risk-watch':'',`주의 ${targets.watch}`));badge.append(row);
    badge.setAttribute('aria-label',`${M.floorName(targets.level)} ${targets.roomName} · ${targets.occupancy==null?'현원 미연결':'현원 '+targets.occupancy+'명'} · 집중 ${targets.focus}명 · 주의 ${targets.watch}명 · 3D 층 요약 보기`);
    badge.onclick=()=>observation.open(targets);return badge;
  }
  const risk=targets.focus?'focus':targets.watch?'watch':'normal',badge=make('div','f3-observation-marker'+(targets.kind==='space'?' f3-space-marker':'')+' f3-risk-'+risk);
  badge.dataset.roomId=targets.roomId||'';
  if(targets.kind==='space'){
    const name=make('button','f3-space-name',targets.roomName);name.type='button';name.title=targets.roomName;name.setAttribute('aria-label',`${M.floorName(targets.level)} ${targets.roomName} · 공간 선택`);name.hidden=!showNames;name.onclick=()=>selectRoom(targets.level,targets.roomId);badge.append(name);
    if(!targets.hasSummary)return badge;
  }
  const counts=make('div','f3-space-counts');badge.append(counts);
  const count=make('button','f3-occupancy-button');if(targets.roomId){count.append(occupancyIcon(),make('b','',targets.occupancy==null?'—':String(targets.occupancy)));}else count.textContent='위치 확인';count.type='button';const countLabel=targets.occupancy!=null?`현원 ${targets.occupancy}명`:(targets.roomId?'현원 미연결':'위치 확인');count.setAttribute('aria-label',`${M.floorName(targets.level)} ${targets.roomName} · ${countLabel}`);count.title=`${targets.roomName} · ${countLabel}`;count.onclick=()=>observation.open(targets);counts.append(count);
  if(targets.focus||targets.watch){const alert=make('button','f3-alert-button');alert.type='button';alert.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9v5m0 3v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';alert.append(make('span','',String(targets.focus+targets.watch)));const label=`${M.floorName(targets.level)} ${targets.roomName} · 집중 ${targets.focus}명 · 주의 ${targets.watch}명 · 생활실 정보 보기`;alert.title=label;alert.setAttribute('aria-label',label);alert.onclick=()=>observation.open(targets);counts.append(alert);}
  return badge;
}
function occupancyIcon(){const icon=make('span','f3-occupancy-icon');icon.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 21v-3a7 7 0 0 1 14 0v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';return icon;}
function observationLine(targets){const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.dataset.tier=targets.focus?'focus':targets.watch?'watch':'normal';$('observation-lines').append(line);return line;}
function placeObservation(a,x,y,w,h,used){
  const chosen=window.FacilityObservation.markerPosition(x,y,a.badge.offsetWidth||140,a.badge.offsetHeight||60,w,h,used);
  used.push(chosen);a.badge.style.left=chosen.cx+'px';a.badge.style.top=chosen.cy+'px';
  a.line.setAttribute('x1',x);a.line.setAttribute('y1',y);a.line.setAttribute('x2',chosen.cx);a.line.setAttribute('y2',chosen.cy);
}
function updateMarkers() {
  const w=viewport.clientWidth,h=viewport.clientHeight;
  for(const {group} of floorGroups) {
    const p=group.localToWorld(new THREE.Vector3(-project.width/2-0.8,0.55,project.depth/2+0.9)).project(camera),marker=group.userData.marker;
    const x=(p.x+1)*w/2,y=(1-p.y)*h/2;
    marker.hidden=observationAnchors.some(a=>a.group===group&&a.kind==='floor')||p.z>1||p.z<-1||x<10||x>w-10||y<10||y>h-10;
    marker.style.left=x+'px';marker.style.top=y+'px';
  }
  const used=observationReserved();
  for(const a of observationAnchors){
    const p=a.group.localToWorld(new THREE.Vector3(a.x,a.y,a.z)).project(camera),x=(p.x+1)*w/2,y=(1-p.y)*h/2;
    a.badge.hidden=drawing||(a.kind==='space'&&!showNames&&!a.hasSummary)||(a.kind==='floor'&&matchMedia('(max-width:500px)').matches)||p.z>1||p.z<-1||x<0||x>w||y<0||y>h;
    a.line.style.display=a.badge.hidden?'none':'';if(!a.badge.hidden)placeObservation(a,x,y,w,h,used);
  }
}
function observationReserved(){if(drawing)return [];const panel=$('observation-details').hidden?$('observation-open'):$('observation-details'),b=viewport.getBoundingClientRect();return [panel,document.querySelector('.f3-view-caption'),...$('floor-labels').children].filter(el=>!el.hidden).map(el=>{const a=el.getBoundingClientRect();return {left:a.left-b.left,right:a.right-b.left,top:a.top-b.top,bottom:a.bottom-b.top};});}
function pointer(event) {
  const bounds=canvas.getBoundingClientRect();return {x:((event.clientX-bounds.left)/bounds.width)*2-1,y:1-((event.clientY-bounds.top)/bounds.height)*2};
}
function groundPoint(event) {
  if(fallback){const p=fallbackPoint(event);return p;}
  raycaster.setFromCamera(pointer(event),camera);const p=new THREE.Vector3();
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-0.08),p)?{x:p.x,z:p.z}:null;
}
function drawPreview(end) {
  previewEnd=end;
  if(fallback){drawFallback(end);return;}
  if(preview){scene.remove(preview);dispose(preview);}
  preview=new THREE.Group();let points=[];
  if(drawingShape==='rectangle'){if(startPoint&&end)points=M.vertices(M.rectangle(startPoint,end,project));}
  else{points=drawingPoints.slice();if(end&&(!points.length||Math.hypot(end.x-points.at(-1).x,end.z-points.at(-1).z)>.1))points.push(end);}
  const pts=points.map(p=>new THREE.Vector3(p.x,.18,p.z));if(pts.length>1)preview.add(new (pts.length>2?THREE.LineLoop:THREE.Line)(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:'#4356ad',depthTest:false})));
  if(points.length>=3){try{const shape=M.polygon(points,project),fill=polygonSurface(shape,'#4356ad',.22);fill.position.y=.17;preview.add(fill);}catch{}}
  for(const p of drawingPoints){const dot=new THREE.Mesh(new THREE.SphereGeometry(.13,8,6),new THREE.MeshBasicMaterial({color:'#4356ad',depthTest:false}));dot.position.set(p.x,.2,p.z);preview.add(dot);}scene.add(preview);needsRender=true;
}
canvas.addEventListener('pointerdown',event=>{downPoint={x:event.clientX,y:event.clientY};});
canvas.addEventListener('pointerup',event=>{
  if(!downPoint||Math.hypot(event.clientX-downPoint.x,event.clientY-downPoint.y)>6)return;
  downPoint=null;
  if(drawing) {
    const point=groundPoint(event);if(!point)return;
    if(Math.abs(point.x)>project.width/2||Math.abs(point.z)>project.depth/2){status('건물 바닥 안에 모서리를 지정해주세요.','error');return;}
    canvas.focus();
    if(drawingShape==='polygon'){
      if(drawingPoints.length>=3&&Math.hypot(point.x-drawingPoints[0].x,point.z-drawingPoints[0].z)<.5){finishPolygon();return;}
      const p={x:Math.round(point.x*4)/4,z:Math.round(point.z*4)/4};if(drawingPoints.length&&Math.hypot(p.x-drawingPoints.at(-1).x,p.z-drawingPoints.at(-1).z)<.1)return;
      if(drawingPoints.length>=32){status('점은 최대 32개까지 지정할 수 있습니다. 공간 완성을 눌러주세요.','error');return;}drawingPoints.push(p);drawPreview(null);renderUI();status(`점 ${drawingPoints.length}개를 지정했습니다. 첫 점을 다시 클릭하거나 공간 완성을 눌러 닫으세요.`);return;
    }
    if(!startPoint){startPoint=point;status('반대쪽 모서리를 클릭하면 공간이 만들어집니다.');return;}
    try {finishRoom(M.rectangle(startPoint,point,project));}
    catch(error){startPoint=null;if(preview){scene?.remove(preview);dispose(preview);preview=null;}status(error.message,'error');needsRender=true;}
    return;
  }
  if(fallback) {
    const p=fallbackPoint(event),room=floor().rooms.find(r=>M.contains(r,p));if(room)selectRoom(selectedFloor,room.id);return;
  }
  raycaster.setFromCamera(pointer(event),camera);const hit=raycaster.intersectObjects(pickTargets)[0];if(hit)selectRoom(hit.object.userData.level,hit.object.userData.id);
});
canvas.addEventListener('pointermove',event=>{
  if(drawing){if(startPoint||drawingPoints.length){const p=groundPoint(event);if(p)drawPreview(p);}return;}
  if(fallback||!raycaster)return;
  raycaster.setFromCamera(pointer(event),camera);const hit=raycaster.intersectObjects(pickTargets)[0],label=$('hover-label');
  if(!hit){label.hidden=true;return;}
  const data=hit.object.userData,room=project.floors.find(f=>f.level===data.level)?.rooms.find(r=>r.id===data.id);const bounds=canvas.getBoundingClientRect();
  label.textContent=M.floorName(data.level)+' · '+room.name;label.hidden=false;label.style.left=Math.max(8,Math.min(bounds.width-150,event.clientX-bounds.left+12))+'px';label.style.top=Math.max(8,event.clientY-bounds.top-35)+'px';
});
canvas.addEventListener('pointerleave',()=>{$('hover-label').hidden=true;});
canvas.addEventListener('dblclick',event=>{if(drawing&&drawingShape==='polygon'){event.preventDefault();finishPolygon();}});
canvas.addEventListener('keydown',event=>{
  if(event.key==='Escape'){cancelDrawing();renderUI();return;}
  if(drawing&&event.key==='Enter'){event.preventDefault();finishPolygon();return;}
  if(drawing&&event.key==='Backspace'){event.preventDefault();$('drawing-undo').click();return;}
  if(drawing)return;
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
      ctx.beginPath();M.vertices(r).forEach((p,i)=>{const x=left+(p.x+project.width/2)*scale,y=top+(p.z+project.depth/2)*scale;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.closePath();ctx.globalAlpha=floor().image?0.55:1;ctx.fillStyle=r.id===selectedRoom?'#aebce4':M.COLORS[r.type];ctx.fill();ctx.globalAlpha=1;
      if(showWalls){ctx.strokeStyle='#8293a8';ctx.stroke();}if(showNames&&drawing){const a=M.anchor(r);ctx.fillStyle='#35445b';ctx.font='11px system-ui';ctx.textAlign='center';ctx.fillText(r.name,left+(a.x+project.width/2)*scale,top+(a.z+project.depth/2)*scale,Math.max(5,r.w*scale-4));}
    });
    if(startPoint&&end){const r=M.rectangle(startPoint,end,project);ctx.strokeStyle='#4356ad';ctx.lineWidth=2;ctx.strokeRect(left+(r.x+project.width/2-r.w/2)*scale,top+(r.z+project.depth/2-r.d/2)*scale,r.w*scale,r.d*scale);}
    if(drawingPoints.length){const points=drawingPoints.slice();if(end)points.push(end);ctx.beginPath();points.forEach((p,i)=>{const x=left+(p.x+project.width/2)*scale,y=top+(p.z+project.depth/2)*scale;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});if(points.length>=3){ctx.closePath();ctx.fillStyle='#4356ad33';ctx.fill();}ctx.strokeStyle='#4356ad';ctx.lineWidth=2;ctx.stroke();for(const p of drawingPoints){ctx.beginPath();ctx.arc(left+(p.x+project.width/2)*scale,top+(p.z+project.depth/2)*scale,4,0,Math.PI*2);ctx.fillStyle='#4356ad';ctx.fill();}}
  };
  if(floor().image){const image=floor().image,img=new Image();img.onload=()=>{if(revision!==fallbackRevision)return;let iw=project.width*scale,ih=iw/image.aspect;if(ih>project.depth*scale){ih=project.depth*scale;iw=ih*image.aspect;}ctx.drawImage(img,left+(project.width*scale-iw)/2,top+(project.depth*scale-ih)/2,iw,ih);paint();};img.src=image.src;}else paint();
  $('floor-labels').replaceChildren();
  $('observation-markers').replaceChildren();$('observation-lines').replaceChildren();const used=observationReserved();
  if(!drawing)for(const targets of window.FacilityObservation.spaceMarkers(project,observation.mapped(),mode,selectedFloor).sort((a,b)=>Number(b.hasSummary??true)-Number(a.hasSummary??true))){const badge=observationBadge(targets);badge.hidden=targets.kind==='space'&&!showNames&&!targets.hasSummary;$('observation-markers').append(badge);const line=observationLine(targets);line.style.display=badge.hidden?'none':'';if(!badge.hidden)placeObservation({badge,line},left+(targets.x+project.width/2)*scale,top+(targets.z+project.depth/2)*scale,w,h,used);}
}
document.querySelector('.facility3d-main').inert=true;saveControls();renderUI();await loadShared(true);document.querySelector('.facility3d-main').inert=false;if(loadError&&!projects.length)status(loadError,'error');
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
  let lastFrame=performance.now();function animate(now){requestAnimationFrame(animate);const dt=(now-lastFrame)/1000;lastFrame=now;if(!visible)return;if(updateStaff(dt))needsRender=true;controls.update();if(needsRender){renderer.render(scene,camera);updateMarkers();needsRender=false;}}
  requestAnimationFrame(animate);
} catch(error) {
  renderer?.dispose();renderer=null;camera=null;controls=null;
  fallback=true;mode='plan';$('viewer-loading').hidden=true;
  if(canvas.getContext('2d')===null){fallbackCanvas=document.createElement('canvas');fallbackCanvas.className='f3-fallback-canvas';fallbackCanvas.setAttribute('aria-hidden','true');viewport.append(fallbackCanvas);}
  status('이 브라우저는 3D 표시를 지원하지 않아 선택 층을 2D 평면으로 표시합니다.','warning');
  document.querySelectorAll('[data-mode]').forEach(button=>{if(button.dataset.mode!=='plan')button.disabled=true;});
  renderUI();rebuild();let previous=performance.now();function animateFallback(now){requestAnimationFrame(animateFallback);const dt=(now-previous)/1000;previous=now;updateStaff(dt);}requestAnimationFrame(animateFallback);
}
new ResizeObserver(resize).observe(viewport);
new ResizeObserver(()=>{needsRender=true;if(fallback)drawFallback();}).observe($('observation-details'));
observation.load();
setInterval(()=>{if(!document.hidden&&!drawing)loadShared();},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!drawing)loadShared();});
