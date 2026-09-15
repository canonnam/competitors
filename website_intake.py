"""Private website inquiry inbox. The integration credential can only create records."""
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import urllib.parse
import uuid

INGEST = '/api/website-intake'
ADMIN = '/api/support/website-requests'
STATUSES = ('new', 'contacted', 'completed', 'archived')


class IntakeError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def connect():
    path = Path(os.getenv('WEBSITE_INTAKE_DB_PATH', '/data/website-intake.db'))
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=20)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    with closing(connect()) as db, db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS website_requests (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, environment TEXT NOT NULL,
            created TEXT NOT NULL, created_epoch REAL NOT NULL, client_hash TEXT NOT NULL,
            payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'new', note TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS website_requests_recent ON website_requests(created_epoch DESC);
        CREATE INDEX IF NOT EXISTS website_requests_client ON website_requests(client_hash, created_epoch);
        ''')


def validate(body):
    if not isinstance(body, dict): raise IntakeError(400, '신청 형식을 확인해 주세요.')
    try: record_id = str(uuid.UUID(body.get('id', '')))
    except (ValueError, TypeError, AttributeError): raise IntakeError(400, '접수 번호를 확인해 주세요.')
    kind, environment = body.get('kind'), body.get('environment')
    if kind not in ('visit', 'trial', 'pricing') or environment not in ('dev', 'production'):
        raise IntakeError(400, '신청 유형을 확인해 주세요.')
    client = body.get('clientHash', '')
    if not isinstance(client, str) or not re.fullmatch('[a-f0-9]{64}', client):
        raise IntakeError(400, '접수 정보를 확인해 주세요.')
    data = body.get('data')
    if not isinstance(data, dict) or data.get('privacyConsent') is not True:
        raise IntakeError(400, '개인정보 수집 동의가 필요합니다.')
    fields = ('branch', 'date', 'time', 'elderName', 'guardianName', 'guardianPhone', 'relationship', 'inquiryType') if kind == 'visit' else ('name', 'organization', 'phone')
    clean = {'privacyConsent': True}
    for key in fields:
        value = data.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > 100:
            raise IntakeError(400, '필수 입력값을 확인해 주세요.')
        clean[key] = value.strip()
    if not re.fullmatch(r'0[\d -]{8,20}', clean['guardianPhone' if kind == 'visit' else 'phone']):
        raise IntakeError(400, '연락처를 확인해 주세요.')
    if kind == 'visit':
        if clean['branch'] not in ('incheon', 'anyang'): raise IntakeError(400, '지점을 확인해 주세요.')
        try:
            datetime.strptime(clean['date'], '%Y-%m-%d')
            datetime.strptime(clean['time'], '%H:%M')
        except ValueError: raise IntakeError(400, '방문일시를 확인해 주세요.')
        message = data.get('message', '')
        if not isinstance(message, str) or len(message) > 2000: raise IntakeError(400, '문의 내용은 2,000자 이내로 입력해 주세요.')
        clean['message'] = message.strip()
    return record_id, kind, environment, client, clean


def save(body):
    record_id, kind, environment, client, clean = validate(body)
    payload = json.dumps(clean, ensure_ascii=False, sort_keys=True)
    fingerprint = hashlib.sha256(f'{kind}|{environment}|{payload}'.encode()).hexdigest()
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    with closing(connect()) as db, db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT fingerprint FROM website_requests WHERE id=?', (record_id,)).fetchone()
        if existing:
            if existing['fingerprint'] != fingerprint: raise IntakeError(409, '입력 내용이 변경되었습니다. 다시 신청해 주세요.')
            return {'id': record_id, 'received': True, 'duplicate': True}
        recent = db.execute('SELECT COUNT(*) FROM website_requests WHERE client_hash=? AND created_epoch>?', (client, time.time() - 600)).fetchone()[0]
        if recent >= 5: raise IntakeError(429, '신청 횟수가 많습니다. 10분 후 다시 시도해 주세요.')
        db.execute('INSERT INTO website_requests(id,kind,environment,created,created_epoch,client_hash,payload,fingerprint,updated) VALUES(?,?,?,?,?,?,?,?,?)',
                   (record_id, kind, environment, now, time.time(), client, payload, fingerprint, now))
    return {'id': record_id, 'received': True, 'duplicate': False}


def listing(query):
    filters, params = [], []
    for key, allowed in [('kind', ('visit', 'trial', 'pricing')), ('status', STATUSES), ('environment', ('dev', 'production'))]:
        value = query.get(key, [''])[0]
        if value:
            if value not in allowed: raise IntakeError(400, '필터를 확인해 주세요.')
            filters.append(f'{key}=?'); params.append(value)
    try: page = max(1, int(query.get('page', ['1'])[0]))
    except ValueError: raise IntakeError(400, '페이지를 확인해 주세요.')
    clause = ' WHERE ' + ' AND '.join(filters) if filters else ''
    with closing(connect()) as db:
        total = db.execute('SELECT COUNT(*) FROM website_requests' + clause, params).fetchone()[0]
        rows = db.execute('SELECT id,kind,environment,created,payload,status,note,updated FROM website_requests' + clause + ' ORDER BY created_epoch DESC LIMIT 30 OFFSET ?', [*params, (page-1)*30]).fetchall()
        counts = {row['status']: row['n'] for row in db.execute('SELECT status,COUNT(*) n FROM website_requests GROUP BY status')}
    return {'cards': [{**{k: row[k] for k in row.keys() if k != 'payload'}, 'data': json.loads(row['payload'])} for row in rows], 'total': total, 'page': page, 'counts': counts}


def update(body):
    if not isinstance(body, dict) or body.get('status') not in STATUSES or not isinstance(body.get('note', ''), str) or len(body.get('note', '')) > 2000:
        raise IntakeError(400, '처리 상태와 메모를 확인해 주세요.')
    with closing(connect()) as db, db:
        changed = db.execute('UPDATE website_requests SET status=?,note=?,updated=? WHERE id=?',
            (body['status'], body.get('note', '').strip(), datetime.now(timezone.utc).isoformat(timespec='seconds'), body.get('id'))).rowcount
        if not changed: raise IntakeError(404, '접수를 찾을 수 없습니다.')
    return {'saved': True}


def handle(handler, method):
    parts = urllib.parse.urlsplit(handler.path)
    if parts.path not in (INGEST, ADMIN, ADMIN + '/status'): return False
    import support_applications as support
    import wiki_chat
    try:
        if parts.path == INGEST:
            if method != 'POST': raise IntakeError(405, 'POST 요청만 지원합니다.')
            expected = os.getenv('WEBSITE_INTAKE_SECRET', '')
            supplied = handler.headers.get('Authorization', '').removeprefix('Bearer ')
            if not expected or not hmac.compare_digest(expected.encode(), supplied.encode()):
                raise IntakeError(401, '접수 인증에 실패했습니다.')
            result = save(wiki_chat.read_json(handler, 16000))
            status = 200 if result['duplicate'] else 201
        else:
            if not support.authenticated(handler): raise IntakeError(401, '담당자 접근 키로 로그인해 주세요.')
            if parts.path == ADMIN and method in ('GET', 'HEAD'):
                result = listing(urllib.parse.parse_qs(parts.query))
            elif parts.path == ADMIN + '/status' and method == 'POST':
                wiki_chat.check_origin(handler)
                result = update(wiki_chat.read_json(handler, 10000))
            else: raise IntakeError(405, '지원하지 않는 요청입니다.')
            status = 200
        support.send_json(handler, status, result, method == 'HEAD')
    except IntakeError as exc:
        support.send_json(handler, exc.status, {'error': exc.message}, method == 'HEAD')
    except wiki_chat.ChatError as exc:
        support.send_json(handler, exc.status, {'error': str(exc)}, method == 'HEAD')
    except (sqlite3.Error, OSError):
        support.send_json(handler, 503, {'error': '저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'}, method == 'HEAD')
    return True
