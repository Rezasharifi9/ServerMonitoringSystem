import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import agent_credentials as credentials


class CredentialOwnershipTest(unittest.TestCase):
    def test_dynamic_user_may_read_only_its_own_private_credential(self):
        with patch.object(credentials.os, "geteuid", return_value=65500, create=True):
            directory = SimpleNamespace(st_uid=65500, st_gid=0, st_mode=0o500)
            token = SimpleNamespace(st_uid=65500, st_gid=0, st_mode=0o400)
            self.assertTrue(credentials._protected_credential(directory, 0o027, 0o277))
            self.assertTrue(credentials._protected_credential(token, 0o337, 0o377))
            for owner, group, mode in ((65501, 0, 0o400), (65500, 1, 0o400), (65500, 0, 0o440), (65500, 0, 0o600)):
                self.assertFalse(credentials._protected_credential(
                    SimpleNamespace(st_uid=owner, st_gid=group, st_mode=mode), 0o337, 0o377))


@unittest.skipUnless(os.name == "posix" and os.geteuid() == 0, "root-owned systemd credential fixture")
class SystemdCredentialTest(unittest.TestCase):
    def test_systemd_copy_does_not_relax_regular_token_permissions(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            service = root / "test.service"
            service.mkdir(mode=0o700)
            token = service / "agent-token"
            token.write_text("a" * 64, encoding="ascii")
            token.chmod(0o440)
            service.chmod(0o550)
            with patch.object(credentials, "SYSTEMD_CREDENTIALS", root), patch.dict(os.environ, {"CREDENTIALS_DIRECTORY": str(service)}):
                self.assertEqual(credentials.read_explicit_token(token), "a" * 64)
                with self.assertRaises(ValueError):
                    credentials.read_token_file(token)
                token.chmod(0o444)
                with self.assertRaises(ValueError):
                    credentials.read_explicit_token(token)
                token.chmod(0o440)
                service.chmod(0o755)
                with self.assertRaises(ValueError):
                    credentials.read_explicit_token(token)

    def test_regular_token_remains_private_and_explicit(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "agent.token"
            path.write_text("b" * 64, encoding="ascii")
            path.chmod(0o600)
            self.assertEqual(credentials.read_explicit_token(path), "b" * 64)
            path.chmod(0o640)
            with self.assertRaises(ValueError):
                credentials.read_explicit_token(path)
