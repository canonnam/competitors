"""ERP calls use test-only synthetic residents and never real credentials."""
from datetime import datetime
from http.server import ThreadingHTTPServer
import json
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import urllib.request
import urllib.error

from app import App
import facility_observation as F


ACCESS = 'synthetic-access-token-for-local-tests-only'
REFRESH = 'synthetic-refresh-token-for-local-tests-only'


def synthetic(path, access=None, body=None, timeout=15):
    if path == '/api/token/':
        if body != {'username': 'facility-demo', 'password': 'local-demo'}:
            raise F.ApiError(401, '테스트 계정 정보 오류')
        return {'access': ACCESS, 'refresh': REFRESH}
    if path == '/api/token/refresh/':
        return {'access': ACCESS, 'refresh': REFRESH}
    if access != ACCESS:
        raise F.ApiError(401, '테스트 로그인 필요')
    q = parse_qs(urlsplit(path).query)
    day = datetime.now(F.KST).date().isoformat()
    tier = q['risk_tier'][0]
    residents = ([('가상 대상 A', '201호', '1'), ('가상 대상 C', '미등록실', '1')]
                 if tier == 'focus' else [('가상 대상 B', '201', '1'), ('가상 대상 D', '501호', '5')])
    return {'results': [{'elderly_name': name, 'living_room_name': room, 'living_room_floor': floor,
                         'risk_tier': tier, 'snapshot_date': day, 'nursing_home_id': int(q['nursing_home_id'][0]),
                         'diagnosis': 'not returned', 'birth_date': 'not returned', 'elderly_id': 991}
                        for name, room, floor in residents], 'next': None}


class QuietApp(App):
    def log_message(self, *args):
        pass


