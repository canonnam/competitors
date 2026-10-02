"""Hourly ERP collection with an authenticated, memory-only resident cache."""
from datetime import datetime
import copy
import os
import re
import threading
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
import facility_observation as erp
import facility_access

INTERVAL = 3600
ROOM_PATH = '/api/nursing-homes/living-rooms/'
STATE = {}
STATE_LOCK = threading.RLock()
COLLECT_LOCK = threading.Lock()
SERVICE = {'access': '', 'refresh': '', 'lock': threading.RLock()}


def configured():
    return bool(os.getenv('FACILITY_ERP_USERNAME') and os.getenv('FACILITY_ERP_PASSWORD'))


def connect():
    if not configured():
        raise erp.ApiError(503, 'ERP 자동 수집 계정이 아직 설정되지 않았습니다.')
    access, refresh = erp.token_pair(erp.request('/api/token/', body={
        'username': os.environ['FACILITY_ERP_USERNAME'], 'password': os.environ['FACILITY_ERP_PASSWORD']}))
    SERVICE.update(access=access, refresh=refresh)


def integer(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1000:
        raise erp.ApiError(502, f'ERP 생활실 {label} 형식을 확인해주세요.')
    return value


def living_rooms(ident, include_residents=False):
    path = ROOM_PATH + '?' + urlencode({'nursing_home': ident})
    rows, visited, ids, resident_ids = [], set(), set(), set()
    deadline = time.monotonic() + 35
    while path:
        url = urlsplit(urljoin(erp.BACKEND, path))
        if (url.scheme != 'https' or url.netloc != urlsplit(erp.BACKEND).netloc or url.path != ROOM_PATH
                or parse_qs(url.query).get('nursing_home') != [str(ident)] or url.geturl() in visited or len(visited) >= 30):
            raise erp.ApiError(502, 'ERP 생활실 목록의 지점과 페이지 연결을 확인해주세요.')
        visited.add(url.geturl())
        data = erp.authorized(SERVICE, url.geturl(), deadline)
        batch = data if isinstance(data, list) else data.get('results') if isinstance(data, dict) else None
        if not isinstance(batch, list) or len(rows) + len(batch) > 1000:
            raise erp.ApiError(502, 'ERP 생활실 목록 형식을 확인해주세요.')
        for raw in batch:
            if not isinstance(raw, dict) or raw.get('id') is None or str(raw['id']) in ids:
                raise erp.ApiError(502, 'ERP 생활실의 중복과 식별 정보를 확인해주세요.')
            ids.add(str(raw['id']))
            branch = raw.get('nursing_home_id', raw.get('nursing_home'))
            if branch is not None and str(branch) != str(ident):
                raise erp.ApiError(502, 'ERP 생활실의 지점이 요청한 지점과 다릅니다.')
            name = erp.text(raw.get('name'))
            floor = raw.get('floor')
            if not name or isinstance(floor, bool) or not isinstance(floor, (int, str)):
                raise erp.ApiError(502, 'ERP 생활실 이름과 층을 확인해주세요.')
            occupancy = integer(raw.get('current_occupancy'), '현원')
            capacity = integer(raw.get('capacity'), '정원')
            rows.append({'name': name, 'floor': str(floor)[:20], 'current_occupancy': occupancy,
                         'capacity': capacity, 'remaining_capacity': max(0, capacity - occupancy),
                         'occupancy_status': 'over_capacity' if occupancy > capacity else 'full' if occupancy == capacity else 'available'})
            if include_residents:
                residents = raw.get('elderly_residents')
                if residents is not None and (not isinstance(residents, list) or len(residents) > 1000):
                    raise erp.ApiError(502, 'ERP 생활실 입소자 목록 형식을 확인해주세요.')
                clean, seen = [], set()
                for resident in residents or []:
                    if not isinstance(resident, dict) or isinstance(resident.get('id'), bool) or not re.fullmatch(r'[1-9]\d{0,18}', str(resident.get('id', ''))):
                        raise erp.ApiError(502, 'ERP 입소자 식별 정보를 확인해주세요.')
                    resident_id = str(resident['id'])
                    if resident_id in seen or resident_id in resident_ids:
                        raise erp.ApiError(502, 'ERP 생활실에 중복된 입소자가 있습니다.')
                    seen.add(resident_id)
                    resident_ids.add(resident_id)
                    clean.append({'id': resident_id, 'name': erp.text(resident.get('name')) or '이름 미확인'})
                rows[-1]['elderly_residents'] = clean if residents is not None else None
        path = None if isinstance(data, list) else data.get('next')
        if path is not None and not isinstance(path, str):
            raise erp.ApiError(502, 'ERP 생활실 페이지 연결을 확인해주세요.')
    return rows


def bundle(ident):
    observations = erp.targets(SERVICE, ident, include_ids=True)
    private_rooms = living_rooms(ident, include_residents=True)
    rooms = [{k:v for k,v in r.items() if k != 'elderly_residents'} for r in private_rooms]
    grouped = {}
    for row in observations['rows']:
        key = (row['living_room_floor'], row['living_room_name'])
        group = grouped.setdefault(key, {'living_room_floor': key[0], 'living_room_name': key[1], 'focus': 0, 'watch': 0})
        group[row['risk_tier']] += 1
    return {'nursingHomeId': ident, 'nursingHomeName': erp.BRANCHES[ident],
            'snapshotDate': observations['snapshotDate'], 'checkedAt': datetime.now(erp.KST).isoformat(timespec='seconds'),
            'rooms': rooms, 'observations': list(grouped.values()), 'assignedOccupancy': sum(r['current_occupancy'] for r in rooms),
            'privateRooms': private_rooms, 'privateObservations': observations['rows']}


def collect_once():
    # A browser request cannot start collection or make concurrent ERP requests.
    if not COLLECT_LOCK.acquire(blocking=False):
        return False
    try:
        for ident in erp.BRANCHES:
            attempt = datetime.now(erp.KST).isoformat(timespec='seconds')
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
                message = error.message if isinstance(error, erp.ApiError) else 'ERP 자동 수집을 완료하지 못했습니다.'
                with STATE_LOCK:
                    previous = STATE.get(ident, {})
                    STATE[ident] = {**previous, 'attemptedAt': attempt, 'error': message}
        return True
    finally:
        COLLECT_LOCK.release()


def cached(ident, private=False):
    with STATE_LOCK:
        state = copy.deepcopy(STATE.get(ident, {}))
    if not state.get('result'):
        raise erp.ApiError(503, state.get('error') or ('ERP 첫 자동 수집을 진행하고 있습니다.' if configured() else 'ERP 자동 수집 계정이 아직 설정되지 않았습니다.'))
    result = state['result']
    rooms, observations = result.pop('privateRooms'), result.pop('privateObservations')
    if private:
        result['rooms'] = rooms
        result['residentObservations'] = observations
    result.update(attemptedAt=state['attemptedAt'], collectionError=state.get('error'), intervalSeconds=INTERVAL,
                  stale=bool(state.get('error')) or time.time() - state['successAt'] > INTERVAL + 120
                        or result['snapshotDate'] != datetime.now(erp.KST).date().isoformat())
    return result


def handle(handler, method):
    parts = urlsplit(handler.path)
    if parts.path not in (erp.PREFIX + 'data', erp.PREFIX + 'residents'):
        return False
    head = method == 'HEAD'
    if not facility_access.require(handler, head):
        return True
    try:
        if method not in ('GET', 'HEAD'):
            raise erp.ApiError(405, '조회 전용 화면입니다.')
        query = parse_qs(parts.query)
        if query.get('nursing_home_id') not in (['2'], ['3']):
            raise erp.ApiError(400, '건물의 ERP 지점을 선택해주세요.')
        erp.send(handler, 200, cached(int(query['nursing_home_id'][0]), private=parts.path.endswith('/residents')), head)
    except erp.ApiError as error:
        erp.send(handler, error.status, {'error': error.message}, head)
    return True


def start_scheduler():
    stop = threading.Event()
    def run():
        while not stop.is_set():
            started = time.monotonic()
            collect_once()
            stop.wait(max(1, INTERVAL - (time.monotonic() - started)))
    threading.Thread(target=run, name='facility-hourly-collection', daemon=True).start()
    return stop
