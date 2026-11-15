from hashlib import sha256
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import nodeguard_agent as agent


class ForwarderProbeTest(unittest.TestCase):
    def test_missing_toml_parser_withholds_managed_logs(self):
        unit = "nodeguard-svc-" + "a" * 24 + ".service"
        with patch.object(agent, "tomllib", None):
            self.assertEqual(agent.redact_forwarder_logs(unit, [{"message": "secret"}]), [])
            self.assertEqual(agent.redact_forwarder_logs(unit, [{"message": "secret"}], ["secret"]),
                             [{"message": "[redacted]"}])

    def test_missing_interface_reports_offline_instead_of_retaining_old_health(self):
        item = {"id": "tun-gre", "interface": "gre1", "peer": "10.1.0.2", "mtu": 1376}
        with patch.object(agent, "interface_state", side_effect=FileNotFoundError):
            result = agent.probe_tunnel(item, None)
        self.assertEqual(result["status"], "offline")
        self.assertEqual(result["packetLoss"], 100)
        self.assertEqual(result["mtu"], 1376)
        self.assertNotIn("rxMbps", result)
        self.assertNotIn("txMbps", result)
        with patch.object(agent, "interface_state", side_effect=FileNotFoundError):
            legacy_result = agent.probe_tunnel(item, {})
        self.assertEqual((legacy_result["rxMbps"], legacy_result["txMbps"]), (0, 0))
        with patch.object(agent, "interface_state", side_effect=PermissionError):
            self.assertIsNone(agent.probe_tunnel(item, None))

    def test_probe_stream_omits_traffic_for_healthy_and_missing_interfaces(self):
        items = [{"id": "healthy", "interface": "gre1", "peer": "10.1.0.2"},
                 {"id": "missing", "interface": "gre2", "peer": "10.2.0.2"}]
        with patch.object(agent, "interface_state", side_effect=[({}, 1400, True), FileNotFoundError]), \
                patch.object(agent, "icmp_probe", return_value={"packetLoss": 0, "rttMs": 10, "jitterMs": 1}):
            results = [agent.probe_tunnel(item, None) for item in items]
        self.assertEqual([item["status"] for item in results], ["healthy", "offline"])
        self.assertTrue(all("rxMbps" not in item and "txMbps" not in item for item in results))

    def test_requires_expected_https_result(self):
        config = {"id": "tun-forward-lab", "localPort": 8443, "url": "https://health.example/tunnel"}
        with patch.object(agent, "safe_command", return_value=SimpleNamespace(returncode=0, stdout="204")) as command:
            result = agent.forwarder_probe(config)
        self.assertTrue(result["ok"])
        self.assertEqual(result["tunnelId"], "tun-forward-lab")
        self.assertIn("measuredAt", result)
        arguments = command.call_args.args[1]
        self.assertEqual(arguments[arguments.index("--connect-to") + 1], "::127.0.0.1:8443")
        self.assertEqual(arguments[arguments.index("--url") + 1], config["url"])
        self.assertNotIn("--insecure", arguments)
        self.assertNotIn("--location", arguments)
        for reply in (None, SimpleNamespace(returncode=60, stdout="204"), SimpleNamespace(returncode=0, stdout="200")):
            with patch.object(agent, "safe_command", return_value=reply):
                self.assertFalse(agent.forwarder_probe(config)["ok"])


