/* Shared monthly branch cards for the operating report and home dashboard. */
(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./operating-model.js'):root.OperatingModel);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.OperatingCards=api;
})(typeof window==='undefined'?globalThis:window,function(M){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=(v,d=1)=>v==null?'—':v.toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d});
  const money=v=>v==null?'자료 없음':num(v/10000)+'만원';
  const exact=v=>num(v,0)+'원';
  const pct=(v,base)=>base>0?num(v/base*100)+'%':'—';
  const tone=v=>v<0?'negative':v>0?'positive':'';
  function render(branch,m,previous) {
    const id=['anyang','incheon'].includes(branch.id)?branch.id:'',name=esc(branch.name);
    const heading=`<h3 class="location"><i class="${id}" aria-hidden="true"></i>${name}</h3>`;
    if(!m)return `<article class="branch-card ${id}">${heading}<p class="empty">이 달의 자료가 없습니다.</p></article>`;
    const p=previous?.month===M.previousMonth(m.month)?previous:null;
    const labor=M.groups(m,'expense')['인건비']||0;
    const cashNote=m.profit>=0&&m.cashChange<0?'운영에서는 남았지만, 상환·자금 이동으로 실제 자금은 줄었습니다.':m.profit<0&&m.cashChange>=0?'차입·자금 유입이 운영 적자를 보완하고 있습니다.':m.profit<0?`운영수입보다 비용이 ${money(-m.profit)} 많았습니다.`:`운영수입의 ${pct(m.profit,m.revenue)}가 남았습니다.`;
    return `<article class="branch-card ${id}"><div class="card-heading">${heading}<span class="badge ${m.profit<0?'loss':''}">${m.profit<0?'운영 적자':m.profit>0?'운영 흑자':'손익 균형'}</span></div><div class="profit-line"><strong class="${tone(m.profit)}" title="${exact(m.profit)}">${money(m.profit)}</strong><span>운영 손익</span></div><p class="change">${p?`전월보다 <b class="${tone(m.profit-p.profit)}">${money(Math.abs(m.profit-p.profit))} ${m.profit>=p.profit?'개선':'감소'}</b> · 손익률 ${pct(m.profit,m.revenue)}`:'전월 자료 없음 · 전월 대비 비교 불가'}</p><div class="mini-stats"><div><span>운영수입</span><strong title="${exact(m.revenue)}">${money(m.revenue)}</strong></div><div><span>운영비용</span><strong title="${exact(m.cost)}">${money(m.cost)}</strong></div><div><span>수입 대비 인건비</span><strong>${pct(labor,m.revenue)}</strong></div></div><p class="card-note">${cashNote}</p></article>`;
  }
  return {render};
});
