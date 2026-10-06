const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const script=fs.readFileSync('assets/ui-help.js','utf8');
// Minimal DOM for lifecycle tests; browser QA covers layout and real focus behavior.
function fixture(){
  let observer;
  class Node{
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.attrs={};this.dataset={};this.style={};this.events={};this.hidden=false;this.open=false;this.tabIndex=0;}
    get isConnected(){return this===doc.body||!!this.parentElement?.isConnected;}
    append(...nodes){for(const n of nodes){n.remove();n.parentElement=this;this.children.push(n);}}
    remove(){if(this.parentElement){this.parentElement.children.splice(this.parentElement.children.indexOf(this),1);this.parentElement=null;}}
    before(n){const parent=this.parentElement,index=parent.children.indexOf(this);n.remove();n.parentElement=parent;parent.children.splice(index,0,n);}
    after(n){const parent=this.parentElement,index=parent.children.indexOf(this);n.remove();n.parentElement=parent;parent.children.splice(index+1,0,n);}
    replaceWith(n){this.before(n);this.remove();}
    contains(n){return n===this||this.children.some(child=>child.contains(n));}
    setAttribute(k,v){this.attrs[k]=String(v);}
    getAttribute(k){return this.attrs[k]??null;}
    addEventListener(k,f){(this.events[k]??=[]).push(f);}
    emit(k,extra={}){const event={target:this,preventDefault(){this.prevented=true;},stopPropagation(){},...extra};for(const f of this.events[k]||[])f(event);return event;}
    focus(){const old=doc.activeElement;doc.activeElement=this;old?.emit('blur',{relatedTarget:this});this.emit('focus');}
    matches(selector){return selector.split(',').some(raw=>{const s=raw.trim();if(s[0]==='#')return this.id===s.slice(1);if(s==='[data-ui-help]')return this.dataset.uiHelp!==undefined;if(s==='[tabindex]')return 'tabindex' in this.attrs;if(s==='dialog[open]')return this.tagName==='DIALOG'&&this.open;if(s==='a[href]')return this.tagName==='A'&&'href' in this.attrs;return this.tagName.toLowerCase()===s;});}
    closest(s){for(let n=this;n;n=n.parentElement)if(n.matches(s))return n;return null;}
    querySelectorAll(s){const out=[];for(const child of this.children){if(child.matches(s))out.push(child);out.push(...child.querySelectorAll(s));}return out;}
    querySelector(s){return this.querySelectorAll(s)[0]||null;}
    getBoundingClientRect(){return this.tagName==='BUTTON'?{left:20,top:20,bottom:60,width:40,height:40}:{left:0,top:0,width:280,height:140};}
    getClientRects(){for(let n=this;n;n=n.parentElement)if(n.hidden)return [];return [this.getBoundingClientRect()];}
  }
  const doc={body:new Node('body'),documentElement:{clientWidth:320},activeElement:null,events:{},createElement:tag=>new Node(tag),createComment:()=>new Node('comment'),querySelector(s){return this.body.querySelector(s);},querySelectorAll(s){return this.body.querySelectorAll(s);},addEventListener:Node.prototype.addEventListener,emit:Node.prototype.emit};
  const win={innerHeight:480,events:{},addEventListener:Node.prototype.addEventListener,emit:Node.prototype.emit};
  const section=new Node('section'),heading=new Node('h2'),first=new Node('p'),second=new Node('p'),next=new Node('input');
  heading.textContent='기능 제목';first.id='live-guide';
  first.dataset.uiHelp=second.dataset.uiHelp='사용 안내';section.append(heading,first,second,next);doc.body.append(section);
  const existing=new Node('button'),existingTip=new Node('div');existing.id='existing-help';existingTip.id='existing-tooltip';doc.body.append(existing,existingTip);
  function run(){vm.runInNewContext(script,{document:doc,window:win,MutationObserver:class{constructor(fn){observer=fn;}observe(){}},setTimeout,clearTimeout});}
  return {doc,win,Node,section,heading,first,second,next,existing,existingTip,run,mutate:()=>observer()};
}
test('groups explanations at the nearest heading, preserving live nodes and existing tooltips',()=>{
  const f=fixture();f.run();const button=f.heading.querySelector('button'),panel=f.doc.querySelector('#'+button.getAttribute('aria-controls'));
  assert.equal(f.heading.querySelectorAll('button').length,1);assert.ok(panel.contains(f.first)&&panel.contains(f.second));
  f.first.textContent='갱신된 안내';assert.equal(f.doc.querySelector('#live-guide'),f.first);assert.equal(f.doc.querySelector('#live-guide').textContent,'갱신된 안내');assert.equal(f.existing.parentElement,f.doc.body);assert.equal(f.existingTip.parentElement,f.doc.body);
  assert.equal(button.getAttribute('aria-describedby'),panel.id);assert.equal(panel.getAttribute('role'),'tooltip');assert.ok(panel.hidden);
});
test('different explanation labels share one icon per heading and retain their sections',()=>{
  const f=fixture(),third=new f.Node('p'),other=new f.Node('section'),otherHeading=new f.Node('h2'),otherSource=new f.Node('p');
  f.second.dataset.uiHelp='확인 기준';third.dataset.uiHelp='측정 범위';f.section.append(third);otherSource.dataset.uiHelp='다른 기능 안내';other.append(otherHeading,otherSource);f.doc.body.append(other);f.run();
  const b=f.heading.querySelector('button'),p=f.first.parentElement;
  assert.equal(f.heading.querySelectorAll('button').length,1);assert.equal(b.getAttribute('aria-label'),'기능 제목 안내');assert.ok(p.contains(f.first)&&p.contains(f.second)&&p.contains(third));
  assert.deepEqual(p.children.filter(n=>n.tagName==='STRONG').map(n=>n.textContent),['사용 안내','확인 기준','측정 범위']);
  assert.equal(otherHeading.querySelectorAll('button').length,1);assert.notEqual(otherSource.parentElement,p);
});
test('focus, click, Escape and outside click open and close a single tooltip',()=>{
  const f=fixture();f.run();const b=f.heading.querySelector('button'),p=f.doc.querySelector('#'+b.getAttribute('aria-controls'));
  b.focus();assert.equal(p.parentElement,f.doc.body);assert.equal(b.getAttribute('aria-expanded'),'true');b.emit('click');b.emit('click');assert.ok(p.hidden);
  b.emit('click');assert.ok(f.doc.emit('keydown',{key:'Escape'}).prevented);assert.ok(p.hidden);b.emit('click');f.doc.emit('pointerdown',{target:f.next});assert.ok(p.hidden);
});
test('print restores each source to its original position and details state, then remounts',()=>{
  const f=fixture(),details=new f.Node('details'),summary=new f.Node('summary');details.append(summary);details.dataset.uiHelp='기준';f.section.append(details);f.run();
  const panel=f.first.parentElement,order=[...panel.children];
  assert.ok(details.open);f.win.emit('beforeprint');assert.deepEqual(f.section.children.filter(n=>['P','DETAILS'].includes(n.tagName)),[f.first,f.second,details]);assert.equal(details.open,false);
  f.mutate();f.win.emit('afterprint');assert.ok(f.first.parentElement.getAttribute('role')==='tooltip');assert.ok(details.open);assert.equal(f.heading.querySelectorAll('button').length,1);assert.deepEqual(panel.children,order);
});
test('removing a dynamic section cleans its open tooltip and mounts replacement content',()=>{
  const f=fixture();f.run();f.heading.querySelector('button').emit('click');const old=f.first.parentElement;f.section.remove();
  const region=new f.Node('section'),heading=new f.Node('h2'),source=new f.Node('p');source.dataset.uiHelp='새 안내';region.append(heading,source);f.doc.body.append(region);f.mutate();
  assert.equal(old.isConnected,false);assert.equal(heading.querySelectorAll('button').length,1);assert.equal(source.parentElement.getAttribute('role'),'tooltip');
});
test('dialog tooltips stay in the top layer and their source links are keyboard reachable',()=>{
  const f=fixture(),dialog=new f.Node('dialog'),link=new f.Node('a');dialog.open=true;link.setAttribute('href','https://example.com/reference');f.first.append(link);dialog.append(f.section);f.doc.body.append(dialog);f.run();
  const b=f.heading.querySelector('button'),p=f.first.parentElement;b.focus();assert.equal(p.parentElement,dialog);
  assert.ok(b.emit('keydown',{key:'Tab',shiftKey:false}).prevented);assert.equal(f.doc.activeElement,link);
  p.emit('keydown',{key:'Tab',shiftKey:true});assert.equal(f.doc.activeElement,b);b.emit('keydown',{key:'Tab',shiftKey:false});p.emit('keydown',{key:'Tab',shiftKey:false});assert.equal(f.doc.activeElement,f.next);assert.ok(p.hidden);
  b.focus();b.emit('keydown',{key:'Tab',shiftKey:false});f.doc.emit('keydown',{key:'Escape'});assert.equal(f.doc.activeElement,b);assert.ok(p.hidden);
  b.emit('pointerenter',{pointerType:'mouse'});assert.ok(p.hidden);b.emit('pointerleave');b.emit('pointerenter',{pointerType:'mouse'});assert.equal(p.hidden,false);
});
