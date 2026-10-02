"""Persistent liability policies and daily aggregate-only ERP checks."""
from __future__ import annotations

import base64
from contextlib import closing
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
from urllib.parse import urlsplit

import facility_observation as erp
import wiki_chat

PREFIX = '/api/liability-insurance'
MAX_FILE = 10 * 1024 * 1024
LOCK = threading.Lock()
COLLECT_LOCK = threading.Lock()
SERVICE = {'access': '', 'refresh': '', 'lock': threading.RLock()}
LAST_STARTED = 0.0


def now():
    return datetime.now(erp.KST)


def db_path():
    return Path(os.getenv('LIABILITY_INSURANCE_DB_PATH', '/data/liability-insurance.db'))


def init_db():
    db_path().parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db_path())) as db, db:
        db.execute('''CREATE TABLE IF NOT EXISTS policies (
            branch INTEGER PRIMARY KEY, insurance_name TEXT NOT NULL,
            insured_count INTEGER NOT NULL, start_date TEXT, end_date TEXT,
            version INTEGER NOT NULL, updated_at TEXT NOT NULL)''')
        db.execute('''CREATE TABLE IF NOT EXISTS certificates (
            branch INTEGER PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL,
            content BLOB NOT NULL, uploaded_at TEXT NOT NULL)''')
        db.execute('''CREATE TABLE IF NOT EXISTS occupancy (
            branch INTEGER PRIMARY KEY, total INTEGER, checked_at TEXT,
            attempted_at TEXT NOT NULL, error TEXT, source TEXT)''')


