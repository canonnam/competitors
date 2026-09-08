"""Verify map endpoints without exposing unrelated Railway credentials."""
import http.client,json,os,threading,unittest
from unittest.mock import patch
import app

class MapEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join(5)
    def request(self,path,method='GET'):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        try:
            conn.request(method,path);r=conn.getresponse();return r.status,r.headers,r.read()
        finally:conn.close()
    def test_only_browser_key_is_public(self):
        key='a'*32
        with patch.dict(os.environ,{'KAKAO_JAVASCRIPT_KEY':key,'KAKAO_REST_API_KEY':'do-not-expose','NAVER_INCHEON_SECRET_KEY':'secret'}):
            status,headers,raw=self.request('/api/maps-config')
            self.assertEqual(status,200);self.assertEqual(json.loads(raw),{'kakaoJavascriptKey':key})
            self.assertEqual(headers['Cache-Control'],'no-store');self.assertIn('noindex',headers['X-Robots-Tag'])
            self.assertEqual(self.request('/api/maps-config','HEAD')[2],b'')
    def test_missing_configuration_and_data_route(self):
        with patch.dict(os.environ,{'KAKAO_JAVASCRIPT_KEY':''}):self.assertEqual(self.request('/api/maps-config')[0],503)
        status,headers,raw=self.request('/api/nearby-facilities')
        self.assertEqual(status,200);self.assertEqual(len(json.loads(raw)['facilities']),725)
        self.assertEqual(self.request('/api/nearby-facilities','HEAD')[2],b'')
        self.assertEqual(self.request('/nearby-facilities.html')[0],200)
        self.assertEqual(self.request('/data/nearby_facilities.json')[0],404)
        self.assertEqual(self.request('/.env')[0],404)
if __name__=='__main__':unittest.main()