class V2bXJournalTest(unittest.TestCase):
    def test_debug_filter_and_urgent_structured_errors_advance_cursors(self):
        reply = SimpleNamespace(returncode=0, stdout="\n".join(json.dumps({
            "__CURSOR": "cursor-" + str(index), "__REALTIME_TIMESTAMP": "1794176000000000",
            "_SYSTEMD_UNIT": "V2bX.service", "PRIORITY": "6", "MESSAGE": message,
        }) for index, message in enumerate([
            'level=debug msg="trace"', 'level=info msg="routine"',
            '{"level":"error","msg":"failed"}', 'level=debug msg="last trace"',
        ])))
        with patch.object(agent, "safe_command", return_value=reply):
            routine, cursor = agent.journal("V2bX.service", None)
            urgent, urgent_cursor = agent.journal("V2bX.service", None, urgent=True)
            debugging, _ = agent.journal("V2bX.service", None, include_debug=True)
        self.assertEqual(len(routine), 2)
        self.assertEqual(len(urgent), 1)
        self.assertEqual(urgent[0]["severity"], "ERROR")
        self.assertEqual(len(debugging), 4)
        self.assertEqual(cursor, "cursor-3")
        self.assertEqual(urgent_cursor, "cursor-3")

    def test_missing_unit_does_not_report_v2bx_as_stopped(self):
        with patch.object(agent, "safe_command", return_value=SimpleNamespace(returncode=0, stdout="LoadState=not-found\nActiveState=inactive\n")):
            self.assertIsNone(agent.service_health("V2bX.service"))

    def test_detects_managed_v2bx_when_dbus_rejects_agent(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            units = root / "units"
            units.mkdir()
            cgroups = root / "cgroups"
            for suffix, component in (("a", "V2bX"), ("b", "GRE")):
                profile = "svc-" + suffix * 24
                unit = f"nodeguard-{profile}.service"
                (units / unit).write_text(f"[Unit]\nDescription=NodeGuard managed {component} service {profile}\n")
                (cgroups / unit).mkdir(parents=True)
                (cgroups / unit / "cgroup.events").write_text("populated 1\nfrozen 0\n")
            with patch.object(agent, "SYSTEM_UNITS", units), patch.object(agent, "SYSTEM_SLICE", cgroups), \
                    patch.object(agent, "safe_command", return_value=SimpleNamespace(returncode=1, stdout="")):
                self.assertEqual(agent.observed_v2bx(None), ("nodeguard-svc-" + "a" * 24 + ".service", "running"))

    def test_exact_tag_matching_and_restart_dedup_key(self):
        unit = "V2bX.service"
        tag = "[https://panel.example]-vless:7"
        messages = [
            (unit, f'time="2026-11-09T00:00:00Z" level=info msg="Added users" tag="{tag}"'),
            (unit, json.dumps({"level": "error", "msg": "node failed", "tag": tag})),
            (unit, f'level=info msg="Client supplied tag={tag}"'),
            (unit, f'level=info msg="different node" tag="{tag}0"'),
            ("other.service", f'level=info msg="not V2bX" tag="{tag}"'),
            (unit, f'level=info msg="duplicate fields" tag="{tag}" tag="{tag}"'),
            (unit, '{"level":"info","msg":"duplicate fields","tag":"wrong","tag":' + json.dumps(tag) + '}'),
        ]
        reply = SimpleNamespace(returncode=0, stdout="\n".join(json.dumps({
            "__CURSOR": "cursor-" + str(index), "__REALTIME_TIMESTAMP": "1794176000000000",
            "_SYSTEMD_UNIT": origin, "PRIORITY": "6", "MESSAGE": message,
        }) for index, (origin, message) in enumerate(messages)))
        with patch.object(agent, "safe_command", return_value=reply) as command:
            entries, cursor = agent.journal(unit, None, {tag: "node-1"})
            restarted, _ = agent.journal(unit, None, {tag: "node-1"})
        self.assertEqual(cursor, "cursor-6")
        self.assertEqual([entry.get("nodeId") for entry in entries], ["node-1", "node-1", None, None, None, None, None])
        self.assertEqual(entries[0]["source"], "v2bx-node")
        self.assertEqual(entries[-1]["source"], "v2bx-shared")
        self.assertEqual(entries[0]["eventKey"], sha256(b"cursor-0").hexdigest())
        self.assertEqual(entries, restarted)
        self.assertIn("--since=-10min", command.call_args.args[1])
        with patch.object(agent, "safe_command", return_value=None):
            self.assertEqual(agent.journal(unit, cursor), ([], cursor))


class SpeedBatchProbeTest(unittest.TestCase):
    def test_ten_ping_attempts_are_parsed_from_the_tunnel_interface(self):
        stdout = "\n".join(
            f"64 bytes from 10.90.1.2: icmp_seq={index} ttl=64 time={value} ms"
            for index, value in enumerate((80, 90, 100), 1)
        )
        with patch.object(agent, "safe_command", return_value=SimpleNamespace(returncode=0, stdout=stdout)) as command:
            samples = agent.ping_rtts("10.90.1.2", "gre1")
        self.assertEqual(samples, [80.0, 90.0, 100.0])
        arguments = command.call_args.args[1]
        self.assertEqual(arguments[arguments.index("-c") + 1], "10")
        self.assertEqual(arguments[arguments.index("-I") + 1], "gre1")
        self.assertEqual(arguments[-1], "10.90.1.2")
        with self.assertRaises(ValueError):
            agent.ping_rtts("10.90.1.2", "gre 1")

    def test_speedtest_download_is_average_megabits(self):
        reply = SimpleNamespace(returncode=0, stdout='{"download":{"bandwidth":12500000}}')
        with patch.object(agent, "speedtest_installed", return_value=True), \
                patch.object(agent, "safe_command", return_value=reply) as command:
            self.assertEqual(agent.speedtest_download_mbps("gre1"), (100, None))
        self.assertEqual(command.call_args.args[1][command.call_args.args[1].index("--interface") + 1], "gre1")
        with patch.object(agent, "speedtest_installed", return_value=False):
            self.assertEqual(agent.speedtest_download_mbps(None), (None, "speedtest_missing"))

    def test_batch_uses_ten_pings_and_one_bandwidth_reading(self):
        probe = {
            "id": "11111111-1111-4111-8111-111111111111", "mode": "internet", "pingCount": 10,
            "bandwidth": "speedtest", "peer": "10.1.1.1", "interface": "gre1",
        }
        seen = {}

        def ping(peer, interface=None, count=10):
            seen.update(peer=peer, interface=interface, count=count)
            return [80, 90, 100, 85, 95, 88, 92, 91, 89, 90]

        with patch.object(agent, "ping_rtts", side_effect=ping), \
                patch.object(agent, "speedtest_download_mbps", return_value=(100, None)) as speed:
            result = agent.execute_speed_batch(probe)
        self.assertEqual(seen, {"peer": "1.1.1.1", "interface": None, "count": 10})
        self.assertEqual(result["pingsMs"], [80, 90, 100, 85, 95, 88, 92, 91, 89, 90])
        self.assertEqual(result["bandwidthMbps"], 100)
        self.assertIsNone(result["error"])
        speed.assert_called_once_with(None)

        failed = {**probe, "mode": "gre", "peer": "10.90.1.2", "interface": "gre1"}
        with patch.object(agent, "ping_rtts", return_value=[]), \
                patch.object(agent, "measure_bandwidth", return_value=(50, None)):
            result = agent.execute_speed_batch(failed)
        self.assertEqual(result["error"], "ping_failed")
        self.assertIsNone(result["bandwidthMbps"])


if __name__ == "__main__":
    unittest.main()
