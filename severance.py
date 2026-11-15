"""Private, reproducible severance calculations using stored monthly payroll."""
import calendar
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import io
import json
import os
from pathlib import Path
import re
import threading
from urllib.parse import parse_qs, urlsplit
import uuid
import zipfile
import xml.etree.ElementTree as ET

import payroll_insurance as payroll
import support_applications as response
import wiki_chat

ROOT = Path(__file__).resolve().parent
PREFIX = '/api/severance'
BRANCHES = {2: '안양점', 3: '인천점'}
LOCK = threading.RLock()
POLICY = '2026-11-15-v3'


def storage():
    return Path(os.getenv('SEVERANCE_DIR', '/data/severance'))


def number(value, label, maximum='10000000000'):
    if value is None or value == '' or isinstance(value, bool):
        raise ValueError(f'{label}을(를) 입력해주세요. 없으면 0을 입력합니다.')
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(f'{label}은(는) 숫자로 입력해주세요.') from None
    if not result.is_finite() or result < 0 or result > Decimal(maximum) or result.as_tuple().exponent < -6:
        raise ValueError(f'{label}의 범위를 확인해주세요.')
    return result


def money(value):
    return int(value.quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def day(value, label):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError(f'{label}을(를) 확인해주세요.')
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError(f'{label}을(를) 확인해주세요.') from None
    if not 1950 <= parsed.year <= 2100:
        raise ValueError(f'{label}의 연도를 확인해주세요.')
    return parsed


def text(value, label, limit=120, optional=False):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 and c != '\n' for c in value):
        raise ValueError(f'{label}을(를) 확인해주세요.')
    value = value.strip()
    if not value and not optional:
        raise ValueError(f'{label}을(를) 입력해주세요.')
    return value


def branch_id(value):
    if str(value) not in ('2', '3'):
        raise ValueError('지점을 선택해주세요.')
    return int(value)


def shift_month(value, count):
    year, month = divmod(value.year * 12 + value.month - 1 + count, 12)
    return date(year, month + 1, min(value.day, calendar.monthrange(year, month + 1)[1]))


def periods(hire, last):
    if last < hire:
        raise ValueError('마지막 근무일은 입사일 이후여야 합니다.')
    retirement = last + timedelta(days=1)
    start = max(hire, shift_month(retirement, -3))
    result, cursor = [], start
    while cursor <= last:
        days = calendar.monthrange(cursor.year, cursor.month)[1]
        end = min(date(cursor.year, cursor.month, days), last)
        result.append({'month': cursor.strftime('%Y-%m'), 'start': cursor.isoformat(), 'end': end.isoformat(),
                       'days': (end - cursor).days + 1, 'calendarDays': days})
        cursor = end + timedelta(days=1)
    return result


def employees(branch):
    people = {}
    for path in sorted(payroll.root().glob('*.json')):
        if not payroll.MONTH.fullmatch(path.stem):
            continue
        report = payroll.read_report(path.stem)['report']
        for b in report['branches']:
            if b['id'] != branch:
                continue
            for row in b['rows']:
                if row['payroll'] is not None:
                    people[row['name']] = {'name': row['name'], 'position': row['position'], 'lastMonth': path.stem}
    return sorted(people.values(), key=lambda r: r['name'])


