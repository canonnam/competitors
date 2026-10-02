"""Only synthetic ERP credentials and names are used in these tests."""
import json
import os
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit
import test_facility_observation as legacy
import facility_collection as C
import facility_observation as F


def synthetic_rooms(path, access=None, body=None, timeout=15):
    if urlsplit(path).path == C.ROOM_PATH:
        return {'results': [{'id': 1, 'name': '201호', 'floor': 1, 'capacity': 4, 'current_occupancy': 3,
                             'elderly_residents': [{'id': 765, 'name': 'PRIVATE-RESIDENT-SENTINEL'}],
                             'diagnosis': 'PRIVATE-DIAGNOSIS-SENTINEL'}], 'next': None}
    return legacy.synthetic(path, access, body, timeout)


class CollectionTests(unittest.TestCase):
    call = legacy.ObservationTests.call

    def setUp(self):
        legacy.ObservationTests.setUp(self)
        C.STATE.clear(); C.SERVICE.update(access='', refresh='')
        self.env = patch.dict(os.environ, {'FACILITY_ERP_USERNAME': 'facility-demo', 'FACILITY_ERP_PASSWORD': 'local-demo'})
        self.env.start(); self.upstream.side_effect = synthetic_rooms

    def tearDown(self):
        self.env.stop(); C.STATE.clear(); C.SERVICE.update(access='', refresh=''); legacy.ObservationTests.tearDown(self)

    def test_hourly_cache_is_anonymous_and_browser_reads_never_call_erp(self):
        self.assertTrue(C.collect_once()); before = self.upstream.call_count
        for _ in range(3):
            code, headers, data = self.call('data?nursing_home_id=2')
            self.assertEqual(code, 200); self.assertEqual(data['assignedOccupancy'], 3)
            self.assertEqual(data['intervalSeconds'], 3600); self.assertFalse(data['stale'])
            raw = json.dumps(data); self.assertNotIn('PRIVATE-', raw); self.assertNotIn('elderly_', raw)
            self.assertNotIn('가상 대상', raw); self.assertIn('no-store', headers['Cache-Control'])
        self.assertEqual(before, self.upstream.call_count)
        self.assertEqual(self.call('targets?nursing_home_id=2')[0], 401)
        self.assertEqual(self.call('data?nursing_home_id=1')[0], 400)
        self.assertEqual(self.call('data?nursing_home_id=2', method='POST', data={})[0], 405)

    def test_first_failure_is_unavailable_and_later_failure_preserves_explicitly_stale_bundle(self):
        self.assertEqual(self.call('data?nursing_home_id=2')[0], 503)
        C.collect_once(); initial = C.cached(2)
        self.upstream.side_effect = F.ApiError(502, '합성 수집 실패')
        C.collect_once(); saved = C.cached(2)
        self.assertTrue(saved['stale']); self.assertEqual(saved['checkedAt'], initial['checkedAt'])
        self.assertEqual(saved['rooms'], initial['rooms']); self.assertEqual(saved['collectionError'], '합성 수집 실패')

    def test_failed_refresh_automatically_logs_into_the_service_account_again(self):
        C.collect_once(); C.SERVICE['access'] = 'expired'
        def expired(path, access=None, body=None, timeout=15):
            if path == '/api/token/refresh/': raise F.ApiError(401, '합성 만료')
            if path not in ('/api/token/', '/api/token/refresh/') and access == 'expired': raise F.ApiError(401, '합성 만료')
            return synthetic_rooms(path, access, body, timeout)
        self.upstream.side_effect = expired; C.collect_once()
        self.assertFalse(C.cached(2)['stale']); self.assertTrue(C.SERVICE['access'])
        self.assertGreaterEqual(sum(c.args[0] == '/api/token/' for c in self.upstream.call_args_list), 2)

    def test_room_pagination_rejects_external_destinations_and_other_branches(self):
        C.collect_once()
        for next_page in ('https://untrusted.example/api/nursing-homes/living-rooms/', C.ROOM_PATH+'?nursing_home=3'):
            self.upstream.side_effect = lambda *a, **k: {'results': [], 'next': next_page}
            before = self.upstream.call_count
            with self.assertRaises(F.ApiError): C.living_rooms(2)
            self.assertEqual(self.upstream.call_count, before+1)

    def test_malformed_and_duplicate_room_data_do_not_replace_the_cache(self):
        C.collect_once()
        for change in ({'current_occupancy': True}, {'nursing_home': 3}, {'current_occupancy': None}):
            def bad(path, *args, **kwargs):
                out = synthetic_rooms(path, *args, **kwargs)
                if urlsplit(path).path == C.ROOM_PATH: out['results'][0].update(change)
                return out
            self.upstream.side_effect = bad; C.collect_once(); self.assertTrue(C.cached(2)['stale'])

    def test_collection_lock_prevents_duplicate_workers(self):
        C.COLLECT_LOCK.acquire()
        try: self.assertFalse(C.collect_once()); self.upstream.assert_not_called()
        finally: C.COLLECT_LOCK.release()

    def test_scheduler_collects_immediately_then_waits_one_hour(self):
        event = threading.Event()
        def stop_after_interval(delay):
            self.assertGreater(delay, 3599); self.assertLessEqual(delay, 3600); event.set(); return True
        with patch.object(C, 'collect_once') as collect, patch.object(C.threading, 'Event', return_value=event), patch.object(event, 'wait', side_effect=stop_after_interval), patch.object(C.threading, 'Thread', side_effect=lambda target, **kwargs: SimpleNamespace(start=target)):
            stop = C.start_scheduler()
            self.assertIs(stop, event); self.assertTrue(event.is_set()); collect.assert_called_once()


if __name__ == '__main__':
    import sys
    if '--serve' in sys.argv:
        from http.server import ThreadingHTTPServer
        from test_facility_observation import QuietApp
        os.environ['FACILITY_ERP_USERNAME']='facility-demo'; os.environ['FACILITY_ERP_PASSWORD']='local-demo'
        F.request=synthetic_rooms; C.collect_once()
        print('Synthetic facility MVP QA: http://localhost:8097/facility-3d.html', flush=True)
        ThreadingHTTPServer(('127.0.0.1', 8097), QuietApp).serve_forever()
    else:
        unittest.main()
