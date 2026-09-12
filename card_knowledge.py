"""Fresh, bounded evidence from the same saved data as each homepage card.

No collector, remote request, personal form state, or wiki import is run here.
The fixed registry is also the coverage inventory for chat/status and tests.
"""
from collections import defaultdict
from calendar import monthrange
from datetime import timedelta
from html.parser import HTMLParser
import hashlib
import json
import re

CARDS = {
    'payroll': ('급여 계산·근로계약서', '/payroll.html'),
    'claim_check': ('지점별 청구 점검', '/claim-check.html'),
    'agency_news': ('건보공단·복지부 뉴스·지원사업', '/agency-news.html'),
    'ai_hub': ('AI 허브 활용데이터', '/ai-hub-data.html'),
    'naver_ads': ('네이버 광고분석', '/naver-ads.html'),
    'search_visibility': ('검색노출 현황', '/search-visibility.html'),
    'reputation': ('더비다요양원 평판 점검', '/reputation-watch.html'),
    'nearby': ('주변 영업처 지도', '/nearby-facilities.html'),
    'statistics': ('통계자료', '/statistics.html'),
}
ALIASES = {
    'payroll': ('급여계산', '급여계산기', '근로계약', '통상임금', '통상시급', '주휴시간', '주주야야', '연장수당', '야간수당'),
    'claim_check': ('청구점검', '청구현황', '청구상태', '청구여부', '청구마감', '접수완료', '청구처리'),
    'agency_news': ('건보공단', '복지부', '공공기관', '기관뉴스', '지원사업', '지원금', '정부지원', '공고', '지원추천', '사업추천'),
    'ai_hub': ('ai허브', 'aihub', 'ai데이터', '활용데이터', '데이터셋', '학습데이터'),
    'naver_ads': ('광고', '파워링크', '플레이스효율', 'cpc', 'ctr', '클릭률', '클릭수', '소재성과'),
    'search_visibility': ('검색현황', '검색노출', '검색순위', '노출현황', 'seo', 'aeo', 'geo', '챗지피티', 'chatgpt', 'gemini', '제미나이', 'ai언급', '웹언급', '미션'),
    'reputation': ('평판', '부정적언급', '부정언급', '불만', '악성리뷰'),
    'nearby': ('영업처', '주변', '인근', '가까운', '연락처', '전화번호', '지도'),
    'statistics': ('통계', '책갈피', '조사자료', '보건사회연구원', '실태조사'),
}


def match(question):
    q = re.sub(r'\s+', '', question.lower())
    found = {key for key, words in ALIASES.items() if any(w in q for w in words)}
    if '청구' in q and any(w in q for w in ('안양', '인천', '더비다', '했', '됐', '되었')):
        found.add('claim_check')
    return found


def ro_path(path):
    # URI mode=ro cannot create a missing database or modify a collector's data.
    if not path.is_file():
        raise FileNotFoundError('Saved card data is unavailable')
    return path.resolve().as_uri() + '?mode=ro'


def saved_report(kind, now):
    if kind == 'search_visibility':
        import search_visibility as v
        import naver_ads
        return v.report(ro_path(v.db_path()), ad_path=ro_path(naver_ads.db_path()), now=now)
    if kind == 'naver_ads':
        import naver_ads as module
    elif kind == 'agency_news':
        import agency_news as module
    elif kind == 'reputation':
        import reputation_watch as module
    elif kind == 'claim_check':
        import claim_check
        return claim_check.report(now=now)
    else:
        raise ValueError('Unknown card')
    return module.report(ro_path(module.db_path()), now=now)


def select_branches(question):
    return [ident for ident, name in [('anyang', '안양'), ('incheon', '인천')] if name in question]


def fields(row, names):
    """Only explicitly public, meaningful fields may become model evidence."""
    return {name: row[name] for name in names.split() if name in row}


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def ranked(question, rows, text, limit=5):
    from service_knowledge import tokens, compact
    ignore = {'알려주세요', '알려줘', '최근', '최신', '자료', '현황', '추천', '질문', '통계', '뉴스', '지원사업'}
    words = tokens(question) - ignore
    return sorted(rows, key=lambda r: -sum(compact(w) in compact(text(r)) for w in words))[:limit]


