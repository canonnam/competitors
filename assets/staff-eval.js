(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let selected = '', createdId = '', pendingDelete = null, deleteFocus = null, listRequest = 0, detailRequest = 0;
  function status(text, kind) { const node = $('eval-status'); node.hidden=!text; node.textContent = text; if (kind) node.dataset.status = kind; else node.removeAttribute('data-status'); }
  async function api(path, options = {}) {
    const response = await fetch(path, {cache: 'no-store', credentials: 'same-origin', ...options});
    const body = await response.json();
    if (!response.ok) throw Error(body.error || '요청을 처리하지 못했습니다.');
    return body;
  }
  function itemButton(row) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-button';
    button.classList.add('eval-open');
    button.disabled = !!row.deleted_at;
    const name = document.createElement('strong');
    name.textContent = row.name + ' · ' + row.branch_label;
    name.title = name.textContent;
    const state = document.createElement('span');
    state.className = 'ui-status';
    if (row.needs_human || row.status === 'expired') state.dataset.status = 'warning';
    else if (row.status === 'completed') state.dataset.status = 'success';
    state.textContent = row.deleted_at ? '삭제됨 · ' + row.status_label : row.status_label + (row.needs_human ? ' · 사람 확인 필요' : '');
    const scores = document.createElement('small');
    scores.textContent = '자동 ' + (row.auto_score == null ? '—' : row.auto_score) + ' · 확정 ' + (row.confirmed_score == null ? '—' : row.confirmed_score);
    button.append(name, scores, state);
    button.addEventListener('click', () => openDetail(row.id).catch(error=>status(error.message,'error')));
    return button;
  }
  async function refresh() {
    const request = ++listRequest;
    const branch = $('eval-filter').value;
    const query = new URLSearchParams({view:$('eval-list-view').value});
    if(branch)query.set('branch',branch);
    const data = await api('/api/support/staff-eval?' + query);
    if(request!==listRequest)return data;
    const list = $('eval-list');
    list.replaceChildren();
    $('eval-empty').hidden = data.evaluations.length > 0;
    $('eval-empty').textContent = $('eval-list-view').value === 'deleted' ? '삭제된 평가가 없습니다.' : '아직 만든 평가 링크가 없습니다. 위에서 링크를 생성하세요.';
    data.evaluations.forEach(row => {
      const item = document.createElement('li');
      item.append(itemButton(row));
      const action=document.createElement('button');action.type='button';action.className='ui-button ui-info-button eval-list-action';
      action.setAttribute('aria-label',row.name+' · '+row.branch_label+' 평가 '+(row.deleted_at?'복구':'삭제'));
      action.title=row.deleted_at?'평가 복구':'평가 삭제';
      action.innerHTML=row.deleted_at?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.5 6.2M3 4v7h7"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/></svg>';
      action.addEventListener('click',()=>row.deleted_at?restore(row,action):askDelete(row,action));
      item.append(action);
      list.append(item);
    });
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
    const request=++detailRequest;
    selected = id;
    const row = await api('/api/support/staff-eval/detail?id=' + encodeURIComponent(id));
    if(request!==detailRequest||selected!==id)return;
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
      const confirmed = item.steps.filter(step => step.met).map(step => step.label);
      const pending = item.steps.filter(step => !step.met).map(step => step.label);
      const summary = item.answer_status === 'unanswered' ? '제출된 답변 없음' : [
        confirmed.length ? '확인된 내용: ' + confirmed.join(', ') : '',
        pending.length ? '추가 확인 필요: ' + pending.join(', ') : ''
      ].filter(Boolean).join(' · ');
      const orderLabels = {insufficient: '판단 근거 부족', review: '순서 확인 필요', partial: '확인된 항목 간 일치', matched: '확인된 항목 간 일치'};
      [item.code, item.title + (item.skipped ? ' · 건너뜀' : ''), item.score, summary, orderLabels[item.order_status] || '확인 필요'].forEach(value => {
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
    $('eval-detail').scrollIntoView({block: 'start'});
  }
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
      createdId=created.id;
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
  $('eval-list-view').addEventListener('change', () => {
    selected='';detailRequest++;$('eval-detail').hidden=true;
    refresh().catch(error=>status(error.message,'error'));
  });
  const deleteDialog=$('eval-delete-dialog');
  function askDelete(row,button){
    pendingDelete=row;deleteFocus=button;
    $('eval-delete-name').textContent=row.name+' · '+row.branch_label+' · '+row.status_label;
    $('eval-delete-error').hidden=true;
    deleteDialog.showModal();$('eval-delete-cancel').focus();
  }
  async function restore(row,button){
    button.disabled=true;
    try{
      await api('/api/support/staff-eval/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:row.id})});
      await refresh();status('평가를 복구했습니다. 평가 목록에서 확인하세요.','success');$('eval-list-view').focus();
    }catch(error){status(error.message,'error');button.disabled=false;}
  }
  $('eval-delete-cancel').addEventListener('click',()=>deleteDialog.close());
  deleteDialog.addEventListener('cancel',event=>{if($('eval-delete-confirm').disabled)event.preventDefault();});
  deleteDialog.addEventListener('click',event=>{if(event.target===deleteDialog&&!$('eval-delete-confirm').disabled){const box=deleteDialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)deleteDialog.close();}});
  deleteDialog.addEventListener('close',()=>{pendingDelete=null;if(deleteFocus?.isConnected)deleteFocus.focus();else $('eval-list-view').focus();});
  $('eval-delete-confirm').addEventListener('click',async()=>{
    if(!pendingDelete)return;
    const row=pendingDelete,button=$('eval-delete-confirm');button.disabled=true;$('eval-delete-cancel').disabled=true;
    try{
      await api('/api/support/staff-eval/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:row.id})});
      if(selected===row.id){selected='';detailRequest++;$('eval-detail').hidden=true;}
      if(createdId===row.id){createdId='';$('eval-created').hidden=true;$('eval-link').value='';}
      await refresh();deleteDialog.close();status('평가를 삭제했습니다. 삭제된 평가에서 복구할 수 있습니다.','success');
    }catch(error){$('eval-delete-error').textContent=error.message;$('eval-delete-error').dataset.status='error';$('eval-delete-error').hidden=false;}
    finally{button.disabled=false;$('eval-delete-cancel').disabled=false;}
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
  refresh().then(() => {
    status('');
  }).catch(error => status(error.message, 'error'));
})();
