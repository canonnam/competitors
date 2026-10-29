from datetime import datetime
from contextlib import closing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agency_news as news
import business_support
import iris_support
import support_applications


SOURCE = next(source for source in news.SOURCES if source['id'] == 'iris')
NOW = datetime(2026, 9, 30, 11, 0, tzinfo=news.KST)
TITLE = '2026년 AX실증밸리조성(R&D) 사업 신규지원대상 과제 통합 공고(수정)'
DETAIL = """
<ul>
  <li class="write"><strong>소관부처</strong><span>과학기술정보통신부</span></li>
  <li class="write"><strong>전문기관</strong><span>정보통신산업진흥원</span></li>
  <li class="write"><strong>공고명</strong><span>2026년 AX실증밸리조성(R&amp;D) 사업 신규지원대상 과제 통합 공고(수정)</span></li>
  <li class="write"><strong>접수기간</strong><span>2026-09-16 ~ 2026-09-30</span></li>
</ul>
<div class="tb_contents"><div class="se-contents">
모두의 AI 구현을 위한 AX 기술 실증 과제입니다.
일부 과제에는 AI 기반 에너지 운영 최적화도 포함됩니다.
전산등록 마감일 15 시 전까지 제출해야 합니다.
</div></div>
"""


def page(identity='023937', title=TITLE):
    return {
        'ancmPrg': 'ancmIng',
        'paginationInfo': {'currentPageNo': 1, 'totalPageCount': 1},
        'listBsnsAncmBtinSitu': [{
            'ancmId': identity, 'ancmTl': title,
            'ancmDe': '2026-08-31', 'rcveStrDe': '2026.09.16',
            'rcveEndDe': '2026.09.30',
            'blngGovdSeNm': '과학기술정보통신부',
            'sorgnNm': '정보통신산업진흥원',
        }],
    }


