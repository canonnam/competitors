"""Site-wide password gate, reusing the map's server-only password hash."""
from http.cookies import SimpleCookie, CookieError
from io import BytesIO
from pathlib import Path
from contextlib import closing
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import urlsplit
import facility_observation as erp

PREFIX = '/api/site-access/'
LEGACY_PREFIX = '/api/facility-map-access/'
COOKIE = 'vida_knowledge_access'
TTL = 24 * 60 * 60
HASH_ENV = 'FACILITY_MAP_PASSWORD_HASH'
ROOT = Path(__file__).resolve().parent
LOGIN_ASSETS = {
    ROOT / 'favicon.ico', ROOT / 'robots.txt',
    ROOT / 'assets' / 'ui-foundation.css',
    ROOT / 'assets' / 'site-access.css',
    ROOT / 'assets' / 'facility-map-login.js',
}
MAX_FAILURES = 10
LOCK_SECONDS = 60 * 60
VERIFY_SLOTS = threading.BoundedSemaphore(4)


class LoginError(erp.ApiError):
    def __init__(self, status, message, retry_after=0, remaining=None, code=''):
        super().__init__(status, message)
        self.retry_after, self.remaining, self.code = retry_after, remaining, code


def make_password_hash(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600000).hex()
    return f'pbkdf2_sha256$600000${salt}${digest}'


def setting():
    value = os.getenv(HASH_ENV, '')
    return value if re.fullmatch(r'pbkdf2_sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}', value) else ''


def signature(value):
    # A new scope invalidates previously issued map-only cookies at rollout.
    return hmac.new(setting().encode(), ('knowledge-site:' + value).encode(), hashlib.sha256).hexdigest()


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
    erp.send(handler, 401, {'error': '지식 창고 비밀번호 인증이 필요합니다.', 'code': 'site_locked'}, head)
    return False


def client_key(handler):
    address = handler.client_address[0]
    if os.getenv('RAILWAY_ENVIRONMENT_ID'):
        # Railway appends the verified remote IP; never trust the leftmost value.
        # Read all header lines so a duplicate user header cannot take precedence.
        for name in ('X-Forwarded-For', 'X-Real-IP'):
            values = handler.headers.get_all(name, []) if hasattr(handler.headers, 'get_all') else [handler.headers.get(name, '')]
            value = ','.join(values).split(',')[-1].strip()
            if value:
                try:
                    address = str(ipaddress.ip_address(value))
                    break
                except ValueError:
                    continue
    address = ipaddress.ip_address(address)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return hmac.new(setting().encode(), ('site-login-ip:' + str(address)).encode(), hashlib.sha256).hexdigest()


def attempt_store():
    default = '/data/site-access.db' if os.getenv('RAILWAY_ENVIRONMENT_ID') else ROOT / '.local' / 'site-access.db'
    path = Path(os.getenv('SITE_ACCESS_DB_PATH') or default)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    try:
        db.execute('''CREATE TABLE IF NOT EXISTS login_attempts (
            client TEXT PRIMARY KEY, failures INTEGER NOT NULL,
            locked_until REAL NOT NULL DEFAULT 0)''')
        db.commit()
        return db
    except Exception:
        db.close()
        raise


def blocked(retry_after):
    seconds = max(1, math.ceil(retry_after))
    raise LoginError(429, f'비밀번호 10회 오류로 로그인이 1시간 동안 제한되었습니다. 약 {math.ceil(seconds / 60)}분 후 다시 시도해주세요.',
                     retry_after=seconds, code='login_temporarily_blocked')


def check_attempt(key):
    with closing(attempt_store()) as db:
        row = db.execute('SELECT locked_until FROM login_attempts WHERE client=?', (key,)).fetchone()
        now = time.time()
        if row and row[0] > now:
            blocked(row[0] - now)


