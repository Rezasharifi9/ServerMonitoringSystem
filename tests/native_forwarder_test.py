import copy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import nodeguard_agent as agent

class NativeForwarderTest(unittest.TestCase):
    def test_busy_v2bx_logs_leave_room_for_native_tunnel_logs(self):
        native = "nodeguard-svc-" + "a" * 24 + ".service"
        sampler = agent.Sampler.__new__(agent.Sampler)
        sampler.config = {"serverId": "foreign"}
        sampler.cursors = {}
        plan = {"due": {"logs": 0}, "tunnels": [], "nativeForwarderLogs": [{"id": "route", "unit": native, "redact": []}]}
        def journal(unit, cursor, tags=None, limit=80, *args):
            return [{"message": "event", "source": "v2bx-shared"} for _ in range(limit)], "cursor"
        for count in (1, 100):
            with self.subTest(v2bx_units=count), patch.object(Path, "read_text", return_value="42 0"), patch.object(agent, "managed_v2bx_units", return_value=[(f"v2bx-{n}.service", "running") for n in range(count)]), patch.object(agent, "service_health", return_value=None), patch.object(agent, "journal", side_effect=journal):
                report, cursors = sampler.report(plan)
                self.assertEqual(len(report["logs"]), 100)
                self.assertEqual(sum(item["source"] == "tunnel" for item in report["logs"]), 8)
                self.assertEqual(cursors[native], "cursor")

    def test_dynamic_user_bus_rejection_uses_only_owned_native_cgroup(self):
        unit = "nodeguard-svc-" + "a" * 24 + ".service"
        def contents(path, *args, **kwargs):
            return "populated 1\nfrozen 0\n" if path.name == "cgroup.events" else "Description=NodeGuard managed Rathole service svc-" + "a" * 24
        with patch.object(agent, "service_health", return_value=None), patch.object(Path, "read_text", autospec=True, side_effect=contents):
            self.assertEqual(agent.native_service_health(unit), "running")
            self.assertIsNone(agent.native_service_health("ssh.service"))
        with patch.object(agent, "service_health", return_value=None), patch.object(Path, "read_text", return_value="Description=Unmanaged service"):
            self.assertIsNone(agent.native_service_health(unit))
        with patch.object(agent, "service_health", return_value=None), patch.object(Path, "read_text", side_effect=FileNotFoundError):
            self.assertEqual(agent.native_service_health(unit), "stopped")

    def test_scoped_plan_redaction_does_not_require_reading_root_credentials(self):
        unit = "nodeguard-svc-" + "a" * 24 + ".service"
        with patch.object(Path, "read_text", side_effect=PermissionError("protected credential")) as read:
            logs = agent.redact_forwarder_logs(unit, [{"message": "private-value echoed"}], ["private-value"])
            self.assertEqual(logs[0]["message"], "[redacted] echoed")
            read.assert_not_called()

    def test_health_requires_live_service_and_connected_control_channel(self):
        item = {"id": "test", "unit": "nodeguard-svc-" + "a" * 24 + ".service", "controlPort": 3080}
        with patch.object(agent, "service_health", return_value="running") as health, patch.object(agent, "safe_command", return_value=SimpleNamespace(returncode=0, stdout="peer:50123")) as command:
            self.assertTrue(agent.native_forwarder_probe(item)["ok"])
            command.return_value.stdout = ""
            self.assertFalse(agent.native_forwarder_probe(item)["ok"])
            command.return_value.stdout = "peer:50123"; health.return_value = "stopped"
            self.assertFalse(agent.native_forwarder_probe(item)["ok"])
            self.assertIsNone(agent.native_forwarder_probe({**item, "controlPort": "3080; reboot"}))
            self.assertIsNone(agent.native_forwarder_probe({**item, "unit": "ssh.service"}))

    def test_private_config_values_never_enter_tunnel_logs(self):
        unit = "nodeguard-svc-" + "a" * 24 + ".service"
        logs = [{"message": '{"default_token":"fixture-secret","private_key":"fixture-key"}'}]
        with patch.object(Path, "read_text", return_value='[server]\ndefault_token="fixture-secret"\n[server.transport.noise]\nlocal_private_key="fixture-key"\n'):
            result = agent.redact_forwarder_logs(unit, copy.deepcopy(logs))
            self.assertNotIn("fixture-secret", result[0]["message"])
            self.assertNotIn("fixture-key", result[0]["message"])
        with patch.object(Path, "read_text", side_effect=OSError("missing")):
            self.assertEqual(agent.redact_forwarder_logs(unit, logs), [])

if __name__ == "__main__": unittest.main()
