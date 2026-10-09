from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import app
import clarity_report as cr
import facility_access
import website_intake

AT = datetime(2026, 10, 9, 1, 0, tzinfo=timezone.utc)
EXPORT = [
    {'metricName': 'Traffic', 'information': [{'totalSessionCount': 12, 'totalBotSessionCount': 3, 'distinctUserCount': 7}]},
    {'metricName': 'ScrollDepth', 'information': [{'averageScrollDepth': 43.5}]},
    {'metricName': 'DeadClickCount', 'information': [{'sessionsWithMetricPercentage': 25}]},
    {'metricName': 'PopularPages', 'information': [{'url': 'https://www.thevida.co.kr/contact?name=private&phone=01012345678', 'visitsCount': 3, 'private': 'secret'}]},
]


def fixture_fetch(url, token, body=None):
    if body is None:
        return EXPORT
    return {'query': body['query'], 'dataErrorType': 0, 'data': [{'SessionCount': 9 if 'smart event' not in body['query'] else 2}]}


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'THEVIDA_BRANDSITE_CLARITY': 'private-test-token',
            'CLARITY_REPORT_DB_PATH': str(root / 'report.db'), 'WEBSITE_INTAKE_DB_PATH': str(root / 'intake.db'),
            'SITE_ACCESS_DB_PATH': str(root / 'access.db'), 'CLARITY_REPORT_SYNC_ENABLED': 'false'})
        self.env.start()
        cr.init_db()
        website_intake.init_db()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_real_windows_and_aggregates_exclude_dev_and_private_fields(self):
        with closing(website_intake.connect()) as db, db:
            for ident, environment, delta in [('production', 'production', -10), ('dev', 'dev', -10), ('old', 'production', -90000)]:
                db.execute('INSERT INTO website_requests(id,kind,environment,created,created_epoch,client_hash,payload,fingerprint,updated) VALUES(?,?,?,?,?,?,?,?,?)',
                    (ident, 'visit', environment, AT.isoformat(), AT.timestamp()+delta, 'a'*64,
                     json.dumps({'branch': 'incheon', 'guardianName': 'private person', 'guardianPhone': '01012345678'}), 'hash', AT.isoformat()))
        requests = []
        def fetch(url, token, body=None):
            requests.append((url, body))
            return fixture_fetch(url, token, body)
        self.assertTrue(cr.collect_once(AT, fetch))
        result = cr.report(AT)
        latest = result['latest']
        self.assertEqual(datetime.fromisoformat(latest['window_end']) - datetime.fromisoformat(latest['window_start']), timedelta(days=1))
        self.assertEqual(latest['intake']['total'], 1)
        self.assertEqual(latest['intake']['incheon'], 1)
        self.assertEqual(latest['event_sessions']['all_non_bot'], 9)
        self.assertEqual(latest['event_sessions']['phone_click_incheon'], 2)
        self.assertEqual(len(requests), 5)
        self.assertIn('2026-10-08T01:00:00+00:00', requests[1][1]['query'])
        raw = json.dumps(result)
        for private in ('private-test-token', 'private person', '01012345678', 'guardianName', '?name='):
            self.assertNotIn(private, raw)
        cr.init_db()
        self.assertEqual(cr.report(AT)['latest'], latest)

    def test_failed_export_preserves_last_success_and_redacts_errors(self):
        cr.collect_once(AT, fixture_fetch)
        prior = cr.report(AT)['latest']
        def failure(*args):
            raise cr.CollectionError('Clarity 토큰 인증을 확인해 주세요.')
        self.assertFalse(cr.collect_once(AT+timedelta(minutes=31), failure))
        result = cr.report(AT+timedelta(hours=31))
        self.assertEqual(result['latest'], prior)
        self.assertTrue(result['sync']['stale'])
        self.assertIn('인증', result['sync']['error'])

    def test_event_errors_and_inconsistent_counts_are_unknown_not_zero(self):
        def fetch(url, token, body=None):
            if body is None:
                return EXPORT
            if 'phone_click_incheon' in body['query']:
                return {'query': body['query'], 'dataErrorType': 0, 'data': []}
            if 'phone_click_anyang' in body['query']:
                return {'query': body['query'], 'dataErrorType': 0, 'data': [{'SessionCount': 100}]}
            return fixture_fetch(url, token, body)
        self.assertTrue(cr.collect_once(AT, fetch))
        result = cr.report(AT)['latest']
        self.assertIsNone(result['event_sessions']['phone_click_incheon'])
        self.assertIsNone(result['event_sessions']['phone_click_anyang'])
        self.assertEqual(result['event_sessions']['consultation_submitted'], 2)

    def test_recent_24_hour_budget_survives_restarts_and_read_only_report(self):
        calls = []
        def fetch(*args):
            calls.append(args)
            return fixture_fetch(*args)
        self.assertTrue(cr.collect_once(AT, fetch))
        self.assertFalse(cr.collect_once(AT+timedelta(minutes=5), fetch))
        self.assertTrue(cr.collect_once(AT+timedelta(minutes=31), fetch))
        self.assertTrue(cr.collect_once(AT+timedelta(minutes=62), fetch))
        cr.init_db()
        self.assertFalse(cr.collect_once(AT+timedelta(hours=5), fetch))
        for _ in range(10):
            cr.report(AT)
        self.assertEqual(len(calls), 15)

    def test_query_mismatch_retries_once_and_never_accepts_wrong_window(self):
        calls = {}
        def fetch(url, token, body=None):
            if body is None:
                return EXPORT
            query = body['query']
            calls[query] = calls.get(query, 0) + 1
            if ('phone_click_incheon' in query and calls[query] == 1) or 'phone_click_anyang' in query:
                return {'query': 'Different dates and filter', 'dataErrorType': 0, 'data': [{'SessionCount': 0}]}
            if 'consultation_submitted' in query:
                raise cr.CollectionError('Clarity 조회 한도에 도달했습니다.')
            return fixture_fetch(url, token, body)
        self.assertTrue(cr.collect_once(AT, fetch))
        latest = cr.report(AT)['latest']
        self.assertEqual(latest['event_sessions']['phone_click_incheon'], 2)
        self.assertIsNone(latest['event_sessions']['phone_click_anyang'])
        self.assertIsNone(latest['event_sessions']['consultation_submitted'])
        self.assertEqual(sorted(calls.values()), [1, 1, 2, 2])

    def test_strict_unknown_and_zero_semantics(self):
        for n in (None, True, 'NaN', float('inf'), -1, '', [], {}):
            with self.subTest(n=n), self.assertRaises(cr.CollectionError):
                cr.number(n)
        for response in ({'dataErrorType': 1, 'data': [{'SessionCount': 0}]}, {'dataErrorType': 0, 'data': [{'SessionCount': 1.5}]}, {'dataErrorType': 0, 'data': [{'Other': 0}]}):
            with self.assertRaises(cr.CollectionError):
                cr.session_count(response)
        self.assertEqual(cr.session_count({'dataErrorType': 0, 'data': [{'SessionCount': '0'}]}), 0)
        with self.assertRaises(cr.CollectionError):
            cr.session_count({'query': 'Wrong dates', 'dataErrorType': 0, 'data': [{'SessionCount': 0}]}, AT-timedelta(days=1), AT)
        self.assertEqual(cr.safe_url('javascript:alert(1)'), '')
        empty_clicks = [*EXPORT[:1], {'metricName': 'DeadClickCount', 'information': []}]
        cr.collect_once(AT, lambda url, token, body=None: fixture_fetch(url, token, body) if body else empty_clicks)
        self.assertIsInstance(cr.report(AT)['insights'], list)

    def test_scheduler_first_run_daily_and_retry_spacing(self):
        self.assertTrue(cr.due(AT))
        cr.collect_once(AT, fixture_fetch)
        self.assertFalse(cr.due(AT+timedelta(minutes=15)))
        self.assertFalse(cr.due(AT+timedelta(hours=1)))
        self.assertTrue(cr.due(AT+timedelta(days=1)))

    def test_intake_unavailable_does_not_claim_zero(self):
        with patch.object(website_intake, 'connect', side_effect=sqlite_error()):
            result = cr.intake_counts(AT-timedelta(days=1), AT)
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(result['total'])

    def test_report_and_new_page_keep_existing_password_gate(self):
        self.env2 = patch.dict(os.environ, {'FACILITY_MAP_PASSWORD_HASH': facility_access.make_password_hash('test-clarity-password')})
        self.env2.start()
        server = ThreadingHTTPServer(('127.0.0.1', 0), app.App)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://127.0.0.1:{server.server_port}'
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(url+'/api/clarity-report')
            self.assertEqual(error.exception.code, 401)
            login = urllib.request.urlopen(url+'/clarity-report.html').read().decode()
            self.assertIn('비밀번호', login)
            cookie = facility_access.COOKIE+'='+facility_access.issue_cookie()
            for method in ('GET', 'HEAD'):
                request = urllib.request.Request(url+'/api/clarity-report', headers={'Cookie': cookie}, method=method)
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn('no-store', response.headers['Cache-Control'])
                    if method == 'HEAD':
                        self.assertEqual(response.read(), b'')
            with urllib.request.urlopen(urllib.request.Request(url+'/clarity-report.html', headers={'Cookie': cookie})) as response:
                self.assertIn('clarity-content', response.read().decode())
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(urllib.request.Request(url+'/clarity_report.py', headers={'Cookie': cookie}))
        finally:
            server.shutdown()
            server.server_close()
            self.env2.stop()


def sqlite_error():
    import sqlite3
    return sqlite3.OperationalError('database unavailable')


if __name__ == '__main__':
    unittest.main()
