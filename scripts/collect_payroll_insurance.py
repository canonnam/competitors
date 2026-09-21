"""Join verified NHIS CSV downloads with the production ERP payroll ledger."""
import argparse
import csv
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urljoin, urlsplit
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import payroll_insurance as model

BACKEND = 'https://vida-backend-prod-production.up.railway.app'
BUSINESS = {2: '3338503020', 3: '3898502626'}
KINDS = {'건강': 'health', '국민연금': 'pension', '고용': 'employment', '산재': 'accident'}


def amount(value, fraction=False):
    if value is None or value == '': raise ValueError('필수 금액이 비어 있습니다.')
    numeric = Decimal(str(value).replace(',', ''))
    if not numeric.is_finite() or (not fraction and numeric != numeric.to_integral_value()):
        raise ValueError('원 단위 금액 형식 오류')
    return model.number(float(numeric) if fraction else int(numeric), fraction=fraction)


def birthday(value):
    digits = re.sub(r'\D', '', value or '')
    return digits[-6:] if len(digits) == 8 else digits[:6] if len(digits) >= 6 else ''


def plain_name(value): return re.sub(r'\d+$', '', (value or '').strip())


def request(path, access=None, body=None):
    url = urljoin(BACKEND, path)
    if urlsplit(url).netloc != urlsplit(BACKEND).netloc or not url.startswith(BACKEND + '/api/'):
        raise ValueError('ERP 페이지네이션 주소 오류')
    headers = {'Content-Type': 'application/json'}
    if access: headers['Authorization'] = 'Bearer ' + access
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urllib.request.urlopen(req, timeout=40) as response: return json.load(response)


def employees(ident, token):
    path = f'/api/users/?nursing_home={ident}&exclude_viewer=true&employment_status=all'
    result, visited = [], set()
    while path:
        if path in visited or len(visited) > 50: raise ValueError('ERP 목록 페이지네이션 오류')
        visited.add(path)
        data = request(path, token)
        result.extend(data if isinstance(data, list) else data['results'])
        path = None if isinstance(data, list) else data.get('next')
    return [r for r in result if r.get('nursing_home') == ident]


def load_nhis(folder, manifest, ident, period):
    evidence = next(b for b in manifest['branches'] if b['id'] == ident)
    if evidence['businessNumber'].replace('-', '') != BUSINESS[ident] or evidence['month'] != period:
        raise ValueError('공단 화면의 사업자/조회 월 확인 기록이 일치하지 않습니다.')
    if evidence.get('healthEmployerEqualsEmployee') is not True:
        raise ValueError('건강·요양 사용자/가입자 부담액 일치 여부를 화면에서 확인해주세요.')
    persons, sources = {}, []
    for korean, key in KINDS.items():
        file = folder / f'{model.BRANCHES[ident]}_{period}_{korean}.csv'
        raw = file.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if evidence['files'][korean] != digest: raise ValueError('확인 기록 이후 원본 파일이 변경되었습니다.')
        table = [r for r in csv.reader(raw.decode('cp949').splitlines()) if any(r)]
        headers, rows = table[0], [r for r in table[1:] if any(r)]
        if headers[3] not in ('성명', '가입자명'): raise ValueError('공단 파일 이름 열 오류')
        if korean == '건강':
            if len(headers) != 31 or headers[13] != '고지보험료' or headers[26] != '고지보험료':
                raise ValueError('건강보험 파일 열 구성이 변경되었습니다.')
        elif '결정보험료' not in headers: raise ValueError('공단 결정 보험료 열 없음')
        sources.append({'kind': korean, 'sha256': digest, 'records': len(rows)})
        for r in rows:
            if len(r) != len(headers): raise ValueError('공단 CSV 열 수 불일치')
            name, born = r[3].strip(), birthday(r[2])
            if not name or len(born) != 6: raise ValueError('공단 식별 필드 형식 오류')
            p = persons.setdefault((name, born), {'name': name, 'birth': born, 'insurance': dict.fromkeys(model.INSURANCE)})
            values = {'health': amount(r[13]), 'care': amount(r[26])} if korean == '건강' else {key: amount(r[headers.index('결정보험료')])}
            for k, v in values.items():
                # Settlement rows for one employee are additive, not discarded.
                p['insurance'][k] = (p['insurance'][k] or 0) + v
    return persons, sources, evidence


