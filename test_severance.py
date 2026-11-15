import copy
from datetime import date
from decimal import Decimal
import http.client
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile
import xml.etree.ElementTree as ET

import app
import facility_access
import payroll_insurance as payroll
import severance as m
from test_payroll_insurance import sample


def manual(hire='2025-01-01', last='2025-12-31', amount=3000000):
    return {'branch': 2, 'name': '검증용', 'hireDate': hire, 'lastDay': last, 'weeklyHours': 40,
            'ordinaryDaily': 80000, 'annualBonus': 0, 'priorLeavePay': 0, 'unusedDays': 0,
            'leaveAlreadyPaid': 0, 'note': '', 'includeSeal': True,
            'standardPeriodConfirmed': True, 'payItemsConfirmed': True,
            'wages': [{'month': p['month'], 'mode': 'manual', 'amount': amount, 'excluded': 0,
                       'sourceKey': '', 'sourceHash': '', 'reason': '검증용 입력'}
                      for p in m.periods(date.fromisoformat(hire), date.fromisoformat(last))]}


class SeveranceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {'PAYROLL_INSURANCE_DIR': self.temp.name+'/payroll', 'SEVERANCE_DIR': self.temp.name+'/severance'})
        self.env.start(); self.addCleanup(self.env.stop)

    def test_calendar_window_and_inclusive_tenure(self):
        r = m.calculate(manual())['result']
        self.assertEqual((r['retirementDate'],r['tenureDays'],r['periodDays']),('2026-01-01',365,92))
        self.assertEqual(r['severance'],2934783)
        p=m.periods(date(2020,1,1),date(2026,3,16))
        self.assertEqual([(r['month'],r['days']) for r in p],[('2025-12',15),('2026-01',31),('2026-02',28),('2026-03',16)])
        self.assertEqual(sum(r['days'] for r in m.periods(date(2020,1,1),date(2024,4,30))),90)
        self.assertEqual(m.periods(date(2020,1,1),date(2026,5,30))[0]['start'],'2026-02-28')

    def test_eligibility_leap_year_and_hours(self):
        for hire,last,hours,eligible in [('2024-01-01','2024-12-30',40,False),('2024-01-01','2024-12-31',15,True),('2025-01-01','2025-12-31',14.99,False)]:
            b=manual(hire,last);b['weeklyHours']=hours;r=m.calculate(b)['result'];self.assertEqual(r['eligible'],eligible)
            if not eligible:self.assertEqual(r['severance'],0)
        short=m.calculate(manual('2026-02-15','2026-02-28'))['result']
        self.assertEqual((short['periodDays'],short['tenureDays']),(14,14))

    def test_ordinary_floor_annual_items_and_separate_leave(self):
        b=manual();b.update(ordinaryDaily=120000,annualBonus=1200000,priorLeavePay=400000,unusedDays=3.5,leaveAlreadyPaid=120000)
        r=m.calculate(b)['result']
        self.assertEqual((r['bonusIncluded'],r['priorLeaveIncluded']),(300000,100000))
        self.assertEqual((r['severance'],r['unusedLeavePay'],r['leaveDue'],r['totalBeforeTax']),(3600000,420000,300000,3900000))
        b['unusedDays']=20
        self.assertEqual(m.calculate(b)['result']['averageDaily'],r['averageDaily'])

    def test_legacy_acquisition_input_does_not_change_employee_entitlement(self):
        b=manual();expected=m.calculate(b)
        b['acquisitionDate']='2025-07-01'
        self.assertEqual(m.calculate(b),expected)
        # Old saved records remain readable/exportable without the retired split.
        legacy=copy.deepcopy(expected)
        legacy['input']['acquisitionDate']='2025-07-01'
        legacy['result'].update(previousShare=1000000,currentShare=1934783)
        import openpyxl
        sheet=openpyxl.load_workbook(io.BytesIO(m.xlsx(legacy))).active
        self.assertEqual(sheet['H15'].value,2934783)
        self.assertFalse(any('인수일' in str(cell.value) or '이전 부담' in str(cell.value) for row in sheet for cell in row))

    def write_payroll(self, duplicate=False, gross=3100000):
        for month in ['2025-12','2026-01','2026-02','2026-03']:
            b=sample();b['month']=month
            for branch in b['branches']:
                row=branch['rows'][0];row['name']='검증용';row['payroll'].update(gross_pay=gross,net_pay=gross-100)
                if duplicate:
                    other=copy.deepcopy(row);other['key']='second';branch['rows'].append(other)
            payroll.save(b)

    def source_body(self):
        b=manual('2025-01-01','2026-03-16')
        ps=m.wages(2,'검증용',date(2025,1,1),date(2026,3,16))
        b['wages']=[{'month':p['month'],'mode':'monthly','sourceKey':p['candidates'][0]['key'],'sourceHash':p['sourceHash'],'excluded':0,'reason':''} for p in ps]
        return b

    def test_partial_proration_actual_settlement_and_exclusions(self):
        self.write_payroll();b=self.source_body();r=m.calculate(b)['result']
        self.assertEqual(r['wages'][0]['included'],1500000)
        self.assertEqual(r['wages'][-1]['included'],1600000)
        b['wages'][-1].update(mode='actual',excluded=200000,reason='연차 지급분 제외')
        self.assertEqual(m.calculate(b)['result']['wages'][-1]['included'],2900000)
        b['wages'][0].update(excluded=310000,reason='별도 안분 상여')
        self.assertEqual(m.calculate(b)['result']['wages'][0]['included'],1350000)

    def test_suggestions_do_not_guess_unclear_final_partial_pay(self):
        self.write_payroll();ps=m.wages(2,'검증용',date(2025,1,1),date(2026,3,16))
        self.assertEqual(ps[0]['candidates'][0]['suggested'],1500000)
        self.assertEqual(ps[1]['candidates'][0]['suggested'],3100000)
        self.assertIsNone(ps[-1]['candidates'][0]['suggested'])
        self.assertEqual(ps[-1]['candidates'][0]['prorated'],1600000)
        report=payroll.read_report('2026-03')['report'];report['branches'][0]['rows'][0]['payroll']['work_days']=16;payroll.save(report)
        self.assertEqual(m.wages(2,'검증용',date(2025,1,1),date(2026,3,16))[-1]['candidates'][0]['suggested'],3100000)

    def test_direct_period_amount_preserves_provenance_and_is_not_prorated_twice(self):
        self.write_payroll();b=self.source_body()
        for row in b['wages']:row.update(mode='period',amount=1200000,excluded=100000,reason='해당 기간 연차분 차감')
        result=m.calculate(b)
        self.assertEqual(result['result']['wages'][0]['included'],1100000)
        self.assertEqual(result['result']['wageTotal'],4400000)
        self.assertEqual(result['input']['wages'][0]['sourceKey'],b['wages'][0]['sourceKey'])
        self.assertTrue(m.xlsx(result).startswith(b'PK'))
        b['wages'][0]['amount']=''
        with self.assertRaises(ValueError):m.calculate(b)
        b['wages'][0]['amount']=1200000;self.write_payroll(gross=3200000)
        with self.assertRaises(m.wiki_chat.ChatError):m.calculate(b)

    def test_source_staleness_duplicate_choice_and_missing_gross(self):
        self.write_payroll(duplicate=True);b=self.source_body()
        self.assertEqual(len(m.wages(2,'검증용',date(2025,1,1),date(2026,3,16))[0]['candidates']),2)
        b['wages'][0]['sourceKey']=''
        with self.assertRaises(ValueError):m.calculate(b)
        b=self.source_body();self.write_payroll(gross=3200000)
        with self.assertRaises(m.wiki_chat.ChatError) as error:m.calculate(b)
        self.assertEqual(error.exception.status,409)
        b=manual();b['wages'][0].update(mode='actual',sourceKey='missing')
        with self.assertRaises(ValueError):m.calculate(b)

    def test_validation_zero_missing_and_confirmations(self):
        for key,value in [('ordinaryDaily',0),('ordinaryDaily','NaN'),('annualBonus',None),('weeklyHours',169),('hireDate','2026-02-30'),('lastDay','2020-01-01'),('includeSeal','yes'),('payItemsConfirmed',False),('standardPeriodConfirmed',False)]:
            with self.subTest(key=key,value=value):
                b=manual();b[key]=value
                with self.assertRaises(ValueError):m.calculate(b)
        b=manual();b['wages'][0]['reason']=''
        with self.assertRaises(ValueError):m.calculate(b)
        b=manual();b['wages'][0]['excluded']=4000000
        with self.assertRaises(ValueError):m.calculate(b)
        b=manual();b['wages'][0]['amount']=0;self.assertEqual(m.calculate(b)['result']['wages'][0]['included'],0)

    def test_save_revision_history_and_snapshot(self):
        b=manual();first=m.save(b);b.update(id=first['id'],revision=1,note='수정');second=m.save(b)
        self.assertEqual(second['revision'],2);self.assertEqual(len(list((m.storage()/'history').glob('*.json'))),1)
        with self.assertRaises(m.wiki_chat.ChatError):m.save(b)
        self.assertEqual(m.read(second['id']),second);self.assertEqual(len(m.records()),1)
        with self.assertRaises(ValueError):m.read('../file')

    def test_xlsx_preserves_layout_safe_text_print_and_branch_seal(self):
        import openpyxl
        original=openpyxl.load_workbook(m.ROOT/'templates/severance.xlsx').active
        for branch,filename in [(2,'seal-anyang.png'),(3,'seal-incheon.png')]:
            b=manual();b.update(branch=branch,name='=1+2',unusedDays=2)
            raw=m.xlsx(m.calculate(b));book=openpyxl.load_workbook(io.BytesIO(raw));s=book.active
            self.assertEqual(s['C5'].value,'=1+2');self.assertEqual(s['C5'].data_type,'s')
            self.assertEqual(str(s.merged_cells),str(original.merged_cells));self.assertEqual(s['H15'].value,2934783)
            self.assertEqual(s['G5'].value.date(),date(2025,1,1));self.assertEqual(s.page_setup.fitToWidth,1)
            self.assertEqual(str(s.page_setup.paperSize),'9');self.assertEqual(len(s._images),1)
            with zipfile.ZipFile(io.BytesIO(raw)) as z:self.assertEqual(z.read('xl/media/seal.png'),(m.ROOT/'assets/contracts'/filename).read_bytes())
            for cell in ['B3','B8','B9','B14','H15']:self.assertEqual(s[cell]._style,original[cell]._style)
        b['includeSeal']=False;book=openpyxl.load_workbook(io.BytesIO(m.xlsx(m.calculate(b))));self.assertFalse(book.active._images)

    def test_delete_restore_preserves_snapshot_and_version_history(self):
        original=m.save(manual());ident=original['id'];before=m.xlsx(original)
        with patch.object(m,'calculate',side_effect=AssertionError('Lifecycle changes must not recalculate')):
            deleted=m.change_record_state({'id':ident,'revision':1},True)
            self.assertEqual(m.records(),[]);self.assertEqual(len(m.records('deleted')),1)
            self.assertEqual(deleted['revision'],2);self.assertTrue(deleted['deletedAt'])
            with self.assertRaises(m.wiki_chat.ChatError) as error:m.read(ident)
            self.assertEqual(error.exception.status,404)
            restored=m.change_record_state({'id':ident,'revision':2},False)
        self.assertEqual(restored['revision'],3);self.assertNotIn('deletedAt',restored)
        for key in ['input','result','createdAt']:self.assertEqual(restored[key],original[key])
        self.assertEqual(m.records('deleted'),[]);self.assertEqual(len(m.records()),1)
        # Zip timestamps may differ, but every exported entry must remain identical.
        with zipfile.ZipFile(io.BytesIO(before)) as a,zipfile.ZipFile(io.BytesIO(m.xlsx(restored))) as b:
            self.assertEqual({n:a.read(n) for n in a.namelist()},{n:b.read(n) for n in b.namelist()})
        history=m.storage()/'history'
        self.assertEqual(json.loads((history/f'{ident}-1.json').read_text('utf-8')),original)
        self.assertEqual(json.loads((history/f'{ident}-2.json').read_text('utf-8')),deleted)

    def test_delete_conflicts_and_deleted_record_cannot_be_saved(self):
        body=manual();first=m.save(body);ident=first['id']
        for revision in [None,True,0,2,'1']:
            with self.subTest(revision=revision),self.assertRaises(m.wiki_chat.ChatError) as error:
                m.change_record_state({'id':ident,'revision':revision},True)
            self.assertEqual(error.exception.status,409)
        deleted=m.change_record_state({'id':ident,'revision':1},True)
        for revision in [1,2]:
            with self.assertRaises(m.wiki_chat.ChatError):m.change_record_state({'id':ident,'revision':revision},True)
        body.update(id=ident,revision=deleted['revision'])
        with self.assertRaises(m.wiki_chat.ChatError) as error:m.save(body)
        self.assertEqual(error.exception.status,409)
        restored=m.change_record_state({'id':ident,'revision':2},False)
        with self.assertRaises(m.wiki_chat.ChatError):m.save(body)
        body['revision']=restored['revision'];body['note']='복구 후 수정'
        self.assertEqual(m.save(body)['revision'],4)
        with self.assertRaises(ValueError):m.records('all')


class SeveranceAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.env=patch.dict(os.environ,{'SEVERANCE_DIR':cls.temp.name+'/records','PAYROLL_INSURANCE_DIR':cls.temp.name+'/pay',facility_access.HASH_ENV:facility_access.make_password_hash('test-only'), 'FACILITY_ACCESS_DB_PATH':cls.temp.name+'/auth.db'})
        cls.env.start();cls.cookie=facility_access.COOKIE+'='+facility_access.issue_cookie()
        cls.server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App);cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.env.stop();cls.temp.cleanup()

    def request(self,path,method='GET',body=None,auth=True,origin=None):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        headers={'Cookie':self.cookie} if auth else {}
        if body is not None:headers.update({'Content-Type':'application/json','Origin':origin or f'http://127.0.0.1:{self.server.server_port}'})
        c.request(method,path,json.dumps(body).encode() if body is not None else None,headers);r=c.getresponse();raw=r.read();result=(r.status,dict(r.headers),raw);c.close();return result

    def test_authenticated_save_read_download_and_origin(self):
        self.assertEqual(self.request('/api/severance/records',auth=False)[0],401)
        self.assertEqual(self.request('/api/severance/save','POST',manual(),origin='https://elsewhere.invalid')[0],403)
        status,_,raw=self.request('/api/severance/wages','POST',manual())
        self.assertEqual(status,200);self.assertEqual(len(json.loads(raw)['wages']),3)
        self.assertEqual(self.request('/api/severance/wages?name=example')[0],404)
        status,headers,raw=self.request('/api/severance/save','POST',manual());self.assertEqual(status,200);record=json.loads(raw)
        status,headers,raw=self.request('/api/severance/export?id='+record['id']);self.assertEqual(status,200);self.assertTrue(raw.startswith(b'PK'));self.assertIn('no-store',headers['Cache-Control'])
        self.assertEqual(self.request('/api/severance/export?id='+record['id'],'HEAD')[2],b'')
        self.assertEqual(self.request('/api/severance/record?id=../../oops')[0],400)
        self.assertEqual(self.request('/templates/severance.xlsx')[0],404)

    def test_delete_restore_auth_origin_filter_and_export(self):
        status,_,raw=self.request('/api/severance/save','POST',manual());self.assertEqual(status,200)
        record=json.loads(raw);body={'id':record['id'],'revision':1}
        for action in ['delete','restore']:
            path='/api/severance/'+action
            self.assertEqual(self.request(path,'POST',body,auth=False)[0],401)
            self.assertEqual(self.request(path,'POST',body,origin='https://elsewhere.invalid')[0],403)
            self.assertEqual(self.request(path+'?id='+record['id'])[0],404)
        self.assertEqual(self.request('/api/severance/delete','POST',body)[0],200)
        for route in ['record','export']:
            for method in ['GET','HEAD']:
                self.assertEqual(self.request('/api/severance/'+route+'?id='+record['id'],method)[0],404)
        for view,expected in [('active',False),('deleted',True)]:
            status,_,raw=self.request('/api/severance/records?view='+view)
            self.assertEqual(status,200);self.assertEqual(record['id'] in [r['id'] for r in json.loads(raw)['records']],expected)
        self.assertEqual(self.request('/api/severance/restore','POST',body)[0],409)
        body['revision']=2;self.assertEqual(self.request('/api/severance/restore','POST',body)[0],200)
        self.assertEqual(self.request('/api/severance/export?id='+record['id'])[0],200)
        self.assertEqual(self.request('/api/severance/records?view=all')[0],400)


if __name__=='__main__':unittest.main()
