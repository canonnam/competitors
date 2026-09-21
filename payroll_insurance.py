"""Private monthly payroll / NHIS snapshots. No ERP credentials or public writes."""
from __future__ import annotations

import argparse
import base64
import csv
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from urllib.parse import parse_qs, urlsplit

MONTH = re.compile(r'20\d{2}-(0[1-9]|1[0-2])\Z')
BRANCHES = {2: '안양', 3: '인천'}
ROLES = ('사회복지사', '간호(조무)사', '물리(작업)치료사', '요양보호사', '기타', '직책 미확인')
INSURANCE = ('health', 'care', 'pension', 'employment', 'accident')
PAY = ('work_days', 'basic_pay', 'gross_pay', 'total_deduction', 'net_pay',
       'national_pension', 'health_insurance', 'long_term_care_insurance', 'employment_insurance')
LOCK = threading.Lock()
KST = timezone(timedelta(hours=9))


def now():
    return datetime.now(KST).isoformat(timespec='seconds')


def month(value):
    if not isinstance(value, str) or not MONTH.fullmatch(value):
        raise ValueError('귀속 월은 YYYY-MM 형식이어야 합니다.')
    return value


def previous_month(at=None):
    at = at or datetime.now(KST)
    return (at.replace(day=1) - timedelta(days=1)).strftime('%Y-%m')


def role(position):
    value = re.sub(r'\s+', '', position or '')
    if value in ('사회복지사',): return ROLES[0]
    if value in ('간호사', '간호조무사', '간호(조무)사'): return ROLES[1]
    if value in ('물리치료사', '작업치료사', '물리(작업)치료사'): return ROLES[2]
    if value == '요양보호사': return ROLES[3]
    if value in ('', '미기재', '직책미확인'): return ROLES[5]
    return ROLES[4]


def number(value, nullable=False, fraction=False):
    if nullable and value is None: return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('금액/근무일수 형식을 확인해주세요.')
    if not -10**11 < value < 10**11 or (not fraction and value != int(value)):
        raise ValueError('유효한 원 단위 금액이 아닙니다.')
    return value if fraction else int(value)


def string(value, limit=100):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ValueError('텍스트 형식을 확인해주세요.')
    return value


def timestamp(value, optional=False):
    if optional and value is None: return None
    parsed = datetime.fromisoformat(string(value))
    if not parsed.tzinfo: raise ValueError('확인 시각에는 시간대가 필요합니다.')
    return value


def insurance_total(row):
    values = row['insurance']
    found = [v * (2 if k in ('health', 'care') else 1) for k, v in values.items() if v is not None]
    return sum(found) if found else None


def employee_deductions(row):
    pay = row['payroll']
    return None if pay is None else sum(pay[k] for k in PAY[5:])


def summarize(rows):
    def total(getter):
        values = [getter(r) for r in rows]
        present = [v for v in values if v is not None]
        return sum(present) if present else None
    return {'people': len(rows), 'payrollPeople': sum(r['payroll'] is not None for r in rows),
            'insurancePeople': sum(insurance_total(r) is not None for r in rows),
            'grossPay': total(lambda r: r['payroll']['gross_pay'] if r['payroll'] else None),
            'netPay': total(lambda r: r['payroll']['net_pay'] if r['payroll'] else None),
            'employeeDeductions': total(employee_deductions), 'insuranceTotal': total(insurance_total),
            'insurance': {k: total(lambda r: r['insurance'][k]) for k in INSURANCE}}


