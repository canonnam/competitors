(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let selected = '';
  function status(text, kind) { const node = $('eval-status'); node.textContent = text; if (kind) node.dataset.status = kind; else node.removeAttribute('data-status'); }
  function lock() { $('eval-app').hidden = true; $('eval-lock').hidden = false; $('eval-key').value = ''; }
  async function api(path, options = {}) {
    const response = await fetch(path, {cache: 'no-store', credentials: 'same-origin', ...options});
    const body = await response.json();
    if (!response.ok) { if (response.status === 401) lock(); throw Error(body.error || '요청을 처리하지 못했습니다.'); }
    return body;
  }
  function support(path, options) { return api('/api/support/' + path, options); }
  function itemButton(row) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-button';
    const name = document.createElement('strong');
    name.textContent = row.name + ' · ' + row.branch_label;
    const state = document.createElement('span');
    state.textContent = row.status_label + (row.needs_human ? ' · 사람 확인 필요' : '');
    const scores = document.createElement('small');
    scores.textContent = '자동 ' + (row.auto_score == null ? '—' : row.auto_score) + ' · 확정 ' + (row.confirmed_score == null ? '—' : row.confirmed_score);
    button.append(name, state, scores);
    button.addEventListener('click', () => openDetail(row.id));
    return button;
  }
  async function refresh() {
    const branch = $('eval-filter').value;
    const data = await api('/api/support/staff-eval' + (branch ? '?branch=' + encodeURIComponent(branch) : ''));
    const list = $('eval-list');
    list.replaceChildren();
    $('eval-empty').hidden = data.evaluations.length > 0;
    data.evaluations.forEach(row => list.append(itemButton(row)));
    return data;
  }
  function bubble(message) {
    const node = document.createElement('div');
    node.className = 'eval-bubble ' + (message.role === 'staff' ? 'is-staff' : 'is-assistant');
    const who = document.createElement('span');
    who.textContent = message.role === 'staff' ? '종사자' : '평가';
    node.append(who, document.createTextNode(message.text));
    return node;
  }
  async function openDetail(id) {
    selected = id;
    const row = await api('/api/support/staff-eval/detail?id=' + encodeURIComponent(id));
    $('eval-detail').hidden = false;
    $('eval-detail-title').textContent = row.name + ' · ' + row.status_label;
    $('eval-detail-meta').textContent = row.role + ' · ' + row.branch_label + ' · 만료 ' + row.expires;
    $('eval-review').hidden = false;
    $('eval-review').textContent = row.needs_human ? '사람 확인 필요' : '자동 채점 초안';
    $('eval-review').dataset.status = row.needs_human ? 'warning' : 'success';
    $('eval-auto').textContent = row.auto_score == null ? '—' : String(row.auto_score);
    $('eval-confirmed').textContent = row.confirmed_score == null ? '—' : String(row.confirmed_score);
    $('eval-gemini').textContent = row.gemini_score == null ? '—' : String(row.gemini_score);
    $('eval-gemini-note').textContent = row.gemini_note || '';
    $('eval-score').value = row.confirmed_score == null ? '' : String(row.confirmed_score);
    $('eval-confirm').querySelector('button[type="submit"]').disabled = row.status !== 'completed';
    const body = $('eval-items');
    body.replaceChildren();
    (row.items || []).forEach(item => {
      const tr = document.createElement('tr');
      [item.code, item.title, item.score, item.steps.map(step => (step.met ? '충족' : '빠짐') + ' ' + step.label).join(', '), item.order_ok ? '맞음' : '확인'].forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        tr.append(cell);
      });
      body.append(tr);
    });
    const transcript = $('eval-transcript');
    transcript.replaceChildren();
    if (!row.transcript.length) transcript.append('아직 대화가 없습니다.');
    row.transcript.forEach(message => transcript.append(bubble(message)));
    $('eval-detail').scrollIntoView({block: 'nearest'});
  }
  $('eval-login').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    status('로그인 중…');
    try {
      await support('login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({key: $('eval-key').value})});
      $('eval-key').value = '';
      $('eval-lock').hidden = true;
      $('eval-app').hidden = false;
      await refresh();
      status('평가 링크를 만들 수 있습니다.', 'success');
    } catch (error) { status(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  $('eval-create').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    status('링크를 만드는 중…');
    try {
      const created = await api('/api/support/staff-eval/create', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
        name: $('eval-name').value, branch: $('eval-branch').value, birthdate: $('eval-birth').value,
        employee_hint: $('eval-hint').value, expiry_hours: Number($('eval-hours').value)
      })});
      $('eval-link').value = location.origin + created.url;
      $('eval-created').hidden = false;
      $('eval-create').reset();
      $('eval-hours').value = '72';
      await refresh();
      status('평가 링크를 만들었습니다. 종사자에게 전달하세요.', 'success');
    } catch (error) { status(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  $('eval-copy').addEventListener('click', async () => {
    const value = $('eval-link').value;
    try { await navigator.clipboard.writeText(value); status('링크를 복사했습니다.', 'success'); }
    catch { $('eval-link').select(); status('링크를 길게 눌러 복사해 주세요.', 'warning'); }
  });
  $('eval-filter').addEventListener('change', () => refresh().catch(error => status(error.message, 'error')));
  $('eval-logout').addEventListener('click', async () => {
    try { await support('logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}); lock(); status('로그아웃되었습니다.'); }
    catch (error) { status(error.message, 'error'); }
  });
  $('eval-confirm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selected) return;
    const raw = $('eval-score').value.trim();
    const payload = {id: selected};
    if (raw !== '') payload.score = Number(raw);
    try {
      await api('/api/support/staff-eval/confirm', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
      await refresh();
      await openDetail(selected);
      status('점수를 확정했습니다.', 'success');
    } catch (error) { status(error.message, 'error'); }
  });
  $('eval-retake').addEventListener('click', async () => {
    if (!selected || !window.confirm('대화와 점수를 지우고 같은 링크로 다시 응시하게 할까요?')) return;
    try {
      await api('/api/support/staff-eval/retake', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: selected, expiry_hours: 72})});
      await refresh();
      await openDetail(selected);
      status('다시 응시할 수 있게 초기화했습니다.', 'success');
    } catch (error) { status(error.message, 'error'); }
  });
  support('session').then(async session => {
    if (!session.authenticated) { lock(); status(session.configured ? '담당자 접근 키로 로그인해주세요.' : '담당자 접근 키 설정이 필요합니다.', session.configured ? '' : 'warning'); return; }
    $('eval-lock').hidden = true;
    $('eval-app').hidden = false;
    await refresh();
    status('평가 링크를 만들거나 결과를 확인하세요.', 'success');
  }).catch(error => status(error.message, 'error'));
})();
