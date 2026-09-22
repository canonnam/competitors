const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// A small event-driven DOM/audio harness; no real microphone or credentials.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.className = ''; this.textContent = ''; this.value = ''; }
  get classList() { return {contains: name => this.className.split(' ').includes(name)}; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  replaceWith(item) { const index = this.parent.children.indexOf(this); this.parent.children[index] = item; item.parent = this.parent; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  focus() {}
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || (selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tag === selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  click() { if (!this.disabled) return this.events.click?.({preventDefault() {}}); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const state = () => ({name:'테스트', role:'요양보호사', branch_label:'인천점', status:'in_progress', consented:true, authenticated:true, input_open:true, scenario_id:'fall', voice:{available:true}, progress:{current:1,total:6}, messages:[{role:'assistant',text:'상황 1/6 · 낙상'}]});
const setup = {model:'models/test-live', generationConfig:{responseModalities:['AUDIO']}, inputAudioTranscription:{}};
const credentials = {token:'auth_tokens/test',model:setup.model,setup,websocket_url:'wss://example.test',speak:'상황 읽기'};
async function harness(options = {}) {
  const app = new Element('main'), timers = new Map(), sockets = [], calls = [];
  let timerId = 0, stopped = 0, audioClosed = 0, micRequests = 0, cues = 0, processor;
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
    open() { this.readyState = 1; this.onopen(); }
    send(text) { this.sent.push(JSON.parse(text)); }
    message(value) { return this.onmessage({data:JSON.stringify(value)}); }
    close() { this.readyState = 3; this.onclose?.({code:1000}); }
  }
  class AudioContext {
    constructor() { this.sampleRate = options.sampleRate || 48000; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    close() { audioClosed++; return Promise.resolve(); }
    createMediaStreamSource() { return {connect() {},disconnect() {}}; }
    createScriptProcessor() { processor = {connect() {},disconnect() {}}; return processor; }
    createGain() { return {gain:{value:0, setValueAtTime(){},linearRampToValueAtTime(){}}, connect() {},disconnect() {}}; }
    createOscillator() { return {frequency:{value:0},connect(){},disconnect(){},start(){cues++;},stop(){}}; }
  }
  const context = {
    document:{getElementById:()=>app, createElement:tag=>new Element(tag)},
    location:{hash:'#test-token'}, WebSocket:Socket, Blob, btoa, atob,
    navigator:{mediaDevices:{async getUserMedia(config) { micRequests++; if (options.mic) await options.mic(config); return {getTracks:()=>[{stop(){stopped++;}}]}; }}},
    window:{AudioContext, setTimeout(fn, ms) { timers.set(++timerId,{fn,ms}); return timerId; }, clearTimeout(id) { timers.delete(id); }},
    async fetch(url, config) {
      calls.push({url,config});
      if (url.endsWith('/live-token')) {
        const value = options.token ? await options.token() : credentials;
        return {ok:!value.error,json:async()=>value};
      }
      if (url.endsWith('/message')) return {ok:false,json:async()=>({error:'저장 실패'})};
      if (url.endsWith('/skip')) return {ok:true,json:async()=>({...state(),scenario_id:'infection',progress:{current:2,total:6},messages:[{role:'assistant',text:'상황 2/6 · 감염'}]})};
      return {ok:true,json:async()=>state()};
    },
  };
  vm.runInNewContext(fs.readFileSync('assets/staff-eval-session.js','utf8'), context);
  await flush();
  return {
    app,timers,sockets,calls,
    button(text) { return app.querySelectorAll('button').find(el=>el.textContent === text); },
    async tick(ms) { const item = [...timers].find(([,t])=>t.ms === ms); assert.ok(item, `timer ${ms} exists`); timers.delete(item[0]); item[1].fn(); await flush(); },
    stats() { return {stopped,audioClosed,micRequests,cues}; },
    audio(samples = new Float32Array([0,0.25,-0.25,1,-1])) { processor?.onaudioprocess?.({inputBuffer:{getChannelData:()=>samples}}); },
    async record() {
      this.button('상황 듣기').click(); await flush();
      const ws = sockets.at(-1); ws.open(); await ws.message({setupComplete:{}}); await flush();
      await ws.message({serverContent:{turnComplete:true}}); await this.tick(80);
      this.button('답변 말하기').click(); await flush();
      return ws;
    },
    async review(ws, text = '안전을 확보하고 보고합니다.') {
      this.audio();
      await ws.message({serverContent:{inputTranscription:{text}}});
      this.button('답변 끝내기').click(); await flush(); await this.tick(300);
      await ws.message({serverContent:{turnComplete:true}}); await this.tick(1800);
    },
  };
}

test('wire setup is accepted before any read prompt and startup timeout is cleared', async () => {
  const h = await harness();
  h.button('상황 듣기').click(); await flush();
  const ws = h.sockets[0]; ws.open();
  assert.deepEqual(ws.sent, [{setup}]);
  assert.equal(ws.url, 'wss://example.test?access_token=auth_tokens%2Ftest');
  await ws.message({setupComplete:{}}); await flush();
  assert.equal(ws.sent.length, 2);
  assert.ok(ws.sent[1].clientContent.turns[0].parts[0].text.startsWith('[읽기]'));
  assert.equal(ws.sent[1].clientContent.turnComplete, true);
  assert.ok(![...h.timers.values()].some(t=>t.ms === 15000));
  h.button('글로 답하기').click();
  assert.equal(ws.readyState, 3);
  assert.equal(h.stats().audioClosed, 1);
});

test('failed token can be retried without losing a typed draft', async () => {
  let attempts = 0;
  const h = await harness({token:()=>++attempts === 1 ? {error:'일시적 연결 실패'} : credentials});
  h.button('상황 듣기').click(); await flush();
  assert.ok(h.button('음성 다시 시도'));
  const field = h.app.querySelector('textarea'); field.value = '작성 중인 답변'; field.events.input();
  h.button('음성 다시 시도').click();
  h.button('상황 듣기').click(); await flush();
  assert.equal(h.sockets.length, 1);
  h.button('글로 답하기').click();
  assert.equal(h.app.querySelector('textarea').value, '작성 중인 답변');
});

test('a late token response cannot open a socket after switching to text', async () => {
  let release;
  const h = await harness({token:()=>new Promise(resolve=>{release=resolve;})});
  h.button('상황 듣기').click(); await flush();
  h.button('글로 답하기').click();
  release(credentials); await flush();
  assert.equal(h.sockets.length, 0);
  assert.ok(h.app.querySelector('textarea'));
});

test('setup rejection and connection timeout both close the socket and allow retry', async () => {
  for (const timeout of [false,true]) {
    const h = await harness();
    h.button('상황 듣기').click(); await flush();
    const ws = h.sockets[0]; ws.open();
    if (timeout) await h.tick(15000);
    else { await ws.message({error:{code:400}}); await flush(); }
    assert.equal(ws.readyState, 3);
    assert.ok(h.button('음성 다시 시도'));
    assert.equal(h.timers.size, 0);
  }
});

test('recognized answer survives a save failure and capture timer is cancelled', async () => {
  const h = await harness();
  const ws = await h.record();
  await h.review(ws);
  assert.deepEqual(ws.sent.at(-1), {realtimeInput:{activityEnd:{}}});
  assert.ok(![...h.timers.values()].some(t=>t.ms === 60000));
  assert.equal(h.calls.filter(c=>c.url.endsWith('/message')).length, 0, 'never auto-submit');
  h.app.querySelector('.voice-review').events.submit({preventDefault(){}}); await flush();
  assert.equal(h.app.querySelector('textarea').value, '안전을 확보하고 보고합니다.');
  assert.equal(h.stats().stopped, 1);
  assert.equal(ws.readyState, 3);
  const saved = h.calls.find(call=>call.url.endsWith('/message'));
  assert.equal(JSON.parse(saved.config.body).text, '안전을 확보하고 보고합니다.');
});

test('cue waits for actual microphone samples and native PCM preserves all samples', async () => {
  for (const sampleRate of [44100,48000]) {
    const h = await harness({sampleRate});
    const ws = await h.record();
    assert.equal(h.stats().cues, 0);
    assert.ok(!ws.sent.some(x=>x.realtimeInput?.activityStart));
    assert.ok(h.app.querySelector('.voice-state').textContent.includes('시작음을 기다려'));
    h.audio(new Float32Array([0,0.5,-0.5,1,-1]));
    assert.equal(h.stats().cues, 1);
    assert.equal(h.app.querySelector('.voice').dataset.phase, 'capturing');
    const packets = ws.sent.filter(x=>x.realtimeInput);
    assert.deepEqual(packets[0], {realtimeInput:{activityStart:{}}});
    assert.equal(packets[1].realtimeInput.audio.mimeType, 'audio/pcm;rate=' + sampleRate);
    const pcm = Buffer.from(packets[1].realtimeInput.audio.data,'base64');
    assert.equal(pcm.length,10);
    assert.equal(pcm.readInt16LE(4),-16384);
    h.button('답변 끝내기').click(); await flush();
    h.audio(); // Trailing syllable remains inside the activity boundary.
    assert.ok(ws.sent.at(-1).realtimeInput.audio);
    await h.tick(300);
    assert.ok(ws.sent.at(-1).realtimeInput.activityEnd);
    h.button('글로 답하기').click();
    assert.equal(h.timers.size,0);
  }
});

test('repeated and late transcription is retained without overwriting corrections', async () => {
  const h = await harness(), ws = await h.record();
  h.audio();
  for (const text of ['확인 ', '확인 ', '합니다.']) await ws.message({serverContent:{inputTranscription:{text}}});
  h.button('답변 끝내기').click(); await flush(); await h.tick(300);
  await ws.message({serverContent:{turnComplete:true}}); await h.tick(1800);
  const input = h.app.querySelector('textarea');
  assert.equal(input.value,'확인 확인 합니다.');
  await ws.message({serverContent:{inputTranscription:{text:' 보고합니다.'}}});
  assert.equal(input.value,'확인 확인 합니다. 보고합니다.');
  input.value = '직접 수정한 답변'; input.events.input();
  await ws.message({serverContent:{inputTranscription:{text:' 기록합니다.'}}});
  assert.equal(input.value,'직접 수정한 답변');
  h.app.querySelector('.voice-review').events.submit({preventDefault(){}}); await flush();
  assert.equal(h.app.querySelector('textarea').value,'직접 수정한 답변');
  assert.equal(JSON.parse(h.calls.find(c=>c.url.endsWith('/message')).config.body).text,'직접 수정한 답변');
});

test('rerecord isolates late events from the previous connection', async () => {
  const h = await harness(), ws = await h.record(); await h.review(ws);
  h.button('다시 말하기').click(); await flush();
  const next = h.sockets.at(-1); assert.notEqual(next,ws); next.open();
  await next.message({setupComplete:{}}); await flush(); h.audio();
  await ws.message({serverContent:{inputTranscription:{text:'이전 녹음'}}});
  await next.message({serverContent:{inputTranscription:{text:'새 답변'}}});
  assert.equal(h.app.querySelector('.live-line').textContent,'새 답변');
  h.button('글로 답하기').click();
  assert.equal(h.timers.size,0);
});

test('skip is blocked during recording and advances explicitly in either mode', async () => {
  for (const textMode of [false,true]) {
    const h = await harness();
    if (textMode) h.button('글로 답하기').click();
    else {
      const ws = await h.record();
      assert.equal(h.button('이 문항 건너뛰기').disabled,true);
      await h.review(ws);
    }
    await h.button('이 문항 건너뛰기').click(); await flush();
    const skipped = h.calls.find(c=>c.url.endsWith('/skip'));
    assert.deepEqual(JSON.parse(skipped.config.body),{scenario_id:'fall'});
    assert.equal(h.app.querySelectorAll('.progress')[1].textContent,'진행 2/6');
    assert.equal(h.calls.filter(c=>c.url.endsWith('/message')).length,0);
    assert.equal(h.timers.size,0);
  }
});

test('missing microphone samples time out and a cancelled permission request stops tracks', async () => {
  const h = await harness(); await h.record(); await h.tick(5000);
  assert.ok(h.app.querySelector('textarea'));
  assert.equal(h.stats().cues,0);
  assert.equal(h.stats().stopped,1);
  assert.equal(h.timers.size,0);
  let release;
  const pending = await harness({mic:()=>new Promise(resolve=>{release=resolve;})});
  await pending.record();
  pending.button('글로 답하기').click(); release(); await flush();
  assert.equal(pending.stats().stopped,1);
  assert.equal(pending.stats().cues,0);
  assert.equal(pending.timers.size,0);
});
