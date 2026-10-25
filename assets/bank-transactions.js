(function () {
  'use strict';
  const page = document.getElementById('bank-transactions');
  if (!page) return;
  const month = document.getElementById('bt-month'), branch = document.getElementById('bt-branch');
  const error = document.getElementById('bt-error'), refresh = document.getElementById('bt-refresh');
  const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => value == null ? '—' : Number(value).toLocaleString('ko-KR') + '원';
  const time = value => value ? new Date(value).toLocaleString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : '미수집';
  let data = null, serial = 0;
  function render() {
    const selected = data.branches.filter(b => !branch.value || b.id === branch.value);
    document.getElementById('bt-period').textContent = `${data.period[0]} ~ ${data.period[1]}`;
    document.getElementById('bt-next').textContent = `다음 수집 예정 ${time(data.nextCollectionAt)} (한국시간)`;
    document.getElementById('bt-summary').innerHTML = `<div class="bt-branches">${selected.map(b => {
      const status = !b.available ? (b.failure ? '수집 실패' : '미수집') : b.failure ? '이전 성공 자료' : b.status === 'verified' ? '원본 검증 완료' : '확인 필요';
      return `<article class="bt-branch"><div class="bt-branch-heading"><h2>${esc(b.name)}</h2><span class="ui-status" ${b.available && !b.failure && b.status === 'verified' ? 'data-status="success"' : 'data-status="warning"'}>${status}</span></div><p class="bt-muted">하나은행 공단부담금 · ${esc(b.account)}</p>${b.available ? `<dl class="bt-totals"><div><dt>거래 건수</dt><dd>${b.count.toLocaleString('ko-KR')}건</dd></div><div><dt>입금 합계</dt><dd>${money(b.deposits)}</dd></div><div><dt>출금 합계</dt><dd>${money(b.withdrawals)}</dd></div><div><dt>월말 거래 후 잔액</dt><dd>${money(b.closingBalance)}</dd></div></dl><p class="bt-muted">수집 ${esc(time(b.collectedAt))}</p><a class="ui-button ui-button--primary" href="${esc(b.downloadUrl)}" download="hana-${b.id}-${data.month}.xls">${esc(b.name)} 원본 엑셀 다운로드</a>` : '<p class="bt-muted">해당 월의 은행 원본이 아직 없습니다.</p>'}${b.failure ? `<p class="bt-warning">${esc(b.failure.message)}<br>실패 확인 ${esc(time(b.failure.failedAt))}</p>` : ''}</article>`;
    }).join('')}</div>`;
    document.getElementById('bt-checks').innerHTML = selected.map(b => `<article class="bt-check"><h3>${esc(b.name)}</h3>${b.available ? `<ul><li>계좌·조회기간·원본 열 구성 확인</li><li>전체 거래 ${b.count}건 보존 · 원본 합계 ${b.deposits === b.bankDeposits && b.withdrawals === b.bankWithdrawals ? '일치' : '불일치'}</li><li>거래 간 잔액 연결 ${b.balanceChecks == null ? '검증 불가' : `${b.balanceChecks}구간 중 ${b.issues.filter(i => i.kind === 'balance').length}구간 불일치`}</li><li>다운로드 원본의 SHA-256 해시 확인</li></ul>${b.issues.length ? `<ul class="bt-warning">${b.issues.map(i => `<li>${i.row ? `엑셀 ${i.row}행: ` : ''}${esc(i.message)}</li>`).join('')}</ul>` : '<p class="bt-muted">계좌·기간·합계·잔액 검증에서 이상이 발견되지 않았습니다.</p>'}<details><summary>원본 확인 정보</summary><p class="bt-muted bt-hash">SHA-256 ${esc(b.sha256)}</p><p class="bt-muted">월초 첫 거래 전 잔액 ${money(b.openingBalance)}<br>최초 거래 ${esc(b.firstTransaction)}<br>최종 거래 ${esc(b.lastTransaction)}</p></details>` : '<p class="bt-muted">원본 수집 후 검증 결과를 표시합니다.</p>'}</article>`).join('');
    const records = selected.filter(b => b.available).flatMap(b => b.records.map(r => ({...r, branch:b.name})));
    document.getElementById('bt-table').innerHTML = records.length ? `<div class="bt-table-wrap" tabindex="0" role="region" aria-label="거래내역 표, 좌우 스크롤 가능"><table><caption>${esc(data.month)} 거래내역 ${records.length}건 · 원본 순서 유지</caption><thead><tr>${['지점','원본 행','거래일시','적요','추가메모','의뢰인/수취인','입금','출금','거래후잔액','구분'].map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${records.map(r => `<tr>${[r.branch,r.row,r.date,r.description,r.memo,r.counterparty,money(r.deposit),money(r.withdrawal),money(r.balance),r.type].map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="bt-muted">표시할 거래내역이 없습니다. 미수집은 거래 0건을 뜻하지 않습니다.</p>';
  }
  async function load() {
    const current = ++serial;
    refresh.disabled = true; error.textContent = '';
    try {
      const response = await fetch('/api/bank-transactions' + (month.value ? '?month=' + encodeURIComponent(month.value) : ''), {cache:'no-store'});
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '저장 자료를 불러오지 못했습니다.');
      if (current !== serial) return;
      data = value;
      month.innerHTML = data.months.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      month.value = data.month;
      render();
    } catch (e) {
      if (current !== serial) return;
      error.textContent = e.message;
      document.getElementById('bt-summary').textContent = '현재 저장 자료를 확인할 수 없습니다.';
      document.getElementById('bt-checks').replaceChildren();
      document.getElementById('bt-table').replaceChildren();
    } finally { if (current === serial) refresh.disabled = false; }
  }
  month.addEventListener('change', load);
  branch.addEventListener('change', () => { if (data) render(); });
  refresh.addEventListener('click', load);
  load();
})();
