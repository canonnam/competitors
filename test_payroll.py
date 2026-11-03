"""Contract route, asset access, and client-only personal input safeguards."""
from html.parser import HTMLParser
from pathlib import Path
import http.client
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch
import app

ROOT = Path(__file__).resolve().parent

class FormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.fields = []
        self.assets = []
        self.forms = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('input', 'select', 'textarea'):
            self.fields.append(a)
        if tag == 'script' and a.get('src'):
            self.assets.append(a['src'])
        if tag == 'link' and a.get('rel') == 'stylesheet':
            self.assets.append(a['href'])
        if tag == 'form':
            self.forms.append(a)

class PayrollRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {
            app.facility_access.HASH_ENV: app.facility_access.make_password_hash('payroll-test-only'),
            'SITE_ACCESS_DB_PATH': str(Path(cls.folder.name) / 'access.db'),
            'RAILWAY_ENVIRONMENT_ID': '',
        })
        cls.environment.start()
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.App)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        connection = http.client.HTTPConnection('127.0.0.1', cls.server.server_port, timeout=5)
        try:
            connection.request('POST', '/api/site-access/session',
                               body=json.dumps({'password': 'payroll-test-only'}),
                               headers={'Content-Type': 'application/json',
                                        'Origin': f'http://127.0.0.1:{cls.server.server_port}'})
            response = connection.getresponse()
            if response.status != 200:
                raise AssertionError(f'Test login failed: {response.status}')
            cls.cookie = response.headers['Set-Cookie'].split(';')[0]
            response.read()
        finally:
            connection.close()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.environment.stop()
        cls.folder.cleanup()

    def request(self, path, method='GET', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, path, headers={'Cookie': self.cookie, **(headers or {})})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_payroll_remains_password_protected(self):
        status, _, body = self.request('/payroll.html', headers={'Cookie': ''})
        self.assertEqual(status, 200)
        self.assertIn('map-access-form', body.decode('utf-8'))
        self.assertEqual(self.request('/assets/payroll.js', headers={'Cookie': ''})[0], 401)

    def test_payroll_assets_and_no_personal_data_submission(self):
        status, headers, body = self.request('/payroll.html')
        self.assertEqual(status, 200)
        parser = FormParser()
        parser.feed(body.decode('utf-8'))
        names = {f.get('name') for f in parser.fields}
        self.assertTrue({'organization','organizationAddress','residentNumber','employee','bank','account'} <= names)
        self.assertNotIn('workplace', names)
        self.assertIn('termYears', names)
        for name in ('manualOvertime', 'manualNight', 'overtimeOrdinary', 'nightOrdinary'):
            self.assertEqual(sum(f.get('name') == name for f in parser.fields), 1)
        for name in ('overtimeOrdinary', 'nightOrdinary'):
            self.assertNotIn('checked', next(f for f in parser.fields if f.get('name') == name))
        self.assertIn('checked', next(f for f in parser.fields if f.get('name') == 'includeSeal'))
        self.assertEqual(next(f for f in parser.fields if f.get('name') == 'includeSeal')['form'], 'contract-form')
        self.assertFalse(any(f.get('type') == 'file' for f in parser.fields))
        self.assertEqual(parser.forms[0]['onsubmit'], 'return false')
        for asset in parser.assets + ['/assets/contracts/templates.json', '/assets/contracts/NanumGothic-Regular.ttf', '/assets/contracts/NanumGothic-Bold.ttf', '/assets/contracts/seal-anyang.png', '/assets/contracts/seal-incheon.png']:
            with self.subTest(asset=asset):
                self.assertEqual(self.request(asset)[0], 200)
        for branch in ('anyang', 'incheon'):
            asset = f'/assets/contracts/seal-{branch}.png'
            status, headers, body = self.request(asset)
            self.assertEqual(headers.get_content_type(), 'image/png')
            self.assertEqual(body, (ROOT/asset.lstrip('/')).read_bytes())
        self.assertEqual(self.request('/test_payroll.cjs')[0], 404)
        self.assertEqual(self.request('/assets/contracts/private.json')[0], 404)
        js = (ROOT/'assets/payroll.js').read_text(encoding='utf-8')
        for forbidden in ('localStorage','sessionStorage','sendBeacon','XMLHttpRequest','/api/','JSON.stringify(model)'):
            self.assertNotIn(forbidden, js)

if __name__ == '__main__':
    unittest.main()