class ObservationTests(unittest.TestCase):
    def setUp(self):
        F.SESSIONS.clear(); F.ATTEMPTS.clear()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), QuietApp)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.patch = patch.object(F, 'request', side_effect=synthetic)
        self.upstream = self.patch.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.patch.stop()
        F.SESSIONS.clear(); F.ATTEMPTS.clear()

    def call(self, path='session', method='GET', data=None, cookie=None, origin=None):
        headers = {'Origin': origin or self.base, 'Content-Type': 'application/json'}
        if cookie: headers['Cookie'] = cookie
        req = urllib.request.Request(self.base + F.PREFIX + path, method=method, headers=headers,
                                     data=json.dumps(data).encode() if data is not None else None)
        try: response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error: response = error
        with response:
            return response.status, response.headers, json.loads(response.read())

    def connect(self):
        code, headers, data = self.call(method='POST', data={'username': 'facility-demo', 'password': 'local-demo'})
        self.assertEqual(code, 200); self.assertEqual(data, {'connected': True})
        cookie = headers['Set-Cookie']; self.assertIn('HttpOnly', cookie); self.assertIn('SameSite=Strict', cookie)
        self.assertNotIn(ACCESS, cookie); self.assertNotIn(REFRESH, cookie)
        return cookie.split(';')[0]

    def test_anonymous_cannot_read_health_targets_and_responses_are_uncached(self):
        code, headers, data = self.call('targets?nursing_home_id=2')
        self.assertEqual(code, 401); self.assertIn('no-store', headers['Cache-Control']); self.assertNotIn('rows', data)
        self.assertEqual(self.call()[2], {'connected': False}); self.upstream.assert_not_called()

    def test_login_cookie_and_logout_do_not_expose_or_persist_credentials(self):
        cookie = self.connect(); self.assertEqual(self.call(cookie=cookie)[2], {'connected': True})
        self.assertTrue(all('password' not in s and 'username' not in s for s in F.SESSIONS.values()))
        self.assertEqual(self.call(method='DELETE', cookie=cookie)[2], {'connected': False})
        self.assertEqual(self.call('targets?nursing_home_id=2', cookie=cookie)[0], 401)

    def test_today_focus_watch_are_fresh_and_payload_excludes_other_health_fields(self):
        cookie = self.connect()
        for _ in range(2):
            code, headers, data = self.call('targets?nursing_home_id=2', cookie=cookie)
            self.assertEqual(code, 200); self.assertEqual(len(data['rows']), 4)
            self.assertEqual(data['snapshotDate'], datetime.now(F.KST).date().isoformat())
            self.assertEqual([r['risk_tier'] for r in data['rows']], ['focus', 'focus', 'watch', 'watch'])
            self.assertEqual(set(data['rows'][0]), {'elderly_name','living_room_name','living_room_floor','risk_tier','risk_tier_display'})
            self.assertIn('no-store', headers['Cache-Control'])
        self.assertEqual(self.upstream.call_count, 5)  # Login, then two real queries on every visit.

    def test_csrf_and_unregistered_branch_are_rejected(self):
        self.assertEqual(self.call(method='POST', data={}, origin='https://untrusted.example')[0], 403)
        cookie = self.connect()
        self.assertEqual(self.call('targets?nursing_home_id=1', cookie=cookie)[0], 400)
        self.assertEqual(self.call(method='DELETE', cookie=cookie, origin='https://untrusted.example')[0], 403)
        self.assertTrue(self.call(cookie=cookie)[2]['connected'])

    def test_pagination_and_same_branch_date_and_tier_are_preserved(self):
        cookie = self.connect(); first = True
        def pages(path, access=None, body=None, timeout=15):
            nonlocal first
            out = synthetic(path, access, body, timeout)
            if urlsplit(path).path == F.LIST_PATH and first:
                first = False; out['next'] = path + '&page=2'
            return out
        self.upstream.side_effect = pages
        code, _, data = self.call('targets?nursing_home_id=2', cookie=cookie)
        self.assertEqual(code, 200); self.assertEqual(len(data['rows']), 6)

    def test_cross_host_or_cross_branch_next_page_never_receives_bearer(self):
        cookie = self.connect()
        for next_page in ('https://untrusted.example/api/health-insights/snapshots/',
                          '/api/health-insights/snapshots/?nursing_home_id=3&risk_tier=focus&snapshot_date=2026-10-02'):
            with self.subTest(next_page=next_page):
                self.upstream.side_effect = lambda *args, **kwargs: {'results': [], 'next': next_page}
                before = self.upstream.call_count
                code, _, data = self.call('targets?nursing_home_id=2', cookie=cookie)
                self.assertEqual(code, 502); self.assertNotIn('rows', data)
                self.assertEqual(self.upstream.call_count, before + 1)

    def test_expired_access_refreshes_and_failed_refresh_requires_login(self):
        cookie = self.connect(); session = next(iter(F.SESSIONS.values())); session['access'] = 'expired'
        self.assertEqual(self.call('targets?nursing_home_id=2', cookie=cookie)[0], 200)
        self.assertEqual(session['access'], ACCESS)
        session['access'] = 'expired'
        def denied(path, *args, **kwargs):
            if path == '/api/token/refresh/': raise F.ApiError(401, '테스트 만료')
            return synthetic(path, *args, **kwargs)
        self.upstream.side_effect = denied
        self.assertEqual(self.call('targets?nursing_home_id=2', cookie=cookie)[0], 401)
        self.assertFalse(self.call(cookie=cookie)[2]['connected'])

    def test_branch_or_date_mismatch_and_partial_failure_never_become_zero_targets(self):
        cookie = self.connect()
        for field, value in [('nursing_home_id', 3), ('snapshot_date', '2020-01-01'), ('risk_tier', 'routine')]:
            def wrong(path, *args, **kwargs):
                out = synthetic(path, *args, **kwargs); out['results'][0][field] = value; return out
            self.upstream.side_effect = wrong
            self.assertEqual(self.call('targets?nursing_home_id=2', cookie=cookie)[0], 502)
        def partial(path, *args, **kwargs):
            if 'risk_tier=watch' in path: raise F.ApiError(502, '테스트 조회 실패')
            return synthetic(path, *args, **kwargs)
        self.upstream.side_effect = partial
        code, _, data = self.call('targets?nursing_home_id=2', cookie=cookie)
        self.assertEqual(code, 502); self.assertNotIn('rows', data)


if __name__ == '__main__':
    import sys
    if '--serve' in sys.argv:
        F.request = synthetic
        server = ThreadingHTTPServer(('127.0.0.1', 8097), QuietApp)
        print('Local synthetic ERP QA only: http://localhost:8097/facility-3d.html', flush=True)
        server.serve_forever()
    else:
        unittest.main()
