"""Synthetic ERP data exercises month boundaries, pagination and private-data minimization."""
from datetime import datetime
from http.server import ThreadingHTTPServer
from threading import Thread
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import json
import os
import unittest
import facility_access as A
import facility_observation as E
import resident_movement as M
from test_facility_assets import QuietApp

NOW = datetime(2026, 10, 8, 16, tzinfo=E.KST)


def synthetic(path, access=None, body=None, timeout=15):
    url = urlsplit(path)
    if url.path == '/api/token/':
        return {'access': 'synthetic-access-123456789', 'refresh': 'synthetic-refresh-123456789'}
    if url.path == '/api/token/refresh/':
        return {'access': 'synthetic-refreshed-123456789'}
    ident = int(parse_qs(url.query)['nursing_home'][0])
    if url.path == '/api/elderly/list/':
        assert parse_qs(url.query)['date'] == ['2026-01-01']
        return [{'id': 101, 'nursing_home': ident, 'name': 'PRIVATE-BASELINE'},
                {'id': 102, 'nursing_home': ident}]
    if url.path == '/api/elderly/':
        assert parse_qs(url.query)['status'] == ['all']
        if 'page=2' in url.query:
            return {'results': [{'id': 4, 'nursing_home': ident, 'admission_date': None}], 'next': None}
        return {'results': [
            {'id': 1, 'nursing_home': ident, 'admission_date': '2026-09-30T14:59:59Z', 'name': 'PRIVATE-NAME'},
            {'id': 2, 'nursing_home': ident, 'admission_date': '2026-09-30T15:00:00Z', 'status': 'discharged'},
            {'id': 3, 'nursing_home': ident, 'admission_date': '2026-09-05', 'is_deleted': True},
            {'id': 5, 'nursing_home': ident, 'admission_date': '2026-11-01'},
        ], 'next': f'/api/elderly/?nursing_home={ident}&status=all&page=2'}
    if url.path == '/api/discharge-records/':
        return [
            {'id': 10, 'elderly': 2, 'nursing_home': ident, 'discharge_date': '2026-09-01'},
            {'id': 11, 'elderly': 2, 'nursing_home': ident, 'discharge_date': '2026-09-30'},
            {'id': 12, 'elderly': {'id': 2}, 'discharge_date': '2026-09-30T15:00:00Z'},
            {'id': 13, 'elderly': 1, 'discharge_date': '2026-09-20', 'deleted_at': '2026-09-21'},
        ]
    raise AssertionError('unexpected ERP path')