class IrisSupportTests(unittest.TestCase):
    def test_attachment_only_notice_does_not_abort_source_or_invent_body(self):
        html = DETAIL[:DETAIL.index('<div class="tb_contents">')] + '''
        <div class="tb_contents">■ 공고문</div>
        <ul class="add_file"><li><a class="file_down"
          href="javascript:f_bsnsAncm_downloadAtchFile('group','file','notice.hwpx','12');">공고.hwpx</a></li></ul>'''
        detail = iris_support.parse_detail(html)
        self.assertEqual(detail['body_status'], 'attachment_only')
        self.assertEqual(detail['overview'], '')
        items, scanned = iris_support.collect(
            SOURCE, {}, NOW, list_fetcher=lambda _: page(), detail_fetcher=lambda _: html)
        self.assertEqual(set(scanned), {'iris:023937'})
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['body_status'], 'attachment_only')
        self.assertIn('첨부 본문 미확인', items[0]['match_basis'])
        self.assertIn('첨부 본문 확인 필요', items[0]['recommendation'])
        self.assertEqual(items[0]['benefit'], '')
        self.assertIsNone(items[0]['deadline_at'])
        # Missing attachment text is not grounds for withdrawing a prior match.
        unrelated = html.replace(TITLE.replace('&', '&amp;'), '운영지원 안내')
        old_page = page(title='운영지원 안내')
        items, scanned = iris_support.collect(
            SOURCE, {'iris:023937': 'old-signature'}, NOW,
            list_fetcher=lambda _: old_page, detail_fetcher=lambda _: unrelated)
        self.assertEqual(items, [])
        self.assertEqual(set(scanned), {'iris:023937'})

    def test_empty_or_error_detail_still_fails_without_real_attachment_markup(self):
        metadata = DETAIL[:DETAIL.index('<div class="tb_contents">')]
        for html in [metadata, metadata + '<div class="tb_contents">■ 공고문</div>',
                     metadata + '<div class="tb_contents">■ 공고문</div><ul class="add_file"><a class="file_down" href="/login">첨부</a></ul>',
                     '<div class="tb_contents">■ 공고문</div><ul class="add_file"><a class="file_down" href="javascript:f_bsnsAncm_downloadAtchFile(1)">첨부</a></ul>']:
            with self.subTest(html=html), self.assertRaises(ValueError):
                iris_support.parse_detail(html)

    def test_plain_notice_body_is_read_without_editor_wrapper(self):
        html = DETAIL.replace('<div class="se-contents">', '').replace('</div></div>', '</div>')
        detail = iris_support.parse_detail(html)
        self.assertEqual(detail['body_status'], 'inline')
        self.assertIn('AX 기술 실증', detail['overview'])
        self.assertEqual(iris_support.assess({'title': TITLE}, detail, NOW)['deadline_at'], '2026-09-30T15:00:00+09:00')

    def test_public_list_and_detail_accept_ax_call_with_energy_subproject(self):
        rows, pages = iris_support.parse_page(page(), 1, SOURCE)
        self.assertEqual(pages, 1)
        self.assertEqual(rows[0]['url'], 'https://www.iris.go.kr/contents/retrieveBsnsAncmView.do?ancmId=023937&ancmPrg=')
        detail = iris_support.parse_detail(DETAIL)
        result = iris_support.assess(rows[0], detail, NOW)
        self.assertIn('AI·AX 전환', result['topics'])
        self.assertEqual(result['deadline_at'], '2026-09-30T15:00:00+09:00')
        self.assertTrue(iris_support.period_status({**rows[0], **result}, NOW)['active'])
        self.assertFalse(iris_support.period_status({**rows[0], **result}, NOW.replace(hour=15))['active'])

    def test_collector_persists_iris_and_accepts_interest_choice(self):
        items, seen = iris_support.collect(
            SOURCE, {}, NOW, list_fetcher=lambda _: page(), detail_fetcher=lambda _: DETAIL)
        self.assertEqual(set(seen), {'iris:023937'})
        self.assertEqual([item['id'] for item in items], ['iris:023937'])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'agency-news.db'
            news.init_db(path)
            with patch.object(iris_support, 'collect', return_value=(items, seen)):
                result = news.sync(path, NOW, sources=[SOURCE])
            self.assertEqual(result[0]['last_added'], 1)
            self.assertIn('iris:023937', news.report(path, NOW)['article_ids'])
            business_support.save_preference(path, 'iris:023937', 'interested', NOW, reason='')
            saved = next(item for item in news.report(path, NOW)['items'] if item['id'] == 'iris:023937')
            self.assertEqual(saved['preference'], 'interested')
            with patch.dict(os.environ, {'SUPPORT_DB_PATH': str(Path(tmp) / 'support.db')}), \
                    patch.object(news, 'db_path', return_value=path):
                support_applications.init_db()
                self.assertTrue(support_applications.ensure_case('iris:023937'))
                support_applications.collect_case('iris:023937')
                with closing(support_applications.connect()) as db:
                    case = db.execute('SELECT status,error FROM support_cases WHERE id=?', ('iris:023937',)).fetchone()
                self.assertEqual(case['status'], 'needs_review')
                self.assertIn('IRIS', case['error'])

    def test_agetech_is_a_preferred_topic_without_senior_only_requirement(self):
        row = {'title': '에이지테크 현장 실증 지원', 'department': '중소벤처기업부'}
        detail = {'title': row['title'], 'target': '중소기업', 'benefit': '에이지테크 서비스 개발',
                  'overview': '에이지테크 서비스 개발 지원',
                  'application_period': '2026-09-01 ~ 2026-10-31'}
        result = business_support.assess(row, detail, NOW.date())
        self.assertIn('에이지테크', result['topics'])
        self.assertGreaterEqual(result['score'], 30)

    def test_untrusted_identifier_and_response_are_rejected(self):
        with self.assertRaises(ValueError):
            iris_support.detail_url('023937&other=1')
        broken = page()
        broken['paginationInfo']['currentPageNo'] = 2
        with self.assertRaises(ValueError):
            iris_support.parse_page(broken, 1, SOURCE)

    def test_iris_collector_is_packaged_in_deployment_image(self):
        self.assertIn('iris_support.py', Path('Dockerfile').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
