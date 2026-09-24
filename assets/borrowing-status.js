(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const number = value => Number(value || 0).toLocaleString('ko-KR');
  const exact = value => `${number(value)}원`;
  const money = value => `${(Number(value || 0) / 10000).toLocaleString('ko-KR', {minimumFractionDigits:1, maximumFractionDigits:1})}만원`;
  const signedMoney = value => `${value > 0 ? '+' : ''}${money(value)}`;
  const typeLabels = [
    ['financial-institution-borrowing', '금융기관 차입'],
    ['other-borrowing', '기타차입금'],
    ['principal-repayment', '원금상환'],
    ['loan-related', '대여 관련'],
    ['other-financing', '기타 차입·상환']
  ];
  let report;
  let selectedYear = 'all';

  const monthsFor = branch => branch.months.filter(month => selectedYear === 'all' || month.month.startsWith(selectedYear));
  const detailFor = month => month.financingBreakdown || [];
  const typeFor = (month, type) => detailFor(month).find(item => item.type === type) || {income:0, expense:0, count:0};
  const sum = (rows, getValue) => rows.reduce((total, row) => total + getValue(row), 0);
  const detailCount = month => sum(detailFor(month), item => item.count || 0);
  const rangeLabel = () => selectedYear === 'all' ? '전체 제공 기간' : `${selectedYear}년`;
  const periodMonths = () => report.branches.flatMap(monthsFor);

  function renderKpis(months) {
    const allDetails = months.flatMap(detailFor);
    const totalIncome = sum(allDetails, item => item.income || 0);
    const principalExpense = sum(months, month => typeFor(month, 'principal-repayment').expense || 0);
    const net = sum(months, month => month.financing || 0);
    const count = sum(months, detailCount);
    const values = [
      ['차입 관련 수입', totalIncome, `유형별 합계 · ${number(count)}건`],
      ['원금상환 지출', principalExpense, '원금상환 계정·분류 합계'],
      ['차입·상환 순액', net, `${rangeLabel()} 현금흐름 누계`],
      ['현재 원금 잔액', null, '기초 원금 잔액 자료 미제공']
    ];
    $('kpis').innerHTML = values.map(([label, value, note]) => `<article class="kpi loan-kpi"><span class="kpi-label">${label}</span><strong class="${value === null ? 'loan-balance-unknown' : 'loan-net'}" ${value === null ? '' : `title="${exact(value)}"`}>${value === null ? '별도 자료 필요' : money(value)}</strong><small>${note}</small></article>`).join('');
  }

  function branchTotals(branch) {
    const months = monthsFor(branch);
    const details = months.flatMap(detailFor);
    return {
      months,
      borrowingIncome: sum(details, item => item.income || 0),
      principalExpense: sum(months, month => typeFor(month, 'principal-repayment').expense || 0),
      net: sum(months, month => month.financing || 0),
      count: sum(months, detailCount)
    };
  }

  function renderBranches() {
    $('branches').innerHTML = report.branches.map(branch => {
      const totals = branchTotals(branch);
      const id = ['anyang','incheon'].includes(branch.id) ? branch.id : '';
      return `<article class="branch-card loan-branch-card ${id}"><div class="card-heading"><h3 class="location"><i class="${id}" aria-hidden="true"></i>${esc(branch.name)}</h3><span class="badge">${number(totals.count)}건</span></div><div class="mini-stats"><div><span>차입 관련 수입</span><strong title="${exact(totals.borrowingIncome)}">${money(totals.borrowingIncome)}</strong></div><div><span>원금상환 지출</span><strong title="${exact(totals.principalExpense)}">${money(totals.principalExpense)}</strong></div><div><span>차입·상환 순액</span><strong class="loan-net" title="${exact(totals.net)}">${signedMoney(totals.net)}</strong></div></div><p class="loan-summary-note">${totals.months.length ? `${totals.months[0].month} ~ ${totals.months.at(-1).month} 집계 · 현재 원금 잔액은 별도 자료가 필요합니다.` : '이 기간의 자료가 없습니다.'}</p></article>`;
    }).join('');
  }

  function renderHistory() {
    const rows = [];
    for (const branch of report.branches) {
      for (const month of monthsFor(branch)) {
        for (const transaction of month.financingTransactions || []) {
          const label = typeLabels.find(([type]) => type === transaction.type)?.[1] || '기타 차입·상환';
          const income = transaction.income || 0;
          const expense = transaction.expense || 0;
          rows.push({date:transaction.date, branch:branch.name, label, income, expense, net:income - expense});
        }
      }
    }
    rows.sort((left, right) => right.date.localeCompare(left.date) || left.branch.localeCompare(right.branch, 'ko') || left.label.localeCompare(right.label, 'ko'));
    $('history').innerHTML = rows.length ? rows.map(row => `<tr><td>${esc(row.date)}</td><td>${esc(row.branch)}</td><td>${row.label}</td><td title="${exact(row.income)}">${money(row.income)}</td><td title="${exact(row.expense)}">${money(row.expense)}</td><td class="loan-net" title="${exact(row.net)}">${signedMoney(row.net)}</td></tr>`).join('') : '<tr><td class="loan-empty-cell" colspan="6">선택한 기간에는 차입 관련 거래가 없습니다.</td></tr>';
    $('detail-period').textContent = `${rangeLabel()} · ${number(rows.length)}건 · 단위: 만원`;
  }

  function render() {
    const months = periodMonths();
    renderKpis(months);
    renderBranches();
    renderHistory();
    const url = new URL(window.location.href);
    if (selectedYear === 'all') url.searchParams.delete('year');
    else url.searchParams.set('year', selectedYear);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  async function load() {
    $('status').hidden = false;
    $('retry').hidden = true;
    $('dashboard').hidden = true;
    $('status').textContent = '차입금 자료를 불러오고 있습니다.';
    try {
      const response = await fetch('/api/operating-report');
      if (!response.ok) throw new Error('report unavailable');
      report = await response.json();
      if (report.schemaVersion !== 1 || report.branches?.length !== 2 || report.branches.some(branch => branch.months.some(month => !Array.isArray(month.financingBreakdown) || !Array.isArray(month.financingTransactions)))) throw new Error('financing data unavailable');
      const months = report.branches.flatMap(branch => branch.months.map(month => month.month)).sort();
      const years = [...new Set(months.map(month => month.slice(0, 4)))].sort().reverse();
      const requestedYear = new URLSearchParams(window.location.search).get('year');
      selectedYear = requestedYear === 'all' || years.includes(requestedYear) ? requestedYear || 'all' : 'all';
      $('year').innerHTML = '<option value="all">전체 제공 기간</option>' + years.map(year => `<option value="${year}">${year}년</option>`).join('');
      $('year').value = selectedYear;
      $('coverage').textContent = `자료 ${String(report.sourceDate || '').replaceAll('-', '.')} · 거래 ${months[0]} ~ ${months.at(-1)}`;
      $('methodology').textContent = `안양점 ${report.branches[0].months.length}개월 · 인천점 ${report.branches[1].months.length}개월의 익명 월별 집계를 사용합니다. 집계 기간 선택은 양 지점에 각각 적용합니다.`;
      $('dashboard').hidden = false;
      render();
      $('status').hidden = true;
    } catch (error) {
      $('status').textContent = '차입금 분류 자료를 불러오지 못했습니다. 운영비 자료를 갱신한 뒤 다시 확인해주세요.';
      $('retry').hidden = false;
    }
  }

  $('year').addEventListener('change', () => { selectedYear = $('year').value; render(); });
  $('retry').addEventListener('click', load);
  load();
})();
