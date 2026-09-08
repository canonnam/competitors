import { marked } from '/assets/vendor/marked.esm.js';
import DOMPurify from '/assets/vendor/purify.es.mjs';

const icon = name => `<img src="/assets/icons/${name}.svg" alt="" aria-hidden="true">`;
const launcher = document.createElement('button');
launcher.className = 'wiki-launcher';
launcher.type = 'button';
launcher.setAttribute('aria-label', '위키에게 질문하기');
launcher.setAttribute('aria-expanded', 'false');
launcher.setAttribute('aria-controls', 'wiki-chat-panel');
launcher.title = '위키에게 질문하기';
launcher.innerHTML = icon('message-circle');
const panel = document.createElement('dialog');
panel.id = 'wiki-chat-panel';
panel.className = 'wiki-panel';
panel.setAttribute('aria-labelledby', 'wiki-chat-title');
panel.innerHTML = `
  <div class="wiki-topbar">
    <div class="wiki-title-group"><h2 id="wiki-chat-title">위키에게 질문하기</h2><p class="wiki-state" role="status">연결 확인 중</p></div>
    <button class="wiki-icon-button wiki-reset" type="button" title="새 대화" aria-label="새 대화">${icon('rotate-ccw')}</button>
    <a class="wiki-icon-button" href="/knowledge.html" title="지식 문서 관리" aria-label="지식 문서 관리">${icon('settings')}</a>
    <button class="wiki-icon-button wiki-close" type="button" title="대화창 닫기" aria-label="대화창 닫기">${icon('x')}</button>
  </div>
  <div class="wiki-messages" role="log" aria-label="위키 대화" aria-live="polite" aria-relevant="additions"></div>
  <form class="wiki-composer">
    <div class="wiki-input-row"><textarea rows="2" maxlength="2000" aria-label="위키에 질문" placeholder="궁금한 내용을 물어보세요"></textarea><button class="wiki-icon-button wiki-send" type="submit" title="질문 보내기" aria-label="질문 보내기" disabled>${icon('send')}</button></div>
    <p class="wiki-error" role="alert" hidden></p>
  </form>`;
document.body.append(launcher, panel);
const messages = panel.querySelector('.wiki-messages');
const input = panel.querySelector('textarea');
const send = panel.querySelector('.wiki-send');
const reset = panel.querySelector('.wiki-reset');
const state = panel.querySelector('.wiki-state');
const error = panel.querySelector('.wiki-error');
let history = [], pending = false, controller, failedQuestion = null;
try {
  const saved = JSON.parse(sessionStorage.getItem('vida-wiki-conversation') || '[]');
  if (Array.isArray(saved)) history = saved.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-20);
} catch { /* Conversation storage is optional in private browsing. */ }

