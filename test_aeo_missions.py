from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

import app
import aeo_missions as m
import search_visibility as v


class MissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'visibility.db'
        v.init_db(self.path)
        self.item = {'keyword': '인천 요양원 추천', 'branch': 'incheon', 'status': 'ready',
                     'stale': False, 'mentioned': False, 'branch_result': {'mentioned': False}}
        self.report = {'branches': [{'id': 'incheon', 'name': '인천점'}, {'id': 'anyang', 'name': '안양점'}],
                       'providers': [{'id': provider, 'kind': 'ai', 'items': [self.item]} for provider in ('openai', 'gemini')]}
        self.patcher = patch.object(v, 'report', return_value=self.report)
        self.patcher.start(); self.addCleanup(self.patcher.stop)

    def state(self, provider='openai', item=None):
        with v.connect(self.path) as db:
            return m.view(db, provider, item or self.item, '인천점')

    def body(self, **changes):
        state = self.state()
        return {'provider': 'openai', 'keyword': self.item['keyword'], 'branch': 'incheon',
                'mission_id': state['current']['id'], 'revision': state['revision'], 'action': 'complete',
                'request_id': str(uuid.uuid4()), **changes}

    def test_blocked_reason_required_then_retry_and_complete_advances(self):
        for changes in ({'reason_code': 'time'}, {'reason': '시간 부족'}, {'reason_code': 'time', 'reason': '  '}):
            with self.assertRaises(ValueError):
                m.submit(self.path, self.body(action='blocked', **changes))
        state = m.submit(self.path, self.body(action='blocked', reason_code='access', reason='블로그 편집 권한이 없습니다.'))
        self.assertEqual((state['completed'], state['current']['id']), (0, 'access'))
        self.assertIn('수정 요청 초안', state['current']['retry'])
        self.assertEqual(state['history'][0]['reason'], '블로그 편집 권한이 없습니다.')
        state = m.submit(self.path, self.body(note='담당자가 공개 페이지를 확인했습니다.', evidence_url='https://example.com/branch'))
        self.assertEqual((state['completed'], state['current']['id']), (1, 'identity'))
        v.init_db(self.path)  # A restart/migration cannot reset the user's work.
        self.assertEqual(self.state(), state)
        self.assertFalse(self.item['mentioned'])

    def test_idempotent_retry_concurrent_completion_and_stale_revision(self):
        body = self.body()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: m.submit(self.path, deepcopy(body)), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(self.state()['history']), 1)
        with self.assertRaises(m.Conflict):
            m.submit(self.path, {**body, 'request_id': str(uuid.uuid4())})
        with self.assertRaises(m.Conflict):
            m.submit(self.path, {**body, 'note': '다른 작업'})

    def test_tracks_distinguish_missing_evidence_and_observed_mention(self):
        for item in ({**self.item, 'status': 'error'}, {**self.item, 'stale': True},
                     {**self.item, 'branch_result': {'branch_unconfirmed': True}}):
            self.assertEqual(m.track_for(item), 'verify')
        self.assertEqual(m.track_for(self.item), 'improve')
        mentioned = {**self.item, 'branch_result': {'mentioned': True}}
        self.assertEqual(m.track_for(mentioned), 'maintain')
        self.assertEqual(self.state(item=mentioned)['current']['id'], 'preserve')
        m.submit(self.path, self.body())
        self.assertEqual(self.state(item=mentioned)['current']['id'], 'identity')
        self.assertEqual(self.state('gemini')['completed'], 0)
        self.assertEqual(self.state(item={**self.item, 'branch': 'anyang'})['completed'], 0)
        self.assertEqual(self.state(item={**self.item, 'keyword': '다른 질문'})['completed'], 0)

    def test_all_steps_finish_and_cannot_skip(self):
        with self.assertRaises(m.Conflict):
            m.submit(self.path, self.body(mission_id='review'))
        for expected in ('identity', 'answer', 'evidence', 'review', None):
            state = m.submit(self.path, self.body())
            self.assertEqual(state['current']['id'] if state['current'] else None, expected)
        self.assertEqual(state['completed'], state['total'])
        self.assertEqual(len(state['history']), 5)

    def test_request_validation(self):
        for changes in ({'action':'skip'}, {'reason':[]}, {'note':'x'*1501}, {'revision':True},
                        {'evidence_url':'javascript:alert(1)'}, {'evidence_url':'https://user:pass@example.com'},
                        {'request_id':'bad'}):
            with self.assertRaises(ValueError):
                m.submit(self.path, self.body(**changes))
        with self.assertRaises(LookupError):
            m.submit(self.path, self.body(keyword='unregistered'))
        with self.assertRaises(ValueError):
            m.submit(self.path, [])

    def test_http_submission_errors_origin_and_response(self):
        with patch.object(v, 'db_path', return_value=self.path):
            server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.App)
            thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
            try:
                for body, headers, expected in (
                    (self.body(), {'Origin':'https://other.example'}, 403),
                    ([], {}, 400),
                    (self.body(action='blocked'), {}, 400),
                    (self.body(), {}, 200)):
                    conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
                    conn.request('POST', '/api/search-visibility/missions', json.dumps(body), {'Content-Type':'application/json', **headers})
                    response = conn.getresponse();result = json.loads(response.read());conn.close()
                    self.assertEqual(response.status, expected)
                    self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                    if expected == 200:
                        self.assertEqual(result['mission']['current']['id'], 'identity')
            finally:
                server.shutdown();server.server_close();thread.join()


class EnabledKeywordsTests(unittest.TestCase):
    def test_only_on_rows_survive_deduplication_even_when_inventory_is_stale(self):
        rows = [{'keyword':'인천요양원','group':'OFF','eligible':False,'average_rank':1},
                {'keyword':'인천요양원','group':'ON','eligible':True,'average_rank':4},
                {'keyword':'중지키워드','group':'OFF','eligible':False,'average_rank':2}]
        for stale in (False, True):
            report = {'updated_at':'2026-09-11','stale':stale,'items':rows}
            with patch.object(v.naver_ads, 'keyword_report', return_value=report):
                queries, _ = v.naver_queries('unused', datetime.now(v.KST), {}, show_stale=True)
                self.assertEqual(len(queries), 1)
                self.assertEqual(queries[0]['groups'], ['ON'])
                self.assertEqual(queries[0]['average_ad_rank'], 4)
                collected, _ = v.naver_queries('unused', datetime.now(v.KST), {})
                self.assertEqual(len(collected), 0 if stale else 1)

    def test_all_off_has_no_fallback_and_on_is_distinct_from_delivery_eligibility(self):
        rows = [{'keyword':'OFF','group':'A','eligible':True,'enabled':False},
                {'keyword':'심사대기지만ON','group':'A','eligible':False,'enabled':True}]
        self.assertEqual([q['keyword'] for q in v.active_keyword_queries(rows)], ['심사대기지만ON'])
        report = {'updated_at':'2026-09-11','stale':False,'items':rows[:1]}
        with patch.object(v.naver_ads, 'keyword_report', return_value=report):
            self.assertEqual(v.naver_queries('unused', datetime.now(v.KST), {}, show_stale=True)[0], [])
        self.assertFalse(v.naver_ads.switched_on({'status':'ELIGIBLE','userLock':True}))
        self.assertFalse(v.naver_ads.switched_on({'status':'PAUSED','userLock':False}))
        self.assertFalse(v.naver_ads.switched_on({}))
        self.assertTrue(v.naver_ads.switched_on({'status':'PENDING','userLock':False}))


if __name__ == '__main__':
    unittest.main()