def wages(branch, name, hire, last):
    result = periods(hire, last)
    for p in result:
        report = payroll.read_report(p['month'])['report']
        rows, sources = [], []
        if report:
            for b in report['branches']:
                if b['id'] == branch:
                    rows = [r for r in b['rows'] if r['name'] == name and r['payroll'] is not None]
                    sources = b.get('payrollSources', [])
        p.update({'sourceHash': payroll.digest(report) if report else '', 'candidates': [
            {'key': r['key'], 'gross': r['payroll'].get('gross_pay'), 'workDays': r['payroll'].get('work_days'),
             'position': r['position'], 'note': r.get('sourceNote', '')} for r in rows],
            'sources': [{'file': s['file'], 'sheet': s.get('sheet', '')} for s in sources]})
        for candidate in p['candidates']:
            gross = candidate['gross']
            candidate.update(suggested=None, prorated=None, suggestion='해당 기간의 세전 급여를 입력해주세요.')
            if gross is None or gross < 0:
                continue
            candidate['prorated'] = money(Decimal(str(gross)) * p['days'] / p['calendarDays'])
            if p['days'] == p['calendarDays']:
                candidate.update(suggested=gross, suggestion='한 달 지급총액 자동 반영')
            elif p['month'] != last.strftime('%Y-%m'):
                candidate.update(suggested=candidate['prorated'], suggestion=f'월 급여 × {p["days"]}/{p["calendarDays"]}일')
            elif candidate['workDays'] == p['days']:
                candidate.update(suggested=gross, suggestion='원본 근무일수가 해당 기간과 같아 정산액 반영')
            else:
                candidate['suggestion'] = '월중 퇴사: 이미 정산된 급여인지 확인해주세요.'
    return result


