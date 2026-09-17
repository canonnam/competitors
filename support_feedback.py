"""Conservative, explainable recommendation rules from support rejection reasons.

Only explicit support types/conditions become preference rules. Unclear or temporary
reasons stay attached to the selected announcement, without rejecting its sector.
"""
import re


MAX_REASON_LENGTH = 500
FEATURES = {
    'space': ('입주·공간 지원', ('입주', '사무공간', '사무실', '공간지원', '공유오피스', '보육공간')),
    'training': ('교육·멘토링', ('교육', '강의', '수강', '아카데미', '멘토링', '컨설팅')),
    'event': ('행사·전시·경진대회', ('행사', '전시', '박람회', '경진대회', '세미나', '컨퍼런스', '밋업')),
    'investment': ('투자·IR', ('투자유치', '투자상담', '투자', 'IR', '피칭')),
    'export': ('수출·해외 진출', ('수출', '해외', '글로벌진출', '국제진출')),
    'patent': ('특허·지식재산', ('특허', '상표', '지식재산', '지재권')),
    'hiring': ('인력·채용', ('채용', '고용', '인건비', '연구인력', '인력지원', '인력채용')),
    'loan': ('융자·대출·보증', ('융자', '대출', '보증')),
    'manufacturing': ('제조·장비', ('제조', '공장', '장비구입', '설비')),
    'robot': ('로봇', ('로봇', '로보틱스', '로보트')),
    'adoption': ('AI·AX 솔루션 도입', ('솔루션도입', 'AI도입', 'AX도입', 'AI바우처', 'AI활용바우처')),
    'commercialization': ('상용화·사업화', ('상용화', '사업화', '판매', '마케팅', '판로')),
    'research': ('연구개발 과제', ('연구개발', 'R&D', '연구과제', '연구비', '기술개발', '공동연구', '산학연')),
    'senior': ('시니어 케어', ('시니어', '고령', '노인', '어르신', '요양', '치매', '에이지테크')),
    'ai': ('AI·AX', ('AI', 'AX', '인공지능', '머신러닝', '딥러닝', 'LLM')),
    'pilot': ('현장 실증', ('실증', '리빙랩', '테스트베드', '시범사업')),
    'contribution': ('자부담이 명시된 사업', ('자부담', '자기부담', '민간부담', '기업부담')),
    'agriculture': ('농업·농식품 분야', ('농업', '농식품', '농산물', '농촌', '스마트팜', '애그테크')),
    'forestry': ('산림 분야', ('산림', '임업', '임산물', '목재산업')),
    'pharma': ('제약·의약품 분야', ('제약', '의약품', '신약')),
    'tourism': ('관광 분야', ('관광', '여행업', '트래블테크')),
    'craft': ('공예 분야', ('공예', '공예품')),
    'distribution': ('유통 분야', ('유통', '이커머스', '전자상거래')),
    'consumer_goods': ('소비재 분야', ('소비재', '소비용품')),
    'radio': ('주파수·전파 분야', ('주파수', '전파')),
    'power': ('전력 산업', ('전력산업', '전력기술', '전력분야', '전력기업', '전력기자재', '발전산업')),
    'nuclear_energy': ('원전·에너지 산업', ('원전', '원자력', '에너지산업', '에너지분야', '에너지기업', '에너지공급망')),
    'india': ('인도 대상 사업', ('인도', 'India')),
    'vietnam': ('베트남 대상 사업', ('베트남', 'Vietnam', 'Viet Nam')),
    'middle_east': ('중동 대상 사업', ('중동', 'Middle East', '사우디', '아랍에미리트', 'UAE', '두바이', '카타르', '쿠웨이트', '바레인', '오만')),
    'kca': ('한국방송통신전파진흥원 사업', ('한국방송통신전파진흥원', '방송통신전파진흥원', '전파진흥원', 'KCA')),
    'small_business': ('소상공인 전용 사업', ('소상공인',)),
    'technology_transfer': ('기술이전 계약 필요 사업', ('공공기술', '기술이전')),
}
SECTORS = {'agriculture', 'forestry', 'pharma', 'tourism', 'craft', 'distribution', 'consumer_goods', 'radio', 'power', 'nuclear_energy'}
COUNTRIES = {'india', 'vietnam', 'middle_east'}
CONDITIONS = {'small_business', 'technology_transfer'}
NEGATIVE = re.compile(r'관심(?:이)?없|필요(?:가)?없|필요하지않|원하지않|원치않|불필요|맞지않|안맞|부적합|부담|싫|제외|원하지|아니라|아닌|아님|아닙|말고|없음|없습|미보유')
POSITIVE = re.compile(r'관심(?:이)?있|원합|원해|원하|원함|희망|필요합|필요해|필요하|필요함|찾고|좋겠|선호')
TEMPORARY = re.compile(r'이번|지금|현재|당장|일정|시기|마감|기간|바빠|바쁘|준비부족|준비가안|시간부족|시간이없')


