from copy import deepcopy
from datetime import date, datetime, timedelta
from html import escape
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agency_news as news
import business_support as biz

NOW = datetime(2026, 9, 9, 8, tzinfo=news.KST)
SOURCE = next(source for source in news.SOURCES if source['id'] == 'bizinfo')


def detail(title='SaaS 창업기업 개발 지원', target='전국 소재 업력 3년 이내 창업기업', benefit='소프트웨어 개발비 지원', period='2026.09.01 ~ 2026.09.30'):
    return {'title':title, 'target':target, 'benefit':benefit, 'overview':target+' '+benefit, 'application_period':period}


def detail_html(data):
    return '<div class="support_project_detail"><h2 class="title">'+escape(data['title'])+'</h2><div class="view_cont"><ul>'+''.join(
        '<li><span class="s_title">'+label+'</span><div class="txt">'+value+'</div></li>' for label,value in
        [('신청기간',escape(data['application_period'])),('사업개요','<p>설명 ☞ '+escape(data['target'])+' ☞ '+escape(data['benefit'])+'</p>')])+'</ul></div></div>'


def listing(ids, following=None, period='2026-09-01 ~ 2026-09-30'):
    rows=''.join(f'<tr><td>{i}</td><td>기술</td><td class="txt_l"><a href="/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_{i}">SaaS 창업기업 개발 지원 {i}</a></td><td>{period}</td><td>중소벤처기업부</td><td>수행기관</td><td>2026-09-08</td><td>10</td></tr>' for i in ids)
    tail=f'<a href="/sii/siia/selectSIIA200View.do?cpage={following}">다음</a>' if following else ''
    return '<table>'+rows+'</table>'+tail


