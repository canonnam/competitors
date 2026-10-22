import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
import recipient_history as M


def row(key='a', qualification='일반', start='2020-01-01', end='9999-12-31', name='테스트'):
    return {'personKey': key * 64, 'name': name, 'qualification': qualification, 'appliedOn': start, 'endOn': end}


def payload(rows, branch='anyang', period='2026-10'):
    return {'schemaVersion': 1, 'benefitMonth': period, 'branches': [{
        'id': branch, 'institutionNumber': M.BRANCHES[branch][1], 'checkedAt': '2026-10-22T08:00:00+09:00',
        'source': {'kind': 'portal-dom', 'headers': M.HEADERS, 'recordCount': len(rows),
                   'sha256': hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()}, 'records': rows}]}


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'RECIPIENT_HISTORY_DIR': self.folder.name})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.folder.cleanup()

    def test_current_month_not_previous_and_kst_year_rollover(self):
        self.assertEqual(M.current_month(datetime(2026, 12, 31, 16, tzinfo=timezone.utc)), '2027-01')
        self.assertEqual(M.current_month(datetime(2026, 10, 1, 2, tzinfo=timezone.utc)), '2026-10')

    def analyze(self, rows):
        return M.analyze(M.validate(payload(rows))['branches'][0], '2026-10')

    def test_actual_change_and_period_renewal_are_not_row_counts(self):
        result = self.analyze([row(end='2026-10-07'), row(qualification='기초', start='2026-10-07'),
                               row('b', end='2026-10-15'), row('b', start='2026-10-15')])
        self.assertEqual((result['sourceRecords'], result['people'], result['changedPeople'], result['periodOnlyPeople']), (4, 2, 1, 1))
        self.assertEqual(result['reviewPeople'], 0)

    def test_one_day_contiguity_future_and_ambiguous_gaps(self):
        actual = self.analyze([row(end='2026-10-02'), row(qualification='기초', start='2026-10-03')])
        self.assertEqual(actual['changedPeople'], 1)
        future = self.analyze([row(end='2026-10-29'), row(qualification='기초', start='2026-10-29')])
        self.assertEqual((future['changedPeople'], future['scheduledPeople']), (0, 1))
        for old in ['2026-10-01', '9999-12-31']:
            unclear = self.analyze([row(end=old), row(qualification='기초', start='2026-10-05')])
            self.assertEqual(unclear['changedPeople'], 0)
            self.assertEqual(unclear['reviewPeople'], 1)

    def test_new_start_and_end_without_successor_are_review_not_change(self):
        for rows in [[row(start='2026-10-02')], [row(end='2026-10-04')]]:
            result = self.analyze(rows)
            self.assertEqual((result['changedPeople'], result['reviewPeople']), (0, 1))

    def test_duplicates_not_double_counted_and_same_names_not_merged(self):
        old, new = row(end='2026-10-07'), row(qualification='기초', start='2026-10-07')
        result = self.analyze([old, old, new, new, row('b')])
        self.assertEqual((result['changedPeople'], result['people'], len(result['events'])), (1, 2, 1))

    def test_validation_count_month_institution_dates_hash_and_private_fields(self):
        valid = payload([row()])
        mutations = [lambda p: p.update(benefitMonth='../2026-10'),
                     lambda p: p['branches'][0].update(institutionNumber='12817700685'),
                     lambda p: p['branches'][0]['source'].update(recordCount=2),
                     lambda p: p['branches'][0]['records'][0].update(recognitionNumber='sensitive'),
                     lambda p: p['branches'][0]['records'][0].update(appliedOn='2026-99-01'),
                     lambda p: p['branches'][0]['records'][0].update(name='변조'),
                     lambda p: p['branches'][0].update(checkedAt='2026-10-22T08:00:00')]
        for mutate in mutations:
            data = copy.deepcopy(valid)
            mutate(data)
            with self.assertRaises((ValueError, TypeError)):
                M.validate(data)

    def test_partial_branch_merge_failure_retains_success_and_zero_is_distinct(self):
        M.save(payload([row()]))
        M.save(payload([], 'incheon'))
        M.save_failure('2026-10', 'anyang')
        report = M.report('2026-10', True)
        anyang, incheon = report['branches']
        self.assertEqual((anyang['status'], anyang['people']), ('previous', 1))
        self.assertEqual((incheon['status'], incheon['people']), ('ready', 0))
        self.assertNotIn('records', json.dumps(report))
        self.assertNotIn('테스트', json.dumps(report, ensure_ascii=False))
        M.save(payload([row()]))
        self.assertIsNone(M.report('2026-10')['branches'][0]['failure'])
        self.assertEqual(M.report('2026-11')['branches'][0]['status'], 'unqueried')
        self.assertNotIn('people', M.report('2026-11')['branches'][0])

    def test_recoverable_corrections_and_no_older_overwrite(self):
        M.save(payload([row()]))
        corrected = payload([row(qualification='기초')])
        M.save(corrected)
        self.assertTrue(list((Path(self.folder.name) / 'history').glob('*.json')))
        corrected['branches'][0]['checkedAt'] = '2026-10-21T08:00:00+09:00'
        with self.assertRaises(ValueError):
            M.save(corrected)

    def test_knowledge_is_usage_only_never_reads_personal_store(self):
        import card_knowledge
        with patch.object(M, 'report', side_effect=AssertionError('private data read')):
            result = card_knowledge.retrieve('recipient_history', '수급자구분 변경이력', datetime.now(M.KST))
        value = json.dumps(result, ensure_ascii=False)
        self.assertIn('당월', value)
        self.assertIn('/recipient-history.html', value)


class RouteTests(unittest.TestCase):
    # Reuse existing local-only auth test setup without inheriting its unrelated tests.
    from test_facility_access import MapAccessTests as _Access
    setUp = _Access.setUp
    tearDown = _Access.tearDown
    call = _Access.call
    login = _Access.login

    def test_protected_summary_detail_head_writes_and_source_files(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'RECIPIENT_HISTORY_DIR': folder}):
            for path in ['/api/recipient-history', '/api/recipient-history/summary']:
                self.assertEqual(self.call(path)[0], 401)
            cookie = self.login()
            for path in ['/api/recipient-history', '/api/recipient-history/summary']:
                code, headers, raw = self.call(path, cookie=cookie)
                self.assertEqual(code, 200)
                self.assertIn('no-store', headers['Cache-Control'])
                self.assertEqual(self.call(path, 'HEAD', cookie=cookie)[2], b'')
                for method in ['POST', 'DELETE']:
                    self.assertEqual(self.call(path, method, cookie=cookie)[0], 405)
            self.assertEqual(self.call('/api/recipient-history?month=2026-99', cookie=cookie)[0], 400)
            for path in ['/recipient_history.py', '/.local/recipient-history/anyang-2026-10.json']:
                self.assertEqual(self.call(path, cookie=cookie)[0], 404)
            self.assertIn('수급자구분 변경이력', self.call('/recipient-history.html', cookie=cookie)[2].decode())


if __name__ == '__main__':
    unittest.main()