def validate(payload):
    """Reconstruct an allowlisted payload; identifiers used to match stay on the PC."""
    if not isinstance(payload, dict) or payload.get('schemaVersion') != 1:
        raise ValueError('지원하지 않는 결과 형식입니다.')
    result = {'schemaVersion': 1, 'month': month(payload['month']), 'checkedAt': timestamp(payload['checkedAt']), 'branches': []}
    if sorted(b['id'] for b in payload['branches']) != [2, 3]:
        raise ValueError('안양·인천 두 지점의 결과가 모두 필요합니다.')
    for b in payload['branches']:
        ident = b['id']
        clean = {'id': ident, 'name': BRANCHES[ident], 'ledgerId': number(b['ledgerId']),
                 'confirmedAt': timestamp(b.get('confirmedAt'), optional=True),
                 'payrollCheckedAt': timestamp(b['payrollCheckedAt']),
                 'insuranceCheckedAt': timestamp(b['insuranceCheckedAt']), 'rows': [], 'sources': [],
                 'portalTotals': {k: number(b['portalTotals'].get(k), nullable=True) for k in ('healthCare', 'pension', 'employment', 'accident')}}
        for source in b['sources']:
            kind = source['kind']
            if kind not in ('건강', '국민연금', '고용', '산재'): raise ValueError('보험 종류 오류')
            digest = source['sha256']
            if not re.fullmatch('[a-f0-9]{64}', digest): raise ValueError('원본 해시 오류')
            clean['sources'].append({'kind': kind, 'file': f'{BRANCHES[ident]}_{result["month"]}_{kind}.csv',
                                     'sha256': digest, 'records': number(source['records'])})
        if sorted(s['kind'] for s in clean['sources']) != sorted(('건강', '국민연금', '고용', '산재')):
            raise ValueError('4종 원본 파일이 모두 필요합니다.')
        keys = set()
        for r in b['rows']:
            key = string(r['key'])
            if key in keys: raise ValueError('직원 행 중복')
            keys.add(key)
            pay = r.get('payroll')
            if pay is not None:
                pay = {k: number(pay[k], fraction=k == 'work_days') for k in PAY}
                if pay['gross_pay'] - pay['total_deduction'] != pay['net_pay']:
                    raise ValueError('급여 지급·공제·실지급 합계 불일치')
            row = {'key': key, 'name': string(r['name']), 'position': string(r['position']),
                   'match': string(r['match']), 'payroll': pay,
                   'insurance': {k: number(r['insurance'][k], nullable=True) for k in INSURANCE}}
            row['role'] = role(row['position'])
            row['insuranceTotal'] = insurance_total(row)
            row['employeeDeductions'] = employee_deductions(row)
            clean['rows'].append(row)
        if not clean['rows']: raise ValueError('빈 자료를 완료 결과로 저장할 수 없습니다.')
        clean['totals'] = summarize(clean['rows'])
        clean['groups'] = [dict(role=g, **summarize([r for r in clean['rows'] if r['role'] == g])) for g in ROLES]
        individual = clean['totals']['insurance']
        health_care = [individual[k] for k in ('health', 'care') if individual[k] is not None]
        comparable = {'healthCare': 2 * sum(health_care) if health_care else None,
                      **{k: individual[k] for k in ('pension', 'employment', 'accident')}}
        clean['reconciliation'] = {k: {'individual': v, 'portal': clean['portalTotals'][k],
                                    'difference': None if clean['portalTotals'][k] is None or v is None else clean['portalTotals'][k] - v}
                                   for k, v in comparable.items()}
        result['branches'].append(clean)
    result['branches'].sort(key=lambda b: b['id'])
    return result


def root():
    return Path(os.getenv('PAYROLL_INSURANCE_DIR', '/data/payroll-insurance'))


def encoded(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def digest(payload):
    return hashlib.sha256(encoded(payload)).hexdigest()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.pending-')
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data); out.flush(); os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def save(payload):
    clean = validate(payload)
    target = root() / (clean['month'] + '.json')
    with LOCK:
        if target.exists():
            old = target.read_bytes()
            # Corrections remain recoverable, without touching other months.
            if old != encoded(clean):
                atomic(root() / 'history' / f'{clean["month"]}-{hashlib.sha256(old).hexdigest()}.json', old)
        atomic(target, encoded(clean))
        failure = root() / (clean['month'] + '.failure.json')
        if failure.exists(): failure.unlink()
    return {'month': clean['month'], 'sha256': digest(clean), 'rows': [len(b['rows']) for b in clean['branches']]}


