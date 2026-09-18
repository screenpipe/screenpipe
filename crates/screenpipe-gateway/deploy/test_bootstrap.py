# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import base64
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch, mock_open
spec = importlib.util.spec_from_file_location("loader", Path(__file__).with_name("load-secret.py"))
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)

class BootstrapTests(unittest.TestCase):
    def config(self, cloud="azure"):
        return dict(cloud=cloud, license_id="lic-1", control_plane="https://screenpipe.test",
                    policy_public_key="public", prefix="", account="archive", container="telemetry",
                    bucket="archive", vault_name="vault", secret_name="enrollment", project="test-project")

    def test_azure_uses_managed_identity_and_only_the_named_secret(self):
        calls = []
        def request(url, headers):
            calls.append((url, headers))
            return {"access_token": "fixture"} if len(calls) == 1 else {"value": "sge_fixture"}
        self.assertEqual(loader.load_enrollment(self.config(), request), "sge_fixture")
        self.assertEqual(calls[0][1], {"Metadata": "true"})
        self.assertIn("vault.vault.azure.net/secrets/enrollment?", calls[1][0])

    def test_gcp_uses_attached_service_account(self):
        calls = []
        def request(url, headers):
            calls.append((url, headers))
            return {"access_token": "fixture"} if len(calls) == 1 else {"payload": {"data": base64.b64encode(b"sge_fixture").decode()}}
        self.assertEqual(loader.load_enrollment(self.config("gcp"), request), "sge_fixture")
        self.assertEqual(calls[0][1], {"Metadata-Flavor": "Google"})
        self.assertIn("projects/test-project/secrets/enrollment/versions/latest:access", calls[1][0])

    def test_provider_environment_and_single_line_validation(self):
        for cloud, key in [("azure", "AZURE_CONTAINER"), ("gcp", "GCS_BUCKET")]:
            env = loader.environment(self.config(cloud), "sge_fixture")
            self.assertIn("SCREENPIPE_GATEWAY_" + key + "=", env)
            self.assertNotIn("S3_BUCKET", env)
            self.assertNotIn("ACCESS_KEY", env)
        with self.assertRaises(ValueError):
            loader.environment(self.config(), "sge_fixture\nOTHER=bad")
        with self.assertRaises(ValueError):
            loader.environment({**self.config(), "license_id": "lic\nINJECT=1"}, "sge_fixture")

    @patch.object(loader.subprocess, "run")
    @patch.object(loader.os, "umask")
    @patch.object(loader.os, "chown")
    @patch.object(loader.os, "chmod")
    @patch.object(loader.os, "makedirs")
    @patch.object(loader.os.path, "ismount", return_value=True)
    @patch.object(loader.os.path, "exists", return_value=True)
    @patch.object(loader.os.path, "isfile", return_value=True)
    @patch.object(loader, "load_enrollment")
    def test_registered_restart_needs_no_enrollment_secret(self, load, *_):
        with patch("builtins.open", mock_open(read_data=json.dumps(self.config()))):
            loader.main()
        load.assert_not_called()

if __name__ == "__main__":
    unittest.main()
