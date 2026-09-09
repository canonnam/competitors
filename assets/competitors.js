/* Enhance the static research page without inventing scores or financial estimates. */
(() => {
  'use strict';
  const data = window.competitorData;
  const roles = {
    operations: {name:'기관 운영', keys:['easy','carefor','ecm','angel','allcare','jipangi','salary','maeum','yoyangsys']},
    assist: {name:'업무보조·교육', keys:['planner','well','aicareplus']},
    monitor: {name:'안부·안전 돌봄', keys:['hyodol','happy','skt']},
    care: {name:'돌봄 운영·매칭', keys:['caring','caredoc']},
    safety: {name:'시설 낙상·이상감지', keys:['cleverus','inzinious','spacebank']}
  };
  const roleOf = Object.fromEntries(Object.entries(roles).flatMap(([role, group]) => group.keys.map(key => [key, role])));
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const evidenceSources = item => (item.sources || [[item.src, item.url]]).map(([label,url]) => source(url,label)).join('<br>');
  const normalize = value => value.normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g,' ').trim();
  const selected = new Set();
  const cards = [...document.querySelectorAll('#cards > .card')].map(element => {
    const key = element.querySelector('[data-compare]').dataset.compare;
    element.dataset.key = key;
    element.classList.add(`tone-${roleOf[key]}`);
    element.querySelector('.tag').textContent = roles[roleOf[key]].name;
    element.querySelector('[data-compare]').hidden = false;
    // Search product facts rather than revenue-source boilerplate.
    const searchable = normalize([data[key].n, ...data[key].facts.flat(), data[key].note, element.querySelector('.pills').textContent].join(' '));
    return {key, element, searchable};
  });
  const fact = (key, labels) => data[key].facts.find(([label]) => labels.includes(label))?.[1] || '공개 확인 불가';
  const source = (url, label) => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>`;
  const priceEvidence = price => `${escape(price.checked)} 재확인 · ${escape(price.v)}<br>${source(price.s,'공식 가격 근거')}${(price.links || []).map(([label,url]) => ' · ' + source(url,label)).join('')}`;
  function filterCards() {
    const role = $('role-filter').value;
    const terms = normalize($('service-search').value).split(' ').filter(Boolean);
    let visible = 0;
    cards.forEach(card => {
      const match = (role === 'all' || roleOf[card.key] === role) && terms.every(term => card.searchable.includes(term));
      card.element.hidden = !match;
      if (match) visible++;
    });
    $('result-count').textContent = `${visible} / ${cards.length}개 서비스${role === 'all' ? '' : ' · ' + roles[role].name}`;
    $('empty-state').hidden = visible !== 0;
    document.querySelectorAll('[data-role]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.role === role)));
  }
  function resetFilters() {
    $('service-search').value = '';
    $('role-filter').value = 'all';
    filterCards();
    $('service-search').focus();
  }
  $('explorer-controls').hidden = false;
  $('service-search').addEventListener('input', filterCards);
  $('role-filter').addEventListener('change', filterCards);
  $('reset-filters').addEventListener('click', resetFilters);
  $('empty-reset').addEventListener('click', resetFilters);
  document.querySelectorAll('[data-role]').forEach(button => button.addEventListener('click', () => {
    $('role-filter').value = button.dataset.role;
    $('service-search').value = '';
    filterCards();
    $('explorer').scrollIntoView({block:'start', behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    $('service-search').focus({preventScroll:true});
  }));
  function renderSelection(message = '') {
    $('compare-tray').hidden = selected.size === 0;
    document.body.classList.toggle('has-selection', selected.size > 0);
    $('selection-count').textContent = `비교 ${selected.size} / 3`;
    $('selected-services').innerHTML = [...selected].map(key => `<button type="button" data-remove="${key}" aria-label="${escape(data[key].n)} 비교에서 제외">${escape(data[key].n)}<span aria-hidden="true">×</span></button>`).join('');
    $('open-comparison').disabled = selected.size < 2;
    $('selection-status').textContent = message || (selected.size === 1 ? '서비스를 하나 더 선택하면 나란히 비교할 수 있습니다.' : '필터를 바꿔도 선택한 서비스는 유지됩니다.');
    cards.forEach(({key,element}) => {
      const button = element.querySelector('[data-compare]');
      const active = selected.has(key);
      element.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.textContent = active ? '✓ 비교에 담김' : '+ 비교 담기';
      button.setAttribute('aria-label', `${data[key].n} ${active ? '비교에서 제외' : '비교에 담기'}`);
    });
  }
  function toggleSelection(key) {
    if (selected.has(key)) selected.delete(key);
    else if (selected.size >= 3) {
      $('selection-status').textContent = '최대 3개까지 비교할 수 있습니다. 선택한 서비스를 먼저 제외해주세요.';
      return;
    } else selected.add(key);
    renderSelection();
  }
  cards.forEach(({key,element}) => element.querySelector('[data-compare]').addEventListener('click', () => toggleSelection(key)));
  $('selected-services').addEventListener('click', event => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    const key = button.dataset.remove;
    selected.delete(key);
    renderSelection();
    // A removed chip no longer exists: return focus to a visible, useful control.
    const next = $('selected-services').querySelector('button');
    if (next) next.focus();
    else {
      const card = cards.find(card => card.key === key);
      (card.element.hidden ? $('service-search') : card.element.querySelector('[data-compare]')).focus();
    }
  });
  $('clear-selection').addEventListener('click', () => {selected.clear();renderSelection();$('service-search').focus();});

  function showDialog(dialog) { dialog.showModal(); document.body.style.overflow = 'hidden'; }
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => {if (!document.querySelector('dialog[open]')) document.body.style.overflow = '';});
    dialog.addEventListener('click', event => {
      const box = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
    });
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  window.openFeedback = () => showDialog($('feedbackModal'));
  window.closeFeedback = () => $('feedbackModal').close();
  window.closeDetail = () => $('modal').close();
  window.openDetail = key => {
    if (!data[key]) return;
    const item = data[key], price = item.price50;
    // The dedicated price panel contains the later, explicitly conditioned price research.
    const facts = item.facts.filter(([label]) => label !== '가격');
    $('sheet').innerHTML = `<span class="tag">${escape(roles[roleOf[key]].name)} · ${escape(item.type)}</span><h2 id="detail-title">${escape(item.n)}</h2><p class="small">근거: ${evidenceSources(item)}</p><dl class="facts">${facts.map(([label,value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl><section class="price-panel"><h3>가격과 도입 조건 · 50인 기준 검증</h3><p><strong>${escape(price.m)}</strong></p><p>${escape(price.o)}</p><p class="small">${escape(price.u)}</p><p class="price-basis">${escape(price.b)}</p><p class="small price-evidence">${priceEvidence(price)}</p></section><section class="revenue-detail"><h3>매출과 확인 근거</h3>${$('revenue-'+key).innerHTML}</section><h3>분석 메모</h3><p>${escape(item.note)}</p>${item.screenshot ? `<figure class="service-shot"><figcaption>서비스 화면 · 공식 사이트 캡처 (2026-09-07)</figcaption><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer"><img src="${escape(item.screenshot)}" alt="${escape(item.n)} 공식 사이트 화면" loading="lazy"></a></figure>` : '<p class="small">공식 서비스 화면 캡처 미수집</p>'}${item.functionShot ? `<figure class="function-shot"><figcaption>공개된 기능 사용 화면 · 공식 원본</figcaption><a href="${escape(item.functionShotSource)}" target="_blank" rel="noopener noreferrer"><img src="${escape(item.functionShot)}" alt="${escape(item.functionShotTitle)}" loading="lazy"></a></figure>` : ''}<p>${source(item.url,'공식 사이트 열기')}</p>`;
    showDialog($('modal'));
    $('modal').scrollTop = 0;
  };
  $('open-comparison').addEventListener('click', () => {
    if (selected.size < 2) return;
    const keys = [...selected];
    const rows = [
      ['주된 역할', key => escape(roles[roleOf[key]].name) + `<p>${escape(data[key].type)}</p>`],
      ['운영사', key => escape(fact(key,['운영사']))],
      ['공개 기능', key => escape(fact(key,['핵심 기능','핵심 공개 내용']))],
      ['감지 방식', key => escape(fact(key,['감지 방식']))],
      ['요양시설 도입', key => escape(fact(key,['요양시설 도입']))],
      ['도입 상태', key => escape(fact(key,['도입 상태']))],
      ['알림·대응', key => escape(fact(key,['알림·대응']))],
      ['50인 가정 가격', key => `<strong>${escape(data[key].price50.m)}</strong>`],
      ['초기 비용', key => escape(data[key].price50.o)],
      ['가격 적용 조건', key => escape(data[key].price50.u)],
      ['산출·검증 근거', key => escape(data[key].price50.b) + `<p>${priceEvidence(data[key].price50)}</p>`],
      ['도입·고객 지표', key => escape(fact(key,['고객수','고객/도입 지표']))],
      ['직영 기관 운영', key => escape(fact(key,['직영 기관 운영']))],
      ['운영사 매출', key => $('revenue-'+key).innerHTML],
      ['분석 메모', key => escape(data[key].note)],
      ['확인 출처', key => evidenceSources(data[key])]
    ];
    $('selection-table').innerHTML = `<caption class="small">선택한 ${keys.length}개 서비스 · 공개 자료 기준 비교</caption><thead><tr><th scope="col">비교 항목</th>${keys.map(key => `<th scope="col">${escape(data[key].n)}<p class="comparison-role">${escape(roles[roleOf[key]].name)}</p></th>`).join('')}</tr></thead><tbody>${rows.map(([label,render]) => `<tr><th scope="row">${label}</th>${keys.map(key => `<td>${render(key)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $('selection-table').style.minWidth = keys.length === 3 ? '860px' : '660px';
    showDialog($('comparison-dialog'));
    $('comparison-dialog').scrollTop = 0;
    document.querySelector('.comparison-scroll').scrollTop = 0;
    document.querySelector('.comparison-scroll').scrollLeft = 0;
  });
  filterCards();
  renderSelection();
})();
