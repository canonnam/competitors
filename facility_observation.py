"""Authenticated, uncached ERP focus/watch lookup. Resident data is never stored."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
import hashlib
import json
import re
import secrets
import threading
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
import urllib.error
import urllib.request

BACKEND = 'https://vida-backend-prod-production.up.railway.app'
PREFIX = '/api/facility-observation/'
LIST_PATH = '/api/health-insights/snapshots/'
COOKIE = 'vida_facility_session'
BRANCHES = {2: '안양점', 3: '인천점'}
KST = timezone(timedelta(hours=9))
SESSIONS = {}
ATTEMPTS = {}
LOCK = threading.RLock()
TTL = 8 * 60 * 60


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ApiError(502, 'ERP 조회 주소가 변경되어 연결을 확인해야 합니다.')


def request(path, access=None, body=None, timeout=15):
    url = urljoin(BACKEND, path)
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.netloc != urlsplit(BACKEND).netloc or not parts.path.startswith('/api/'):
        raise ApiError(502, 'ERP 조회 주소를 확인해주세요.')
    headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
    if access:
        headers['Authorization'] = 'Bearer ' + access
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ApiError(502, 'ERP 응답이 너무 큽니다. 조회 범위를 확인해주세요.')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise ApiError(401, 'ERP 로그인이 만료되었거나 계정 정보가 올바르지 않습니다.') from None
        if error.code == 403:
            raise ApiError(403, '이 계정에 해당 지점의 대상자 조회 권한이 없습니다.') from None
        raise ApiError(502, 'ERP 대상자 조회에 실패했습니다. 잠시 후 다시 조회해주세요.') from None
    except (OSError, ValueError):
        raise ApiError(502, 'ERP에 연결하지 못했습니다. 잠시 후 다시 조회해주세요.') from None


def token_pair(data):
    if not isinstance(data, dict) or not isinstance(data.get('access'), str) or not 20 <= len(data['access']) <= 8192:
        raise ApiError(502, 'ERP 로그인 응답을 확인해주세요.')
    refresh = data.get('refresh', '')
    if not isinstance(refresh, str) or len(refresh) > 8192:
        raise ApiError(502, 'ERP 로그인 응답을 확인해주세요.')
    return data['access'], refresh


def session_key(handler):
    try:
        cookie = SimpleCookie(handler.headers.get('Cookie', ''))
        value = cookie[COOKIE].value if COOKIE in cookie else ''
    except Exception:
        value = ''
    return hashlib.sha256(value.encode()).hexdigest() if re.fullmatch(r'[A-Za-z0-9_-]{43}', value) else ''


def get_session(handler):
    key = session_key(handler)
    with LOCK:
        for old in [k for k, s in SESSIONS.items() if s['expires'] <= time.time()]:
            SESSIONS.pop(old, None)
        return SESSIONS.get(key)


def cookie_header(handler, value='', age=0):
    host = urlsplit('//' + handler.headers.get('Host', '')).hostname
    secure = '' if host in ('localhost', '127.0.0.1', '::1') else '; Secure'
    return f'{COOKIE}={value}; Path={PREFIX}; Max-Age={age}; HttpOnly; SameSite=Strict{secure}'


def send(handler, status, data, head=False, cookie=None):
    raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store, private')
    handler.send_header('Vary', 'Cookie')
    handler.send_header('Content-Length', str(len(raw)))
    if cookie:
        handler.send_header('Set-Cookie', cookie)
    handler.end_headers()
    if not head:
        handler.wfile.write(raw)


def same_origin(handler):
    origin = urlsplit(handler.headers.get('Origin', ''))
    host = handler.headers.get('Host', '')
    local = origin.hostname in ('localhost', '127.0.0.1', '::1')
    if origin.netloc != host or origin.scheme != ('http' if local else 'https'):
        raise ApiError(403, '시설 도면 페이지에서 연결해주세요.')


def body(handler):
    try:
        length = int(handler.headers.get('Content-Length', '0'))
        if not 0 < length <= 4096 or handler.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError()
        data = json.loads(handler.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError()
        return data
    except (ValueError, TypeError):
        raise ApiError(400, '로그인 입력 형식을 확인해주세요.') from None


def login(handler):
    same_origin(handler)
    data = body(handler)
    user, password = data.get('username'), data.get('password')
    if not isinstance(user, str) or not 1 <= len(user.strip()) <= 150 or not isinstance(password, str) or not 1 <= len(password) <= 1024:
        raise ApiError(400, 'ERP 아이디와 비밀번호를 입력해주세요.')
    ip = handler.client_address[0]
    with LOCK:
        now = time.time()
        for key in [k for k, values in ATTEMPTS.items() if not values or values[-1] < now - 60]:
            ATTEMPTS.pop(key, None)
        attempts = [at for at in ATTEMPTS.get(ip, []) if at > now - 60]
        if len(attempts) >= 5:
            raise ApiError(429, '로그인을 여러 번 시도했습니다. 1분 후 다시 연결해주세요.')
        ATTEMPTS[ip] = attempts + [now]
    access, refresh = token_pair(request('/api/token/', body={'username': user.strip(), 'password': password}))
    # Only tokens live in server memory. Passwords, resident rows and browser tokens are not persisted.
    value = secrets.token_urlsafe(32)
    with LOCK:
        get_session(handler)
        if len(SESSIONS) >= 500:
            raise ApiError(503, '연결이 많습니다. 잠시 후 다시 연결해주세요.')
        SESSIONS.pop(session_key(handler), None)
        SESSIONS[hashlib.sha256(value.encode()).hexdigest()] = {
            'access': access, 'refresh': refresh, 'expires': time.time() + TTL, 'lock': threading.RLock()}
    send(handler, 200, {'connected': True}, cookie=cookie_header(handler, value, TTL))


def authorized(session, path, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ApiError(504, 'ERP 조회 시간이 길어졌습니다. 다시 조회해주세요.')
    try:
        return request(path, session['access'], timeout=min(15, remaining))
    except ApiError as error:
        if error.status != 401 or not session['refresh']:
            raise
        refreshed = request('/api/token/refresh/', body={'refresh': session['refresh']})
        access, refresh = token_pair(refreshed)
        session['access'] = access
        if refresh:
            session['refresh'] = refresh
        return request(path, session['access'], timeout=min(15, max(1, deadline - time.monotonic())))


def text(value, maximum=80):
    return value.strip()[:maximum] if isinstance(value, str) else ''


def targets(session, ident, include_ids=False):
    day = datetime.now(KST).date().isoformat()
    rows, deadline = [], time.monotonic() + 35
    with session['lock']:
        for tier in ('focus', 'watch'):
            path = LIST_PATH + '?' + urlencode({'nursing_home_id': ident, 'risk_tier': tier, 'snapshot_date': day})
            visited = set()
            while path:
                url = urlsplit(urljoin(BACKEND, path))
                query = parse_qs(url.query)
                if (url.scheme != 'https' or url.netloc != urlsplit(BACKEND).netloc or url.path != LIST_PATH
                    or query.get('nursing_home_id') != [str(ident)] or query.get('risk_tier') != [tier]
                    or query.get('snapshot_date') != [day] or url.geturl() in visited or len(visited) >= 30):
                    raise ApiError(502, 'ERP 목록 페이지 연결을 확인해주세요.')
                visited.add(url.geturl())
                data = authorized(session, url.geturl(), deadline)
                batch = data if isinstance(data, list) else data.get('results') if isinstance(data, dict) else None
                if not isinstance(batch, list) or len(rows) + len(batch) > 10000:
                    raise ApiError(502, 'ERP 대상자 목록 형식을 확인해주세요.')
                for raw in batch:
                    if not isinstance(raw, dict):
                        raise ApiError(502, 'ERP 대상자 목록 형식을 확인해주세요.')
                    branch = raw.get('nursing_home_id', raw.get('nursing_home'))
                    if branch is not None and str(branch) != str(ident):
                        raise ApiError(502, 'ERP 응답의 지점이 요청한 지점과 다릅니다.')
                    if raw.get('snapshot_date') is not None and raw['snapshot_date'] != day:
                        raise ApiError(502, '오늘의 관찰 자료를 확인하지 못했습니다. 다시 조회해주세요.')
                    if raw.get('risk_tier') != tier:
                        raise ApiError(502, 'ERP 응답의 관찰 등급이 조회 조건과 다릅니다.')
                    value = raw.get('living_room_floor')
                    floor = str(value)[:20] if isinstance(value, (str, int)) and not isinstance(value, bool) else None
                    rows.append({'elderly_name': text(raw.get('elderly_name')) or '이름 미확인',
                                 'living_room_name': text(raw.get('living_room_name')) or None,
                                 'living_room_floor': floor, 'risk_tier': tier,
                                 'risk_tier_display': '집중관찰' if tier == 'focus' else '주의관찰'})
                    if include_ids:
                        resident_id = raw.get('elderly_id', raw.get('elderly'))
                        rows[-1]['elderly_id'] = str(resident_id) if not isinstance(resident_id, bool) and isinstance(resident_id, (str, int)) and re.fullmatch(r'[1-9]\d{0,18}', str(resident_id)) else None
                path = None if isinstance(data, list) else data.get('next')
                if path is not None and not isinstance(path, str):
                    raise ApiError(502, 'ERP 목록 페이지 연결을 확인해주세요.')
    return {'nursingHomeId': ident, 'nursingHomeName': BRANCHES[ident], 'snapshotDate': day,
            'checkedAt': datetime.now(KST).isoformat(timespec='seconds'), 'rows': rows}


def handle(handler, method):
    parts = urlsplit(handler.path)
    if not parts.path.startswith(PREFIX):
        return False
    head = method == 'HEAD'
    try:
        if parts.path == PREFIX + 'session':
            if method in ('GET', 'HEAD'):
                send(handler, 200, {'connected': get_session(handler) is not None}, head)
            elif method == 'POST':
                login(handler)
            elif method == 'DELETE':
                same_origin(handler)
                with LOCK:
                    SESSIONS.pop(session_key(handler), None)
                send(handler, 200, {'connected': False}, cookie=cookie_header(handler))
            else:
                raise ApiError(405, '지원하지 않는 요청입니다.')
        elif parts.path == PREFIX + 'targets' and method in ('GET', 'HEAD'):
            session = get_session(handler)
            if not session:
                raise ApiError(401, 'ERP 로그인으로 연결하면 관찰 대상자를 조회합니다.')
            query = parse_qs(parts.query)
            if query.get('nursing_home_id') not in (['2'], ['3']):
                raise ApiError(400, '건물의 ERP 지점을 선택해주세요.')
            try:
                result = targets(session, int(query['nursing_home_id'][0]))
            except ApiError as error:
                if error.status == 401:
                    with LOCK:
                        SESSIONS.pop(session_key(handler), None)
                raise
            send(handler, 200, result, head)
        else:
            raise ApiError(404, '조회 경로를 확인해주세요.')
    except ApiError as error:
        send(handler, error.status, {'error': error.message}, head)
    except Exception:
        send(handler, 502, {'error': 'ERP 연결을 완료하지 못했습니다. 다시 시도해주세요.'}, head)
    return True