def visibility(question, now, data):
    from service_knowledge import evidence
    branches = select_branches(question)
    names = {b['id']: b['name'] for b in data['branches']}
    result = []
    for provider in data['providers']:
        q = re.sub(r'\s+', '', question.lower())
        requested = {p for p, aliases in [('naver', ('네이버',)), ('chatgpt_web', ('chatgpt', '챗지피티')), ('gemini_web', ('gemini', '제미나이'))]
                     if any(a in q for a in aliases)}
        if requested and provider['id'] not in requested:
            continue
        summaries, details = [], []
        for branch in branches or list(names):
            rows = [r for r in provider['items'] if r.get('branch') == branch]
            checked = [r for r in rows if r.get('status') == 'ready' and not r.get('stale')]
            is_naver = provider['id'] == 'naver'
            summaries.append(f"{names[branch]}: 등록 질문·키워드 {len(rows)}개, 최신 측정 완료 {len(checked)}개, "
                f"지점 언급 {sum(bool(r.get('branch_result', {}).get('mentioned')) for r in checked)}개, "
                + (f"광고 제외 첫 페이지 {sum(r.get('branch_result', {}).get('first_page') == 1 for r in checked)}개, " if is_naver else '')
                + f"측정 대기·오류·지난 결과 {len(rows)-len(checked)}개.")
            selected = ranked(question, rows, lambda r: r['keyword'], limit=20 if len(branches) == 1 else 12)
            for row in selected:
                detail = fields(row, 'keyword branch status stale observed_at error measurement_type')
                detail['지점별_결과'] = fields(row.get('branch_result', {}), 'mentioned first_page branch_unconfirmed')
                # Only include matching links when the question asks for their detail.
                if any(w in question for w in ('출처', '원문', '어디', '링크', '상세')):
                    detail['확인된_링크'] = [fields(m, 'area title url page position') for m in row.get('branch_result', {}).get('matches', [])[:3]]
                # Retain registered query and result, without session metadata or user-entered notes.
                if row.get('mission'):
                    detail['미션_진행'] = fields(row['mission'], 'track_label completed total')
                    if any(w in question for w in ('미션', '개선', '해야', '할일', '할 일')):
                        detail['현재_미션'] = fields(row['mission'].get('current') or {}, 'title why steps done')
                details.append(detail)
        updated = max((r.get('observed_at') or '' for r in provider['items'] if not branches or r.get('branch') in branches), default='')
        scope = (f"조회 시각 {now.isoformat()}. 저장된 {provider.get('label', provider.get('name', provider['id']))} 관측 결과. "
                 "최신 측정 완료만 현재 집계에 포함합니다. 미측정·오류는 미노출/언급 없음이 아니며, 지난 관측은 시각을 표시해 구분합니다. "
                 "지점 미확인 브랜드 언급은 해당 지점 노출로 계산하지 않습니다. 네이버 광고와 자연 검색은 별개이며 AI 웹 답변은 고정 순위가 아닙니다. "
                 "계정·모드·위치·질문에 따라 달라지는 표본이며 지금 새로 웹 검색한 결과가 아닙니다.\n")
        result.append(evidence('search_visibility', provider.get('label', provider.get('name', provider['id'])) + ' 검색노출 현황',
                               scope + '\n'.join(summaries) + '\n키워드별 발췌: ' + dump(details), updated))
    return result


