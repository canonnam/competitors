"""Private Clarity snapshots. Browser reads never consume the external API quota."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import math
import os
import re
from pathlib import Path
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo
import facility_observation as erp
import website_intake

KST = ZoneInfo('Asia/Seoul')
UTC = timezone.utc
ROOT = Path(__file__).resolve().parent
EXPORT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1'
MCP = 'https://clarity.microsoft.com/mcp/dashboard/query'
EVENTS = ('phone_click_incheon', 'phone_click_anyang', 'consultation_submitted')
LOCK = threading.Lock()
FIELDS = {
    'Traffic': ('totalSessionCount', 'totalBotSessionCount', 'distinctUserCount', 'pagesPerSessionPercentage'),
    'EngagementTime': ('totalTime', 'activeTime'), 'ScrollDepth': ('averageScrollDepth',),
    **{key: ('sessionsCount', 'sessionsWithMetricPercentage', 'pagesViews', 'subTotal') for key in
       ('DeadClickCount', 'ExcessiveScroll', 'RageClickCount', 'QuickbackClick', 'ScriptErrorCount', 'ErrorClickCount')},
    **{key: ('name', 'sessionsCount') for key in ('Browser', 'Device', 'OS', 'Country', 'ReferrerUrl')},
    'PopularPages': ('url', 'visitsCount'),
}


class CollectionError(Exception):
    pass


class QueryMismatch(CollectionError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a project token to another location.
        return None


def db_path():
    return Path(os.getenv('CLARITY_REPORT_DB_PATH', str(Path('/data' if os.getenv('RAILWAY_ENVIRONMENT_ID') else ROOT / '.local') / 'clarity-report.db')))


def connect():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=20)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    with closing(connect()) as db, db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS clarity_snapshots (day TEXT PRIMARY KEY, collected TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS clarity_attempts (at TEXT PRIMARY KEY, error TEXT NOT NULL DEFAULT '');
        ''')


def number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise CollectionError('분석 응답의 수치 형식을 확인하지 못했습니다.')
    try:
        n = float(value)
    except (ValueError, OverflowError):
        raise CollectionError('분석 응답의 수치 형식을 확인하지 못했습니다.') from None
    if not math.isfinite(n) or n < 0 or n > 2**53:
        raise CollectionError('분석 응답의 수치 범위를 확인하지 못했습니다.')
    return int(n) if n.is_integer() else n


def safe_url(value):
    parsed = urllib.parse.urlsplit(str(value))
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return ''
    # Query strings can contain form/user data; never archive or publish them.
    return urllib.parse.urlunsplit((parsed.scheme, parsed.hostname, parsed.path, '', ''))[:1000]


def normalize_metrics(data):
    if not isinstance(data, list):
        raise CollectionError('Clarity 통계 응답 형식을 확인하지 못했습니다.')
    result = {}
    for metric in data:
        if not isinstance(metric, dict) or metric.get('metricName') not in FIELDS:
            continue
        key = metric['metricName']
        rows = metric.get('information')
        if not isinstance(rows, list) or len(rows) > 1000:
            raise CollectionError('Clarity 통계 행을 확인하지 못했습니다.')
        clean = []
        for row in rows:
            if not isinstance(row, dict):
                raise CollectionError('Clarity 통계 행을 확인하지 못했습니다.')
            item = {}
            for field in FIELDS[key]:
                if field not in row:
                    continue
                if field == 'url' or (key == 'ReferrerUrl' and field == 'name' and str(row[field]).startswith(('https://', 'http://'))):
                    item[field] = safe_url(row[field])
                elif field == 'name':
                    item[field] = str(row[field])[:160]
                else:
                    item[field] = number(row[field])
            clean.append(item)
        result[key] = clean
    if not result.get('Traffic') or 'totalSessionCount' not in result['Traffic'][0]:
        raise CollectionError('방문 통계가 응답에 없습니다. 이전 결과를 유지합니다.')
    return result


def fetch_json(url, token, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
        method='POST' if body is not None else 'GET')
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=45) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise CollectionError('분석 응답이 허용 크기를 초과했습니다.')
        return json.loads(raw)
    except urllib.error.HTTPError as exc:
        messages = {401: 'Clarity 토큰 인증을 확인해 주세요.', 403: 'Clarity 조회 권한을 확인해 주세요.',
                    429: 'Clarity 조회 한도에 도달했습니다. 다음 수집 때 재시도합니다.'}
        raise CollectionError(messages.get(exc.code, 'Clarity 연결이 일시적으로 실패했습니다.')) from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError):
        raise CollectionError('Clarity 응답을 받지 못했습니다. 이전 결과를 유지합니다.') from None


def session_count(response, start=None, end=None, event=None):
    if not isinstance(response, dict) or response.get('dataErrorType') != 0:
        raise CollectionError('이벤트 분석 결과를 확인하지 못했습니다.')
    if start is not None and end is not None:
        description = response.get('query', '')
        if not isinstance(description, str):
            raise CollectionError('이벤트 조회 구간을 확인하지 못했습니다.')
        dates = {text.replace('-', '/').replace('T', ' ') for text in
                 re.findall(r'20\d\d[/-]\d\d[/-]\d\d[ T]\d\d:\d\d:\d\d', description)}
        expected = {date.strftime('%Y/%m/%d %H:%M:%S') for date in (start, end)}
        if not expected.issubset(dates) or (event and event not in description):
            raise QueryMismatch('이벤트 조회 구간·필터가 일치하지 않아 집계를 확인해야 합니다.')
    rows = response.get('data')
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise CollectionError('이벤트 세션 집계를 확인하지 못했습니다.')
    values = {str(key).lower(): value for key, value in rows[0].items()}
    if 'sessioncount' not in values:
        raise CollectionError('이벤트 세션 집계 열을 확인하지 못했습니다.')
    n = number(values['sessioncount'])
    if not isinstance(n, int):
        raise CollectionError('이벤트 세션 수가 정수가 아닙니다.')
    return n


def intake_counts(start, end):
    """Return aggregates only; no applicant details are loaded into this report."""
    counts = {'total': 0, 'visit': 0, 'trial': 0, 'pricing': 0, 'incheon': 0, 'anyang': 0}
    try:
        with closing(website_intake.connect()) as db:
            rows = db.execute('''SELECT kind, json_extract(payload, '$.branch') branch, COUNT(*) n
                FROM website_requests WHERE environment='production' AND created_epoch>=? AND created_epoch<?
                GROUP BY kind, json_extract(payload, '$.branch')''', (start.timestamp(), end.timestamp()))
            for row in rows:
                counts['total'] += row['n']
                if row['kind'] in ('visit', 'trial', 'pricing'):
                    counts[row['kind']] += row['n']
                if row['branch'] in ('incheon', 'anyang'):
                    counts[row['branch']] += row['n']
        return {'status': 'ok', **counts}
    except (sqlite3.Error, OSError):
        return {'status': 'unavailable', **dict.fromkeys(counts, None)}


def collect_once(at=None, fetch=fetch_json):
    at = (at or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    token = os.getenv('THEVIDA_BRANDSITE_CLARITY', '').strip()
    if not token:
        return False
    with LOCK:
        with closing(connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            attempts = [datetime.fromisoformat(row['at']) for row in db.execute(
                'SELECT at FROM clarity_attempts WHERE at>=?', ((at - timedelta(days=1)).isoformat(),))]
            if len(attempts) >= 3 or (attempts and (at - max(attempts)).total_seconds() < 1800):
                return False
            db.execute('INSERT INTO clarity_attempts(at) VALUES(?)', (at.isoformat(),))
        start = at - timedelta(days=1)
        try:
            metrics = normalize_metrics(fetch(EXPORT, token))
        except CollectionError as exc:
            with closing(connect()) as db, db:
                db.execute('UPDATE clarity_attempts SET error=? WHERE at=?', (str(exc), at.isoformat()))
            return False
        counts, errors = {}, {}
        for event in ('all_non_bot', *EVENTS):
            criterion = '' if event == 'all_non_bot' else f" with the exact smart event name '{event}'"
            query = (f"Count distinct non-bot sessions{criterion} across the entire project. "
                     f"Use UTC timestamps from {start.isoformat()} inclusive to {at.isoformat()} exclusive. "
                     "Return exactly one row with one integer column named SessionCount. Do not return user identifiers.")
            try:
                for query_attempt in range(2):
                    try:
                        counts[event] = session_count(fetch(MCP, token, {'query': query, 'timezone': 'UTC'}),
                            start, at, None if event == 'all_non_bot' else event)
                        break
                    except QueryMismatch:
                        # Natural-language query generation may choose another window.
                        # Retry once, but never accept an unverified count or retry HTTP limits.
                        if query_attempt:
                            raise
            except CollectionError as exc:
                counts[event], errors[event] = None, str(exc)
        # Invalid cross-query counts cannot be presented as a conversion rate.
        for event in EVENTS:
            if counts[event] is not None and counts['all_non_bot'] is not None and counts[event] > counts['all_non_bot']:
                counts[event], errors[event] = None, '조회 범위가 일치하지 않아 이벤트 집계를 확인해야 합니다.'
        payload = {'collected': at.isoformat(), 'window_start': start.isoformat(), 'window_end': at.isoformat(),
                   'metrics': metrics, 'event_sessions': counts, 'event_errors': errors,
                   'intake': intake_counts(start, at)}
        with closing(connect()) as db, db:
            db.execute('INSERT OR REPLACE INTO clarity_snapshots(day,collected,payload) VALUES(?,?,?)',
                (at.astimezone(KST).date().isoformat(), at.isoformat(), json.dumps(payload, ensure_ascii=False)))
            db.execute('UPDATE clarity_attempts SET error=? WHERE at=?',
                ('일부 이벤트 집계가 미조회 상태입니다.' if errors else '', at.isoformat()))
        return True


def due(at=None):
    at = (at or datetime.now(UTC)).astimezone(UTC)
    if not os.getenv('THEVIDA_BRANDSITE_CLARITY', '').strip():
        return False
    with closing(connect()) as db:
        last = db.execute('SELECT at,error FROM clarity_attempts ORDER BY at DESC LIMIT 1').fetchone()
    if not last:
        return True
    attempted = datetime.fromisoformat(last['at']).astimezone(KST)
    now = at.astimezone(KST)
    if (now - attempted).total_seconds() < 1800:
        return False
    if last['error']:
        return True
    scheduled = now.replace(hour=9, minute=40, second=0, microsecond=0)
    return now >= scheduled and attempted < scheduled


def insights(latest):
    if not latest:
        return []
    metrics = latest['metrics']
    rows = []
    traffic = metrics['Traffic'][0].get('totalSessionCount')
    if traffic is not None and traffic < 30:
        rows.append(f'Clarity 세션 {traffic}개로 표본이 작습니다. 며칠 더 누적한 뒤 변화 방향을 확인하세요.')
    dead_rows = metrics.get('DeadClickCount') or [{}]
    dead = dead_rows[0].get('sessionsWithMetricPercentage')
    if dead is not None and dead >= 20:
        rows.append(f'반응 없는 클릭이 있는 세션 비중은 {dead:g}%입니다. Clarity 녹화에서 버튼·링크의 반응을 확인할 후보입니다.')
    if latest['event_sessions'].get('all_non_bot') and all(latest['event_sessions'].get(key) == 0 for key in EVENTS):
        rows.append('조회된 일반 방문 세션에서 전화 클릭·상담 완료 이벤트가 확인되지 않았습니다. 상담 버튼의 위치와 안내를 점검할 수 있습니다.')
    if latest['intake']['status'] == 'ok':
        rows.append(f"같은 조회 구간의 실제 운영 홈페이지 접수는 {latest['intake']['total']}건입니다. 실제 접수 실적은 이 저장 건수를 기준으로 확인하세요.")
    return rows or ['추가 관측을 누적해 방문·상담 흐름을 비교하세요.']


def report(at=None):
    at = at or datetime.now(UTC)
    with closing(connect()) as db:
        records = db.execute('SELECT day,payload FROM clarity_snapshots ORDER BY day DESC LIMIT 30').fetchall()
        attempt = db.execute('SELECT at,error FROM clarity_attempts ORDER BY at DESC LIMIT 1').fetchone()
    latest = json.loads(records[0]['payload']) if records else None
    history = []
    for row in reversed(records):
        item = json.loads(row['payload'])
        history.append({'day': row['day'], 'collected': item['collected'], 'window_start': item['window_start'],
            'window_end': item['window_end'], 'sessions': item['metrics']['Traffic'][0].get('totalSessionCount'),
            'non_bot_sessions': item['event_sessions'].get('all_non_bot'),
            'incheon': item['event_sessions'].get('phone_click_incheon'),
            'anyang': item['event_sessions'].get('phone_click_anyang'),
            'consultation': item['event_sessions'].get('consultation_submitted'), 'intake': item['intake'].get('total')})
    next_run = at.astimezone(KST).replace(hour=9, minute=40, second=0, microsecond=0)
    if at.astimezone(KST) >= next_run:
        next_run += timedelta(days=1)
    return {'site': 'https://www.thevida.co.kr/', 'timezone': 'Asia/Seoul', 'latest': latest, 'history': history,
        'insights': insights(latest), 'sync': {'configured': bool(os.getenv('THEVIDA_BRANDSITE_CLARITY', '').strip()),
        'enabled': os.getenv('CLARITY_REPORT_SYNC_ENABLED', 'true').lower() == 'true',
        'stale': bool(latest and (at - datetime.fromisoformat(latest['collected'])).total_seconds() > 30 * 3600),
        'last_attempt': attempt['at'] if attempt else None, 'error': attempt['error'] if attempt else '',
        'next_run': next_run.isoformat()}, 'dashboard_url': 'https://clarity.microsoft.com/projects/view/yrfd5180n5/dashboard'}


def start_scheduler():
    stop = threading.Event()
    if os.getenv('CLARITY_REPORT_SYNC_ENABLED', 'true').lower() != 'true':
        return stop
    def run():
        while not stop.is_set():
            try:
                if due():
                    collect_once()
            except Exception:
                print('Clarity collection will retry; previous report retained.', flush=True)
            stop.wait(60)
    threading.Thread(target=run, name='clarity-daily-report', daemon=True).start()
    return stop


def handle(handler, method):
    if urllib.parse.urlsplit(handler.path).path != '/api/clarity-report':
        return False
    try:
        erp.send(handler, 200, report(), method == 'HEAD')
    except (sqlite3.Error, OSError, ValueError):
        erp.send(handler, 503, {'error': '홈페이지 분석 보고서를 불러오지 못했습니다.'}, method == 'HEAD')
    return True


if __name__ == '__main__':
    init_db()
    print('Clarity snapshot saved.' if collect_once() else 'No new Clarity snapshot saved.')
