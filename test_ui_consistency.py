"""Architectural checks for the shared UI contract, not copies of CSS values."""
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
EXTERNAL_PAGES = {'support-share.html'}
FOUNDATION = '/assets/ui-foundation.css'


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.stylesheets = []
        self.scripts = []
        self.shared_headers = 0
        self.main_regions = 0
        self.feed(source)

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            self.stylesheets.append(urlsplit(attrs['href']).path)
        if tag == 'script' and attrs.get('src'):
            self.scripts.append(urlsplit(attrs['src']).path)
        if tag == 'header' and 'kb-header' in attrs.get('class', '').split():
            self.shared_headers += 1
        if tag == 'main':
            self.main_regions += 1


class UIConsistencyTest(unittest.TestCase):
    def test_every_internal_page_loads_one_shared_foundation_last(self):
        pages = sorted(ROOT.glob('*.html'))
        self.assertTrue(pages, 'No HTML entry points found')
        for path in pages:
            if path.name in EXTERNAL_PAGES:
                continue
            with self.subTest(page=path.name):
                page = Page(path.read_text(encoding='utf-8'))
                for stylesheet in ('/assets/site.css', '/assets/navigation.css', FOUNDATION):
                    self.assertEqual(page.stylesheets.count(stylesheet), 1, stylesheet)
                self.assertEqual(page.stylesheets[-1], FOUNDATION)
                self.assertEqual(page.scripts.count('/assets/navigation.js'), 1)
                self.assertEqual(page.shared_headers, 1)
                self.assertEqual(page.main_regions, 1)
                for stylesheet in page.stylesheets:
                    if stylesheet.startswith('/assets/'):
                        self.assertTrue((ROOT / stylesheet.lstrip('/')).is_file(), stylesheet)

    def test_external_sharing_is_explicitly_isolated(self):
        for name in EXTERNAL_PAGES:
            with self.subTest(page=name):
                page = Page((ROOT / name).read_text(encoding='utf-8'))
                self.assertNotIn(FOUNDATION, page.stylesheets)
                self.assertNotIn('/assets/navigation.js', page.scripts)

    def test_internal_headers_use_resolvable_external_destinations(self):
        for path in sorted(ROOT.glob('*.html')):
            if path.name in EXTERNAL_PAGES:
                continue
            with self.subTest(page=path.name):
                source = path.read_text(encoding='utf-8')
                self.assertIn('href="https://www.thevida.co.kr/"', source)
                self.assertIn('href="https://admin.thevida.co.kr/"', source)
                self.assertNotIn('href="https://thevida.co.kr/"', source)

    def test_future_work_instructions_link_to_the_contract(self):
        instructions = (ROOT / 'AGENTS.md').read_text(encoding='utf-8')
        guideline = ROOT / 'docs/UI_UX_GUIDELINES.md'
        self.assertIn(guideline.relative_to(ROOT).as_posix(), instructions)
        self.assertIn('test_ui_consistency.py', instructions)
        self.assertIn(FOUNDATION.lstrip('/'), guideline.read_text(encoding='utf-8'))
        self.assertTrue((ROOT / FOUNDATION.lstrip('/')).is_file())

    def test_shared_token_references_have_definitions(self):
        sources = '\n'.join(path.read_text(encoding='utf-8') for path in (ROOT / 'assets').glob('*.css'))
        definitions = set(re.findall(r'(--ui-[\w-]+)\s*:', sources))
        references = set(re.findall(r'var\(\s*(--ui-[\w-]+)', sources))
        self.assertTrue(definitions, 'Shared UI tokens are missing')
        self.assertFalse(references - definitions, f'Undefined UI tokens: {references - definitions}')


if __name__ == '__main__':
    unittest.main()