def record_attempt(key, correct):
    # Serialize the final decision across threads/processes. A success that races
    # with the tenth failure cannot clear a lock that has already started.
    with closing(attempt_store()) as db, db:
        db.execute('BEGIN IMMEDIATE')
        now = time.time()
        row = db.execute('SELECT failures, locked_until FROM login_attempts WHERE client=?', (key,)).fetchone()
        if row and row[1] > now:
            retry_after = row[1] - now
            remaining = 0
        else:
            failures = row[0] if row and not row[1] else 0
            if correct:
                db.execute('DELETE FROM login_attempts WHERE client=?', (key,))
                retry_after, remaining = 0, MAX_FAILURES
            else:
                failures += 1
                until = now + LOCK_SECONDS if failures >= MAX_FAILURES else 0
                db.execute('''INSERT INTO login_attempts(client, failures, locked_until) VALUES(?,?,?)
                    ON CONFLICT(client) DO UPDATE SET failures=excluded.failures, locked_until=excluded.locked_until''',
                           (key, failures, until))
                retry_after, remaining = max(0, until - now), max(0, MAX_FAILURES - failures)
    # Raise after the transaction commits, so the tenth failure's lock persists.
    if retry_after:
        blocked(retry_after)
    if not correct:
        raise LoginError(401, f'비밀번호가 올바르지 않습니다. 남은 시도는 {remaining}회입니다.',
                         remaining=remaining, code='incorrect_password')


def verify_password(handler, password, stored):
    key = client_key(handler)
    check_attempt(key)
    if not VERIFY_SLOTS.acquire(blocking=False):
        raise LoginError(429, '로그인 요청이 많습니다. 잠시 후 다시 시도해주세요.', retry_after=1, code='login_busy')
    try:
        # Recheck after acquiring a verification slot, before expensive hashing.
        check_attempt(key)
        _, rounds, salt, expected = stored.split('$')
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(rounds)).hex()
        record_attempt(key, hmac.compare_digest(actual, expected))
    finally:
        VERIFY_SLOTS.release()


def send_session_error(handler, error, head=False):
    payload = {'error': error.message}
    if isinstance(error, LoginError):
        if error.code:
            payload['code'] = error.code
        if error.remaining is not None:
            payload['remainingAttempts'] = error.remaining
        if error.retry_after:
            payload['retryAfter'] = error.retry_after
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    handler.send_response(error.status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store, private')
    handler.send_header('Vary', 'Cookie')
    handler.send_header('Content-Length', str(len(raw)))
    if isinstance(error, LoginError) and error.retry_after:
        handler.send_header('Retry-After', str(error.retry_after))
    handler.end_headers()
    if not head:
        handler.wfile.write(raw)


def handle(handler, method):
    path = urlsplit(handler.path).path
    handler._site_access_protected = True
    handler._site_cache_sent = False
    handler._site_vary_sent = False
    if path in (PREFIX + 'session', LEGACY_PREFIX + 'session'):
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
                    raise erp.ApiError(503, '지식 창고 비밀번호 설정을 확인해주세요.')
                verify_password(handler, password, stored)
                erp.send(handler, 200, {'unlocked': True}, cookie=cookie_header(handler, issue_cookie(), TTL))
            elif method == 'DELETE':
                erp.same_origin(handler)
                erp.send(handler, 200, {'unlocked': False}, cookie=cookie_header(handler))
            else:
                raise erp.ApiError(405, '지원하지 않는 요청입니다.')
        except erp.ApiError as error:
            send_session_error(handler, error, head)
        except (sqlite3.Error, OSError):
            send_session_error(handler, erp.ApiError(503, '로그인 보호 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'), head)
        return True
    # Machine ingestion keeps its existing Bearer-secret check in website_intake.
    if path == '/api/website-intake' and method == 'POST':
        return False
    resolved = Path(handler.translate_path(handler.path)).resolve()
    if method in ('GET', 'HEAD') and resolved in LOGIN_ASSETS:
        handler._site_access_protected = False
        return False
    if authorized(handler):
        if method not in ('GET', 'HEAD'):
            try:
                erp.same_origin(handler)
            except erp.ApiError:
                erp.send(handler, 403, {'error': '지식 창고에서 다시 시도해주세요.'})
                return True
        return False
    # Preserve the requested URL. API and file requests never receive HTML data.
    relative = resolved.relative_to(ROOT) if resolved.is_relative_to(ROOT) else None
    api = relative is not None and relative.parts and relative.parts[0] == 'api'
    hidden = relative is not None and any(part.startswith('.') for part in relative.parts)
    if method in ('GET', 'HEAD') and not api and not hidden and resolved.suffix.lower() in ('', '.html'):
        with gate_page(handler) as page:
            if method == 'GET':
                handler.wfile.write(page.read())
        return True
    return not require(handler, method == 'HEAD')


def gate_page(handler):
    raw = (Path(__file__).resolve().parent / 'facility-map-login.html').read_bytes()
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/html; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store, private')
    handler.send_header('Vary', 'Cookie')
    handler.send_header('Content-Length', str(len(raw)))
    handler.end_headers()
    return BytesIO(raw)