function save() {
  try { sessionStorage.setItem('vida-wiki-conversation', JSON.stringify(history.slice(-20))); } catch { /* Storage can be unavailable. */ }
}
function scroll() { messages.scrollTop = messages.scrollHeight; }
function refreshSend() { send.disabled = !input.value.trim() || pending; }
function renderMessage(message) {
  const article = document.createElement('article');
  article.className = `wiki-message wiki-message-${message.role}`;
  const label = document.createElement('p');
  label.className = 'wiki-message-label';
  label.textContent = message.role === 'user' ? '나' : '더비다 위키';
  const body = document.createElement('div');
  body.className = 'wiki-text';
  if (message.role === 'user') body.textContent = message.content;
  else body.innerHTML = DOMPurify.sanitize(marked.parse(message.content), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'pre'],
    ALLOWED_ATTR: [],
  });
  article.append(label, body);
  if (message.role === 'assistant' && Array.isArray(message.sources) && message.sources.length) {
    const sources = document.createElement('div');
    sources.className = 'wiki-sources';
    const heading = document.createElement('p');
    heading.className = 'wiki-sources-heading';
    heading.textContent = '참고한 위키 문서';
    sources.append(heading);
    for (const source of message.sources) {
      const detail = document.createElement('details');
      detail.className = 'wiki-source';
      const title = document.createElement('summary');
      title.textContent = `[${source.number}] ${source.title}`;
      const date = document.createElement('p');
      date.className = 'wiki-source-date';
      date.textContent = `문서 갱신 ${source.updated}${source.status === 'needs-review' ? ' · 검토 필요' : ''}`;
      const excerpt = document.createElement('pre');
      excerpt.textContent = source.excerpt;
      detail.append(title, date, excerpt);
      sources.append(detail);
    }
    article.append(sources);
  }
  if (message.role === 'assistant') {
    const copy = document.createElement('button');
    copy.className = 'wiki-icon-button wiki-copy';
    copy.type = 'button';
    copy.title = '답변 복사';
    copy.setAttribute('aria-label', '답변 복사');
    copy.innerHTML = icon('copy');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(message.content); copy.title = '복사했습니다'; }
      catch { copy.title = '복사하지 못했습니다'; }
    };
    article.append(copy);
  }
  messages.append(article);
  scroll();
}
function render() {
  messages.replaceChildren();
  if (history.length) history.forEach(renderMessage);
  else {
    const welcome = document.createElement('div');
    welcome.className = 'wiki-welcome';
    welcome.innerHTML = `${icon('book-open')}<h3>어떤 업무가 궁금하세요?</h3><div class="wiki-suggestions"></div>`;
    welcome.querySelector('img').className = 'wiki-book';
    for (const question of ['물리치료사 대신 작업치료사를 배치해도 되나요?', '요양원 CCTV 해상도 기준은 무엇인가요?', '인력 가산·감산 기준을 알려주세요']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = question;
      button.onclick = () => { input.value = question; refreshSend(); input.focus(); };
      welcome.querySelector('.wiki-suggestions').append(button);
    }
    messages.append(welcome);
  }
}
async function checkStatus() {
  try {
    const response = await fetch('/api/chat/status', {signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error();
    const data = await response.json();
    state.textContent = data.ready ? `위키 문서 ${data.documentCount}개 연결됨` : (data.documentCount ? `위키 ${data.documentCount}개 · 답변 연결 준비 중` : '지식 문서 등록 대기 중');
  } catch { state.textContent = '연결을 확인해주세요'; }
}
function close() { panel.close(); launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }
launcher.onclick = () => {
  if (panel.open) close();
  else { panel.show(); launcher.setAttribute('aria-expanded', 'true'); input.focus(); scroll(); checkStatus(); }
};
panel.querySelector('.wiki-close').onclick = close;
panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
reset.onclick = () => {
  if (pending) return;
  history = []; failedQuestion = null; save(); render(); error.hidden = true; input.value = ''; refreshSend(); input.focus();
};
input.addEventListener('input', refreshSend);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !pending) { event.preventDefault(); panel.querySelector('form').requestSubmit(); }
});
panel.querySelector('form').onsubmit = async event => {
  event.preventDefault();
  const question = input.value.trim();
  if (!question || pending) return;
  const isRetry = failedQuestion === question && history.at(-1)?.role === 'user';
  const previous = (isRetry ? history.slice(0, -1) : history).slice(-6).map(({role, content}) => ({role, content: content.slice(0, 6000)}));
  if (!isRetry) { history.push({role: 'user', content: question}); save(); }
  failedQuestion = null;
  input.value = ''; pending = true; reset.disabled = true; error.hidden = true; refreshSend(); render();
  const loading = document.createElement('div');
  loading.className = 'wiki-thinking';
  loading.setAttribute('role', 'status');
  loading.textContent = '위키에서 근거를 찾아 답변을 작성하고 있습니다';
  messages.append(loading); scroll();
  controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 85000);
  try {
    const response = await fetch('/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal, body: JSON.stringify({message: question, history: previous})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '답변을 받지 못했습니다. 다시 시도해주세요.');
    history.push({role: 'assistant', content: data.answer, sources: data.sources});
    save(); loading.remove(); renderMessage(history.at(-1));
  } catch (failure) {
    failedQuestion = question;
    error.hidden = false;
    error.textContent = failure.name === 'AbortError' ? '답변 시간이 길어졌습니다. 잠시 후 다시 시도해주세요.' : failure.message;
    input.value = question;
  } finally {
    clearTimeout(timer); loading.remove(); pending = false; reset.disabled = false; refreshSend();
    if (panel.open) input.focus();
  }
};
render();
