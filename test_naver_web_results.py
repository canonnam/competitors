from copy import deepcopy
from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

import search_visibility as v
import naver_web_results as n
import web_search_results as w

NOW = datetime(2026, 9, 21, 20, 0, tzinfo=v.KST)


class NaverBrowserTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.path = Path(temp.name)/'visibility.db'; self.adpath = Path(temp.name)/'ads.db'
        v.init_db(self.path); v.naver_ads.init_db(self.adpath)
        self.query = v.settings()['naver_queries'][0]
        adpath = patch.object(v.naver_ads, 'db_path', return_value=self.adpath)
        adpath.start(); self.addCleanup(adpath.stop)

    def body(self, **changes):
        return {'provider': 'naver', **self.query, 'request_id': str(uuid.uuid4()),
                'observed_at': NOW.isoformat(), 'status': 'ready', 'capture_method': 'browser',
                'session_context': '기존 로그인 · 기본 위치', 'complete_search': True,
                'pages': [{'page': 1, 'url': v.search_url(self.query['keyword']), 'has_next': False,
                           'text': '검색 결과: 더비다요양원 인천 광고입니다. 더비다요양원 안양 자연검색입니다.',
                           'results': [
                               {'area': 'ad', 'position': 1, 'title': '더비다요양원 인천', 'url': 'https://example.com/ad'},
                               {'area': 'web', 'position': 2, 'title': '더비다요양원 안양', 'url': 'https://example.com/anyang'}]}], **changes}

    def report(self, now=NOW):
        return v.report(self.path, self.adpath, now)['providers'][0]

    def item(self, now=NOW):
        return next(i for i in self.report(now)['items'] if i['keyword'] == self.query['keyword'])

    def test_real_pages_preserve_body_urls_and_separate_ad_and_branch(self):
        body = self.body(); w.submit(self.path, body, NOW)
        item = self.item()
        self.assertEqual(item['status'], 'ready')
        self.assertEqual(item['pages'][0]['text'], body['pages'][0]['text'])
        self.assertEqual(item['evidence'][0]['url'], body['pages'][0]['url'])
        self.assertEqual(item['session_context'], body['session_context'])
        self.assertEqual(len(item['matches']), 2)
        self.assertEqual(len(item['branch_result']['matches']), 1)
        self.assertEqual(item['branch_result']['first_page'], 1)
        self.assertEqual(self.report()['checked'], 1)
        with patch.object(v, 'fetch_html', side_effect=AssertionError('No server search')):
            self.assertEqual(v.sync_provider(self.path, 'naver', [self.query], v.settings(), NOW), [])
        with patch.object(v.threading, 'Thread') as worker:
            v.start_scheduler(self.path, self.adpath).set()
            worker.assert_not_called()

    def test_blocked_keeps_previous_evidence_and_excludes_current_counts(self):
        w.submit(self.path, self.body(), NOW)
        later = NOW+timedelta(minutes=1)
        blocked = self.body(status='blocked', observed_at=later.isoformat(), reason='보안 확인 화면', pages=[])
        w.submit(self.path, blocked, later)
        item = self.item(later)
        self.assertEqual(item['status'], 'error'); self.assertEqual(self.report(later)['checked'], 0)
        self.assertEqual(item['last_attempt_request_id'], blocked['request_id'])
        self.assertEqual(item['observed_at'], NOW.isoformat())
        self.assertEqual(item['error'], '보안 확인 화면'); self.assertTrue(item['pages'])

    def test_partial_pages_wrong_query_and_missing_evidence_rejected(self):
        cases = []
        body = self.body(); body['pages'][0]['has_next'] = True; cases.append(body)
        body = self.body(); body['pages'][0]['url'] = v.search_url('다른 질문'); cases.append(body)
        body = self.body(); body['pages'][0]['results'][0]['title'] = '복사된 다른 질문의 결과'; cases.append(body)
        body = self.body(); body['pages'][0]['page'] = 2; cases.append(body)
        cases += [self.body(capture_method='api'), self.body(complete_search=False), self.body(status='blocked', reason='')]
        for body in cases:
            with self.subTest(body=body), self.assertRaises(ValueError): w.submit(self.path, body, NOW)
        with self.assertRaises(LookupError): w.submit(self.path, self.body(keyword='OFF 키워드'), NOW)

    def test_idempotency_and_next_cycle(self):
        body = self.body(); w.submit(self.path, body, NOW); w.submit(self.path, deepcopy(body), NOW)
        self.assertEqual(len(self.item()['history']), 1)
        with self.assertRaises(ValueError): w.submit(self.path, {**body, 'session_context': '다른 환경'}, NOW)
        self.assertEqual(self.item(NOW+timedelta(days=1))['status'], 'ready')
        self.assertEqual(self.item(NOW+timedelta(days=2))['status'], 'pending')

    def test_old_server_cooldown_does_not_hide_browser_success(self):
        config = v.settings(); signature = v.query_signature('naver', self.query, config)
        old = {'provider': 'naver', 'keyword': self.query['keyword'], 'signature': signature,
               'observed_at': (NOW-timedelta(days=1)).isoformat(), 'mentioned': False, 'matches': []}
        with v.connect(self.path) as db:
            db.execute('INSERT INTO observations VALUES (?,?,?,?,?)', ('naver', self.query['keyword'], '2026-09-20', signature, json.dumps(old)))
            db.execute('INSERT INTO checks VALUES (?,?)', ('naver:cooldown', json.dumps({'until': (NOW+timedelta(days=2)).isoformat(), 'error': '조회 제한'})))
        self.assertEqual(self.item()['status'], 'pending')
        w.submit(self.path, self.body(), NOW)
        self.assertFalse(self.report()['collection_paused'])
        self.assertEqual(self.report()['checked'], 1)
        summary = v.report(self.path, self.adpath, NOW, summary=True)['providers'][0]
        self.assertEqual(summary['checked'], 1)
        self.assertNotIn('pages', summary['items'][0])


if __name__ == '__main__': unittest.main()
