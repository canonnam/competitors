"""Regression tests for pages bundled in the deployment image."""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parent


class StaticPageDeploymentTests(unittest.TestCase):
    def test_dockerfile_copies_all_locally_linked_html_pages(self):
        index = (ROOT / "index.html").read_text(encoding="utf-8")
        linked_pages = set(re.findall(r'href="/([^"?#]+\.html)"', index))
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        copied_files = set(re.findall(r"COPY\s+(.+?)\s+/app/?", dockerfile))
        bundled = {name for group in copied_files for name in group.split()}
        self.assertTrue(linked_pages <= bundled, f"Deployment image omits: {sorted(linked_pages - bundled)}")

    def test_every_competitor_card_shows_a_revenue_disclosure(self):
        report = (ROOT / "competitors.html").read_text(encoding="utf-8")
        cards = re.findall(r'<div class="card"\s+data-t="(?:erp|ai)">', report)
        revenue_disclosures = re.findall(r'<div class="revenue-disclosure" id="revenue-([^\"]+)">', report)
        self.assertGreater(len(cards), 0)
        self.assertEqual(len(revenue_disclosures), len(cards))
        self.assertEqual(len(set(revenue_disclosures)), len(cards))
        detail_ids = re.findall(r'onclick="openDetail\(\x27([^\x27]+)\x27\)"', report)
        self.assertEqual(set(detail_ids), set(revenue_disclosures))
        self.assertNotIn("매출: 공개 확인 필요", report)

    def test_shared_navigation_and_single_detail_heading(self):
        home = (ROOT / "index.html").read_text(encoding="utf-8")
        header = re.search(r'<header class="kb-header">.*?</header>', home).group()
        self.assertIn('더비다 지식 창고', home)
        self.assertNotIn('더비다를 위한<br>지식 창고', home)
        self.assertNotIn('class="card primary"', home)
        for page in ('competitors.html', 'competitor-uiux.html', 'competitor-news.html', 'ai-hub-data.html', 'naver-ads.html', 'operating-costs.html', 'statistics.html'):
            with self.subTest(page=page):
                content = (ROOT / page).read_text(encoding="utf-8")
                self.assertIn(header, content)
                self.assertIn('/assets/site.css', content)
                self.assertEqual(len(re.findall(r'<h1[ >]', content)), 1)
                self.assertEqual(content.count('class="kb-page-heading"'), 1)
                self.assertIn('aria-current="page"', content)

    def test_usability_section_records_derbida_complementary_input(self):
        page = (ROOT / "competitor-uiux.html").read_text(encoding="utf-8")
        self.assertIn('id="uxtest"', page)
        self.assertIn("보완 실입력 완료", page)
        self.assertIn("본인부담금·메시지 임시저장·프로그램·회의·정기점검 입력 완료", page)
        self.assertIn("직원관리 비고는 저장 범위 불명확으로 미확정", page)
        self.assertIn("설정은 탐색만", page)
        self.assertIn("개발 데이터는 삭제하지 않음", page)
        self.assertIn("주요 생성 흐름은 작동하지만 저장 범위·초안 안전성·다단계 경로의 안내가 더 필요함", page)
        self.assertIn("derbida-message-draft.png", page)
        self.assertNotIn("1차 실입력 미완료", page)
        self.assertNotIn("판정 보류", page)
        self.assertNotIn("이번 회차 미측정", page)

    def test_new_revenue_entries_keep_scope_year_and_sources(self):
        report = (ROOT / "competitors.html").read_text(encoding="utf-8")
        for key in ('easy', 'carefor', 'angel', 'jipangi', 'yoyangsys', 'happy', 'skt'):
            block = re.search(r'id="revenue-' + key + r'">(.*?)</div>', report).group(1)
            self.assertRegex(block, r'운영사 매출 · 20\d{2}년')
            self.assertIn('재확인: 2026-09-08', block)
            self.assertGreaterEqual(block.count('href="https://'), 2)


if __name__ == "__main__":
    unittest.main()
