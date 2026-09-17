import unittest

from support_feedback import analyze_reason, feature_matches, matched_rules


class ReasonAnalysisTests(unittest.TestCase):
    def rules(self, reason):
        return {(r['mode'], r['feature']) for r in analyze_reason(reason)['rules']}

    def test_specific_dislikes_and_desired_research_are_not_confused(self):
        for reason in ['입주 공간은 필요 없고, 시니어 AI 연구과제에 관심이 있습니다.',
                       '입주·공간 지원은 필요 없습니다.']:
            self.assertEqual(self.rules(reason), {('avoid', 'space')})
        self.assertEqual(self.rules('교육·행사보다 연구개발 과제를 원합니다.'),
                         {('avoid', 'training'), ('avoid', 'event')})
        self.assertEqual(self.rules('교육은 관심없고 연구과제는 관심있어요'), {('avoid', 'training')})
        self.assertEqual(self.rules('해외 특허는 필요 없습니다.'), {('avoid', 'export'), ('avoid', 'patent')})
        self.assertEqual(self.rules('IR'), {('avoid', 'investment')})
        self.assertEqual(self.rules('AI 과제만 관심없습니다.'), {('avoid', 'ai')})

    def test_required_subjects_lower_only_candidates_without_the_subject(self):
        self.assertEqual(self.rules('시니어 케어와 관련된 사업만 원합니다.'), {('require', 'senior')})
        self.assertEqual(self.rules('노인과 관련 없는 사업입니다.'), {('require', 'senior')})
        self.assertEqual(self.rules('연구과제가 아니라 교육 지원입니다.'), {('require', 'research'), ('avoid', 'training')})
        self.assertEqual(self.rules('AI 과제만 관심 있습니다.'), {('require', 'ai')})
        feedback = analyze_reason('연구과제만 원합니다.')
        self.assertTrue(matched_rules({'title': '창업 IR 클리닉'}, feedback))
        self.assertFalse(matched_rules({'title': 'AI 기술개발 공동연구'}, feedback))

    def test_temporary_unclear_and_positive_reasons_do_not_create_negative_rules(self):
        for reason in ['이번에는 일정이 맞지 않습니다.', '이 사업만 제외해주세요.',
                       '지금은 교육을 받을 시간이 없습니다.', '나중에 검토하겠습니다.',
                       '시니어 연구과제에 관심 있습니다.', 'AI 연구개발이 필요합니다.',
                       '교육에 관심이 없는 것은 아닙니다.', '자부담이 부담되지 않습니다.', 'MAX만 원합니다.',
                       '이번에는 연구과제만 관심 있습니다.']:
            self.assertFalse(self.rules(reason), reason)
        self.assertIn(('avoid', 'export'), self.rules('이번 일정은 안 맞습니다. 앞으로 해외 지원은 필요 없습니다.'))

    def test_cost_penalty_requires_evidence_in_announcement_not_generic_checks(self):
        feedback = analyze_reason('자부담이 부담됩니다.')
        self.assertEqual(self.rules(feedback['reason']), {('avoid', 'contribution')})
        self.assertFalse(matched_rules({'title': 'AI 연구개발', 'checks': ['자부담 확인']}, feedback))
        self.assertFalse(matched_rules({'title': 'AI 연구개발', 'benefit': '자부담 없음'}, feedback))
        self.assertFalse(matched_rules({'title': 'AI 연구개발', 'benefit': '자부담 0%'}, feedback))
        self.assertTrue(matched_rules({'title': 'AI 연구개발', 'benefit': '자부담 20% 이상'}, feedback))
        self.assertTrue(matched_rules({'title': 'AI 연구개발', 'benefit': '인건비 자부담 없음, 장비비 기업부담 20%'}, feedback))

    def test_english_word_boundaries_and_elderly_care_meaning(self):
        for key in ('ai', 'investment'):
            self.assertFalse(feature_matches({'title': 'Trail Max Fair 지원'}, key))
        self.assertFalse(feature_matches({'title': '시니어 과학기술인 채용 지원'}, 'senior'))
        self.assertTrue(feature_matches({'title': '노인 돌봄 AI 실증 지원'}, 'senior'))

    def test_saved_sector_country_institution_and_eligibility_reasons(self):
        cases = {
            '주파수, 전파 관련 사업 관심 없음': {'radio'},
            '중동 사업 관심 없음': {'middle_east'},
            '인도는 관심 없음': {'india'},
            '전파진흥원 관심 없음': {'kca'},
            '공예, 유통은 관심 없음.': {'craft', 'distribution'},
            '농업 분야는 관심 없습니다.': {'agriculture'},
            '공공기술 이전 계약이 없음': {'technology_transfer'},
            '전력 산업은 관심 없음': {'power'},
            '소상공인 아님': {'small_business'},
            '소비재 관심없음': {'consumer_goods'},
            '원전 에너지 분야 관심 없음': {'nuclear_energy'},
            '베트남은 관심 없음': {'vietnam'},
            '제약 관심 없음': {'pharma'},
            '산림분야는 관심 없음': {'forestry'},
            '지역관광 분야는 관심 없음': {'tourism'},
        }
        for reason, expected in cases.items():
            with self.subTest(reason=reason):
                self.assertEqual(self.rules(reason), {('avoid', key) for key in expected})

    def test_geography_and_sector_matches_do_not_expand_to_unrelated_words(self):
        self.assertTrue(feature_matches({'title': '인도 시장 진출'}, 'india'))
        for title in ['인도네시아 시장 진출', '인도양 협력', '중소 법인도 참여 가능']:
            self.assertFalse(feature_matches({'title': title}, 'india'), title)
        self.assertTrue(feature_matches({'title': '중동 수출 지원'}, 'middle_east'))
        self.assertFalse(feature_matches({'title': '부천 중동 입주기업 모집'}, 'middle_east'))
        self.assertFalse(feature_matches({'title': '부천시 중동역 창업센터'}, 'middle_east'))
        self.assertFalse(feature_matches({'title': 'AI 공동연구', 'benefit': '농업과 제약 등 활용 예시 소개'}, 'agriculture'))
        self.assertFalse(feature_matches({'title': '분야 제약 없이 AI 연구개발 지원'}, 'pharma'))
        self.assertFalse(feature_matches({'title': '돌봄 연구성과 전파 사업'}, 'radio'))
        self.assertTrue(feature_matches({'title': '중소기업 기술 지원', 'operator': '한국방송통신전파진흥원'}, 'kca'))
        self.assertFalse(feature_matches({'title': 'KCA 사례를 소개하는 행사', 'operator': '다른 기관'}, 'radio'))

    def test_eligibility_exclusions_require_actual_target_conditions(self):
        for target in ['인천 소재 소상공인', '소상공인기본법에 따른 소상공인']:
            self.assertTrue(feature_matches({'target': target}, 'small_business'))
        for target in ['중소기업 및 소상공인', '소상공인 또는 중소기업', '소상공인 대상 솔루션 공급기업', '소상공인 제외',
                       '국내 중소기업, 개인사업자 및 소상공인']:
            self.assertFalse(feature_matches({'target': target}, 'small_business'), target)
        self.assertFalse(feature_matches({'title': '기업 지원', 'checks': ['소상공인 자격 확인']}, 'small_business'))
        self.assertTrue(feature_matches({'target': '공공기술 이전 계약을 체결한 기업'}, 'technology_transfer'))
        for target in ['공공기술 이전 계약완료 또는 완료 예정인 기업', '기술이전을 희망하는 기업', '국내 기업']:
            self.assertFalse(feature_matches({'target': target}, 'technology_transfer'), target)
        self.assertFalse(feature_matches({'title': '공공기관 미활용 특허 나눔', 'target': '국내 기업'}, 'technology_transfer'))

    def test_ambiguous_positive_and_temporary_sector_reasons_remain_local(self):
        for reason in ['농업도 관심 있습니다.', '농업 분야에 관심이 없는 것은 아닙니다.',
                       '농업은 잘 모르겠습니다.', '이번에는 베트남 일정이 맞지 않습니다.',
                       '현재 공공기술 이전 계약이 없습니다.']:
            self.assertFalse(self.rules(reason), reason)
        self.assertEqual(self.rules('농업은 관심 없지만 시니어 연구개발에는 관심 있습니다.'), {('avoid', 'agriculture')})


if __name__ == '__main__':
    unittest.main()
