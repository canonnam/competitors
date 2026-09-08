(() => {
  let token = '', documents = [];
  const byId = id => document.getElementById(id);
  const status = byId('admin-status');
  async function request(path, body) {
    const response = await fetch(path, {method: body ? 'POST' : 'GET', headers: {'Authorization': `Bearer ${token}`, ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(45000)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
    return data;
  }
  function render() {
    const filter = byId('document-filter').value.toLowerCase();
    const visible = documents.filter(doc => `${doc.title} ${doc.path}`.toLowerCase().includes(filter));
    const list = byId('document-list');
    list.replaceChildren();
    byId('empty-documents').hidden = visible.length > 0;
    byId('empty-documents').textContent = documents.length ? '검색 결과가 없습니다.' : '등록된 문서가 없습니다.';
    for (const doc of visible) {
      const row = document.createElement('tr');
      const title = document.createElement('td');
      title.textContent = doc.title;
      const path = document.createElement('span');
      path.className = 'document-path'; path.textContent = doc.path; title.append(path);
      const date = document.createElement('td'); date.textContent = doc.updated;
      const state = document.createElement('td'); state.textContent = doc.status === 'needs-review' ? '검토 필요' : doc.status === 'seed' ? '초안' : '등록됨';
      const actions = document.createElement('td');
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'document-delete'; remove.title = '문서 삭제'; remove.setAttribute('aria-label', `${doc.title} 삭제`);
      remove.innerHTML = '<img src="/assets/icons/trash-2.svg" alt="">';
      remove.onclick = async () => {
        if (!confirm(`'${doc.title}' 문서를 답변 지식에서 삭제할까요?`)) return;
        remove.disabled = true;
        try { await request('/api/wiki/delete', {id: doc.id}); await load(); status.textContent = '문서를 삭제했습니다.'; }
        catch (error) { status.textContent = error.message; remove.disabled = false; }
      };
      actions.append(remove); row.append(title, date, state, actions); list.append(row);
    }
  }
  async function load() {
    const data = await request('/api/wiki/documents');
    documents = data.documents;
    byId('document-count').textContent = `문서 ${documents.length}개`;
    byId('connection-state').textContent = data.ready ? '답변 서비스 연결됨' : '답변 서비스 연결 대기 중';
    render();
  }
  byId('login-form').onsubmit = async event => {
    event.preventDefault(); token = byId('admin-key').value.trim();
    const button = event.target.querySelector('button'); button.disabled = true; status.textContent = '연결 중';
    try { await load(); byId('login-form').hidden = true; byId('knowledge-workspace').hidden = false; byId('logout').hidden = false; byId('admin-key').value = ''; status.textContent = ''; }
    catch (error) { token = ''; status.textContent = error.message; }
    finally { button.disabled = false; }
  };
  byId('logout').onclick = () => { token = ''; documents = []; byId('document-list').replaceChildren(); byId('knowledge-workspace').hidden = true; byId('logout').hidden = true; byId('login-form').hidden = false; status.textContent = ''; byId('admin-key').focus(); };
  byId('document-filter').addEventListener('input', render);
  byId('upload-form').onsubmit = async event => {
    event.preventDefault();
    const files = [...byId('document-files').files];
    const button = event.target.querySelector('button');
    const progress = byId('upload-status');
    button.disabled = true;
    try {
      if (!files.length || files.length > 100) throw new Error('파일은 한 번에 1~100개 선택해주세요.');
      if (files.some(file => !/\.(md|txt)$/i.test(file.name) || file.size > 200000)) throw new Error('200KB 이하의 .md 또는 .txt 파일을 선택해주세요.');
      if (files.reduce((sum, file) => sum + file.size, 0) > 4000000) throw new Error('한 번에 등록하는 파일은 총 4MB 이하여야 합니다.');
      progress.textContent = `${files.length}개 문서를 등록하고 있습니다`;
      const payload = [];
      for (const file of files) payload.push({path: `uploads/${file.name}`, content: await file.text()});
      const result = await request('/api/wiki/import', {documents: payload});
      progress.textContent = `신규 ${result.added}개 · 갱신 ${result.updated}개 · 변경 없음 ${result.unchanged}개`;
      byId('document-files').value = ''; await load();
    } catch (error) { progress.textContent = error.message; }
    finally { button.disabled = false; }
  };
})();
