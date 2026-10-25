"""Bank export boundaries, independent controls, immutable originals, and private HTTP."""
from datetime import datetime
import hashlib
import http.client
from http.server import ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import bank_transactions as model

RAW = bytes.fromhex('d0cf11e0a1b11ae1') + b'test original'


class Sheet:
    def __init__(self):
        self.rows = [[''] * 10 for _ in range(7)]
        self.rows[0][0] = '거래내역'
        self.rows[3][0] = '계좌번호 : ' + model.BRANCHES['incheon'][1]
        self.rows[5][0] = '조회기간 : 2026-09-01 ~ 2026-09-30'
        self.rows[6] = model.HEADERS.copy()
        self.rows += [['2026-09-30 09:00:00', '출금', '', '', '', 40, 160, 'CMS', '', ''],
                      ['2026-09-01 09:00:00', '입금', '', '', 100, '', 200, '송금', '', ''],
                      ['', '', '', '합계', 100, 40, '', '', '', '']]
        self.ncols = 10

    @property
    def nrows(self):
        return len(self.rows)

    def row_values(self, index):
        return self.rows[index]

    def cell_value(self, row, column):
        return self.rows[row][column]


class Book:
    nsheets = 1

    def __init__(self, sheet):
        self.sheet = sheet

    def sheet_by_index(self, index):
        return self.sheet

    def release_resources(self):
        pass


class BankTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.environment = patch.dict(os.environ, {'BANK_TRANSACTIONS_DIR': self.temp.name})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.sheet = Sheet()
        self.book = patch.object(model.xlrd, 'open_workbook', return_value=Book(self.sheet))
        self.book.start()
        self.addCleanup(self.book.stop)

    def save(self, collected='2026-10-25T15:00:00+09:00'):
        with patch.object(model, 'now', return_value=datetime(2026, 10, 25, 16, tzinfo=model.KST)):
            return model.save(RAW, 'incheon', '2026-09', collected, True)

    def test_month_boundary_uses_korean_calendar(self):
        self.assertEqual(model.previous_month(datetime(2026, 1, 1, 0, tzinfo=model.KST)), '2025-12')
        self.assertEqual(model.period('2024-02'), ('2024-02-01', '2024-02-29'))
        for value in ('../2026-09', '2026-13', '', None):
            with self.assertRaises(ValueError):
                model.month(value)

    def test_totals_and_each_balance_reconcile_without_dropping_rows(self):
        result = model.parse_export(RAW, 'incheon', '2026-09')
        self.assertEqual((result['count'], result['deposits'], result['withdrawals']), (2, 100, 40))
        self.assertEqual((result['openingBalance'], result['closingBalance'], result['balanceChecks']), (100, 160, 1))
        self.assertEqual(result['status'], 'verified')
        self.assertEqual([r['row'] for r in result['records']], [8, 9])

    def test_wrong_account_incomplete_month_and_missing_footer_rejected(self):
        for row, column, value in ((3, 0, '계좌번호 : 123'), (5, 0, '조회기간 : 2026-09-02 ~ 2026-09-30'),
                                   (6, 4, '변경한 입금'), (-1, 3, '')):
            sheet = Sheet()
            sheet.rows[row][column] = value
            with patch.object(model.xlrd, 'open_workbook', return_value=Book(sheet)), self.assertRaises(ValueError):
                model.parse_export(RAW, 'incheon', '2026-09')

    def test_out_of_month_and_fractional_money_rejected(self):
        for column, value in ((0, '2026-10-01 00:00:00'), (4, 0.5)):
            sheet = Sheet()
            sheet.rows[7][column] = value
            with patch.object(model.xlrd, 'open_workbook', return_value=Book(sheet)), self.assertRaises(ValueError):
                model.parse_export(RAW, 'incheon', '2026-09')

    def test_control_mismatch_and_broken_balance_remain_visible(self):
        self.sheet.rows[-1][4] = 101
        self.sheet.rows[7][6] = 159
        result = model.parse_export(RAW, 'incheon', '2026-09')
        self.assertEqual({i['kind'] for i in result['issues']}, {'totals', 'balance'})
        self.assertEqual(result['status'], 'review')
        self.assertEqual(len(result['records']), 2)

    def test_same_second_source_order_is_preserved(self):
        self.sheet.rows[7][0] = self.sheet.rows[8][0]
        self.assertEqual(model.parse_export(RAW, 'incheon', '2026-09')['issues'], [])

    def test_empty_month_has_unknown_balances(self):
        self.sheet.rows = self.sheet.rows[:7] + [['', '', '', '합계', 0, 0, '', '', '', '']]
        result = model.parse_export(RAW, 'incheon', '2026-09')
        self.assertEqual(result['count'], 0)
        self.assertIsNone(result['openingBalance'])
        self.assertIsNone(result['closingBalance'])

    def test_more_than_one_hundred_rows_are_all_preserved(self):
        rows = [[f'2026-09-01 09:{i // 60:02d}:{i % 60:02d}', '입금', '', '', 1, '', 100 + i, '송금', '', ''] for i in range(143)]
        self.sheet.rows = self.sheet.rows[:7] + list(reversed(rows)) + [['', '', '', '합계', 143, 0, '', '', '', '']]
        result = model.parse_export(RAW, 'incheon', '2026-09')
        self.assertEqual((result['count'], result['deposits'], result['balanceChecks']), (143, 143, 142))
        self.assertEqual(result['status'], 'verified')

    def test_duplicate_candidates_are_flagged_and_never_removed(self):
        self.sheet.rows.insert(8, self.sheet.rows[7].copy())
        self.sheet.rows[-1][5] = 80
        result = model.parse_export(RAW, 'incheon', '2026-09')
        self.assertEqual(result['count'], 3)
        self.assertIn('duplicate', {i['kind'] for i in result['issues']})

    def test_original_hash_failure_retention_and_stale_import(self):
        result = self.save()
        self.assertEqual(result['sha256'], hashlib.sha256(RAW).hexdigest())
        self.assertEqual(model.original('2026-09', 'incheon'), RAW)
        model.save_failure('2026-09', 'incheon')
        branch = model.report('2026-09')['branches'][0]
        self.assertTrue(branch['available'])
        self.assertIsNotNone(branch['failure'])
        with self.assertRaises(ValueError):
            self.save('2026-10-24T15:00:00+09:00')
        self.assertEqual(model.original('2026-09', 'incheon'), RAW)
        (model.root() / 'files' / (result['sha256'] + '.xls')).write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            model.original('2026-09', 'incheon')

    def test_unknown_branch_and_missing_export_proof_cannot_be_saved(self):
        with self.assertRaises(ValueError):
            model.manifest_path('2026-09', '../files')
        with self.assertRaises(ValueError):
            model.save(RAW, 'incheon', '2026-09', '2026-10-25T15:00:00+09:00', False)
        with self.assertRaises(ValueError):
            model.save(RAW, 'incheon', '2026-09', '2026-09-29T15:00:00+09:00', True)

    def test_http_requires_existing_site_login_and_download_is_exact(self):
        import app
        import facility_access
        self.save()
        class QuietApp(app.App):
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), QuietApp)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
        self.addCleanup(connection.close)
        for route in ('/api/bank-transactions', '/api/bank-transactions/download?month=2026-09&branch=incheon'):
            with patch.object(facility_access, 'authorized', return_value=False):
                connection.request('GET', route)
                response = connection.getresponse()
                self.assertEqual(response.status, 401)
                response.read()
        with patch.object(facility_access, 'authorized', return_value=True):
            connection.request('GET', '/api/bank-transactions/download?month=2026-09&branch=incheon')
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn('no-store', response.getheader('Cache-Control'))
            self.assertIn('attachment;', response.getheader('Content-Disposition'))
            self.assertEqual(response.read(), RAW)
            connection.request('HEAD', '/api/bank-transactions/download?month=2026-09&branch=incheon')
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(int(response.getheader('Content-Length')), len(RAW))
            self.assertEqual(response.read(), b'')
            connection.request('POST', '/api/bank-transactions', body=b'{}', headers={'Origin': f'http://127.0.0.1:{server.server_port}'})
            response = connection.getresponse()
            self.assertEqual(response.status, 405)
            response.read()


if __name__ == '__main__':
    unittest.main()
