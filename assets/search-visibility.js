(function(root){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function safeUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
  function fresh(item){return item.status==='ready'&&!item.stale;}
  function stateLabel(item){if(item.status==='unconfigured')return '연결 필요';if(item.status==='error')return '측정 불가';if(item.status==='running')return '측정 중';if(item.status==='unverified')return '검색 근거 부족';return '갱신 대기';}
  function matchLabel(item,areas){
    if(!fresh(item))return stateLabel(item);
    if(areas.every(area=>['ad','place_ad'].includes(area))&&item.ad_coverage_complete===false)return '광고 재측정 대기';
    const found=(item.matches||[]).filter(row=>areas.includes(row.area)).sort((a,b)=>a.page-b.page||a.position-b.position)[0];
    return found?`${found.page}페이지 · ${found.position}번째`:(item.unconfirmed_matches||[]).some(row=>areas.includes(row.area))?'브랜드 노출 · 지점 미확인':'측정 범위 내 미확인';
  }
  function filterRows(items,query='',filter='all'){return items.filter(item=>item.keyword.includes(query.trim())&&(filter==='all'||(filter==='found'&&fresh(item)&&item.mentioned)||(filter==='absent'&&fresh(item)&&!item.mentioned&&!item.branch_unconfirmed)||(filter==='unknown'&&fresh(item)&&item.branch_unconfirmed)||(filter==='pending'&&!fresh(item))));}
  function scopeData(data,branch=''){
    if(!branch)return data;
    return {...data,selected_branch:branch,providers:data.providers.map(p=>{
      const items=p.items.filter(item=>item.branch===branch).map(item=>({...item,...item.branch_result}));
      const checked=items.filter(fresh);
      return {...p,items,expected:items.length,checked:checked.length,mentioned:checked.filter(item=>item.mentioned).length,first_page:checked.filter(item=>item.first_page===1).length};
    })};
  }
  function homeSummary(data){
    if(data.branches?.length){
      const lines=data.branches.map(branch=>{
        const scoped=scopeData(data,branch.id),naver=scoped.providers.find(p=>p.id==='naver'),ai=scoped.providers.filter(p=>p.kind==='ai'&&p.configured);
        const checked=ai.reduce((s,p)=>s+p.checked,0),mentioned=ai.reduce((s,p)=>s+p.mentioned,0);
        return `${branch.name} · 네이버 첫 페이지(광고 제외) ${naver.checked?`${naver.first_page}/${naver.checked}개`:'측정 대기'} · AI API 언급 ${checked?`${mentioned}/${checked}건`:'측정 대기'}`;
      });
      return {text:lines.join('\n'),warning:!data.enabled||data.keyword_source.stale||data.providers.some(p=>!p.configured||p.checked<p.expected)};
    }
    const naver=data.providers.find(p=>p.id==='naver'),ai=data.providers.filter(p=>p.kind==='ai'&&p.configured);
    const checked=ai.reduce((sum,p)=>sum+p.checked,0),mentioned=ai.reduce((sum,p)=>sum+p.mentioned,0);
    const parts=[naver?.checked?`네이버 첫 페이지(광고 제외) ${naver.first_page}/${naver.checked}개`:naver?.items.some(item=>item.status==='error')?'네이버 측정 불가':'네이버 측정 대기',checked?`AI API 언급 ${mentioned}/${checked}건`:'AI 측정 대기'];
    return {text:parts.join(' · '),warning:!data.enabled||data.keyword_source.stale||data.providers.some(p=>!p.configured||p.checked<p.expected)};
  }
  function citedAnswer(item){
    const text=item.answer||'',citations=item.citations||[],ends=new Map();
    citations.forEach((c,i)=>{if(!safeUrl(c.url))return;const end=Math.max(0,Math.min(text.length,Number(c.end)||text.length));if(!ends.has(end))ends.set(end,[]);ends.get(end).push([c,i+1]);});
    let out='',previous=0;
    [...ends].sort((a,b)=>a[0]-b[0]).forEach(([end,list])=>{out+=esc(text.slice(previous,end));out+=list.map(([c,n])=>`<a class="visibility-citation" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer" title="${esc(c.title)}">[${n}]</a>`).join('');previous=end;});
    return out+esc(text.slice(previous));
  }
  const api={safeUrl,fresh,stateLabel,matchLabel,filterRows,scopeData,homeSummary,citedAnswer};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.SearchVisibility=api;
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id),date=value=>value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'미측정';
  const tag=(text,tone='')=>`<span class="visibility-tag ${tone}">${esc(text)}</span>`;
  const areaName={web:'웹문서',place:'플레이스',ad:'파워링크 광고',place_ad:'플레이스 광고'};
  let current,unfiltered,markdownRenderer;
  const selectedName=()=>current.branches?.find(b=>b.id===current.selected_branch)?.name;
  function answerHtml(item){
    const content=citedAnswer(item);
    return markdownRenderer?markdownRenderer(content):content;
  }
  if($('visibility-ai-grid'))Promise.all([import('/assets/vendor/marked.esm.js'),import('/assets/vendor/purify.es.mjs')]).then(([{marked},{default:purify}])=>{
    markdownRenderer=content=>purify.sanitize(marked.parse(content),{
      ALLOWED_TAGS:['p','br','strong','em','ul','ol','li','h1','h2','h3','h4','blockquote','a','code'],
      ALLOWED_ATTR:['href','title','target','rel','class'],ALLOWED_URI_REGEXP:/^https?:\/\//i
    });
    if(current)drawAI();
  }).catch(()=>{});
  function history(item){return `<div class="visibility-history" aria-label="최근 관측 기록">${(item.history||[]).slice().reverse().map(day=>`<span class="visibility-day ${day.mentioned?'is-found':''}" title="${esc(date(day.at))} · ${day.mentioned?'노출 확인':'미확인'}" aria-label="${esc(date(day.at))} ${day.mentioned?'노출 확인':'미확인'}"></span>`).join('')}</div><span class="visibility-small">${(item.history||[]).length}회 ${item.query?.source?'관측':'API 표본'} · 초록색은 ${esc(selectedName()||'브랜드')} ${item.query?.source?'웹·플레이스 노출 확인(광고 제외)':'언급 확인'}</span>`;}
  function overview(){
    $('visibility-overview').innerHTML=current.providers.map(p=>{
      const ai=p.kind==='ai',metric=!p.configured?'연결 필요':!p.checked?(p.items.some(item=>item.status==='error')?'측정 불가':'측정 대기'):`${ai?p.mentioned:p.first_page}<small> / ${p.checked}</small>`;
      return `<article class="visibility-metric ${!p.checked?'is-pending':''}"><h2>${esc(p.id==='openai'?'OpenAI API 검색':p.name)}</h2><strong>${metric}</strong><p>${esc(selectedName()||'전체 지점')} · ${ai?'API 표본 속 언급':'첫 페이지 · 광고 제외'}<br>${p.configured?`${p.expected}개 중 ${p.checked}개 정상 측정`:'API 연결 후 매일 측정'}</p></article>`;
    }).join('');
    const naverError=current.providers.find(p=>p.id==='naver')?.items.find(item=>item.error)?.error;
    const aiErrors=current.providers.filter(p=>p.kind==='ai'&&p.configured).map(p=>{const error=p.items.find(item=>item.error)?.error;return error?`${p.name}: ${error}.`:'';}).filter(Boolean).join(' ');
    const missing=current.providers.filter(p=>!p.configured).map(p=>p.name.replace(' 검색 답변',''));
    $('visibility-notice').textContent=[aiErrors,naverError?`네이버: ${naverError}.`:'',missing.length?`${missing.join('·')}는 아직 API가 연결되지 않아 측정하지 않았습니다.`:'',!current.owned_urls.length?'공식 홈페이지·블로그 주소를 등록하면 자사 페이지 인용 여부도 구분할 수 있습니다.':'',current.keyword_source.stale?'광고 키워드 목록 갱신이 지연되어 이전 목록을 표시합니다.':''].filter(Boolean).join(' ');
  }
  function drawNaver(){
    const opened=new Set([...$('visibility-keywords').querySelectorAll('details[open] summary')].map(el=>el.textContent));
    const provider=current.providers.find(p=>p.id==='naver');
    const rows=filterRows(provider.items,$('visibility-search').value,$('visibility-filter').value);
    $('visibility-count').textContent=`${rows.length} / ${provider.items.length}개`;
    const adCount=provider.items.filter(item=>item.query.source==='ad_account').length,regionalCount=provider.items.filter(item=>item.query.source==='regional').length;
    $('visibility-keyword-source').textContent=[selectedName()||'전체 지점',adCount?`인천 광고 계정 ${adCount}개 · 목록 ${date(current.keyword_source.updated_at)}`:'',regionalCount?`안양 지역 점검 키워드 ${regionalCount}개 · 광고 계정 연동 키워드 아님`:'',`최대 ${current.max_pages}페이지 확인`].filter(Boolean).join(' · ');
    $('visibility-keywords').innerHTML=rows.map(item=>{
      const matches=(item.matches||[]),links=[...matches.map(m=>({...m,unconfirmed:false})),...(item.unconfirmed_matches||[]).map(m=>({...m,unconfirmed:true}))].map(m=>`<li>${esc(areaName[m.area])} ${m.page}페이지 ${m.position}번째 · ${m.unconfirmed?'브랜드 노출 · 지점 미확인':m.owned?'공식 주소':'브랜드 언급'}<br><a href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener noreferrer">${esc(m.title)}</a></li>`).join('');
      const cells=[['web'],['place'],['ad','place_ad']].map(areas=>`<td>${tag(matchLabel(item,areas),!fresh(item)||(areas.includes('ad')&&item.ad_coverage_complete===false)?'is-warning':matches.some(m=>areas.includes(m.area))?'':'is-absent')}</td>`).join('');
      return `<tr><td><details${opened.has(item.keyword)?' open':''}><summary>${esc(item.keyword)}</summary>${item.search_correction?`<p class="visibility-small">네이버 검색어 보정: ${esc(item.search_correction.from)} → ${esc(item.search_correction.to)}</p>`:''}<span class="visibility-small">${esc(current.branches?.find(b=>b.id===item.branch)?.name||'공통')} · ${item.query.source==='regional'?'지역 점검 키워드':'광고 계정 등록 키워드'}${item.query.groups?.length?' · '+esc(item.query.groups.join(' · ')):''}</span>${item.error?`<p class="visibility-small">${esc(item.error)}</p>`:''}${item.ad_coverage_complete===false?'<p class="visibility-small">첫 페이지 광고 수집 방식을 보완해 재측정 중입니다. 아래의 이전 광고 기록은 일부 누락될 수 있습니다.</p>':''}${!fresh(item)&&item.observed_at?`<p class="visibility-small">아래는 ${esc(date(item.observed_at))}의 이전 결과입니다.</p>`:''}<ul class="visibility-evidence">${links||'<li>저장된 브랜드 노출 결과 없음</li>'}</ul><div class="visibility-pages">${(item.evidence||[]).map(p=>`<a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener noreferrer">${p.page}페이지 원문</a>`).join('')}</div>${history(item)}</details></td>${cells}<td>${Number.isFinite(item.query.average_ad_rank)?item.query.average_ad_rank.toLocaleString('ko-KR',{maximumFractionDigits:1})+'위':item.query.source==='regional'?'해당 없음':'정보 없음'}<span class="visibility-small">${item.query.source==='regional'?'광고 계정 미연동':'페이지 환산하지 않음'+(item.query.eligible?'':' · 집행 제한')}</span></td><td>${esc(date(item.observed_at))}${!fresh(item)?'<span class="visibility-small">정상 집계에서 제외</span>':''}</td></tr>`;
    }).join('')||'<tr><td colspan="6">조건에 맞는 키워드가 없습니다.</td></tr>';
  }
  function drawAI(){
    const opened=new Set([...$('visibility-ai-grid').querySelectorAll('.visibility-ai-card')].filter(el=>el.querySelector('details[open]')).map(el=>el.querySelector('h3').textContent));
    const provider=current.providers.find(p=>p.id===$('visibility-provider').value);
    $('visibility-ai-status').textContent=provider.configured?`${selectedName()||'전체 지점'} · ${provider.model} · ${provider.expected}개 질문 중 ${provider.checked}개 정상 측정 · ${provider.mentioned}개 API 표본에서 ${selectedName()||'브랜드'} 언급`:`${provider.name}은 API 연결 후 측정을 시작합니다. 아직 노출 여부를 판단할 수 없습니다.`;
    $('visibility-ai-grid').innerHTML=provider.items.map(item=>{
      const label=fresh(item)?(item.mentioned?'API 표본에 언급':item.branch_unconfirmed?'API 표본 · 지점 미확인':'API 표본에 미언급'):stateLabel(item);
      const tone=!fresh(item)?'is-warning':item.mentioned?'':'is-absent';
      const citations=(item.citations||[]).filter(c=>safeUrl(c.url));
      return `<article class="visibility-ai-card"><div class="visibility-ai-top"><h3>${esc(item.keyword)}</h3>${tag(label,tone)}</div><p>${esc(date(item.observed_at))}${item.answer?` · ${esc(item.model)}${item.owned_cited?' · 공식 주소 인용':''}`:''}${item.error?'<br>'+esc(item.error):''}</p>${item.answer?`<details${opened.has(item.keyword)?' open':''}><summary>실제 답변과 검색 근거 보기</summary>${!fresh(item)?'<p class="visibility-small">정상 집계에서 제외된 이전 관측 또는 근거 부족 답변입니다.</p>':''}<div class="visibility-answer${markdownRenderer?' is-markdown':''}">${answerHtml(item)}</div><ol class="visibility-citations">${citations.map(c=>`<li><a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a></li>`).join('')}</ol>${(item.search_suggestions||[]).map(s=>`<iframe class="visibility-suggestions" title="Google 검색 제안" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${esc(s.html)}"></iframe>`).join('')}<p class="visibility-small">보낸 질문: ${esc(item.prompt)}</p></details>`:'<p>수집된 답변이 없습니다.</p>'}${history(item)}</article>`;
    }).join('');
  }
  function render(data){unfiltered=data;current=scopeData(data,$('visibility-branch').value);overview();drawNaver();drawAI();const measured=current.providers.reduce((s,p)=>s+p.checked,0);$('visibility-run').textContent=`${current.enabled?current.schedule:'자동 수집 중지'} · ${selectedName()||'전체 지점'} 정상 측정 ${measured}건 · 다음 점검 ${date(current.next_run)}`;}
  async function refresh(){
    const home=$('home-visibility-status');
    try{const response=await fetch('/api/search-visibility'+(home?'?summary=1':''),{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('request');const data=await response.json();if(home){const value=homeSummary(data);home.textContent=value.text;home.className='visibility-home-status'+(value.warning?' is-warning':'');}else render(data);}
    catch{if(home){home.textContent='검색노출 현황 연결 확인 필요';home.className='visibility-home-status is-warning';}else{$('visibility-run').textContent='저장 결과를 불러오지 못했습니다. 잠시 후 새로고침해주세요.';if(current){unfiltered.providers.forEach(p=>{p.items.forEach(item=>{item.stale=true;item.status='error';});p.checked=0;p.mentioned=0;p.first_page=0;});current=scopeData(unfiltered,$('visibility-branch').value);overview();drawNaver();drawAI();}}}
  }
  if($('visibility-keywords')){const branch=new URLSearchParams(location.search).get('branch');if(['incheon','anyang'].includes(branch))$('visibility-branch').value=branch;$('visibility-branch').addEventListener('change',()=>{if(unfiltered)render(unfiltered);});['visibility-search','visibility-filter'].forEach(id=>$(id).addEventListener(id.endsWith('search')?'input':'change',()=>{if(current)drawNaver();}));$('visibility-provider').addEventListener('change',()=>{if(current)drawAI();});$('visibility-refresh').addEventListener('click',refresh);}
  if($('home-visibility-status')||$('visibility-keywords')){refresh();document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});setInterval(()=>{if(!document.hidden)refresh();},60000);}
})(globalThis);
