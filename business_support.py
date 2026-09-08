"""Bizinfo announcements matched to CompassOne; recommendations are not eligibility decisions."""
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.parse

from agency_news import Document, checked_url, matches, normalized

PROFILE = json.loads((Path(__file__).parent / 'data/company_support_profile.json').read_text(encoding='utf-8'))
if os.getenv('BUSINESS_SUPPORT_PROFILE_JSON'):
    overrides = json.loads(os.environ['BUSINESS_SUPPORT_PROFILE_JSON'])
    PROFILE = {**PROFILE, **overrides, 'certifications': {**PROFILE['certifications'], **overrides.get('certifications', {})}}
LIST_PATH = '/sii/siia/selectSIIA200View.do'
DETAIL_PATH = '/sii/siia/selectSIIA200Detail.do'
ORIGIN = 'https://www.bizinfo.go.kr'
BOOTSTRAP_PAGES = 10
MAX_PAGES = 100
POLICY_REVISION = '2026-09-09-regions-care-ai'


def list_url(page=1):
    return ORIGIN + LIST_PATH + '?' + urllib.parse.urlencode({
        'rows': 15, 'cpage': page, 'orderGb': '1', 'sort': 'desc', 'schEndAt': 'N'})


def parse_list(html, source, page):
    root = Document(html).root
    rows = []
    for tr in root.all('tr'):
        cells = [child for child in tr.children if getattr(child, 'tag', '') == 'td']
        if not any(cell.has_class('txt_l') for cell in cells):
            continue
        if len(cells) != 8:
            raise ValueError('Unexpected Bizinfo table columns')
        link = next((node for node in cells[2].all('a') if 'pblancId=' in node.attrs.get('href', '')), None)
        if link is None:
            raise ValueError('Missing Bizinfo announcement link')
        url = urllib.parse.urlsplit(checked_url(urllib.parse.urljoin(ORIGIN, link.attrs['href'])))
        identity = urllib.parse.parse_qs(url.query).get('pblancId', [''])[0]
        if url.netloc != 'www.bizinfo.go.kr' or url.path != DETAIL_PATH or not re.fullmatch(r'PBLN_\d+', identity):
            raise ValueError('Unexpected Bizinfo announcement identifier')
        title = link.text()
        if not title:
            raise ValueError('Missing Bizinfo title')
        rows.append({'id': source['id'] + ':' + identity, 'title': title,
                     'url': ORIGIN + DETAIL_PATH + '?pblancId=' + identity,
                     'published_at': date.fromisoformat(cells[6].text()).isoformat(),
                     'category': cells[1].text(), 'application_period': cells[3].text(),
                     'department': cells[4].text(), 'operator': cells[5].text(),
                     'source_id': source['id'], 'source': source['name'], 'agency': source['agency'],
                     'pinned': False, 'kind': 'support'})
    if not rows:
        raise ValueError('No Bizinfo announcements found; previous records retained')
    following = False
    for a in root.all('a'):
        parsed = urllib.parse.urlsplit(urllib.parse.urljoin(ORIGIN, a.attrs.get('href', '')))
        if parsed.netloc == 'www.bizinfo.go.kr' and parsed.path == LIST_PATH and urllib.parse.parse_qs(parsed.query).get('cpage') == [str(page+1)]:
            following = True
            break
    return rows, following


def parse_detail(html):
    root = Document(html).root
    view = next((node for node in root.all('div') if node.has_class('support_project_detail')), None)
    if view is None:
        raise ValueError('Missing Bizinfo announcement detail')
    heading = next((node for node in view.all('h2') if node.has_class('title')), None)
    content = next((node for node in view.all('div') if node.has_class('view_cont')), None)
    if heading is None or content is None:
        raise ValueError('Incomplete Bizinfo announcement')
    fields = {}
    for row in content.all('li'):
        label = next((node for node in row.all('span') if node.has_class('s_title')), None)
        value = next((node for node in row.all('div') if node.has_class('txt')), None)
        if label is not None and value is not None:
            fields[label.text()] = value.text()
    overview = fields.get('사업개요', '')
    if not heading.text() or not overview or not fields.get('신청기간'):
        raise ValueError('Missing Bizinfo application period or overview')
    bullets = [part.strip() for part in re.split(r'☞\s*', overview)[1:] if part.strip()]
    return {'title': heading.text(), 'overview': overview,
            'target': bullets[0] if bullets else overview[:500],
            'benefit': bullets[1] if len(bullets) > 1 else '',
            'application_period': fields['신청기간'],
            'application_method': fields.get('사업신청 방법', ''),
            'contact': fields.get('문의처', '')}


