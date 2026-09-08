from copy import deepcopy
from datetime import datetime, timedelta
from html import escape
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse

import app
import search_visibility as v

NOW = datetime(2026, 9, 9, 11, 0, tzinfo=v.KST)
QUERY = {'keyword': '인천 요양원 추천', 'city': 'Incheon'}


def page(title='타사 요양원', number=1, following=None, url='https://example.com/facility'):
    query=urllib.parse.urlencode({'query':QUERY['keyword'],'page':number+1})
    return ('<div class="fds-web-doc-root"><a data-heatmap-target=".link" href="'+url+'">공식 사이트</a>'
            '<a data-heatmap-target=".link" href="'+url+'">'+escape(title)+'</a><p>시설 안내</p></div>'
            '<a aria-current="page" aria-label="'+str(number)+'페이지">'+str(number)+'</a>'
            +('<a class="btn_next" href="/search.naver?'+escape(query)+'">다음</a>' if following else ''))


def response(text='타사 요양원을 비교하세요.', cited=True):
    return {'status':'completed','model':'test-model','output':[{'type':'web_search_call','status':'completed'},
        {'type':'message','content':[{'type':'output_text','text':text,'annotations':[
            {'type':'url_citation','url':'https://example.com/facility','title':'시설 원문','start_index':0,'end_index':len(text)}] if cited else []}]}]}


class VisibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=Path(self.temp.name)/'visibility.db';v.init_db(self.path)
        self.adpath=Path(self.temp.name)/'ads.db';v.naver_ads.init_db(self.adpath)
        self.config=deepcopy(v.settings())
        self.env=patch.dict(os.environ,{'OPENAI_API_KEY':'test-key','GEMINI_API_KEY':'','PERPLEXITY_API_KEY':'','SERPAPI_KEY':''})
        self.env.start()
        self.addCleanup(self.env.stop);self.addCleanup(self.temp.cleanup)
        with v.naver_ads.connect(self.adpath) as db:
            v.naver_ads.set_state(db,keyword_snapshot=json.dumps({'updated_at':NOW.isoformat(),'through':'2026-09-08','items':[
                {'keyword':QUERY['keyword'],'group':'인천','average_rank':2.5,'eligible':True}]},ensure_ascii=False))

    def report(self,now=NOW):return v.report(self.path,self.adpath,now)

    def test_actual_pagination_does_not_convert_ad_rank_to_page(self):
        self.config['max_pages']=3
        calls=[]
        def fetch(url):
            n=int(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('page',['1'])[0]);calls.append(n)
            return page('더비다 요양원' if n==3 else '다른 시설',n,n<3)
        result=v.collect_naver(QUERY,self.config,fetch)
        self.assertEqual(calls,[1,2,3]);self.assertEqual(result['first_page'],3)
        self.assertEqual(result['matches'][0]['position'],1)
        self.assertEqual(result['pages_checked'],3)

    def test_changed_layout_wrong_page_and_external_pagination_fail_closed(self):
        for html in ('<html>점검 중</html>',page(number=2),page(following=True).replace('/search.naver?','https://evil.test/?'),
                     page()+'<div class="place-app-root"><a class="changed">더비다요양원</a></div>'):
            with self.assertRaises(ValueError):v.parse_naver(html,v.search_url(QUERY['keyword']))
        with self.assertRaises(ValueError):v.parse_naver(page()+'자동입력 방지',v.search_url(QUERY['keyword']))

    def test_paid_ads_do_not_count_as_organic_visibility(self):
        html=page()+'<a class="lnk_tit" href="https://adcr.naver.com/click">더비다요양원 광고</a>'
        result=v.collect_naver(QUERY,self.config,lambda _:html)
        self.assertFalse(result['mentioned']);self.assertIsNone(result['first_page'])
        self.assertEqual(result['matches'][0]['area'],'ad')
        self.assertEqual(result['matches'][0]['url'],v.search_url(QUERY['keyword']))

    def test_owned_blog_mobile_urls_and_exact_place_ids(self):
        for url in ('https://blog.naver.com/vida25/100','https://m.blog.naver.com/vida25/100',
                    'https://blog.naver.com/PostView.naver?blogId=vida25&logNo=100',
                    'https://map.naver.com/p/search/anything/place/1671277974',
                    'https://m.place.naver.com/hospital/2000549036/home'):
            self.assertTrue(v.is_owned(url,self.config),url)
        for url in ('https://blog.naver.com/vida250/100','https://blog.naver.com.evil.test/vida25','https://map.naver.com/p/search/anything/place/123','javascript:alert(1)'):
            self.assertFalse(v.is_owned(url,self.config),url)
        self.assertFalse(v.brand_mentioned('더비다 쇼핑몰',self.config))

    def test_serp_adapter_uses_actual_page_and_validates_evidence_host(self):
        from io import BytesIO
        requests=[]
        def request(value,**kwargs):
            url=value.full_url if hasattr(value,'full_url') else value
            requests.append(url)
            if len(requests)==1:
                return BytesIO(json.dumps({'search_metadata':{'status':'Success','raw_html_file':'https://serpapi.com/searches/test/result.html'}}).encode())
            return BytesIO(page(number=3).encode())
        url=v.search_url(QUERY['keyword'])+'&page=3'
        with patch.dict(os.environ,{'SERPAPI_KEY':'test-search-key'}),patch.object(v.urllib.request,'urlopen',side_effect=request):
            html=v.fetch_serp_html(url)
        params=urllib.parse.parse_qs(urllib.parse.urlsplit(requests[0]).query)
        self.assertEqual(params['page'],['3']);self.assertEqual(params['where'],['web'])
        self.assertEqual(params['query'],[QUERY['keyword']]);self.assertNotIn('test-search-key',html)
        with patch.dict(os.environ,{'SERPAPI_KEY':'test-search-key'}),patch.object(v.urllib.request,'urlopen',return_value=BytesIO(json.dumps(
            {'search_metadata':{'status':'Success','raw_html_file':'https://evil.test/searches/result.html'}}).encode())):
            with self.assertRaises(ValueError):v.fetch_serp_html(url)

    def test_ai_query_never_contains_our_brand_or_urls(self):
        calls=[]
        def request(url,payload,headers):calls.append((url,payload));return response('더비다요양원을 포함한 비교입니다.')
        result=v.collect_ai('openai',QUERY,self.config,request)
        self.assertTrue(result['mentioned']);self.assertTrue(result['grounded'])
        raw=json.dumps(calls,ensure_ascii=False)
        self.assertNotIn('더비다',raw);self.assertNotIn('vida25',raw)
        self.assertEqual(calls[0][1]['max_tool_calls'],1)
        self.assertEqual(calls[0][1]['input'],QUERY['keyword'])
        self.assertEqual(calls[0][1]['tool_choice'],{'type':'web_search'})

    def test_incomplete_or_unsearched_ai_is_not_a_negative_observation(self):
        for data in ({'status':'incomplete','output':[]},{'status':'completed','output':response()['output'][1:]}):
            with self.assertRaises(ValueError):v.parse_openai(data)
        text,citations,_=v.parse_openai(response('확인할 자료가 부족합니다.',False))
        self.assertTrue(text);self.assertEqual(citations,[])

    def test_unverified_answer_and_disconnected_providers_excluded_from_denominator(self):
        v.sync_provider(self.path,'openai',[QUERY],self.config,NOW,requester=lambda *args:response(cited=False))
        providers={p['id']:p for p in self.report()['providers']}
        self.assertEqual(providers['openai']['checked'],0)
        self.assertEqual(providers['openai']['items'][0]['status'],'unverified')
        self.assertTrue(providers['openai']['items'][0]['answer'])
        self.assertEqual(providers['gemini']['checked'],0)
        self.assertEqual(providers['gemini']['items'][0]['status'],'unconfigured')
        self.assertEqual(providers['openai']['items'][0]['history'],[])

    def test_restart_does_not_repeat_paid_calls_and_next_day_keeps_history(self):
        calls=[]
        def request(*args):calls.append(1);return response('더비다 요양원을 비교하세요.')
        v.sync_provider(self.path,'openai',[QUERY],self.config,NOW,requester=request)
        v.init_db(self.path)
        v.sync_provider(self.path,'openai',[QUERY],self.config,NOW+timedelta(minutes=10),requester=request)
        self.assertEqual(len(calls),1)
        v.sync_provider(self.path,'openai',[QUERY],self.config,NOW+timedelta(days=1),requester=request)
        self.assertEqual(len(calls),2)
        row=self.report(NOW+timedelta(days=1))['providers'][1]['items'][0]
        self.assertEqual(len(row['history']),2);self.assertFalse(row['stale'])

    def test_failed_new_day_preserves_old_answer_but_marks_it_stale(self):
        v.sync_provider(self.path,'openai',[QUERY],self.config,NOW,requester=lambda *args:response())
        def failure(*args):raise TimeoutError('secret must not escape')
        v.sync_provider(self.path,'openai',[QUERY],self.config,NOW+timedelta(days=1),requester=failure)
        row=self.report(NOW+timedelta(days=1))['providers'][1]['items'][0]
        self.assertEqual(row['observed_at'],NOW.isoformat());self.assertTrue(row['stale'])
        self.assertEqual(row['status'],'error');self.assertNotIn('secret',json.dumps(row))

    def test_daily_failure_attempt_limit_and_thirty_minute_retry(self):
        calls=[]
        def failure(*args):calls.append(1);raise TimeoutError()
        for minutes in (0,1,30,61,300):
            v.sync_provider(self.path,'openai',[QUERY],self.config,NOW+timedelta(minutes=minutes),requester=failure)
        self.assertEqual(len(calls),2)

    def test_naver_access_limit_stops_all_remaining_queries(self):
        calls=[]
        def failure(url):calls.append(url);raise urllib.error.HTTPError(url,403,'Forbidden',{},None)
        queries=[QUERY,{'keyword':'안양 요양원 추천'}]
        v.sync_provider(self.path,'naver',queries,self.config,NOW,fetcher=failure)
        v.sync_provider(self.path,'naver',queries,self.config,NOW+timedelta(minutes=31),fetcher=failure)
        self.assertEqual(len(calls),1)
        self.assertEqual(self.report()['providers'][0]['items'][0]['status'],'error')

    def test_partial_naver_page_failure_does_not_replace_previous_result(self):
        v.sync_provider(self.path,'naver',[QUERY],self.config,NOW,fetcher=lambda _:page('더비다요양원'))
        def failure(url):
            if 'page=2' in url:raise TimeoutError()
            return page(following=True)
        v.sync_provider(self.path,'naver',[QUERY],self.config,NOW+timedelta(days=1),fetcher=failure)
        row=self.report(NOW+timedelta(days=1))['providers'][0]['items'][0]
        self.assertEqual(row['observed_at'],NOW.isoformat());self.assertTrue(row['mentioned']);self.assertTrue(row['stale'])

    def test_schedule_boundary(self):
        boundary=NOW.replace(hour=10,minute=50)
        self.assertEqual(v.due_at(boundary),boundary)
        self.assertEqual(v.next_daily(boundary-timedelta(seconds=1)),boundary)
        self.assertEqual(v.next_daily(boundary),boundary+timedelta(days=1))

    def test_gemini_and_perplexity_grounded_answers(self):
        text='더비다요양원을 확인하세요.'
        data={'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':text}]},'groundingMetadata':{
            'webSearchQueries':['인천 요양원'],'groundingChunks':[{'web':{'uri':'https://example.com','title':'시설'}}],
            'groundingSupports':[{'segment':{'endIndex':len(text.encode())},'groundingChunkIndices':[0]}]}}]}
        result=v.parse_gemini(data)
        self.assertEqual(result[1][0]['end'],len(text))
        self.assertEqual(v.parse_perplexity({'choices':[{'finish_reason':'stop','message':{'content':text}}],'citations':['https://example.com','javascript:bad']})[1][0]['url'],'https://example.com')

    def test_api_reads_only_and_private_files_remain_private(self):
        with patch.object(v,'db_path',return_value=self.path),patch.object(v.naver_ads,'db_path',return_value=self.adpath),patch.object(v,'collect_ai') as collector:
            server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                for method in ('GET','HEAD'):
                    conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                    conn.request(method,'/api/search-visibility?summary=1');res=conn.getresponse();body=res.read()
                    self.assertEqual(res.status,200);self.assertEqual(res.getheader('Cache-Control'),'no-store')
                    self.assertNotIn(b'test-key',body);conn.close()
                for path in ('/search_visibility.py','/data/search_visibility.json'):
                    conn=http.client.HTTPConnection('127.0.0.1',server.server_port);conn.request('GET',path)
                    res=conn.getresponse();res.read();self.assertEqual(res.status,404);conn.close()
                collector.assert_not_called()
            finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
