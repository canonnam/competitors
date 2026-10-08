"""Hourly, aggregate-only admission/discharge counts from the existing ERP."""
from datetime import datetime
import copy
import os
import re
import threading
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

import facility_access
import facility_observation as erp

PREFIX = '/api/resident-movement'
INTERVAL = 3600
STATE = {}
STATE_LOCK = threading.RLock()
COLLECT_LOCK = threading.Lock()
SERVICE = {'access': '', 'refresh': '', 'lock': threading.RLock()}


def now():
    return datetime.now(erp.KST)


def connect():
    user, password = os.getenv('FACILITY_ERP_USERNAME'), os.getenv('FACILITY_ERP_PASSWORD')
    if not user or not password:
        user, password = os.getenv('LIABILITY_ERP_USERNAME'), os.getenv('LIABILITY_ERP_PASSWORD')
    if not user or not password:
        raise erp.ApiError(503, 'ERP 자동 수집 계정이 아직 설정되지 않았습니다.')
    access, refresh = erp.token_pair(erp.request('/api/token/', body={'username': user, 'password': password}))
    SERVICE.update(access=access, refresh=refresh)


def identifier(value):
    if isinstance(value, dict):
        value = value.get('id')
    if isinstance(value, bool) or not re.fullmatch(r'[1-9]\d{0,18}', str(value)):
        raise erp.ApiError(502, 'ERP 입·퇴소 식별 정보를 확인해주세요.')
    return str(value)


def month_key(value, cutoff):
    if value in (None, ''):
        return None
    try:
        if not isinstance(value, str) or not re.match(r'^\d{4}-\d{2}-\d{2}(?:$|[T ])', value):
            raise ValueError()
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        # Date-only/naive ERP values already describe Seoul local time.
        parsed = parsed.replace(tzinfo=erp.KST) if parsed.tzinfo is None else parsed.astimezone(erp.KST)
        if not 1900 <= parsed.year <= 2100:
            raise ValueError()
        return parsed.strftime('%Y-%m') if parsed.date() <= cutoff else None
    except (ValueError, TypeError):
        raise erp.ApiError(502, 'ERP 입·퇴소 날짜 형식을 확인해주세요.') from None


def deleted(row):
    return row.get('is_deleted') is True or bool(row.get('deleted_at')) or row.get('status') == 'deleted'


def rows(ident, endpoint, status=None):
    params = {'nursing_home': ident}
    if status:
        params['status'] = status
    path = endpoint + '?' + urlencode(params)
    visited, seen, total = set(), set(), 0
    deadline = time.monotonic() + 60
    while path:
        url = urlsplit(urljoin(erp.BACKEND, path))
        query = parse_qs(url.query)
        if (url.scheme != 'https' or url.netloc != urlsplit(erp.BACKEND).netloc or url.path != endpoint
                or query.get('nursing_home') != [str(ident)] or (status and query.get('status') != [status])
                or url.geturl() in visited or len(visited) >= 100):
            raise erp.ApiError(502, 'ERP 입·퇴소 목록의 지점과 페이지 연결을 확인해주세요.')
        visited.add(url.geturl())
        data = erp.authorized(SERVICE, url.geturl(), deadline)
        batch = data if isinstance(data, list) else data.get('results') if isinstance(data, dict) else None
        if not isinstance(batch, list) or total + len(batch) > 50000:
            raise erp.ApiError(502, 'ERP 입·퇴소 목록 형식을 확인해주세요.')
        total += len(batch)
        for row in batch:
            if not isinstance(row, dict):
                raise erp.ApiError(502, 'ERP 입·퇴소 목록 형식을 확인해주세요.')
            branch = row.get('nursing_home_id', row.get('nursing_home'))
            if branch is not None and identifier(branch) != str(ident):
                raise erp.ApiError(502, 'ERP 입·퇴소 응답의 지점이 요청과 다릅니다.')
            key = identifier(row.get('id'))
            if key in seen:
                raise erp.ApiError(502, 'ERP 입·퇴소 목록에 중복된 페이지 항목이 있습니다.')
            seen.add(key)
            if not deleted(row):
                yield row
        path = None if isinstance(data, list) else data.get('next')
        if path is not None and not isinstance(path, str):
            raise erp.ApiError(502, 'ERP 입·퇴소 페이지 연결을 확인해주세요.')


