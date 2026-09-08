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
        revenue_disclosures = re.findall(r'<div class="revenue-disclosure">', report)
        self.assertGreater(len(cards), 0)
        self.assertEqual(len(revenue_disclosures), len(cards))
        self.assertNotIn("매출: 공개 확인 필요", report)


if __name__ == "__main__":
    unittest.main()
