(function () {
  'use strict';
  const app = document.getElementById('app');
  const token = decodeURIComponent(location.hash.replace(/^#/, ''));
  const base = '/api/staff-eval/' + encodeURIComponent(token);
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function show(message, kind) {
    app.replaceChildren(node('p', 'status', message));
    if (kind) app.firstChild.dataset.status = kind;
  }
  async function call(path, body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
      headers: body ? {'Content-Type': 'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '요청을 처리하지 못했습니다.');
    return data;
  }
  function messages(data) {
    const list = node('div');
    (data.messages || []).forEach(message => {
      list.append(node('div', 'bubble ' + (message.role === 'staff' ? 'staff' : 'assistant'), message.text));
    });
    return list;
  }
  function render(data) {
    app.replaceChildren();
    app.append(node('p', 'progress', data.role + ' · ' + data.branch_label));
    app.append(node('h1', '', data.name));
    if (data.status === 'expired') { app.append(node('p', '', '평가 링크가 만료되었습니다. 시설장에게 새 링크를 요청해 주세요.')); return; }
    if (data.status === 'completed') {
      app.append(node('p', 'done', data.done_message || '제출 완료. 결과는 시설장 확인 후 안내됩니다.'));
      app.append(messages(data));
      return;
    }
    if (!data.consented) return consent();
    if (!data.authenticated) return identity(data);
    app.append(node('p', 'progress', '진행 ' + data.progress.current + '/' + data.progress.total));
    app.append(messages(data));
    if (!data.input_open) return;
    const form = node('form');
    const label = node('label', '', '답변');
    const input = node('textarea');
    input.required = true;
    input.maxLength = 2000;
    input.setAttribute('aria-label', '상황에 대한 답변');
    label.append(input);
    const button = node('button', 'primary', '보내기');
    button.type = 'submit';
    const note = node('p', 'status', '');
    form.append(label, button, note);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      note.textContent = '보내는 중…';
      try { render(await call('/message', {text: input.value})); }
      catch (error) { note.textContent = error.message; note.dataset.status = 'error'; button.disabled = false; }
    });
    app.append(form);
    input.focus();
  }
  function consent() {
    app.append(node('h2', '', '평가 안내'));
    app.append(node('p', '', '요양보호사 지침 숙지와 상황판단을 대화로 확인합니다. 지금 단계는 글로 답하는 평가입니다.'));
    app.append(node('p', '', '대화 내용과 자동 채점 초안은 시설 지식창고 서버에 저장됩니다.'));
    app.append(node('p', '', '결과는 시설장만 확인합니다. 점수는 이 화면에서 바로 보여 주지 않고, 시설장 확인 후 안내됩니다.'));
    const form = node('form');
    const label = node('label', 'check');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.required = true;
    label.append(box, document.createTextNode('안내를 확인했고 평가에 동의합니다.'));
    const button = node('button', 'primary', '동의하고 시작');
    button.type = 'submit';
    form.append(label, button);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      try { render(await call('/consent', {accepted: true})); }
      catch (error) { show(error.message, 'error'); }
    });
    app.append(form);
  }
  function identity(data) {
    app.append(node('h2', '', '본인 확인'));
    app.append(node('p', '', data.name + ' 님이 맞는지 확인해 주세요.'));
    const form = node('form');
    if (data.needs_birthdate) {
      const label = node('label', '', '생년월일');
      const input = node('input');
      input.type = 'date';
      input.required = !data.needs_employee_hint;
      input.name = 'birthdate';
      label.append(input);
      form.append(label);
    }
    if (data.needs_employee_hint) {
      const label = node('label', '', '직원번호 끝자리');
      const input = node('input');
      input.inputMode = 'numeric';
      input.autocomplete = 'off';
      input.required = !data.needs_birthdate;
      input.maxLength = 20;
      input.name = 'employee_hint';
      label.append(input);
      form.append(label);
    }
    if (data.needs_name) {
      const label = node('label', '', '이름 확인');
      const input = node('input');
      input.required = true;
      input.maxLength = 40;
      input.name = 'name';
      label.append(input);
      form.append(label);
    }
    const button = node('button', 'primary', '확인하고 평가 시작');
    button.type = 'submit';
    const note = node('p', 'status', '');
    form.append(button, note);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      const payload = {};
      new FormData(form).forEach((value, key) => { payload[key] = value; });
      if ((data.needs_birthdate || data.needs_employee_hint) && !payload.birthdate && !payload.employee_hint) {
        note.textContent = '생년월일 또는 직원번호 끝자리를 입력해 주세요.';
        note.dataset.status = 'error';
        button.disabled = false;
        return;
      }
      try { render(await call('/verify', payload)); }
      catch (error) { note.textContent = error.message; note.dataset.status = 'error'; button.disabled = false; }
    });
    app.append(form);
  }
  if (!token) { show('평가 링크 전체를 열어 주세요. 주소 끝의 # 이후가 빠져 있으면 시설장에게 링크를 다시 요청해 주세요.', 'error'); return; }
  call('').then(render).catch(error => show(error.message, 'error'));
})();
