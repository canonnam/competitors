/* Existing pages keep their feedback forms; the ads page uses this fallback. */
if (typeof window.openFeedback !== 'function') {
  window.openFeedback = function () {
    let dialog = document.getElementById('kb-feedback-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'kb-feedback-dialog';
      dialog.className = 'kb-feedback-dialog';
      dialog.setAttribute('aria-labelledby', 'kb-feedback-title');
      dialog.innerHTML = '<h2 id="kb-feedback-title">개선요청</h2><form><label>분류<select name="category"><option value="data">데이터·출처 보정</option><option value="content">분석·비교 개선</option><option value="ui">화면·사용성 개선</option><option value="feature">새 기능 제안</option><option value="issue">오류 신고</option></select></label><label>개선 의견<textarea name="message" required minlength="5" maxlength="4000"></textarea></label><p role="status"></p><div class="kb-dialog-actions"><button type="button">취소</button><button type="submit">의견 보내기</button></div></form>';
      document.body.appendChild(dialog);
      dialog.querySelector('[type="button"]').onclick = () => dialog.close();
      dialog.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const form = event.target, button = form.querySelector('[type="submit"]'), status = form.querySelector('[role="status"]');
        button.disabled = true; status.textContent = '접수 중';
        try {
          const fields = new FormData(form);
          const response = await fetch('/api/feedback', {method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(20000), body:JSON.stringify({category:fields.get('category'), message:fields.get('message'), page:'naver-ads'})});
          if (!response.ok) throw new Error('request');
          const data = await response.json();
          status.textContent = `개선요청 #${data.id}가 접수되었습니다.`; form.reset();
        } catch { status.textContent = '접수에 실패했습니다. 잠시 후 다시 시도해주세요.'; }
        finally { button.disabled = false; }
      };
    }
    dialog.showModal();
  };
}
