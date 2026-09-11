(function (root) {
  'use strict';
  const WEEK = 365 / 7 / 12;
  const names = { D: '주', N: '야', O: '휴' };
  function contractEndDate(start, years) {
    if (!start) return '';
    const count = Number(years), value = new Date(`${start}T00:00:00Z`);
    if (![1, 2].includes(count) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== start || value.getUTCFullYear() + count > 9999) throw Error('계약 시작일과 계약기간을 확인해주세요.');
    value.setUTCFullYear(value.getUTCFullYear() + count);
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().slice(0, 10);
  }
  function minutes(value) {
    if (!/^\d{2}:\d{2}$/.test(value || '')) throw Error('근무·휴게 시각을 입력해주세요.');
    const [h, m] = value.split(':').map(Number);
    if (h > 23 || m > 59) throw Error('올바른 시각을 입력해주세요.');
    return h * 60 + m;
  }
  function interval(start, end) {
    const a = minutes(start); let b = minutes(end);
    if (b <= a) b += 1440;
    return [a, b];
  }
  const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  function nightMinutes(a, b) {
    let n = 0;
    for (let d = -1; d <= 2; d++) n += overlap(a, b, d * 1440 + 1320, (d + 1) * 1440 + 360);
    return n;
  }
  function shift(spec) {
    const [a, b] = interval(spec.start, spec.end);
    let rest = 0, nightRest = 0; const ranges = [];
    for (const item of spec.breaks) {
      if (!item.start && !item.end && !item.hours) continue;
      if (item.hours === '' || item.hours == null) throw Error('휴게시간을 입력해주세요.');
      let [c, d] = interval(item.start, item.end);
      if (c < a) { c += 1440; d += 1440; }
      const duration = Number(item.hours) * 60;
      if (!Number.isFinite(duration) || duration < 0 || duration > d - c || c < a || d > b) throw Error('휴게시간은 해당 근무시간 안에 있어야 합니다.');
      if (duration === 0) continue;
      if (ranges.some(([x, y]) => overlap(c, d, x, y) > 0)) throw Error('휴게시간대가 서로 겹칩니다.');
      ranges.push([c, d]);
      const night = nightMinutes(c, d);
      if (night > 0 && night < d - c && duration !== d - c) throw Error('22시 또는 06시를 걸치는 휴게는 시간대를 나누어 입력해주세요.');
      rest += duration; nightRest += night === d - c ? duration : night;
    }
    if (rest >= b - a) throw Error('휴게시간은 전체 근무시간보다 짧아야 합니다.');
    return { work: (b - a - rest) / 60, night: (nightMinutes(a, b) - nightRest) / 60 };
  }
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }
  function hours(input) {
    const pattern = input.pattern;
    if (!pattern.length || !pattern.some(x => x !== 'O') || pattern.some(x => !(x in names))) throw Error('근무가 포함된 반복순서를 지정해주세요.');
    if (pattern.length > 42) throw Error('반복순서는 최대 42일까지 설정할 수 있습니다.');
    const shifts = {};
    for (const id of ['D', 'N']) if (pattern.includes(id)) shifts[id] = shift(input.shifts[id]);
    const paid = Number(input.weeklyPaidHours);
    if (input.weeklyPaidHours === '' || input.weeklyPaidHours == null) throw Error('주휴시간을 입력해주세요.');
    if (!Number.isFinite(paid) || paid < 0 || paid > 8) throw Error('주휴시간은 0~8시간으로 입력해주세요.');
    const days = pattern.length * 7 / gcd(pattern.length, 7);
    let base = 0, overtime = 0, night = 0, weeklyBase = 0, weeklyWork = 0, maxWeek = 0;
    for (let i = 0; i < days; i++) {
      const s = shifts[pattern[i % pattern.length]] || { work: 0, night: 0 };
      const normal = Math.min(8, s.work);
      base += normal; weeklyBase += normal; weeklyWork += s.work;
      overtime += Math.max(0, s.work - 8); night += s.night;
      if (i % 7 === 6) {
        const extra = Math.max(0, weeklyBase - 40);
        base -= extra; overtime += extra;
        maxWeek = Math.max(maxWeek, weeklyWork); weeklyWork = 0; weeklyBase = 0;
      }
    }
    const factor = 365 / days / 12;
    const regular = base * factor;
    // Retain the workbook's contractual rounding conventions explicitly.
    const fixed209 = input.mode === 'weekly' && pattern.filter(x => x !== 'O').length === 5 && pattern.every(x => x === 'O' || shifts[x].work === 8) && paid === 8;
    const paidHours = paid * (input.mode === 'cycle' ? 4.345 : WEEK);
    const basic = fixed209 ? 209 : regular + paidHours;
    return { regular, paid: fixed209 ? 209 - regular : paidHours, basic, overtime: overtime * factor, night: night * factor,
      divisor: basic + overtime * factor * 1.5 + night * factor * .5, maxWeek,
      counts: Object.fromEntries(['D', 'N'].map(id => [id, 365 / pattern.length / 12 * pattern.filter(x => x === id).length])) };
  }
  function calculate(input) {
    const h = hours(input);
    const overtimeOrdinary = input.overtimeOrdinary === true, nightOrdinary = input.nightOrdinary === true;
    const divisor = h.basic + (overtimeOrdinary ? 0 : h.overtime * 1.5) + (nightOrdinary ? 0 : h.night * .5);
    const extras = input.extras.map(x => ({ ...x, amount: Number(x.amount || 0) }));
    if (extras.some(x => !Number.isFinite(x.amount) || x.amount < 0)) throw Error('수당은 0 이상의 금액으로 입력해주세요.');
    const included = extras.filter(x => x.ordinary).reduce((s, x) => s + x.amount, 0);
    const excluded = extras.filter(x => !x.ordinary).reduce((s, x) => s + x.amount, 0);
    const context = { hours:h, divisor, overtimeOrdinary, nightOrdinary, extras };
    if (input.amount === '' || input.amount == null) return { ...context, pending: true };
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw Error('월급 또는 시급은 0보다 커야 합니다.');
    // Solve the agreed gross pay once, without counting included fixed premiums twice.
    const hourly = input.basis === 'hourly' ? amount : (amount - excluded) / divisor;
    const overtime = Math.round(hourly * h.overtime * 1.5);
    const night = Math.round(hourly * h.night * .5);
    const total = input.basis === 'hourly' ? Math.round(hourly * divisor + excluded) : Math.round(amount);
    const basic = total - overtime - night - included - excluded;
    if (basic < 0 || hourly <= 0) throw Error('입력한 수당 합계가 급여를 초과합니다. 월급과 수당을 확인해주세요.');
    const ordinaryMonthly = basic + included + (overtimeOrdinary ? overtime : 0) + (nightOrdinary ? night : 0);
    return { ...context, hourly, overtime, night, total, basic, ordinaryMonthly, pending: false };
  }
  function shiftText(id, spec) {
    const overnight = minutes(spec.end) <= minutes(spec.start) ? '익일 ' : '';
    const breaks = spec.breaks.filter(b => Number(b.hours) > 0).map(b => `${b.start}~${b.end} 사이 ${Number(b.hours)}시간`).join(', ');
    return `${id === 'D' ? '주간' : '야간'} ${spec.start}~${overnight}${spec.end}(휴게 ${breaks || '없음'})`;
  }
  function workText(input) {
    const weekly = input.mode === 'weekly';
    const label = weekly ? `1주 ${input.pattern.filter(x => x !== 'O').length}일 근무` : `${input.pattern.map(x => names[x]).join('')} 근무`;
    const shifts = ['D', 'N'].filter(id => input.pattern.includes(id)).map(id => shiftText(id, input.shifts[id])).join(', ');
    return `${label}를 원칙으로 하며, 근로시간 및 휴게시간은 "${shifts}"로 한다. (단, 기관 및 개인사정에 따라 근로시간 및 휴게시간을 변경할 수 있다.)`;
  }
  const api = { contractEndDate, minutes, shift, hours, calculate, workText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PayrollCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
