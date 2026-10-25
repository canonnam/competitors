import io
import json
import subprocess
import unittest
import urllib.error
from unittest.mock import patch

from scripts import publish_claim_check


class PublishVerificationTests(unittest.TestCase):
    def test_password_protected_site_is_verified_through_existing_railway_login(self):
        report = {"benefitMonth": "2026-09", "branches": []}
        error = urllib.error.HTTPError(
            publish_claim_check.URL, 401, "Unauthorized", {},
            io.BytesIO(b'{"code":"site_locked"}'),
        )
        result = subprocess.CompletedProcess([], 0, json.dumps(report), "")
        with patch.object(publish_claim_check.urllib.request, "urlopen", side_effect=error), \
                patch.object(publish_claim_check.subprocess, "run", return_value=result) as ssh:
            self.assertEqual(publish_claim_check.read_published("railway"), report)
        command = ssh.call_args.args[0]
        self.assertIn(publish_claim_check.SERVICE, command)
        self.assertEqual(command[-2:], ["python", "/app/claim_check.py"])

    def test_unrelated_authorization_error_is_not_treated_as_site_password(self):
        error = urllib.error.HTTPError(
            publish_claim_check.URL, 401, "Unauthorized", {},
            io.BytesIO(b'{"code":"different_auth_error"}'),
        )
        with patch.object(publish_claim_check.urllib.request, "urlopen", side_effect=error), \
                patch.object(publish_claim_check.subprocess, "run") as ssh:
            with self.assertRaises(urllib.error.HTTPError):
                publish_claim_check.read_published("railway")
        ssh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
