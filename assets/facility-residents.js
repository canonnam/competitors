export function initResidents(ctx){
  const R=window.FacilityResidents,$=id=>document.getElementById(id),cache=new Map();
  let entries=[],projectId=null,shown=true,elapsed=1;
  function motion(floor){
    const project=ctx.project(),result=ctx.observations(),stamp=R.signature(project,floor,result);
    if(project.id!==projectId){projectId=project.id;cache.clear();}
    const previous=cache.get(floor.id);if(previous?.stamp===stamp)return previous.motion;
    const next=R.create(project,floor,result);cache.set(floor.id,{stamp,motion:next});return next;
  }
  function figure(parent,actor){
    const T=ctx.three(),root=new T.Group(),color=R.COLORS[actor.tier];
    function mesh(geometry,color,x,y,z,parent=root){const m=new T.Mesh(geometry,new T.MeshStandardMaterial({color,roughness:.85}));m.position.set(x,y,z);m.castShadow=true;parent.add(m);return m;}
    mesh(new T.CylinderGeometry(.14,.20,.45,8),color,0,.72,0);
    mesh(new T.SphereGeometry(.15,10,8),'#e4c4a7',0,1.06,.015);
    mesh(new T.SphereGeometry(.158,10,8,0,Math.PI*2,0,Math.PI/2),'#cbd0d2',0,1.07,.015);
    const legs=[],arms=[];
    for(const sign of [-1,1]){
      const hip=new T.Group();hip.position.set(sign*.09,.49,0);root.add(hip);
      mesh(new T.BoxGeometry(.12,.25,.14),'#647176',0,-.125,0,hip);
      const knee=new T.Group();knee.position.y=-.25;hip.add(knee);
      mesh(new T.BoxGeometry(.11,.24,.13),'#647176',0,-.12,0,knee);legs.push({hip,knee});
      const arm=new T.Group();arm.position.set(sign*.21,.9,0);root.add(arm);
      mesh(new T.BoxGeometry(.085,.32,.1),color,0,-.16,0,arm);arms.push(arm);
    }
    const chair=new T.Group();root.add(chair);
    const chairColor=actor.tier==='normal'?'#bdcbbf':'#d2d8de';
    mesh(new T.BoxGeometry(.5,.1,.48),chairColor,0,.43,.02,chair);
    mesh(new T.BoxGeometry(.5,.42,.08),chairColor,0,.70,-.19,chair);
    for(const x of [-.19,.19])mesh(new T.BoxGeometry(.07,.38,.07),'#86998e',x,.19,.03,chair);
    const toilet=new T.Group();root.add(toilet);
    mesh(new T.CylinderGeometry(.21,.13,.35,12),'#f7f8f7',0,.25,0,toilet);
    const rim=mesh(new T.TorusGeometry(.18,.04,6,12),'#f7f8f7',0,.45,0,toilet);rim.rotation.x=Math.PI/2;
    mesh(new T.BoxGeometry(.43,.45,.15),'#e6eae9',0,.65,-.25,toilet);
    chair.visible=false;toilet.visible=false;root.userData={legs,arms,chair,toilet};parent.add(root);return root;
  }
  function prepare(floor,group){const m=motion(floor);for(const actor of m.actors)actor.mesh=group?figure(group,actor):null;entries.push({floor,motion:m});return m;}
  function summary(){
    if(!shown)return '어르신 숨김';
    const connected=entries.some(e=>e.motion.connected),total=entries.reduce((n,e)=>n+e.motion.summary.total,0),lying=entries.reduce((n,e)=>n+e.motion.summary.lying,0);
    return connected?`어르신 ${total}명${lying?' · 누움 예시 '+lying+'명':''}`:'어르신 자료 미연결';
  }
  function help(){
    const counts={walk:0,seated:0,bathroom:0,lying:0,idle:0};let uncertain=0,noRoute=0;
    for(const e of entries){uncertain+=e.motion.summary.uncertain;noRoute+=e.motion.summary.noRoute;for(const a of e.motion.actors)counts[a.pose]++;}
    const text=`걷기 ${counts.walk} · 복도 휴식 ${counts.seated} · 화장실 ${counts.bathroom} · 누움 ${counts.lying}${uncertain?' · 등급 확인 필요 '+uncertain+'명':''}${noRoute?' · 외부 동선 미연결 '+noRoute+'명':''}`;
    if($('resident-activity-summary').textContent!==text)$('resident-activity-summary').textContent=text;
  }
  function update(dt){
    const active=shown&&ctx.playing()&&!ctx.drawing()&&!document.hidden;let animated=false;
    for(const entry of entries){if(active){entry.motion.tick(dt,ctx.speed());if(entry.motion.actors.some(a=>!a.fixed))animated=true;}
      for(const a of entry.motion.actors){
        const mesh=a.mesh;if(!mesh)continue;mesh.visible=shown&&!ctx.drawing();
        const lying=a.pose==='lying'&&a.bed,seated=a.pose==='seated'||a.pose==='bathroom',scale=lying?a.bed.scale:1;
        mesh.scale.setScalar(scale);mesh.position.set(a.x,lying?.84*scale:.08,a.z+(lying?.58*scale:0));mesh.rotation.set(lying?-Math.PI/2:0,lying?0:a.heading,0);
        mesh.userData.chair.visible=a.pose==='seated';mesh.userData.toilet.visible=a.pose==='bathroom';
        mesh.userData.legs.forEach(({hip,knee},i)=>{hip.rotation.x=seated?-Math.PI/2:active&&a.walking?Math.sin(a.phase+i*Math.PI)*.32:0;knee.rotation.x=seated?Math.PI/2:0;});
        mesh.userData.arms.forEach((arm,i)=>arm.rotation.x=active&&a.walking?Math.sin(a.phase+i*Math.PI)*-.24:seated?-.35:0);
      }
    }
    elapsed+=dt;if(elapsed>=1||dt===0){help();elapsed=0;}return animated;
  }
  function fallback(canvas,bounds){
    if(!shown||ctx.drawing())return;
    const project=ctx.project();for(const entry of entries)for(const a of entry.motion.actors){const x=bounds.left+(a.x+project.width/2)*bounds.scale,y=bounds.top+(a.z+project.depth/2)*bounds.scale;
      canvas.fillStyle=R.COLORS[a.tier];canvas.strokeStyle='#fff';canvas.lineWidth=1;
      if(a.pose==='lying'){canvas.fillRect(x-4,y-7,8,14);canvas.strokeRect(x-4,y-7,8,14);}else{canvas.beginPath();canvas.arc(x,y,a.pose==='seated'||a.pose==='bathroom'?4:5,0,Math.PI*2);canvas.fill();canvas.stroke();}
    }
  }
  $('resident-toggle').onclick=()=>{shown=!shown;$('resident-toggle').setAttribute('aria-pressed',String(shown));ctx.updated();};
  window.addEventListener('pagehide',()=>cache.clear());
  return {motion,prepare,begin(){entries=[];},update,summary,fallback};
}
