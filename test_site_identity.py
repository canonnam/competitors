"""Verify branding and search exclusion on actual HTTP responses."""
import http.client
from html.parser import HTMLParser
from pathlib import Path
import struct
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

import app

ROOT = Path(__file__).resolve().parent
ORIGIN = 'https://competitors-dev.up.railway.app'


class HeadMetadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            self.meta[attrs.get('name', attrs.get('property'))] = attrs.get('content')
        elif tag == 'link':
            self.links.append(attrs)


class SiteIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.App)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, path, method='GET', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def assert_not_indexable(self, headers):
        directives = {part.strip() for part in headers['X-Robots-Tag'].split(',')}
        self.assertTrue({'noindex', 'nofollow', 'nosnippet', 'noimageindex'} <= directives)

    def test_every_page_delivers_metadata_without_javascript(self):
        for file in ROOT.glob('*.html'):
            path = '/' if file.name == 'index.html' else '/' + file.name
            with self.subTest(page=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assert_not_indexable(headers)
                head = HeadMetadata()
                head.feed(body.decode('utf-8').split('</head>', 1)[0])
                self.assertIn('noindex', head.meta['robots'])
                self.assertEqual(head.meta['og:url'], ORIGIN + path)
                self.assertEqual(head.meta['twitter:card'], 'summary_large_image')
                self.assertEqual(head.meta['og:image'], head.meta['twitter:image'])
                self.assertEqual(head.meta['og:image:width'], '1200')
                self.assertEqual(head.meta['og:image:height'], '630')
                image_url = urlsplit(head.meta['og:image'])
                self.assertEqual(image_url.scheme, 'https')
                self.assertEqual(image_url.netloc, urlsplit(ORIGIN).netloc)
                self.assertTrue((ROOT / image_url.path.lstrip('/')).is_file())
                icons = [item for item in head.links if item.get('rel') in {'icon', 'apple-touch-icon'}]
                self.assertEqual(len(icons), 3)
                for icon in icons:
                    self.assertEqual(self.request(icon['href'])[0], 200)

    def test_assets_api_errors_and_head_responses_are_not_indexable(self):
        paths = {
            '/assets/brand/og-image.png': (200, 'image/png'),
            '/assets/brand/favicon.svg': (200, 'image/svg+xml'),
            '/favicon.ico': (200, 'image/'),
            '/robots.txt': (200, 'text/plain'),
            '/api/naver-ads': (200, 'application/json'),
            '/missing-page': (404, 'text/html'),
            '/app.py': (404, 'text/html'),
            '/.env': (404, 'text/html'),
        }
        with patch.object(app.naver_ads, 'report', return_value={'status': 'test'}):
            for path, (expected_status, content_type) in paths.items():
                for method in ('GET', 'HEAD'):
                    with self.subTest(path=path, method=method):
                        status, headers, body = self.request(path, method)
                        self.assertEqual(status, expected_status)
                        self.assertTrue(headers['Content-Type'].startswith(content_type))
                        self.assert_not_indexable(headers)
                        if method == 'HEAD':
                            self.assertEqual(body, b'')

    def test_conditional_response_keeps_noindex_header(self):
        _, headers, _ = self.request('/assets/brand/og-image.png')
        status, headers, body = self.request('/assets/brand/og-image.png', headers={
            'If-Modified-Since': headers['Last-Modified'],
        })
        self.assertEqual(status, 304)
        self.assertEqual(body, b'')
        self.assert_not_indexable(headers)

    def test_images_and_root_files_are_ready_for_deployment(self):
        raw = (ROOT / 'assets/brand/og-image.png').read_bytes()
        self.assertEqual(raw[:8], b'\x89PNG\r\n\x1a\n')
        self.assertEqual(struct.unpack('>II', raw[16:24]), (1200, 630))
        icon = (ROOT / 'favicon.ico').read_bytes()
        self.assertEqual(struct.unpack('<HHH', icon[:6]), (0, 1, 3))
        self.assertEqual([icon[6 + index * 16] for index in range(3)], [16, 32, 48])
        dockerfile = (ROOT / 'Dockerfile').read_text(encoding='utf-8')
        self.assertIn('COPY robots.txt favicon.ico /app/', dockerfile)
        robots = (ROOT / 'robots.txt').read_text(encoding='utf-8')
        rules = [line for line in robots.splitlines() if line and not line.startswith('#')]
        self.assertEqual(rules, ['User-agent: *', 'Allow: /'])


if __name__ == '__main__':
    unittest.main()