def save_failure(period):
    # No arbitrary error text: errors can contain credentials or employee data.
    value = {'month': month(period), 'failedAt': now(), 'message': '월별 수집 또는 검증에 실패했습니다. 이전 성공 결과를 유지합니다.'}
    atomic(root() / (period + '.failure.json'), encoded(value))
    return value


def read_report(period=''):
    months = sorted([p.stem for p in root().glob('*.json') if MONTH.fullmatch(p.stem)], reverse=True)
    expected = previous_month()
    selected = month(period) if period else (months[0] if months else expected)
    path = root() / (selected + '.json')
    failure_path = root() / (expected + '.failure.json')
    selected_failure = root() / (selected + '.failure.json')
    return {'months': months, 'expectedMonth': expected,
            'report': validate(json.loads(path.read_text('utf-8'))) if path.exists() else None,
            'failure': json.loads(selected_failure.read_text('utf-8')) if selected_failure.exists() else None,
            'latestFailure': json.loads(failure_path.read_text('utf-8')) if failure_path.exists() else None}


CSV_HEAD = ['귀속월', '지점', '성명', '직책', '직책그룹', '근무일수', '기본급', '지급총액', '공제합계', '실지급액',
            '급여 보험공제합계', '건강(가입자)', '요양(가입자)', '국민연금(원본결정)', '고용(원본결정)', '산재(원본결정)', '보험료합계(노사합산 기준)', '연결상태']


def csv_bytes(report, branch=''):
    out = io.StringIO(newline='')
    writer = csv.writer(out); writer.writerow(CSV_HEAD)
    for b in report['branches']:
        if branch and str(b['id']) != branch: continue
        for r in b['rows']:
            pay = r['payroll'] or {}
            cells = [report['month'], b['name'], r['name'], r['position'], r['role'], *[pay.get(k) for k in PAY[:5]],
                     r['employeeDeductions'], *[r['insurance'][k] for k in INSURANCE], r['insuranceTotal'], r['match']]
            writer.writerow(["'" + v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v for v in cells])
    return ('\ufeff' + out.getvalue()).encode('utf-8')


def handle(handler, method):
    parts = urlsplit(handler.path)
    if parts.path != '/api/support/payroll-insurance': return False
    import support_applications as auth
    head = method == 'HEAD'
    try:
        if not auth.authenticated(handler):
            auth.send_json(handler, 401, {'error': '담당자 접근 키로 로그인해주세요.'}, head); return True
        if method not in ('GET', 'HEAD'):
            auth.send_json(handler, 405, {'error': '조회 전용 화면입니다.'}, head); return True
        query = parse_qs(parts.query)
        period = query.get('month', [''])[0]
        branch = query.get('branch', [''])[0]
        if branch not in ('', '2', '3'): raise ValueError('지점을 확인해주세요.')
        data = read_report(period)
        if query.get('format') == ['csv']:
            if not data['report']:
                auth.send_json(handler, 404, {'error': '해당 월의 저장 결과가 없습니다.'}, head)
            else:
                auth.send_file(handler, f'급여_4대보험_{data["report"]["month"]}.csv', csv_bytes(data['report'], branch), head)
        else:
            auth.send_json(handler, 200, data, head)
    except (ValueError, KeyError, TypeError):
        auth.send_json(handler, 400, {'error': '귀속 월 또는 저장 자료 형식을 확인해주세요.'}, head)
    except OSError:
        auth.send_json(handler, 503, {'error': '저장 결과를 불러오지 못했습니다.'}, head)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--import-gzip-base64')
    group.add_argument('--failure')
    group.add_argument('--verify')
    args = parser.parse_args()
    if args.failure:
        result = save_failure(args.failure)
    elif args.verify:
        saved = read_report(month(args.verify))['report']
        result = {'month': args.verify, 'sha256': digest(saved) if saved else None}
    else:
        compressed = base64.b64decode(args.import_gzip_base64, validate=True)
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
            raw = stream.read(2_000_001)
        if len(raw) > 2_000_000: raise ValueError('결과 파일 크기 초과')
        result = save(json.loads(raw))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
