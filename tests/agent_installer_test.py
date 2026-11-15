import io
import json
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import install_agent as installer
import nodeguard_enroll


class AgentInstallerTest(unittest.TestCase):
    def setUp(self):
        sandbox = TemporaryDirectory()
        self.addCleanup(sandbox.cleanup)
        root = Path(sandbox.name)
        self.config_dir = root / "etc"
        self.modules = root / "modules"
        self.units = root / "units"
        for path in (self.config_dir, self.modules, self.units):
            path.mkdir()
        self.token = self.config_dir / "agent.token"
        self.pending = self.config_dir / "agent.token.pending"
        self.config_path = self.config_dir / "agent.json"
        self.defaults = {
            "serverId": "ir-main",
            "interface": "ens3",
            "endpoint": "https://monitor.example/api/v1/agent/telemetry",
            "tokenFile": str(self.token),
        }
        source = Path(installer.__file__).parent
        self.files = {name: (source / name).read_bytes() for name in installer.MODULES}
        self.files.update({name: installer.MANAGED_UNIT for name in installer.UNITS})
        self.args = SimpleNamespace(interface=None, reuse_credential=False, stdin_code=True, with_iperf=False,
                                    with_provision=False, sync_iperf_receivers=False, sync_tunnels=False)
        mocks = (
            patch.multiple(installer, CONFIG_DIR=self.config_dir, MODULE_DIR=self.modules, UNIT_DIR=self.units),
            patch.object(installer, "secure_mode", side_effect=lambda path, kind: stat.S_IFREG if path.exists() else None),
            patch.object(installer, "put", side_effect=lambda path, data: path.write_bytes(data)),
            patch.object(installer, "sync_directory"),
            patch.object(Path, "is_dir", return_value=True),
            patch.object(sys, "stdin", io.StringIO("b" * 64 + "\n")),
            patch.object(sys, "path", list(sys.path)),
            patch("builtins.print"),
            patch.object(installer.subprocess, "run"),
            patch.object(installer.subprocess, "check_output", return_value="systemd 252\n"),
        )
        for mock in mocks:
            mock.start()
            self.addCleanup(mock.stop)

    def test_install_retries_pending_token_and_keeps_old_credential_until_success(self):
        old = "c" * 64
        self.token.write_text(old, encoding="ascii")
        self.token.chmod(0o600)
        self.config_path.write_text(json.dumps({**self.defaults, "intervalSec": 43}), encoding="utf8")
        calls = 0

        def enroll(config, code):
            nonlocal calls
            calls += 1
            self.assertEqual(config["tokenFile"], str(self.pending))
            self.assertEqual(code, "b" * 64)
            self.assertEqual(self.token.read_text(encoding="ascii"), old)
            credential = nodeguard_enroll.prepare_credential(self.pending)
            if calls == 1:
                self.first_attempt = credential
                raise URLError("lost response")
            self.assertEqual(credential, self.first_attempt)

        with patch.object(nodeguard_enroll, "enroll", side_effect=enroll):
            with self.assertRaises(URLError):
                installer.install_service(self.defaults, self.files, self.args)
            self.assertEqual(self.token.read_text(encoding="ascii"), old)
            self.assertTrue(self.pending.exists())
            installer.subprocess.run.assert_not_called()
            sys.stdin.seek(0)
            installer.install_service(self.defaults, self.files, self.args)
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.token.read_text(encoding="ascii").strip(), self.first_attempt)
        self.assertEqual(json.loads(self.config_path.read_text(encoding="utf8"))["intervalSec"], 43)
        self.assertEqual([call.args[0][1] for call in installer.subprocess.run.call_args_list],
                         ["daemon-reload", "enable", "restart", "is-active"])

    def test_reuse_skips_enrollment_and_writes_initial_config(self):
        self.token.write_text("d" * 64, encoding="ascii")
        self.token.chmod(0o600)
        self.args.reuse_credential = True
        self.args.interface = "ens4"
        with patch.object(nodeguard_enroll, "enroll") as enroll:
            installer.install_service(self.defaults, self.files, self.args)
        enroll.assert_not_called()
        self.assertEqual(json.loads(self.config_path.read_text(encoding="utf8"))["interface"], "ens4")
        self.assertEqual(self.token.read_text(encoding="ascii"), "d" * 64)
        self.assertEqual({file.name for file in self.units.iterdir()}, {installer.SERVICE})

    def test_workers_require_explicit_flags_and_keep_local_config(self):
        self.token.write_text("d" * 64, encoding="ascii")
        self.token.chmod(0o600)
        self.config_path.write_text(json.dumps({**self.defaults, "intervalSec": 43, "iperfTargets": []}), encoding="utf8")
        target = {"tunnelId": "tun-1", "receiverServerId": "exit-1", "sourceIp": "10.20.0.1", "peerIp": "10.20.0.2", "port": 5201}
        self.defaults["iperfTargets"] = [target]
        self.args.reuse_credential = True
        self.args.with_iperf = True
        self.args.with_provision = True
        with patch.object(installer.os, "access", return_value=True), patch.object(installer, "directory") as directory:
            installer.install_service(self.defaults, self.files, self.args)
        directory.assert_called_once_with(self.config_dir / "profiles")
        self.assertEqual({file.name for file in self.units.iterdir()}, set(installer.UNITS))
        config = json.loads(self.config_path.read_text(encoding="utf8"))
        self.assertEqual(config["intervalSec"], 43)
        self.assertEqual(config["iperfTargets"], [target])
        self.assertIn([installer.SYSTEMCTL, "restart", *installer.UNITS], [call.args[0] for call in installer.subprocess.run.call_args_list])

    def test_iperf_requires_enrolled_target_before_enrollment(self):
        self.args.with_iperf = True
        with patch.object(nodeguard_enroll, "enroll") as enroll:
            with self.assertRaisesRegex(ValueError, "iperfTargets"):
                installer.install_service(self.defaults, self.files, self.args)
        enroll.assert_not_called()
        installer.subprocess.run.assert_not_called()

    def test_receiver_sync_groups_peers_and_retires_only_managed_old_units(self):
        self.token.write_text("d" * 64, encoding="ascii")
        self.token.chmod(0o600)
        self.args.reuse_credential = True
        self.args.sync_iperf_receivers = True
        self.defaults["iperfReceivers"] = [
            {"sourceIp": "10.20.0.1", "bindIp": "10.20.0.2", "port": 5201},
            {"sourceIp": "10.21.0.1", "bindIp": "10.20.0.2", "port": 5201},
            {"sourceIp": "fc00::1", "bindIp": "fc00::2", "port": 5202},
        ]
        stale = self.units / ("nodeguard-iperf-rx-" + "0" * 24 + ".service")
        foreign = self.units / ("nodeguard-iperf-rx-" + "1" * 24 + ".service")
        stale.write_bytes(installer.MANAGED_UNIT)
        foreign.write_bytes(b"[Service]\n")
        with patch.object(installer, "preflight_receiver_tools") as tools:
            installer.install_service(self.defaults, self.files, self.args)
        tools.assert_called_once()
        self.assertFalse(stale.exists())
        self.assertTrue(foreign.exists())
        desired = installer.receiver_units(self.defaults)
        self.assertEqual(len(desired), 2)
        first, second = (contents.decode() for contents in desired.values())
        self.assertIn("IPAddressDeny=any", first)
        self.assertIn("IPAddressAllow=10.20.0.1/32 10.21.0.1/32", first)
        self.assertIn("--server -4 --bind 10.20.0.2 --port 5201 --server-max-duration 30 --server-bitrate-limit 100M", first)
        self.assertIn("iperf_receiver.py %n", first)
        self.assertIn("IPAddressAllow=fc00::1/128", second)
        self.assertEqual({file.name for file in self.units.iterdir()}, {installer.SERVICE, foreign.name, *desired})
        commands = [call.args[0] for call in installer.subprocess.run.call_args_list]
        self.assertEqual(commands[0], [installer.SYSTEMCTL, "disable", "--now", stale.name])
        self.assertTrue(any(command[1] == "restart" for command in commands))

    def test_receiver_plan_refuses_invalid_enrollment_before_touching_services(self):
        self.args.sync_iperf_receivers = True
        for invalid in (None, [{"sourceIp": "1.2.3.4", "bindIp": "10.20.0.2", "port": 5201}],
                        [{"sourceIp": "fc00::1", "bindIp": "10.20.0.2", "port": 5201}],
                        [{"sourceIp": "10.20.0.1", "bindIp": "10.20.0.2", "port": 80}]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                installer.install_service({**self.defaults, "iperfReceivers": invalid}, self.files, self.args)
        self.assertEqual(list(self.units.iterdir()), [])
        installer.subprocess.run.assert_not_called()

    def test_independently_managed_unit_blocks_install(self):
        unit = self.units / installer.SERVICE
        unit.write_bytes(b"[Service]\n")
        with patch.object(nodeguard_enroll, "enroll") as enroll:
            with self.assertRaisesRegex(ValueError, "independently managed"):
                installer.install_service(self.defaults, self.files, self.args)
        enroll.assert_not_called()
        installer.subprocess.run.assert_not_called()
        self.assertEqual(unit.read_bytes(), b"[Service]\n")

class UbuntuCompatibilityTest(unittest.TestCase):
    def test_runtime_sources_parse_on_python_38(self):
        import ast
        source = Path(installer.__file__).parent
        for name in (*installer.MODULES, "ssh_stage.py", "install_agent.py"):
            with self.subTest(module=name):
                ast.parse((source / name).read_text(), feature_version=(3, 8))

    def test_systemd_versions_for_supported_ubuntu_releases(self):
        import subprocess
        group = SimpleNamespace(getgrnam=lambda _: object())
        for ubuntu, systemd in (("20.04", 245), ("22.04", 249), ("24.04", 255), ("26.04", 259)):
            with self.subTest(ubuntu=ubuntu), patch.object(sys, "platform", "linux"), \
                    patch.object(installer.os, "geteuid", return_value=0, create=True), \
                    patch.object(Path, "is_dir", return_value=True), \
                    patch.dict(sys.modules, {"grp": group}), \
                    patch.object(subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                    patch.object(subprocess, "check_output", return_value=f"systemd {systemd}\n"):
                installer.system_ready()

    def test_ubuntu_2004_uses_private_static_user_credential(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            token = root / "root.token"
            token.write_bytes(b"a" * 64)
            account = SimpleNamespace(pw_uid=123, pw_gid=123)
            original_path = Path
            def mapped(value):
                return root / "private" if value == "/var/lib/nodeguard-credentials" else original_path(value)
            with patch.object(installer.subprocess, "check_output", return_value="systemd 245\n"), \
                    patch.dict(sys.modules, {"pwd": SimpleNamespace(getpwnam=lambda _: account)}), \
                    patch.object(installer, "Path", side_effect=mapped), \
                    patch.object(installer, "directory", side_effect=lambda path: path.mkdir(exist_ok=True)), \
                    patch.object(installer.os, "fchown", create=True), \
                    patch.object(installer.os, "fchmod", create=True):
                units = {installer.SERVICE: (Path(installer.__file__).parent / installer.SERVICE).read_bytes()}
                output = installer.compatible_units(units, token)[installer.SERVICE].decode()
            self.assertIn("User=nodeguard-agent", output)
            self.assertNotIn("LoadCredential=", output)
            self.assertNotIn("DynamicUser=yes", output)
            self.assertEqual((root / "private" / "agent.token").read_bytes(), token.read_bytes())
            self.assertIn(str(root / "private" / "agent.token"), output)

    def test_modern_systemd_keeps_dynamic_user_and_credentials(self):
        units = {installer.SERVICE: b"DynamicUser=yes\nLoadCredential=agent-token:/etc/nodeguard/agent.token\n"}
        with patch.object(installer.subprocess, "check_output", return_value="systemd 255\n"):
            self.assertEqual(installer.compatible_units(units, Path("unused")), units)

    def test_ubuntu_prerequisites_wait_for_package_lock(self):
        with patch.object(sys, "platform", "linux"), \
                patch.object(installer.os, "geteuid", return_value=0, create=True), \
                patch.object(Path, "read_text", return_value='ID=ubuntu\nVERSION_ID="20.04"\n'), \
                patch.object(Path, "exists", return_value=False), \
                patch.object(installer.subprocess, "run") as run:
            installer.prepare_prerequisites()
        self.assertEqual(run.call_count, 2)
        self.assertTrue(all("DPkg::Lock::Timeout=180" in call.args[0] for call in run.call_args_list))

