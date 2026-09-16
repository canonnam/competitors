import base64
from contextlib import closing
import copy
from datetime import datetime
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import app
import support_projects as grants
import support_applications as support


class GrantTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.env=patch.dict(os.environ,{'SUPPORT_DB_PATH':str(Path(self.tmp.name)/'support.db'),'SUPPORT_ACCESS_KEY':'local-test-key'})
        self.env.start();self.addCleanup(self.env.stop)
        support.init_db();grants.init_db();self.pid='ax-2026-1-1-2'
        self.server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        self.cookie=''
    def request(self,path,body=None,auth=True,method=None):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        headers={'Content-Type':'application/json'}
        if auth and self.cookie:headers['Cookie']=self.cookie
        c.request(method or ('POST' if body is not None else 'GET'),path,json.dumps(body) if body is not None else None,headers)
        r=c.getresponse();data=r.read();status=r.status;cookie=r.getheader('Set-Cookie');c.close()
        return status,data,cookie
    def login(self):
        status,_,cookie=self.request('/api/support/login',{'key':'local-test-key'})
        self.assertEqual(status,200);self.cookie=cookie.split(';')[0]
    def share(self,sections=None,file_ids=None):
        result=grants.share_create({'id':self.pid,'sections':sections or ['overview','requirements','consortium'],'file_ids':file_ids or []})
        return result,result['url'].split('#')[1]
    def test_authentication_and_static_source_protection(self):
        for path in ['/api/support/projects','/api/support/projects/detail?id='+self.pid,'/api/support/projects/file?id=unknown']:
            self.assertEqual(self.request(path,auth=False)[0],401)
        for path in ['/support_projects.py','/data/ax-2026-project.json','/.local/notice.txt']:
            self.assertEqual(self.request(path,auth=False)[0],404)
        self.assertEqual(self.request('/support-projects.html')[0],200)
        self.login();self.assertEqual(self.request('/api/support/projects')[0],200)
    def test_seed_and_preserve_edits_on_restart_conflict(self):
        p=grants.get_project(self.pid);p['data']['summary']='수정한 준비 내용';saved=grants.save(p)
        self.assertEqual(saved['revision'],2)
        with self.assertRaises(support.wiki_chat.ChatError):grants.save(p)
        grants.init_db();self.assertEqual(grants.get_project(self.pid)['data']['summary'],'수정한 준비 내용')
        with closing(support.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM grant_history').fetchone()[0],1)
    def test_budget_matching_and_region_denominator(self):
        year=[{'national':75,'local':15}]
        s={'rows':[{'name':'지역 중소','type':'sme','region':'local','shares':[50]},{'name':'비영리','type':'nonprofit','region':'other','shares':[50]}]}
        r=grants.budget_result(s,year)[0]
        self.assertEqual(r['rows'][0]['burden'],15);self.assertEqual(r['rows'][0]['cash'],1.5)
        self.assertEqual(r['rows'][0]['inkind'],13.5);self.assertEqual(r['total'],105)
        self.assertAlmostEqual(r['region_share'],60/105*100,places=5);self.assertTrue(r['region_pass'])
    def test_unknown_unallocated_and_overallocation_not_pass(self):
        y=[{'national':10,'local':2}];s={'rows':[{'name':'미정','type':'unknown','region':'unknown','shares':[100]}]}
        r=grants.budget_result(s,y)[0];self.assertIsNone(r['rows'][0]['burden']);self.assertIsNone(r['region_pass'])
        s['rows'][0].update(type='sme',region='local',shares=[50]);self.assertIsNone(grants.budget_result(s,y)[0]['region_pass'])
        s['rows']*=3;r=grants.budget_result(s,y)[0];self.assertTrue(r['overallocated']);self.assertIsNone(r['region_pass'])
        s['rows'][0]['shares']=[float('nan')]
        with self.assertRaises(ValueError):grants.budget_result(s,y)
    def test_shared_projection_and_read_only(self):
        p=grants.get_project(self.pid);p['data']['partners'][0]['note']='PRIVATE_CONTACT';p['data']['tasks'][0]['note']='PRIVATE_TASK';grants.save(p)
        _,token=self.share();status,raw,_=self.request('/api/project-share/'+token,auth=False)
        self.assertEqual(status,200);payload=json.loads(raw)
        for key in ['tasks','scenarios','journal']:self.assertNotIn(key,payload['data'])
        self.assertNotIn(b'PRIVATE',raw)
        self.assertEqual(self.request('/api/project-share/'+token,{},auth=False)[0],405)
        self.assertEqual(self.request('/api/support/projects/save',p,auth=False)[0],401)
    def test_files_exact_scope_dedup_and_cross_project(self):
        body={'id':self.pid,'name':'공고.txt','base64':base64.b64encode(b'notice').decode(),'kind':'공고'}
        f=grants.upload(body);self.assertEqual(f['id'],grants.upload(body)['id'])
        second=grants.upload({**body,'name':'내부.txt'})
        _,token=self.share(['files'],[f['id']])
        self.assertEqual(self.request('/api/project-share/'+token+'/file?id='+f['id'],auth=False)[:2],(200,b'notice'))
        self.assertEqual(self.request('/api/project-share/'+token+'/file?id='+second['id'],auth=False)[0],404)
        other=grants.create({'title':'다른 사업'})
        with self.assertRaises(ValueError):grants.share_create({'id':other['id'],'sections':['files'],'file_ids':[f['id']]})
    def test_expiration_and_revocation_gate_files_too(self):
        f=grants.upload({'id':self.pid,'name':'a.txt','base64':base64.b64encode(b'a').decode()})
        result,token=self.share(['files'],[f['id']]);row=grants.resolve_share(token)
        dt=datetime.fromtimestamp(row['expires'],grants.KST)
        self.assertEqual((dt.month,dt.day,dt.hour,dt.minute,dt.second),(12,31,23,59,59))
        with patch.object(grants.time,'time',return_value=row['expires']+1):
            self.assertEqual(self.request('/api/project-share/'+token,auth=False)[0],410)
            self.assertEqual(self.request('/api/project-share/'+token+'/file?id='+f['id'],auth=False)[0],410)
        self.login();self.request('/api/support/projects/revoke',{'id':self.pid,'share_id':result['id']})
        self.assertEqual(self.request('/api/project-share/'+token,auth=False)[0],410)
    def test_share_tracks_saved_changes_only(self):
        _,token=self.share();p=grants.get_project(self.pid);p['data']['summary']='최신 저장 요약';grants.save(p)
        result=json.loads(self.request('/api/project-share/'+token,auth=False)[1]);self.assertEqual(result['data']['summary'],'최신 저장 요약')
    def test_cross_origin_mutation_denied(self):
        self.login();c=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        c.request('POST','/api/support/projects/create',json.dumps({'title':'bad'}),{'Cookie':self.cookie,'Content-Type':'application/json','Origin':'https://evil.example'})
        r=c.getresponse();self.assertEqual(r.status,403);r.read();c.close()

if __name__=='__main__':unittest.main()