def calculate(body):
    if not isinstance(body, dict):
        raise ValueError('입력 형식을 확인해주세요.')
    branch = branch_id(body.get('branch'))
    name = text(body.get('name'), '성명', 50)
    hire = day(body.get('hireDate'), '최초 입사일')
    last = day(body.get('lastDay'), '마지막 근무일')
    schedule = wages(branch, name, hire, last)
    retirement = last + timedelta(days=1)
    tenure = (retirement - hire).days
    hours = number(body.get('weeklyHours'), '주 평균 소정근로시간', '168')
    ordinary = number(body.get('ordinaryDaily'), '1일 통상임금', '10000000')
    if ordinary == 0:
        raise ValueError('통상임금 비교를 위해 1일 통상임금을 0보다 크게 입력해주세요.')
    bonus = number(body.get('annualBonus'), '최근 1년 상여금')
    prior_leave = number(body.get('priorLeavePay'), '기지급 전년도 연차수당')
    unused = number(body.get('unusedDays'), '미사용 연차 일수', '366')
    leave_paid = number(body.get('leaveAlreadyPaid'), '이미 지급한 퇴직 시 연차수당')
    note = text(body.get('note', ''), '메모', 1000, True)
    include_seal = body.get('includeSeal', True)
    if not isinstance(include_seal, bool):
        raise ValueError('직인 포함 여부를 확인해주세요.')
    if body.get('standardPeriodConfirmed') is not True:
        raise ValueError('휴직·휴업 등 평균임금 산정 제외기간이 없는지 확인해주세요. 제외기간이 있으면 별도 산정이 필요합니다.')
    if body.get('payItemsConfirmed') is not True:
        raise ValueError('상여·연차 금액과 월급여에서 제외할 중복 금액을 확인해주세요.')
    submitted = body.get('wages')
    if not isinstance(submitted, list) or len(submitted) != len(schedule):
        raise ValueError('근무기간에 맞는 급여를 다시 불러와주세요.')
    clean_rows, lines = [], []
    wage_total = Decimal(0)
    warnings = []
    for period, row in zip(schedule, submitted):
        if not isinstance(row, dict) or row.get('month') != period['month']:
            raise ValueError('급여 산정 월이 변경되었습니다. 다시 불러와주세요.')
        mode = row.get('mode')
        if mode not in ('monthly', 'actual', 'manual', 'period'):
            raise ValueError(f'{period["month"]}의 적용 방식을 선택해주세요.')
        reason = text(row.get('reason', ''), '급여 확인 메모', 180, True)
        source_key = row.get('sourceKey', '')
        source = next((c for c in period['candidates'] if c['key'] == source_key), None)
        if mode == 'period':
            gross = number(row.get('amount'), f'{period["month"]} 기간 급여')
            if source_key and not source:
                raise ValueError('원본 급여를 다시 불러와주세요.')
            if source and row.get('sourceHash') != period['sourceHash']:
                raise wiki_chat.ChatError(409, '급여 원본이 갱신되었습니다. 급여를 다시 불러와 확인해주세요.')
            if not reason:
                reason = '기간 급여 직접 입력'
        elif mode == 'manual':
            gross = number(row.get('amount'), f'{period["month"]} 직접 입력 임금')
            if not reason:
                raise ValueError('직접 입력한 임금의 근거를 메모해주세요.')
            source_key = ''
        else:
            if not source or source['gross'] is None:
                raise ValueError(f'{period["month"]}에 세전 지급총액이 없습니다. 확인한 임금을 직접 입력해주세요.')
            if row.get('sourceHash') != period['sourceHash']:
                raise wiki_chat.ChatError(409, '급여 원본이 갱신되었습니다. 급여를 다시 불러와 확인해주세요.')
            gross = number(source['gross'], '원본 급여')
        excluded = number(row.get('excluded'), '평균임금 제외 금액')
        if excluded > gross:
            raise ValueError('제외 금액은 적용 전 임금을 넘을 수 없습니다.')
        if excluded and not reason:
            raise ValueError('급여에서 제외한 금액의 근거를 메모해주세요.')
        amount = gross - excluded
        if mode == 'monthly':
            amount = amount * period['days'] / period['calendarDays']
        amount = Decimal(money(amount))
        wage_total += amount
        clean_rows.append({'month': period['month'], 'mode': mode, 'amount': float(gross),
                           'excluded': float(excluded), 'sourceKey': source_key,
                           'sourceHash': period['sourceHash'], 'reason': reason})
        lines.append({**period, 'gross': float(gross), 'excluded': float(excluded), 'included': int(amount),
                      'mode': mode, 'sourceKey': source_key, 'reason': reason})
        if mode == 'manual':
            warnings.append(f'{period["month"]}: 직접 확인한 임금 적용')
    days = sum(p['days'] for p in schedule)
    bonus_part, leave_part = bonus / 4, prior_leave / 4
    daily = (wage_total + bonus_part + leave_part) / days
    applied = max(daily, ordinary)
    eligible = retirement >= shift_month(hire, 12) and hours >= 15
    severance = money(applied * 30 * tenure / 365) if eligible else 0
    leave_total = money(ordinary * unused)
    if leave_paid > leave_total:
        raise ValueError('이미 지급한 연차수당은 산정된 잔여 연차수당을 넘을 수 없습니다.')
    leave_due = leave_total - money(leave_paid)
    if not eligible:
        warnings.append('법정 퇴직금 대상 요건 미충족: 계속근로 1년 이상·주 평균 15시간 이상을 확인하세요.')
    if ordinary > daily:
        warnings.append('평균임금보다 높은 1일 통상임금을 적용했습니다.')
    if days < 89:
        warnings.append('입사 이후 실제 재직기간만 평균임금 산정기간에 포함했습니다.')
    clean = {'branch': branch, 'name': name, 'hireDate': hire.isoformat(), 'lastDay': last.isoformat(),
             'weeklyHours': float(hours), 'ordinaryDaily': float(ordinary), 'annualBonus': float(bonus),
             'priorLeavePay': float(prior_leave), 'unusedDays': float(unused), 'leaveAlreadyPaid': float(leave_paid),
             'note': note,
             'includeSeal': include_seal, 'standardPeriodConfirmed': True, 'payItemsConfirmed': True, 'wages': clean_rows}
    result = {'policyVersion': POLICY, 'branchName': BRANCHES[branch], 'retirementDate': retirement.isoformat(),
              'periodStart': schedule[0]['start'], 'periodEnd': last.isoformat(), 'periodDays': days,
              'tenureDays': tenure, 'eligible': eligible, 'wageTotal': int(wage_total),
              'bonusIncluded': float(bonus_part), 'priorLeaveIncluded': float(leave_part),
              'averageDaily': float(daily), 'appliedDaily': float(applied), 'ordinaryApplied': ordinary > daily,
              'severance': severance, 'unusedLeavePay': leave_total, 'leaveDue': leave_due,
              'totalBeforeTax': severance + leave_due,
              'paymentDue': (retirement + timedelta(days=14)).isoformat(), 'wages': lines, 'warnings': warnings}
    return {'input': clean, 'result': result}