def candidates(name, born, rows, name_key, birth_key):
    possible = [r for r in rows if plain_name(r.get(name_key)) == plain_name(name)]
    if born:
        verified = [r for r in possible if birthday(r.get(birth_key)) == born]
        if verified: return verified, '성명·생년월일 일치'
        # A conflicting birthday must never be merged by name alone.
        possible = [r for r in possible if not birthday(r.get(birth_key))]
    exact = [r for r in possible if r.get(name_key) == name]
    return exact, '지점 내 유일 성명 일치'


def build_branch(ident, ledger, staff, persons, sources, evidence, checked):
    result = {'id': ident, 'ledgerId': ledger['id'], 'confirmedAt': ledger.get('confirmed_at'),
              'payrollCheckedAt': checked, 'insuranceCheckedAt': evidence['checkedAt'], 'sources': sources,
              'portalTotals': evidence['portalTotals'], 'rows': []}
    ledger_entries = ledger['entries']
    by_id = {p['id']: p for p in staff}
    for entry in ledger_entries:
        person = by_id.get(entry.get('user'), {})
        result['rows'].append({'key': 'ledger-' + str(entry['id']), 'name': entry['user_name'],
            'position': entry.get('position') or person.get('profile', {}).get('position') or '직책 미확인',
            'payroll': {k: amount(entry[k], fraction=k == 'work_days') for k in model.PAY},
            'insurance': dict.fromkeys(model.INSURANCE), 'match': '공단 개인별 자료 없음',
            '_birth': birthday(entry.get('birth_date') or person.get('birth_date'))})
    assigned = set()
    for index, p in enumerate(persons.values()):
        matched, method = candidates(p['name'], p['birth'], result['rows'], 'name', '_birth')
        if len(matched) == 1 and matched[0]['key'] not in assigned:
            row = matched[0]; assigned.add(row['key'])
            row['insurance'] = p['insurance']; row['match'] = method
            continue
        people, _ = candidates(p['name'], p['birth'], staff, 'username', 'birth_date')
        position = people[0].get('profile', {}).get('position') if len(people) == 1 else None
        result['rows'].append({'key': 'nhis-' + str(index), 'name': p['name'], 'position': position or '직책 미확인',
                              'payroll': None, 'insurance': p['insurance'],
                              'match': '동명이인·연결 확인 필요' if matched else '공단 자료만 있음 · 급여대장 없음'})
    for row in result['rows']: row.pop('_birth', None)
    result['rows'].sort(key=lambda r: (model.ROLES.index(model.role(r['position'])), r['name'], r['key']))
    # Preserve every source won, including settlements and unmatched employees.
    for k in model.INSURANCE:
        if sum(p['insurance'][k] or 0 for p in persons.values()) != sum(r['insurance'][k] or 0 for r in result['rows']):
            raise ValueError('개인별 원본 보험료와 연결 결과 합계가 다릅니다.')
    if sum(r['payroll']['gross_pay'] for r in result['rows'] if r['payroll']) != sum(amount(e['gross_pay']) for e in ledger_entries):
        raise ValueError('급여 지급총액 대사 오류')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--month', required=True)
    parser.add_argument('--nhis-dir', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    period = model.month(args.month)
    manifest = json.loads(args.manifest.read_text('utf-8-sig'))
    if manifest['month'] != period: raise ValueError('원본 확인 기록의 귀속 월 불일치')
    user, password = os.environ.get('VIDA_REPORT_USER'), os.environ.get('VIDA_REPORT_PASS')
    if not user or not password: raise ValueError('이 작업에서 승인받은 ERP 계정을 환경변수로 제공해주세요.')
    token = request('/api/token/', body={'username': user, 'password': password})['access']
    checked = model.now()
    result = {'schemaVersion': 1, 'month': period, 'checkedAt': checked, 'branches': []}
    year, mon = map(int, period.split('-'))
    for ident in model.BRANCHES:
        ledger = request(f'/api/payroll/ledger/?nursing_home_id={ident}&year={year}&month={mon}', token)
        if (ledger['year'], ledger['month'], ledger['nursing_home']) != (year, mon, ident):
            raise ValueError('급여대장의 귀속 월·지점 불일치')
        persons, sources, evidence = load_nhis(args.nhis_dir, manifest, ident, period)
        result['branches'].append(build_branch(ident, ledger, employees(ident, token), persons, sources, evidence, checked))
    clean = model.validate(result)
    model.atomic(args.output, model.encoded(clean))
    print(json.dumps({'month': period, 'branches': [{'site': b['name'], 'rows': len(b['rows']),
                     'confirmed': bool(b['confirmedAt']), 'totals': b['totals'], 'groups': b['groups']} for b in clean['branches']]}, ensure_ascii=False))


if __name__ == '__main__': main()
