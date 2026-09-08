(function (root) {
  'use strict';
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  const previousMonth = month => {
    const [year, m] = month.split('-').map(Number);
    return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
  };
  function groups(month, key) {
    const result = {};
    for (const row of month?.accounts || []) result[row.group] = (result[row.group] || 0) + row[key];
    return result;
  }
  function drivers(current, previous) {
    if (!current || !previous || previous.month !== previousMonth(current.month)) return [];
    const result = [];
    for (const [key, sign, label] of [['income', 1, '수입'], ['expense', -1, '비용']]) {
      const before = groups(previous, key), after = groups(current, key);
      for (const group of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const delta = (after[group] || 0) - (before[group] || 0);
        if (delta) result.push({group, label, delta, impact: delta * sign, before: before[group] || 0, after: after[group] || 0});
      }
    }
    return result.sort((a,b) => a.impact - b.impact);
  }
  function combined(months) {
    if (months.some(m => !m)) return null;
    return Object.fromEntries(['revenue','cost','profit','cashChange'].map(k => [k,sum(months,k)]));
  }
  function csv(report, year) {
    const rows = [['월','지점','운영수입(원)','운영비용(원)','운영손익(원,입출금기준)','자금증감(원)','차입·상환 순액(원)','시설투자 순액(원)','기타이동 순액(원)','오입금·반환 순액(원)','월말잔액(원)']];
    const months = [...new Set(report.branches.flatMap(b=>b.months.map(m=>m.month)))].filter(m=>year==='all'||m.startsWith(year)).sort();
    for(const month of months) for(const branch of report.branches) {
      const m=branch.months.find(m=>m.month===month);
      rows.push(m ? [month,branch.name,...['revenue','cost','profit','cashChange','financing','investment','transfer','correction','closingBalance'].map(k=>m[k])] : [month,branch.name,...Array(9).fill('자료 없음')]);
    }
    return '\ufeff'+rows.map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n');
  }
  const api = {sum,previousMonth,groups,drivers,combined,csv};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  else root.OperatingModel=api;
})(typeof window === 'undefined' ? globalThis : window);
