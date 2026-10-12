from contextlib import closing
from io import BytesIO
import concurrent.futures
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import uuid

import website_intake as intake
import website_telegram as telegram


class WebsiteTelegramTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            'WEBSITE_INTAKE_DB_PATH': self.temp.name + '/intake.db',
            'TELEGRAM_BOT_TOKEN': '123456:fake_test_token', 'TELEGRAM_CHAT_ID': '12345678',
            'WEBSITE_TELEGRAM_ENABLED': 'true', 'WEBSITE_TELEGRAM_NOTIFY_DEV': 'false',
        })
        self.env.start()
        intake.init_db()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def payload(self, kind='trial', environment='production'):
        data = {'name': '가상 신청자', 'organization': '가상 기관',
                'phone': '010-0000-0000', 'privacyConsent': True}
        if kind == 'visit':
            data = {'branch': 'anyang', 'date': '2099-10-12', 'time': '14:00',
                    'elderName': '가상 어르신', 'guardianName': '가상 보호자',
                    'guardianPhone': '010-0000-0000', 'relationship': '자녀',
                    'inquiryType': '입소 상담', 'message': '가상 방문 문의', 'privacyConsent': True}
        return {'id': str(uuid.uuid4()), 'kind': kind, 'environment': environment,
                'clientHash': uuid.uuid4().hex * 2, 'data': data}

    def rows(self):
        with closing(intake.connect()) as db:
            return [dict(row) for row in db.execute('SELECT * FROM website_telegram_outbox')]

    def record(self, request_id):
        with closing(intake.connect()) as db:
            return dict(db.execute('SELECT * FROM website_requests WHERE id=?', (request_id,)).fetchone())

    def test_production_queue_is_atomic_and_duplicate_ingestion_does_not_resend(self):
        payload = self.payload()
        with patch.object(telegram, 'send_notification') as send:
            intake.save(payload)
            self.assertTrue(intake.save(payload)['duplicate'])
            self.assertEqual(len(self.rows()), 1)
            send.assert_not_called()
        with patch.object(telegram, 'enqueue', side_effect=sqlite3.OperationalError('failure')):
            failed = self.payload()
            with self.assertRaises(sqlite3.OperationalError):
                intake.save(failed)
        self.assertIsNone(self.record_or_none(failed['id']))

    def record_or_none(self, request_id):
        with closing(intake.connect()) as db:
            return db.execute('SELECT id FROM website_requests WHERE id=?', (request_id,)).fetchone()

    def test_dev_opt_in_and_disabled_configuration_never_backfill_history(self):
        intake.save(self.payload(environment='dev'))
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': ''}):
            intake.save(self.payload())
        self.assertEqual(self.rows(), [])
        intake.init_db()
        self.assertEqual(self.rows(), [])
        with patch.dict(os.environ, {'WEBSITE_TELEGRAM_NOTIFY_DEV': 'true'}):
            intake.save(self.payload(environment='dev'))
        with patch.dict(os.environ, {'WEBSITE_TELEGRAM_ENABLED': 'false'}):
            intake.save(self.payload())
            self.assertEqual(telegram.dispatch_pending()['sent'], 0)
        self.assertEqual(len(self.rows()), 1)

    def test_success_persists_and_restart_does_not_resend(self):
        intake.save(self.payload())
        with patch.object(telegram, 'send_notification', return_value=101) as send:
            self.assertEqual(telegram.dispatch_pending()['sent'], 1)
            intake.init_db()
            self.assertEqual(telegram.dispatch_pending()['sent'], 0)
            send.assert_called_once()
        row = self.rows()[0]
        self.assertEqual((row['state'], row['attempts'], row['message_id']), ('sent', 1, 101))
        self.assertTrue(row['sent_at'])

    def test_failure_preserves_inquiry_and_retries_after_backoff(self):
        payload = self.payload()
        intake.save(payload)
        with patch.object(telegram, 'send_notification', side_effect=telegram.DeliveryError('telegram_429', 90)):
            with self.assertLogs(telegram.LOG, level='WARNING') as logs:
                result = telegram.dispatch_pending(now=1000)
        self.assertEqual(result['retry_after'], 90)
        self.assertNotIn(payload['data']['name'], ''.join(logs.output))
        self.assertNotIn('fake_test_token', ''.join(logs.output))
        self.assertTrue(self.record(payload['id']))
        self.assertEqual(self.rows()[0]['next_attempt'], 1090)
        with patch.object(telegram, 'send_notification', return_value=102) as send:
            self.assertEqual(telegram.dispatch_pending(now=1089)['sent'], 0)
            send.assert_not_called()
            self.assertEqual(telegram.dispatch_pending(now=1090)['sent'], 1)

    def test_concurrent_workers_claim_one_delivery(self):
        intake.save(self.payload())
        claimed, release = threading.Event(), threading.Event()
        def send(*args):
            claimed.set()
            self.assertTrue(release.wait(5))
            return 103
        with patch.object(telegram, 'send_notification', side_effect=send) as sender:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(telegram.dispatch_pending)
                self.assertTrue(claimed.wait(5))
                try:
                    self.assertEqual(pool.submit(telegram.dispatch_pending).result(timeout=5)['sent'], 0)
                finally:
                    release.set()
                self.assertEqual(first.result(timeout=5)['sent'], 1)
            sender.assert_called_once()

    def test_expired_lease_is_recovered_but_active_lease_is_held(self):
        intake.save(self.payload())
        telegram._claim('12345678', 1000)
        with patch.object(telegram, 'send_notification', return_value=104) as sender:
            self.assertEqual(telegram.dispatch_pending(now=1119)['sent'], 0)
            sender.assert_not_called()
            self.assertEqual(telegram.dispatch_pending(now=1120)['sent'], 1)
        self.assertEqual(self.rows()[0]['attempts'], 2)

    def test_recipient_change_does_not_forward_old_queue_to_another_chat(self):
        intake.save(self.payload())
        with patch.dict(os.environ, {'TELEGRAM_CHAT_ID': '87654321'}):
            with patch.object(telegram, 'send_notification') as sender:
                self.assertEqual(telegram.dispatch_pending()['sent'], 0)
                sender.assert_not_called()

    def test_labels_korean_time_and_plain_text_are_preserved(self):
        for kind in ('visit', 'trial', 'pricing'):
            payload = self.payload(kind)
            intake.save(payload)
            record = self.record(payload['id'])
            record['created'] = '2026-10-12T00:01:00+00:00'
            text = telegram.message_text(record)
            self.assertIn('2026-10-12 09:01', text)
            self.assertIn(payload['id'], text)
            self.assertIn(telegram.INBOX_URL, text)
            self.assertNotIn('privacyConsent', text)
        self.assertIn('더비다 안양점', telegram.message_text(self.record_or_visit()))
        payload = self.payload('pricing', 'dev')
        payload['data'].update(service='facility-dashboard', facilityType='요양원', position='대표',
                               name='😀'*100, organization='😀'*100, message='😀'*2000)
        intake.save(payload)
        text = telegram.message_text(self.record(payload['id']))
        self.assertIn('[개발 사이트]', text)
        self.assertIn('대시보드 구축 상담', text)
        self.assertLessEqual(len(text.encode('utf-16-le')) // 2, 4096)

    def record_or_visit(self):
        with closing(intake.connect()) as db:
            return dict(db.execute("SELECT * FROM website_requests WHERE kind='visit'").fetchone())

    def test_api_failure_redacts_token_url_and_server_description(self):
        secret_url = 'https://api.telegram.org/bot123456:fake_test_token/sendMessage'
        error = urllib.error.HTTPError(secret_url, 429, 'secret description', {},
            BytesIO(json.dumps({'ok': False, 'error_code': 429, 'description': 'private information',
                                'parameters': {'retry_after': 70}}).encode()))
        opener = MagicMock()
        opener.open.side_effect = error
        with patch.object(telegram.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(telegram.DeliveryError) as caught:
                telegram.api_request('123456:fake_test_token', 'sendMessage', {})
        self.assertEqual(str(caught.exception), 'telegram_429')
        self.assertEqual(caught.exception.retry_after, 70)
        self.assertNotIn('fake_test_token', str(caught.exception))
        self.assertIsNone(telegram.NoRedirect().redirect_request(None, None, None, None, None, None))

    def test_notification_api_payload_and_recipient_validation(self):
        payload = self.payload('visit')
        payload['data']['message'] = '<script>문의 & 확인</script>'
        intake.save(payload)
        with patch.object(telegram, 'api_request', return_value={'message_id': 105, 'chat': {'id': 12345678}}) as api:
            self.assertEqual(telegram.send_notification('test-token', '12345678', self.record(payload['id'])), 105)
        body = api.call_args.args[2]
        self.assertNotIn('parse_mode', body)
        self.assertTrue(body['protect_content'])
        self.assertIn('<script>문의 & 확인</script>', body['text'])
        self.assertEqual(body['reply_markup']['inline_keyboard'][0][0]['url'], telegram.INBOX_URL)
        with patch.object(telegram, 'api_request', return_value={'message_id': 106, 'chat': {'id': 999}}):
            with self.assertRaises(telegram.DeliveryError):
                telegram.send_notification('test-token', '12345678', self.record(payload['id']))

    def test_background_worker_processes_queue_and_disabled_worker_never_calls_api(self):
        dispatched = threading.Event()
        def dispatch():
            dispatched.set()
            return {'sent': 0, 'failed': 0, 'retry_after': 0}
        with patch.object(telegram, 'dispatch_pending', side_effect=dispatch):
            stop = telegram.start_worker()
            try:
                self.assertTrue(dispatched.wait(5))
            finally:
                stop.set()
                for thread in threading.enumerate():
                    if thread.name == 'website-telegram':
                        thread.join(5)
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': ''}):
            with patch.object(telegram, 'dispatch_pending') as dispatch:
                telegram.start_worker().set()
                dispatch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
