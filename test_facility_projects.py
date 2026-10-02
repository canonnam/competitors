"""Exercise shared persistence, simultaneous editors and validated geometry over HTTP."""
import copy
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import facility_projects as P
from test_facility_assets import QuietApp


def sample(identifier='building-test'):
    return dict(version=1, id=identifier, name='합성 지점', width=24, depth=16, height=3.2, scale='estimated', example=False, nursingHomeId=2, floors=[dict(id='floor-1', level=1, name='1층', image=None, rooms=[dict(id='room-1', name='101호', type='living', beds=4, x=0, z=0, w=4, d=4)], staff=[dict(role='care', count=3), dict(role='nurse', count=1)])])


class FacilityProjectTests(unittest.TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.previous = P.DB_PATH
        self.db = Path(self.folder.name)/'projects.db'
        P.init_db(self.db)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), QuietApp)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        P.DB_PATH = self.previous
        self.folder.cleanup()

    def request(self, method='GET', path='', data=None, origin=None):
        headers = {'Origin': self.base if origin is None else origin, 'Content-Type': 'application/json'}
        req = Request(self.base+P.PREFIX+path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
        try:
            with urlopen(req) as response:
                return response.status, json.loads(response.read()) if method != 'HEAD' else response.headers
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def save(self, project=None, revision=0):
        return self.request('POST', data=dict(project=project or sample(), revision=revision))

    def test_shared_staff_and_images_survive_a_new_connection_and_reinitialization(self):
        project = sample()
        project['floors'][0]['image'] = dict(name='합성 도면', src='data:image/png;base64,aGVsbG8=', aspect=1)
        self.assertEqual(self.save(project)[0], 200)
        P.init_db(self.db)
        status, result = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(result['projects'][0]['project'], project)
        self.assertEqual(result['projects'][0]['revision'], 1)
        self.assertIn('no-store', self.request('HEAD')[1]['Cache-Control'])

    def test_concurrent_edits_have_one_winner_and_rejected_save_preserves_winner(self):
        self.save()
        a, b = sample(), sample()
        a['floors'][0]['staff'][0]['count'] = 5
        b['floors'][0]['staff'][0]['count'] = 7
        with ThreadPoolExecutor(2) as pool:
            replies = list(pool.map(lambda p: self.save(p, 1), [a, b]))
        self.assertEqual(sorted(r[0] for r in replies), [200, 409])
        winner = replies[0][1]['project'] if replies[0][0] == 200 else replies[1][1]['project']
        self.assertEqual(self.request()[1]['projects'][0]['project'], winner)
        self.assertEqual(self.request()[1]['projects'][0]['revision'], 2)

    def test_delete_restore_and_stale_edit_cannot_resurrect_deleted_building(self):
        self.save()
        self.assertEqual(self.request('DELETE', 'building-test/', {'revision': 1})[0], 200)
        self.assertEqual(self.request()[1]['projects'], [])
        self.assertEqual(self.save(revision=1)[0], 409)
        self.assertEqual(self.save(revision=2)[0], 409)
        status, restored = self.request('POST', 'building-test/restore/', {'revision': 2})
        self.assertEqual((status, restored['revision']), (200, 3))
        self.assertEqual(restored['project'], sample())
        self.assertEqual(self.request('POST', 'building-test/restore/', {'revision': 2})[0], 409)

    def test_server_discards_credentials_and_resident_records(self):
        p = sample()
        p.update(password='synthetic-only', elderly_residents=[{'name': '합성 어르신'}])
        p['floors'][0]['rooms'][0]['risk_tier'] = 'focus'
        p['floors'][0]['staff'][0]['name'] = '합성 직원'
        self.assertEqual(self.save(p)[0], 200)
        self.assertEqual(self.request()[1]['projects'][0]['project'], sample())
        with closing(P.connect()) as con:
            raw = con.execute('SELECT data FROM facility_projects').fetchone()[0]
        for word in ('password', 'elderly_residents', 'risk_tier', '합성 직원'):
            self.assertNotIn(word, raw)

    def test_invalid_geometry_images_and_staff_never_replace_valid_document(self):
        self.save()
        patches = [lambda p: p.update(width=200), lambda p: p['floors'][0]['rooms'][0].update(x=12), lambda p: p['floors'][0]['staff'][0].update(count=21), lambda p: p['floors'][0]['staff'].append({'role': 'care', 'count': 1}), lambda p: p['floors'][0].update(image={'src': 'https://example.com/pic.png', 'aspect': 1}), lambda p: p['floors'][0]['rooms'][0].update(points=[{'x':-2,'z':-2},{'x':2,'z':2},{'x':-2,'z':2},{'x':2,'z':-2}])]
        for change in patches:
            p = copy.deepcopy(sample()); change(p)
            with self.subTest(project=p):
                self.assertEqual(self.save(p, 1)[0], 400)
                self.assertEqual(self.request()[1]['projects'][0]['revision'], 1)

    def test_concave_polygon_and_old_project_without_staff_are_accepted(self):
        p = sample(); del p['floors'][0]['staff']
        points = [{'x':x,'z':z} for x,z in [(-3,-3),(3,-3),(3,0),(0,0),(0,3),(-3,3)]]
        p['floors'][0]['rooms'][0]['points'] = points
        status, row = self.save(p)
        self.assertEqual(status, 200)
        self.assertEqual(row['project']['floors'][0]['rooms'][0]['points'], points)
        self.assertEqual(row['project']['floors'][0]['staff'], [])

    def test_cross_origin_invalid_revision_and_project_limit(self):
        self.assertEqual(self.request('POST', data={'project':sample(),'revision':0}, origin='https://other.example')[0], 403)
        self.assertEqual(self.save(revision=True)[0], 400)
        for i in range(8):
            self.assertEqual(self.save(sample('building-'+str(i)))[0], 200)
        self.assertEqual(self.save(sample('building-overflow'))[0], 400)
        self.assertEqual(len(self.request()[1]['projects']), 8)
        self.assertEqual(self.request('DELETE', 'building-0/', {'revision':1})[0], 200)
        self.assertEqual(self.save(sample('building-new'))[0], 200)
        self.assertEqual(self.request('POST', 'building-0/restore/', {'revision':2})[0], 400)

    def test_shared_floors_keep_physical_numbers_and_reject_duplicate_or_invalid_levels(self):
        p = sample()
        upper = copy.deepcopy(p['floors'][0])
        upper.update(id='floor-4', level=4, name='4층')
        upper['rooms'][0].update(id='room-4', name='401호')
        p['floors'].append(upper)
        self.assertEqual(self.save(p)[0], 200)
        P.init_db(self.db)
        self.assertEqual(self.request()[1]['projects'][0]['project'], p)
        for level in (1, 0, -2, 13, 4.5, True):
            invalid = copy.deepcopy(p)
            invalid['floors'][1]['level'] = level
            self.assertEqual(self.save(invalid, 1)[0], 400)
            self.assertEqual(self.request()[1]['projects'][0]['project'], p)

    def test_basement_and_twelve_ground_floors_share_full_contents_after_restart(self):
        p = sample()
        ground = copy.deepcopy(p['floors'][0])
        p['floors'] = []
        for level in range(1, 13):
            f = copy.deepcopy(ground)
            f.update(id=f'floor-{level}', level=level, name=f'{level}층')
            f['rooms'][0].update(id=f'room-{level}', name=f'{level}01호')
            p['floors'].append(f)
        basement = copy.deepcopy(ground)
        basement.update(id='floor-b1', level=-1, name='지하 1층',
                        image=dict(name='합성 지하 도면', src='data:image/png;base64,aGVsbG8=', aspect=1))
        basement['rooms'][0].update(id='room-b1', name='지하 생활실')
        p['floors'].insert(0, basement)
        self.assertEqual(self.save(p)[0], 200)
        P.init_db(self.db)
        self.assertEqual(self.request()[1]['projects'][0]['project'], p)
        deleted = copy.deepcopy(p)
        deleted['floors'].pop(0)
        self.assertEqual(self.save(deleted, 1)[0], 200)
        self.assertEqual(self.request()[1]['projects'][0]['project'], deleted)
        self.assertEqual(self.save(p, 2)[0], 200)
        self.assertEqual(self.request()[1]['projects'][0]['project'], p)


if __name__ == '__main__':
    unittest.main()
