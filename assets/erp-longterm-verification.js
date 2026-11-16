(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const homeBadge = byId('home-erp-longterm-status');
  const page = byId('verification-report');
  if (!homeBadge && !page) return;

  const branches = {anyang: '안양점', incheon: '인천점'};
  const categories = {admission: '입퇴소·외박', work: '근무내용', misc: '기타자료', program: '프로그램'};
  const types = {difference: '기록 차이', review: '추가 확인'};
  const statuses = {complete: '점검 완료', partial: '일부 점검', blocked: '점검 대기', missing: '기록 없음'};
  const monthLabel = (month) => `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`;
  const dateLabel = (date) => {
    const [year, month, day] = date.split('-').map(Number);
    return `${year}년 ${month}월 ${day}일`;
  };
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  const count = (findings, type) => findings.filter((item) => item.type === type).length;

  function renderUpdates(updates) {
    if (!updates.length) return;
    byId('verification-updates').hidden = false;
    byId('verification-updates-title').textContent = `자동화 업데이트 ${updates.length}건`;
    const list = byId('verification-update-list');
    for (const update of [...updates].sort((a, b) => b.date.localeCompare(a.date))) {
      const item = element('li');
      const date = element('time', dateLabel(update.date));
      date.dateTime = update.date;
      item.append(date, element('h3', update.title), element('p', update.detail));
      list.append(item);
    }
  }

  function renderOverview(report, months) {
    const range = months.length === 1 ? monthLabel(months[0]) :
      `${monthLabel(months.at(-1))}~${monthLabel(months[0])} (${months.length}개월)`;
    byId('verification-period').textContent = `${range} · 최근 반영 ${dateLabel(report.updatedOn)}`;
    for (const card of page.querySelectorAll('[data-branch]')) {
      const branch = card.dataset.branch;
      const results = months.map((month) => report.months[month][branch]).filter(Boolean);
      const completed = results.filter((result) => result.status === 'complete').length;
      const records = report.findings.filter((item) => item.branch === branch && months.includes(item.month));
      let status = 'missing';
      if (completed === months.length) status = 'complete';
      else if (completed || results.some((result) => result.status === 'partial')) status = 'partial';
      else if (results.length) status = 'blocked';
      const badge = card.querySelector('.ui-status');
      badge.textContent = statuses[status];
      badge.dataset.status = status === 'complete' ? 'success' : 'warning';
      const summary = card.querySelector('p');
      if (status === 'blocked') summary.textContent = '검증 자료 확인을 기다리고 있습니다.';
      else if (status === 'missing') summary.textContent = '선택한 월의 점검 기록이 없습니다.';
      else summary.textContent =
        `${completed}/${months.length}개월 완료 · 기록 차이 ${count(records, 'difference')}건 · 추가 확인 ${count(records, 'review')}건`;
      if (months.length === 1 && results[0]?.note) summary.append(` · ${results[0].note}`);
    }
  }

  function findingRow(finding) {
    const row = element('tr');
    const month = element('td', monthLabel(finding.month));
    if (finding.date) month.append(element('small', finding.date));
    const task = element('td', categories[finding.category]);
    task.append(element('small', types[finding.type]));
    const detail = element('td');
    if (finding.subject) detail.append(element('strong', finding.subject));
    detail.append(element('span', finding.detail));
    row.append(month, element('td', branches[finding.branch]), task, detail);
    return row;
  }

  function renderPage(report, months) {
    const monthFilter = byId('verification-month');
    const branchFilter = byId('verification-branch');
    const categoryFilter = byId('verification-category');
    const typeFilter = byId('verification-type');
    for (const month of months) {
      const option = element('option', monthLabel(month));
      option.value = month;
      monthFilter.append(option);
    }
    const refresh = () => {
      const month = monthFilter.value;
      renderOverview(report, month ? [month] : months);
      const current = report.findings.filter((item) =>
        (!month || item.month === month) &&
        (!branchFilter.value || item.branch === branchFilter.value) &&
        (!categoryFilter.value || item.category === categoryFilter.value) &&
        (!typeFilter.value || item.type === typeFilter.value));
      byId('verification-rows').replaceChildren(...current.map(findingRow));
      byId('verification-table').hidden = !current.length;
      byId('verification-result').textContent = current.length ?
        `기록 차이 ${count(current, 'difference')}건 · 추가 확인 ${count(current, 'review')}건` :
        '선택한 조건에 해당하는 지적사항이 없습니다. 점검 여부는 위의 지점별 현황에서 확인할 수 있습니다.';
    };
    [monthFilter, branchFilter, categoryFilter, typeFilter].forEach((filter) => {
      filter.addEventListener('change', refresh);
    });
    renderUpdates(report.updates);
    refresh();
    byId('verification-load').hidden = true;
    page.hidden = false;
  }

  async function loadReport() {
    try {
      const response = await fetch('/api/erp-longterm-verification', {cache: 'no-store'});
      if (!response.ok) throw new Error('Verification report unavailable');
      const report = await response.json();
      const months = Object.keys(report.months).sort().reverse();
      if (!months.length) throw new Error('Verification report is empty');
      if (homeBadge) {
        homeBadge.textContent = Object.entries(branches).map(([id, name]) => {
          const label = statuses[report.months[months[0]][id]?.status] ?? statuses.missing;
          return `${name.slice(0, -1)} ${label.replace('점검 ', '')}`;
        }).join(' · ');
      }
      if (page) renderPage(report, months);
    } catch {
      if (page) byId('verification-load').textContent = '검증 내역을 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
    }
  }

  loadReport();
})();
