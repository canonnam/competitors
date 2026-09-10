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


if __name__ == '__main__':
    unittest.main()
