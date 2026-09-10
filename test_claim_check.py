import copy
from datetime import datetime, timedelta
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import app
import claim_check as claims
from scripts.publish_claim_check import verify_published

NOW = datetime(2026, 9, 10, 14, tzinfo=claims.KST)


def sample():
    return {"benefitMonth": "2026-08", "branches": [
        {"id": ident, "institutionNumber": number, "checkedAt": NOW.isoformat(), "querySucceeded": True,
         "claims": [{"benefitMonth": "2026-08", "benefitType": kind, "recipientType": recipient,
                     "claimType": "원청구", "submittedOn": "2026-09-07", "processingStatus": "심사"}
                    for kind, recipient in claims.REQUIRED_CLAIMS]}
        for ident, (_, number) in claims.BRANCHES.items()]}


class ClaimCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "checks.json"

    def result(self, payload):
        claims.save(payload, self.path, NOW)
        return claims.report(self.path, NOW)

    def test_all_three_categories_and_review_status_are_required(self):
        result = self.result(sample())
        self.assertTrue(result["allAccepted"])
        self.assertEqual(result["deadline"], "2026-09-10")
        self.assertEqual(result["daysUntilDeadline"], 0)
        self.assertTrue(all(b["verifiedItems"] == 3 for b in result["branches"]))
        for index in range(3):
            with self.subTest(missing=index):
                payload = sample()
                del payload["branches"][0]["claims"][index]
                result = self.result(payload)
                self.assertEqual(result["branches"][0]["status"], "check")
                self.assertEqual(len(result["branches"][0]["missing"]), 1)
                self.assertEqual(result["branches"][1]["status"], "accepted")

    def test_three_rows_with_duplicate_general_do_not_replace_medical(self):
        payload = sample()
        payload["branches"][0]["claims"][1] = copy.deepcopy(payload["branches"][0]["claims"][0])
        result = self.result(payload)["branches"][0]
        self.assertEqual(result["status"], "check")
        self.assertEqual(result["missing"][0]["recipientType"], "의료")

    def test_non_review_status_and_extra_non_review_claim_require_check(self):
        for status in ("접수", "지급", "반송", "청구취소"):
            payload = sample()
            payload["branches"][0]["claims"][2]["processingStatus"] = status
            self.assertFalse(self.result(payload)["allAccepted"])
        payload = sample()
        extra = copy.deepcopy(payload["branches"][0]["claims"][0])
        extra["processingStatus"] = "반송"
        payload["branches"][0]["claims"].append(extra)
        self.assertFalse(self.result(payload)["allAccepted"])

    def test_unrelated_allowances_do_not_affect_required_three(self):
        payload = sample()
        extra = copy.deepcopy(payload["branches"][0]["claims"][0])
        extra.update(benefitType="보수교육", processingStatus="반송")
        payload["branches"][0]["claims"].append(extra)
        result = self.result(payload)
        self.assertTrue(result["allAccepted"])
        self.assertEqual(result["branches"][0]["count"], 3)

    def test_empty_failed_missing_queries_never_show_complete(self):
        self.assertFalse(claims.report(self.path, NOW)["allAccepted"])
        payload = sample()
        payload["branches"][0]["claims"] = []
        self.assertFalse(self.result(payload)["allAccepted"])
        payload["branches"][0]["querySucceeded"] = False
        failed = self.result(payload)["branches"][0]
        self.assertEqual(failed["status"], "check")
        self.assertEqual(failed["lastQueryFailureAt"], NOW.isoformat())
        self.result(sample())
        result = claims.report(self.path, NOW + timedelta(hours=37))
        self.assertTrue(result["allAccepted"])
        self.assertEqual(result["branches"][0]["checkedAt"], NOW.isoformat())

    def test_failed_recheck_preserves_each_branch_result_and_success_time(self):
        self.result(sample())
        later = NOW + timedelta(hours=1)
        payload = sample()
        for branch in payload["branches"]:
            branch["checkedAt"] = later.isoformat()
        payload["branches"][0].update(querySucceeded=False, claims=[])
        claims.save(payload, self.path, later)
        result = claims.report(self.path, later)
        self.assertTrue(result["allAccepted"])
        self.assertEqual(result["branches"][0]["checkedAt"], NOW.isoformat())
        self.assertEqual(result["branches"][0]["lastQueryFailureAt"], later.isoformat())
        self.assertEqual(result["branches"][0]["verifiedItems"], 3)
        self.assertEqual(result["branches"][1]["checkedAt"], later.isoformat())
        self.assertIsNone(result["branches"][1]["lastQueryFailureAt"])
        verify_published(payload, result)
        stale = copy.deepcopy(result)
        stale["branches"][0]["lastQueryFailureAt"] = NOW.isoformat()
        with self.assertRaises(RuntimeError):
            verify_published(payload, stale)

    def test_repeated_failures_do_not_erase_results_and_real_new_result_replaces_them(self):
        self.result(sample())
        for hours in (1, 2):
            later = NOW + timedelta(hours=hours)
            payload = sample()
            for branch in payload["branches"]:
                branch.update(checkedAt=later.isoformat(), querySucceeded=False, claims=[])
            claims.save(payload, self.path, later)
            result = claims.report(self.path, later)
            self.assertTrue(result["allAccepted"])
            self.assertEqual(result["branches"][0]["lastQueryFailureAt"], later.isoformat())
        later = NOW + timedelta(hours=3)
        payload = sample()
        for branch in payload["branches"]:
            branch["checkedAt"] = later.isoformat()
        payload["branches"][0]["claims"][0]["processingStatus"] = "반송"
        claims.save(payload, self.path, later)
        result = claims.report(self.path, later)
        self.assertFalse(result["allAccepted"])
        self.assertEqual(result["branches"][0]["checkedAt"], later.isoformat())
        self.assertIsNone(result["branches"][0]["lastQueryFailureAt"])

    def test_first_failure_is_unknown_and_earlier_verified_result_can_be_recovered(self):
        later = NOW + timedelta(hours=1)
        failed = sample()
        for branch in failed["branches"]:
            branch.update(checkedAt=later.isoformat(), querySucceeded=False, claims=[])
        claims.save(failed, self.path, later)
        result = claims.report(self.path, later)
        self.assertFalse(result["allAccepted"])
        self.assertIsNone(result["branches"][0]["checkedAt"])
        self.assertEqual(result["branches"][0]["lastQueryFailureAt"], later.isoformat())
        verify_published(failed, result)
        claims.save(sample(), self.path, later)
        recovered = claims.report(self.path, later)
        self.assertTrue(recovered["allAccepted"])
        self.assertEqual(recovered["branches"][0]["checkedAt"], NOW.isoformat())
        self.assertEqual(recovered["branches"][0]["lastQueryFailureAt"], later.isoformat())
        verify_published(sample(), recovered)
        # An older failure cannot replace the newer failure or the recovered result.
        for branch in failed["branches"]:
            branch["checkedAt"] = NOW.isoformat()
        with self.assertRaises(ValueError):
            claims.save(failed, self.path, later)

    def test_failed_query_does_not_carry_completion_into_a_new_benefit_month(self):
        self.result(sample())
        later = datetime(2026, 10, 6, 11, tzinfo=claims.KST)
        payload = sample()
        payload["benefitMonth"] = "2026-09"
        for branch in payload["branches"]:
            branch.update(checkedAt=later.isoformat(), querySucceeded=False, claims=[])
        claims.save(payload, self.path, later)
        result = claims.report(self.path, later)
        self.assertFalse(result["allAccepted"])
        self.assertTrue(all(b["claims"] == [] and b["checkedAt"] is None for b in result["branches"]))

    def test_failure_metadata_cannot_predate_success_or_claim_a_future_attempt(self):
        for moment in (NOW - timedelta(minutes=1), NOW + timedelta(hours=1)):
            payload = sample()
            payload["branches"][0]["lastQueryFailureAt"] = moment.isoformat()
            with self.assertRaises(ValueError):
                claims.save(payload, self.path, NOW)

    def test_month_rollover_hides_history_and_year_rollover_uses_korea(self):
        self.result(sample())
        result = claims.report(self.path, datetime(2026, 10, 1, tzinfo=claims.KST))
        self.assertEqual(result["benefitMonth"], "2026-09")
        self.assertFalse(result["allAccepted"])
        self.assertEqual(result["branches"][0]["claims"], [])
        self.assertIsNone(result["branches"][0]["checkedAt"])
        month, deadline = claims.period(datetime.fromisoformat("2026-12-31T16:00:00+00:00"))
        self.assertEqual(month, "2026-12")
        self.assertEqual(deadline.isoformat(), "2027-01-10")

    def test_wrong_institution_old_month_and_secrets_are_rejected(self):
        for mutation in (
            lambda p: p["branches"][0].update(institutionNumber="12817700685"),
            lambda p: p.update(benefitMonth="2026-07"),
            lambda p: p["branches"][0].update(password="not-a-real-secret"),
            lambda p: p["branches"][0]["claims"][0].update(patientName="test"),
            lambda p: p["branches"][0]["claims"][0].update(benefitMonth="2026-07"),
        ):
            payload = sample()
            mutation(payload)
            with self.assertRaises(ValueError):
                claims.save(payload, self.path, NOW)
        result = self.result(sample())
        self.assertNotIn("institutionNumber", json.dumps(result))

    def test_older_and_future_checks_cannot_overwrite_new_results(self):
        self.result(sample())
        payload = sample()
        payload["branches"][0]["checkedAt"] = (NOW - timedelta(minutes=1)).isoformat()
        with self.assertRaises(ValueError):
            claims.save(payload, self.path, NOW)
        payload["branches"][0]["checkedAt"] = (NOW + timedelta(hours=1)).isoformat()
        with self.assertRaises(ValueError):
            claims.save(payload, self.path, NOW)

    def test_http_read_only_no_cache_and_missing_source_error(self):
        server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.App)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.object(claims, "data_path", return_value=self.path), patch.object(claims, "now_kst", return_value=NOW):
                self.result(sample())
                for method in ("GET", "HEAD"):
                    conn = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    conn.request(method, "/api/claim-check")
                    response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader("Cache-Control"), "no-store")
                    body = response.read()
                    if method == "GET":
                        self.assertTrue(json.loads(body)["allAccepted"])
                    else:
                        self.assertEqual(body, b"")
                    conn.close()
                self.path.write_text("{bad-json", encoding="utf-8")
                conn = http.client.HTTPConnection("127.0.0.1", server.server_port)
                conn.request("GET", "/api/claim-check")
                response = conn.getresponse()
                self.assertEqual(response.status, 503)
                self.assertNotIn(str(self.path).encode(), response.read())
                conn.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
