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

    def test_current_page_can_be_visible_text_without_an_aria_label(self):
        html=page(number=2).replace('<a aria-current="page" aria-label="2페이지">2</a>',
                                   '<a href="?page=2" aria-current="page">2 페이지</a>')
        rows,_=v.parse_naver(html,v.search_url(QUERY['keyword'])+'&page=2',2)
        self.assertEqual(rows[0]['page'],2)

    def test_indexed_pdf_result_is_counted_without_downloading_the_document(self):
        pdf=page('안양 노인전문 요양원',5,url='https://memory.library.kr/dext/file/view/resource/126941').replace('data-heatmap-target=".link"','data-heatmap-target=".pdf"')
        rows,_=v.parse_naver(pdf,v.search_url('안양치매요양원')+'&page=5',5)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['title'],'안양 노인전문 요양원')
        self.assertEqual((rows[0]['page'],rows[0]['position']),(5,1))

    def test_only_explicit_first_page_search_correction_is_followed_and_disclosed(self):
        corrected='인천시 요양원 추천'
        url=urllib.parse.urlencode({'query':corrected,'page':2})
        first=page(following=True).replace('<a aria-current="page"',
            '<a href="?'+urllib.parse.urlencode({'query':corrected})+'" aria-current="page"')
        first=first.replace(escape(urllib.parse.urlencode({'query':QUERY['keyword'],'page':2})),escape(url))
        with self.assertRaises(ValueError):v.parse_naver(first,v.search_url(QUERY['keyword']))
        first+='<p>'+corrected+' 으로 검색한 결과입니다.</p>'
        calls=[]
        def fetch(url):calls.append(url);return first if len(calls)==1 else page(number=2)
        result=v.collect_naver(QUERY,self.config,fetch)
        self.assertEqual(result['pages_checked'],2)
        self.assertEqual(result['search_correction'],{'from':QUERY['keyword'],'to':corrected})

    def test_paid_ads_do_not_count_as_organic_visibility(self):
        html=page()+'<a class="lnk_tit" href="https://adcr.naver.com/click">더비다요양원 광고</a>'
        result=v.collect_naver(QUERY,self.config,lambda _:html)
        self.assertFalse(result['mentioned']);self.assertIsNone(result['first_page'])
        self.assertEqual(result['matches'][0]['area'],'ad')
        self.assertEqual(result['matches'][0]['url'],v.search_url(QUERY['keyword']))

    def test_first_page_ads_include_description_and_preserve_ad_order(self):
        html=page()+'<ul><li><a class="lnk_head" href="https://ader.naver.com/other">다른 요양원</a><a class="link_desc">안양 요양원</a></li>'
        html+='<li><a class="site" href="https://ader.naver.com/brand">더비다요양원</a><a class="lnk_head" href="https://ader.naver.com/paid">재활 중심 더비다 요양원</a>'
        html+='<a class="link_desc" href="https://ader.naver.com/paid">미추홀구 숭의동 요양원, 기능유지 중심 돌봄</a></li></ul>'
        html+='<a class="lnk_head" href="https://example.com">광고가 아닌 제목</a>'
        result=v.collect_naver(QUERY,self.config,lambda _:html)
        self.assertEqual(len(result['matches']),1)
        ad=result['matches'][0]
        self.assertEqual((ad['area'],ad['page'],ad['position']),('ad',1,2))
        self.assertIn('숭의동',ad['snippet']);self.assertNotIn('안양',ad['snippet'])
        self.assertEqual(ad['url'],v.search_url(QUERY['keyword']))
        self.assertEqual(v.evidence_branch(ad['title']+'\n'+ad['snippet'],ad['url'],self.config),'incheon')
        self.assertFalse(result['mentioned']);self.assertIsNone(result['first_page'])

    def test_old_ad_parser_is_rechecked_once_without_losing_organic_history(self):
        v.sync_provider(self.path,'naver',[QUERY],self.config,NOW,fetcher=lambda _:page('더비다요양원'))
        identity=v.check_id('naver',QUERY,self.config)
        with v.connect(self.path) as db:
            state=json.loads(db.execute('select payload from checks where id=?',(identity,)).fetchone()[0])
            state.pop('last_success_version');state.pop('attempt_version');state['attempts']=2
            db.execute('update checks set payload=? where id=?',(json.dumps(state),identity))
            observation=json.loads(db.execute('select payload from observations').fetchone()[0])
            observation.pop('ad_parser_version')
            db.execute('update observations set payload=?',(json.dumps(observation),))
        row=self.report()['providers'][0]['items'][0]
        self.assertTrue(row['mentioned']);self.assertFalse(row['ad_coverage_complete'])
        calls=[]
        def fetch(url):calls.append(url);return page('더비다요양원')
        v.sync_provider(self.path,'naver',[QUERY],self.config,NOW+timedelta(minutes=2),fetcher=fetch)
        v.sync_provider(self.path,'naver',[QUERY],self.config,NOW+timedelta(minutes=3),fetcher=fetch)
        self.assertEqual(len(calls),1)
        self.assertTrue(self.report()['providers'][0]['items'][0]['ad_coverage_complete'])

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
        self.assertEqual(calls[0][1]['max_tool_calls'],3)
        self.assertEqual(calls[0][1]['input'],QUERY['keyword'])
        self.assertEqual(calls[0][1]['tool_choice'],{'type':'web_search'})

    def test_incomplete_or_unsearched_ai_is_not_a_negative_observation(self):
        for data in ({'status':'incomplete','output':[]},{'status':'completed','output':response()['output'][1:]}):
            with self.assertRaises(ValueError):v.parse_openai(data)
        text,citations,_=v.parse_openai(response('확인할 자료가 부족합니다.',False))
        self.assertTrue(text);self.assertEqual(citations,[])

    def test_model_upgrade_preserves_old_observations_and_collects_new_sample_once(self):
        with patch.dict(os.environ, {'SEARCH_OPENAI_MODEL': 'gpt-5.4-mini'}):
            v.sync_provider(self.path,'openai',[QUERY],self.config,NOW,requester=lambda *args:response())
            other_signatures={p:v.query_signature(p,QUERY,self.config) for p in ('naver','gemini')}
        calls=[]
        def request(url,payload,headers):
            calls.append(payload)
            result=response('더비다요양원 인천점을 비교하세요.')
            result['model']=payload['model']
            return result
        with patch.dict(os.environ, {'SEARCH_OPENAI_MODEL': 'gpt-6-astra'}):
            before=next(p for p in self.report()['providers'] if p['id']=='openai')
            self.assertEqual(before['checked'],0)
            v.sync_provider(self.path,'openai',[QUERY],self.config,NOW,requester=request)
            v.sync_provider(self.path,'openai',[QUERY],self.config,NOW+timedelta(minutes=1),requester=request)
            after=next(p for p in self.report()['providers'] if p['id']=='openai')
            self.assertEqual(after['checked'],1)
            self.assertEqual(after['items'][0]['model'],'gpt-6-astra')
            self.assertEqual(len(after['items'][0]['history']),1)
            self.assertEqual(other_signatures,{p:v.query_signature(p,QUERY,self.config) for p in other_signatures})
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['reasoning'],{'effort':'low'})
        self.assertEqual(calls[0]['max_output_tokens'],4096)
        self.assertEqual(calls[0]['max_tool_calls'],3)
        self.assertEqual(calls[0]['input'],QUERY['keyword'])
        self.assertNotIn('더비다',json.dumps(calls,ensure_ascii=False))
        with v.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM observations WHERE provider='openai'").fetchone()[0],2)

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

    def test_interrupted_public_search_resumes_but_paid_attempt_is_preserved(self):
        def interrupted(*args):raise InterruptedError()
        v.sync_provider(self.path,'naver',[QUERY],self.config,NOW,fetcher=interrupted)
        v.sync_provider(self.path,'naver',[QUERY],self.config,NOW+timedelta(minutes=1),fetcher=lambda _:page())
        self.assertEqual(self.report()['providers'][0]['checked'],1)
        v.sync_provider(self.path,'openai',[QUERY],self.config,NOW,requester=interrupted)
        with patch.object(v,'collect_ai') as request:
            v.sync_provider(self.path,'openai',[QUERY],self.config,NOW+timedelta(minutes=1))
            request.assert_not_called()

    def test_gemini_billing_error_exposes_action_without_raw_provider_details(self):
        from io import BytesIO
        error=urllib.error.HTTPError('https://example.com',429,'quota',{},BytesIO(json.dumps({'error':{
            'message':'Your prepayment credits are depleted. private-details'}}).encode()))
        message=v.safe_error(error)
        self.assertIn('크레딧 부족',message);self.assertNotIn('private-details',message)

    def test_naver_access_limit_stops_all_remaining_queries(self):
        calls=[]
        def failure(url):calls.append(url);raise urllib.error.HTTPError(url,403,'Forbidden',{},None)
        queries=[QUERY,{'keyword':'안양 요양원 추천'}]
        v.sync_provider(self.path,'naver',queries,self.config,NOW,fetcher=failure)
        v.sync_provider(self.path,'naver',queries,self.config,NOW+timedelta(minutes=31),fetcher=failure)
        self.assertEqual(len(calls),1)
        self.assertEqual(self.report()['providers'][0]['items'][0]['status'],'error')

    def test_naver_security_check_html_stops_remaining_queries(self):
        calls=[]
        def blocked(url):calls.append(url);return '<html>자동입력 방지</html>'
        v.sync_provider(self.path,'naver',[QUERY,{'keyword':'다른 키워드'}],self.config,NOW,fetcher=blocked)
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

    def test_regional_queries_remain_collectable_when_ad_inventory_is_stale(self):
        queries, inventory=v.naver_queries(self.adpath,NOW,self.config)
        regional=[q for q in queries if q['source']=='regional']
        self.assertEqual(len(regional),12)
        self.assertTrue(all(q['branch']=='anyang' and q['average_ad_rank'] is None and q['eligible'] is None for q in regional))
        with patch.object(v.naver_ads,'keyword_report',return_value={**inventory,'stale':True}):
            collectable,_=v.naver_queries(self.adpath,NOW,self.config)
            self.assertEqual(collectable,regional)
            v.sync_provider(self.path,'naver',regional[:1],self.config,NOW,fetcher=lambda _:page('더비다요양원 안양'))
            rows=self.report()['providers'][0]['items']
            target=next(row for row in rows if row['keyword']==regional[0]['keyword'])
            self.assertEqual(target['status'],'ready')
            self.assertTrue(target['branch_result']['mentioned'])
            self.assertTrue(next(row for row in rows if row['query']['source']=='ad_account')['stale'])

    def test_branch_metadata_reuses_existing_observation_without_paid_calls(self):
        query={'keyword':'안양 요양원 추천','city':'Anyang'}
        enriched={**query,'branch':'anyang'}
        self.assertEqual(v.query_signature('openai',query,self.config),v.query_signature('openai',enriched,self.config))
        v.sync_provider(self.path,'openai',[query],self.config,NOW,requester=lambda *args:response('더비다요양원 안양점을 확인하세요.'))
        with patch.object(v,'collect_ai') as collector:
            v.sync_provider(self.path,'openai',[enriched],self.config,NOW)
            collector.assert_not_called()
        row=next(row for row in self.report()['providers'][1]['items'] if row['keyword']==query['keyword'])
        self.assertEqual(row['branch'],'anyang')
        self.assertTrue(row['branch_result']['mentioned'])
        self.assertTrue(row['branch_result']['history'][0]['mentioned'])

    def test_other_branch_and_generic_brand_do_not_count_as_anyang(self):
        def match(title,url='https://example.com/facility',area='web'):
            return {'title':title,'snippet':title,'url':url,'area':area,'page':1,'position':1}
        observed={'matches':[match('더비다요양원 인천'),match('더비다요양원 안내'),
                              match('더비다요양원','https://map.naver.com/p/entry/place/2000549036',area='place')]}
        result=v.branch_observation(observed,'anyang',self.config)
        self.assertTrue(result['mentioned']);self.assertEqual(len(result['matches']),1)
        self.assertEqual(result['matches'][0]['area'],'place')
        self.assertEqual(len(result['unconfirmed_matches']),1)
        self.assertTrue(result['branch_unconfirmed'])
        for answer in ('안양 요양원 추천\n더비다요양원 인천점', '안양 지역 추천\n더비다요양원입니다.'):
            result=v.branch_observation({'answer':answer,'mentioned':True},'anyang',self.config)
            self.assertFalse(result['mentioned'])
        self.assertTrue(result['branch_unconfirmed'])
        result=v.branch_observation({'matches':[match('더비다요양원 인천',area='ad')]},'incheon',self.config)
        self.assertFalse(result['mentioned']);self.assertIsNone(result['first_page'])

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
