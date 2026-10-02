"""Map entry and direct API requests must enforce the same server password gate."""
from http.server import ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
import json
import os
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
        self.assertEqual(self.call('/facility_access.py')[0],404)
        self.assertEqual(self.call('/facility-map-login.html')[0],404)

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
