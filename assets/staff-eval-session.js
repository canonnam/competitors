(function () {
  'use strict';
  const app = document.getElementById('app');
  const token = decodeURIComponent(location.hash.replace(/^#/, ''));
  const base = '/api/staff-eval/' + encodeURIComponent(token);
  let mode = 'voice';
  let textReason = '';
  let voice = null;
  let current = null;
  let textDraft = '';

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    if (el.classList.contains('ui-status')) el.setAttribute('role', 'status');
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
    app.replaceChildren(node('h1', '', '종사자 평가'), node('p', 'ui-status', message));
    if (kind) app.lastChild.dataset.status = kind;
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
    const messages = data.messages || [];
    function bubble(message) {
      const item = node('div', 'bubble ' + (message.role === 'staff' ? 'staff' : 'assistant'));
      item.append(node('span', 'speaker', message.role === 'staff' ? '내 답변' : '평가 안내'), node('p', '', message.text));
      return item;
    }
    if (data.input_open && messages.length) {
      list.append(bubble(messages[messages.length - 1]));
      if (messages.length > 1) {
        const history = node('details', 'history');
        history.append(node('summary', '', '이전 대화 보기'));
        messages.slice(0, -1).forEach(message => history.append(bubble(message)));
        list.append(history);
      }
    } else messages.forEach(message => list.append(bubble(message)));
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
  function pcm16Base64(audio) {
    // Send every sample at its native rate; the service resamples without
    // the aliasing and lost chunk boundaries of client-side decimation.
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
      const note = node('p', 'ui-status', '평가 링크가 만료되었습니다. 시설장에게 새 링크를 요청해 주세요.');
      note.dataset.status = 'warning';
      app.append(note);
      return;
    }
    if (data.status === 'completed') {
      const note = node('p', 'ui-status done', data.done_message || '제출 완료. 결과는 시설장 확인 후 안내됩니다.');
      note.dataset.status = 'success';
      app.append(note);
      app.append(messageList(data));
      return;
    }
    if (!data.consented) return consent();
    if (!data.authenticated) return identity(data);
    app.append(node('p', 'progress', '진행 ' + data.progress.current + '/' + data.progress.total));
    const progress = node('progress', 'evaluation-progress');
    progress.max = data.progress.total;
    progress.value = data.progress.current - 1;
    progress.setAttribute('aria-label', '완료한 상황');
    app.append(progress);
    app.append(messageList(data));
    if (!data.input_open) return;
    if (useVoice(data)) mountVoice(data);
    else mountText(data);
  }
  function mountText(data) {
    const reason = textReason || '음성 연결 준비가 되지 않아 글로 답합니다. 상황을 읽고 아래에 적어 주세요.';
    app.append(node('p', 'ui-status', reason));
    let retry = null;
    if (data.voice && data.voice.available) {
      retry = node('button', 'ui-button voice-retry', '음성 다시 시도');
      retry.type = 'button';
      retry.addEventListener('click', () => { mode = 'voice'; textReason = ''; render(current); });
      app.append(retry);
    }
    const form = node('form');
    const label = node('label', '', '답변');
    const input = node('textarea');
    input.required = true;
    input.maxLength = 2000;
    input.setAttribute('aria-label', '상황에 대한 답변');
    input.value = textDraft;
    input.addEventListener('input', () => { textDraft = input.value; });
    label.append(input);
    const button = node('button', 'ui-button ui-button--primary form-submit', '답변 보내기');
    button.type = 'submit';
    const note = node('p', 'ui-status', '');
    form.append(label, button, note);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      skip.disabled = true;
      input.disabled = true;
      if (retry) retry.disabled = true;
      note.textContent = '보내는 중…';
      try { const next = await call('/message', {text: input.value}); textDraft = ''; render(next); }
      catch (error) { note.textContent = error.message; note.dataset.status = 'error'; button.disabled = false; skip.disabled = false; input.disabled = false; if (retry) retry.disabled = false; }
    });
    app.append(form);
    const skip = mountSkip(() => { button.disabled = true; input.disabled = true; if (retry) retry.disabled = true; }, () => { button.disabled = false; input.disabled = false; if (retry) retry.disabled = false; });
    input.focus();
  }
  function mountSkip(before, failed) {
    const area = node('div', 'skip-question');
    const button = node('button', 'ui-button', current.progress.current === current.progress.total ? '마지막 문항 건너뛰고 완료' : '이 문항 건너뛰기');
    button.type = 'button';
    const note = node('p', 'hint', '건너뛴 문항은 다시 돌아올 수 없습니다. 아직 보내지 않은 답변은 저장되지 않으며, 제출한 내용까지 평가됩니다.');
    button.addEventListener('click', async () => {
      button.disabled = true;
      before();
      try {
        const next = await call('/skip', {scenario_id: current.scenario_id});
        textDraft = '';
        render(next);
      } catch (error) {
        note.textContent = error.message;
        note.setAttribute('role', 'alert');
        button.disabled = false;
        failed();
      }
    });
    area.append(button, note);
    app.append(area);
    return button;
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
    let captureTimer = 0;
    let connectTimer = 0;
    let readTimer = 0;
    let playbackTimer = 0;
    let readyTimer = 0;
    let tailTimer = 0;
    let reviewEdited = false;
    let quietFrames = 0;
    let cancelConnect = null;
    const state = node('p', 'ui-status voice-state', '상황을 들으려면 아래 버튼을 누르세요.');
    state.setAttribute('role', 'status');
    const mic = node('button', 'ui-button ui-button--primary mic', '상황 듣기');
    mic.type = 'button';
    mic.setAttribute('aria-pressed', 'false');
    const live = node('p', 'live-line', '');
    live.setAttribute('aria-live', 'polite');
    const hint = node('p', 'hint', '‘답변 말하기’를 누르고 시작음과 ‘지금 말씀하세요’ 표시를 기다리세요. 말씀을 마치면 ‘답변 끝내기’를 누르세요.');
    const indicator = node('div', 'recording-indicator');
    indicator.setAttribute('aria-hidden', 'true');
    indicator.append(node('span', 'recording-dot'));
    const level = node('meter', 'mic-level');
    level.min = 0; level.max = 1; level.value = 0;
    level.setAttribute('aria-label', '마이크 입력 음량');
    const levelText = node('p', 'hint mic-level-hint', '녹음이 시작되면 마이크 입력 크기가 표시됩니다.');
    const review = node('form', 'voice-review');
    review.hidden = true;
    const reviewLabel = node('label', '', '인식된 답변 확인');
    const reviewInput = node('textarea');
    reviewInput.maxLength = 2000; reviewInput.required = true;
    reviewInput.setAttribute('aria-label', '인식된 답변');
    reviewInput.addEventListener('input', () => { reviewEdited = true; textDraft = reviewInput.value; });
    reviewLabel.append(reviewInput);
    const send = node('button', 'ui-button ui-button--primary', '확인하고 답변 보내기');
    send.type = 'submit';
    const again = node('button', 'ui-button', '다시 말하기');
    again.type = 'button';
    review.append(reviewLabel, node('p', 'hint', '다르게 인식된 부분은 직접 고친 뒤 보내세요.'), send, again);
    const textButton = node('button', 'ui-button', '글로 답하기');
    textButton.type = 'button';
    const stage = node('section', 'voice');
    stage.append(state, indicator, mic, level, levelText, live, hint, review, textButton);
    app.append(stage);
    const skip = mountSkip(() => {
      if (phase === 'review') textDraft = reviewInput.value;
      phase = 'skipping'; setState('문항을 건너뛰는 중입니다.');
      mic.disabled = true; textButton.disabled = true; send.disabled = true; again.disabled = true;
      if (player) player.stop();
      closeVoice();
    }, () => { mode = 'text'; textReason = '문항을 건너뛰지 못했습니다. 답변을 보내거나 다시 시도해 주세요.'; paint(current); });

    function setState(text, kind) {
      stage.dataset.phase = phase;
      skip.disabled = !['idle', 'connecting', 'reading', 'ready', 'review'].includes(phase);
      state.textContent = text;
      if (kind) state.dataset.status = kind;
      else delete state.dataset.status;
    }
    function setMic(label, pressed, disabled) {
      mic.textContent = label;
      mic.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      mic.disabled = !!disabled;
    }
    function stopMic() {
      window.clearTimeout(captureTimer);
      window.clearTimeout(tailTimer);
      window.clearTimeout(readyTimer);
      level.value = 0;
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
      window.clearTimeout(connectTimer);
      window.clearTimeout(readTimer);
      window.clearTimeout(playbackTimer);
      if (cancelConnect) cancelConnect();
      if (socket) { const closing = socket; socket = null; try { closing.close(); } catch (error) { /* already closed */ } }
      stopMic();
      if (player) player.stop();
      if (context) { context.close().catch(() => {}); context = null; }
    };
    session.sync = function (next) {
      current = next;
      skip.textContent = next.progress.current === next.progress.total ? '마지막 문항 건너뛰고 완료' : '이 문항 건너뛰기';
      const progress = app.querySelectorAll('.progress')[1];
      const list = app.querySelector('.transcript');
      if (progress) progress.textContent = '진행 ' + next.progress.current + '/' + next.progress.total;
      const meter = app.querySelector('.evaluation-progress');
      if (meter) meter.value = next.progress.current - 1;
      if (list) list.replaceWith(messageList(next));
      if (next.status === 'completed' || !next.input_open) {
        closeVoice();
        paint(next);
      }
    };
    function fallback(message) {
      if (phase === 'review' || phase === 'saving') textDraft = reviewInput.value;
      else if (finalHeard || interimHeard) textDraft = heardText();
      mode = 'text';
      textReason = message;
      const snapshot = current;
      closeVoice();
      paint(snapshot);
    }
    function remember(piece, finalText) {
      if (!piece) return;
      if (finalText) {
        // Final messages are incremental. Repeated words are real speech too.
        finalHeard += piece;
        interimHeard = '';
      } else interimHeard = piece;
      live.textContent = heardText();
      if (phase === 'review' && !reviewEdited) reviewInput.value = heardText();
      if (phase === 'waiting') {
        window.clearTimeout(waitTimer);
        waitTimer = window.setTimeout(deliver, 1800);
      }
    }
    function heardText() { return (finalHeard + interimHeard).trim(); }
    function speak(text) {
      if (!session.open || !socket || socket.readyState !== 1) {
        phase = 'idle';
        setState('음성 연결이 끊겼습니다. 상황 듣기를 다시 누르거나 글로 답해 주세요.');
        setMic('상황 듣기', false, false);
        return;
      }
      if (!text) {
        phase = 'ready';
        setState('답변할 준비가 되었습니다.');
        setMic('답변 말하기', false, false);
        return;
      }
      if (player) player.stop();
      phase = 'reading';
      review.hidden = true;
      mic.hidden = false;
      finalHeard = '';
      interimHeard = '';
      live.textContent = '';
      setState('AI가 말하는 중');
      setMic('상황 듣기', false, true);
      socket.send(JSON.stringify({clientContent: {
        turns: [{role: 'user', parts: [{text: '[읽기]\n' + text}]}], turnComplete: true
      }}));
      window.clearTimeout(readTimer);
      readTimer = window.setTimeout(() => {
        if (session.open && phase === 'reading') fallback('상황 음성을 받지 못했습니다. 다시 시도하거나 글로 답해 주세요.');
      }, 45000);
    }
    function onTurnComplete() {
      if (phase === 'reading') {
        window.clearTimeout(readTimer);
        const delay = player ? player.remaining() : 0;
        window.clearTimeout(playbackTimer);
        playbackTimer = window.setTimeout(() => {
          if (!session.open || phase !== 'reading') return;
          phase = 'ready';
          setState('답변할 준비가 되었습니다.');
          setMic('답변 말하기', false, false);
        }, delay * 1000 + 80);
        return;
      }
      if (phase !== 'waiting') return;
      window.clearTimeout(waitTimer);
      waitTimer = window.setTimeout(deliver, finalHeard || interimHeard ? 1800 : 8000);
    }
    function deliver() {
      if (!session.open || phase !== 'waiting') return;
      const text = heardText();
      phase = 'review';
      reviewEdited = false;
      reviewInput.value = text;
      review.hidden = false;
      mic.hidden = true;
      send.disabled = false; again.disabled = false;
      setState(text ? '인식된 답변을 확인한 뒤 보내 주세요.' : '음성이 잘 들리지 않았습니다. 다시 말하거나 답변을 직접 적어 주세요.', text ? 'success' : 'warning');
      reviewInput.focus();
    }
    async function handleMessage(event, generation, onReady, onError) {
      if (!session.open || generation !== session.generation) return;
      let raw = event.data;
      if (typeof Blob !== 'undefined' && raw instanceof Blob) raw = await raw.text();
      let message;
      try { message = JSON.parse(raw); } catch (error) { return; }
      if (!session.open || generation !== session.generation) return;
      if (message.setupComplete) { onReady(); return; }
      if (message.error) { onError('음성 서비스에 연결하지 못했습니다. 다시 시도하거나 글로 답해 주세요.'); return; }
      const content = message.serverContent;
      if (!content) return;
      if (content.interrupted && player) player.stop();
      const parts = (content.modelTurn && content.modelTurn.parts) || [];
      parts.forEach(part => {
        const inline = part.inlineData || part.inline_data;
        if (!(inline && inline.data && player) || phase !== 'reading') return;
        try { player.enqueue(inline.data); } catch (error) { /* 깨진 음성 조각은 건너뛴다 */ }
      });
      if (phase === 'capturing' || phase === 'stopping' || phase === 'waiting' || phase === 'review') {
        const interim = content.interimInputTranscription || content.interim_input_transcription;
        const finalText = content.inputTranscription || content.input_transcription;
        if (interim && interim.text) remember(interim.text, false);
        if (finalText && finalText.text) remember(finalText.text, true);
      }
      if (content.turnComplete || content.turn_complete) onTurnComplete();
    }
    function openSocket(speakText, readPrompt = true) {
      return call('/live-token', {}).then(creds => new Promise((resolve, reject) => {
        if (!session.open) { resolve(); return; }
        const ws = new WebSocket(creds.websocket_url + '?access_token=' + encodeURIComponent(creds.token));
        socket = ws;
        const generation = ++session.generation;
        let settled = false;
        cancelConnect = () => { if (!settled) { settled = true; resolve(); } };
        function fail(message) {
          if (!session.open || generation !== session.generation) return;
          window.clearTimeout(connectTimer);
          if (!settled) { settled = true; reject(Error(message)); }
          else fallback(message);
        }
        connectTimer = window.setTimeout(() => fail('음성 연결 시간이 초과되었습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.'), 15000);
        if (!player && context) player = createPlayer(context, creds.output_rate || 24000);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            setup: creds.setup || {
              model: creds.model,
              generationConfig: {responseModalities: ['AUDIO'], speechConfig: {languageCode: 'ko-KR'}},
              systemInstruction: {parts: [{text: creds.system_instruction}]},
              inputAudioTranscription: {languageCodes: ['ko-KR']},
              outputAudioTranscription: {},
              realtimeInputConfig: {automaticActivityDetection: {disabled: true}},
            }
          }));
        };
        ws.onmessage = event => handleMessage(event, generation, () => {
          if (settled || !session.open) return;
          settled = true;
          window.clearTimeout(connectTimer);
          resolve();
          if (readPrompt) speak(speakText || creds.speak || assistantText(current));
          else { phase = 'ready'; setState('답변할 준비가 되었습니다.'); setMic('답변 말하기', false, false); }
        }, fail);
        ws.onerror = () => fail('음성 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하거나 글로 답해 주세요.');
        ws.onclose = event => {
          if (!session.open || generation !== session.generation) return;
          window.clearTimeout(connectTimer);
          if (!settled) {
            fail(event.code === 1008 ? '음성 연결 설정을 확인하지 못했습니다. 다시 시도하거나 담당자에게 알려 주세요.' : '음성 연결이 종료되었습니다. 다시 시도하거나 글로 답해 주세요.');
            return;
          }
          if (phase === 'saving') return;
          socket = null;
          if (phase === 'capturing' || phase === 'stopping' || phase === 'waiting' || phase === 'review') {
            fallback('음성 연결이 끊겼습니다. 인식된 답변을 확인하고 글로 이어서 보내 주세요.');
            return;
          }
          window.clearTimeout(readTimer);
          window.clearTimeout(playbackTimer);
          stopMic();
          phase = 'idle';
          setState('음성 연결이 끊겼습니다. 상황 듣기를 다시 누르거나 글로 답해 주세요.', 'warning');
          setMic('상황 듣기', false, false);
        };
      }));
    }
    async function submitAnswer(text) {
      phase = 'saving';
      reviewInput.disabled = true; send.disabled = true; again.disabled = true;
      textButton.disabled = true;
      window.clearTimeout(waitTimer);
      setState('처리 중');
      setMic('답변 말하기', false, true);
      try {
        const data = await call('/message', {text: text});
        textDraft = '';
        finalHeard = '';
        interimHeard = '';
        review.hidden = true; reviewInput.disabled = false;
        textButton.disabled = false;
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
        textDraft = text;
        fallback(error.message + ' 인식한 답변을 확인하고 다시 보내 주세요.');
      }
    }
    function stopCapture() {
      if (phase !== 'capturing') return;
      phase = 'stopping';
      setState('말씀을 글로 정리하고 있습니다. 잠시 기다려 주세요.');
      setMic('답변 끝내기', true, true);
      // Drain the audio callback buffer so the final syllable is not cut off.
      tailTimer = window.setTimeout(() => {
        if (!session.open || phase !== 'stopping') return;
        phase = 'waiting';
        stopMic();
        if (socket && socket.readyState === 1) socket.send(JSON.stringify({realtimeInput: {activityEnd: {}}}));
        window.clearTimeout(waitTimer);
        waitTimer = window.setTimeout(deliver, 8000);
      }, 300);
    }
    async function startMic() {
      phase = 'permission';
      setState('마이크를 준비하는 중입니다.');
      setMic('마이크 준비 중', false, true);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Error('mic');
      if (!context.createScriptProcessor) throw Error('mic');
      stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true}});
      if (!session.open) { stopMic(); return; }
      if (!socket || socket.readyState !== 1) throw Error('connection closed');
      sourceNode = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      mute = context.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = event => {
        if (phase === 'arming' && socket && socket.readyState === 1) {
          window.clearTimeout(readyTimer);
          socket.send(JSON.stringify({realtimeInput: {activityStart: {}}}));
          phase = 'capturing';
          playStartCue();
          setState('지금 말씀하세요 · 녹음 중', 'success');
          setMic('답변 끝내기', true, false);
          captureTimer = window.setTimeout(() => { if (session.open && phase === 'capturing') stopCapture(); }, 60000);
        }
        if (!['capturing', 'stopping'].includes(phase) || !socket || socket.readyState !== 1) return;
        const samples = event.inputBuffer.getChannelData(0);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const rms = Math.sqrt(energy / samples.length);
        level.value = Math.min(1, rms * 6);
        quietFrames = rms < 0.008 ? quietFrames + 1 : 0;
        levelText.textContent = quietFrames > 24 ? '소리가 작습니다. 마이크에 조금 더 가까이 말씀해 주세요.' : '마이크가 듣고 있습니다. 평소 목소리로 말씀해 주세요.';
        const encoded = pcm16Base64(samples);
        if (encoded) socket.send(JSON.stringify({realtimeInput: {audio: {data: encoded, mimeType: 'audio/pcm;rate=' + context.sampleRate}}}));
      };
      phase = 'arming';
      finalHeard = ''; interimHeard = ''; quietFrames = 0; reviewEdited = false;
      live.textContent = ''; review.hidden = true; mic.hidden = false;
      setState('시작음을 기다려 주세요. 마이크 입력을 확인하고 있습니다.');
      readyTimer = window.setTimeout(() => { if (session.open && phase === 'arming') fallback('마이크 입력을 받지 못했습니다. 마이크를 확인하거나 글로 답해 주세요.'); }, 5000);
      sourceNode.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
    }
    function playStartCue() {
      try {
        const tone = context.createOscillator(), gain = context.createGain();
        const now = context.currentTime;
        tone.frequency.value = 880;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.015);
        gain.gain.linearRampToValueAtTime(0, now + 0.16);
        tone.connect(gain); gain.connect(context.destination);
        tone.onended = () => { tone.disconnect(); gain.disconnect(); };
        tone.start(now); tone.stop(now + 0.18);
      } catch (error) { /* The visible recording cue remains available. */ }
    }
    async function onMic() {
      if (!session.open || mic.disabled) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) { fallback('이 브라우저에서 음성을 사용할 수 없습니다. 글로 답하거나 다른 브라우저에서 열어 주세요.'); return; }
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
      phase = 'connecting';
      setMic('상황 듣기', false, true);
      setState('연결 중');
      try { await openSocket(assistantText(current)); }
      catch (error) { if (session.open) fallback(error.message || '음성 연결을 열지 못했습니다. 글로 답해 주세요.'); }
    }
    mic.addEventListener('click', () => { onMic(); });
    review.addEventListener('submit', event => {
      event.preventDefault();
      if (phase !== 'review' || !reviewInput.value.trim()) return;
      submitAnswer(reviewInput.value.trim());
    });
    again.addEventListener('click', async () => {
      if (phase !== 'review') return;
      textDraft = reviewInput.value;
      finalHeard = textDraft; interimHeard = '';
      review.hidden = true; mic.hidden = false;
      phase = 'connecting'; setState('다시 말할 준비를 하고 있습니다.'); setMic('마이크 준비 중', false, true);
      session.generation += 1;
      if (socket) { socket.close(); socket = null; }
      try { await context.resume(); await openSocket('', false); if (session.open) await startMic(); }
      catch (error) { if (session.open) fallback('다시 녹음하지 못했습니다. 인식된 답변을 글로 확인해 주세요.'); }
    });
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
    const button = node('button', 'ui-button ui-button--primary form-submit', '동의하고 시작');
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
    const button = node('button', 'ui-button ui-button--primary form-submit', '확인하고 평가 시작');
    button.type = 'submit';
    const note = node('p', 'ui-status', '');
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