def period_status(period, today):
    raw_dates = re.findall(r'\d{4}[.\-/]\d{2}[.\-/]\d{2}', period)
    dates = [date.fromisoformat(re.sub(r'[./]', '-', value)) for value in raw_dates]
    if len(dates) >= 2:
        start, end = dates[0], dates[1]
        if end < start:
            raise ValueError('Reversed application dates')
        if today > end:
            label = '마감'
        elif today < start:
            label = '접수 예정'
        else:
            label = '접수기간 내'
        return {'label': label, 'deadline': end.isoformat(), 'days_left': (end-today).days,
                'active': today <= end}
    return {'label': '접수 여부 확인', 'deadline': None, 'days_left': None, 'active': True}


REGIONS = {
    '서울': ('서울', '서울특별시'), '부산': ('부산', '부산광역시'),
    '대구': ('대구', '대구광역시'), '인천': ('인천', '인천시', '인천광역시'),
    '광주': ('광주', '광주광역시'), '대전': ('대전', '대전광역시'),
    '울산': ('울산', '울산광역시'), '세종': ('세종', '세종시', '세종특별자치시'),
    '경기': ('경기', '경기도'), '강원': ('강원', '강원도', '강원특별자치도'),
    '충북': ('충북', '충청북도'), '충남': ('충남', '충청남도'),
    '전북': ('전북', '전라북도', '전북특별자치도'), '전남': ('전남', '전라남도'),
    '경북': ('경북', '경상북도'), '경남': ('경남', '경상남도'),
    '제주': ('제주', '제주도', '제주특별자치도'),
}
CARE = ('장기요양', '요양원', '돌봄', '시니어', '고령친화', '고령자', '노인복지', '사회복지',
        '에이지테크', 'Age-Tech', '에이징테크', '복지시설')
AX = ('AX', 'AI전환', '인공지능전환', 'AI도입', 'AI활용', '인공지능도입', '인공지능활용', '지능화')
PHYSICAL_AI = ('피지컬AI', 'Physical AI', '돌봄로봇', '케어로봇', '재활로봇', '서비스로봇')
LOCATION = ('위치정보', '위치기반서비스', '위치기반사업', 'LBS', 'GPS')
GYEONGGI_CITIES = ('수원', '용인', '고양', '성남', '화성', '부천', '남양주', '안산', '평택', '안양',
                  '시흥', '파주', '김포', '의정부', '광주', '하남', '광명', '군포', '양주', '오산',
                  '이천', '안성', '구리', '의왕', '포천', '양평', '여주', '동두천', '과천', '가평', '연천')
SOFTWARE = ('SaaS', '클라우드', '소프트웨어', '정보통신', 'ICT', '디지털헬스', '헬스케어', '플랫폼개발', '플랫폼서비스', '서비스개발', 'ERP')
STARTUP = ('창업기업', '초기창업', '스타트업', '창업도약', '액셀러레이', '액셀러레이터', '창업사업화', '오픈이노베이션')
RESEARCH = ('연구개발', 'R&D', '기술개발', '산학연', '기업부설연구소', '연구인력', '기술사업화', '기술실증')
GENERAL = ('지식재산', '특허', '상표', '고용', '채용', '일자리', '인건비', '직무교육', '직업훈련', '직장어린이집',
           '경영컨설팅', '경영지원', '경영안정', '정책자금', '육성자금', '보증', '이자지원', '이차보전', '수출바우처', '디지털전환')


