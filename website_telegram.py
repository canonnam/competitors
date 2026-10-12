"""Server-only Telegram notifications, persisted with each new website inquiry."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid

LOG = logging.getLogger(__name__)
INBOX_URL = 'https://app.aivida.tech/website-requests.html'
KST = timezone(timedelta(hours=9))


class DeliveryError(Exception):
    """Only a safe error code is retained; Telegram URLs contain a credential."""
    def __init__(self, code, retry_after=0):
        super().__init__(code)
        self.code, self.retry_after = code, retry_after


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def credentials():
    if os.getenv('WEBSITE_TELEGRAM_ENABLED', 'true').lower() != 'true':
        return None
    token = os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
    chat_id = os.getenv('TELEGRAM_CHAT_ID', '').strip()
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', token) or not re.fullmatch(r'[1-9]\d*', chat_id):
        return None
    return token, chat_id


def init_db(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS website_telegram_outbox (
            request_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt REAL NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0,
            lease_token TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '',
            sent_at TEXT, message_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS website_telegram_due
            ON website_telegram_outbox(state,next_attempt,lease_until);
    ''')


def enqueue(db, request_id, environment):
    """Called inside the inquiry transaction. Never backfill old requests."""
    config = credentials()
    notify_dev = os.getenv('WEBSITE_TELEGRAM_NOTIFY_DEV', 'false').lower() == 'true'
    if config and (environment == 'production' or notify_dev):
        db.execute('INSERT INTO website_telegram_outbox(request_id,chat_id) VALUES(?,?)',
                   (request_id, config[1]))


def _failure(result, fallback):
    code = result.get('error_code', fallback) if isinstance(result, dict) else fallback
    parameters = result.get('parameters') if isinstance(result, dict) else None
    retry = parameters.get('retry_after', 0) if isinstance(parameters, dict) else 0
    return DeliveryError(f'telegram_{code}' if isinstance(code, int) else 'telegram_response',
                         retry if isinstance(retry, int) and retry > 0 else 0)


def api_request(token, method, body):
    request = urllib.request.Request(f'https://api.telegram.org/bot{token}/{method}',
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            result = json.loads(response.read(65536))
    except urllib.error.HTTPError as exc:
        try:
            result = json.loads(exc.read(65536))
        except (ValueError, OSError):
            result = {}
        finally:
            exc.close()
        raise _failure(result, exc.code) from None
    except (OSError, ValueError):
        raise DeliveryError('telegram_connection') from None
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise _failure(result, 'response')
    return result.get('result')


def message_text(record):
    data = json.loads(record['payload'])
    kind = {'visit': '방문상담', 'trial': '무료체험 신청', 'pricing': '비용 문의'}[record['kind']]
    if data.get('service') == 'facility-dashboard':
        kind = '대시보드 구축 신청' if record['kind'] == 'trial' else '대시보드 구축 상담'
    prefix = '[개발 사이트] ' if record['environment'] == 'dev' else ''
    received = datetime.fromisoformat(record['created']).astimezone(KST).strftime('%Y-%m-%d %H:%M')
    lines = [f'{prefix}더비다 새 상담신청', f'유형: {kind}', f'접수: {received} (한국 시간)']
    fields = (('branch', '희망 지점'), ('guardianName', '보호자'), ('guardianPhone', '연락처'),
              ('date', '희망 방문일'), ('time', '희망 시간'), ('inquiryType', '상담 유형'),
              ('name', '신청자'), ('organization', '기관명'), ('phone', '연락처'),
              ('facilityType', '시설 유형'), ('position', '직책'))
    for key, label in fields:
        value = data.get(key)
        if value:
            if key == 'branch':
                value = {'anyang': '더비다 안양점', 'incheon': '더비다 인천점'}[value]
            lines.append(f'{label}: {value}')
    if data.get('message'):
        message = data['message']
        # Leave ample room for the receipt number, even with emoji input.
        bounded = message.encode('utf-16-le')[:2400].decode('utf-16-le', errors='ignore')
        lines.extend(('', '문의 내용:', bounded + ('…' if bounded != message else '')))
    lines.extend(('', f'접수번호: {record["id"]}', INBOX_URL))
    return '\n'.join(lines)


def send_notification(token, chat_id, record):
    result = api_request(token, 'sendMessage', {
        'chat_id': chat_id, 'text': message_text(record), 'protect_content': True,
        'link_preview_options': {'is_disabled': True},
        'reply_markup': {'inline_keyboard': [[{'text': '상담신청 관리 열기', 'url': INBOX_URL}]]},
    })
    chat = result.get('chat') if isinstance(result, dict) else None
    if (not isinstance(result, dict) or not isinstance(result.get('message_id'), int)
            or not isinstance(chat, dict) or str(chat.get('id')) != chat_id):
        raise DeliveryError('telegram_response')
    return result['message_id']


def _claim(chat_id, now):
    import website_intake as intake
    with closing(intake.connect()) as db, db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('''SELECT o.request_id,o.attempts,r.id,r.kind,r.environment,r.created,r.payload
            FROM website_telegram_outbox o JOIN website_requests r ON r.id=o.request_id
            WHERE o.chat_id=? AND o.state!='sent' AND o.next_attempt<=? AND o.lease_until<=?
            ORDER BY r.created_epoch LIMIT 1''', (chat_id, now, now)).fetchone()
        if not row:
            return None
        claimed = dict(row)
        claimed['lease_token'] = uuid.uuid4().hex
        db.execute('''UPDATE website_telegram_outbox SET state='sending',attempts=attempts+1,
            lease_until=?,lease_token=? WHERE request_id=?''',
            (now + 120, claimed['lease_token'], row['request_id']))
        return claimed


def dispatch_pending(limit=10, now=None):
    """Network work runs outside SQLite transactions and outside intake requests."""
    import website_intake as intake
    config = credentials()
    result = {'sent': 0, 'failed': 0, 'retry_after': 0}
    if not config:
        return result
    token, chat_id = config
    for _ in range(limit):
        current = time.time() if now is None else now
        record = _claim(chat_id, current)
        if record is None:
            break
        try:
            message_id = send_notification(token, chat_id, record)
        except DeliveryError as exc:
            retry = max(exc.retry_after, min(3600, 30 * 2 ** min(record['attempts'], 7)))
            with closing(intake.connect()) as db, db:
                db.execute('''UPDATE website_telegram_outbox SET state='pending',next_attempt=?,
                    lease_until=0,lease_token='',error_code=? WHERE request_id=? AND lease_token=?''',
                    (current + retry, exc.code, record['request_id'], record['lease_token']))
            LOG.warning('Website Telegram delivery deferred (%s).', exc.code)
            result['failed'] += 1
            result['retry_after'] = retry
            # A rate limit or bad credential affects other pending messages too.
            break
        else:
            with closing(intake.connect()) as db, db:
                db.execute('''UPDATE website_telegram_outbox SET state='sent',sent_at=?,message_id=?,
                    lease_until=0,lease_token='',error_code='' WHERE request_id=? AND lease_token=?''',
                    (datetime.now(timezone.utc).isoformat(timespec='seconds'), message_id,
                     record['request_id'], record['lease_token']))
            result['sent'] += 1
    return result


def start_worker():
    stop = threading.Event()
    if not credentials():
        return stop
    def run():
        while not stop.is_set():
            delay = 5
            try:
                result = dispatch_pending()
                delay = max(delay, result['retry_after'])
            except (sqlite3.Error, OSError, ValueError, KeyError, TypeError):
                LOG.warning('Website Telegram worker deferred (storage_or_format).')
            stop.wait(delay)
    threading.Thread(target=run, name='website-telegram', daemon=True).start()
    return stop
