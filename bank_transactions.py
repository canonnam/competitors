"""Verified Hana monthly exports. Original files stay outside the static tree."""
import argparse
import base64
from collections import Counter
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

import xlrd

KST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent
BRANCHES = {'incheon': ('인천점', '439-910040-60104'), 'anyang': ('안양점', '439-910043-10004')}
HEADERS = ['거래일시', '적요', '추가메모', '의뢰인/수취인', '입금', '출금', '거래후잔액', '구분', '거래점', '거래특이사항']
LOCK = threading.RLock()
MAX_FILE = 10_000_000


def now():
    return datetime.now(KST)


def root():
    default = '/data/bank-transactions' if os.getenv('RAILWAY_ENVIRONMENT_ID') else ROOT / '.local/bank-transactions'
    return Path(os.getenv('BANK_TRANSACTIONS_DIR', default))


def month(value):
    if not isinstance(value, str) or not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])', value):
        raise ValueError('거래 월 형식이 올바르지 않습니다.')
    return value


def previous_month(at=None):
    at = (at or now()).astimezone(KST)
    return (at.replace(day=1) - timedelta(days=1)).strftime('%Y-%m')


def period(value):
    start = datetime.strptime(month(value), '%Y-%m').replace(tzinfo=KST)
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    return start.strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def atomic(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        stream.write(raw)
        temporary = Path(stream.name)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def amount(value, blank=False):
    if blank and value == '':
        return 0
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or abs(value) > 10**15:
        raise ValueError('원 단위 금액 형식을 확인해주세요.')
    return int(value)


def parse_export(raw, branch, selected):
    month(selected)
    if branch not in BRANCHES or not 0 < len(raw) <= MAX_FILE or not raw.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
        raise ValueError('하나은행 원본 XLS와 지점을 확인해주세요.')
    book = xlrd.open_workbook(file_contents=raw, on_demand=True)
    try:
        if book.nsheets != 1:
            raise ValueError('원본 시트 구성을 확인해주세요.')
        sheet = book.sheet_by_index(0)
        if sheet.ncols != 10 or not 8 <= sheet.nrows <= 50008 or sheet.row_values(6) != HEADERS:
            raise ValueError('하나은행 거래내역 원본 열 구성이 아닙니다.')
        if str(sheet.cell_value(0, 0)).strip() != '거래내역':
            raise ValueError('거래내역 파일이 아닙니다.')
        if str(sheet.cell_value(3, 0)).strip() != '계좌번호 : ' + BRANCHES[branch][1]:
            raise ValueError('선택한 지점의 공단부담금 계좌와 다릅니다.')
        start, end = period(selected)
        if str(sheet.cell_value(5, 0)).strip() != f'조회기간 : {start} ~ {end}':
            raise ValueError('조회기간이 해당 월의 1일부터 말일까지가 아닙니다.')
        footer = sheet.row_values(sheet.nrows - 1)
        if footer[3] != '합계':
            raise ValueError('전체 거래의 합계 행이 없습니다. 전체엑셀다운로드를 사용해주세요.')
        records = []
        for index in range(7, sheet.nrows - 1):
            row = sheet.row_values(index)
            stamp = datetime.strptime(str(row[0]), '%Y-%m-%d %H:%M:%S')
            if stamp.strftime('%Y-%m') != selected:
                raise ValueError('대상 월 밖의 거래가 있습니다.')
            deposit, withdrawal, balance = amount(row[4], True), amount(row[5], True), amount(row[6])
            if deposit < 0 or withdrawal < 0:
                raise ValueError('음수 입출금이 있어 원본 확인이 필요합니다.')
            if any(not isinstance(row[i], str) or len(row[i]) > 2000 for i in (1, 2, 3, 7, 8, 9)):
                raise ValueError('거래 내용 형식을 확인해주세요.')
            records.append({'row': index + 1, 'date': stamp.strftime('%Y-%m-%d %H:%M:%S'),
                            'description': row[1], 'memo': row[2], 'counterparty': row[3],
                            'deposit': deposit, 'withdrawal': withdrawal, 'balance': balance,
                            'type': row[7], 'office': row[8], 'note': row[9]})
        issues = []
        deposits, withdrawals = sum(r['deposit'] for r in records), sum(r['withdrawal'] for r in records)
        bank_deposits, bank_withdrawals = amount(footer[4], True), amount(footer[5], True)
        if (deposits, withdrawals) != (bank_deposits, bank_withdrawals):
            issues.append({'kind': 'totals', 'message': '거래 합계와 은행 원본 합계가 다릅니다.'})
        dates = [r['date'] for r in records]
        ordered = dates == sorted(dates, reverse=True)
        if not ordered:
            issues.append({'kind': 'order', 'message': '최근거래먼저 정렬을 확인해주세요. 잔액 연결을 검증하지 못했습니다.'})
        else:
            for newer, older in zip(records, records[1:]):
                if older['balance'] + newer['deposit'] - newer['withdrawal'] != newer['balance']:
                    issues.append({'kind': 'balance', 'row': newer['row'], 'message': '앞뒤 거래의 잔액이 연결되지 않습니다.'})
        counts = Counter(tuple(r[k] for k in ('date', 'description', 'memo', 'counterparty', 'deposit', 'withdrawal', 'balance', 'type', 'office', 'note')) for r in records)
        duplicates = sum(n - 1 for n in counts.values() if n > 1)
        if duplicates:
            issues.append({'kind': 'duplicate', 'message': f'완전히 같은 거래가 {duplicates}건 있어 원본 대조가 필요합니다. 자동 제외하지 않았습니다.'})
        ambiguous = [r['row'] for r in records if bool(r['deposit']) == bool(r['withdrawal'])]
        if ambiguous:
            issues.append({'kind': 'amount', 'message': '입금·출금 금액 구분 확인이 필요합니다.', 'rows': ambiguous})
        oldest, newest = (records[-1], records[0]) if records and ordered else (None, None)
        return {'records': records, 'count': len(records), 'deposits': deposits, 'withdrawals': withdrawals,
                'bankDeposits': bank_deposits, 'bankWithdrawals': bank_withdrawals,
                'openingBalance': oldest['balance'] - oldest['deposit'] + oldest['withdrawal'] if oldest else None,
                'closingBalance': newest['balance'] if newest else None,
                'firstTransaction': min(dates) if dates else None, 'lastTransaction': max(dates) if dates else None,
                'balanceChecks': max(0, len(records) - 1) if ordered else None,
                'issues': issues, 'status': 'review' if issues else 'verified'}
    finally:
        book.release_resources()


def manifest_path(selected, branch):
    month(selected)
    if branch not in BRANCHES:
        raise ValueError('지점을 확인해주세요.')
    return root() / f'{selected}-{branch}.json'


def load(selected, branch):
    path = manifest_path(selected, branch)
    if not path.exists():
        return None
    value = json.loads(path.read_text('utf-8'))
    if value['month'] != selected or value['branch'] != branch or not re.fullmatch('[0-9a-f]{64}', value['sha256']):
        raise ValueError('저장 정보 확인이 필요합니다.')
    return value


def save(raw, branch, selected, collected_at, full_export):
    at = datetime.fromisoformat(collected_at)
    if at.tzinfo is None or at > now() + timedelta(minutes=5) or not full_export or month(selected) > previous_month():
        raise ValueError('완료된 월의 실제 전체 다운로드와 수집 시각이 필요합니다.')
    if at.date().isoformat() <= period(selected)[1]:
        raise ValueError('수집 시각이 거래 월말보다 빠릅니다.')
    parsed = parse_export(raw, branch, selected)
    value = {'month': selected, 'branch': branch, 'collectedAt': collected_at, 'sha256': digest(raw),
             'bytes': len(raw), 'fullExport': True, **parsed}
    with LOCK:
        previous = load(selected, branch)
        if previous and datetime.fromisoformat(previous['collectedAt']) > at:
            raise ValueError('오래된 자료로 최신 수집을 덮어쓸 수 없습니다.')
        atomic(root() / 'files' / (value['sha256'] + '.xls'), raw)
        if previous and previous != value:
            atomic(root() / 'history' / f'{selected}-{branch}-{digest(encoded(previous))}.json', encoded(previous))
        atomic(manifest_path(selected, branch), encoded(value))
        failure = root() / f'{selected}-{branch}.failure.json'
        failure.unlink(missing_ok=True)
    return {'month': selected, 'branch': branch, 'sha256': value['sha256'], 'count': value['count'], 'status': value['status']}


def save_failure(selected, branch):
    manifest_path(selected, branch)
    atomic(root() / f'{selected}-{branch}.failure.json', encoded({'failedAt': now().isoformat(), 'message': '은행 조회 또는 원본 검증에 실패했습니다. 이전 성공 자료는 유지합니다.'}))
    return {'month': selected, 'branch': branch, 'failed': True}


def original(selected, branch):
    value = load(selected, branch)
    if not value:
        raise FileNotFoundError()
    raw = (root() / 'files' / (value['sha256'] + '.xls')).read_bytes()
    if digest(raw) != value['sha256']:
        raise ValueError('원본 파일의 해시가 일치하지 않습니다.')
    return raw


def report(selected=''):
    selected = month(selected) if selected else previous_month()
    months = {selected, previous_month()}
    for path in root().glob('*.json'):
        match = re.fullmatch(r'(20\d{2}-\d{2})-(incheon|anyang)\.json', path.name)
        if match:
            months.add(month(match[1]))
    branches = []
    for ident, (name, account) in BRANCHES.items():
        item = load(selected, ident)
        if item:
            original(selected, ident)
        failed_path = root() / f'{selected}-{ident}.failure.json'
        failed = json.loads(failed_path.read_text('utf-8')) if failed_path.exists() else None
        branches.append({**(item or {}), 'id': ident, 'name': name, 'account': account, 'available': item is not None,
                         'failure': failed, 'downloadUrl': f'/api/bank-transactions/download?month={selected}&branch={ident}' if item else None})
    next_date = now().replace(day=1, hour=9, minute=0, second=0, microsecond=0)
    if next_date <= now():
        next_date = (next_date.replace(day=28) + timedelta(days=4)).replace(day=1)
    return {'month': selected, 'period': period(selected), 'expectedMonth': previous_month(), 'months': sorted(months, reverse=True),
            'nextCollectionAt': next_date.isoformat(), 'branches': branches}


def handle(handler, method):
    parts = urlsplit(handler.path)
    if parts.path not in ('/api/bank-transactions', '/api/bank-transactions/download'):
        return False
    from support_applications import send_json
    try:
        if method not in ('GET', 'HEAD'):
            send_json(handler, 405, {'error': '조회·다운로드 전용입니다.'})
            return True
        query = parse_qs(parts.query, keep_blank_values=True)
        if any(len(v) != 1 for v in query.values()):
            raise ValueError()
        selected = query.get('month', [''])[0]
        if parts.path.endswith('/download'):
            branch = query.get('branch', [''])[0]
            raw = original(month(selected), branch)
            handler.send_response(200)
            handler.send_header('Content-Type', 'application/vnd.ms-excel')
            handler.send_header('Content-Disposition', f'attachment; filename="hana-{branch}-{selected}.xls"')
            handler.send_header('Cache-Control', 'no-store, private')
            handler.send_header('Content-Length', str(len(raw)))
            handler.end_headers()
            if method != 'HEAD':
                handler.wfile.write(raw)
        else:
            send_json(handler, 200, report(selected), method == 'HEAD')
    except FileNotFoundError:
        send_json(handler, 404, {'error': '해당 월의 원본 파일이 아직 없습니다.'}, method == 'HEAD')
    except (ValueError, TypeError, KeyError):
        send_json(handler, 400, {'error': '거래 월·지점 또는 원본 파일 확인이 필요합니다.'}, method == 'HEAD')
    except OSError:
        send_json(handler, 503, {'error': '거래내역 저장 자료를 읽지 못했습니다.'}, method == 'HEAD')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--import-gzip-base64')
    group.add_argument('--verify')
    group.add_argument('--failure')
    parser.add_argument('--branch', choices=BRANCHES, required=True)
    args = parser.parse_args()
    if args.failure:
        result = save_failure(args.failure, args.branch)
    elif args.verify:
        item = load(month(args.verify), args.branch)
        result = {'month': args.verify, 'branch': args.branch, 'sha256': digest(original(args.verify, args.branch)), 'count': item['count'], 'status': item['status']}
    else:
        with gzip.GzipFile(fileobj=io.BytesIO(base64.b64decode(args.import_gzip_base64, validate=True))) as stream:
            raw = stream.read(14_000_001)
        if len(raw) > 14_000_000:
            raise ValueError('파일 크기를 확인해주세요.')
        value = json.loads(raw)
        if set(value) != {'month', 'branch', 'collectedAt', 'fullExport', 'file'} or value['branch'] != args.branch:
            raise ValueError('수집 형식을 확인해주세요.')
        result = save(base64.b64decode(value['file'], validate=True), args.branch, value['month'], value['collectedAt'], value['fullExport'] is True)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