def bundle(ident):
    cutoff = now().date()
    admissions, discharges, missing = {}, {}, 0
    for row in rows(ident, '/api/elderly/', 'all'):
        month = month_key(row.get('admission_date'), cutoff)
        if row.get('admission_date') in (None, ''):
            missing += 1
        if month:
            admissions.setdefault(month, set()).add(identifier(row['id']))
    for row in rows(ident, '/api/discharge-records/'):
        if row.get('discharge_date') in (None, ''):
            raise erp.ApiError(502, 'ERP 퇴소 기록의 퇴소일이 누락되어 있습니다.')
        month = month_key(row['discharge_date'], cutoff)
        if month:
            discharges.setdefault(month, set()).add(identifier(row.get('elderly', row.get('elderly_id'))))
    # Only counts survive the collection. Names, IDs and individual dates are discarded.
    months = [{'month': month, 'admitted': len(admissions.get(month, ())),
               'discharged': len(discharges.get(month, ()))} for month in sorted(admissions.keys() | discharges.keys())]
    return {'id': ident, 'name': erp.BRANCHES[ident], 'asOf': cutoff.isoformat(),
            'checkedAt': now().isoformat(timespec='seconds'), 'missingAdmissionDates': missing, 'months': months}


def collect_once():
    if not COLLECT_LOCK.acquire(blocking=False):
        return False
    try:
        for ident in erp.BRANCHES:
            attempt = now().isoformat(timespec='seconds')
            try:
                with SERVICE['lock']:
                    if not SERVICE['access']:
                        connect()
                    try:
                        result = bundle(ident)
                    except erp.ApiError as error:
                        if error.status != 401:
                            raise
                        connect()
                        result = bundle(ident)
                with STATE_LOCK:
                    STATE[ident] = {'result': result, 'attemptedAt': attempt, 'error': None, 'successAt': time.time()}
            except Exception as error:
                message = error.message if isinstance(error, erp.ApiError) else 'ERP 입·퇴소 자동 수집을 완료하지 못했습니다.'
                with STATE_LOCK:
                    STATE[ident] = {**STATE.get(ident, {}), 'attemptedAt': attempt, 'error': message}
        return True
    finally:
        COLLECT_LOCK.release()


def report():
    with STATE_LOCK:
        states = copy.deepcopy(STATE)
    branches = []
    for ident, name in erp.BRANCHES.items():
        state = states.get(ident, {})
        result = state.get('result')
        branches.append({**(result or {'id': ident, 'name': name, 'asOf': None, 'checkedAt': None, 'months': None}),
                         'attemptedAt': state.get('attemptedAt'), 'collectionError': state.get('error'),
                         'stale': not result or bool(state.get('error')) or time.time() - state.get('successAt', 0) > INTERVAL + 120
                                  or result['asOf'] != now().date().isoformat()})
    return {'schemaVersion': 1, 'today': now().date().isoformat(), 'timeZone': 'Asia/Seoul',
            'intervalSeconds': INTERVAL, 'branches': branches}


def handle(handler, method):
    if urlsplit(handler.path).path != PREFIX:
        return False
    head = method == 'HEAD'
    if not facility_access.require(handler, head):
        return True
    if method not in ('GET', 'HEAD'):
        erp.send(handler, 405, {'error': '조회 전용 화면입니다.'}, head)
    else:
        erp.send(handler, 200, report(), head)
    return True


def start_scheduler():
    stop = threading.Event()
    def run():
        while not stop.is_set():
            started = time.monotonic()
            collect_once()
            stop.wait(max(1, INTERVAL - (time.monotonic() - started)))
    threading.Thread(target=run, name='resident-movement-hourly', daemon=True).start()
    return stop
