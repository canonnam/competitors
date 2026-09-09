from contextlib import closing
from datetime import date
import copy
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import competitor_news
import service_knowledge as service
import wiki_chat as wiki

TODAY = date(2026, 9, 9)


class ServiceKnowledgeTest(unittest.TestCase):
    def test_calendar_periods(self):
        cases = {
            "2026년 7월": ["2026-07"], "2026-07": ["2026-07"],
            "7월": ["2026-07"], "작년 7월": ["2025-07"],
            "2026년 1~7월": [f"2026-{m:02d}" for m in range(1, 8)],
            "2026년 5월부터 7월까지": ["2026-05", "2026-06", "2026-07"],
            "2025년 12월~2026년 2월": ["2025-12", "2026-01", "2026-02"],
            "2025년 7월과 2026년 7월": ["2025-07", "2026-07"],
            "올해 상반기": [f"2026-{m:02d}" for m in range(1, 7)],
            "2025년 4분기": ["2025-10", "2025-11", "2025-12"],
            "이번달": ["2026-09"], "지난달": ["2026-08"],
            "최근 3개월": ["2026-07", "2026-08", "2026-09"],
            "최근 운영손익": ["2026-07"],
        }
        for question, expected in cases.items():
            with self.subTest(question=question):
                self.assertEqual(service.requested_months(question, TODAY, ["2025-04", "2026-07"]), expected)
        for question in ("2026년 13월", "2026년 7~3월", "최근 99개월"):
            with self.subTest(question=question), self.assertRaises(ValueError):
                service.requested_months(question, TODAY, ["2026-07"])

    def test_competitor_data_matches_dashboard_and_revenue(self):
        rows = service.competitor_catalog()
        self.assertEqual(len(rows), 20)
        found = service.retrieve("케어포와 이지케어의 50인 가격과 매출을 비교", today=TODAY)
        self.assertEqual(len(found), 2)
        carefor = next(r for r in found if r["title"].startswith("케어포"))
        self.assertIn("77,000", carefor["content"])
        self.assertIn("63억", carefor["content"])
        self.assertIn("2024", carefor["content"])
        self.assertIn("서비스 단독 매출", carefor["content"])
        self.assertEqual(carefor["url"], "/competitors.html")

    def test_full_overview_not_partial_market_ranking(self):
        result = service.retrieve("경쟁사 전체 가격 비교", today=TODAY)
        self.assertEqual(len(result), 1)
        for row in service.competitor_catalog():
            self.assertIn(row["name"], result[0]["content"])
        self.assertIn("단순 순위 비교할 수 없습니다", result[0]["content"])

    def test_safety_supplier_names_resolve_to_new_catalog_entries(self):
        catalog = service.competitor_catalog()
        self.assertNotIn('eroum', {row['id'] for row in catalog})
        for name, expected in [('클레버러스', 'cleverus'), ('비클레버', 'cleverus'),
                               ('인지니어스', 'inzinious'), ('InCare24', 'inzinious'),
                               ('스페이스뱅크', 'spacebank')]:
            rows = service.matched_companies(name + ' 도입 사례', catalog)
            self.assertEqual([row['id'] for row in rows], [expected])

    def test_operating_totals_match_known_month_and_exclude_private_fields(self):
        report = service.load_json("operating_report.json")
        report["employeeNames"] = ["PRIVATE_NAME"]
        report["branches"][0]["months"][-1]["transactions"] = [{"memo": "PRIVATE_MEMO"}]
        with patch.object(service, "load_json", return_value=report):
            rows = service.operating_evidence("더비다 안양점 2026년 7월 손익", TODAY)
        text = "\n".join(r["content"] for r in rows)
        for expected in ("101,252,630원", "104,984,385원", "-3,731,755원", "2026-06", "전월 대비 증감"):
            self.assertIn(expected, text)
        for secret in ("PRIVATE_NAME", "PRIVATE_MEMO", "sheet1", "sha256", ".xlsx"):
            self.assertNotIn(secret, text)

    def test_missing_month_not_latest_or_zero(self):
        rows = service.retrieve("더비다 지난달 운영손익", today=TODAY)
        branch = next(r for r in rows if r["title"].startswith("더비다 안양점"))
        self.assertIn("자료 없는 월: 2026-08", branch["content"])
        self.assertNotIn("합계", branch["content"])
        self.assertNotIn("101,252,630", branch["content"])

    def test_combined_requires_both_branches(self):
        report = copy.deepcopy(service.load_json("operating_report.json"))
        report["branches"][1]["months"] = [m for m in report["branches"][1]["months"] if m["month"] != "2026-07"]
        with patch.object(service, "load_json", return_value=report):
            result = service.operating_evidence("더비다 2026년 7월 지점 비교", TODAY)
        combined = result[-1]["content"]
        self.assertIn("합산 불가 월: 2026-07", combined)
        self.assertNotIn("두 지점 합계:", combined)

    def test_period_sum_and_branch_comparison(self):
        result = service.retrieve("더비다 2026년 1~7월 누적", today=TODAY)
        self.assertIn("2026-01~2026-07", result[1]["title"])
        report = service.load_json("operating_report.json")
        expected = sum(m["profit"] for b in report["branches"] for m in b["months"] if "2026-01" <= m["month"] <= "2026-07")
        self.assertIn(f"운영손익(입출금 기준) {expected:,}원", result[-1]["content"])

    def test_followups_retain_domain_without_old_month(self):
        history = [{"role": "user", "content": "더비다 안양점 2026년 6월 손익은?"}]
        next_turn = service.retrieve("7월은?", history, TODAY)
        self.assertIn("2026-07", next_turn[1]["title"])
        history.append({"role": "user", "content": "7월은?"})
        compared = service.retrieve("그럼 전월 대비는?", history, TODAY)
        self.assertIn("2026-07", compared[1]["title"])
        self.assertIn("비교 전월 2026-06", compared[1]["content"])
        self.assertFalse(service.retrieve("작업치료사 필수인력 기준은?", history, TODAY))

    def test_missing_sources_fail_closed(self):
        with patch.object(service, "load_json", side_effect=OSError()):
            result = service.retrieve("케어포와 더비다 안양점 운영손익", today=TODAY)
        self.assertTrue(result)
        self.assertTrue(all(r["status"] == "needs-review" for r in result))
        self.assertTrue(all("읽을 수 없습니다" in r["content"] for r in result))

    def test_url_safety(self):
        for url in ("javascript:alert(1)", "//evil.example", "/api/wiki/documents", "file:///secret", "https://user:secret@example.com", "https://example.com\\evil", None):
            self.assertIsNone(service.safe_url(url), url)
        self.assertEqual(service.safe_url("https://example.com/news?id=1"), "https://example.com/news?id=1")


class ServiceNewsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "news.db"
        self.env = patch.dict(os.environ, {"COMPETITOR_NEWS_DB_PATH": str(self.path)})
        self.env.start()
        competitor_news.init_db(self.path)

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_reads_live_database_without_collecting_or_writing(self):
        with patch.object(competitor_news, "sync", side_effect=AssertionError("must not collect")):
            first = service.retrieve("케어포 최근 뉴스", today=TODAY)
            self.assertTrue(any("병원동행" in row["title"] for row in first))
            item = {"id": "new", "title": "케어포 새 소식", "url": "https://example.com/news", "competitor_id": "carefor",
                    "competitor": "케어포", "source": "공식 공지", "published_at": "2026-09-09T09:00:00+09:00",
                    "summary": "UNREVIEWED_CONTENT", "reviewed": False}
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute("INSERT INTO articles VALUES(?,?,?,?,?,?)", ("new", item["url"], "new", item["published_at"], 0, json.dumps(item)))
            latest = service.retrieve("케어포 오늘 뉴스 1건", today=TODAY)
        self.assertEqual(len(latest), 2)
        self.assertEqual(latest[1]["title"], "케어포 새 소식")
        self.assertIn("제목만 수집", latest[1]["content"])
        self.assertNotIn("UNREVIEWED_CONTENT", latest[1]["content"])

    def test_empty_period_is_not_no_news_everywhere(self):
        result = service.retrieve("케어포 2026년 7월 뉴스", today=TODAY)
        self.assertEqual(len(result), 1)
        self.assertIn("범위 내 0건", result[0]["content"])
        self.assertIn("실시간 검색한 결과가 아닙니다", result[0]["content"])

    def test_selected_company_followup_preserves_news_domain(self):
        result = service.retrieve("케어닥은?", [{"role": "user", "content": "케어포 최신 뉴스"}], TODAY)
        self.assertTrue(all(row["dataset"] == "competitor_news" for row in result))
        self.assertTrue(any("케어닥" in row["title"] for row in result))

    def test_news_listing_preserves_plans_and_publication_dates(self):
        result = service.retrieve("케어닥 최신 뉴스", today=TODAY)
        for i, row in enumerate(result, 1):
            row["number"] = i
        answer = service.news_list_answer("케어닥 최신 뉴스", result)
        self.assertIn("연다고 밝혔습니다", answer)
        self.assertIn("게시일: 2026-09-08", answer)
        self.assertNotIn("개설했습니다", answer)
        self.assertIsNone(service.news_list_answer("이 뉴스가 우리에게 미칠 영향을 분석해주세요", result))

    def test_requested_count_does_not_rank_old_numeric_headlines_first(self):
        item = {"id": "old3", "title": "돌봄 3자 협약 체결", "url": "https://example.com/old", "competitor_id": "caring",
                "published_at": "2025-01-01", "summary": "", "reviewed": False}
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("INSERT INTO articles VALUES(?,?,?,?,?,?)", ("old3", item["url"], "old3", item["published_at"], 0, json.dumps(item)))
        rows = service.retrieve("경쟁사 최신 뉴스 3건을 알려주세요", today=TODAY)[1:]
        dates = [r["updated"] for r in rows]
        self.assertEqual(dates, sorted(dates, reverse=True))
        self.assertTrue(all(date.startswith("2026-") for date in dates))


