"""Password gate for the facility map and its data. Secrets stay on the server."""
from http.cookies import SimpleCookie, CookieError
from io import BytesIO
from pathlib import Path
import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from urllib.parse import urlsplit
import facility_observation as erp

PREFIX = '/api/facility-map-access/'
COOKIE = 'vida_facility_map'
TTL = 24 * 60 * 60
HASH_ENV = 'FACILITY_MAP_PASSWORD_HASH'
ATTEMPTS = {}
LOCK = threading.Lock()


def make_password_hash(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600000).hex()
    return f'pbkdf2_sha256$600000${salt}${digest}'


def setting():
    value = os.getenv(HASH_ENV, '')
    return value if re.fullmatch(r'pbkdf2_sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}', value) else ''


def signature(value):
    return hmac.new(setting().encode(), ('facility-map:' + value).encode(), hashlib.sha256).hexdigest()


def issue_cookie():
    payload = f'{int(time.time()) + TTL}.{secrets.token_hex(24)}'
    return payload + '.' + signature(payload)


def authorized(handler):
    if not setting():
        return False
    try:
        cookies = SimpleCookie(handler.headers.get('Cookie', ''))
        token = cookies[COOKIE].value if COOKIE in cookies else ''
        if not re.fullmatch(r'\d{10}\.[a-f0-9]{48}\.[a-f0-9]{64}', token):
            return False
        expiry, nonce, digest = token.split('.')
        return time.time() < int(expiry) <= time.time() + TTL + 1 and hmac.compare_digest(digest, signature(expiry + '.' + nonce))
    except (ValueError, TypeError, CookieError):
        return False


def cookie_header(handler, value='', age=0):
    local = urlsplit('//' + handler.headers.get('Host', '')).hostname in ('localhost', '127.0.0.1', '::1')
    return f'{COOKIE}={value}; Path=/; Max-Age={age}; HttpOnly; SameSite=Strict' + ('' if local else '; Secure')


def require(handler, head=False):
    if authorized(handler):
        return True
    erp.send(handler, 401, {'error': '비밀번호 인증이 필요합니다.', 'code': 'facility_map_locked'}, head)
    return False


def rate_limit(handler):
    # The global limit also bounds attempts when an upstream proxy shares an IP.
    ip, now = handler.client_address[0], time.time()
    with LOCK:
        for key in list(ATTEMPTS):
            ATTEMPTS[key] = [t for t in ATTEMPTS[key] if t > now - 300]
            if not ATTEMPTS[key]:
                del ATTEMPTS[key]
        if len(ATTEMPTS.get(ip, [])) >= 5 or len(ATTEMPTS.get('*', [])) >= 30:
            raise erp.ApiError(429, '입력 시도가 많습니다. 5분 후 다시 시도해주세요.')
        ATTEMPTS.setdefault(ip, []).append(now)
        ATTEMPTS.setdefault('*', []).append(now)
    return ip, now


def handle(handler, method):
    path = urlsplit(handler.path).path
    if path == PREFIX + 'session':
        head = method == 'HEAD'
        try:
            if method in ('GET', 'HEAD'):
                erp.send(handler, 200, {'unlocked': authorized(handler)}, head)
            elif method == 'POST':
                erp.same_origin(handler)
                password = erp.body(handler).get('password')
                if not isinstance(password, str) or not 1 <= len(password) <= 1024:
                    raise erp.ApiError(400, '비밀번호를 입력해주세요.')
                stored = setting()
                if not stored:
                    raise erp.ApiError(503, '지도 비밀번호 설정을 확인해주세요.')
                ip, attempt = rate_limit(handler)
                _, rounds, salt, expected = stored.split('$')
                actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(rounds)).hex()
                if not hmac.compare_digest(actual, expected):
                    raise erp.ApiError(401, '비밀번호가 올바르지 않습니다.')
                with LOCK:
                    for key in (ip, '*'):
                        if attempt in ATTEMPTS.get(key, []):
                            ATTEMPTS[key].remove(attempt)
                erp.send(handler, 200, {'unlocked': True}, cookie=cookie_header(handler, issue_cookie(), TTL))
            elif method == 'DELETE':
                erp.same_origin(handler)
                erp.send(handler, 200, {'unlocked': False}, cookie=cookie_header(handler))
            else:
                raise erp.ApiError(405, '지원하지 않는 요청입니다.')
        except erp.ApiError as error:
            erp.send(handler, error.status, {'error': error.message}, head)
        return True
    protected = path.startswith('/api/facility-projects/') or path in (erp.PREFIX + 'data', erp.PREFIX + 'residents')
    return protected and not require(handler, method == 'HEAD')


def gate_page(handler):
    raw = (Path(__file__).resolve().parent / 'facility-map-login.html').read_bytes()
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/html; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store, private')
    handler.send_header('Vary', 'Cookie')
    handler.send_header('Content-Length', str(len(raw)))
    handler.end_headers()
    return BytesIO(raw)