def named_regions(text, compact=False):
    # Bizinfo combines neighboring regions in labels such as [전남광주] and [대구경북].
    left = '' if compact else r'(?<![가-힣])'
    right = r'(?=$|[^가-힣]|소재|지역|관내|내|에' + ('|' + '|'.join(REGIONS) if compact else '') + ')'
    return {region for region, aliases in REGIONS.items() if any(
        re.search(left + re.escape(alias) + right, text)
        for alias in aliases)}


def geography_allowed(item, title, target, profile):
    allowed = set(profile['regions'])
    # Regional governments' programs remain out of scope even when recruiting nationwide.
    bracket = re.match(r'^\[([^]]+)\]', title)
    regional_scope = named_regions(item.get('department', ''))
    regional_scope |= named_regions(bracket.group(1), compact=True) if bracket else named_regions(title)
    if regional_scope and not regional_scope & allowed:
        return False
    target_scope = named_regions(target)
    if target_scope and not target_scope & allowed:
        return False
    # City-specific programs within Gyeonggi are not province-wide programs.
    cities = set(re.findall(r'(?<![가-힣])([가-힣]{2,6}(?:시|군))\s*(?:소재|관내|지역|내|에|중소기업|기업)', target))
    city_title = re.match(r'^(?:\[[^]]+\]\s*)?([가-힣]{2,6}(?:시|군))\s', title)
    if city_title:
        cities.add(city_title.group(1))
    for label in (item.get('department', ''), bracket.group(1) if bracket else ''):
        cities.update(re.findall(r'(?<![가-힣])([가-힣]{2,6}(?:시|군))(?=$|[^가-힣])', label))
    province_names = {alias for aliases in REGIONS.values() for alias in aliases if alias.endswith('시')}
    cities -= province_names
    if cities and not cities & set(profile['cities']):
        return False
    city_names = {city for city in GYEONGGI_CITIES if re.search(
        r'(?<![가-힣])' + city + r'(?:시|군)?(?=$|[^가-힣]|소재|지역|관내|내|에)', title+' '+target)}
    company_cities = {city.removesuffix('시') for city in profile['cities']}
    if city_names and not city_names & company_cities:
        return False
    local_hq = re.search(r'(성남|안양|인천)[^.;☞]{0,35}(본사|본점)', target)
    if local_hq and local_hq.group(1) != profile['headquarters_city'].removesuffix('시'):
        if not matches(target, ('또는', '사업장', '지점', '연구소')):
            return False
    return True


