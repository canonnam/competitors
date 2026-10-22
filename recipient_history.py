"""Private, read-only Longterm recipient qualification history snapshots."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

KST = timezone(timedelta(hours=9))
BRANCHES = {'anyang': ('안양점', '14117000625'), 'incheon': ('인천점', '12817700685')}
HEADERS = ['수급자명', '인정관리번호', '자격', '적용일자', '종료일자']
MONTH = re.compile(r'20\d{2}-(?:0[1-9]|1[0-2])\Z')
HASH = re.compile(r'[0-9a-f]{64}\Z')
LOCK = threading.RLock()


def now():
    return datetime.now(KST).isoformat(timespec='seconds')


def current_month(at=None):
    return (at or datetime.now(KST)).astimezone(KST).strftime('%Y-%m')


def month(value):
    if not isinstance(value, str) or not MONTH.fullmatch(value):
        raise ValueError('급여제공월 형식 오류')
    return value


def root():
    default = Path('/data/recipient-history') if Path('/data').is_dir() else Path(__file__).parent / '.local/recipient-history/store'
    return Path(os.environ.get('RECIPIENT_HISTORY_DIR', default))


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def text(value, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ValueError('문자열 형식 오류')
    return value.strip()


def iso_day(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('날짜 형식 오류')
    date.fromisoformat(value)
    return value


def checked_at(value):
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed > datetime.now(KST) + timedelta(minutes=5):
        raise ValueError('실제 조회 시각을 확인해주세요')
    return parsed.astimezone(KST).isoformat(timespec='seconds')


def validate(payload):
    if payload.get('schemaVersion') != 1:
        raise ValueError('자료 버전 오류')
    period = month(payload.get('benefitMonth'))
    branches = payload.get('branches')
    if not isinstance(branches, list) or not 1 <= len(branches) <= 2:
        raise ValueError('지점 자료 오류')
    cleaned, seen = [], set()
    for branch in branches:
        key = branch.get('id')
        if key not in BRANCHES or key in seen or branch.get('institutionNumber') != BRANCHES[key][1]:
            raise ValueError('지점·기관번호 불일치')
        seen.add(key)
        source, records = branch.get('source', {}), branch.get('records')
        if not isinstance(records, list) or len(records) > 5000 or type(source.get('recordCount')) is not int or source['recordCount'] != len(records):
            raise ValueError('원본 조회 건수와 수집 행 수가 다릅니다')
        if source.get('kind') not in ('portal-dom', 'xlsx') or source.get('headers') != HEADERS or not HASH.fullmatch(source.get('sha256', '')):
            raise ValueError('출처 검증 오류')
        safe = []
        for row in records:
            # Reject rather than silently persist an unexpected government identifier.
            if set(row) != {'personKey', 'name', 'qualification', 'appliedOn', 'endOn'} or not HASH.fullmatch(row.get('personKey', '')):
                raise ValueError('허용되지 않은 개인정보 필드')
            item = {'personKey': row['personKey'], 'name': text(row['name'], 40),
                    'qualification': text(row['qualification'], 50),
                    'appliedOn': iso_day(row['appliedOn']), 'endOn': iso_day(row['endOn'])}
            if item['endOn'] < item['appliedOn']:
                raise ValueError('적용·종료일 역전')
            safe.append(item)
        source_hash = hashlib.sha256(json.dumps(safe, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
        if source_hash != source['sha256']:
            raise ValueError('수집 행 무결성 해시 불일치')
        cleaned.append({'id': key, 'institutionNumber': BRANCHES[key][1], 'checkedAt': checked_at(branch['checkedAt']),
                        'source': {'kind': source['kind'], 'recordCount': len(safe), 'headers': HEADERS, 'sha256': source['sha256']},
                        'records': safe})
    return {'schemaVersion': 1, 'benefitMonth': period, 'branches': sorted(cleaned, key=lambda b: b['id'])}


def analyze(branch, period):
    """Only contiguous, unambiguous before/after source rows establish a change."""
    groups, events = {}, []
    as_of = datetime.fromisoformat(branch['checkedAt']).astimezone(KST).date().isoformat()
    for row in branch['records']:
        groups.setdefault(row['personKey'], []).append(row)
    for person, source_rows in groups.items():
        rows = sorted({(r['appliedOn'], r['endOn'], r['qualification'], r['name']) for r in source_rows})
        for start, end, qualification, name in rows:
            if start[:7] != period:
                continue
            earlier = [r for r in rows if r[0] < start]
            adjacent = [r for r in earlier if (date.fromisoformat(start) - date.fromisoformat(r[1])).days in (0, 1)]
            overlaps = [r for r in earlier if r[1] > start]
            same_day = [r for r in rows if r[0] == start]
            before, reason = None, ''
            if len(adjacent) == 1 and not overlaps and len(same_day) == 1:
                before = adjacent[0][2]
                kind = 'period' if before == qualification else 'change'
            else:
                kind = 'review'
                reason = '이전 구분 미확인' if not earlier and len(same_day) == 1 else '중복·겹침 또는 기간 단절 확인 필요'
            events.append({'personKey': person, 'name': name, 'effectiveOn': start, 'before': before,
                           'after': qualification, 'kind': kind, 'scheduled': start > as_of, 'reason': reason})
        # A finite end without a successor is not proof of a category change.
        last = max(rows, key=lambda r: r[1])
        if last[1][:7] == period and not any(r[0] >= last[1] and r != last for r in rows):
            events.append({'personKey': person, 'name': last[3], 'effectiveOn': last[1], 'before': last[2],
                           'after': None, 'kind': 'review', 'scheduled': last[1] > as_of, 'reason': '기간 종료·후속 자격 미확인'})
    events.sort(key=lambda e: (e['effectiveOn'], e['name'], e['personKey']))
    count = lambda kind, scheduled=False: len({e['personKey'] for e in events if e['kind'] == kind and e['scheduled'] == scheduled})
    return {'sourceRecords': len(branch['records']), 'people': len(groups), 'changedPeople': count('change'),
            'scheduledPeople': count('change', True), 'periodOnlyPeople': len({e['personKey'] for e in events if e['kind'] == 'period'}),
            'reviewPeople': len({e['personKey'] for e in events if e['kind'] == 'review'}), 'events': events}


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.recipient-')
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def saved(period):
    path = root() / (month(period) + '.json')
    return validate(json.loads(path.read_text('utf-8'))) if path.exists() else None


def save(payload):
    clean = validate(payload)
    period = clean['benefitMonth']
    with LOCK:
        previous = saved(period)
        branches = {b['id']: b for b in (previous or {}).get('branches', [])}
        for branch in clean['branches']:
            old = branches.get(branch['id'])
            if old and branch['checkedAt'] < old['checkedAt']:
                raise ValueError('이전 조회 자료로 덮어쓸 수 없습니다')
        if previous and previous != clean:
            atomic(root() / 'history' / f'{period}-{digest(previous)}.json', encoded(previous))
        branches.update({b['id']: b for b in clean['branches']})
        merged = validate({**clean, 'branches': list(branches.values())})
        atomic(root() / (period + '.json'), encoded(merged))
        for branch in clean['branches']:
            failure = root() / f'{period}-{branch["id"]}.failure.json'
            if failure.exists():
                failure.unlink()
    return {'benefitMonth': period, 'branches': {b['id']: digest(b) for b in clean['branches']}}


def save_failure(period, branch):
    month(period)
    if branch not in BRANCHES:
        raise ValueError('지점 오류')
    value = {'failedAt': now(), 'message': '조회 또는 검증 실패. 이전 성공 결과가 있으면 유지합니다.'}
    with LOCK:
        atomic(root() / f'{period}-{branch}.failure.json', encoded(value))
    return {'benefitMonth': period, 'branch': branch, **value}


def report(period='', summary=False):
    selected = month(period) if period else current_month()
    payload = saved(selected)
    found = {b['id']: b for b in (payload or {}).get('branches', [])}
    months = sorted({current_month(), selected, *[p.stem for p in root().glob('*.json') if MONTH.fullmatch(p.stem)]}, reverse=True)
    branches = []
    for key, (name, _) in BRANCHES.items():
        branch = found.get(key)
        failure = root() / f'{selected}-{key}.failure.json'
        failed = json.loads(failure.read_text('utf-8')) if failure.exists() else None
        item = {'id': key, 'name': name, 'available': branch is not None, 'checkedAt': branch['checkedAt'] if branch else None,
                'failure': failed, 'status': 'previous' if branch and failed else 'failed' if failed else 'ready' if branch else 'unqueried'}
        if branch:
            counts = analyze(branch, selected)
            item.update({k: v for k, v in counts.items() if k != 'events'})
            if not summary:
                item.update({'events': counts['events'], 'records': branch['records'], 'source': branch['source']})
        branches.append(item)
    return {'benefitMonth': selected, 'expectedMonth': current_month(), 'months': months, 'branches': branches}


def handle(handler, method):
    parts = urlsplit(handler.path)
    if parts.path not in ('/api/recipient-history', '/api/recipient-history/summary'):
        return False
    from support_applications import send_json
    try:
        if method not in ('GET', 'HEAD'):
            send_json(handler, 405, {'error': '조회 전용입니다.'})
        else:
            query = parse_qs(parts.query)
            send_json(handler, 200, report(query.get('month', [''])[0], parts.path.endswith('/summary')), method == 'HEAD')
    except (ValueError, TypeError, KeyError):
        send_json(handler, 400, {'error': '조회 월 또는 저장 자료의 검증이 필요합니다.'}, method == 'HEAD')
    except OSError:
        send_json(handler, 503, {'error': '저장 자료를 불러오지 못했습니다.'}, method == 'HEAD')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--import-gzip-base64')
    group.add_argument('--verify')
    group.add_argument('--failure')
    parser.add_argument('--branch', choices=BRANCHES)
    args = parser.parse_args()
    if args.failure:
        result = save_failure(args.failure, args.branch)
    elif args.verify:
        payload = saved(month(args.verify))
        result = {'benefitMonth': args.verify, 'branches': {b['id']: digest(b) for b in (payload or {}).get('branches', [])}}
    else:
        with gzip.GzipFile(fileobj=io.BytesIO(base64.b64decode(args.import_gzip_base64, validate=True))) as stream:
            raw = stream.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('자료 크기 초과')
        result = save(json.loads(raw))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
