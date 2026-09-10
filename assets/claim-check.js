(function () {
  'use strict';
  const home = document.getElementById('home-claim-status');
  const grid = document.getElementById('claim-branches');
  if (!home && !grid) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const monthText = month => `${month.slice(0,4)}년 ${Number(month.slice(5))}월`;
  const dateText = value => value ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)) : '확인 기록 없음';
  const badge = branch => `<span class="claim-badge ${branch.status === 'accepted' ? 'accepted' : ''}">${escape(branch.label)}</span>`;
  const queryNote = branch => branch.lastQueryFailureAt ? `<p class="claim-query-note">${escape(dateText(branch.lastQueryFailureAt))} ${branch.checkedAt ? '재조회 실패 · 이전에 확인한 청구 결과를 유지합니다.' : '공단 조회 실패 · 연결 상태를 확인해주세요.'}</p>` : '';
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    const button = document.getElementById('claim-refresh');
    if (button) button.disabled = true;
    try {
      const response = await fetch('/api/claim-check', {cache:'no-store',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('request');
      const data = await response.json();
      if (!Array.isArray(data.branches) || data.branches.length !== 2) throw new Error('format');
      const deadline = `${Number(data.deadline.slice(5,7))}월 ${Number(data.deadline.slice(8))}일`;
      if (home) {
        document.getElementById('home-claim-period').textContent = `${monthText(data.benefitMonth)} 급여 · ${deadline} 마감`;
        home.innerHTML = data.branches.map(b => `<div class="claim-home-row"><strong>${escape(b.name)}</strong><span>${b.verifiedItems}/3 항목 · ${badge(b)}</span></div>`).join('');
        const times = data.branches.map(b=>b.checkedAt).filter(Boolean).sort();
        document.getElementById('home-claim-time').textContent = times.length === 2 ? `${dateText(times[0])} 조회 기준` : '지점별 확인 기록을 확인해주세요.';
      }
      if (grid) {
        document.getElementById('claim-period').textContent = `${monthText(data.benefitMonth)} 급여제공분`;
        document.getElementById('claim-deadline').textContent = `${data.deadline.replaceAll('-','. ')} 청구 마감`;
        document.getElementById('claim-due-state').textContent = data.allAccepted ? '두 지점 접수 완료' : data.daysUntilDeadline === 0 ? '오늘 마감 · 점검 필요' : data.daysUntilDeadline < 0 ? '마감일 경과 · 점검 필요' : `마감까지 ${data.daysUntilDeadline}일`;
        grid.innerHTML = data.branches.map(b => `<article class="claim-branch"><div class="claim-branch-heading"><h2>${escape(b.name)}</h2>${badge(b)}</div><p>${escape(b.message)}</p><p class="claim-checked">청구 상태 확인 · ${escape(dateText(b.checkedAt))}</p>${queryNote(b)}${(b.claims.length || b.missing.length) ? `<div class="claim-table-wrap"><table class="claim-table"><thead><tr><th scope="col">급여종류</th><th scope="col">수급자 구분</th><th scope="col">청구일</th><th scope="col">처리상태</th></tr></thead><tbody>${[...b.claims, ...b.missing.map(c=>({...c,claimType:'',submittedOn:null,processingStatus:'미확인'}))].map(c=>`<tr><td>${escape(c.benefitType.replace('(개정법)',''))}</td><td>${escape(c.recipientType)}<br><span class="claim-muted">${escape(c.claimType)}</span></td><td>${escape(c.submittedOn || '미확인')}</td><td>${escape(c.processingStatus)}</td></tr>`).join('')}</tbody></table></div>` : ''}</article>`).join('');
        document.getElementById('claim-sync').textContent = '저장된 공단 조회 결과입니다. 새로고침은 저장 결과를 다시 불러옵니다.';
      }
    } catch (_) {
      if (home) {
        home.textContent = '점검 · 청구 상태를 불러오지 못했습니다.';
        document.getElementById('home-claim-time').textContent = '';
      }
      if (grid) {
        grid.innerHTML = '<p class="claim-error" role="alert">청구 상태를 불러오지 못했습니다. 다시 새로고침하거나 공단에서 확인해주세요.</p>';
        document.getElementById('claim-due-state').textContent = '점검 필요';
        document.getElementById('claim-sync').textContent = '저장 결과 조회 실패';
      }
    } finally {
      loading = false;
      if (button) button.disabled = false;
    }
  }
  document.getElementById('claim-refresh')?.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => {if (!document.hidden) refresh();});
  setInterval(() => {if (!document.hidden) refresh();}, 300000);
  refresh();
})();
