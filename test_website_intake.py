import concurrent.futures
from contextlib import closing
import http.client
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

import app
import support_applications as support
import website_intake as intake


class WebsiteIntakeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            'WEBSITE_INTAKE_DB_PATH': self.temp.name + '/requests.db',
            'SUPPORT_DB_PATH': self.temp.name + '/support.db',
            'WEBSITE_INTAKE_SECRET': 'test-create-only', 'SUPPORT_ACCESS_KEY': 'test-operator',
        })
        self.env.start(); intake.init_db(); support.init_db()
        class QuietApp(app.App):
            def log_message(self, *args): pass
        self.server = app.ThreadingHTTPServer(('127.0.0.1', 0), QuietApp)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.env.stop(); self.temp.cleanup()

    def payload(self, kind='trial'):
        data = {'name': '가상 테스트', 'organization': '테스트 기관', 'phone': '010-0000-0000', 'privacyConsent': True}
        if kind == 'visit': data = {'branch': 'anyang', 'date': '2099-09-15', 'time': '10:00', 'elderName': '가상 어르신', 'guardianName': '가상 보호자', 'guardianPhone': '010-0000-0000', 'relationship': '자녀', 'inquiryType': '입소 상담', 'message': '<script>가상 내용</script>', 'privacyConsent': True}
        return {'id': str(uuid.uuid4()), 'kind': kind, 'environment': 'dev', 'clientHash': 'a'*64, 'data': data}

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        conn.request(method, path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json', **(headers or {})})
        response = conn.getresponse(); raw = response.read()
        result = response.status, dict(response.getheaders()), json.loads(raw) if raw and response.getheader('Content-Type', '').startswith('application/json') else raw
        conn.close(); return result

    def submit(self, body):
        return self.request('POST', intake.INGEST, body, {'Authorization': 'Bearer test-create-only'})

    def login(self):
        status, headers, _ = self.request('POST', '/api/support/login', {'key': 'test-operator'})
        self.assertEqual(status, 200)
        return {'Cookie': headers['Set-Cookie'].split(';')[0]}

    def test_authorization_boundaries(self):
        self.assertEqual(self.request('POST', intake.INGEST, self.payload())[0], 401)
        self.assertEqual(self.request('GET', intake.INGEST)[0], 405)
        for method in ('GET', 'HEAD'):
            self.assertEqual(self.request(method, intake.ADMIN)[0], 200)
            self.assertEqual(self.request(method, intake.ADMIN+'/summary')[0], 200)
        self.assertEqual(self.request('GET', '/api/support/profile')[0], 200)
        self.assertEqual(self.request('POST', intake.ADMIN+'/status', {'status':'completed'})[0], 404)
        self.assertEqual(self.request('POST', intake.ADMIN+'/status', {'status':'completed'}, {'Origin':'https://unrelated.example'})[0], 403)

    def test_validation_and_consent(self):
        for invalid in (None, [], {}, {**self.payload(), 'environment':'unknown'}):
            self.assertEqual(self.submit(invalid)[0], 400 if invalid is not None else 413)
        p = self.payload(); p['data']['privacyConsent'] = False
        self.assertEqual(self.submit(p)[0], 400)
        p = self.payload('visit'); p['data']['date'] = '2026-02-30'
        self.assertEqual(self.submit(p)[0], 400)

    def test_card_round_trip_and_persistence(self):
        ids = []
        for kind in ('visit', 'trial', 'pricing'):
            p = self.payload(kind); status, _, result = self.submit(p)
            self.assertEqual(status, 201); self.assertTrue(result['received']); ids.append(p['id'])
        intake.init_db()
        cookie = {}  # Listing, filters and updates work without a support session.
        status, headers, result = self.request('GET', intake.ADMIN, headers=cookie)
        self.assertEqual(status, 200); self.assertEqual(result['total'], 3)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertNotIn('clientHash', json.dumps(result)); self.assertNotIn('fingerprint', json.dumps(result))
        self.assertEqual(self.request('POST', intake.ADMIN+'/status', {'id':ids[0], 'status':'archived', 'note':'테스트 보관'}, cookie)[0], 200)
        filtered = self.request('GET', intake.ADMIN+'?kind=visit&status=archived&environment=dev', headers=cookie)[2]
        self.assertEqual(filtered['total'], 1); self.assertEqual(filtered['cards'][0]['note'], '테스트 보관')
        self.assertEqual(self.request('POST', intake.ADMIN+'/status', {'id':ids[0], 'status':'new'}, {**cookie,'Origin':'https://unrelated.example'})[0], 403)

    def test_idempotency_and_rate_limit(self):
        p = self.payload()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.submit(p), range(4)))
        self.assertEqual(sum(r[0] == 201 for r in results), 1)
        p['data']['name'] = '다른 내용'
        self.assertEqual(self.submit(p)[0], 409)
        for _ in range(4): self.assertEqual(self.submit(self.payload())[0], 201)
        self.assertEqual(self.submit(self.payload())[0], 429)

    def test_open_summary_is_production_only_and_contains_no_applicant_data(self):
        cookie = {}
        empty = self.request('GET', intake.ADMIN+'/summary', headers=cookie)[2]
        self.assertEqual(empty['counts'], dict.fromkeys(intake.STATUSES, 0))
        self.assertEqual(empty['total'], 0)
        self.assertIsNone(empty['lastReceivedAt'])
        for kind, state in zip(('visit', 'trial', 'pricing', 'visit'), intake.STATUSES):
            p = self.payload(kind); p['environment'] = 'production'
            self.assertEqual(self.submit(p)[0], 201)
            intake.update({'id': p['id'], 'status': state, 'note': 'PRIVATE NOTE'})
        self.assertEqual(self.submit(self.payload())[0], 201)  # Development record excluded.
        status, headers, result = self.request('GET', intake.ADMIN+'/summary', headers=cookie)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(result['counts'], dict.fromkeys(intake.STATUSES, 1))
        self.assertEqual(result['kinds'], {'visit': 2, 'trial': 1, 'pricing': 1})
        self.assertEqual(result['total'], 4)
        self.assertEqual(result['environment'], 'production')
        self.assertTrue(result['lastReceivedAt'])
        self.assertEqual(set(result), {'counts', 'kinds', 'total', 'environment', 'lastReceivedAt', 'generatedAt'})
        self.assertNotIn('가상', json.dumps(result, ensure_ascii=False))
        self.assertNotIn('PRIVATE NOTE', json.dumps(result))
        self.assertEqual(self.request('HEAD', intake.ADMIN+'/summary', headers=cookie)[2], b'')
        self.assertEqual(self.request('POST', intake.ADMIN+'/summary', {}, cookie)[0], 405)
        session = self.login()
        self.request('POST', '/api/support/logout', {}, session)
        self.assertEqual(self.request('GET', intake.ADMIN+'/summary', headers=session)[0], 200)

    def test_private_files_not_served(self):
        for path in ('/website_intake.py', '/data/website-intake.db', '/.env'):
            self.assertEqual(self.request('GET', path)[0], 404)
        self.assertEqual(self.request('GET', '/website-requests.html')[0], 200)


if __name__ == '__main__': unittest.main()
