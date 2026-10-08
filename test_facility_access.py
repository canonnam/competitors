"""Site entry and direct API/file requests enforce one server password gate."""
from http.server import ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
import json
import os
from pathlib import Path
import hashlib
import hmac
import secrets
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import facility_access as A
from test_facility_assets import QuietApp

TEST_PASSWORD = 'facility-map-demo'
TEST_HASH = A.make_password_hash(TEST_PASSWORD)


class MapAccessTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {A.HASH_ENV: TEST_HASH})
        self.env.start(); A.ATTEMPTS.clear()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), QuietApp)
        self.thread = Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.env.stop(); A.ATTEMPTS.clear()

    def call(self, path=A.PREFIX+'session', method='GET', data=None, cookie=None, origin=None):
        headers={'Origin': origin or self.base, 'Content-Type': 'application/json'}
        if cookie: headers['Cookie']=cookie
        req=Request(self.base+path, method=method, headers=headers, data=json.dumps(data).encode() if data is not None else None)
        try: response=urlopen(req, timeout=10)
        except HTTPError as error: response=error
        with response: return response.status,response.headers,response.read()

    def login(self):
        code,headers,raw=self.call(method='POST',data={'password':TEST_PASSWORD})
        self.assertEqual(code,200); self.assertEqual(json.loads(raw),{'unlocked':True})
        return headers['Set-Cookie'].split(';')[0]

    def test_direct_and_encoded_page_links_are_locked_and_data_cannot_be_bypassed(self):
        for path in ('/facility-3d.html','/facility-3d.html?shared=yes','/%66acility-3d.html','/assets/../facility-3d.html'):
            code,headers,raw=self.call(path)
            self.assertEqual(code,200); self.assertIn('no-store',headers['Cache-Control'])
            self.assertIn('map-access-form',raw.decode()); self.assertNotIn('project-select',raw.decode())
        for path in ('/api/facility-projects/','/api/facility-observation/data?nursing_home_id=2','/api/facility-observation/residents?nursing_home_id=2'):
            for method in ('GET','HEAD','POST','DELETE'):
                code,headers,raw=self.call(path,method,{} if method=='POST' else None)
                self.assertEqual(code,401); self.assertNotIn('elderly',raw.decode()); self.assertIn('no-store',headers['Cache-Control'])
        cookie=self.login()
        self.assertEqual(self.call('/facility_access.py',cookie=cookie)[0],404)
        self.assertEqual(self.call('/facility-map-login.html',cookie=cookie)[0],404)

    def test_every_html_entry_and_encoded_shared_url_requires_site_password(self):
        pages = sorted(Path(__file__).parent.glob('*.html'))
        for page in pages:
            for method in ('GET','HEAD'):
                with self.subTest(page=page.name,method=method):
                    code,headers,raw=self.call('/'+page.name+'?shared=1',method)
                    self.assertEqual(code,200)
                    self.assertIn('no-store',headers['Cache-Control'])
                    self.assertIn('Cookie',headers['Vary'])
                    if method == 'GET':
                        self.assertIn('map-access-form',raw.decode())
                        self.assertNotIn('/assets/navigation.js',raw.decode())
                    else: self.assertEqual(raw,b'')
        for path in ('/','/?category=finance','/%69ndex.html','/assets/../payroll-insurance.html',
                     '/%73upport-share.html?token=demo','/staff-eval-session.html?token=demo'):
            self.assertIn('map-access-form',self.call(path)[2].decode())

    def test_one_site_cookie_opens_every_page_and_map_without_another_password(self):
        cookie=self.login()
        for page in sorted(Path(__file__).parent.glob('*.html')):
            if page.name == 'facility-map-login.html': continue
            with self.subTest(page=page.name):
                code,headers,raw=self.call('/'+page.name+'?shared=1',cookie=cookie)
                self.assertEqual(code,200)
                self.assertNotIn('map-access-form',raw.decode())
                self.assertIn('no-store',headers['Cache-Control'])
                self.assertIn('Cookie',headers['Vary'])
                self.assertEqual(raw,page.read_bytes())

    def test_all_read_and_write_apis_are_denied_before_dispatch_without_cookie(self):
        routes = ('/api/operating-report','/api/naver-ads','/api/competitor-news',
            '/api/maps-config','/api/nearby-facilities','/api/claim-check',
            '/api/search-visibility','/api/reputation-watch','/api/agency-news',
            '/api/support/payroll-insurance','/api/support/projects',
            '/api/support/website-requests','/api/support/staff-eval',
            '/api/support/config','/api/project-share/demo', '/api/staff-eval/demo',
            '/api/facility-projects/','/api/facility-observation/data',
            '/api/liability-insurance','/api/feedback','/api/wiki-chat',
            '/%61pi/operating-report','/assets/../api/operating-report')
        for route in routes:
            for method in ('GET','HEAD','POST','DELETE'):
                with self.subTest(route=route,method=method):
                    code,headers,raw=self.call(route,method,{} if method=='POST' else None)
                    self.assertEqual(code,401)
                    self.assertIn('no-store',headers['Cache-Control'])
                    if method != 'HEAD': self.assertEqual(json.loads(raw)['code'],'site_locked')
        # Machine ingestion cannot return visitor data or bypass its own secret.
        self.assertIn(self.call('/api/website-intake','POST',{})[0],(401,503))

    def test_only_login_bootstrap_assets_are_available_without_authentication(self):
        for path in A.LOGIN_ASSETS:
            code,headers,raw=self.call('/'+path.relative_to(A.ROOT).as_posix())
            self.assertEqual(code,200)
        for path in ('/assets/navigation.js','/assets/statistics-data.js',
            '/assets/competitors-data.js','/assets/facility-3d.js',
            '/assets/facility-3d/example-floorplan.pdf',
            '/assets/contracts/templates.json','/data/statistics_knowledge.json',
            '/app.py','/.env','/assets/../app.py'):
            with self.subTest(path=path):
                self.assertEqual(self.call(path)[0],401)
        cookie=self.login()
        code,headers,raw=self.call('/assets/statistics-data.js',cookie=cookie)
        self.assertEqual(code,200)
        self.assertIn('no-store',headers['Cache-Control'])
        self.assertIn('Cookie',headers['Vary'])
        self.assertEqual(self.call('/app.py',cookie=cookie)[0],404)

    def test_legacy_map_cookie_is_rejected_and_legacy_session_issues_site_cookie(self):
        payload=f'{int(A.time.time())+A.TTL}.{secrets.token_hex(24)}'
        digest=hmac.new(TEST_HASH.encode(),('facility-map:'+payload).encode(),hashlib.sha256).hexdigest()
        old='vida_facility_map='+payload+'.'+digest
        self.assertIn('map-access-form',self.call('/',cookie=old)[2].decode())
        self.assertEqual(self.call('/api/operating-report',cookie=old)[0],401)
        code,headers,raw=self.call(A.LEGACY_PREFIX+'session','POST',{'password':TEST_PASSWORD})
        self.assertEqual(code,200)
        cookie=headers['Set-Cookie'].split(';')[0]
        self.assertTrue(cookie.startswith(A.COOKIE+'='))
        self.assertNotIn('map-access-form',self.call('/',cookie=cookie)[2].decode())

    def test_authenticated_post_cannot_be_submitted_from_another_origin(self):
        cookie=self.login()
        code,headers,raw=self.call('/api/feedback','POST',{'message':'test demo'},
                                  cookie=cookie,origin='https://other.example')
        self.assertEqual(code,403)

    def test_authenticated_api_keeps_working_and_overrides_public_cache_headers(self):
        cookie=self.login()
        for route in ('/api/operating-report','/api/nearby-facilities'):
            code,headers,raw=self.call(route,cookie=cookie)
            self.assertEqual(code,200)
            self.assertIsInstance(json.loads(raw),dict)
            self.assertIn('no-store',headers['Cache-Control'])
            self.assertIn('Cookie',headers['Vary'])

    def test_expired_cookie_locks_home_map_and_data_again(self):
        cookie=self.login()
        with patch.object(A.time,'time',return_value=A.time.time()+A.TTL+1):
            for path in ('/','/payroll-insurance.html','/facility-3d.html'):
                self.assertIn('map-access-form',self.call(path,cookie=cookie)[2].decode())
            self.assertEqual(self.call('/api/operating-report',cookie=cookie)[0],401)

    def test_correct_password_opens_page_and_cookie_survives_reconnection_without_exposing_password(self):
        cookie=self.login()
        code,headers,raw=self.call('/facility-3d.html',cookie=cookie)
        self.assertEqual(code,200); self.assertIn('project-select',raw.decode()); self.assertNotIn('map-access-form',raw.decode())
        self.assertIn('no-store',headers['Cache-Control']); self.assertNotIn(TEST_PASSWORD,cookie)
        self.assertEqual(json.loads(self.call(cookie=cookie)[2]),{'unlocked':True})
        header=A.cookie_header(SimpleNamespace(headers={'Host':'app.aivida.tech'}),A.issue_cookie(),A.TTL)
        for word in ('HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=86400'): self.assertIn(word,header)
        self.assertEqual(self.call(method='DELETE',cookie=cookie)[0],200)
        self.assertEqual(json.loads(self.call()[2]),{'unlocked':False})

    def test_wrong_password_and_csrf_never_unlock_and_repeated_failures_are_limited(self):
        self.assertEqual(self.call(method='POST',data={'password':TEST_PASSWORD},origin='https://other.example')[0],403)
        for _ in range(5): self.assertEqual(self.call(method='POST',data={'password':'wrong'})[0],401)
        self.assertEqual(self.call(method='POST',data={'password':TEST_PASSWORD})[0],429)
        with patch.object(A.time,'time',return_value=A.time.time()+301):
            self.assertEqual(self.call(method='POST',data={'password':TEST_PASSWORD})[0],200)

    def test_forgery_expiry_changed_password_and_missing_configuration_fail_closed(self):
        token=A.issue_cookie()
        def valid(value): return A.authorized(SimpleNamespace(headers={'Cookie':A.COOKIE+'='+value}))
        self.assertTrue(valid(token)); self.assertFalse(valid(token[:-1]+('0' if token[-1]!='0' else '1')))
        with patch.object(A.time,'time',return_value=A.time.time()+A.TTL+1): self.assertFalse(valid(token))
        with patch.dict(os.environ,{A.HASH_ENV:A.make_password_hash('changed')}): self.assertFalse(valid(token))
        with patch.dict(os.environ,{A.HASH_ENV:''}):
            self.assertFalse(valid(token)); self.assertEqual(self.call(method='POST',data={'password':TEST_PASSWORD})[0],503)


if __name__=='__main__': unittest.main()