class SupportTests(unittest.TestCase):
    def setUp(self):
        self.profile=deepcopy(biz.PROFILE)
        self.profile.update(employee_count_max=2,annual_revenue_krw=1000000000)
        self.profile['certifications']={'women_enterprise':None,'venture':True,'startup':None}

    def assess(self, data):
        return biz.assess({},data,NOW.date(),self.profile)

    def test_official_list_canonical_links_and_detail_bullets(self):
        rows, following=biz.parse_list(listing([1,2],2),SOURCE,1)
        self.assertEqual(len(rows),2);self.assertTrue(following)
        self.assertEqual(rows[0]['id'],'bizinfo:PBLN_1')
        parsed=biz.parse_detail(detail_html(detail()))
        self.assertEqual(parsed['target'],detail()['target'])
        self.assertEqual(parsed['benefit'],detail()['benefit'])
        for html in ['점검 중',listing([1]).replace('2026-09-08','2026-99-99'),listing([1]).replace('/sii/siia/selectSIIA200Detail.do','https://example.com/sii/siia/selectSIIA200Detail.do')]:
            with self.assertRaises(ValueError):biz.parse_list(html,SOURCE,1)
        with self.assertRaises(ValueError):biz.parse_detail('<div>공고 없음</div>')

    def test_software_startup_research_and_women_are_candidates_not_eligibility(self):
        match=self.assess(detail('여성기업 SaaS 연구개발 지원','전국 여성기업 중 업력 3년 이내 벤처기업'))
        self.assertIn('SaaS·디지털 기술',match['topics'])
        self.assertIn('여성기업',match['topics'])
        self.assertIn('조건 확인',match['recommendation'])
        self.assertTrue(any('여성기업확인서' in value for value in match['checks']))
        self.assertTrue(any('벤처기업 확인' in value for value in match['reasons']))

    def test_wrong_geography_and_headquarters_vs_research_center(self):
        for title,target in [('[부산] SaaS 개발 지원','부산 소재 중소기업'),
                             ('전남 창업 지원','전남 내 기업부설연구소가 있는 창업기업'),
                             ('[경기] 하남시 창업 지원','하남시 중소기업'),
                             ('[경기] 안양시 창업 지원','안양시에 본사를 둔 기업'),
                             ('[인천] 창업 지원','인천 소재 본사 기업')]:
            self.assertIsNone(self.assess(detail(title,target)),title)
        self.assertIsNone(self.assess(detail('[충남] 스타트업 밋업','전국 창업기업')))
        match=self.assess(detail('[경기] 안양시 SaaS 연구개발','안양시에 본사 또는 연구소를 둔 기업'))
        self.assertIsNotNone(match)
        self.assertTrue(any('소재지' in check for check in match['checks']))

    def test_other_regional_authorities_full_names_and_city_restrictions(self):
        for authority in ('충청남도', '강원특별자치도', '전북특별자치도', '서울특별시'):
            self.assertIsNone(biz.assess({'department':authority},detail('전국 스타트업 밋업'),NOW.date(),self.profile))
        for scope in ('전남광주','대구경북','광주시','경상남도'):
            self.assertIsNone(self.assess(detail('['+scope+'] 기술닥터 지원','지역 내 중소기업')),scope)
        self.assertIsNone(biz.assess({'department':'수원시'},detail(),NOW.date(),self.profile))
        for target in ('충청북도 소재 창업기업', '경상남도 내 중소기업', '경기도 수원시 관내 기업',
                       '광주시 소재 소프트웨어 기업', '춘천시에 소재한 창업기업', '용인 소재 중소기업'):
            self.assertIsNone(self.assess(detail(target=target)),target)
        for title,target in [('[경기] 성남시 SaaS 지원','성남시 내 기업'),
                             ('전국 AX 실증 지원','전국 중소기업'),
                             ('인천광역시 돌봄 실증','인천광역시 소재 사업장'),
                             ('경기도 연구개발 지원','경기도 내 기업부설연구소 보유 기업')]:
            self.assertIsNotNone(self.assess(detail(title,target)),title)
        self.assertIsNone(self.assess(detail('2026년 서울 창업 지원','전국 창업기업')))

    def test_location_information_excluded_even_with_care_and_software(self):
        for location in ('위치정보', '위치 기반 서비스', 'LBS', 'GPS'):
            self.assertIsNone(self.assess(detail(location+' SaaS 개발 지원')),location)
            self.assertIsNone(self.assess(detail('돌봄 기술 지원', '전국 '+location+' 사업자')),location)
        candidate=detail('시니어 SaaS 지원')
        candidate['overview']+=' 위치정보 사업 육성'
        self.assertIsNone(self.assess(candidate))

    def test_senior_welfare_ax_and_physical_ai_topics(self):
        for title,topic in [('시니어 현장 실증','시니어·사회복지·장기요양'),
                            ('사회복지 현장 디지털 서비스','시니어·사회복지·장기요양'),
                            ('장기요양 AX 실증','AI·AX 전환'),
                            ('AI 전환 바우처','AI·AX 전환'),
                            ('피지컬 AI 현장 실증','피지컬 AI·돌봄 로봇'),
                            ('Physical AI 돌봄 현장 실증','피지컬 AI·돌봄 로봇'),
                            ('돌봄 로봇 도입','피지컬 AI·돌봄 로봇')]:
            matched=self.assess(detail(title,'전국 중소기업','사업비 지원'))
            self.assertIsNotNone(matched,title)
            self.assertIn(topic,matched['topics'])
        for title,target in [('사회복지 지원','비영리법인만 신청 가능'),
                             ('제조업 AX 바우처','공장등록 제조기업'),
                             ('MAX 컨퍼런스','전국 중소기업')]:
            self.assertIsNone(self.assess(detail(title,target,'사업비 지원')),title)

    def test_wrong_sectors_and_incidental_platform_keywords(self):
        for title,target in [('반려동물 온라인 플랫폼 입점','반려동물 제조ㆍ수출 기업'),
                             ('식품기업 채용 지원','국내 식품ㆍ외식 기업'),
                             ('산업위기 이차보전','산업위기지역 소재 기업'),
                             ('제조업 소프트웨어 도입 지원','공장등록 제조업 기업'),
                             ('청년식당 창업 지원','예비창업자 또는 초기 창업자'),
                             ('뿌리기업 기술개발','뿌리기업'),
                             ('가구 판매 플랫폼 입점','가구 수출기업')]:
            self.assertIsNone(self.assess(detail(title,target,'온라인 판로 개척')),title)
        self.assertIsNone(self.assess(detail('산업기술 연구개발','주관연구개발기관','전력망핵심기술 및 중수로 사업 연구개발비 지원')))

    def test_establishment_employment_and_existing_business_limits(self):
        for target in ['예비창업자','업력 7년 이상 창업기업','상시근로자 10인 이상 중소기업',"고용보험 성립일자가 '22.12.31. 이전인 기업"]:
            self.assertIsNone(self.assess(detail(target=target)),target)
        match=self.assess(detail(target='매출액 30억원 이하, 업력 3년 이내 창업기업'))
        self.assertTrue(any('기준연도' in check for check in match['checks']))

    def test_deadline_day_upcoming_closed_and_rolling_not_falsely_open(self):
        self.assertEqual(biz.period_status('2026.09.01 ~ 2026.09.09',NOW.date())['days_left'],0)
        self.assertFalse(biz.period_status('2026.09.01 ~ 2026.09.08',NOW.date())['active'])
        self.assertEqual(biz.period_status('2026.09.10 ~ 2026.09.30',NOW.date())['label'],'접수 예정')
        self.assertEqual(biz.period_status('예산 소진시까지',NOW.date())['label'],'접수 여부 확인')
        self.assertIsNone(self.assess(detail(period='2026.01.01 ~ 2026.01.31')))

    def test_collect_follows_full_known_page_and_deduplicates_after_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'agency.db';news.init_db(path)
            def fetch(url):
                return listing([2,1]) if 'View.do' in url else detail_html(detail())
            self.assertEqual(news.sync(path,NOW,fetch,[SOURCE])[0]['last_added'],2)
            news.init_db(path)
            self.assertEqual(news.sync(path,NOW+timedelta(days=1),fetch,[SOURCE])[0]['last_added'],0)
            report=news.report(path,NOW)
            self.assertEqual(report['support']['active'],2)
            first_seen=report['items'][0]['first_seen_at']
            def changed(url):
                return listing([2,1],period='2026-09-01 ~ 2026-10-31') if 'View.do' in url else detail_html(detail(period='2026.09.01 ~ 2026.10.31'))
            news.sync(path,NOW+timedelta(days=2),changed,[SOURCE])
            report=news.report(path,NOW)
            self.assertEqual(report['items'][0]['first_seen_at'],first_seen)
            self.assertEqual(report['total'],2)
            self.assertNotIn('company',report)
            self.assertNotIn('annual_revenue',json.dumps(report))
            self.assertNotIn('items',news.report(path,NOW,summary=True))
            self.assertEqual(news.report(path,NOW+timedelta(days=70))['support']['active'],0)
            self.assertEqual(news.report(path,NOW+timedelta(days=70),summary=True)['article_ids'],[])

    def test_failed_detail_keeps_archive_and_seen_for_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'agency.db';news.init_db(path)
            news.sync(path,NOW,lambda url:listing([1]) if 'View.do' in url else detail_html(detail()),[SOURCE])
            before=news.report(path,NOW)
            def failure(url):
                if 'View.do' in url:return listing([2,1])
                raise TimeoutError('test failure')
            result=news.sync(path,NOW+timedelta(days=1),failure,[SOURCE])
            self.assertTrue(result[0]['error'])
            self.assertEqual(result[0]['last_success'],NOW.isoformat())
            self.assertEqual(news.report(path,NOW)['items'],before['items'])
            with news.connect(path) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM seen').fetchone()[0],1)

    def test_mixed_known_page_does_not_stop_before_new_announcements(self):
        old,_=biz.parse_list(listing([1,2,3]),SOURCE,1)
        seen={row['id']:biz.fingerprint(row) for row in old}
        pages={1:listing([5,1],2),2:listing([4,2],3),3:listing([3])}
        calls=[]
        def fetch(url):
            if 'Detail.do' in url:return detail_html(detail())
            page=int(biz.urllib.parse.parse_qs(biz.urllib.parse.urlsplit(url).query)['cpage'][0]);calls.append(page)
            return pages[page]
        selected,_=biz.collect(SOURCE,seen,NOW,fetch)
        self.assertEqual(calls,[1,2,3])
        self.assertEqual({item['id'] for item in selected},{'bizinfo:PBLN_5','bizinfo:PBLN_4'})

    def test_changed_target_withdraws_a_previous_recommendation(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'agency.db';news.init_db(path)
            news.sync(path,NOW,lambda url:listing([1]) if 'View.do' in url else detail_html(detail()),[SOURCE])
            def changed(url):
                return listing([1]).replace('SaaS 창업기업 개발 지원 1','수정된 창업 지원') if 'View.do' in url else detail_html(detail(target='예비창업자'))
            news.sync(path,NOW+timedelta(days=1),changed,[SOURCE])
            report=news.report(path,NOW)
            self.assertEqual(report['support']['active'],0)
            self.assertEqual(report['total'],1)
            self.assertEqual(report['items'][0]['application_status']['label'],'추천 제외')

    def test_policy_change_reviews_known_nonmatches_and_older_recommendations(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'agency.db';news.init_db(path)
            old=detail('위치정보 컨설팅','전국 위치정보 사업자')
            def fetch(url):
                if 'View.do' in url:return listing([2,1])
                return detail_html(old if url.endswith('_1') else detail('장기요양 AX 실증','전국 중소기업'))
            original=biz.assess
            def old_assess(item,data,today):
                return original(item,detail(),today) if item['id'].endswith('_1') else None
            with patch.object(biz,'POLICY_REVISION','previous'),patch.object(biz,'assess',side_effect=old_assess):
                news.sync(path,NOW,fetch,[SOURCE])
            before=news.report(path,NOW)['items'][0]
            calls=[]
            def current(url):
                calls.append(url)
                # Former recommendation is now outside the list; it must still be reviewed.
                return listing([2]) if 'View.do' in url else fetch(url)
            result=news.sync(path,NOW+timedelta(minutes=1),current,[SOURCE],force=False)
            self.assertEqual(result[0]['policy_revision'],biz.POLICY_REVISION)
            self.assertEqual(result[0]['last_added'],1)
            report=news.report(path,NOW)
            self.assertEqual(report['support']['active'],1)
            self.assertEqual(report['article_ids'],['bizinfo:PBLN_2'])
            archived=next(item for item in report['items'] if item['id'].endswith('_1'))
            self.assertTrue(archived['withdrawn'])
            self.assertEqual(archived['first_seen_at'],before['first_seen_at'])
            self.assertTrue(any(url.endswith('_1') for url in calls))
            self.assertEqual(news.sync(path,NOW+timedelta(minutes=2),current,[SOURCE],force=False),[])

    def test_failed_policy_review_is_atomic_and_retries_after_thirty_minutes(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'agency.db';news.init_db(path)
            fetch=lambda url:listing([1]) if 'View.do' in url else detail_html(detail())
            with patch.object(biz,'POLICY_REVISION','previous'):
                news.sync(path,NOW,fetch,[SOURCE])
            before=news.report(path,NOW)['items']
            def failure(url):
                if 'View.do' in url:return listing([2,1])
                if url.endswith('_1'):raise TimeoutError('test policy retry')
                return detail_html(detail())
            result=news.sync(path,NOW+timedelta(minutes=1),failure,[SOURCE],force=False)
            self.assertEqual(result[0]['policy_revision'],'previous')
            self.assertTrue(result[0]['error'])
            self.assertEqual(news.report(path,NOW)['items'],before)
            with news.connect(path) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM seen').fetchone()[0],1)
            self.assertEqual(news.sync(path,NOW+timedelta(minutes=2),fetch,[SOURCE],force=False),[])
            retried=news.sync(path,NOW+timedelta(minutes=31),fetch,[SOURCE],force=False)
            self.assertEqual(retried[0]['policy_revision'],biz.POLICY_REVISION)
            self.assertFalse(retried[0]['error'])

    def test_policy_review_reaches_later_known_pages_and_preserves_original_seen_time(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'agency.db';news.init_db(path)
            calls=[]
            def fetch(url):
                if 'Detail.do' in url:return detail_html(detail())
                page=int(biz.urllib.parse.parse_qs(biz.urllib.parse.urlsplit(url).query)['cpage'][0])
                calls.append(page)
                return listing([page],page+1 if page<3 else None)
            with patch.object(biz,'POLICY_REVISION','previous'):
                news.sync(path,NOW,fetch,[SOURCE])
            calls.clear()
            first_seen={item['id']:item['first_seen_at'] for item in news.report(path,NOW)['items']}
            result=news.sync(path,NOW+timedelta(minutes=1),fetch,[SOURCE],force=False)
            self.assertEqual(calls,[1,2,3])
            self.assertEqual(result[0]['last_added'],0)
            self.assertEqual({item['id']:item['first_seen_at'] for item in news.report(path,NOW)['items']},first_seen)


if __name__=='__main__':unittest.main()