def compact(value):
    return re.sub(r'\s+', '', value).casefold()


def contains(value, words):
    # Do not mistake e.g. "fair" for IR or "trail" for AI.
    for word in words:
        word = compact(word)
        if re.fullmatch(r'[a-z]+', word):
            if re.search(r'(?<![a-z])' + re.escape(word) + r'(?![a-z])', value):
                return True
        elif word in value:
            return True
    return False


def feature_matches(item, key):
    # Generated checks/recommendation explanations are not evidence of eligibility.
    fields = ('title', 'target', 'benefit')
    if key in SECTORS or key in COUNTRIES:
        fields = ('title', 'target')
    elif key == 'kca':
        fields = ('title', 'department', 'operator')
    raw = ' '.join(str(item.get(field, '')) for field in fields)
    value = compact(raw)
    if key in COUNTRIES:
        return country_matches(raw, key)
    if key == 'small_business':
        target = compact(item.get('target', ''))
        # A mixed SME/small-business call or a supplier serving small businesses
        # must not be mistaken for a small-business-only eligibility requirement.
        if not target or not contains(target, FEATURES[key][1]):
            return False
        if re.search(r'소상공인(?:은|을|이)?(?:제외|아닌|아니어도)|소상공인.*(?:공급기업|공급사|솔루션개발기업)', target):
            return False
        alternatives = r'(?:중소[·ㆍ]?기업|중견기업|벤처기업|창업기업|스타트업|일반기업|개인사업자|비영리법인)'
        joiner = r'(?:[·ㆍ/,]|및|또는|과|와|혹은|이나)+'
        if re.search(alternatives + joiner + r'소상공인|소상공인' + joiner + alternatives, target):
            return False
        without_certificates = re.sub(r'중소기업확인서|중소기업기본법', '', target)
        if re.search(alternatives, without_certificates) and not re.search(r'소상공인(?:만|전용|인|으로|에해당|중)|(?:해당하는|인)소상공인', target):
            return False
        return True
    if key == 'technology_transfer':
        target = compact(item.get('target', ''))
        if not contains(target, FEATURES[key][1]):
            return False
        # Planned contracts are an alternative, not a contract already required.
        if re.search(r'예정|계획|희망|계약(?:이|은)?(?:없어도|불필요)|계약여부무관', target):
            return False
        return bool(re.search(r'계약.{0,16}(?:체결|완료)|(?:이전|도입)받은|이전기업', target))
    if key == 'contribution':
        value = re.sub(r'(?:자부담|자기부담|민간부담|기업부담)(?:금|비율)?(?:은|이|는)?(?:없(?:음|습니다|어요|다)?|면제|0(?:원|%))', '', value)
    if key == 'senior' and re.search(r'(?:시니어|고경력)(?:과학기술인|연구자|인력)', compact(item.get('title', ''))):
        return False
    if key == 'radio':
        value = re.sub(r'한국방송통신전파진흥원|방송통신전파진흥원|전파진흥원|한국전파진흥협회|성과전파|사례전파', '', value)
    if key == 'pharma':
        value = re.sub(r'(?:시간|공간|지역|업종|분야|자격)?제약(?:이|은|을)?(?:없|없이|받지않|없이)', '', value)
    return contains(value, FEATURES[key][1])


def country_matches(value, key):
    """Keep country names separate from e.g. Indonesia and Bucheon Jung-dong."""
    if key == 'india':
        return bool(re.search(r'(?<![가-힣a-z])인도(?!네시아|양|적)|\bindia\b', value, re.I))
    if key == 'middle_east':
        value = re.sub(r'(?:부천(?:시)?|성남(?:시)?|해운대(?:구)?|주소)\s*중동|중동(?:로|역|점|센터|\s*\d)', '', value)
    return contains(compact(value), FEATURES[key][1])


def exclusion_rules(item, rules):
    """Only core purpose, explicit geography or target conditions cause hiding.

    Incidental mentoring/export/space mentioned in benefits can lower rank, but
    cannot hide an otherwise useful research project.
    """
    return [rule for rule in rules if rule['mode'] == 'require'
            or rule['feature'] in SECTORS | COUNTRIES | CONDITIONS | {'kca', 'contribution'}
            or feature_matches({'title': item.get('title', '')}, rule['feature'])]


def validate_reason(reason):
    if not isinstance(reason, str):
        raise ValueError('관심없는 이유를 글자로 입력해주세요.')
    reason = reason.strip()
    if len(reason) > MAX_REASON_LENGTH:
        raise ValueError(f'관심없는 이유는 {MAX_REASON_LENGTH}자 이내로 입력해주세요.')
    if any(ord(char) < 32 and char not in '\n\r\t' for char in reason):
        raise ValueError('관심없는 이유에 사용할 수 없는 문자가 있습니다.')
    return reason


