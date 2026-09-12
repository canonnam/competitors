"""Card coverage, read-only refresh, routing, scope and evidence regressions."""
from copy import deepcopy
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

import agency_news
import card_knowledge as cards
import claim_check
import competitor_news
import naver_ads
import reputation_watch
import search_visibility
import service_knowledge as service
import web_search_results
from test_claim_check import sample as claim_sample

NOW = datetime(2026, 9, 12, 11, tzinfo=service.KST)


class CardKnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.paths = {'AGENCY_NEWS_DB_PATH': self.root/'agency.db', 'NAVER_ADS_DB_PATH': self.root/'ads.db',
                      'SEARCH_VISIBILITY_DB_PATH': self.root/'visibility.db', 'REPUTATION_WATCH_DB_PATH': self.root/'reputation.db',
                      'CLAIM_CHECK_PATH': self.root/'claims.json', 'COMPETITOR_NEWS_DB_PATH': self.root/'news.db'}
        env = patch.dict(os.environ, {k: str(v) for k,v in self.paths.items()})
        env.start(); self.addCleanup(env.stop)
        for module in (agency_news, naver_ads, search_visibility, reputation_watch, competitor_news):
            module.init_db(module.db_path())

    def text(self, items):
        return '\n'.join(r['content'] for r in items)

    def test_registry_covers_every_homepage_card_and_source_links(self):
        homepage = (service.ROOT/'index.html').read_text(encoding='utf-8')
        pages = set(re.findall(r'<a href="(/[^"?#]+\.html)"', homepage))
        self.assertEqual(pages, set(service.PAGES.values()))
        self.assertEqual(len(service.status()), 12)
        for page in pages:
            self.assertEqual(service.safe_url(page), page)
            self.assertIn(repr(page), (service.ROOT/'assets/wiki-chat.js').read_text(encoding='utf-8'))

    def test_every_new_card_routes_without_operating_false_positive(self):
        questions = {'payroll': '인천점 근로계약서 사용법', 'claim_check': '안양점 청구 상태',
            'agency_news': '건보공단·복지부 뉴스', 'ai_hub': 'ERP에 연결할 AI 허브 데이터셋',
            'naver_ads': '더비다 인천점 이번달 광고비', 'search_visibility': '인천점 검색현황',
            'reputation': '안양점 평판 점검', 'nearby': '안양점 주변 주야간보호', 'statistics': '직원 휴게 공간 통계자료'}
        for kind, q in questions.items():
            with self.subTest(kind=kind):
                result = service.retrieve(q, today=NOW.date())
                self.assertEqual({r['dataset'] for r in result}, {kind})
                self.assertTrue(result)
                self.assertFalse(any('읽을 수 없습니다' in r['content'] for r in result))

    def test_search_followup_overrides_branch_and_does_not_reuse_old_answer(self):
        history = [{'role': 'user', 'content': '인천점 검색노출 현황'}, {'role': 'assistant', 'content': 'OLD_FALSE_ANSWER'}]
        rows = service.retrieve('그럼 안양점은?', history, NOW.date())
        self.assertEqual({r['dataset'] for r in rows}, {'search_visibility'})
        self.assertIn('안양점:', self.text(rows))
        self.assertNotIn('인천점:', self.text(rows))
        self.assertNotIn('OLD_FALSE_ANSWER', self.text(rows))
        history += [{'role': 'user', 'content': '더비다 인천점 7월 운영손익'}]
        rows = service.retrieve('그럼 전월 대비는?', history, NOW.date())
        self.assertEqual({r['dataset'] for r in rows}, {'operating'})

    def test_saved_web_observation_refreshes_next_question_without_writes_or_collection(self):
        query = search_visibility.settings()['ai_queries'][0]
        def submit(answer, when):
            web_search_results.submit(search_visibility.db_path(), {
                'provider':'chatgpt_web', 'keyword':query['keyword'], 'branch':query['branch'], 'request_id':str(uuid.uuid4()),
                'observed_at':when.isoformat(), 'status':'ready', 'answer':answer, 'session_context':'PRIVATE_SESSION',
                'capture_method':'browser', 'model':'기본', 'search_confirmed':True, 'complete_answer':True, 'surfaces':['answer']}, when)
        submit('인천 지역의 다른 요양원을 비교하고 상담 정보를 확인하세요.', NOW)
        with patch.object(search_visibility, 'sync_provider', side_effect=AssertionError('No collection')):
            first = cards.retrieve('search_visibility', '인천점 ChatGPT 검색현황', NOW)
            self.assertIn('지점 언급 0개', self.text(first))
            later = NOW+timedelta(minutes=1)
            submit('더비다요양원 인천점은 인천 지역의 요양원입니다. 시설 정보를 확인하세요.', later)
            before = hashlib.sha256(search_visibility.db_path().read_bytes()).hexdigest()
            updated = cards.retrieve('search_visibility', '인천점 ChatGPT 검색현황', later)
            self.assertIn('지점 언급 1개', self.text(updated))
            self.assertIn(later.isoformat(), self.text(updated))
            self.assertNotIn('PRIVATE_SESSION', self.text(updated))
            self.assertEqual(before, hashlib.sha256(search_visibility.db_path().read_bytes()).hexdigest())
            self.assertEqual(len(updated), 1)

    def test_ro_uri_cannot_write_and_missing_db_cannot_be_created(self):
        for module in (naver_ads, competitor_news):
            with module.connect(cards.ro_path(module.db_path())) as db:
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute('CREATE TABLE forbidden (value TEXT)')
        missing = self.root/'never-created.db'
        with patch.dict(os.environ, {'SEARCH_VISIBILITY_DB_PATH':str(missing)}):
            rows = service.retrieve('검색노출 현황', today=NOW.date())
        self.assertEqual(rows[0]['status'], 'needs-review')
        self.assertFalse(missing.exists())

    def test_naver_summary_counts_branch_natural_results_and_excludes_stale(self):
        rows = [{'keyword':'a', 'branch':'incheon', 'status':'ready', 'stale':False, 'mentioned':True,
                 'branch_result':{'mentioned':False, 'first_page':None, 'branch_unconfirmed':True}},
                {'keyword':'b', 'branch':'incheon', 'status':'error', 'stale':True,
                 'branch_result':{'mentioned':True, 'first_page':1}},
                {'keyword':'c', 'branch':'incheon', 'status':'ready', 'stale':False,
                 'branch_result':{'mentioned':True, 'first_page':3}}]
        data={'branches':[{'id':'incheon','name':'인천점'}], 'providers':[{'id':'naver','name':'네이버 검색','items':rows}]}
        text=self.text(cards.visibility('검색노출',NOW,data))
        self.assertIn('최신 측정 완료 2개',text)
        self.assertIn('지점 언급 1개',text)
        self.assertIn('광고 제외 첫 페이지 0개',text)
        self.assertIn('미측정·오류는 미노출/언급 없음이 아니며',text)

    def test_ads_refresh_uses_campaign_totals_not_creative_double_count(self):
        path=naver_ads.db_path()
        with naver_ads.connect(path) as db:
            db.execute('DELETE FROM metrics');db.execute('DELETE FROM entities');db.execute('DELETE FROM state')
            db.execute("INSERT INTO entities VALUES ('c','campaign','플레이스','캠페인',1)")
            db.execute("INSERT INTO entities VALUES ('a','creative','플레이스','소재',1)")
            db.executemany('INSERT INTO metrics VALUES (?,?,?,?,?)',[('c','2026-09-11',100,5,500),('a','2026-09-11',100,5,500)])
            naver_ads.set_state(db,since='2026-09-11',through='2026-09-11',updated_at=NOW.isoformat())
        first=self.text(cards.retrieve('naver_ads','인천점 어제 광고비',NOW))
        self.assertIn('"광고비_VAT포함_원":500.0',first)
        self.assertIn('"CTR_퍼센트":5.0',first)
        with naver_ads.connect(path) as db:
            db.execute("UPDATE metrics SET cost=750 WHERE entity_id='c'")
        second=self.text(cards.retrieve('naver_ads','인천점 어제 광고비',NOW))
        self.assertIn('"광고비_VAT포함_원":750.0',second)
        self.assertIn('해당 기간 자료 없음', self.text(cards.retrieve('naver_ads','오늘 광고비',NOW)))
        self.assertIn('안양점 광고 실적은 연결되어 있지 않습니다', self.text(cards.retrieve('naver_ads','안양점 광고비',NOW)))

    def test_claim_file_refresh_and_historical_month_scope(self):
        payload=claim_sample()
        claim_check.save(payload, now=NOW)
        first=self.text(cards.retrieve('claim_check','안양점 청구현황',NOW))
        self.assertIn('접수 완료',first)
        payload['branches'][0]['claims'][0]['processingStatus']='반송'
        payload['branches'][0]['checkedAt']=NOW.isoformat()
        claim_check.save(payload,now=NOW)
        second=self.text(cards.retrieve('claim_check','안양점 청구현황',NOW))
        self.assertIn('반송',second)
        self.assertNotIn('institutionNumber',second)
        self.assertIn('7',self.text(cards.retrieve('claim_check','7월 청구현황',NOW)))
        self.assertIn('제공하지 않습니다',self.text(cards.retrieve('claim_check','7월 청구현황',NOW)))

    def test_agency_refreshes_live_db_and_combined_agency_filter(self):
        rows=[]
        for ident, agency in [('1','국민건강보험공단'),('2','보건복지부')]:
            rows.append({'id':ident,'title':agency+' 새 소식','kind':'news','agency':agency,'published_at':'2026-09-12',
                         'collected_at':NOW.isoformat(),'url':'https://example.com/'+ident})
        with agency_news.connect(agency_news.db_path()) as db:
            for row in rows:
                db.execute('INSERT INTO articles VALUES(?,?,?)',(row['id'],row['published_at'],json.dumps(row)))
        result=cards.retrieve('agency_news','건보공단·복지부 오늘 뉴스',NOW)
        self.assertEqual(len(result),3)
        self.assertIn('제목만 수집',self.text(result))
        rows[0]['title']='갱신된 새 소식'
        with agency_news.connect(agency_news.db_path()) as db:
            db.execute('UPDATE articles SET payload=? WHERE id=?',(json.dumps(rows[0]),'1'))
        self.assertIn('갱신된 새 소식',self.text(cards.retrieve('agency_news','건보공단 오늘 뉴스',NOW)))

    def test_reputation_uses_actual_identity_and_keeps_uncertainty(self):
        data=cards.saved_report('reputation',NOW)
        data['items']=[{'identity':'anyang','active':True,'title':'안양 확인 후보','verdict':'uncertain','evidence':'동일시설 확인 필요'},
                       {'identity':'incheon','active':True,'title':'인천 후보','verdict':'concern'}]
        result=self.text(cards.reputation('안양 평판',NOW,data))
        self.assertIn('안양 확인 후보',result);self.assertNotIn('인천 후보',result)
        self.assertIn('동일시설 확인 필요',result)

    def test_static_data_refreshes_without_wiki_import_or_process_restart(self):
        root=self.root/'site';root.mkdir();(root/'data').mkdir()
        payload=deepcopy(service.load_json('nearby_facilities.json'))
        payload['facilities']=payload['facilities'][:1]
        target=root/'data/nearby_facilities.json'
        with patch.object(service,'ROOT',root):
            target.write_text(json.dumps(payload),encoding='utf-8')
            first=self.text(cards.nearby('주변시설'))
            payload['facilities'][0]['phone']='000-NEW-PHONE';payload['asOf']='2026-09-12'
            target.write_text(json.dumps(payload),encoding='utf-8')
            rows=cards.nearby('주변시설')
        self.assertNotIn('000-NEW-PHONE',first);self.assertIn('000-NEW-PHONE',self.text(rows))
        self.assertEqual(rows[0]['updated'],'2026-09-12')

    def test_static_statistics_preserve_survey_denominator_and_reject_stale_export(self):
        rows=cards.statistics('통계 직원 휴게 공간')
        self.assertIn('16.7%',self.text(rows));self.assertIn('종사자의 응답 비율',self.text(rows))
        data=service.load_json('statistics_knowledge.json');data['sourceHash']='bad'
        with patch.object(service,'load_json',return_value=data),self.assertRaises(ValueError):
            cards.statistics('통계')

    def test_payroll_only_reads_public_text_and_templates(self):
        rows=cards.static_page('payroll','근로계약서')
        self.assertGreater(len(rows),1)
        self.assertNotIn('value=',self.text(rows));self.assertNotIn('sessionStorage',self.text(rows))
        self.assertIn('개별 직원 입력값',self.text(rows))

    def test_all_card_sources_survive_evidence_limit(self):
        rows=[service.evidence(kind,kind,str(n)) for kind in service.PAGES for n in range(5)]
        selected=service.select_evidence(rows)
        self.assertEqual(len(selected),12)
        self.assertEqual({r['dataset'] for r in selected},set(service.PAGES))


if __name__ == '__main__':
    unittest.main()