def ads(question, now, data):
    from service_knowledge import evidence, requested_months
    if select_branches(question) == ['anyang']:
        return [evidence('naver_ads', '광고분석 조회 범위', '현재 광고 자료는 인천점 계정입니다. 안양점 광고 실적은 연결되어 있지 않습니다.', data.get('updated_at') or '')]
    daily = [r for r in data['daily'] if r['level'] == 'campaign']
    available = sorted({r['date'][:7] for r in daily})
    q = re.sub(r'\s+', '', question)
    start, end = data.get('since') or '', data.get('through') or ''
    if re.search(r'\d월|\d분기|20\d{2}|이번달|지난달|최근\d+개월|상반기|하반기|올해|작년', q):
        months = requested_months(question, now.date(), available)
        daily = [r for r in daily if r['date'][:7] in months]
        year, month = map(int, months[-1].split('-'))
        start, end = months[0] + '-01', f'{months[-1]}-{monthrange(year, month)[1]:02d}'
    elif '오늘' in q or '어제' in q or '최근' in q or not re.search(r'전체|누적|월별', q):
        count = re.search(r'최근(\d{1,3})일', q)
        last = now.date() if '오늘' in q else now.date() - timedelta(days=1)
        days = 1 if '오늘' in q or '어제' in q else int(count[1]) if count else 7
        start, end = (last - timedelta(days=days-1)).isoformat(), last.isoformat()
        daily = [r for r in daily if start <= r['date'] <= end]
    def total(rows):
        totals = {k: round(sum(r[k] for r in rows), 2) for k in ('impressions', 'clicks', 'cost')}
        return {'노출수': totals['impressions'], '클릭수': totals['clicks'], '광고비_VAT포함_원': totals['cost'],
                'CTR_퍼센트': round(totals['clicks']/totals['impressions']*100, 2) if totals['impressions'] else None,
                'CPC_원': round(totals['cost']/totals['clicks'], 2) if totals['clicks'] else None}
    channels, months = defaultdict(list), defaultdict(list)
    for row in daily:
        channels[row['channel']].append(row)
        months[row['date'][:7]].append(row)
    stats = {'조회기간': [start, end], '보유기간': [data.get('since'), data.get('through')],
             '합계': total(daily) if daily else '해당 기간 자료 없음. 0원으로 해석하지 않음',
             '채널별': {k: total(v) for k, v in channels.items()}, '월별': {k: total(v) for k, v in months.items()},
             '수집상태': fields(data.get('sync', {}), 'enabled stale error schedule target_date')}
    keywords = data.get('keywords', {})
    stats['키워드_최근7일_광고순위'] = {**fields(keywords, 'updated_at through stale error total top_count eligible_top_count'),
        'items': [fields(r, 'keyword average_rank eligible impressions clicks cost') for r in ranked(question, keywords.get('items', []), lambda r: r.get('keyword', ''), 12)]}
    notes = '인천점 광고 계정의 캠페인 합계이며 소재를 중복 합산하지 않았습니다. CTR·CPC는 합산값에서 계산했습니다. ' \
            '자료가 없는 날짜를 0으로 채우거나 다른 기간으로 대체하지 마세요. 수집 완료일까지의 부분 집계일 수 있습니다. 광고 평균순위와 자연 검색 페이지는 다릅니다. 상담·입소 전환은 측정하지 않습니다.\n'
    result = [evidence('naver_ads', '인천점 네이버 광고 실적·조회 범위', notes + dump(stats), data.get('updated_at') or '')]
    if any(w in question for w in ('소재', '이전 분석', '분석 기록')):
        creatives = defaultdict(list)
        for row in data['daily']:
            if row['level'] == 'creative' and start <= row['date'] <= end:
                creatives[row['title']].append(row)
        result.append(evidence('naver_ads', '광고 소재·이전 분석 기록', dump({'소재별': {k: total(v) for k,v in list(creatives.items())[:20]},
            '이전분석_당시기준': data.get('history', {})}), data.get('updated_at') or ''))
    return result


def agency(question, now, data):
    from service_knowledge import evidence, safe_url, requested_months, compact
    rows = data['items']
    support = any(w in question for w in ('지원', '공고', '추천'))
    if support:
        rows = [r for r in rows if r.get('kind') == 'support']
        if not any(w in question for w in ('마감', '종료', '전체', '관심없', '제외')):
            rows = [r for r in rows if r.get('application_status', {}).get('active') and r.get('preference') != 'not_interested']
    else:
        rows = [r for r in rows if r.get('kind') != 'support']
    agencies = [term for word, term in [('복지부', '복지부'), ('건보공단', '공단')] if word in question]
    if agencies:
        rows = [r for r in rows if any(term in str(r.get('agency', '')) for term in agencies)]
    q = compact(question)
    period = '보유 전체 게시일'
    if any(w in q for w in ('오늘', '어제', '최근')) and ('오늘' in q or '어제' in q or re.search(r'최근\d+일',q)):
        count = re.search(r'최근(\d{1,3})일',q)
        end = now.date()-timedelta(days=1 if '어제' in q else 0)
        start = end-timedelta(days=max(1,int(count[1]))-1 if count else 0)
        rows = [r for r in rows if start.isoformat() <= r.get('published_at', '')[:10] <= end.isoformat()]
        period = f'{start}~{end}'
    elif re.search(r'\d월|20\d{2}|이번달|지난달|최근\d+개월|올해|작년|분기|상반기|하반기',q):
        periods = requested_months(question, now.date(), [now.strftime('%Y-%m')])
        rows = [r for r in rows if r.get('published_at','')[:7] in periods]
        period = ', '.join(periods)
    header = f"조회일 {now.date()}; 게시일 범위 {period}; 해당 조건 {len(rows)}건. 수집 상태: {dump(fields(data.get('sync', {}), 'stale errors schedule'))}. " \
             '저장된 공고·뉴스만 조회했습니다. 게시일과 시행일은 다릅니다. 지원사업 추천은 신청 자격 확정이 아니며 대상·신청기간·확인 조건을 유지하세요.'
    result = [evidence('agency_news', '공공기관 뉴스·지원사업 조회 범위', header, data.get('updated_at') or '')]
    for row in ranked(question, rows, lambda r: str(r.get('title', '')) + str(r.get('summary', '')), 5):
        content = fields(row, 'title agency source kind published_at collected_at summary application_period application_status target benefit reasons cautions fit_reasons checks preference recommendation_score research_focus withdrawn')
        if not row.get('summary') and row.get('kind') != 'support':
            content['본문_범위'] = '제목만 수집되었습니다. 원문 전체를 확인한 것처럼 설명하지 마세요.'
        result.append(evidence('agency_news', row['title'], dump(content), row.get('collected_at') or row.get('published_at', ''),
                               url=safe_url(row.get('url'))))
    return result


