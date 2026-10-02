"""Coverage mismatch, expiry, daily scheduling and durable certificate boundaries."""
import base64
from contextlib import closing
from datetime import datetime, timedelta
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
import json
import urllib.error
import urllib.request

import liability_insurance as li
import app

AT = datetime(2026, 10, 2, 10, tzinfo=li.erp.KST)


class LiabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {'LIABILITY_INSURANCE_DB_PATH': str(Path(self.temp.name) / 'li.db')})
        env.start(); self.addCleanup(env.stop)
        li.init_db()
        self.policy = {'insurance_name': '배상책임보험', 'insured_count': 34, 'start_date': '2026-01-01', 'end_date': '2027-01-01'}
        self.occupancy = {'total': 34, 'checked_at': AT.isoformat(), 'error': None}

    def result(self, policy=None, occupancy=None, at=None):
        return li.assessment(policy or self.policy, occupancy or self.occupancy, at or AT)

    def test_equal_increase_decrease_and_zero(self):
        self.assertEqual(self.result()['status'], 'success')
        increase = self.result(occupancy={**self.occupancy, 'total': 38})
        self.assertEqual(increase['status'], 'error'); self.assertEqual(increase['difference'], 4)
        self.assertIn('늘려주세요', increase['issues'][0]['message'])
        decrease = self.result(occupancy={**self.occupancy, 'total': 30})
        self.assertEqual(decrease['status'], 'success'); self.assertEqual(decrease['difference'], -4)
        self.assertEqual(decrease['label'], '양호'); self.assertEqual(decrease['issues'], [])
        expired_excess = self.result(policy={**self.policy, 'insured_count': 35, 'end_date': '2026-10-01'})
        self.assertEqual(expired_excess['status'], 'error')
        self.assertEqual(self.result(policy={**self.policy, 'insured_count': 0}, occupancy={**self.occupancy, 'total': 0})['status'], 'success')

    def test_expiry_and_future_period_boundaries(self):
        for days, status in ((31, 'success'), (30, 'warning'), (1, 'warning'), (0, 'warning'), (-1, 'error')):
            with self.subTest(days=days):
                result = self.result(policy={**self.policy, 'end_date': (AT.date() + timedelta(days=days)).isoformat()})
                self.assertEqual(result['status'], status); self.assertEqual(result['daysRemaining'], days)
        self.assertEqual(self.result(policy={**self.policy, 'start_date': '2026-10-03'})['status'], 'error')
        self.assertEqual(self.result(policy={**self.policy, 'end_date': None})['status'], 'warning')

    def test_unknown_stale_failed_or_unregistered_is_never_normal(self):
        self.assertNotEqual(li.assessment(None, None, AT)['status'], 'success')
        for override in ({'checked_at': (AT-timedelta(days=1)).isoformat()}, {'total': None}, {'total': None, 'checked_at': None}, {'error': '연결 실패'}):
            result = self.result(occupancy={**self.occupancy, **override})
            self.assertTrue(result['stale']); self.assertNotEqual(result['status'], 'success')

    def body(self, **kw):
        return {'insuranceName': '배상책임보험', 'insuredCount': 34, 'startDate': '2026-01-01', 'endDate': '2027-01-01', 'version': 0, **kw}

    def test_atomic_durable_certificate_branch_separation_and_version(self):
        cert = {'name': '증서.pdf', 'type': 'application/pdf', 'data': base64.b64encode(b'%PDF-1.7\nexample').decode()}
        li.save(2, self.body(certificate=cert))
        first = li.report()['branches']; self.assertEqual(first[0]['version'], 1); self.assertIsNone(first[1]['policy'])
        self.assertEqual(first[0]['certificate']['name'], '증서.pdf')
        li.init_db(); self.assertEqual(li.report()['branches'][0]['policy']['insuredCount'], 34)
        with self.assertRaises(li.erp.ApiError): li.save(2, self.body(insuredCount=38))
        li.save(2, self.body(version=1, insuredCount=35)); self.assertEqual(li.report()['branches'][0]['certificate']['name'], '증서.pdf')
        with self.assertRaises(ValueError): li.save(2, self.body(version=2, insuredCount=40, certificate={**cert, 'data': 'broken'}))
        self.assertEqual(li.report()['branches'][0]['policy']['insuredCount'], 35)

    def test_validation_and_missing_period_are_safe(self):
        for bad in (True, -1, 1.5, '34', 10001):
            with self.assertRaises(ValueError): li.save(2, self.body(insuredCount=bad))
        for bad in ('2026-02-30', '2026-2-02', '1900-01-01'):
            with self.assertRaises(ValueError): li.save(2, self.body(startDate=bad))
        with self.assertRaises(ValueError): li.save(2, self.body(startDate='2028-01-01'))
        li.save(2, self.body(insuranceName='', startDate='', endDate=''))
        self.assertEqual(li.report()['branches'][0]['status'], 'warning')

    def test_erp_fallback_failures_keep_last_good_count_and_zero(self):
        def primary_error(service, path, deadline):
            if 'statistics' in path: raise li.erp.ApiError(502, '서버 오류')
            return {'total_elderly': 0 if '/2/' in path else 38}
        with patch.object(li, 'connect'), patch.object(li.erp, 'authorized', side_effect=primary_error), patch.object(li, 'now', return_value=AT):
            li.collect_once()
        result=li.report()['branches']; self.assertEqual(result[0]['occupancy']['total'], 0); self.assertEqual(result[1]['occupancy']['total'], 38)
        self.assertEqual(result[0]['occupancy']['source'], 'dashboard_stats')
        with patch.object(li, 'connect'), patch.object(li.erp, 'authorized', side_effect=li.erp.ApiError(403, '권한 없음')):
            li.collect_once()
        result=li.report()['branches']; self.assertEqual(result[1]['occupancy']['total'], 38); self.assertTrue(result[1]['stale'])
        with patch.object(li, 'connect'), patch.object(li.erp, 'authorized', return_value={'total_elderly': True}): li.collect_once()
        self.assertEqual(li.report()['branches'][1]['occupancy']['total'], 38)

    def test_daily_kst_schedule_and_hourly_error_retry(self):
        self.assertTrue(li.due(AT))
        with patch.object(li, 'connect'), patch.object(li.erp, 'authorized', return_value={'total_elderly': 34}), patch.object(li, 'now', return_value=AT): li.collect_once()
        self.assertFalse(li.due(AT)); self.assertTrue(li.due(AT+timedelta(days=1)))
        self.assertFalse(li.due((AT+timedelta(days=1)).replace(hour=8)))
        early=AT.replace(hour=8)
        with closing(sqlite3.connect(li.db_path())) as db, db: db.execute('UPDATE occupancy SET checked_at=?', (early.isoformat(),))
        self.assertFalse(li.due(early)); self.assertTrue(li.due(AT.replace(hour=9)))
        with closing(sqlite3.connect(li.db_path())) as db, db: db.execute('UPDATE occupancy SET error=?,attempted_at=?', ('失敗', AT.isoformat()))
        self.assertFalse(li.due(AT+timedelta(minutes=59))); self.assertTrue(li.due(AT+timedelta(hours=1)))

    def test_unauthorized_reconnect_and_branch_mismatch(self):
        calls = iter([li.erp.ApiError(401, '만료'), {'total_elderly': 34}, {'total_elderly': 38, 'nursing_home_id': 2}])
        def response(*args):
            value=next(calls)
            if isinstance(value, Exception): raise value
            return value
        with patch.object(li, 'connect') as connect, patch.object(li.erp, 'authorized', side_effect=response): li.collect_once()
        self.assertTrue(connect.called)
        result=li.report()['branches']; self.assertEqual(result[0]['occupancy']['total'], 34); self.assertIsNone(result[1]['occupancy']['total'])

    def test_http_save_download_cross_origin_and_branch_boundaries(self):
        server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        origin=f'http://127.0.0.1:{server.server_port}'
        cert={'name':'test.pdf','type':'application/pdf','data':base64.b64encode(b'%PDF-1.7\ntest').decode()}
        def post(path, data, source=origin):
            return urllib.request.urlopen(urllib.request.Request(origin+path,data=json.dumps(data).encode(),headers={'Origin':source,'Content-Type':'application/json'}))
        with post(li.PREFIX+'/2',self.body(certificate=cert)) as response:
            self.assertEqual(json.load(response)['branches'][0]['version'],1)
        with urllib.request.urlopen(origin+li.PREFIX+'/2/certificate') as response:
            self.assertEqual(response.read(),b'%PDF-1.7\ntest');self.assertIn('attachment',response.headers['Content-Disposition'])
        with urllib.request.urlopen(urllib.request.Request(origin+li.PREFIX+'/2/certificate',method='HEAD')) as response:
            self.assertEqual(response.read(),b'');self.assertEqual(response.headers['Content-Length'],'13')
        with self.assertRaises(urllib.error.HTTPError) as exc:post(li.PREFIX+'/2',self.body(version=1),'https://unrelated.example')
        self.assertEqual(exc.exception.code,403)
        with self.assertRaises(urllib.error.HTTPError) as exc:post(li.PREFIX+'/1',self.body())
        self.assertEqual(exc.exception.code,404)
        with self.assertRaises(urllib.error.HTTPError) as exc:urllib.request.urlopen(origin+li.PREFIX+'/3/certificate')
        self.assertEqual(exc.exception.code,404)


if __name__ == '__main__': unittest.main()
