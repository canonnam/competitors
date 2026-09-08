from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import naver_ads as ads


class KeywordClient:
    def __init__(self, count=4):
        self.calls = []
        self.count = count
        self.campaign_status = 'ELIGIBLE'
        self.group_status = 'ELIGIBLE'
        self.bad_stats = None

    def get(self, uri, params=None):
        self.calls.append((uri, params))
        if uri == '/ncc/campaigns':
            return [{'nccCampaignId':'c', 'campaignTp':'WEB_SITE', 'status':self.campaign_status, 'name':'Powerlink'},
                    {'nccCampaignId':'place', 'campaignTp':'PLACE'}]
        if uri == '/ncc/adgroups':
            if params['nccCampaignId'] == 'place':
                raise AssertionError('Place is not a registered keyword ranking')
            return [{'nccAdgroupId':'g', 'status':self.group_status, 'name':'Group'}]
        if uri == '/ncc/keywords':
            return [{'nccKeywordId':f'k{i}', 'keyword':f'Keyword {i}', 'status':'ELIGIBLE', 'userLock':i==1} for i in range(self.count)]
        if self.bad_stats is not None:
            return self.bad_stats
        return {'data':[{'id':key, 'impCnt':100, 'clkCnt':2, 'salesAmt':400, 'avgRnk':0 if key=='k2' else 3.1 if key=='k3' else 3}
                        for key in params['ids'].split(',')], 'cycleBaseTm':'202609081000'}


class KeywordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'ads.db'
        ads.init_db(self.path)
        with ads.connect(self.path) as db:
            db.execute("DELETE FROM state WHERE key LIKE 'keyword_%'")
        self.now = datetime(2026,9,8,10,30,tzinfo=ads.KST)

    def test_rank_boundary_zero_and_parent_eligibility(self):
        client = KeywordClient()
        ads.sync_keywords(self.path,client,self.now)
        result = ads.keyword_report(self.path,self.now)
        self.assertEqual((result['total'],result['ranked_count'],result['top_count'],result['eligible_top_count']),(4,3,2,1))
        self.assertIsNone(result['items'][2]['average_rank'])
        self.assertFalse(result['stale'])
        for field in ('campaign_status','group_status'):
            setattr(client,field,'PAUSED')
            ads.sync_keywords(self.path,client,self.now)
            self.assertEqual(ads.keyword_report(self.path,self.now)['eligible_top_count'],0)
            setattr(client,field,'ELIGIBLE')

    def test_batches_and_seven_day_kst_window(self):
        client = KeywordClient(103)
        ads.sync_keywords(self.path,client,self.now.astimezone(ads.timezone.utc))
        stats = [p for uri,p in client.calls if uri=='/stats']
        self.assertEqual(len(stats),3)
        for params in stats:
            self.assertLessEqual(len(params['ids'].split(',')),50)
            self.assertEqual(params['timeIncrement'],'allDays')
            self.assertEqual(json.loads(params['timeRange']),{'since':'2026-09-01','until':'2026-09-07'})
            self.assertEqual(json.loads(params['fields']),['impCnt','clkCnt','salesAmt','avgRnk'])

    def test_failed_rank_collection_keeps_metrics_and_snapshot(self):
        client = KeywordClient()
        ads.sync_keywords(self.path,client,self.now)
        with ads.connect(self.path) as db:
            before = ads.state_dict(db)['keyword_snapshot']
            metrics = [tuple(row) for row in db.execute('SELECT * FROM metrics')]
        for bad in ({}, {'data':None}, {'data':[{'id':'wrong'}]}, {'data':[{'id':'k0','impCnt':1,'clkCnt':0,'salesAmt':0,'avgRnk':float('nan')}]}, {'data':[], 'cycleBaseTm':'202609061200'}):
            client.bad_stats = bad
            self.assertFalse(ads.refresh_keywords(self.path,client,self.now))
            with ads.connect(self.path) as db:
                self.assertEqual(ads.state_dict(db)['keyword_snapshot'],before)
                self.assertEqual([tuple(row) for row in db.execute('SELECT * FROM metrics')],metrics)
            self.assertTrue(ads.keyword_report(self.path,self.now)['stale'])
        client.bad_stats = None
        ads.refresh_keywords(self.path,client,self.now)
        self.assertFalse(ads.keyword_report(self.path,self.now)['stale'])

    def test_empty_keywords_and_missing_statistics_are_not_top(self):
        client = KeywordClient(0)
        ads.sync_keywords(self.path,client,self.now)
        self.assertEqual(ads.keyword_report(self.path,self.now)['total'],0)
        self.assertFalse(any(uri=='/stats' for uri,_ in client.calls))
        client.count=2;client.bad_stats={'data':[]}
        ads.sync_keywords(self.path,client,self.now)
        result=ads.keyword_report(self.path,self.now)
        self.assertEqual(result['ranked_count'],0)
        self.assertEqual(result['top_count'],0)

    def test_staleness_and_report_level_separation(self):
        before=ads.report(self.path,self.now)['daily']
        ads.sync_keywords(self.path,KeywordClient(),self.now)
        self.assertEqual(ads.report(self.path,self.now)['daily'],before)
        self.assertFalse(ads.keyword_report(self.path,self.now+timedelta(days=1,seconds=-1))['stale'])
        self.assertTrue(ads.keyword_report(self.path,self.now+timedelta(days=1))['stale'])

    def test_scheduler_collects_keywords_when_metrics_are_already_current(self):
        now=datetime.now(ads.KST)
        with ads.connect(self.path) as db:
            ads.set_state(db,through=ads.due_target(now))
        class StopAfterOne:
            stopped=False
            def is_set(self): return self.stopped
            def wait(self,seconds): self.stopped=True
        with patch.object(ads,'NaverClient',return_value=KeywordClient()), patch.object(ads,'sync') as metrics, patch.object(ads,'refresh_keywords') as keywords:
            ads.run_scheduler(self.path,{},StopAfterOne())
            metrics.assert_not_called()
            keywords.assert_called_once()


if __name__ == '__main__':
    unittest.main()