def reputation(question, now, data):
    from service_knowledge import evidence, safe_url
    branches = select_branches(question)
    rows = [r for r in data.get('items', []) if not branches or r.get('identity') in branches or r.get('identity') in ('brand', 'unknown')]
    active = [r for r in rows if r.get('active')]
    info = {'점검상태': fields(data['sync'], 'complete checked_sources expected_sources schedule'),
            '전체지점_집계': data['counts'], '선택지점_후보수': len(active),
            '분석상태': fields(data['analysis'], 'pending error'),
            '수집처별': [fields(r, 'name branch fresh error last_success') for r in data['sources']]}
    result = [evidence('reputation', '평판 점검 범위·수집 상태',
        '공개 검색 결과에서 찾은 부정적 언급 후보이며 사실로 확정된 사건이 아닙니다. 후보 없음은 인터넷 전체에 불만이 없다는 뜻이 아닙니다. 점검 미완료·분석 대기 여부를 함께 안내하세요.\n' + dump(info), data.get('updated_at') or '')]
    for row in active[:5]:
        result.append(evidence('reputation', row.get('title', '검토할 언급'), dump(fields(row, 'title excerpt source verdict evidence category identity first_detected last_detected active seen_in_latest_search')),
                               row.get('last_detected', ''), 'needs-review', safe_url(row.get('url'))))
    return result


def claims(question, now, data):
    from service_knowledge import evidence, requested_months
    if re.search(r'\d+월|20\d{2}-\d{2}', question):
        months = requested_months(question, now.date(), [data['benefitMonth']])
        if months != [data['benefitMonth']]:
            return [evidence('claim_check', '청구 점검 조회 범위', f"요청한 급여제공월 {', '.join(months)}의 청구 결과는 현재 카드에서 제공하지 않습니다. 현재 카드의 대상 급여제공월은 {data['benefitMonth']}입니다.")]
    selected = select_branches(question)
    rows = [r for r in data['branches'] if not selected or r['id'] in selected]
    return [evidence('claim_check', '지점별 장기요양 청구 점검',
        '이번 점검 대상 급여제공월과 조회 시각을 구분하세요. 접수 완료는 지급 완료가 아닙니다. 과거 월의 청구 결과를 현재 월로 바꾸지 마세요.\n' + dump({
            '급여제공월': data['benefitMonth'], '마감일': data['deadline'],
            '지점': [fields(r, 'name status label message checkedAt lastQueryFailureAt claims missing verifiedItems') for r in rows]}),
        max((r.get('checkedAt') or '' for r in rows), default=''))]


class PageText(HTMLParser):
    """Read authored text only: never input values, scripts, styles, or forms' state."""
    def __init__(self):
        super().__init__()
        self.main = False
        self.skip = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'main':
            self.main = True
        if tag in ('script', 'style'):
            self.skip += 1
        if self.main and tag in ('p', 'h1', 'h2', 'h3', 'li', 'section', 'article', 'summary', 'label'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag == 'main':
            self.main = False
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip-1)

    def handle_data(self, text):
        if self.main and not self.skip:
            self.parts.append(text)


def static_page(kind, question):
    from service_knowledge import ROOT, evidence
    parser = PageText()
    path = ROOT / CARDS[kind][1].lstrip('/')
    parser.feed(path.read_text(encoding='utf-8'))
    content = re.sub(r'[ \t]+', ' ', ''.join(parser.parts)).strip()
    updated = '화면 자료 버전 ' + hashlib.sha256(path.read_bytes()).hexdigest()[:10]
    if kind == 'ai_hub':
        dates = re.findall(r'확인일\s*(\d{4}-\d{2}-\d{2})', content)
        updated = dates[-1] if dates else updated
        return [evidence(kind, CARDS[kind][0], content, updated)]
    result = [evidence(kind, '급여 계산·계약서 사용 범위',
        '카드의 공통 사용법과 양식만 참조합니다. 개별 직원 입력값·계약서·급여를 저장하거나 조회하지 않습니다. 계산 결과가 필요한 경우 화면에 근무조건을 입력해야 합니다. 양식 문구를 현행 법률의 확정적 해석으로 사용하지 마세요.\n' + content, updated)]
    templates = json.loads((ROOT / 'assets/contracts/templates.json').read_text(encoding='utf-8'))
    for template in templates.values():
        clauses = [c['text'] for c in template['cells'] if c.get('c') == 2 and c.get('cols', 0) > 5 and c.get('text')]
        result.append(evidence(kind, template['name'] + ' 공통 문구', '\n\n'.join(clauses), updated))
    return result


