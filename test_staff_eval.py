"""종사자 평가 링크, 본인 확인, 루브릭 채점, 담당자 확정."""
from contextlib import closing
import http.client
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest.mock import patch

import app
import card_knowledge
import staff_eval
import support_applications as support


GOOD = [
    '즉시 부축해 의자에 앉히고 의식과 통증, 부상이 있는지 확인합니다. 간호사와 시설장에게 보고하고 사고 경위를 기록합니다.',
    '마스크를 쓰고 손위생을 한 뒤 같은 방을 분리해 격리하고 간호사에게 보고한 다음 체온과 기침 증상을 관찰합니다.',
    '체위를 바꿔 압력을 줄이고 붉어진 피부를 확인한 뒤 간호사에게 보고하고 관찰 내용을 기록합니다.',
    '억지로 하는 것을 중단하고 말리며, 거부 의사를 존중한다고 설명합니다. 시설장에게 보고하고 나중에 다른 방법으로 다시 제안합니다.',
    '의식을 확인하고 호흡이 고르지 않아 즉시 119에 연락한 뒤 시설장에게 보고하고 발생 시각과 조치를 기록합니다.',
    '개인정보를 알려드리지 않고 거절합니다. 보호자에게 신원을 확인한 뒤 시설장에게 보고하고 상담 내용을 기록합니다.',
]


def walk_keys(value):
    found = set()
    if isinstance(value, dict):
        found.update(value)
        for item in value.values():
            found |= walk_keys(item)
    elif isinstance(value, list):
        for item in value:
            found |= walk_keys(item)
    return found


class StaffEvalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {
            'STAFF_EVAL_DB_PATH': str(root / 'staff-eval.db'),
            'SUPPORT_DB_PATH': str(root / 'support.db'),
            'SUPPORT_ACCESS_KEY': 'local-test-key',
            'GEMINI_API_KEY': '',
            'STAFF_EVAL_GEMINI_MODEL': '',
            'SEARCH_GEMINI_MODEL': '',
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        support.init_db()
        staff_eval.init_db()
        self.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.App)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.admin = ''
        self.staff = ''

    def request(self, path, body=None, cookie='', method=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        headers = {'Content-Type': 'application/json'}
        if cookie:
            headers['Cookie'] = cookie
        connection.request(method or ('POST' if body is not None else 'GET'), path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read()
        status, header = response.status, response.getheader('Set-Cookie')
        connection.close()
        return status, raw, header

    def login(self):
        status, _, cookie = self.request('/api/support/login', {'key': 'local-test-key'})
        self.assertEqual(status, 200)
        self.admin = cookie.split(';', 1)[0]

    def create(self, **extra):
        body = {'name': '김보호', 'branch': 'incheon', 'birthdate': '1990-01-01', 'employee_hint': '4321', 'expiry_hours': 72}
        body.update(extra)
        status, raw, _ = self.request('/api/support/staff-eval/create', body, self.admin)
        self.assertEqual(status, 200, raw)
        created = json.loads(raw)
        self.token = created['url'].split('#', 1)[1]
        return created

    def staff_call(self, action, body=None):
        path = '/api/staff-eval/' + self.token + (('' if not action else '/' + action))
        status, raw, cookie = self.request(path, body, self.staff)
        if cookie and 'staff_eval=' in cookie:
            self.staff = cookie.split(';', 1)[0]
        return status, json.loads(raw)

    def test_rubric_rewards_order_and_flags_gaps(self):
        perfect = staff_eval.score_answers({scenario['id']: answer for scenario, answer in zip(staff_eval.SCENARIOS, GOOD)})
        self.assertEqual(perfect['auto_score'], 100)
        self.assertFalse(perfect['needs_human'])
        self.assertEqual([item['code'] for item in perfect['items']], ['A2', 'B2', 'B3', 'D2', 'C2', 'D3'])
        reversed_fall = '기록부터 하고 보고한 다음 부축하고 의식을 확인합니다.'
        item = staff_eval.score_item(reversed_fall, staff_eval.SCENARIOS[0])
        self.assertFalse(item['order_ok'])
        self.assertLess(item['score'], 100)
        weak = staff_eval.score_answers({scenario['id']: '네' for scenario in staff_eval.SCENARIOS})
        self.assertTrue(weak['needs_human'])
        self.assertLess(weak['auto_score'], 50)
        reply, advance = staff_eval.local_reply(staff_eval.SCENARIOS[0], '일단 봤습니다', 1)
        self.assertFalse(advance)
        self.assertIn('어떻게', reply)
        self.assertTrue(staff_eval.local_reply(staff_eval.SCENARIOS[0], '일단 봤습니다', 2)[1])

    def test_link_flow_hides_score_until_admin_confirms(self):
        self.assertEqual(self.request('/api/support/staff-eval')[0], 401)
        self.assertEqual(self.request('/staff_eval.py')[0], 404)
        self.assertEqual(self.request('/staff-eval.html')[0], 200)
        self.assertEqual(self.request('/staff-eval-session.html')[0], 200)
        self.login()
        created = self.create()
        self.assertTrue(created['url'].startswith('/staff-eval-session.html#'))
        status, public = self.staff_call('', None)
        self.assertEqual(status, 200)
        self.assertEqual(public['name'], '김보호')
        self.assertFalse(public['messages'])
        self.assertFalse({'auto_score', 'confirmed_score', 'gemini_score', 'birthdate', 'employee_hint', 'items'} & walk_keys(public))
        self.assertNotIn(b'19900101', json.dumps(public).encode())
        self.assertEqual(self.staff_call('verify', {'birthdate': '1990-01-01'})[0], 403)
        self.assertEqual(self.staff_call('consent', {'accepted': True})[0], 200)
        self.assertEqual(self.staff_call('verify', {'birthdate': '2000-01-01'})[0], 403)
        status, started = self.staff_call('verify', {'employee_hint': '9984321'})
        self.assertEqual(status, 200, started)
        self.assertTrue(started['messages'])
        self.assertIn('낙상', started['messages'][0]['text'])
        self.assertNotIn('A2', started['messages'][0]['text'])
        self.assertTrue(self.staff)
        for answer in GOOD:
            status, state = self.staff_call('message', {'text': answer})
            self.assertEqual(status, 200, state)
        self.assertEqual(state['status'], 'completed')
        self.assertIn('제출 완료', state['done_message'])
        self.assertNotIn('auto_score', walk_keys(state))
        self.assertEqual(self.staff_call('message', {'text': '한 번 더'})[0], 403)
        detail_status, detail_raw, _ = self.request('/api/support/staff-eval/detail?id=' + created['id'], cookie=self.admin)
        self.assertEqual(detail_status, 200)
        detail = json.loads(detail_raw)
        self.assertEqual(detail['auto_score'], 100)
        self.assertFalse(detail['needs_human'])
        self.assertGreaterEqual(len(detail['transcript']), 7)
        self.assertIn('김보호', json.dumps(detail, ensure_ascii=False))
        confirmed_status, confirmed_raw, _ = self.request('/api/support/staff-eval/confirm', {'id': created['id'], 'score': 90}, self.admin)
        self.assertEqual(confirmed_status, 200)
        self.assertEqual(json.loads(confirmed_raw)['confirmed_score'], 90)
        listed_status, listed_raw, _ = self.request('/api/support/staff-eval?branch=anyang', cookie=self.admin)
        self.assertEqual(json.loads(listed_raw)['evaluations'], [])
        listed_status, listed_raw, _ = self.request('/api/support/staff-eval?branch=incheon', cookie=self.admin)
        self.assertEqual(json.loads(listed_raw)['evaluations'][0]['status_label'], '완료')
        retake_status, retake_raw, _ = self.request('/api/support/staff-eval/retake', {'id': created['id']}, self.admin)
        self.assertEqual(retake_status, 200)
        retaken = json.loads(retake_raw)
        self.assertEqual(retaken['status'], 'pending')
        self.assertEqual(retaken['transcript'], [])
        self.assertIsNone(retaken['auto_score'])

    def test_expired_link_and_name_check(self):
        self.login()
        created = self.create(branch='anyang', birthdate='', employee_hint='')
        with closing(sqlite3.connect(staff_eval.db_path())) as db, db:
            db.execute('UPDATE staff_evaluations SET expires=? WHERE id=?', (time.time() - 10, created['id']))
        status, payload = self.staff_call('consent', {'accepted': True})
        self.assertEqual(status, 403)
        self.assertIn('만료', payload['error'])
        created = self.create(name='이돌봄', branch='', birthdate='', employee_hint='', expiry_hours=2)
        self.staff_call('consent', {'accepted': True})
        self.assertEqual(self.staff_call('verify', {'name': '다른사람'})[0], 403)
        status, started = self.staff_call('verify', {'name': '이돌봄'})
        self.assertEqual(status, 200)
        self.assertEqual(started['branch_label'], '지점 미지정')

    def test_gemini_stays_on_server_and_can_flag_review(self):
        os.environ['GEMINI_API_KEY'] = 'test-gemini-key'

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                system = self.system
                if '채점 보조' in system:
                    text = '{"score":40,"note":"차이 있음"}'
                else:
                    text = '{"reply":"확인했습니다.","advance":true}'
                return json.dumps({'candidates': [{'content': {'parts': [{'text': text}]}}]}).encode()

        def urlopen(request, timeout=25):
            self.assertNotIn('test-gemini-key', request.full_url)
            self.assertEqual(request.get_header('X-goog-api-key'), 'test-gemini-key')
            response = Response()
            response.system = json.loads(request.data.decode())['systemInstruction']['parts'][0]['text']
            return response

        with patch('staff_eval.urllib.request.urlopen', side_effect=urlopen):
            reply, advance = staff_eval.facilitate(staff_eval.SCENARIOS[0], GOOD[0], 1)
            score, note = staff_eval.gemini_score({item['id']: GOOD[index] for index, item in enumerate(staff_eval.SCENARIOS)}, staff_eval.score_answers({item['id']: GOOD[index] for index, item in enumerate(staff_eval.SCENARIOS)}))
        self.assertTrue(advance)
        self.assertNotIn('test-gemini-key', reply)
        self.assertEqual(score, 40)
        self.assertEqual(note, '차이 있음')
        rubric = staff_eval.score_answers({item['id']: GOOD[index] for index, item in enumerate(staff_eval.SCENARIOS)})
        self.assertGreaterEqual(abs(score - rubric['auto_score']), 15)

    def test_live_token_is_ephemeral_and_text_remains(self):
        self.login()
        self.create()
        self.staff_call('consent', {'accepted': True})
        status, started = self.staff_call('verify', {'employee_hint': '4321'})
        self.assertEqual(status, 200, started)
        self.assertTrue(started['voice']['preferred'])
        self.assertFalse(started['voice']['available'])
        status, missing = self.staff_call('live-token', {})
        self.assertEqual(status, 503, missing)
        self.assertIn('글로', missing['error'])
        self.assertNotIn('token', missing)
        self.assertEqual(self.request('/api/staff-eval/' + self.token + '/live-token', {})[0], 401)

        os.environ['GEMINI_API_KEY'] = 'test-gemini-key'
        os.environ['STAFF_EVAL_LIVE_MODEL'] = 'not a model'
        self.assertEqual(staff_eval.live_model_id(), 'gemini-3.8-live')
        os.environ['STAFF_EVAL_LIVE_MODEL'] = ''
        status, ready = self.staff_call('')
        self.assertTrue(ready['voice']['available'])
        self.assertNotIn('test-gemini-key', json.dumps(ready))

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                return json.dumps({'name': 'auth_tokens/ephemeral-demo'}).encode()

        def urlopen(request, timeout=15):
            self.assertNotIn('test-gemini-key', request.full_url)
            self.assertEqual(request.get_header('X-goog-api-key'), 'test-gemini-key')
            self.assertTrue(request.full_url.endswith('/v1beta/auth_tokens'))
            body = json.loads(request.data.decode())
            self.assertEqual(body['uses'], 1)
            # REST AuthToken schema, not the SDK's LiveConnectConstraints.
            self.assertNotIn('liveConnectConstraints', body)
            config = body['bidiGenerateContentSetup']
            self.assertEqual(config['model'], 'models/gemini-3.8-live')
            self.assertEqual(config['generationConfig']['responseModalities'], ['AUDIO'])
            self.assertEqual(config['generationConfig']['speechConfig']['languageCode'], 'ko-KR')
            self.assertEqual(config['inputAudioTranscription'], {'languageCodes': ['ko-KR']})
            self.assertTrue(config['realtimeInputConfig']['automaticActivityDetection']['disabled'])
            self.assertNotIn('responseModalities', config)
            self.assertNotIn('speechConfig', config)
            instruction = config['systemInstruction']['parts'][0]['text']
            self.assertIn('요양보호사', instruction)
            self.assertIn('[읽기]', instruction)
            self.assertNotIn('test-gemini-key', request.data.decode())
            return Response()

        with patch('staff_eval.urllib.request.urlopen', side_effect=urlopen):
            status, payload = self.staff_call('live-token', {})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload['token'], 'auth_tokens/ephemeral-demo')
        self.assertEqual(payload['model'], 'models/gemini-3.8-live')
        self.assertEqual(payload['setup'], staff_eval.live_setup())
        self.assertIn('BidiGenerateContentConstrained', payload['websocket_url'])
        self.assertNotIn('key=', payload['websocket_url'])
        self.assertNotIn('test-gemini-key', json.dumps(payload))
        self.assertIn('낙상', payload['speak'])
        self.assertNotIn('auto_score', walk_keys(payload))
        status, state = self.staff_call('message', {'text': GOOD[0]})
        self.assertEqual(status, 200, state)
        self.assertNotIn('auto_score', walk_keys(state))
        page = Path('assets/staff-eval-session.js').read_text(encoding='utf-8')
        self.assertIn('상황 듣기', page)
        self.assertIn('글로 답하기', page)
        self.assertIn('access_token', page)
        self.assertNotIn('GEMINI_API_KEY', page)
        admin = Path('staff-eval.html').read_text(encoding='utf-8')
        self.assertNotIn('지금은 글로 답합니다', admin)
        self.assertIn('말로 답', admin)

    def test_live_token_provider_failure_is_safe_and_retryable(self):
        self.login()
        self.create()
        self.staff_call('consent', {'accepted': True})
        self.staff_call('verify', {'employee_hint': '4321'})
        os.environ['GEMINI_API_KEY'] = 'test-secret-not-for-output'
        error = urllib.error.HTTPError('https://generativelanguage.googleapis.com/v1beta/auth_tokens', 400, 'Bad Request', {}, io.BytesIO(b'test-secret-not-for-output'))
        with patch('staff_eval.urllib.request.urlopen', side_effect=error), self.assertLogs('staff_eval', level='WARNING') as logs:
            status, payload = self.staff_call('live-token', {})
        self.assertEqual(status, 503)
        self.assertIn('다시 시도', payload['error'])
        self.assertNotIn('test-secret-not-for-output', json.dumps(payload) + ''.join(logs.output))
        self.assertIn('status=400', ''.join(logs.output))
        with patch('staff_eval.mint_live_token', return_value='auth_tokens/retry'):
            status, ready = self.staff_call('live-token', {})
        self.assertEqual(status, 200)
        self.assertEqual(ready['token'], 'auth_tokens/retry')

    def test_skip_authentication_stale_request_and_completion(self):
        self.login()
        created = self.create()
        self.assertEqual(self.staff_call('skip', {'scenario_id': 'fall'})[0], 401)
        self.staff_call('consent', {'accepted': True})
        _, state = self.staff_call('verify', {'employee_hint': '4321'})
        self.assertEqual(state['scenario_id'], 'fall')
        self.assertEqual(self.staff_call('skip', {})[0], 400)
        self.assertEqual(self.staff_call('message', {'text': '우선 부축합니다.'})[0], 200)
        for scenario in staff_eval.SCENARIOS:
            status, state = self.staff_call('skip', {'scenario_id': scenario['id']})
            self.assertEqual(status, 200, state)
            # A repeated request cannot accidentally skip the next scenario.
            self.assertIn(self.staff_call('skip', {'scenario_id': scenario['id']})[0], (400, 403))
        self.assertEqual(state['status'], 'completed')
        self.assertNotIn('auto_score', walk_keys(state))
        detail = staff_eval.detail(created['id'])
        self.assertTrue(detail['needs_human'])
        self.assertTrue(all(item['skipped'] for item in detail['items']))
        self.assertGreater(detail['items'][0]['score'], 0)  # Earlier submitted answer retained.
        self.assertEqual([item['score'] for item in detail['items'][1:]], [0] * 5)
        self.assertEqual(len([m for m in detail['transcript'] if m.get('kind') == 'skipped']), 6)
        staff_eval.retake({'id': created['id']})
        self.assertEqual(staff_eval.detail(created['id'])['items'], [])
        self.staff = ''
        self.staff_call('consent', {'accepted': True})
        self.staff_call('verify', {'employee_hint': '4321'})
        staff_eval.save_fields(created['id'], expires=time.time() - 10)
        self.assertEqual(self.staff_call('skip', {'scenario_id': 'fall'})[0], 403)

    def test_card_registration_and_image_copy(self):
        home = Path('index.html').read_text(encoding='utf-8')
        self.assertIn('href="/staff-eval.html"', home)
        self.assertIn('테스트 · 요양보호사', home)
        self.assertIn('종사자 평가', Path('assets/navigation.js').read_text(encoding='utf-8'))
        dockerfile = Path('Dockerfile').read_text(encoding='utf-8')
        self.assertIn('staff_eval.py', dockerfile)
        self.assertIn('staff-eval-session.html', dockerfile)
        self.assertEqual(card_knowledge.match('종사자 평가 링크를 공유해'), {'staff_eval'})
        self.assertNotIn('staff_eval', card_knowledge.match('인천점 근로계약서 사용법'))
        rows = card_knowledge.retrieve('staff_eval', '종사자 평가', None)
        self.assertNotIn('auto_score', rows[0]['content'])


if __name__ == '__main__':
    unittest.main()
