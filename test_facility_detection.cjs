const test=require('node:test'),assert=require('node:assert/strict');
const D=require('./assets/facility-3d-detect.js'),M=require('./assets/facility-3d-model.js');
function raster(w=600,h=400) {
  const data=new Uint8ClampedArray(w*h*4);data.fill(255);
  const line=(x1,y1,x2,y2,color=20)=>{for(let y=Math.min(y1,y2);y<=Math.max(y1,y2);y++)for(let x=Math.min(x1,x2);x<=Math.max(x1,x2);x++){const p=(y*w+x)*4;data[p]=data[p+1]=data[p+2]=color;}};
  const rectangle=(x,y,width,height)=>{line(x,y,x+width,y);line(x,y+height,x+width,y+height);line(x,y,x,y+height);line(x+width,y,x+width,y+height);};
  return {width:w,height:h,data,line,rectangle};
}
test('door gaps close into six rooms plus a corridor; outside and page margins stay excluded',()=>{
  const img=raster();img.rectangle(30,30,540,340);img.line(30,175,570,175);img.line(30,225,570,225);
  for(const x of [210,390]){img.line(x,30,x,175);img.line(x,225,x,370);}
  for(const y of [175,225])for(const x of [120,300,480])img.line(x-7,y,x+7,y,255);
  const {regions}=D.detect(img);
  assert.equal(regions.length,7);
  assert.ok(regions.every(r=>r.left>.04&&r.left+r.width<.96&&r.top>.05&&r.top+r.height<.95));
  assert.equal(D.detect(img,{gap:0}).regions.length,1); // Open doors connect the floor into one region.
});
test('blank images and isolated short text marks produce no room',()=>{
  const img=raster();assert.equal(D.detect(img).regions.length,0);
  for(let x=80;x<200;x+=15)img.rectangle(x,150,8,12);
  assert.equal(D.detect(img).regions.length,0);
});
test('furniture rectangles inside a closed room do not create overlapping room proposals',()=>{
  const img=raster();img.rectangle(40,40,520,320);img.rectangle(100,100,100,70);
  assert.equal(D.detect(img).regions.length,1);
});
test('room names map by their actual position and dimensions or page headings cannot name rooms',()=>{
  const regions=[{left:.1,top:.1,width:.3,height:.4},{left:.6,top:.1,width:.3,height:.4}];
  const labels=[{text:'201호 생활실',x:.25,y:.25,confidence:85},{text:'사무실',x:.75,y:.25,confidence:100},
    {text:'3,600',x:.25,y:.3,confidence:100},{text:'1층 평면도',x:.75,y:.35,confidence:100},{text:'주방',x:.5,y:.8,confidence:95}];
  const named=D.mapLabels(regions,labels);
  assert.deepEqual(named.map(r=>[r.name,r.type]),[['201호 생활실','living'],['사무실','office']]);
  assert.equal(D.mapLabels(regions,[{text:'식당',x:.25,y:.25,confidence:10}])[0].type,'unknown');
});
test('project coordinates use the same image aspect fit as the 3D overlay',()=>{
  const project=M.blank({width:24,depth:16}),region={left:.5,top:.5,width:.25,height:.25,name:'복도',type:'corridor'};
  const [room]=D.projectRooms([region],project,2,M.uid);
  assert.equal(room.w,6);assert.equal(room.d,3);assert.equal(room.x,3);assert.equal(room.z,1.5);
  assert.ok(M.inside(room,project));M.addRoom(project,1,room);assert.deepEqual(M.validate(project),project);
});
test('a unique OCR spelling suggestion is shown with its original; PDF text and custom names stay intact',()=>{
  const region={left:0,top:0,width:1,height:1};
  const proposed=D.mapLabels([region],[{text:'쌍담실',x:.5,y:.5,confidence:65}])[0];
  assert.equal(proposed.name,'상담실');assert.equal(proposed.original,'쌍담실');assert.equal(proposed.type,'office');
  assert.equal(D.mapLabels([region],[{text:'쌍담실',x:.5,y:.5,confidence:100}])[0].name,'쌍담실');
  assert.equal(D.labelInfo('햇살방',true).name,'햇살방');
});
test('PDF label coordinates survive export/import and invalid coordinates are rejected',()=>{
  const p=M.blank();p.floors[0].image={name:'plan.pdf',src:'data:image/png;base64,aGVsbG8=',aspect:1.5,labels:[{text:'식당',x:.5,y:.3,confidence:100}]};
  assert.deepEqual(M.validate(p),p);
  p.floors[0].image.labels[0].x=1.5;assert.throws(()=>M.validate(p),/글자 위치/);
});
