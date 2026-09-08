"""Collection boundaries, failure preservation and server exposure regressions."""
from datetime import datetime, timedelta
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import app
import naver_ads as ads


class FakeClient:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    def get(self, uri, params=None):
        self.calls.append((uri, params))
        if uri == "/ncc/campaigns":
            return [{"nccCampaignId": "campaign-1", "campaignTp": "PLACE", "name": "Test"}]
        if uri == "/ncc/adgroups":
            return []
        if self.fail:
            raise RuntimeError("network unavailable")
        period = json.loads(params["timeRange"])
        return {"dailyStatResponse": {"data": [{"dateStart": period["until"], "impCnt": 100, "clkCnt": 5, "salesAmt": 900}]}}


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "ads.db"
        ads.init_db(self.path)
        with ads.connect(self.path) as db:
            db.execute("DELETE FROM metrics")
            db.execute("DELETE FROM entities")
            db.execute("DELETE FROM state")
            db.execute("INSERT INTO entities VALUES ('campaign-1','campaign','플레이스','Test',1)")
            ads.set_state(db, since="2025-02-01", through="2026-09-06", updated_at="2026-09-07T10:30:00+09:00")
        self.now = datetime(2026, 9, 8, 10, 30, tzinfo=ads.KST)

    def test_kst_schedule_boundary_and_restart_catchup(self):
        self.assertEqual(ads.due_target(self.now - timedelta(seconds=1)), "2026-09-06")
        self.assertEqual(ads.due_target(self.now), "2026-09-07")
        self.assertEqual(ads.due_target(self.now.astimezone(ads.timezone.utc)), "2026-09-07")
        self.assertEqual(ads.next_run(self.now), "2026-09-09T10:30:00+09:00")
        self.assertEqual(ads.next_run(self.now - timedelta(seconds=1)), self.now.isoformat())

    def test_sync_targets_yesterday_and_replaces_corrected_values(self):
        client = FakeClient()
        ads.sync(self.path, client, self.now)
        ads.sync(self.path, client, self.now)
        with ads.connect(self.path) as db:
            self.assertEqual(ads.state_dict(db)["through"], "2026-09-07")
            result = db.execute("SELECT SUM(clicks),SUM(cost) FROM metrics").fetchone()
            self.assertEqual(tuple(result), (5, 900))
        for uri, params in client.calls:
            if uri == "/stats":
                self.assertEqual(params["timeIncrement"], "1")
                self.assertEqual(json.loads(params["timeRange"])["until"], "2026-09-07")

    def test_failed_refresh_does_not_replace_last_good_report(self):
        ads.sync(self.path, FakeClient(), self.now)
        with ads.connect(self.path) as db:
            before_state = ads.state_dict(db)
            before_metrics = list(map(tuple, db.execute("SELECT * FROM metrics")))
        with self.assertRaises(RuntimeError):
            ads.sync(self.path, FakeClient(fail=True), self.now + timedelta(days=1))
        with ads.connect(self.path) as db:
            self.assertEqual(ads.state_dict(db), before_state)
            self.assertEqual(list(map(tuple, db.execute("SELECT * FROM metrics"))), before_metrics)

    def test_malformed_response_is_not_treated_as_zero_spend(self):
        for response in ({}, {"data": None}, {"dailyStatResponse": {"error": "not ready"}}, {"data": [{"dateStart":"2026-09-07"}]}):
            with self.subTest(response=response):
                client = FakeClient()
                client.get = lambda *_args, **_kwargs: response
                with self.assertRaises(ValueError):
                    ads.daily_stats(client, "test", self.now.date()-timedelta(days=1), self.now.date()-timedelta(days=1))

    def test_valid_empty_delivery_and_stale_cycle(self):
        client = FakeClient()
        client.get = lambda *_args, **_kwargs: {"data": []}
        day = self.now.date()-timedelta(days=1)
        self.assertEqual(ads.daily_stats(client,"test",day,day), [("test", "2026-09-07",0,0,0)])
        client.get = lambda *_args, **_kwargs: {"data": [], "cycleBaseTm": "202609061200"}
        with self.assertRaises(ValueError):
            ads.daily_stats(client,"test",day,day)

    def test_deleted_entity_history_is_preserved(self):
        with ads.connect(self.path) as db:
            db.execute("INSERT INTO entities VALUES ('old','campaign','파워링크','Old campaign',1)")
            db.execute("INSERT INTO metrics VALUES ('old','2026-08-31',50,2,200)")
        ads.sync(self.path,FakeClient(),self.now)
        with ads.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT active FROM entities WHERE id='old'").fetchone()[0],0)
            self.assertEqual(db.execute("SELECT clicks FROM metrics WHERE entity_id='old'").fetchone()[0],2)

    def test_restart_catches_missing_days_and_chunks_never_exceed_90(self):
        with ads.connect(self.path) as db:
            ads.set_state(db,through="2026-01-01")
        client=FakeClient()
        ads.sync(self.path,client,self.now)
        spans=[json.loads(params["timeRange"]) for uri,params in client.calls if uri=="/stats"]
        self.assertGreater(len(spans),1)
        self.assertEqual(spans[-1]["until"],"2026-09-07")
        for first,second in zip(spans,spans[1:]):
            self.assertEqual(ads.date.fromisoformat(first["until"])+timedelta(days=1),ads.date.fromisoformat(second["since"]))
        for span in spans:
            self.assertLessEqual((ads.date.fromisoformat(span["until"])-ads.date.fromisoformat(span["since"])).days+1,90)

    def test_report_has_no_credentials_and_preserves_level_separation(self):
        ads.sync(self.path,FakeClient(),self.now)
        config={"NAVER_INCHEON_"+key:"DO-NOT-EXPOSE" for key in ("CUSTOMER_ID","ACCESS_LICENSE","SECRET_KEY")}
        with patch.object(ads,"load_config",return_value=config):
            result=ads.report(self.path,self.now)
        self.assertNotIn("DO-NOT-EXPOSE",json.dumps(result))
        self.assertTrue(result["sync"]["enabled"])
        self.assertFalse(result["sync"]["stale"])
        self.assertEqual(sum(row["clicks"] for row in result["daily"] if row["level"]=="campaign"),5)

    def test_http_report_and_private_files_for_get_and_head(self):
        ads.sync(self.path,FakeClient(),self.now)
        server=ThreadingHTTPServer(("127.0.0.1",0),app.App)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with patch.object(ads,"db_path",return_value=self.path):
                for method in ("GET","HEAD"):
                    for path,status in (("/api/naver-ads",200),("/api/naver-ad-keywords",200),("/naver-ads.html",200),("/",200),("/app.py",404),("/.env",404),("/.git/config",404),("/data/naver_ads_seed.json.gz",404),("/assets/../app.py",404),("/assets/%2e%2e/.env",404),("/assets/",404)):
                        with self.subTest(method=method,path=path):
                            connection=http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=5)
                            connection.request(method,path)
                            response=connection.getresponse()
                            response.read()
                            connection.close()
                            self.assertEqual(response.status,status)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
