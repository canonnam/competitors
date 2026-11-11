"""Financial reconciliation and public endpoint regression coverage."""
from contextlib import closing
import json
from datetime import datetime
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch
import app
import facility_access
from scripts.build_operating_report import classify, update_timestamp

ROOT = Path(__file__).resolve().parent
REPORT = json.loads((ROOT/'data'/'operating_report.json').read_text(encoding='utf-8'))


class OperatingReportTests(unittest.TestCase):
    def test_update_summary_uses_korean_day_and_article_content_update(self):
        updates = app.card_updates
        by_file = {
            'card_updates.json': {
                'statistics': '2026-11-11T14:59:59Z',
                'competitors': '2026-11-11T15:00:00Z',
                'payroll': '2026-11-12T00:00:01+09:00',
            },
            'operating_report.json': {},
            'trend_ideas.json': {'ideas': [{'updated': '2026-11-12'}]},
            'support_resources.json': {'items': [{'collected_date': '2026-11-11'}]},
            'nearby_facilities.json': {},
        }
        notice = {'first_seen_at': '2026-11-10T09:00:00+09:00', 'collected_at': '2026-11-12T00:00:00+09:00'}
        with (
            patch.object(updates, 'read_json', side_effect=lambda path: by_file[path.name]),
            patch.object(updates, 'monthly_updates', return_value=[]),
            patch.object(updates, 'claim_dates', return_value=[]),
            patch.object(updates, 'policy_dates', return_value=[]),
            patch.object(updates, 'ad_dates', return_value=[]),
            patch.object(updates, 'visibility_dates', return_value=[]),
            patch.object(updates, 'reputation_dates', return_value=[]),
            patch.object(updates, 'sqlite_dates', return_value=[]),
            patch.object(updates.website_intake, 'summary', return_value={}),
            patch.object(updates.clarity_report, 'report', return_value={}),
            patch.object(updates.competitor_news, 'report', return_value={'items': []}),
            patch.object(updates.agency_news, 'report', return_value={'items': [notice]}),
        ):
            before = updates.recent(ROOT, datetime.fromisoformat('2026-11-11T14:59:59+00:00'))
            midnight = updates.recent(ROOT, datetime.fromisoformat('2026-11-11T15:00:00+00:00'))
        self.assertEqual(set(before), {'statistics', 'support-resources'})
        self.assertEqual(set(midnight), {'competitors', 'agency-news', 'trend'})

    def test_read_only_timestamp_lookup_uses_saved_dates_without_creating_a_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'feature dates.db'
            query = 'SELECT MAX(updated) FROM test_updates'
            self.assertEqual(list(app.card_updates.sqlite_dates(path, query)), [])
            self.assertFalse(path.exists())
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('CREATE TABLE test_updates (updated TEXT)')
                db.executemany('INSERT INTO test_updates VALUES (?)', [
                    ('2026-11-11T14:59:59+00:00',), ('2026-11-11T15:00:00+00:00',)
                ])
            self.assertEqual(list(app.card_updates.sqlite_dates(path, query)), ['2026-11-11T15:00:00+00:00'])
            with self.assertRaises(sqlite3.OperationalError):
                list(app.card_updates.sqlite_dates(path, 'DELETE FROM test_updates'))

    def test_update_timestamp_tracks_report_changes_not_review_dates(self):
        previous = {'branches': [{'id': 'anyang'}], 'updatedAt': '2025-09-01T01:00:00Z'}
        same_data = {'branches': previous['branches'], 'sourceDate': '2026-11-10'}
        update_timestamp(same_data, previous)
        self.assertEqual(same_data['updatedAt'], previous['updatedAt'])

        changed_data = {'branches': [{'id': 'anyang'}, {'id': 'incheon'}]}
        update_timestamp(changed_data, previous)
        self.assertRegex(changed_data['updatedAt'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
        self.assertNotEqual(changed_data['updatedAt'], previous['updatedAt'])

    def test_all_months_reconcile_to_source_and_cash_bridge(self):
        self.assertEqual(REPORT['sourceCount'], 35)
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
               ('잡지출','7/31착오송금 반환',0,579150,('correction','오입금·반환')),
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
        july=next(m for m in anyang['months'] if m['month']=='2026-07')
        self.assertEqual((july['profit'],july['cashChange']),(-3731755,-17731755))
        march=next(m for m in incheon['months'] if m['month']=='2026-03')
        self.assertEqual(march['profit'],-25262470)
        incheon_july=next(m for m in incheon['months'] if m['month']=='2026-07')
        self.assertEqual(incheon_july['flags'][0]['amount'],5000000)

    def test_august_and_september_match_workbook_controls_and_separate_returns(self):
        # August controls: Anyang E114:G114, Incheon E82:G82.
        # September controls: Anyang E149:G149, Incheon E128:G128.
        expected = {
            ('anyang', '2026-08'): (100770030, 84316828, 16453202, 91696630, 70243428, 21453202, 0, 111, '2026-08-03'),
            ('incheon', '2026-08'): (110709790, 122390965, -11681175, 110144790, 103111815, 7032975, -13714150, 79, '2026-08-02'),
            ('anyang', '2026-09'): (110581743, 104141798, 6439945, 106261403, 90141798, 16119605, 4320340, 146, '2026-09-01'),
            ('incheon', '2026-09'): (120029143, 135068678, -15039535, 117656831, 101196366, 16460465, -19500000, 125, '2026-09-01'),
        }
        fields = ['sourceIncome', 'sourceExpense', 'cashChange', 'revenue', 'cost', 'profit', 'correction', 'transactionCount', 'firstDate']
        for branch in REPORT['branches']:
            months = {m['month']: m for m in branch['months']}
            for previous, month, last_day in [('2026-07', '2026-08', '31'), ('2026-08', '2026-09', '30')]:
                with self.subTest(branch=branch['id'], month=month):
                    current = months[month]
                    self.assertEqual(tuple(current[k] for k in fields), expected[branch['id'], month])
                    self.assertEqual(current['openingBalance'], months[previous]['closingBalance'])
                    self.assertEqual(current['lastDate'], f'{month}-{last_day}')

    def test_aggregates_contain_no_transaction_memos_or_names(self):
        serialized=json.dumps(REPORT,ensure_ascii=False)
        for forbidden in ['임경애','강봉구','어르신','"memo"','"transactions"']:
            self.assertNotIn(forbidden,serialized)


class OperatingEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        password_hash = facility_access.make_password_hash('test-operating-report')
        env = patch.dict('os.environ', {facility_access.HASH_ENV: password_hash})
        env.start()
        cls.addClassCleanup(env.stop)
        cls.cookie = facility_access.COOKIE + '=' + facility_access.issue_cookie()
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),app.App)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def request(self, path, method='GET'):
        return urllib.request.Request(self.base + path, method=method, headers={'Cookie': self.cookie})

    def test_new_page_assets_api_and_head(self):
        for path in ['/operating-costs.html','/assets/operating-costs.css','/assets/operating-costs.js','/assets/operating-model.js','/assets/operating-cards.js','/assets/dashboard-operating.js','/api/operating-report']:
            with self.subTest(path=path),urllib.request.urlopen(self.request(path)) as response:
                self.assertEqual(response.status,200)
        for path in ['/operating-costs.html','/api/operating-report']:
            with urllib.request.urlopen(self.request(path, method='HEAD')) as response:
                self.assertEqual(response.read(),b'')
                self.assertGreater(int(response.headers['Content-Length']),0)
        with urllib.request.urlopen(self.request('/api/operating-report')) as response:
            self.assertEqual(json.load(response),REPORT)
            self.assertEqual(response.headers['Cache-Control'],'no-store')
        with urllib.request.urlopen(self.request('/api/operating-report?summary=1')) as response:
            self.assertEqual(json.load(response), {'updatedAt': REPORT['updatedAt']})
            self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_raw_data_source_and_unlisted_files_are_not_served(self):
        for path in ['/data/operating_report.json','/scripts/build_operating_report.py','/app.py','/.git/config','/missing.html']:
            with self.subTest(path=path),self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(self.request(path))
            self.assertEqual(raised.exception.code,404)

    def test_update_summary_only_returns_timestamps(self):
        updated = {'payroll-insurance': '2026-11-10T05:12:31+00:00'}
        with patch.object(app.card_updates, 'recent', return_value=updated):
            with urllib.request.urlopen(self.request('/api/card-updates')) as response:
                self.assertEqual(json.load(response), {'updatedAt': updated})
                self.assertIn('no-store', response.headers['Cache-Control'])
                self.assertIn('Cookie', response.headers['Vary'])
            with urllib.request.urlopen(self.request('/api/card-updates', method='HEAD')) as response:
                self.assertEqual(response.read(), b'')


if __name__=='__main__':unittest.main()
