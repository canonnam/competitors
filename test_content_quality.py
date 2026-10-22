import unittest,tempfile,uuid,json,http.client,threading
from pathlib import Path
from datetime import datetime,timedelta
from unittest.mock import patch
from http.server import ThreadingHTTPServer
import aeo_missions as m
import app
class QualityTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.path=str(Path(self.tmp.name)/'test.db');self.now=datetime.now(m.KST)
  self.body=dict(request_id=str(uuid.uuid4()),branch='incheon',checked_at=self.now.isoformat(),status='checked',summary='공개 페이지 확인',completed=[dict(note='접근 확인',url='https://www.thevida.co.kr/locations/incheon',verified_at=self.now.isoformat())],next_tasks=['색인 확인'],approvals=[])
 def test_append_idempotency_and_latest_branch_isolation(self):
  m.submit_quality(self.path,self.body);m.submit_quality(self.path,self.body)
  with m.connect(self.path) as db:self.assertEqual(db.execute('select count(*) from content_quality_events').fetchone()[0],1)
  with self.assertRaises(m.Conflict):m.submit_quality(self.path,{**self.body,'summary':'different'})
  old={**self.body,'request_id':str(uuid.uuid4()),'checked_at':(self.now-timedelta(days=1)).isoformat(),'completed':[]}
  with self.assertRaises(m.Conflict):m.submit_quality(self.path,old)
  with m.connect(self.path) as db:self.assertEqual(db.execute('select count(*) from content_quality_events where branch=?',('anyang',)).fetchone()[0],0)
 def test_completed_requires_real_public_evidence_and_time(self):
  for entry in [dict(note='x',url='javascript:alert(1)',verified_at=self.now.isoformat()),dict(note='x',url='https://www.thevida.co.kr/',verified_at=(self.now+timedelta(days=1)).isoformat())]:
   with self.assertRaises(ValueError):m.submit_quality(self.path,{**self.body,'completed':[entry]})
  with self.assertRaises(ValueError):m.submit_quality(self.path,{**self.body,'status':'updated','completed':[]})
  with self.assertRaises(ValueError):m.submit_quality(self.path,{**self.body,'status':'needs_approval'})
 def test_api_requires_site_auth_and_same_origin(self):
  server=ThreadingHTTPServer(('127.0.0.1',0),app.App);thread=threading.Thread(target=server.serve_forever);thread.start()
  try:
   for authorized,origin,expected in [(False,None,401),(True,'https://untrusted.example',403),(True,None,200)]:
    with patch.object(app.facility_access,'authorized',return_value=authorized),patch.object(app.search_visibility,'db_path',return_value=self.path):
     conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
     conn.request('POST','/api/search-visibility/content-quality',json.dumps(self.body),{'Content-Type':'application/json','Origin':origin or f'http://127.0.0.1:{server.server_port}'})
     response=conn.getresponse();response.read();self.assertEqual(response.status,expected);conn.close()
  finally:server.shutdown();server.server_close();thread.join()
if __name__=='__main__':unittest.main()