def analyze_reason(reason):
    """Return only a bounded vocabulary of user-visible preference rules, never code."""
    reason = validate_reason(reason)
    result = {'reason': reason, 'rules': [], 'summary': ''}
    if not reason:
        result['summary'] = '이유를 추가하면 다음 추천에 더 구체적으로 반영합니다.'
        return result
    value = compact(reason)
    # An explicit one-off exclusion must not become a lasting preference.
    if re.search(r'(?:이|해당)(?:사업|공고)만(?:제외|숨|관심없)|이번만', value):
        result['summary'] = '이번 사업만 제외하며 다른 사업의 추천 순위는 바꾸지 않습니다.'
        return result
    rules = set()
    # Keep opposed subjects apart: "교육은 필요 없고, 연구과제에는 관심 있어요".
    separated = re.sub(r'(없|있|않)(?:고|으며)', r'\1.', reason)
    clauses = re.split(r'[.!?。\n;,]+|지만|반면|그런데|대신|보다', separated)
    for clause in clauses:
        value_clause = compact(clause)
        if not value_clause or TEMPORARY.search(value_clause) and not re.search(r'앞으로|계속|항상', value_clause):
            continue
        if re.search(r'없(?:는것|지)?(?:은|이)?(?:아니|아닙|않)|부담(?:이)?(?:되지않|없)', value_clause):
            continue
        required = required_subjects(value_clause)
        rules.update(('require', key) for key in required)
        # A positive desired subject must not become a negative keyword.
        if POSITIVE.search(value_clause) and not NEGATIVE.search(value_clause):
            continue
        # Bare subjects ("IR", "농업 분야") are useful rejection reasons; an
        # uncertain sentence merely mentioning a feature is not an exclusion.
        remainder = value_clause
        for _, words in FEATURES.values():
            for word in sorted(words, key=len, reverse=True):
                remainder = remainder.replace(compact(word), '')
        remainder = re.sub(r'관련|분야|산업|사업|과제|지원|유형|조건|대상|및|[은는이가와과·ㆍ/]', '', remainder)
        if not NEGATIVE.search(value_clause) and remainder:
            continue
        for key, (_, words) in FEATURES.items():
            if key in required or not contains(value_clause, words):
                continue
            if key in COUNTRIES and not country_matches(clause, key):
                continue
            if key == 'radio' and contains(value_clause, FEATURES['kca'][1]) and not re.search(r'주파수|전파(?:관련|분야|산업)', value_clause):
                continue
            # Cost complaints generalize only to an explicit contribution requirement.
            if key == 'contribution' and not NEGATIVE.search(value_clause):
                continue
            rules.add(('avoid', key))
    result['rules'] = [{'mode': mode, 'feature': key, 'label': FEATURES[key][0]}
                       for mode, key in sorted(rules)]
    labels = [('{} 중심·전용 사업은 추천·새 공고 알림에서 제외'.format(rule['label']) if rule['mode'] == 'avoid'
               else '{} 관련성이 확인되지 않은 사업은 추천·새 공고 알림에서 제외'.format(rule['label'])) for rule in result['rules']]
    result['summary'] = ' · '.join(labels) if labels else '이번 사업만 제외합니다. 다른 추천에 반영할 구체적인 지원유형·조건은 확인되지 않았습니다.'
    if not labels and TEMPORARY.search(value):
        result['summary'] = '이번 사업만 제외하며 다른 사업의 추천 순위는 바꾸지 않습니다.'
    return result


def required_subjects(value):
    required = set()
    for key in ('research', 'senior', 'ai', 'pilot'):
        for word in FEATURES[key][1]:
            token = re.escape(compact(word))
            if re.fullmatch(r'[a-z]+', compact(word)):
                token = r'(?<![a-z])' + token + r'(?![a-z])'
            if key == 'senior':
                token += r'(?:케어|돌봄)?'
            only = token + r'(?:와|과|에|이|가)?(?:관련|관계)?(?:된|있는)?(?:사업|분야|과제)?(?:만|위주|중심)'
            unrelated = token + r'(?:와|과|에|이|가)?(?:관련|관계)(?:이|가)?(?:없|없는|무관)'
            missing = token + r'(?:사업|지원|과제)?(?:이|가)?(?:아니|아닙|없)'
            # "AI 과제만 관심없음" means avoid AI, not require AI.
            if ((re.search(only, value) and not NEGATIVE.search(value))
                    or re.search(unrelated, value) or re.search(missing, value)):
                required.add(key)
    return required


def matched_rules(item, feedback):
    return [rule for rule in feedback['rules'] if feature_matches(item, rule['feature']) == (rule['mode'] == 'avoid')]
