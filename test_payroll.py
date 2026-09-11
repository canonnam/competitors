"""Contract route, asset access, and client-only personal input safeguards."""
from html.parser import HTMLParser
from pathlib import Path
import unittest
from test_site_identity import SiteIdentityTests

ROOT = Path(__file__).resolve().parent

class FormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.fields = []
        self.assets = []
        self.forms = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('input', 'select', 'textarea'):
            self.fields.append(a)
        if tag == 'script' and a.get('src'):
            self.assets.append(a['src'])
        if tag == 'link' and a.get('rel') == 'stylesheet':
            self.assets.append(a['href'])
        if tag == 'form':
            self.forms.append(a)

class PayrollRouteTests(SiteIdentityTests):
    def test_payroll_assets_and_no_personal_data_submission(self):
        status, headers, body = self.request('/payroll.html')
        self.assertEqual(status, 200)
        parser = FormParser()
        parser.feed(body.decode('utf-8'))
        names = {f.get('name') for f in parser.fields}
        self.assertTrue({'organization','organizationAddress','residentNumber','employee','bank','account'} <= names)
        self.assertNotIn('workplace', names)
        self.assertIn('termYears', names)
        for name in ('manualOvertime', 'manualNight', 'overtimeOrdinary', 'nightOrdinary'):
            self.assertEqual(sum(f.get('name') == name for f in parser.fields), 1)
        for name in ('overtimeOrdinary', 'nightOrdinary'):
            self.assertIn('checked', next(f for f in parser.fields if f.get('name') == name))
        self.assertFalse(any(f.get('type') == 'file' for f in parser.fields))
        self.assertEqual(parser.forms[0]['onsubmit'], 'return false')
        for asset in parser.assets + ['/assets/contracts/templates.json', '/assets/contracts/NanumGothic-Regular.ttf', '/assets/contracts/NanumGothic-Bold.ttf']:
            with self.subTest(asset=asset):
                self.assertEqual(self.request(asset)[0], 200)
        self.assertEqual(self.request('/test_payroll.cjs')[0], 404)
        self.assertEqual(self.request('/assets/contracts/private.json')[0], 404)
        js = (ROOT/'assets/payroll.js').read_text(encoding='utf-8')
        for forbidden in ('localStorage','sessionStorage','sendBeacon','XMLHttpRequest','/api/','JSON.stringify(model)'):
            self.assertNotIn(forbidden, js)

if __name__ == '__main__':
    unittest.main()
