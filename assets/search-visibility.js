(function(root){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function safeUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
  function fresh(item){return item.status==='ready'&&!item.stale;}
  function stateLabel(item){if(item.status==='unconfigured')return '연결 필요';if(item.status==='error')return '측정 불가';if(item.status==='running')return '측정 중';if(item.status==='unverified')return '검색 근거 부족';return '갱신 대기';}
  function matchLabel(item,areas){
    if(!fresh(item))return stateLabel(item);
    const found=(item.matches||[]).filter(row=>areas.includes(row.area)).sort((a,b)=>a.page-b.page||a.position-b.position)[0];
    return found?`${found.page}페이지 · ${found.position}번째`:'측정 범위 내 미확인';
  }
  function filterRows(items,query='',filter='all'){return items.filter(item=>item.keyword.includes(query.trim())&&(filter==='all'||(filter==='found'&&fresh(item)&&item.mentioned)||(filter==='absent'&&fresh(item)&&!item.mentioned)||(filter==='pending'&&!fresh(item))));}
  function homeSummary(data){
    const naver=data.providers.find(p=>p.id==='naver'),ai=data.providers.filter(p=>p.kind==='ai'&&p.configured);
    const checked=ai.reduce((sum,p)=>sum+p.checked,0),mentioned=ai.reduce((sum,p)=>sum+p.mentioned,0);
    const parts=[naver?.checked?`네이버 첫 페이지 ${naver.first_page}/${naver.checked}개`:naver?.items.some(item=>item.status==='error')?'네이버 측정 불가':'네이버 측정 대기',checked?`AI 언급 ${mentioned}/${checked}건`:'AI 측정 대기'];
    return {text:parts.join(' · '),warning:!data.enabled||data.keyword_source.stale||data.providers.some(p=>!p.configured||p.checked<p.expected)};
  }
  function citedAnswer(item){
    const text=item.answer||'',citations=item.citations||[],ends=new Map();
    citations.forEach((c,i)=>{if(!safeUrl(c.url))return;const end=Math.max(0,Math.min(text.length,Number(c.end)||text.length));if(!ends.has(end))ends.set(end,[]);ends.get(end).push([c,i+1]);});
    let out='',previous=0;
    [...ends].sort((a,b)=>a[0]-b[0]).forEach(([end,list])=>{out+=esc(text.slice(previous,end));out+=list.map(([c,n])=>`<a class="visibility-citation" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer" title="${esc(c.title)}">[${n}]</a>`).join('');previous=end;});
    return out+esc(text.slice(previous));
  }
  const api={safeUrl,fresh,stateLabel,matchLabel,filterRows,homeSummary,citedAnswer};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.SearchVisibility=api;
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id),date=value=>value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'미측정';
  const tag=(text,tone='')=>`<span class="visibility-tag ${tone}">${esc(text)}</span>`;
  const areaName={web:'웹문서',place:'플레이스',ad:'파워링크 광고',place_ad:'플레이스 광고'};
  let current,markdownRenderer;
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
  function history(item){return `<div class="visibility-history" aria-label="최근 관측 기록">${(item.history||[]).slice().reverse().map(day=>`<span class="visibility-day ${day.mentioned?'is-found':''}" title="${esc(date(day.at))} · ${day.mentioned?'노출 확인':'미확인'}" aria-label="${esc(date(day.at))} ${day.mentioned?'노출 확인':'미확인'}"></span>`).join('')}</div><span class="visibility-small">${(item.history||[]).length}회 관측 · 초록색은 브랜드 노출 확인</span>`;}
  function overview(){
    $('visibility-overview').innerHTML=current.providers.map(p=>{
      const ai=p.kind==='ai',metric=!p.configured?'연결 필요':!p.checked?(p.items.some(item=>item.status==='error')?'측정 불가':'측정 대기'):`${ai?p.mentioned:p.first_page}<small> / ${p.checked}</small>`;
      return `<article class="visibility-metric ${!p.checked?'is-pending':''}"><h2>${esc(p.id==='openai'?'ChatGPT 계열 · OpenAI API':p.name)}</h2><strong>${metric}</strong><p>${ai?'검색 답변에서 브랜드 언급':'첫 페이지에서 웹·플레이스 노출'}<br>${p.configured?`${p.expected}개 중 ${p.checked}개 정상 측정`:'API 연결 후 매일 측정'}</p></article>`;
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
    $('visibility-keyword-source').textContent=`인천 광고 계정 · 등록 키워드 ${provider.expected}개 · 키워드 목록 ${date(current.keyword_source.updated_at)} · 최대 ${current.max_pages}페이지 확인`;
    $('visibility-keywords').innerHTML=rows.map(item=>{
      const matches=(item.matches||[]),links=matches.map(m=>`<li>${esc(areaName[m.area])} ${m.page}페이지 ${m.position}번째 · ${m.owned?'공식 주소':'브랜드 언급'}<br><a href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener noreferrer">${esc(m.title)}</a></li>`).join('');
      const cells=[['web'],['place'],['ad','place_ad']].map(areas=>`<td>${tag(matchLabel(item,areas),!fresh(item)?'is-warning':matches.some(m=>areas.includes(m.area))?'':'is-absent')}</td>`).join('');
      return `<tr><td><details${opened.has(item.keyword)?' open':''}><summary>${esc(item.keyword)}</summary><span class="visibility-small">${esc(item.query.groups?.join(' · ')||'')}</span>${item.error?`<p class="visibility-small">${esc(item.error)}</p>`:''}${!fresh(item)&&item.observed_at?`<p class="visibility-small">아래는 ${esc(date(item.observed_at))}의 이전 결과입니다.</p>`:''}<ul class="visibility-evidence">${links||'<li>저장된 브랜드 노출 결과 없음</li>'}</ul><div class="visibility-pages">${(item.evidence||[]).map(p=>`<a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener noreferrer">${p.page}페이지 원문</a>`).join('')}</div>${history(item)}</details></td>${cells}<td>${Number.isFinite(item.query.average_ad_rank)?item.query.average_ad_rank.toLocaleString('ko-KR',{maximumFractionDigits:1})+'위':'정보 없음'}<span class="visibility-small">페이지 환산하지 않음${item.query.eligible?'':' · 집행 제한'}</span></td><td>${esc(date(item.observed_at))}${!fresh(item)?'<span class="visibility-small">정상 집계에서 제외</span>':''}</td></tr>`;
    }).join('')||'<tr><td colspan="6">조건에 맞는 키워드가 없습니다.</td></tr>';
  }
  function drawAI(){
    const opened=new Set([...$('visibility-ai-grid').querySelectorAll('.visibility-ai-card')].filter(el=>el.querySelector('details[open]')).map(el=>el.querySelector('h3').textContent));
    const provider=current.providers.find(p=>p.id===$('visibility-provider').value);
    $('visibility-ai-status').textContent=provider.configured?`${provider.model} · ${provider.expected}개 질문 중 ${provider.checked}개 정상 측정 · ${provider.mentioned}개 답변에서 브랜드 언급`:`${provider.name}은 API 연결 후 측정을 시작합니다. 아직 노출 여부를 판단할 수 없습니다.`;
    $('visibility-ai-grid').innerHTML=provider.items.map(item=>{
      const label=fresh(item)?(item.mentioned?'브랜드 언급':'브랜드 미언급'):stateLabel(item);
      const tone=!fresh(item)?'is-warning':item.mentioned?'':'is-absent';
      const citations=(item.citations||[]).filter(c=>safeUrl(c.url));
      return `<article class="visibility-ai-card"><div class="visibility-ai-top"><h3>${esc(item.keyword)}</h3>${tag(label,tone)}</div><p>${esc(date(item.observed_at))}${item.answer?` · ${esc(item.model)}${item.owned_cited?' · 공식 주소 인용':''}`:''}${item.error?'<br>'+esc(item.error):''}</p>${item.answer?`<details${opened.has(item.keyword)?' open':''}><summary>실제 답변과 검색 근거 보기</summary>${!fresh(item)?'<p class="visibility-small">정상 집계에서 제외된 이전 관측 또는 근거 부족 답변입니다.</p>':''}<div class="visibility-answer${markdownRenderer?' is-markdown':''}">${answerHtml(item)}</div><ol class="visibility-citations">${citations.map(c=>`<li><a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a></li>`).join('')}</ol>${(item.search_suggestions||[]).map(s=>`<iframe class="visibility-suggestions" title="Google 검색 제안" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${esc(s.html)}"></iframe>`).join('')}<p class="visibility-small">보낸 질문: ${esc(item.prompt)}</p></details>`:'<p>수집된 답변이 없습니다.</p>'}${history(item)}</article>`;
    }).join('');
  }
  function render(data){current=data;overview();drawNaver();drawAI();const measured=current.providers.reduce((s,p)=>s+p.checked,0);$('visibility-run').textContent=`${current.enabled?current.schedule:'자동 수집 중지'} · 정상 측정 ${measured}건 · 다음 점검 ${date(current.next_run)}`;}
  async function refresh(){
    const home=$('home-visibility-status');
    try{const response=await fetch('/api/search-visibility'+(home?'?summary=1':''),{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('request');const data=await response.json();if(home){const value=homeSummary(data);home.textContent=value.text;home.className='visibility-home-status'+(value.warning?' is-warning':'');}else render(data);}
    catch{if(home){home.textContent='검색노출 현황 연결 확인 필요';home.className='visibility-home-status is-warning';}else{$('visibility-run').textContent='저장 결과를 불러오지 못했습니다. 잠시 후 새로고침해주세요.';if(current){current.providers.forEach(p=>{p.items.forEach(item=>{item.stale=true;item.status='error';});p.checked=0;p.mentioned=0;p.first_page=0;});overview();drawNaver();drawAI();}}}
  }
  if($('visibility-keywords')){['visibility-search','visibility-filter'].forEach(id=>$(id).addEventListener(id.endsWith('search')?'input':'change',()=>{if(current)drawNaver();}));$('visibility-provider').addEventListener('change',()=>{if(current)drawAI();});$('visibility-refresh').addEventListener('click',refresh);}
  if($('home-visibility-status')||$('visibility-keywords')){refresh();document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});setInterval(()=>{if(!document.hidden)refresh();},60000);}
})(globalThis);
