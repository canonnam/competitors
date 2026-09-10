from copy import deepcopy
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

import app
import agency_news as news
import business_support as biz
from test_business_support import NOW, SOURCE, detail, detail_html, listing


class SupportPreferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'agency.db'
        news.init_db(self.path)
        news.sync(self.path, NOW, lambda url: listing([1, 2, 3]) if 'View.do' in url else detail_html(detail()), [SOURCE])
        with news.connect(self.path) as db:
            for row in db.execute('SELECT * FROM articles').fetchall():
                item = json.loads(row['payload'])
                item['topics'] = ['돌봄'] if item['id'].endswith(('_1', '_2')) else ['연구개발']
                item['score'] = 20
                db.execute('UPDATE articles SET payload=? WHERE id=?', (json.dumps(item), item['id']))
            self.public = {'id': 'news', 'kind': 'mohw', 'published_at': '2026-09-09', 'title': '공공기관 소식'}
            db.execute('INSERT INTO articles VALUES (?,?,?)', ('news', '2026-09-09', json.dumps(self.public)))

    def choose(self, preference, identity='bizinfo:PBLN_1'):
        biz.save_preference(self.path, identity, preference, NOW)

    def report(self):
        return news.report(self.path, NOW)

    def supports(self):
        return [item for item in self.report()['items'] if item.get('kind') == 'support']

    def test_interest_promotes_selected_and_similar_new_candidates_only(self):
        before = self.supports()
        self.assertEqual([item['id'] for item in before], ['bizinfo:PBLN_3', 'bizinfo:PBLN_2', 'bizinfo:PBLN_1'])
        self.choose('interested')
        after = self.supports()
        self.assertEqual([item['id'] for item in after], ['bizinfo:PBLN_1', 'bizinfo:PBLN_2', 'bizinfo:PBLN_3'])
        self.assertGreater(after[1]['recommendation_score'], after[2]['recommendation_score'])
        self.assertEqual(self.report()['items'][0], self.public)
        newcomer = {**after[1], 'id': 'bizinfo:PBLN_4', 'published_at': '2026-09-09'}
        with news.connect(self.path) as db:
            db.execute('INSERT INTO articles VALUES (?,?,?)', (newcomer['id'], newcomer['published_at'], json.dumps(newcomer)))
        self.assertGreater(next(item for item in self.supports() if item['id']==newcomer['id'])['preference_score'], 0)

    def test_dislike_lowers_similar_topics_and_excludes_selected_from_home_alerts(self):
        self.choose('not_interested')
        after = self.supports()
        self.assertEqual([item['id'] for item in after], ['bizinfo:PBLN_3', 'bizinfo:PBLN_2', 'bizinfo:PBLN_1'])
        self.assertLess(after[1]['recommendation_score'], after[0]['recommendation_score'])
        report = self.report()
        self.assertEqual(report['support']['active'], 2)
        self.assertNotIn('bizinfo:PBLN_1', report['article_ids'])
        self.assertTrue(after[-1]['application_status']['active'])
        self.assertEqual(news.report(self.path, NOW, summary=True)['support'], report['support'])

    def test_repeated_choice_switch_cancel_restart_and_crawl_preserve_correct_weights(self):
        original = self.supports()
        self.choose('interested')
        selected = self.supports()
        self.choose('interested')
        news.init_db(self.path)
        self.assertEqual(self.supports(), selected)
        news.sync(self.path, NOW, lambda url: listing([1, 2, 3]) if 'View.do' in url else detail_html(detail()), [SOURCE])
        self.assertEqual(self.supports(), selected)
        self.choose('not_interested')
        self.assertEqual(self.supports()[1]['preference_score'], -12)
        self.choose('neutral')
        self.assertEqual(self.supports(), original)
        self.choose('neutral')
        with news.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM support_preferences').fetchone()[0], 0)

    def test_positive_feedback_never_reactivates_expired_or_withdrawn_programs(self):
        self.choose('interested')
        with news.connect(self.path) as db:
            row = db.execute('SELECT payload FROM articles WHERE id=?', ('bizinfo:PBLN_1',)).fetchone()
            item = json.loads(row[0]);item['withdrawn'] = True
            db.execute('UPDATE articles SET payload=? WHERE id=?', (json.dumps(item), item['id']))
        self.assertNotIn('bizinfo:PBLN_1', self.report()['article_ids'])
        self.assertEqual(self.supports()[-1]['application_status']['label'], '추천 제외')
        from datetime import timedelta
        self.assertEqual(news.report(self.path, NOW+timedelta(days=100))['support']['active'], 0)

    def test_topic_adjustment_is_bounded_and_does_not_modify_base_score(self):
        items = deepcopy(self.supports())
        preferences = {str(i): {'preference': 'interested', 'topics': '["돌봄"]'} for i in range(20)}
        biz.apply_preferences(items, preferences)
        self.assertTrue(all(item['score']==20 for item in items))
        self.assertEqual(max(item['preference_score'] for item in items), 40)
        for value in preferences.values(): value['preference']='not_interested'
        biz.apply_preferences(items, preferences)
        self.assertEqual(min(item['preference_score'] for item in items), -40)

    def test_api_validates_inputs_origin_and_storage_failures_without_webhooks(self):
        server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.App)
        worker = threading.Thread(target=server.serve_forever, daemon=True);worker.start()
        def request(body, headers=None, raw=None):
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            conn.request('POST', '/api/agency-news/support-preference', json.dumps(body) if raw is None else raw,
                         {'Content-Type': 'application/json', **(headers or {})})
            response = conn.getresponse();payload = json.loads(response.read());conn.close()
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            return response.status, payload
        body = {'article_id': 'bizinfo:PBLN_1', 'preference': 'interested'}
        try:
            with patch.object(news, 'db_path', return_value=self.path), patch.object(app, 'post_json') as webhook:
                self.assertEqual(request(body), (200, body))
                self.assertEqual(self.supports()[0]['preference'], 'interested')
                for invalid in [[], None, {}, {**body, 'preference': []}, {**body, 'preference': 'yes'}, {**body, 'article_id': '../news'}]:
                    self.assertEqual(request(invalid)[0], 400)
                self.assertEqual(request({**body, 'article_id': 'bizinfo:PBLN_999'})[0], 404)
                self.assertEqual(request(body, {'Origin': 'https://evil.example'})[0], 403)
                self.assertEqual(request(body, {'Sec-Fetch-Site': 'cross-site'})[0], 403)
                self.assertEqual(request(body, {'Content-Type': 'text/plain'})[0], 415)
                self.assertEqual(request(body, raw='{broken')[0], 400)
                self.assertEqual(request(body, raw='x'*1025)[0], 413)
                with patch.object(biz, 'save_preference', side_effect=sqlite3.OperationalError('private DB path')):
                    code, payload = request(body)
                    self.assertEqual(code, 503);self.assertNotIn('private', payload['error'])
                webhook.assert_not_called()
                self.assertEqual(request({**body, 'preference': 'neutral'})[0], 200)
        finally:
            server.shutdown();server.server_close();worker.join(5)


if __name__ == '__main__': unittest.main()