def assess(item, detail, today, profile=PROFILE):
    title, target, body = detail['title'], detail['target'], detail['overview']
    text = title + ' ' + body
    checks, reasons, topics = [], [], []
    status = period_status(detail['application_period'], today)
    if not status['active']:
        return None
    if not geography_allowed(item, title, target, profile):
        return None
    if matches(text, LOCATION):
        return None
    if matches(target, ('비영리법인', '사회복지법인')) and not matches(target, ('영리기업', '중소기업', '창업기업', '요양기관', '요양원', '사회복지시설')):
        return None
    if matches(target, ('예비창업자', '창업예정자')) and not matches(target, ('기창업', '창업기업', '스타트업', '중소기업')):
        return None
    # Narrow sectors do not become applicable just because they use technology or support startups.
    narrow = ('농업인', '농가', '어업인', '수산업', '식품제조', '식품ㆍ외식', '식품외식', '푸드테크', '반려동물', '반도체',
              '자동차부품', '섬유기업', '화장품기업', '소공인', '뿌리기업', '방산', '쇼피입점', '산업위기지역')
    if matches(target, narrow) and not matches(target, ('업종무관', '전업종')):
        return None
    if matches(target, ('제조업', '제조기업', '공장등록')) and not matches(target, ('서비스업', '소프트웨어', '정보통신', 'ICT', '업종무관')):
        return None
    if matches(title, ('관광객유치', '수산엑스포', '농산물', '반도체', '이차전지', '항공부품', '고분자', '자율주행', '청년식당', '유공', '포상', '지정기간연장', '위조방지기술')):
        return None
    if matches(detail['benefit'], ('전력망', '중수로', '에너지설비', '국방무기')) and not matches(title+' '+target, CARE+SOFTWARE):
        return None
    insurance_before = re.search(r'고용보험\s*성립[^☞]{0,30}?[\x27’`]?((?:20)?\d{2})[.\-/]\d{1,2}[.\-/]\d{1,2}[.\s]*(?:이전|이하)', target)
    if insurance_before and 2000+int(insurance_before.group(1))%100 < profile['established_year']:
        return None
    focus = title + ' ' + target
    if matches(focus, CARE):
        topics.append('시니어·사회복지·장기요양'); reasons.append('더비다 요양원 운영 경험과 시니어·사회복지·장기요양 현장에 연결되는 사업입니다.')
    if matches(focus, AX):
        topics.append('AI·AX 전환'); reasons.append('장기요양 업무의 AI 활용과 SaaS 플랫폼 고도화에 적용할 수 있는지 검토할 사업입니다.')
    if matches(focus, PHYSICAL_AI):
        topics.append('피지컬 AI·돌봄 로봇'); reasons.append('요양 현장의 피지컬 AI·돌봄 로봇 실증 또는 SaaS 연계 가능성을 검토할 사업입니다.')
        checks.append('돌봄 현장 적용 분야, 로봇·장비 개발 역량, 실증기관 또는 협력기업 참여 조건을 확인하세요.')
    if matches(focus, SOFTWARE):
        topics.append('SaaS·디지털 기술'); reasons.append('개발 중인 장기요양기관 SaaS 플랫폼과 기술 분야가 연결됩니다.')
    if matches(focus, STARTUP):
        topics.append('창업·사업화'); reasons.append('2024년 설립 기업의 사업화·성장 지원 후보입니다.')
    if matches(focus, RESEARCH):
        topics.append('연구개발'); reasons.append('안양 기업부설연구소와 SaaS 연구개발에 활용할 가능성이 있습니다.')
    if matches(text, ('여성기업', '여성창업', '여성기업인')):
        topics.append('여성기업'); reasons.append('여성 대표자가 운영하는 기업을 위한 지원 분야입니다.')
        if profile['certifications'].get('women_enterprise') is not True:
            checks.append('여성 대표자와 여성기업확인서는 별도 조건입니다. 확인서 필요 여부와 보유 상태를 확인하세요.')
    if matches(title + ' ' + target, GENERAL):
        topics.append('기업 운영·인력'); reasons.append('기업의 인력·지식재산·운영 비용을 지원하는 사업 후보입니다.')
    if not topics:
        return None
    if named_regions(title+' '+target+' '+item.get('department', '')) or re.search(r'(?:성남|안양|인천)', target):
        checks.append('본사(성남), 연구소(안양), 사업장(안양·인천) 중 공고가 인정하는 소재지 기준을 확인하세요.')
    if matches(target, ('본사', '본점')):
        checks.append('본사 소재지 요건은 성남시 분당구를 기준으로 확인해야 합니다.')
    years = re.search(r'(?:업력|창업)\s*(\d+)\s*년\s*(이내|미만|이상|초과)', target)
    if years:
        maximum_age, minimum_age = today.year-profile['established_year'], today.year-profile['established_year']-1
        limit, op = int(years.group(1)), years.group(2)
        if ((op == '미만' and minimum_age >= limit) or (op == '이내' and minimum_age > limit)
                or (op == '이상' and maximum_age < limit) or (op == '초과' and maximum_age <= limit)):
            return None
        checks.append(f"{profile['established_year']}년 설립. 정확한 설립일과 공고일 기준 업력 {limit}년 {op} 조건을 확인하세요.")
    if matches(text, ('청년', '만39세', '만34세')):
        checks.append('대표자 또는 채용 대상자의 연령 요건을 확인하세요.')
    if matches(text, ('벤처기업',)) and profile['certifications'].get('venture') is True:
        reasons.append('보유한 벤처기업 확인을 활용할 수 있는 분야입니다. 유효기간은 확인이 필요합니다.')
    if matches(target, ('창업기업확인', 'TIPS', '중소기업확인', '소상공인')):
        checks.append('필수 기업확인서·선정 이력과 중소기업/소상공인 규모 요건을 확인하세요.')
    if matches(title+' '+target+' '+body.split('☞')[0], AX + PHYSICAL_AI + ('AI', '인공지능', '딥테크', '수출', '해외', '투자유치')):
        checks.append('요구하는 기술 수준·실증 준비도·수출 또는 투자 실적이 현재 사업과 맞는지 확인하세요.')
    if matches(target, ('정보보호인증', '혁신제품', '국가전략기술', '선정기업', '지정기업', '사회적기업인증')):
        checks.append('특정 기술·제품 인증·기존 선정기업 대상입니다. 현재 SaaS의 기능과 보유 인증이 해당하는지 먼저 확인하세요.')
    if matches(title, ('오픈이노베이션', '밋업')):
        checks.append('수요기업이 제시한 세부 협업 과제와 자사 SaaS의 연관성을 첨부 공고문에서 확인하세요.')
    if matches(target, ('매출',)) and profile.get('annual_revenue_krw') is not None:
        checks.append('제공한 매출 규모를 바탕으로 후보를 검토했습니다. 기준연도·평균매출·수가 매출 인정 여부에 따라 판단이 달라집니다.')
    employee_min = re.search(r'(?:상시)?(?:근로자|종업원|직원)\s*(?:수)?\s*(\d+)\s*(?:명|인)\s*이상', target)
    if employee_min and profile.get('employee_count_max') is not None and int(employee_min.group(1)) > profile['employee_count_max']:
        return None
    checks.append('주업종·매출 산정 시 요양원 운영 매출과 SaaS 개발 사업의 인정 범위를 확인하세요.')
    checks.append('중소기업 자격, 제외 업종, 자부담과 중복수혜 제한은 원문 공고문에서 확인이 필요합니다.')
    return {'topics': topics, 'match_basis': '회사 조건·공고 요약', 'reasons': reasons,
            'checks': list(dict.fromkeys(checks)), 'recommendation': '검토 후보 · 조건 확인',
            'target': target[:600], 'benefit': detail['benefit'][:600],
            'application_period': detail['application_period'], 'application_status': status,
            'score': 20*len(topics) + (15 if any(topic in topics for topic in ('시니어·사회복지·장기요양','SaaS·디지털 기술','AI·AX 전환','피지컬 AI·돌봄 로봇')) else 0)}