def record_path(ident):
    if not isinstance(ident, str) or not re.fullmatch(r'[a-f0-9]{32}', ident):
        raise ValueError('산정 기록을 확인해주세요.')
    return storage() / f'{ident}.json'


def read(ident):
    path = record_path(ident)
    if not path.exists():
        raise wiki_chat.ChatError(404, '저장된 산정 기록이 없습니다.')
    return json.loads(path.read_text('utf-8'))


def save(body):
    calculated = calculate(body)
    with LOCK:
        ident = body.get('id') or uuid.uuid4().hex
        path = record_path(ident)
        old = read(ident) if path.exists() else None
        if (body.get('id') and old is None) or (old and body.get('revision') != old['revision']):
            raise wiki_chat.ChatError(409, '다른 창에서 변경된 기록입니다. 목록에서 다시 열어주세요.')
        now = payroll.now()
        record = {'id': ident, 'revision': old['revision'] + 1 if old else 1,
                  'createdAt': old['createdAt'] if old else now, 'updatedAt': now, **calculated}
        if old:
            payroll.atomic(storage() / 'history' / f'{ident}-{old["revision"]}.json', payroll.encoded(old))
        payroll.atomic(path, payroll.encoded(record))
        return record


def records():
    result = []
    for path in storage().glob('*.json'):
        item = read(path.stem)
        result.append({'id': item['id'], 'revision': item['revision'], 'updatedAt': item['updatedAt'],
                       'name': item['input']['name'], 'branch': item['input']['branch'],
                       'lastDay': item['input']['lastDay'], 'severance': item['result']['severance'],
                       'totalBeforeTax': item['result']['totalBeforeTax']})
    return sorted(result, key=lambda r: r['updatedAt'], reverse=True)


def xlsx(record):
    """Fill the sanitized template without touching its native styles/print geometry."""
    data, r = record['input'], record['result']
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    ET.register_namespace('', ns)
    def tag(name): return f'{{{ns}}}{name}'
    with zipfile.ZipFile(ROOT / 'templates/severance.xlsx') as z:
        entries = {n: z.read(n) for n in z.namelist()}
    sheet = ET.fromstring(entries['xl/worksheets/sheet1.xml'])
    def set_cell(address, value):
        cell = sheet.find(f'.//{tag("c")}[@r="{address}"]')
        if cell is None:
            raise ValueError('산정내역서 양식의 셀을 확인해주세요.')
        for child in list(cell): cell.remove(child)
        if isinstance(value, (int, float)):
            cell.attrib.pop('t', None)
            ET.SubElement(cell, tag('v')).text = str(value)
        else:
            cell.set('t', 'inlineStr')
            ET.SubElement(ET.SubElement(cell, tag('is')), tag('t')).text = str(value)
    def won(value): return f'{value:,.0f}'
    def fmt_date(value): return value.replace('-', '.')
    set_cell('C5', data['name'])
    set_cell('G5', (date.fromisoformat(data['hireDate']) - date(1899, 12, 30)).days)
    set_cell('I5', (date.fromisoformat(r['retirementDate']) - date(1899, 12, 30)).days)
    set_cell('E6', f'{r["tenureDays"]}일')
    set_cell('G6', f'{fmt_date(r["periodStart"])} ~ {fmt_date(r["periodEnd"])}')
    modes = {'monthly': '월급 일할 적용', 'actual': '해당 기간 정산액', 'manual': '직접 확인액', 'period': '해당 기간 반영액'}
    wage_lines = []
    for line in r['wages']:
        desc = f'{line["days"]}일 / {won(line["included"])}원 ({modes[line["mode"]]}'
        if line['excluded']: desc += f', {won(line["excluded"])}원 제외 후'
        wage_lines.append(f'[{line["month"]}] {fmt_date(line["start"])} ~ {fmt_date(line["end"])} / {desc})')
    set_cell('B9', '\n'.join(wage_lines))
    average = f'({won(r["wageTotal"])} + 상여 {won(r["bonusIncluded"])} + 연차 {won(r["priorLeaveIncluded"])}) ÷ {r["periodDays"]}일 = {r["averageDaily"]:,.2f}원'
    if r['ordinaryApplied']: average += f'\n적용: 1일 통상임금 {r["appliedDaily"]:,.2f}원 (평균임금보다 높음)'
    set_cell('B12', average)
    set_cell('C15', f'{r["appliedDaily"]:,.2f}원 × 30일 × ({r["tenureDays"]}일 / 365)' if r['eligible'] else '법정 퇴직금 지급 요건 미충족')
    set_cell('H15', r['severance'])
    set_cell('B18', '더비다요양원 ' + ('안양' if data['branch'] == 2 else '인천'))
    extra = []
    if data['unusedDays'] or data['leaveAlreadyPaid']:
        extra.append(f'별도 연차수당 {won(r["unusedLeavePay"])}원 · 기지급 {won(data["leaveAlreadyPaid"])}원 · 세전 지급합계 {won(r["totalBeforeTax"])}원')
    set_cell('B16', '\n'.join(extra))
    if not data['includeSeal']:
        drawing = sheet.find(tag('drawing'))
        if drawing is not None: sheet.remove(drawing)
        for name in list(entries):
            if name.startswith(('xl/media/', 'xl/drawings/', 'xl/worksheets/_rels/')):
                entries.pop(name)
        types = ET.fromstring(entries['[Content_Types].xml'])
        for child in list(types):
            if '/drawings/' in child.get('PartName', ''):
                types.remove(child)
        entries['[Content_Types].xml'] = ET.tostring(types, encoding='utf-8', xml_declaration=True)
    else:
        entries['xl/media/seal.png'] = (ROOT / 'assets/contracts' / ('seal-anyang.png' if data['branch'] == 2 else 'seal-incheon.png')).read_bytes()
    entries['xl/worksheets/sheet1.xml'] = ET.tostring(sheet, encoding='utf-8', xml_declaration=True)
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, raw in entries.items(): z.writestr(name, raw)
    return out.getvalue()


