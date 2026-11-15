import base64
import copy
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import tomllib
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import build_forwarder_bundle as panel
import build_service_bundle as builder
import provision_worker as worker
from provision_worker_test import HostFixture


def settings(component):
    host = {"architecture": "amd64", "restartSeconds": 1800, "assets": []}
    if component == "Rathole":
        server = {"bind_addr": "0.0.0.0:2333", "default_token": "test-private-token", "transport": {"type": "tcp"},
                  "services": {"tcp": {"type": "tcp", "bind_addr": "0.0.0.0:8443"}, "udp": {"type": "udp", "bind_addr": "[::]:8444"}}}
        client = {"remote_addr": "192.0.2.10:2333", "default_token": "test-private-token", "transport": {"type": "tcp"},
                  "services": {"tcp": {"type": "tcp", "local_addr": "127.0.0.1:9443"}, "udp": {"type": "udp", "local_addr": "[::1]:9444"}}}
    else:
        server = {"bind_addr": "0.0.0.0:3080", "token": "test-private-token", "transport": "wssmux", "skip_optz": True,
                  "ports": ["8443=9443", "10000-10010=127.0.0.1:8443"], "sniffer": True, "web_port": 2060, "mux_recievebuffer": 4194304}
        client = {"remote_addr": "192.0.2.10:3080", "token": "test-private-token", "transport": "wssmux", "skip_optz": True, "edge_ip": "198.51.100.10"}
    return {"technology": component, "core": "official", "iran": {**copy.deepcopy(host), "options": server}, "foreign": {**copy.deepcopy(host), "options": client}}


def recipe(component):
    return {"schema": 1, "tunnelId": "native-test", "technology": component,
            "iran": {"serverId": "ir-test", "outerIp": "192.0.2.10"}, "foreign": {"serverId": "out-test", "outerIp": "198.51.100.10"}}


def binary(component, core, arch, root):
    data = bytearray(64); data[:7] = b"\x7fELF\x02\x01\x01"; data[16:18] = (2).to_bytes(2, "little"); data[18:20] = builder.MACHINES[arch].to_bytes(2, "little")
    file = root / (component + ".bin"); file.write_bytes(data)
    return file, "test-1", builder.digest(data)


class PanelForwarderTest(unittest.TestCase):
    def test_native_config_pair_credentials_restart_and_agent_lifecycle(self):
        for component in ("Rathole", "Backhaul"):
            with self.subTest(component=component), TemporaryDirectory() as folder, patch.object(panel, "release_binary", side_effect=binary):
                spec = settings(component)
                spec["iran"]["assets"] = [{"name": "identity.pem", "content": base64.b64encode(b"fixture-private-key").decode()}]
                pairs, enrollment = panel.build_panel_forwarder(recipe(component), spec, Path(folder))
                self.assertNotIn("test-private-token", json.dumps(enrollment))
                for side, profile in zip(builder.SIDES, enrollment["NODEGUARD_PROVISION_PROFILES"]):
                    files = {n: (data, mode) for n, data, mode in pairs[side][1]}
                    native = tomllib.loads(files["service.toml"][0].decode())
                    role = "server" if side == "iran" else "client"
                    self.assertEqual(set(native), {role})
                    self.assertEqual(files["service.toml"][1], 0o600)
                    self.assertIn(b"RuntimeMaxSec=1800", files["nodeguard-" + profile["id"] + ".service"][0])
                    if component == "Backhaul":
                        self.assertIn("/var/lib/nodeguard-", native[role]["sniffer_log"])
                    host = HostFixture()
                    for name, (data, _) in files.items():
                        host.data[worker.PROFILE_ROOT + "/" + profile["id"] + "/" + name] = data
                    job = {"id": str(uuid4()), "lease": "a" * 64, "profile": profile, "operation": "apply"}
                    worker.perform(host, job)
                    self.assertEqual(host.journal(job["id"])["result"]["status"], "succeeded")
                    for action, result in (("stop", "stopped"), ("start", "started"), ("restart", "restarted")):
                        control = {**job, "id": str(uuid4()), "rollbackOf": job["id"], "operation": action + "-service"}
                        worker.perform(host, control)
                        self.assertEqual(host.journal(control["id"])["result"], {"status": "succeeded", "detail": result})
                    changed = "/etc/systemd/system/nodeguard-" + profile["id"] + ".service"
                    original = host.data[changed]; host.data[changed] = b"external change"
                    control = {**job, "id": str(uuid4()), "rollbackOf": job["id"], "operation": "stop-service"}
                    worker.perform(host, control)
                    self.assertEqual(host.journal(control["id"])["result"]["detail"], "external_change")
                    host.data[changed] = original
                    remove = {**job, "id": str(uuid4()), "rollbackOf": job["id"], "operation": "remove"}
                    worker.perform(host, remove)
                    self.assertEqual(host.journal(remove["id"])["result"]["detail"], "removed")

    def test_toml_escapes_strings_and_tables(self):
        value = {"server": {"default_token": 'quote"\n[client]\nx="injection', "services": {"a.b": {"type": "tcp"}}}}
        self.assertEqual(tomllib.loads(panel.native_toml(value)), value)

    def test_rejects_pair_mismatch_and_path_assets(self):
        with TemporaryDirectory() as folder, patch.object(panel, "release_binary", side_effect=binary):
            for change in (lambda s: s["foreign"]["options"].update(default_token="wrong"),
                           lambda s: s["foreign"]["options"]["services"].pop("udp"),
                           lambda s: s["iran"]["assets"].append({"name": "../key", "content": "eA=="}),
                           lambda s: s["iran"]["options"]["transport"].update(tls={"pkcs12": "/root/key"})):
                spec = settings("Rathole"); change(spec)
                with self.assertRaises(ValueError): panel.build_panel_forwarder(recipe("Rathole"), spec, Path(folder))


if __name__ == "__main__":
    unittest.main()