class ServiceIntegrationTest(unittest.TestCase):
    def test_valid_declared_citations_recover_missing_inline_markers(self):
        rows = [dict(service.evidence("operating", "조회 범위", "8월 자료 없음"), number=1),
                dict(service.evidence("operating", "안양점", "8월 자료 없음"), number=2)]
        for answer in ("8월 자료가 없습니다.", "8월 자료가 없습니다. [1, 2]"):
            response = {"status": "completed", "output": [{"type": "message", "content": [
                {"type": "output_text", "text": json.dumps({"answer": answer, "citations": [1, 2]})}]}]}
            with patch.dict(os.environ, {"OPENAI_API_KEY": "test"}), patch.object(wiki.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
                result = wiki.generate_answer("8월 손익", [], rows)
            self.assertIn("[1][2]", result["answer"])
            self.assertEqual(len(result["sources"]), 2)

    def test_mixed_evidence_has_unique_citations(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"OPENAI_API_KEY": "test"}):
            path = Path(directory) / "wiki.db"
            wiki.init_db(path)
            wiki.import_documents([{"path": "wiki/rule.md", "content": "# 인력 가산\n가산 기준은 원문을 확인합니다."}], path=path)
            with patch.object(wiki, "generate_answer", return_value={"answer": "ok", "sources": []}) as generate:
                wiki.answer({"message": "더비다 안양점 7월 운영손익과 인력 가산"}, "test", path)
            rows = generate.call_args.args[2]
            self.assertEqual([r["number"] for r in rows], list(range(1, len(rows) + 1)))
            self.assertTrue(any(r.get("dataset") == "operating" for r in rows))
            self.assertTrue(any(r["title"] == "인력 가산" for r in rows))

    def test_service_ready_without_wiki_documents(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"OPENAI_API_KEY": "test"}):
            path = Path(directory) / "wiki.db"
            wiki.init_db(path)
            status = wiki.public_status(path)
            self.assertTrue(status["ready"])
            self.assertEqual(status["documentCount"], 0)
            self.assertEqual(len(status["datasets"]), 3)


if __name__ == "__main__":
    unittest.main()
