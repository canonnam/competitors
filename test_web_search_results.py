from copy import deepcopy
from datetime import datetime, timedelta
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

import app
import search_visibility as v
import web_search_results as w
import aeo_missions as m

NOW = datetime(2026, 9, 12, 11, 0, tzinfo=v.KST)


class WebResultsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'visibility.db'
        self.adpath = Path(self.temp.name)/'ads.db'
        v.init_db(self.path);v.naver_ads.init_db(self.adpath)
        self.config = v.settings()
        self.query = self.config['ai_queries'][0]

    def body(self, **changes):
        return {'provider':'chatgpt_web', 'keyword':self.query['keyword'], 'branch':self.query['branch'],
                'request_id':str(uuid.uuid4()), 'observed_at':NOW.isoformat(), 'status':'ready',
                'answer':'더비다요양원 인천점은 인천 지역의 요양원입니다. 시설 정보를 확인하세요.',
                'session_context':'비로그인 · 새 대화', 'capture_method':'browser', 'model':'기본 모드',
                'search_confirmed':True, 'complete_answer':True, 'surfaces':['answer','places'],
                'sources':[{'url':'https://example.com/source','title':'화면 출처'}], **changes}

    def report(self, now=NOW, summary=False):
        return v.report(self.path, self.adpath, now, summary=summary)

    def item(self, now=NOW):
        return self.report(now)['providers'][1]['items'][0]

    def test_browser_record_shown_with_provenance_and_branch_specific_evidence(self):
        w.submit(self.path, self.body(), NOW)
        item = self.item()
        self.assertEqual(item['status'], 'ready')
        self.assertTrue(item['mentioned']);self.assertTrue(item['branch_result']['mentioned'])
        self.assertEqual(item['measurement_type'], 'consumer_web')
        self.assertEqual(item['session_context'], '비로그인 · 새 대화')
        self.assertEqual(item['citations'][0]['url'], 'https://example.com/source')
        self.assertEqual(self.report(summary=True)['providers'][1]['checked'], 1)
        self.assertEqual(self.report()['providers'][2]['checked'], 0)

    def test_legacy_api_rows_never_become_web_observations_and_collection_is_disabled(self):
        with v.connect(self.path) as db:
            db.execute('INSERT INTO observations VALUES (?,?,?,?,?)', ('openai',self.query['keyword'],'2026-09-12','old',json.dumps({'provider':'openai','keyword':self.query['keyword'],'answer':'더비다요양원 API 결과','mentioned':True})))
        self.assertEqual([p['id'] for p in self.report()['providers']], ['naver','chatgpt_web','gemini_web'])
        self.assertEqual(self.item()['status'], 'pending');self.assertNotIn('answer', self.item())
        for provider in ('openai','gemini','perplexity','chatgpt_web','gemini_web'):
            self.assertFalse(v.configured(provider))
            self.assertEqual(v.sync_provider(self.path,provider,[self.query],self.config,NOW), [])
        self.assertFalse(hasattr(v,'collect_ai'))

    def test_failure_preserves_previous_answer_without_claiming_absence(self):
        w.submit(self.path,self.body(),NOW)
        later = NOW+timedelta(hours=1)
        w.submit(self.path,self.body(observed_at=later.isoformat(),status='blocked',answer='',reason='로그인 필요'),later)
        item = self.item(later)
        self.assertEqual(item['status'], 'error');self.assertTrue(item['stale'])
        self.assertEqual(item['observed_at'], NOW.isoformat())
        self.assertIn('더비다',item['answer']);self.assertEqual(item['error'],'로그인 필요')
        self.assertEqual(self.report(later)['providers'][1]['checked'],0)
        self.assertEqual(len(item['history']),1)

    def test_freshness_and_missing_evidence_are_not_zero_exposure(self):
        self.assertEqual(self.item()['mission']['track'], 'foundation')
        w.submit(self.path,self.body(answer='다른 요양원을 비교하고 현장 상담을 통해 시설을 확인하세요.'),NOW)
        self.assertFalse(self.item()['mentioned']);self.assertEqual(self.item()['status'],'ready')
        tomorrow=NOW+timedelta(days=1)
        self.assertEqual(self.item(tomorrow)['status'],'pending')
        self.assertEqual(self.report(tomorrow)['providers'][1]['checked'],0)

    def test_time_evidence_provider_and_url_validation(self):
        bad=[{'search_confirmed':False},{'complete_answer':False},{'session_context':''},{'answer':'짧음'},
             {'observed_at':'2026-09-12T11:00:00'},{'observed_at':(NOW+timedelta(days=1)).isoformat()},
             {'conversation_url':'https://chatgpt.com.evil.test/share/test'}, {'conversation_url':'https://u:p@chatgpt.com/c/x'},
             {'sources':[{'url':'javascript:alert(1)'}]},{'surfaces':[]},{'surfaces':['invented']},
             {'status':'blocked','reason':''},{'capture_method':'api'},{'request_id':'invalid'}]
        for changes in bad:
            with self.subTest(changes=changes),self.assertRaises(ValueError):w.submit(self.path,self.body(**changes),NOW)
        with self.assertRaises(LookupError):w.submit(self.path,self.body(provider='openai'),NOW)
        with self.assertRaises(LookupError):w.submit(self.path,self.body(keyword='임의 질문'),NOW)

    def test_duplicate_delivery_does_not_create_another_observation(self):
        body=self.body();w.submit(self.path,body,NOW);w.submit(self.path,deepcopy(body),NOW)
        self.assertEqual(len(self.item()['history']),1)
        with self.assertRaises(ValueError):w.submit(self.path,{**body,'answer':'다른 내용을 담은 잘못된 중복 요청입니다.'},NOW)

    def test_mission_progress_survives_provider_migration(self):
        item={**self.query,'status':'ready','mentioned':False}
        self.assertEqual(m.plan_id('openai',item),m.plan_id('chatgpt_web',item))
        self.assertEqual(m.plan_id('gemini',item),m.plan_id('gemini_web',item))
        with v.connect(self.path) as db:
            db.execute('INSERT INTO aeo_plans VALUES (?,?,?)',(m.plan_id('openai',item),'improve',1))
            db.execute('INSERT INTO aeo_events(plan_id,request_id,mission_id,action,reason_code,reason,note,evidence_url,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                       (m.plan_id('openai',item),str(uuid.uuid4()),'access','complete','','','','',NOW.isoformat()))
        self.assertEqual(self.item()['mission']['completed'],1)
        self.assertEqual(self.item()['mission']['current']['id'],'identity')

    def test_http_record_submission_and_foreign_origin_rejection(self):
        with patch.object(v,'db_path',return_value=self.path):
            server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                for origin,expected in [('https://other.test',403),(f'http://127.0.0.1:{server.server_port}',200)]:
                    body=self.body(observed_at=datetime.now(v.KST).isoformat())
                    conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                    conn.request('POST','/api/search-visibility/web-results',json.dumps(body),{'Content-Type':'application/json','Origin':origin})
                    result=conn.getresponse();result.read();conn.close();self.assertEqual(result.status,expected)
            finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
