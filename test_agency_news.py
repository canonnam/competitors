"""Public board parsing, selection, pagination, archive safety and scheduling."""
from datetime import datetime, timedelta
from html import escape
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import app
import agency_news as news

NOW = datetime(2026, 9, 8, 18, tzinfo=news.KST)
NHIS = news.SOURCES[0]
MOHW = news.SOURCES[7]


def nhis_page(entries, following=None, board='B0152'):
    rows = []
    for identity, title, day, pinned in entries:
        number = '<span class="noti">공지</span>' if pinned else identity
        rows.append(f'<tr><td headers="board_num">{number}</td><td headers="board_title" title="{escape(title)}" />'
                    f'<div><a href="?communityKey={board}&amp;boardId={identity}&amp;act=VIEW">{escape(title)}</a></div></td>'
                    f'<td headers="board_korname">요양심사실</td><td headers="board_create">{day}</td></tr>')
    tail = f'<a href="?communityKey={board}&amp;act=LIST&amp;pageNum={following}&amp;pageSize=10">다음</a>' if following else ''
    return '<table>' + ''.join(rows) + '</table>' + tail


def entry(identity, title='장기요양기관 평가 안내', pinned=False, day='2026-09-08'):
    return (str(identity), title, day, pinned)


class AgencyNewsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'agency.db'
        news.init_db(self.path)

    def state(self):
        with news.connect(self.path) as db:
            return news.states(db)

    def test_requested_nine_sources_and_distinct_board_identifiers(self):
        self.assertEqual(len(news.SOURCES), 10)
        self.assertEqual({s['board'] for s in news.SOURCES}, {'B0152','B0153','B0045','B0010','B0017','B0018','B0019','0027','0003','bizinfo'})
        self.assertIn('/npbs/e/d/320/nped320m01.web', news.SOURCES[1]['url'])
        self.assertEqual(len({s['id'] for s in news.SOURCES}), 10)

    def test_nhis_self_closing_title_cells_pins_and_next_page(self):
        raw = nhis_page([entry(100, pinned=True), entry(99)], 2)
        items, following = news.parse_list(raw, NHIS, news.listing_url(NHIS))
        self.assertEqual(len(items), 2)
        self.assertTrue(items[0]['pinned'])
        self.assertFalse(items[1]['pinned'])
        self.assertEqual(items[0]['title'], '장기요양기관 평가 안내')
        self.assertIn('boardId=100', items[0]['url'])
        self.assertIn('pageNum=2', following)

    def test_mohw_list_and_detail_exclude_navigation_and_hidden_new_label(self):
        raw = '<table><tr><td data-label="제목"><a class="txt_title" href="/board.es?mid=a10503010100&amp;bid=0027&amp;act=view&amp;list_no=123"><span class="sr_only">새글</span>돌봄 기업 지원..</a></td><td data-label="등록일">2026-09-08</td></tr></table>'
        items, _ = news.parse_list(raw, MOHW, news.listing_url(MOHW))
        self.assertEqual(items[0]['title'], '돌봄 기업 지원..')
        detail = '<nav>장기요양 노인 돌봄</nav><article class="board_view"><h2 class="title">전체 제목</h2><div class="contents"><p>본문입니다.</p><script>오염된 내용</script></div></article><footer>치매 장기요양</footer>'
        self.assertEqual(news.mohw_detail(detail), ('전체 제목', '본문입니다.'))

    def test_related_topics_and_exclusion_of_incidental_child_policy_mentions(self):
        for title in ['요양보호사 보수교육 안내', '장기요양기관 재무회계 규칙', '통합돌봄 시범사업', '돌봄 기술 기업 투자 지원']:
            self.assertTrue(news.relevance(title, '', MOHW)[0])
        self.assertTrue(news.relevance('2027년 복지부 예산안', '통합돌봄과 사회복지시설 인건비 지원을 확대합니다.', MOHW)[0])
        for title, body in [('아동학대 예방 대응 회의','통합돌봄 예산도 간단히 소개했다.'),
                            ('아동학대 대응인력 힐링캠프', '돌봄 현장 종사자들이 Trail 프로그램에 참여합니다.'),
                            ('국민연금 투자 현황','노인 지원사업을 소개했다.'),
                            ('건강보험 보장 확대','희귀질환 전문 요양병원 지원 검토')]:
            self.assertFalse(news.relevance(title, body, MOHW)[0])
        self.assertFalse(news.matches('Trail chairs', ('AI',)))
        self.assertTrue(news.matches('장기요양 AI 교육', ('AI',)))
        self.assertTrue(news.relevance('감염관리 매뉴얼 게시', '', news.SOURCES[2])[0])

    def test_empty_invalid_or_external_board_content_does_not_mark_success(self):
        for raw in ['<html>점검 중</html>', nhis_page([entry(1)], board='B0010'),
                    nhis_page([entry(1)]).replace('2026-09-08','2026-99-08')]:
            with self.assertRaises(ValueError):
                news.parse_list(raw, NHIS, news.listing_url(NHIS))
        for url in ['http://www.mohw.go.kr/', 'https://127.0.0.1/', 'https://www.mohw.go.kr.evil.test/', 'https://user@www.mohw.go.kr/']:
            with self.assertRaises(ValueError): news.checked_url(url)

    def test_restart_deduplicates_posts_and_preserves_old_records(self):
        first = news.sync(self.path, NOW, lambda _: nhis_page([entry(1)]), [NHIS])
        news.init_db(self.path)
        second = news.sync(self.path, NOW, lambda _: nhis_page([entry(1)]), [NHIS])
        self.assertEqual(first[0]['last_added'], 1)
        self.assertEqual(second[0]['last_added'], 0)
        self.assertEqual(news.report(self.path, NOW)['total'], 1)

    def test_pinned_known_post_does_not_hide_new_posts_on_later_pages(self):
        first_rows, _ = news.parse_list(nhis_page([entry(1), entry(9,pinned=True)]), NHIS, news.listing_url(NHIS))
        seen = {row['id']:news.fingerprint(row) for row in first_rows}
        pages = {1:nhis_page([entry(9,pinned=True), entry(4)], 2),
                 2:nhis_page([entry(9,pinned=True), entry(3)], 3),
                 3:nhis_page([entry(2), entry(1)])}
        calls = []
        def fetch(url):
            page = int(news.urllib.parse.parse_qs(news.urllib.parse.urlsplit(url).query).get('pageNum',['1'])[0]);calls.append(page)
            return pages[page]
        selected, scanned = news.collect(NHIS, seen, NOW, fetch)
        self.assertEqual(calls, [1,2,3])
        self.assertEqual({item['id'] for item in selected}, {'nhis_B0152:2','nhis_B0152:3','nhis_B0152:4'})

    def test_bootstrap_keeps_old_pinned_guidance_but_skips_old_normal_posts(self):
        selected, scanned = news.collect(NHIS, {}, NOW, lambda _: nhis_page([entry(1,day='2020-01-01',pinned=True),entry(2,day='2020-01-01')]))
        self.assertEqual([item['id'] for item in selected], ['nhis_B0152:1'])
        self.assertEqual(len(scanned), 2)

    def test_changed_title_refreshes_existing_post_without_duplicate(self):
        news.sync(self.path, NOW, lambda _: nhis_page([entry(1)]), [NHIS])
        news.sync(self.path, NOW, lambda _: nhis_page([entry(1,'수정된 평가 안내')]), [NHIS])
        report = news.report(self.path, NOW)
        self.assertEqual(report['total'], 1)
        self.assertEqual(report['items'][0]['title'], '수정된 평가 안내')

    def test_failed_page_preserves_previous_success_archive_and_watermark(self):
        news.sync(self.path, NOW, lambda _: nhis_page([entry(1)]), [NHIS])
        before = self.state()[NHIS['id']]['last_success']
        def fetch(url):
            if 'pageNum=2' in url: raise TimeoutError('test timeout')
            return nhis_page([entry(3),entry(2)],2)
        news.sync(self.path, NOW+timedelta(days=1), fetch, [NHIS])
        state = self.state()[NHIS['id']]
        self.assertEqual(state['last_success'], before)
        self.assertTrue(state['error'])
        self.assertEqual(news.report(self.path, NOW)['total'],1)
        with news.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM seen').fetchone()[0],1)
        self.assertEqual(news.next_run(state,NOW),NOW+timedelta(days=1,minutes=30))

    def test_daily_schedule_is_0910_kst_and_catches_up_after_restart(self):
        state={'last_success':NOW.isoformat()}
        boundary=datetime(2026,9,9,9,10,tzinfo=news.KST)
        self.assertEqual(news.next_run(state,boundary-timedelta(seconds=1)),boundary)
        self.assertEqual(news.next_run(state,boundary),boundary)
        self.assertEqual(news.next_run(state,boundary+timedelta(hours=1)),boundary+timedelta(hours=1))
        self.assertEqual(news.next_run({'last_success':boundary.isoformat()},boundary),boundary+timedelta(days=1))

    def test_successful_boards_are_not_refetched_when_other_boards_need_retry(self):
        news.sync(self.path,NOW,lambda _:nhis_page([entry(1)]),[NHIS])
        with patch.object(news,'collect') as collector:
            news.sync(self.path,NOW+timedelta(minutes=30),sources=[NHIS],force=False)
            collector.assert_not_called()

    def test_api_summary_head_and_private_source_files(self):
        server=app.ThreadingHTTPServer(('127.0.0.1',0),app.App)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with patch.object(news,'db_path',return_value=self.path):
                for method,route in [('GET','/api/agency-news'),('GET','/api/agency-news?summary=1'),('HEAD','/api/agency-news')]:
                    conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5);conn.request(method,route)
                    response=conn.getresponse();raw=response.read();conn.close()
                    self.assertEqual(response.status,200);self.assertEqual(response.headers['Cache-Control'],'no-store')
                    self.assertIn('noindex',response.headers['X-Robots-Tag'])
                    if method=='HEAD':self.assertEqual(raw,b'')
                    else:
                        body=json.loads(raw);self.assertEqual(len(body['sources']),10);self.assertEqual('items' in body,'summary' not in route)
                for route in ['/agency_news.py','/data/agency_news_sources.json','/business_support.py','/data/company_support_profile.json']:
                    conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5);conn.request('GET',route)
                    response=conn.getresponse();response.read();conn.close();self.assertEqual(response.status,404)
        finally:server.shutdown();server.server_close();thread.join(5)


if __name__=='__main__':unittest.main()
