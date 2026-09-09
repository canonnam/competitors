"""Exercise real RSS parsing, archive updates, KST scheduling and HTTP delivery."""
from datetime import datetime, timedelta
from email.utils import format_datetime
from html import escape
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import app
import competitor_news as news

NOW = datetime(2026, 9, 8, 18, tzinfo=news.KST)
SEED_COUNT = len(json.loads((news.ROOT / 'data/competitor_news_seed.json').read_text(encoding='utf-8')))
TARGET = next(row for row in news.TARGETS if row['id'] == 'caredoc')


def feed(title='케어닥, 새로운 돌봄 서비스 발표', link='https://news.google.com/rss/articles/unique-news?oc=5',
         published=None, source='테스트신문'):
    return ('<rss><channel><title>뉴스 검색</title><item><title>' + escape(title + ' - ' + source)
            + '</title><link>' + escape(link) + '</link><pubDate>' + format_datetime(published or NOW)
            + '</pubDate><source>' + escape(source) + '</source></item></channel></rss>').encode()


class NewsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'news.db'
        news.init_db(self.path)

    def test_seed_survives_restarts_and_summary_omits_article_bodies(self):
        news.init_db(self.path)
        report = news.report(self.path, NOW)
        self.assertEqual(report['total'], SEED_COUNT)
        self.assertTrue(all(item['reviewed'] and item['summary'] for item in report['items']))
        self.assertNotIn('items', news.report(self.path, NOW, summary=True))
        self.assertEqual(set(report['article_ids']), {item['id'] for item in report['items']})
        self.assertEqual(news.report(self.path, NOW, summary=True)['article_ids'], report['article_ids'])

    def test_existing_archive_receives_new_reviewed_seed_without_losing_rss(self):
        item = next(row for row in news.report(self.path, NOW)['items'] if row['competitor_id'] == 'cleverus')
        news.sync(self.path, NOW, lambda _: feed(), [TARGET])
        with news.connect(self.path) as db:
            db.execute('DELETE FROM articles WHERE id=?', (item['id'],))
            db.execute("DELETE FROM state WHERE key='seed_revision'")
        news.init_db(self.path)
        self.assertIn(item, news.report(self.path, NOW)['items'])
        self.assertEqual(news.report(self.path, NOW)['total'], SEED_COUNT + 1)
        self.assertEqual(news.report(self.path, NOW)['updated_at'], NOW.isoformat())

    def test_reviewed_seed_enriches_prior_headline_and_keeps_its_identity(self):
        original = news.report(self.path, NOW)['items'][0]
        headline = {**original, 'id': 'earlier-rss-id', 'summary': '', 'reviewed': False}
        with news.connect(self.path) as db:
            db.execute('DELETE FROM articles WHERE id=?', (original['id'],))
            news.put_article(db, headline)
            db.execute("DELETE FROM state WHERE key='seed_revision'")
        news.init_db(self.path)
        updated = next(row for row in news.report(self.path, NOW)['items'] if row['id'] == 'earlier-rss-id')
        self.assertEqual(updated['summary'], original['summary'])
        self.assertTrue(updated['reviewed'])
        self.assertEqual(news.report(self.path, NOW)['total'], SEED_COUNT)

    def test_retired_supplier_is_hidden_from_list_summary_and_shared_reader(self):
        original = news.report(self.path, NOW)['items'][0]
        retired = {**original, 'id': 'retired-id', 'url': 'https://example.org/retired',
                   'title': '이로움케어 과거 기사', 'competitor_id': 'eroum', 'competitor': '이로움케어'}
        with news.connect(self.path) as db:
            news.put_article(db, retired)
        for summary in (False, True):
            report = news.report(self.path, NOW, summary=summary)
            self.assertEqual(report['total'], SEED_COUNT)
            self.assertNotIn('retired-id', report['article_ids'])
            self.assertNotIn(retired, report.get('items', []))
        with news.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM articles').fetchone()[0], SEED_COUNT + 1)
            self.assertNotIn(retired, news.active_articles(db))

    def test_target_change_triggers_collection_and_restarts_preserve_success(self):
        news.sync(self.path, NOW, lambda _: feed(), [TARGET])
        with news.connect(self.path) as db:
            news.write_state(db, 'target_revision', 'old-targets')
        news.init_db(self.path)
        self.assertIsNone(news.report(self.path, NOW)['updated_at'])
        news.sync(self.path, NOW, lambda _: feed(), [TARGET])
        news.init_db(self.path)
        self.assertEqual(news.report(self.path, NOW)['updated_at'], NOW.isoformat())

    def test_facility_safety_targets_reject_namesakes_and_unrelated_business(self):
        targets = {row['id']: row for row in news.TARGETS}
        self.assertNotIn('eroum', targets)
        self.assertTrue(news.relevant('클레버러스, 서초빌리지에 비클레버 구축', targets['cleverus']))
        self.assertTrue(news.relevant('인지니어스, AI 레이더 낙상 감지 개발', targets['inzinious']))
        self.assertFalse(news.relevant('투모로로보틱스, 인텔 인지니어스 프로그램 선정', targets['inzinious']))
        self.assertTrue(news.relevant('스페이스뱅크, 요양원 휴먼케어 구축', targets['spacebank']))
        self.assertFalse(news.relevant('스페이스뱅크, 발전소 산업 DX 협약', targets['spacebank']))

    def test_real_rss_shape_cleans_markup_and_removes_tracking_query(self):
        item, = news.parse_feed(feed(title='<b>케어닥</b>, 새로운 돌봄 서비스 발표'), TARGET, NOW)
        self.assertEqual(item['title'], '케어닥, 새로운 돌봄 서비스 발표')
        self.assertEqual(item['source'], '테스트신문')
        self.assertEqual(item['url'], 'https://news.google.com/rss/articles/unique-news')
        self.assertFalse(item['reviewed'])
        self.assertEqual(item['summary'], '')
        item, = news.parse_feed(feed(title='케어닥, 돌봄 사업 확대 - 테스트신문'), TARGET, NOW)
        self.assertEqual(item['title'], '케어닥, 돌봄 사업 확대')

    def test_duplicate_feed_url_and_normalized_headline_are_inserted_once(self):
        news.sync(self.path, NOW, lambda _: feed(), [TARGET])
        first_ids = news.report(self.path, NOW, summary=True)['article_ids']
        news.sync(self.path, NOW, lambda _: feed(link='https://news.google.com/rss/articles/second-url'), [TARGET])
        news.sync(self.path, NOW, lambda _: feed(title='케어닥 : 새로운 돌봄 서비스 발표'), [TARGET])
        self.assertEqual(news.report(self.path, NOW)['total'], SEED_COUNT + 1)
        self.assertEqual(news.report(self.path, NOW, summary=True)['article_ids'], first_ids)

    def test_rss_never_replaces_reviewed_summary(self):
        original = news.report(self.path, NOW)['items'][0]
        raw = feed(title=original['title'], published=datetime.fromisoformat(original['published_at']))
        news.sync(self.path, NOW, lambda _: raw, [TARGET])
        self.assertEqual(news.report(self.path, NOW)['total'], SEED_COUNT)
        self.assertIn(original, news.report(self.path, NOW)['items'])

    def test_relevance_and_publication_window_exclude_unrelated_old_and_future_items(self):
        for raw in [feed(title='다른 회사의 돌봄'), feed(published=NOW-timedelta(days=31)), feed(published=NOW+timedelta(minutes=1))]:
            self.assertEqual(news.parse_feed(raw, TARGET, NOW), [])
        jipangi = next(row for row in news.TARGETS if row['id'] == 'jipangi')
        self.assertFalse(news.relevant('어르신에게 스마트 지팡이 보급', jipangi))
        self.assertTrue(news.relevant('지팡이, 장기요양 ERP 업데이트', jipangi))
        skt = next(row for row in news.TARGETS if row['id'] == 'skt')
        self.assertFalse(news.relevant('SKT, 스마트폰 신제품 발표', skt))
        self.assertTrue(news.relevant('SKT, AI 돌봄 서비스 확대', skt))
        carefor = next(row for row in news.TARGETS if row['id'] == 'carefor')
        self.assertFalse(news.relevant('케이에스넷, 예금토큰 결제망 한강시스템 연계', carefor))
        self.assertTrue(news.relevant('케어포, 병원동행 시범서비스 공개', carefor))

    def test_unsafe_urls_and_invalid_feeds_do_not_count_as_success(self):
        for raw in [b'<html>blocked</html>', b'<rss/>', b'not xml',
                    b'<!DOCTYPE rss [<!ENTITY x "bad">]><rss/>',
                    feed(link='javascript:alert(1)'), feed(link='https://news.google.com.evil.test/rss/articles/1'),
                    feed(link='https://127.0.0.1/private'), feed(link='https://news.google.com/other'),
                    b'x' * (news.MAX_FEED_BYTES+1)]:
            with self.subTest(raw=raw[:50]), self.assertRaises((ValueError, news.ET.ParseError)):
                news.parse_feed(raw, TARGET, NOW)

    def test_failure_preserves_archive_and_last_success_and_retries_in_thirty_minutes(self):
        news.sync(self.path, NOW, lambda _: feed(), [TARGET])
        before = news.report(self.path, NOW)
        later = NOW + timedelta(days=1)
        news.sync(self.path, later, lambda _: b'<html>unavailable</html>', [TARGET])
        after = news.report(self.path, later)
        self.assertEqual(after['items'], before['items'])
        self.assertEqual(after['updated_at'], before['updated_at'])
        self.assertTrue(after['sync']['stale'])
        self.assertEqual(after['sync']['errors'], ['케어닥'])
        self.assertEqual(after['sync']['next_run'], (later+timedelta(minutes=30)).isoformat())

    def test_partial_success_keeps_new_articles_and_exposes_failed_competitor(self):
        other = next(row for row in news.TARGETS if row['id'] == 'caring')
        news.sync(self.path, NOW, lambda target: feed() if target == TARGET else b'bad', [TARGET, other])
        report = news.report(self.path, NOW)
        self.assertEqual(report['total'], SEED_COUNT + 1)
        self.assertIsNone(report['updated_at'])
        self.assertEqual(report['sync']['errors'], ['케어링'])

    def test_valid_empty_feed_is_success_and_preserves_existing_articles(self):
        news.sync(self.path, NOW, lambda _: b'<rss><channel><title>No news</title></channel></rss>', [TARGET])
        report = news.report(self.path, NOW)
        self.assertEqual(report['total'], SEED_COUNT)
        self.assertEqual(report['updated_at'], NOW.isoformat())
        self.assertFalse(report['sync']['stale'])

    def test_schedule_at_nine_kst_and_restart_catchup(self):
        before = datetime(2026, 9, 9, 8, 59, tzinfo=news.KST)
        boundary = before + timedelta(minutes=1)
        state = {'last_success': NOW.isoformat()}
        self.assertEqual(news.next_run(state, before), boundary)
        self.assertEqual(news.next_run(state, boundary), boundary)
        after = boundary + timedelta(hours=2)
        self.assertEqual(news.next_run(state, after), after)
        self.assertEqual(news.next_run({'last_success': boundary.isoformat()}, after), boundary+timedelta(days=1))

    def test_archive_keeps_prior_records_and_orders_newest_first(self):
        for index in range(3):
            news.sync(self.path, NOW+timedelta(minutes=index), lambda _, i=index: feed(
                title=f'케어닥, 돌봄 서비스 {i}', link=f'https://news.google.com/rss/articles/story-{i}',
                published=NOW+timedelta(minutes=i)), [TARGET])
        report = news.report(self.path, NOW)
        self.assertEqual(report['total'], SEED_COUNT + 3)
        self.assertEqual(sum(item['reviewed'] for item in report['items']), SEED_COUNT)
        self.assertEqual([item['title'] for item in report['items'][:3]], [f'케어닥, 돌봄 서비스 {i}' for i in (2, 1, 0)])

    def test_overlapping_runs_and_disabled_scheduler_make_no_requests(self):
        with news.SYNC_LOCK:
            self.assertIsNone(news.sync(self.path, NOW, lambda _: self.fail('Overlapping fetch'), [TARGET]))
        with patch.dict(news.os.environ, {'COMPETITOR_NEWS_SYNC_ENABLED': 'false'}), patch.object(news.threading, 'Thread') as worker:
            news.start_scheduler(self.path)
            worker.assert_not_called()
            self.assertFalse(news.report(self.path, NOW)['sync']['enabled'])


class NewsEndpointTests(unittest.TestCase):
    def test_get_head_summary_and_private_source_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'news.db'
            news.init_db(path)
            server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.App)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(news, 'db_path', return_value=path):
                    for method, route in [('GET', '/api/competitor-news'), ('HEAD', '/api/competitor-news'), ('GET', '/api/competitor-news?summary=1')]:
                        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                        conn.request(method, route)
                        response = conn.getresponse(); raw = response.read()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                        self.assertIn('noindex', response.headers['X-Robots-Tag'])
                        if method == 'HEAD':
                            self.assertEqual(raw, b'')
                        else:
                            body = json.loads(raw)
                            self.assertEqual(body['total'], SEED_COUNT)
                            self.assertEqual('items' in body, 'summary' not in route)
                        conn.close()
                    for route in ['/competitor_news.py', '/data/news_targets.json', '/data/competitor_news_seed.json']:
                        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                        conn.request('GET', route)
                        response = conn.getresponse(); response.read()
                        self.assertEqual(response.status, 404)
                        conn.close()
            finally:
                server.shutdown(); server.server_close(); thread.join(5)


if __name__ == '__main__':
    unittest.main()