def fingerprint(item):
    return hashlib.sha256(json.dumps([item['title'], item['published_at'], item['application_period']], ensure_ascii=False).encode()).hexdigest()


def collect(source, seen, now, fetcher, stop=None, review=False, archive=()):
    selected, scanned = {}, {}

    def consider(row):
        detail = parse_detail(fetcher(row['url']))
        row = {**row, 'title': detail['title']}
        match = assess(row, detail, now.date())
        if match:
            row.update(match, withdrawn=False, collected_at=now.isoformat(), first_seen_at=now.isoformat())
            selected[row['id']] = row
        elif row['id'] in seen or row.get('kind') == 'support' and row.get('collected_at'):
            row.update(withdrawn=True, application_period=detail['application_period'],
                       target=detail['target'], benefit=detail['benefit'], collected_at=now.isoformat())
            selected[row['id']] = row
        if stop and stop.wait(0.15):
            raise InterruptedError()

    for page in range(1, MAX_PAGES+1):
        if stop and stop.is_set():
            raise InterruptedError()
        rows, following = parse_list(fetcher(list_url(page)), source, page)
        reached_seen = all(row['id'] in seen for row in rows)
        for row in rows:
            if row['published_at'] > now.date().isoformat() or row['id'] in scanned:
                continue
            signature = fingerprint(row)
            scanned[row['id']] = signature
            if not review and seen.get(row['id']) == signature:
                continue
            consider(row)
        # Require a full known page, and overlap at least two pages for same-day ordering changes.
        if not following or (not seen and page >= BOOTSTRAP_PAGES) or (seen and page >= (BOOTSTRAP_PAGES if review else 2) and reached_seen):
            # Reassess older saved recommendations even when they are outside the latest pages.
            for old in archive if review else ():
                if stop and stop.is_set():
                    raise InterruptedError()
                if old['id'] not in scanned:
                    consider(old)
            return list(selected.values()), scanned
    raise ValueError('Bizinfo pagination limit reached before previous records; retry required')