class MovementTests(unittest.TestCase):
    def setUp(self):
        M.STATE.clear(); M.SERVICE.update(access='', refresh='')
        self.env = patch.dict(os.environ, {'FACILITY_ERP_USERNAME': 'synthetic-user', 'FACILITY_ERP_PASSWORD': 'synthetic-password'})
        self.env.start()
        self.clock = patch.object(M, 'now', return_value=NOW); self.clock.start()
        self.upstream = patch.object(E, 'request', side_effect=synthetic).start()

    def tearDown(self):
        patch.stopall(); self.env.stop(); M.STATE.clear(); M.SERVICE.update(access='', refresh='')

    def test_seoul_month_boundaries_all_status_deleted_future_and_unique_people(self):
        M.collect_once()
        for branch in M.report()['branches']:
            self.assertFalse(branch['stale'])
            self.assertEqual(branch['months'], [{'month': '2026-09', 'admitted': 1, 'discharged': 1},
                                               {'month': '2026-10', 'admitted': 1, 'discharged': 1}])
            self.assertEqual(branch['missingAdmissionDates'], 1)
            self.assertEqual(branch['yearStarts'], [{'year': 2026, 'date': '2026-01-01', 'occupancy': 2, 'error': None}])
        raw = json.dumps(M.STATE)
        self.assertNotIn('PRIVATE-NAME', raw); self.assertNotIn('PRIVATE-BASELINE', raw)
        self.assertNotIn('elderly', raw); self.assertNotIn('admission_date', raw)
        self.assertEqual(M.month_key('2026-09-30T23:30:00-07:00', NOW.date()), '2026-10')
        self.assertEqual(M.month_key('2026-09-30T23:30:00', NOW.date()), '2026-09')
        with self.assertRaises(E.ApiError): M.month_key('2026-02-30', NOW.date())

    def test_failures_keep_previous_counts_and_other_branch_can_update(self):
        M.collect_once(); before = M.report()['branches'][0]
        def failure(path, *args, **kwargs):
            if 'nursing_home=2' in path: raise E.ApiError(502, '합성 조회 실패')
            return synthetic(path, *args, **kwargs)
        self.upstream.side_effect = failure; M.collect_once()
        first, second = M.report()['branches']
        self.assertTrue(first['stale']); self.assertEqual(first['months'], before['months'])
        self.assertEqual(first['checkedAt'], before['checkedAt']); self.assertFalse(second['stale'])
        M.STATE.clear(); M.collect_once()
        self.assertIsNone(M.report()['branches'][0]['months'])

    def test_pagination_rejects_changed_host_branch_status_and_repeated_rows(self):
        for next_url in ['https://example.com/api/elderly/?nursing_home=2&status=all',
                         '/api/elderly/?nursing_home=3&status=all', '/api/elderly/?nursing_home=2&status=active',
                         '/api/elderly/?nursing_home=2&status=all']:
            def bad(path, *args, **kwargs):
                result = synthetic(path, *args, **kwargs)
                if urlsplit(path).path == '/api/elderly/': result['next'] = next_url
                return result
            self.upstream.side_effect = bad; M.STATE.clear(); M.collect_once()
            self.assertIsNone(M.report()['branches'][0]['months'])
        self.upstream.side_effect = lambda path,*a,**k: [{'id': 1,'admission_date':'2026-09-01'},{'id':1,'admission_date':'2026-09-02'}]
        with self.assertRaises(E.ApiError): list(M.rows(2, '/api/elderly/', 'all'))

    def test_missing_discharge_identity_date_and_mismatched_branch_are_not_zero(self):
        for bad_row in [{'id': 20, 'elderly': None, 'discharge_date': '2026-09-01'},
                        {'id': 20, 'elderly': 2},
                        {'id': 20, 'elderly': 2, 'discharge_date': '2026-09-01', 'nursing_home': 3}]:
            def bad(path,*a,**k):
                return [bad_row] if urlsplit(path).path == '/api/discharge-records/' else synthetic(path,*a,**k)
            self.upstream.side_effect = bad; M.STATE.clear(); M.collect_once()
            self.assertIsNone(M.report()['branches'][0]['months'])

    def test_expired_tokens_relogin_and_successfully_empty_lists_are_known_zero(self):
        M.SERVICE.update(access='expired', refresh='expired-refresh')
        def expired(path,access=None,body=None,timeout=15):
            if path == '/api/token/refresh/' or access == 'expired': raise E.ApiError(401, '합성 만료')
            if urlsplit(path).path in ('/api/elderly/', '/api/discharge-records/'): return []
            return synthetic(path,access,body,timeout)
        self.upstream.side_effect = expired; M.collect_once()
        self.assertFalse(M.report()['branches'][0]['stale'])
        self.assertEqual(M.report()['branches'][0]['months'], [])

    def test_year_start_failure_keeps_counts_and_zero_baseline_is_valid(self):
        def lookup(path, *args, **kwargs):
            if urlsplit(path).path == '/api/elderly/list/':
                if 'nursing_home=2' in path: raise E.ApiError(502, '합성 기준 현원 조회 실패')
                return []
            return synthetic(path, *args, **kwargs)
        self.upstream.side_effect = lookup; M.collect_once()
        first, second = M.report()['branches']
        self.assertFalse(first['stale']); self.assertEqual(len(first['months']), 2)
        self.assertIsNone(first['yearStarts'][0]['occupancy']); self.assertTrue(first['yearStarts'][0]['error'])
        self.assertEqual(second['yearStarts'][0]['occupancy'], 0); self.assertIsNone(second['yearStarts'][0]['error'])

    def test_year_start_pagination_retains_date_and_collects_each_observed_year(self):
        requested = []
        def lookup(path, *args, **kwargs):
            url = urlsplit(path); query = parse_qs(url.query)
            if url.path == '/api/elderly/':
                return [{'id': 1, 'admission_date': '2025-12-01'}]
            if url.path == '/api/elderly/list/':
                date, ident = query['date'][0], query['nursing_home'][0]
                requested.append((ident, date))
                if query.get('page') == ['2']: return {'results': [{'id': 102}], 'next': None}
                return {'results': [{'id': 101}], 'next': f'/api/elderly/list/?nursing_home={ident}&date={date}&page=2'}
            return synthetic(path, *args, **kwargs)
        self.upstream.side_effect = lookup; M.collect_once()
        for branch in M.report()['branches']:
            self.assertEqual([s['year'] for s in branch['yearStarts']], [2025, 2026])
            self.assertTrue(all(s['occupancy'] == 2 for s in branch['yearStarts']))
        self.assertIn(('2','2025-01-01'), requested)
        self.upstream.side_effect = lambda *a, **k: {'results': [], 'next': '/api/elderly/list/?nursing_home=2&date=2026-01-02'}
        with self.assertRaises(E.ApiError): list(M.rows(2, '/api/elderly/list/', date='2026-01-01'))

    def test_authenticated_http_reads_only_cached_aggregates_and_head_has_no_body(self):
        M.collect_once(); calls = self.upstream.call_count
        with patch.dict(os.environ, {A.HASH_ENV: A.make_password_hash('synthetic-site-password')}):
            cookie = A.COOKIE + '=' + A.issue_cookie()
            server = ThreadingHTTPServer(('127.0.0.1',0), QuietApp)
            thread = Thread(target=server.serve_forever,daemon=True); thread.start()
            url = f'http://127.0.0.1:{server.server_port}{M.PREFIX}'
            try:
                with self.assertRaises(HTTPError) as error: urlopen(url)
                self.assertEqual(error.exception.code, 401)
                for method in ('GET','HEAD'):
                    with urlopen(Request(url,method=method,headers={'Cookie':cookie})) as response:
                        self.assertEqual(response.status,200); self.assertIn('no-store',response.headers['Cache-Control'])
                        raw=response.read()
                        if method=='GET': self.assertEqual(json.loads(raw)['timeZone'],'Asia/Seoul')
                        else: self.assertEqual(raw,b'')
                self.assertEqual(calls,self.upstream.call_count)
            finally: server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