def count(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 10000:
        raise ValueError('인원은 0~10,000 사이의 정수로 입력해주세요.')
    return value


def text(value, limit=150):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ValueError('이름의 길이와 입력 형식을 확인해주세요.')
    return value.strip()


def date(value):
    if value in (None, ''):
        return None
    if not isinstance(value, str) or len(value) != 10:
        raise ValueError('가입기간은 YYYY-MM-DD 형식으로 입력해주세요.')
    try:
        parsed = datetime.strptime(value, '%Y-%m-%d').date()
    except ValueError:
        raise ValueError('유효한 가입기간을 입력해주세요.') from None
    if parsed.isoformat() != value or not 2000 <= parsed.year <= 2100:
        raise ValueError('가입기간의 연도와 날짜를 확인해주세요.')
    return value


def certificate(value):
    if not isinstance(value, dict):
        raise ValueError('보험 증서 파일 형식을 확인해주세요.')
    filename = text(value.get('name'), 180)
    mime = value.get('type')
    encoded = value.get('data')
    if not filename or not isinstance(encoded, str) or len(encoded) > (MAX_FILE * 4 // 3 + 8):
        raise ValueError('10MB 이하의 보험 증서를 선택해주세요.')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError('보험 증서 파일을 읽지 못했습니다.') from None
    signatures = {'application/pdf': raw.startswith(b'%PDF-'), 'image/png': raw.startswith(b'\x89PNG\r\n\x1a\n'),
                  'image/jpeg': raw.startswith(b'\xff\xd8\xff'),
                  'image/webp': raw.startswith(b'RIFF') and raw[8:12] == b'WEBP'}
    if not 0 < len(raw) <= MAX_FILE or not signatures.get(mime):
        raise ValueError('10MB 이하 PDF·JPG·PNG·WEBP 파일만 업로드할 수 있습니다.')
    return filename, mime, raw


def save(branch, body):
    if not isinstance(body, dict):
        raise ValueError('저장 요청 형식을 확인해주세요.')
    name, people = text(body.get('insuranceName', '')), count(body.get('insuredCount'))
    start, end = date(body.get('startDate')), date(body.get('endDate'))
    if start and end and start > end:
        raise ValueError('가입 시작일은 만료일보다 늦을 수 없습니다.')
    version = body.get('version')
    if isinstance(version, bool) or not isinstance(version, int) or version < 0:
        raise ValueError('화면을 새로고침한 뒤 다시 저장해주세요.')
    file = certificate(body['certificate']) if 'certificate' in body else None
    stamp = now().isoformat(timespec='seconds')
    with LOCK, closing(sqlite3.connect(db_path())) as db, db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT version FROM policies WHERE branch=?', (branch,)).fetchone()
        if version != (existing[0] if existing else 0):
            raise erp.ApiError(409, '다른 화면에서 보험 정보가 변경되었습니다. 새로고침 후 확인해주세요.')
        db.execute('INSERT OR REPLACE INTO policies VALUES (?,?,?,?,?,?,?)',
                   (branch, name, people, start, end, version + 1, stamp))
        if file:
            db.execute('INSERT OR REPLACE INTO certificates VALUES (?,?,?,?,?)', (branch, *file, stamp))


def assessment(policy, occupancy, at=None):
    at = at or now()
    today = at.date()
    issues = []
    if not policy:
        issues.append({'code': 'unregistered', 'tone': 'warning', 'message': '보험 가입 인원을 등록해주세요.'})
    total = occupancy.get('total') if occupancy else None
    checked = occupancy.get('checked_at') if occupancy else None
    stale = total is None or not checked or datetime.fromisoformat(checked).astimezone(erp.KST).date() != today or bool(occupancy.get('error'))
    if stale:
        issues.append({'code': 'collection', 'tone': 'warning', 'message': '오늘 현원 확인 필요 · ' +
                       ((occupancy or {}).get('error') or ('이전 수집 결과입니다.' if checked else 'ERP 첫 수집 대기 중입니다.'))})
    difference = total - policy['insured_count'] if policy and total is not None else None
    if difference is not None and difference > 0:
        issues.append({'code': 'increase', 'tone': 'error',
                       'message': f"보험 가입 인원을 {difference}명 늘려주세요 · {policy['insured_count']}명 → {total}명" + (' (이전 현원 기준)' if stale else '')})
    remaining = None
    if policy:
        if not policy['insurance_name']:
            issues.append({'code': 'name_missing', 'tone': 'warning', 'message': '보험 이름을 등록해주세요.'})
        if not policy['start_date'] or not policy['end_date']:
            issues.append({'code': 'period_missing', 'tone': 'warning', 'message': '가입 시작일·만료일을 등록해주세요.'})
        if policy['start_date'] and policy['start_date'] > today.isoformat():
            issues.append({'code': 'not_started', 'tone': 'error', 'message': '보험 가입기간이 아직 시작되지 않았습니다.'})
        if policy['end_date']:
            remaining = (datetime.fromisoformat(policy['end_date']).date() - today).days
            if remaining < 0:
                issues.append({'code': 'expired', 'tone': 'error', 'message': f'보험이 {abs(remaining)}일 전에 만료되었습니다. 갱신해주세요.'})
            elif remaining <= 30:
                issues.append({'code': 'expiring', 'tone': 'warning', 'message': '오늘 만료됩니다. 갱신해주세요.' if remaining == 0 else f'만료 {remaining}일 전입니다. 갱신을 준비해주세요.'})
    status = 'error' if any(i['tone'] == 'error' for i in issues) else 'warning' if issues else 'success'
    return {'status': status, 'label': '양호' if status == 'success' else '조치 필요' if status == 'error' else '확인 필요',
            'issues': issues, 'difference': difference, 'daysRemaining': remaining, 'stale': stale}


def report():
    at = now()
    with closing(sqlite3.connect(db_path())) as db:
        db.row_factory = sqlite3.Row
        policies = {r['branch']: dict(r) for r in db.execute('SELECT * FROM policies')}
        occupancies = {r['branch']: dict(r) for r in db.execute('SELECT * FROM occupancy')}
        files = {r['branch']: dict(r) for r in db.execute('SELECT branch,filename,mime,uploaded_at FROM certificates')}
    branches = []
    for ident, name in erp.BRANCHES.items():
        policy, occupancy, file = policies.get(ident), occupancies.get(ident), files.get(ident)
        branches.append({'id': ident, 'name': name, **assessment(policy, occupancy, at),
                         'policy': {'insuranceName': policy['insurance_name'], 'insuredCount': policy['insured_count'],
                                    'startDate': policy['start_date'], 'endDate': policy['end_date'], 'updatedAt': policy['updated_at']} if policy else None,
                         'version': policy['version'] if policy else 0,
                         'occupancy': {'total': occupancy['total'], 'checkedAt': occupancy['checked_at'],
                                       'attemptedAt': occupancy['attempted_at'], 'error': occupancy['error'], 'source': occupancy['source']} if occupancy else None,
                         'certificate': {'name': file['filename'], 'uploadedAt': file['uploaded_at'], 'url': f'{PREFIX}/{ident}/certificate'} if file else None})
    next_check = at.replace(hour=9, minute=0, second=0, microsecond=0)
    if next_check <= at:
        next_check += timedelta(days=1)
    return {'branches': branches, 'normalCount': sum(b['status'] == 'success' for b in branches),
            'generatedAt': at.isoformat(timespec='seconds'), 'schedule': '매일 오전 9시 (한국시간)',
            'nextCheckAt': next_check.isoformat(timespec='seconds')}


def connect():
    username = os.getenv('LIABILITY_ERP_USERNAME') or os.getenv('FACILITY_ERP_USERNAME')
    password = os.getenv('LIABILITY_ERP_PASSWORD') or os.getenv('FACILITY_ERP_PASSWORD')
    if not username or not password:
        raise erp.ApiError(503, 'ERP 자동 수집 계정이 설정되지 않았습니다.')
    access, refresh = erp.token_pair(erp.request('/api/token/', body={'username': username, 'password': password}))
    SERVICE.update(access=access, refresh=refresh)


def collect_once(manual=False):
    global LAST_STARTED
    if not COLLECT_LOCK.acquire(blocking=False):
        raise erp.ApiError(429, '현원을 확인 중입니다. 잠시 후 새로고침해주세요.')
    try:
        if manual and time.monotonic() - LAST_STARTED < 60:
            raise erp.ApiError(429, '현원을 방금 확인했습니다. 1분 후 다시 확인할 수 있습니다.')
        LAST_STARTED = time.monotonic()
        for ident in erp.BRANCHES:
            stamp, result, error = now().isoformat(timespec='seconds'), None, None
            try:
                with SERVICE['lock']:
                    if not SERVICE['access']:
                        connect()
                    path = f'/api/elderly/statistics/?nursing_home={ident}'
                    def lookup():
                        try:
                            return erp.authorized(SERVICE, path, time.monotonic() + 30), 'elderly_statistics'
                        except erp.ApiError as exc:
                            if exc.status != 502:
                                raise
                            return erp.authorized(SERVICE, f'/api/dashboard/stats/{ident}/', time.monotonic() + 30), 'dashboard_stats'
                    try:
                        data, source = lookup()
                    except erp.ApiError as exc:
                        if exc.status != 401:
                            raise
                        connect()
                        data, source = lookup()
                if not isinstance(data, dict):
                    raise ValueError()
                result = count(data.get('total_elderly'))
                returned = data.get('nursing_home_id', data.get('nursing_home'))
                if returned is not None and str(returned) != str(ident):
                    raise ValueError()
            except Exception as exc:
                error = exc.message if isinstance(exc, erp.ApiError) else 'ERP 전체 현원 응답을 확인하지 못했습니다.'
            with LOCK, closing(sqlite3.connect(db_path())) as db, db:
                if error:
                    db.execute('''INSERT INTO occupancy (branch,attempted_at,error) VALUES (?,?,?)
                                  ON CONFLICT(branch) DO UPDATE SET attempted_at=excluded.attempted_at,error=excluded.error''', (ident, stamp, error))
                else:
                    db.execute('INSERT OR REPLACE INTO occupancy VALUES (?,?,?,?,NULL,?)', (ident, result, stamp, stamp, source))
    finally:
        COLLECT_LOCK.release()


def due(at=None):
    at = at or now()
    with closing(sqlite3.connect(db_path())) as db:
        rows = db.execute('SELECT checked_at,attempted_at,error FROM occupancy').fetchall()
    if len(rows) != len(erp.BRANCHES):
        return True
    for checked, attempted, error in rows:
        # Retry a failed branch hourly; successful results never become zero on error.
        if error and (at - datetime.fromisoformat(attempted)).total_seconds() < 3600:
            continue
        if error or not checked:
            return True
        checked = datetime.fromisoformat(checked).astimezone(erp.KST)
        if at.hour >= 9 and (checked.date() != at.date() or checked.hour < 9):
            return True
    return False


def start_scheduler():
    stop = threading.Event()
    def run():
        while not stop.is_set():
            try:
                if due():
                    collect_once()
            except Exception:
                # Keep the scheduler alive through a temporary database/ERP outage.
                print('Liability insurance collection will retry.', flush=True)
            stop.wait(60)
    threading.Thread(target=run, name='liability-daily-check', daemon=True).start()
    return stop


def handle(handler, method):
    route = urlsplit(handler.path).path
    if route != PREFIX and not route.startswith(PREFIX + '/'):
        return False
    head = method == 'HEAD'
    try:
        if route == PREFIX and method in ('GET', 'HEAD'):
            erp.send(handler, 200, report(), head)
        elif route == PREFIX + '/refresh' and method == 'POST':
            erp.same_origin(handler)
            collect_once(manual=True)
            erp.send(handler, 200, report())
        else:
            tail = route[len(PREFIX) + 1:].split('/')
            if not tail or tail[0] not in ('2', '3'):
                raise erp.ApiError(404, '보험 관리 지점을 찾지 못했습니다.')
            ident = int(tail[0])
            if len(tail) == 1 and method == 'POST':
                erp.same_origin(handler)
                save(ident, wiki_chat.read_json(handler, MAX_FILE * 4 // 3 + 20000))
                erp.send(handler, 200, report())
            elif tail == [str(ident), 'certificate'] and method in ('GET', 'HEAD'):
                with closing(sqlite3.connect(db_path())) as db:
                    file = db.execute('SELECT mime,content FROM certificates WHERE branch=?', (ident,)).fetchone()
                if not file:
                    raise erp.ApiError(404, '등록된 보험 증서가 없습니다.')
                handler.send_response(200)
                handler.send_header('Content-Type', file[0])
                handler.send_header('Content-Disposition', 'attachment; filename="insurance-certificate.' + {'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file[0]] + '"')
                handler.send_header('Cache-Control', 'no-store, private')
                handler.send_header('Content-Length', str(len(file[1])))
                handler.end_headers()
                if not head:
                    handler.wfile.write(file[1])
            else:
                raise erp.ApiError(405, '지원하지 않는 요청입니다.')
    except (erp.ApiError, wiki_chat.ChatError) as exc:
        erp.send(handler, exc.status, {'error': exc.message if isinstance(exc, erp.ApiError) else str(exc)}, head)
    except ValueError as exc:
        erp.send(handler, 400, {'error': str(exc)}, head)
    except (sqlite3.Error, OSError):
        erp.send(handler, 503, {'error': '보험 정보를 저장하거나 불러오지 못했습니다. 다시 시도해주세요.'}, head)
    return True
