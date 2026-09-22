(function () {
  'use strict';
  const app = document.getElementById('app');
  const token = decodeURIComponent(location.hash.replace(/^#/, ''));
  const base = '/api/staff-eval/' + encodeURIComponent(token);
  let mode = 'voice';
  let textReason = '';
  let voice = null;
  let current = null;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function closeVoice() {
    if (!voice) return;
    const session = voice;
    voice = null;
    session.stop();
  }
  function show(message, kind) {
    closeVoice();
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
  function messageList(data) {
    const list = node('div', 'transcript');
    (data.messages || []).forEach(message => {
      list.append(node('div', 'bubble ' + (message.role === 'staff' ? 'staff' : 'assistant'), message.text));
    });
    return list;
  }
  function assistantText(data) {
    const list = (data && data.messages) || [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index].role === 'assistant') return list[index].text || '';
    }
    return '';
  }
  function useVoice(data) {
    return mode === 'voice' && !!(data.voice && data.voice.available && data.input_open);
  }
  function downsample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const length = Math.floor(input.length / ratio);
    const output = new Float32Array(length);
    for (let index = 0; index < length; index += 1) output[index] = input[Math.floor(index * ratio)];
    return output;
  }
  function pcm16Base64(float32, fromRate) {
    const audio = downsample(float32, fromRate, 16000);
    if (!audio.length) return '';
    const bytes = new Uint8Array(audio.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < audio.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, audio[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
    }
    return btoa(binary);
  }
  function createPlayer(audioContext, rate) {
    const sources = [];
    let next = 0;
    return {
      enqueue(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const view = new DataView(bytes.buffer);
        const samples = Math.floor(bytes.length / 2);
        if (!samples) return;
        const buffer = audioContext.createBuffer(1, samples, rate);
        const channel = buffer.getChannelData(0);
        for (let index = 0; index < samples; index += 1) channel[index] = view.getInt16(index * 2, true) / 32768;
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        const start = Math.max(audioContext.currentTime + 0.02, next);
        source.start(start);
        next = start + buffer.duration;
        sources.push(source);
      },
      stop() {
        sources.forEach(source => { try { source.stop(); } catch (error) { /* already ended */ } });
        sources.length = 0;
        next = 0;
      },
      remaining() { return Math.max(0, next - audioContext.currentTime); }
    };
  }
  function render(data) {
    current = data;
    if (!data.consented || !data.authenticated || data.status === 'completed' || data.status === 'expired') {
      closeVoice();
      mode = 'voice';
      textReason = '';
    }
    if (voice && voice.open && useVoice(data)) {
      voice.sync(data);
      return;
    }
    closeVoice();
    paint(data);
  }
  function paint(data) {
    current = data;
    app.replaceChildren();
    app.append(node('p', 'progress', data.role + ' · ' + data.branch_label));
    app.append(node('h1', '', data.name));
    if (data.status === 'expired') {
      app.append(node('p', '', '평가 링크가 만료되었습니다. 시설장에게 새 링크를 요청해 주세요.'));
      return;
    }
    if (data.status === 'completed') {
      app.append(node('p', 'done', data.done_message || '제출 완료. 결과는 시설장 확인 후 안내됩니다.'));
      app.append(messageList(data));
      return;
    }
    if (!data.consented) return consent();
    if (!data.authenticated) return identity(data);
    app.append(node('p', 'progress', '진행 ' + data.progress.current + '/' + data.progress.total));
    app.append(messageList(data));
    if (!data.input_open) return;
    if (useVoice(data)) mountVoice(data);
    else mountText(data);
  }
  function mountText(data) {
    const reason = textReason || '음성 연결 준비가 되지 않아 글로 답합니다. 상황을 읽고 아래에 적어 주세요.';
    app.append(node('p', 'status', reason));
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
  function mountVoice(data) {
    const session = {open: true, generation: 0};
    voice = session;
    let phase = 'idle';
    let socket = null;
    let context = null;
    let player = null;
    let stream = null;
    let processor = null;
    let mute = null;
    let sourceNode = null;
    let finalHeard = '';
    let interimHeard = '';
    let waitTimer = 0;
    const state = node('p', 'voice-state', '상황을 들으려면 아래 버튼을 누르세요.');
    state.setAttribute('role', 'status');
    const mic = node('button', 'mic', '상황 듣기');
    mic.type = 'button';
    mic.setAttribute('aria-pressed', 'false');
    const live = node('p', 'live-line', '');
    live.setAttribute('aria-live', 'polite');
    const hint = node('p', 'hint', '버튼을 한 번 누르면 답을 시작하고, 다시 누르면 그 답을 보냅니다.');
    const textButton = node('button', 'linkish', '글로 답하기');
    textButton.type = 'button';
    const stage = node('section', 'voice');
    stage.append(state, mic, live, hint, textButton);
    app.append(stage);

    function setState(text) { state.textContent = text; }
    function setMic(label, pressed, disabled) {
      mic.textContent = label;
      mic.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      mic.disabled = !!disabled;
    }
    function stopMic() {
      if (processor) {
        processor.onaudioprocess = null;
        try { processor.disconnect(); } catch (error) { /* already disconnected */ }
        processor = null;
      }
      if (sourceNode) { try { sourceNode.disconnect(); } catch (error) { /* already disconnected */ } sourceNode = null; }
      if (mute) { try { mute.disconnect(); } catch (error) { /* already disconnected */ } mute = null; }
      if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    }
    session.stop = function () {
      session.open = false;
      session.generation += 1;
      window.clearTimeout(waitTimer);
      if (socket) { const closing = socket; socket = null; try { closing.close(); } catch (error) { /* already closed */ } }
      stopMic();
      if (player) player.stop();
      if (context) { context.close().catch(() => {}); context = null; }
    };
    session.sync = function (next) {
      current = next;
      const progress = app.querySelectorAll('.progress')[1];
      const list = app.querySelector('.transcript');
      if (progress) progress.textContent = '진행 ' + next.progress.current + '/' + next.progress.total;
      if (list) {
        list.replaceChildren();
        (next.messages || []).forEach(message => {
          list.append(node('div', 'bubble ' + (message.role === 'staff' ? 'staff' : 'assistant'), message.text));
        });
      }
      if (next.status === 'completed' || !next.input_open) {
        closeVoice();
        paint(next);
      }
    };
    function fallback(message) {
      mode = 'text';
      textReason = message;
      const snapshot = current;
      closeVoice();
      paint(snapshot);
    }
    function remember(piece, finalText) {
      if (!piece) return;
      if (finalText) {
        if (!finalHeard) finalHeard = piece;
        else if (piece.indexOf(finalHeard) === 0) finalHeard = piece;
        else if (finalHeard.indexOf(piece) === -1) finalHeard += piece;
        live.textContent = finalHeard;
        return;
      }
      interimHeard = piece;
      if (!finalHeard) live.textContent = interimHeard;
    }
    function speak(text) {
      if (!session.open || !socket || socket.readyState !== 1) {
        phase = 'idle';
        setState('음성 연결이 끊겼습니다. 상황 듣기를 다시 누르거나 글로 답해 주세요.');
        setMic('상황 듣기', false, false);
        return;
      }
      if (!text) {
        phase = 'ready';
        setState('듣는 중');
        setMic('답변 말하기', false, false);
        return;
      }
      if (player) player.stop();
      phase = 'reading';
      finalHeard = '';
      interimHeard = '';
      live.textContent = '';
      setState('AI가 말하는 중');
      setMic('상황 듣기', false, true);
      socket.send(JSON.stringify({realtimeInput: {text: '[읽기]\n' + text}}));
    }
    function onTurnComplete() {
      if (phase === 'reading') {
        const delay = player ? player.remaining() : 0;
        window.setTimeout(() => {
          if (!session.open || phase !== 'reading') return;
          phase = 'ready';
          setState('듣는 중');
          setMic('답변 말하기', false, false);
        }, delay * 1000 + 80);
        return;
      }
      if (phase !== 'waiting') return;
      window.clearTimeout(waitTimer);
      waitTimer = window.setTimeout(deliver, 700);
    }
    function deliver() {
      if (!session.open || phase !== 'waiting') return;
      const text = (finalHeard || interimHeard).replace(/\s+/g, ' ').trim();
      if (!text) {
        phase = 'ready';
        setState('음성이 들리지 않았습니다. 다시 말씀해 주세요.');
        setMic('답변 말하기', false, false);
        return;
      }
      submitAnswer(text);
    }
    async function handleMessage(event, generation, onReady) {
      if (!session.open || generation !== session.generation) return;
      let raw = event.data;
      if (typeof Blob !== 'undefined' && raw instanceof Blob) raw = await raw.text();
      let message;
      try { message = JSON.parse(raw); } catch (error) { return; }
      if (!session.open || generation !== session.generation) return;
      if (message.setupComplete) { onReady(); return; }
      if (message.error) { fallback('음성 연결을 열지 못했습니다. 글로 답해 주세요.'); return; }
      const content = message.serverContent;
      if (!content) return;
      if (content.interrupted && player) player.stop();
      const parts = (content.modelTurn && content.modelTurn.parts) || [];
      parts.forEach(part => {
        const inline = part.inlineData || part.inline_data;
        if (!(inline && inline.data && player) || phase === 'capturing') return;
        try { player.enqueue(inline.data); } catch (error) { /* 깨진 음성 조각은 건너뛴다 */ }
      });
      if (phase === 'capturing' || phase === 'waiting') {
        const interim = content.interimInputTranscription || content.interim_input_transcription;
        const finalText = content.inputTranscription || content.input_transcription;
        if (interim && interim.text) remember(interim.text, false);
        if (finalText && finalText.text) remember(finalText.text, true);
      }
      if (content.turnComplete || content.turn_complete) onTurnComplete();
    }
    function openSocket(speakText) {
      return call('/live-token', {}).then(creds => new Promise((resolve, reject) => {
        if (!session.open) return;
        const ws = new WebSocket(creds.websocket_url + '?access_token=' + encodeURIComponent(creds.token));
        socket = ws;
        const generation = session.generation;
        let settled = false;
        if (!player && context) player = createPlayer(context, creds.output_rate || 24000);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            setup: {
              model: creds.model,
              responseModalities: ['AUDIO'],
              systemInstruction: {parts: [{text: creds.system_instruction}]},
              inputAudioTranscription: {languageCodes: ['ko-KR']},
              outputAudioTranscription: {},
              speechConfig: {languageCode: 'ko-KR'}
            }
          }));
        };
        ws.onmessage = event => handleMessage(event, generation, () => {
          if (settled || !session.open) return;
          settled = true;
          resolve();
          speak(speakText || creds.speak || assistantText(current));
        });
        ws.onerror = () => {
          if (settled) return;
          settled = true;
          reject(Error('음성 연결을 열지 못했습니다. 글로 답해 주세요.'));
        };
        ws.onclose = () => {
          if (!session.open || generation !== session.generation) return;
          if (!settled) {
            settled = true;
            reject(Error('음성 연결을 열지 못했습니다. 글로 답해 주세요.'));
            return;
          }
          if (phase === 'saving') return;
          socket = null;
          stopMic();
          phase = 'idle';
          setState('음성 연결이 끊겼습니다. 상황 듣기를 다시 누르거나 글로 답해 주세요.');
          setMic('상황 듣기', false, false);
        };
      }));
    }
    async function submitAnswer(text) {
      phase = 'saving';
      window.clearTimeout(waitTimer);
      setState('처리 중');
      setMic('답변 말하기', false, true);
      try {
        const data = await call('/message', {text: text});
        current = data;
        if (!session.open) return;
        if (data.status === 'completed' || !data.input_open) {
          closeVoice();
          paint(data);
          return;
        }
        session.sync(data);
        if (!session.open) return;
        const nextText = assistantText(data);
        if (socket && socket.readyState === 1) speak(nextText);
        else {
          phase = 'idle';
          setState('음성 연결이 끊겼습니다. 상황 듣기를 다시 누르거나 글로 답해 주세요.');
          setMic('상황 듣기', false, false);
        }
      } catch (error) {
        if (!session.open) return;
        phase = 'ready';
        setState(error.message);
        setMic('답변 말하기', false, false);
      }
    }
    function stopCapture() {
      if (phase !== 'capturing') return;
      phase = 'waiting';
      setState('처리 중');
      setMic('답변 끝내기', true, true);
      stopMic();
      if (socket && socket.readyState === 1) socket.send(JSON.stringify({realtimeInput: {audioStreamEnd: true}}));
      window.clearTimeout(waitTimer);
      waitTimer = window.setTimeout(deliver, 8000);
    }
    async function startMic() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Error('mic');
      if (!context.createScriptProcessor) throw Error('mic');
      stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
      if (!session.open) { stopMic(); return; }
      sourceNode = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      mute = context.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = event => {
        if (phase !== 'capturing' || !socket || socket.readyState !== 1) return;
        const encoded = pcm16Base64(event.inputBuffer.getChannelData(0), context.sampleRate);
        if (encoded) socket.send(JSON.stringify({realtimeInput: {audio: {data: encoded, mimeType: 'audio/pcm;rate=16000'}}}));
      };
      sourceNode.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      phase = 'capturing';
      finalHeard = '';
      interimHeard = '';
      live.textContent = '';
      setState('말하는 중');
      setMic('답변 끝내기', true, false);
      window.setTimeout(() => { if (session.open && phase === 'capturing') stopCapture(); }, 60000);
    }
    async function onMic() {
      if (!session.open || mic.disabled) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!context && AudioCtx) {
        context = new AudioCtx();
        player = createPlayer(context, 24000);
      }
      if (context) { try { await context.resume(); } catch (error) { /* playback may still start after the gesture */ } }
      if (phase === 'capturing') { stopCapture(); return; }
      if (phase === 'ready' && socket && socket.readyState === 1) {
        try { await startMic(); }
        catch (error) { fallback('마이크를 사용할 수 없어 글로 답해 주세요.'); }
        return;
      }
      if (phase !== 'idle') return;
      setMic('상황 듣기', false, true);
      setState('연결 중');
      try { await openSocket(assistantText(current)); }
      catch (error) { if (session.open) fallback(error.message || '음성 연결을 열지 못했습니다. 글로 답해 주세요.'); }
    }
    mic.addEventListener('click', () => { onMic(); });
    textButton.addEventListener('click', () => fallback('글로 답하는 중입니다. 상황을 읽고 아래에 적어 주세요.'));
  }
  function consent() {
    app.append(node('h2', '', '평가 안내'));
    app.append(node('p', '', '요양보호사 지침 숙지와 상황판단을 음성으로 확인합니다. 마이크를 허용해 주세요. 음성이 어려우면 글로 답할 수 있습니다.'));
    app.append(node('p', '', '대화 내용과 자동 채점 초안은 시설 지식창고 서버에 저장됩니다. 음성은 글로 옮겨 저장합니다.'));
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
  if (!token) {
    show('평가 링크 전체를 열어 주세요. 주소 끝의 # 이후가 빠져 있으면 시설장에게 링크를 다시 요청해 주세요.', 'error');
    return;
  }
  call('').then(render).catch(error => show(error.message, 'error'));
})();
