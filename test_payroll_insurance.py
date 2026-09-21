import copy
from datetime import datetime
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import app
import card_knowledge
import payroll_insurance as m
from scripts.collect_payroll_insurance import candidates, build_branch, birthday


def sample():
    row = {'key': 'ledger-1', 'name': '테스트직원', 'position': '간호조무사', 'match': '성명·생년월일 일치',
           'payroll': {k: 0 for k in m.PAY}, 'insurance': dict(zip(m.INSURANCE, (100, 10, 200, 40, -10)))}
    row['payroll'].update(gross_pay=1000, total_deduction=100, net_pay=900, health_insurance=30)
    return {'schemaVersion': 1, 'month': '2026-08', 'checkedAt': m.now(), 'branches': [
        {'id': ident, 'ledgerId': ident, 'confirmedAt': m.now(), 'payrollCheckedAt': m.now(), 'insuranceCheckedAt': m.now(),
         'portalTotals': {'healthCare': 220, 'pension': 200, 'employment': 42, 'accident': -10},
         'sources': [{'kind': k, 'sha256': 'a'*64, 'records': 1} for k in ('건강', '국민연금', '고용', '산재')],
         'rows': [copy.deepcopy(row)]} for ident in (2, 3)]}


class PayrollInsuranceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {'PAYROLL_INSURANCE_DIR': self.temp.name}); self.env.start(); self.addCleanup(self.env.stop)

    def test_groups_reconcile_and_preserve_refunds(self):
        data=m.validate(sample())
        for b in data['branches']:
            self.assertEqual(b['totals']['insuranceTotal'],450)
            self.assertEqual(b['groups'][1]['grossPay'],1000)
            self.assertEqual(sum(g['insuranceTotal'] or 0 for g in b['groups']),450)
            self.assertEqual(b['reconciliation']['employment']['difference'],2)
            self.assertEqual(b['totals']['employeeDeductions'],30)

    def test_sanitize_never_stores_extra_pii(self):
        value=sample(); value['password']='SECRET'
        value['branches'][0]['rows'][0].update(birth_date='SECRET', payroll_account_number='SECRET', contact_phone='SECRET')
        self.assertNotIn('SECRET',json.dumps(m.validate(value)))
        self.assertEqual(m.validate(m.validate(value)),m.validate(value))

    def test_missing_is_not_zero_and_unmatched_not_dropped(self):
        value=sample(); row=copy.deepcopy(value['branches'][0]['rows'][0])
        row.update(key='nhis-1',position='직책 미확인',payroll=None)
        row['insurance']=dict.fromkeys(m.INSURANCE); row['insurance']['care']=0
        value['branches'][0]['rows'].append(row)
        b=m.validate(value)['branches'][0]
        self.assertIsNone(b['rows'][1]['insurance']['pension'])
        self.assertEqual(b['rows'][1]['insuranceTotal'],0)
        self.assertEqual(b['groups'][-1]['people'],1)
        self.assertIsNone(b['groups'][-1]['grossPay'])

    def test_history_failure_and_multiple_months(self):
        value=sample(); m.save(value); first=m.read_report('2026-08')['report']
        m.save_failure('2026-08'); self.assertEqual(m.read_report('2026-08')['report'],first)
        self.assertTrue(m.read_report('2026-08')['failure'])
        value['branches'][0]['rows'][0]['name']='수정직원'; m.save(value)
        self.assertIsNone(m.read_report('2026-08')['failure'])
        self.assertEqual(len(list((m.root()/'history').glob('*.json'))),1)
        value['month']='2026-09';m.save(value)
        self.assertEqual(m.read_report()['months'],['2026-09','2026-08'])
        self.assertIsNone(m.read_report('2026-07')['report'])

    def test_validation_and_year_rollover(self):
        for bad in ('../../2026-08','2026-13','26-08'):
            with self.assertRaises(ValueError):m.month(bad)
        self.assertEqual(m.previous_month(datetime(2026,1,10,tzinfo=m.KST)),'2025-12')
        value=sample();value['branches'][0]['rows'][0]['payroll']['net_pay']=0
        with self.assertRaises(ValueError):m.validate(value)
        value=sample();value['branches'][0]['rows']*=2
        with self.assertRaises(ValueError):m.validate(value)
        self.assertEqual(m.role('작업치료사'),'물리(작업)치료사')
        self.assertEqual(m.role('물리치료사'),'물리(작업)치료사')
        self.assertEqual(m.role('사무원'),'기타')

    def test_matching_suffix_and_conflicting_birth(self):
        people=[{'username':'가명1','birth_date':'1970-01-01'}, {'username':'가명','birth_date':'1980-01-01'}]
        found,_=candidates('가명','700101',people,'username','birth_date')
        self.assertEqual(found,[people[0]])
        self.assertEqual(candidates('가명','900101',people,'username','birth_date')[0],[])
        self.assertEqual(birthday('1970-01-01'),'700101')
        self.assertEqual(len(candidates('가명','',people*2,'username','birth_date')[0]),2)

    def test_csv_escapes_formulas_and_missing_values(self):
        value=sample();value['branches'][0]['rows'][0]['name']='=FORMULA()'
        raw=m.csv_bytes(m.validate(value),'2').decode('utf-8-sig')
        self.assertIn("'=FORMULA()",raw);self.assertNotIn('인천',raw)
        self.assertIn('노사합산',raw)

    def test_public_chat_cannot_read_private_reports(self):
        m.save(sample())
        evidence=card_knowledge.retrieve('payroll_insurance','직원 급여 알려줘',datetime.now(m.KST))
        self.assertNotIn('테스트직원',json.dumps(evidence,ensure_ascii=False))
        self.assertIn('담당자',str(evidence))


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join(5)

    def request(self,path,method='GET'):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        try:
            c.request(method,path);r=c.getresponse();return r.status,r.headers,r.read()
        finally:c.close()

    def test_auth_get_head_csv_post(self):
        with patch('support_applications.authenticated',return_value=False):
            for path in ('/api/support/payroll-insurance','/api/support/payroll-insurance?format=csv'):
                for method in ('GET','HEAD','POST'):
                    status,headers,body=self.request(path,method)
                    self.assertEqual(status,401);self.assertEqual(headers['Cache-Control'],'no-store')
                    self.assertNotIn('테스트직원'.encode(),body)
                    if method=='HEAD':self.assertEqual(body,b'')

    def test_authenticated_api_and_static_deny(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,{'PAYROLL_INSURANCE_DIR':temp}), patch('support_applications.authenticated',return_value=True):
            m.save(sample())
            status,headers,body=self.request('/api/support/payroll-insurance?month=2026-08')
            self.assertEqual(status,200);self.assertEqual(json.loads(body)['report']['month'],'2026-08')
            self.assertEqual(self.request('/api/support/payroll-insurance?month=2026-07&format=csv')[0],404)
            self.assertEqual(self.request('/api/support/payroll-insurance?month=../../etc/passwd')[0],400)
            self.assertEqual(self.request('/api/support/payroll-insurance','POST')[0],405)
            for path in ('/.local/2026-08.json','/payroll_insurance.py','/data/payroll-insurance/2026-08.json'):
                self.assertEqual(self.request(path)[0],404)


if __name__=='__main__':unittest.main()