def handle(handler, method):
    parts = urlsplit(handler.path)
    if not (parts.path == PREFIX or parts.path.startswith(PREFIX + '/')):
        return False
    head = method == 'HEAD'
    route = parts.path[len(PREFIX):].strip('/')
    query = parse_qs(parts.query)
    param = lambda key: query.get(key, [''])[0]
    try:
        if method in ('GET', 'HEAD'):
            if route == 'employees': result = {'employees': employees(branch_id(param('branch')))}
            elif route == 'records': result = {'records': records()}
            elif route == 'record': result = read(param('id'))
            elif route == 'export':
                item = read(param('id'))
                response.send_file(handler, f'퇴직금 산정 내역_{item["input"]["name"]}.xlsx', xlsx(item), head)
                return True
            else: raise wiki_chat.ChatError(404, '요청한 기능이 없습니다.')
            response.send_json(handler, 200, result, head)
        elif method == 'POST' and route in ('wages', 'calculate', 'save'):
            wiki_chat.check_origin(handler)
            if not handler.headers.get('Origin'):
                raise wiki_chat.ChatError(403, '퇴직금 관리 화면에서 요청해주세요.')
            body = wiki_chat.read_json(handler, 32000)
            if not isinstance(body, dict):
                raise ValueError('입력 형식을 확인해주세요.')
            if route == 'wages':
                result = {'wages': wages(branch_id(body.get('branch')), text(body.get('name'), '성명', 50),
                                        day(body.get('hireDate'), '입사일'), day(body.get('lastDay'), '마지막 근무일'))}
            else:
                result = save(body) if route == 'save' else calculate(body)
            response.send_json(handler, 200, result)
        else: raise wiki_chat.ChatError(405, '지원하지 않는 요청입니다.')
    except wiki_chat.ChatError as exc:
        response.send_json(handler, exc.status, {'error': str(exc)}, head)
    except (ValueError, TypeError, KeyError) as exc:
        response.send_json(handler, 400, {'error': str(exc) if isinstance(exc, ValueError) else '입력 형식을 확인해주세요.'}, head)
    except OSError:
        response.send_json(handler, 503, {'error': '저장 자료를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.'}, head)
    return True
