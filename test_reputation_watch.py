"""Synthetic test sentences are not allegations about any actual facility."""
from datetime import datetime, timedelta
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import app
import reputation_watch as r

NOW = datetime(2026, 9, 9, 12, tzinfo=r.KST)
EVIDENCE = '가상 테스트 문장: 응대가 불친절했다는 의견'


def result(item, verdict='concern', evidence=EVIDENCE):
    return {'id': item['id'], 'verdict': verdict, 'evidence': evidence if verdict in {'concern', 'uncertain'} else '',
            'category': 'staff' if verdict in {'concern', 'uncertain'} else 'none', 'identity': 'brand'}


def response(rows):
    return {'status': 'completed', 'output': [{'type': 'message', 'content': [
        {'type': 'output_text', 'text': json.dumps({'items': rows}, ensure_ascii=False)}]}]}


class ReputationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'reputation.db'
        r.init_db(self.path)
        self.sources = r.SOURCES[:2]
        self.source_patch = patch.object(r, 'SOURCES', self.sources)
        self.source_patch.start(); self.addCleanup(self.source_patch.stop)
        self.env = patch.dict(os.environ, {'OPENAI_API_KEY': 'unit-test-secret', 'SERPAPI_KEY': ''})
        self.env.start(); self.addCleanup(self.env.stop)
        self.item = r.document('더비다요양원 · 가상 테스트 자료', EVIDENCE, 'https://example.test/post/1', self.sources[0])

    def collect(self, source, now, stop=None):
        return {'documents': [{**self.item, 'source_ids': [source['id']]}], 'pages': 1, 'scanned': 1}

    def classify(self, items):
        return [result(item) for item in items]

    def sync(self, now=NOW, collector=None, classifier=None):
        r.sync(self.path, now, collector=collector or self.collect, classifier=classifier or self.classify)

    def test_canonical_blog_identity_tracking_and_unsafe_links(self):
        expected='https://blog.naver.com/vida25/123'
        self.assertEqual(r.canonical_url('https://m.blog.naver.com/vida25/123?utm_source=x#x'),expected)
        self.assertEqual(r.canonical_url('https://blog.naver.com/PostView.naver?blogId=vida25&logNo=123'),expected)
        for value in ('javascript:alert(1)','https://user:secret@example.com','https://adcr.naver.com/click'):
            self.assertEqual(r.canonical_url(value),'')
        self.assertIsNone(r.document('비다 쇼핑몰 불만','', 'https://example.test/post/1', self.sources[0]))

    def test_search_uses_actual_snippet_not_publisher_ai_description_or_ads(self):
        html='''<div class="fds-web-doc-root">게시자 일반 AI 설명: 가상 사고
        <a data-heatmap-target=".link" href="https://example.test/vida">사이트</a>
        <a data-heatmap-target=".link" href="https://example.test/vida">더비다요양원 안내</a>
        <a data-heatmap-target=".link" href="https://example.test/vida">안전 예방교육 안내입니다.</a></div>
        <a class="lnk_tit" href="https://adcr.naver.com/click">더비다요양원 광고</a>'''
        data=r.fetch_source(self.sources[0], NOW, fetcher=lambda _:html)
        self.assertEqual(len(data['documents']),1)
        self.assertEqual(data['documents'][0]['excerpt'],'안전 예방교육 안내입니다.')
        self.assertNotIn('가상 사고',data['documents'][0]['excerpt'])

    def test_classifier_accepts_only_complete_verbatim_evidence_and_known_ids(self):
        calls=[]
        def request(url,payload,headers):calls.append(payload);return response([result(self.item)])
        rows=r.classify([self.item],request)
        self.assertEqual(rows[0]['evidence'],EVIDENCE)
        self.assertFalse(calls[0]['store']);self.assertNotIn('tools',calls[0])
        self.assertEqual(calls[0]['text']['format']['type'],'json_schema')
        for rows in ([],[result(self.item),result(self.item)],[{**result(self.item),'id':'unknown'}],
                     [result(self.item,evidence='입력에 없는 피해 내용을 지어냄')],[result(self.item,evidence='짧음')]):
            with self.assertRaises(ValueError):r.classify([self.item],lambda *args:response(rows))
        with self.assertRaises(ValueError):r.classify([self.item],lambda *args:{'status':'incomplete'})

    def test_uncertain_identity_cannot_become_a_confirmed_brand_concern(self):
        rows=r.classify([self.item],lambda *args:response([{**result(self.item),'identity':'unknown'}]))
        self.assertEqual(rows[0]['verdict'],'uncertain')

    def test_deduplication_restart_cache_new_day_history_and_stable_new_identity(self):
        classifier=unittest.mock.Mock(side_effect=self.classify)
        self.sync(classifier=classifier)
        first=r.report(self.path,NOW)
        self.assertTrue(first['sync']['complete']);self.assertEqual(first['counts']['documents'],1)
        self.assertEqual(first['documents'][0]['source_ids'],[s['id'] for s in self.sources])
        self.sync(NOW+timedelta(minutes=5),classifier=classifier)
        self.sync(NOW+timedelta(days=1),classifier=classifier)
        second=r.report(self.path,NOW+timedelta(days=1))
        self.assertEqual(classifier.call_count,1)
        self.assertEqual(first['article_ids'],second['article_ids'])
        self.assertEqual(len(second['history']),2)
        self.assertEqual(second['items'][0]['first_detected'],NOW.isoformat())
        self.assertEqual(second['items'][0]['last_detected'],(NOW+timedelta(days=1)).isoformat())

    def test_source_failure_keeps_prior_findings_and_cannot_report_all_clear(self):
        self.sync()
        def failure(*args,**kwargs):raise TimeoutError('private error details')
        self.sync(NOW+timedelta(days=1),collector=failure)
        report=r.report(self.path,NOW+timedelta(days=1))
        self.assertFalse(report['sync']['complete']);self.assertEqual(report['counts']['concern'],1)
        self.assertFalse(report['items'][0]['seen_in_latest_search'])
        self.assertEqual(report['updated_at'],NOW.isoformat())
        self.assertNotIn('private error',json.dumps(report))

    def test_classifier_failure_does_not_mean_no_negative_information(self):
        def failure(items):raise TimeoutError('private-key-like-detail')
        self.sync(classifier=failure)
        report=r.report(self.path,NOW)
        self.assertEqual(report['sync']['checked_sources'],2)
        self.assertFalse(report['sync']['complete']);self.assertEqual(report['analysis']['pending'],1)
        self.assertTrue(report['analysis']['error']);self.assertEqual(report['history'],[])
        self.assertNotIn('private-key',json.dumps(report))

    def test_interrupted_paid_classification_waits_before_retry(self):
        def interrupted(items):raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):self.sync(classifier=interrupted)
        callback=unittest.mock.Mock(side_effect=self.classify)
        self.sync(NOW+timedelta(minutes=1),classifier=callback)
        callback.assert_not_called()
        self.sync(NOW+timedelta(minutes=31),classifier=callback)
        self.assertEqual(callback.call_count,1)

    def test_source_retry_is_limited_and_successful_sources_are_not_repeated(self):
        calls=[]
        def collect(source,now,stop=None):
            calls.append(source['id'])
            if source==self.sources[0]:raise TimeoutError()
            return self.collect(source,now,stop)
        for minutes in (0,1,30,61,100):self.sync(NOW+timedelta(minutes=minutes),collector=collect)
        self.assertEqual(calls.count(self.sources[0]['id']),2)
        self.assertEqual(calls.count(self.sources[1]['id']),1)

    def test_access_restriction_stops_remaining_naver_queries(self):
        calls=[]
        def blocked(source,now,stop=None):
            calls.append(source['id'])
            raise urllib.error.HTTPError(source['url'],403,'Forbidden',{},None)
        self.sync(collector=blocked)
        self.sync(NOW+timedelta(minutes=31),collector=blocked)
        self.assertEqual(len(calls),1)
        report=r.report(self.path,NOW)
        self.assertTrue(all(source['error'] for source in report['sources']))
        self.assertFalse(report['sync']['complete'])

    def test_changed_source_can_leave_review_queue_without_erasing_prior_evidence(self):
        self.sync()
        old_ids=r.report(self.path,NOW)['article_ids']
        self.item={**self.item,'excerpt':'가상 테스트 문장: 현재 시설 안내입니다.'}
        self.sync(NOW+timedelta(days=1),classifier=lambda items:[result(item,'neutral') for item in items])
        report=r.report(self.path,NOW+timedelta(days=1))
        self.assertEqual(report['counts']['concern'],0);self.assertEqual(report['counts']['archived'],1)
        self.assertEqual(report['article_ids'],[])
        self.assertEqual(report['items'][0]['evidence'],EVIDENCE)
        self.assertEqual(report['items'][0]['revision'],old_ids[0])

    def test_a_cached_previous_version_restores_its_own_evidence_not_a_newer_quote(self):
        original=dict(self.item)
        self.sync()
        self.item={**self.item,'excerpt':'다른 가상 테스트 문장: 불편했다는 의견'}
        self.sync(NOW+timedelta(days=1),classifier=lambda items:[result(item,evidence=item['excerpt']) for item in items])
        self.item=original
        callback=unittest.mock.Mock(side_effect=self.classify)
        self.sync(NOW+timedelta(days=2),classifier=callback)
        callback.assert_not_called()
        self.assertEqual(r.report(self.path,NOW+timedelta(days=2))['items'][0]['evidence'],EVIDENCE)

    def test_schedule_and_no_results_are_bounded_to_successful_source_checks(self):
        boundary=NOW.replace(hour=9,minute=30)
        self.assertEqual(r.due_at(boundary),boundary)
        self.assertEqual(r.due_at(boundary-timedelta(seconds=1)),boundary-timedelta(days=1))
        self.sync(collector=lambda *args,**kwargs:{'documents':[],'scanned':0,'pages':1})
        report=r.report(self.path,NOW)
        self.assertTrue(report['sync']['complete']);self.assertEqual(report['counts']['documents'],0)

    def test_api_is_read_only_and_does_not_publish_private_files_or_api_keys(self):
        self.sync()
        with patch.object(r,'db_path',return_value=self.path),patch.object(r,'sync') as collector:
            server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                for method in ('GET','HEAD'):
                    conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                    conn.request(method,'/api/reputation-watch?summary=1')
                    response=conn.getresponse();body=response.read()
                    self.assertEqual(response.status,200);self.assertEqual(response.getheader('Cache-Control'),'no-store')
                    self.assertNotIn(b'unit-test-secret',body);conn.close()
                conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                conn.request('GET','/reputation_watch.py');response=conn.getresponse();response.read()
                self.assertEqual(response.status,404);conn.close();collector.assert_not_called()
            finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
