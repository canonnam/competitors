"""Financial reconciliation and public endpoint regression coverage."""
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
import app
from scripts.build_operating_report import classify

ROOT = Path(__file__).resolve().parent
REPORT = json.loads((ROOT/'data'/'operating_report.json').read_text(encoding='utf-8'))


class OperatingReportTests(unittest.TestCase):
    def test_all_months_reconcile_to_source_and_cash_bridge(self):
        self.assertEqual(REPORT['sourceCount'], 31)
        for branch in REPORT['branches']:
            self.assertEqual(len({m['month'] for m in branch['months']}),len(branch['months']))
            for m in branch['months']:
                with self.subTest(branch=branch['id'],month=m['month']):
                    self.assertEqual(m['revenue'],sum(a['income'] for a in m['accounts']))
                    self.assertEqual(m['cost'],sum(a['expense'] for a in m['accounts']))
                    self.assertEqual(m['profit'],m['revenue']-m['cost'])
                    self.assertEqual(m['cashChange'],m['sourceIncome']-m['sourceExpense']-m['carry'])
                    self.assertEqual(m['cashChange'],m['profit']+sum(m[k] for k in ['financing','investment','transfer','correction']))
                    self.assertEqual(m['closingBalance']-m['openingBalance'],m['cashChange'])

    def test_reclassification_preserves_financial_meaning(self):
        cases=[('기타잡수입','오류 출금(이자)',-4427046,0,('operating','이자')),
               ('기타잡수입','회사 대여',5000000,0,('financing','차입·원금 상환')),
               ('기타잡수입','오루입금 후 출금',-12000000,0,('correction','오입금·반환')),
               ('잡지출','10/15 입금오류 반환',0,4500000,('correction','오입금·반환')),
               ('기타잡수입','3월 약제비 반환',1305500,0,('operating','기타 수입')),
               ('기타전출금','전출금(원금)',0,2000000,('financing','차입·원금 상환')),
               ('전년도이월금','이월',47387837,0,('carry','이월금')),
               ('시설비','시설 공사',0,10000000,('investment','시설·자산 투자')),
               ('의료비','환급',0,-10000,('operating','의료·약품'))]
        for account,memo,income,expense,expected in cases:
            with self.subTest(account=account,memo=memo):self.assertEqual(classify(account,memo,income,expense),expected)
        with self.assertRaises(ValueError):classify('새 계정','',0,100)

    def test_critical_months_do_not_treat_borrowing_or_carry_as_profit(self):
        anyang,incheon=REPORT['branches']
        jan=next(m for m in anyang['months'] if m['month']=='2026-01')
        self.assertEqual(jan['carry'],47387837)
        self.assertEqual(jan['profit'],19829097)
        july=anyang['months'][-1]
        self.assertEqual((july['profit'],july['cashChange']),(-3731755,-17731755))
        march=next(m for m in incheon['months'] if m['month']=='2026-03')
        self.assertEqual(march['profit'],-25262470)
        self.assertEqual(incheon['months'][-1]['flags'][0]['amount'],5000000)

    def test_aggregates_contain_no_transaction_memos_or_names(self):
        serialized=json.dumps(REPORT,ensure_ascii=False)
        for forbidden in ['임경애','강봉구','어르신','"memo"','"transactions"']:
            self.assertNotIn(forbidden,serialized)


class OperatingEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),app.App)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def test_new_page_assets_api_and_head(self):
        for path in ['/operating-costs.html','/assets/operating-costs.css','/assets/operating-costs.js','/assets/operating-model.js','/api/operating-report']:
            with self.subTest(path=path),urllib.request.urlopen(self.base+path) as response:
                self.assertEqual(response.status,200)
        for path in ['/operating-costs.html','/api/operating-report']:
            with urllib.request.urlopen(urllib.request.Request(self.base+path,method='HEAD')) as response:
                self.assertEqual(response.read(),b'')
                self.assertGreater(int(response.headers['Content-Length']),0)
        with urllib.request.urlopen(self.base+'/api/operating-report') as response:
            self.assertEqual(json.load(response),REPORT)
            self.assertEqual(response.headers['Cache-Control'],'no-store')

    def test_raw_data_source_and_unlisted_files_are_not_served(self):
        for path in ['/data/operating_report.json','/scripts/build_operating_report.py','/app.py','/.git/config','/missing.html']:
            with self.subTest(path=path),self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(self.base+path)
            self.assertEqual(raised.exception.code,404)


if __name__=='__main__':unittest.main()