def statistics(question):
    from service_knowledge import ROOT, load_json, evidence, safe_url
    data = load_json('statistics_knowledge.json')
    source = (ROOT / 'assets/statistics-data.js').read_text(encoding='utf-8')
    if hashlib.sha256(source.encode()).hexdigest() != data['sourceHash']:
        raise ValueError('Statistics export is stale')
    docs = {d['id']: d for d in data['documents']}
    result = [evidence('statistics', '통계자료·책갈피 목록',
        '원문 전체가 아닌 카드의 검토된 발췌입니다. 발행일·조사연도·대상·분모를 구분하며 전국 통계를 두 지점의 실적으로 해석하지 마세요.\n' +
        dump([fields(d, 'title published survey publisher summary scope') for d in docs.values()]), data['reviewedAt'])]
    for row in ranked(question, data['bookmarks'], lambda r: dump(fields(r, 'title topic insight metricLabel')), 6):
        doc = docs[row['documentId']]
        result.append(evidence('statistics', row['title'], dump({'문헌': fields(doc, 'title published survey publisher scope'),
            '발췌': fields(row, 'metric metricLabel insight action caveat pdfPage printedPage figure')}),
            data['reviewedAt'], url=safe_url(doc.get('sourceUrl'))))
    return result


def nearby(question):
    from service_knowledge import load_json, evidence
    data = load_json('nearby_facilities.json')
    selected = [name for name in ('안양', '인천') if name in question]
    rows = [r for r in data['facilities'] if not selected or r['branch'] in selected]
    kinds = sorted({r['kind'] for r in rows}, key=len, reverse=True)
    kind = next((k for k in kinds if k in question), None)
    if kind:
        rows = [r for r in rows if r['kind'] == kind]
    radius = re.search(r'(\d+(?:\.\d+)?)\s*(?:km|킬로)', question.lower())
    if radius:
        rows = [r for r in rows if r['distanceKm'] <= float(radius[1])]
    if '방문목욕' in question:
        rows = [r for r in rows if r.get('bathListed')]
    names = [r for r in rows if r['name'] in question]
    if names:
        rows = names
    rows.sort(key=lambda r: r['distanceKm'])
    content = {'조건에_맞는_등록시설수': len(rows), '선택지점': selected or ['안양', '인천'],
               '유형별_기준일': data.get('categoryUpdatedAt'), '가까운_시설_최대10개': [fields(r, 'branch name kind address phone distanceKm bathListed services note source sourceName') for r in rows[:10]]}
    return [evidence('nearby', '주변 영업처·시설 조회',
        '지점 기준 직선거리이며 이동거리가 아닙니다. 공개 연락처이며 운영 여부·서비스·빈자리는 재확인해야 합니다. 등록자료 범위 내 목록입니다.\n' + dump(content), data.get('asOf', ''))]


def retrieve(kind, question, now):
    if kind in ('ai_hub', 'payroll'):
        return static_page(kind, question)
    if kind == 'statistics':
        return statistics(question)
    if kind == 'nearby':
        return nearby(question)
    data = saved_report(kind, now)
    return {'search_visibility': visibility, 'naver_ads': ads, 'agency_news': agency,
            'reputation': reputation, 'claim_check': claims}[kind](question, now, data)


def status():
    from service_knowledge import ROOT
    import agency_news, naver_ads, search_visibility, reputation_watch, claim_check
    paths = {'payroll': [ROOT / 'payroll.html', ROOT / 'assets/contracts/templates.json'],
             'ai_hub': [ROOT / 'ai-hub-data.html'], 'claim_check': [claim_check.data_path()],
             'agency_news': [agency_news.db_path()], 'naver_ads': [naver_ads.db_path()],
             'search_visibility': [search_visibility.db_path(), naver_ads.db_path()],
             'reputation': [reputation_watch.db_path()], 'nearby': [ROOT / 'data/nearby_facilities.json'],
             'statistics': [ROOT / 'data/statistics_knowledge.json']}
    return [{'id': k, 'label': label, 'url': url, 'available': all(p.is_file() for p in paths[k]),
             'refresh': 'on_question'} for k, (label, url) in CARDS.items()]
