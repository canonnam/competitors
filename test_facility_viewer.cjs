const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const M=require('./assets/facility-3d-model.js');
// Execute the actual controller before WebGL boot with synthetic DOM and saved maps.
function controller(readOnly=true){
  const nodes=new Map(),calls=[],backups=[];
  function node(id){if(!nodes.has(id))nodes.set(id,{id,hidden:false,disabled:false,dataset:{},classList:{toggle(){}},style:{setProperty(){}},append(){},replaceChildren(){},setAttribute(k,v){this[k]=v;},addEventListener(){},matches(){return false;}});return nodes.get(id);}
  const modes=['building','exploded','floor','plan'].map(mode=>Object.assign(node(mode),{dataset:{mode}}));
  const ctx={window:{FacilityModel:M,FacilityViewer:{readOnly,active:()=>true,prepare(){}},addEventListener(){}},document:{addEventListener(){},getElementById:node,createElement:()=>node('new-'+nodes.size),querySelector:s=>s==='dialog[open]'?null:node(s),querySelectorAll:()=>modes},localStorage:{getItem(){return null;},setItem(k,v){backups.push(v);}},structuredClone,AbortController,setTimeout,clearTimeout,console,
    checkAccess(){},initFacilityUI:()=>({notify(){}}),initImport(){ctx.importMounted=true;},initObservation:()=>({mapped:()=>({floorTotals:[],groups:[]}),sync(){}}),initStaff:()=>({render(){}}),initResidents:()=>({begin(){}}),
    fetch:async(path,options)=>{calls.push({path,...options});if(ctx.failed)throw new Error('offline');return {ok:true,json:async()=>({projects:ctx.rows})};}};
  ctx.rows=[];ctx.globalThis=ctx;vm.createContext(ctx);
  const source=fs.readFileSync('assets/facility-3d.js','utf8').replace(/^import .*;\r?\n/gm,'').split("document.querySelector('.facility3d-main').inert=true;")[0];
  vm.runInContext(source+"\nglobalThis.api={loadShared,sharedRequest,save,changeMode,chooseFloor,selectRoom,cacheBackup,getProject:()=>project};",ctx);
  return {ctx,node,calls,backups,api:ctx.api};
}
function saved(name='안양점'){const p=M.sample();p.name=name;p.nursingHomeId=2;return {project:p,revision:3};}
test('viewer mounts no editing, importing, saving or deleting handlers',()=>{
  const {ctx,node}=controller();
  for(const id of ['save-project','new-project','edit-project','delete-project','undo-project','add-floor','delete-floor','add-room','delete-room','apply-floor-name','export-project','import-project'])assert.equal(node(id).onclick,undefined,id);
  for(const id of ['room-form','edit-project-form','new-floor-form','new-building-form'])assert.equal(node(id).onsubmit,undefined,id);
  assert.equal(ctx.importMounted,undefined);
  assert.equal(typeof node('view-floor-select').onchange,'function');assert.equal(typeof node('reset-view').onclick,'function');
});
test('viewer rejects all shared-map writes before sending a request',async()=>{
  const {api,calls,ctx}=controller();ctx.rows=[saved()];await api.loadShared(true);calls.length=0;
  await api.save();for(const method of ['POST','DELETE','PUT'])await assert.rejects(api.sharedRequest('',method,{}),/조회 전용/);
  assert.equal(calls.length,0);
});
test('saved maps can change views, select rooms and refresh without writes or browser backups',async()=>{
  const {api,ctx,calls,backups}=controller();ctx.rows=[saved()];await api.loadShared(true);
  const original=JSON.stringify(api.getProject());api.changeMode('exploded');api.chooseFloor(2);api.selectRoom(2,api.getProject().floors[1].rooms[0].id);api.changeMode('plan');
  assert.equal(JSON.stringify(api.getProject()),original);assert.ok(calls.every(c=>c.method==='GET'));assert.equal(backups.length,0);
  ctx.rows=[saved('최신 저장 건물')];ctx.rows[0].revision=4;await api.loadShared();assert.equal(api.getProject().name,'최신 저장 건물');
});
test('empty and failed saved-map reads never display an editable sample as a real facility',async()=>{
  const {api,ctx,node}=controller();await api.loadShared(true);assert.equal(node('.f3-workspace').hidden,true);assert.match(node('project-status').textContent,/저장된 시설 도면이 없습니다/);
  ctx.rows=[saved()];await api.loadShared();assert.equal(node('.f3-workspace').hidden,false);
  ctx.failed=true;await api.loadShared();assert.equal(node('.f3-workspace').hidden,false);assert.match(node('project-status').textContent,/이전 저장본/);
  const failed=controller();failed.ctx.failed=true;await failed.api.loadShared(true);assert.equal(failed.node('.f3-workspace').hidden,true);assert.equal(failed.node('project-status').dataset.status,'error');
});
test('standalone map continues mounting its existing editor and import flow',()=>{
  const {ctx,node}=controller(false);assert.equal(ctx.importMounted,true);assert.equal(typeof node('save-project').onclick,'function');assert.equal(typeof node('room-form').onsubmit,'function');
});

