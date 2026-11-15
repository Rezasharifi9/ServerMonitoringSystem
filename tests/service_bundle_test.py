import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import build_service_bundle as builder
import provision_worker as worker
from provision_worker_test import HostFixture


class ServiceBundleTest(unittest.TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)

    def entry(self, name, config, arch="amd64"):
        binary = bytearray(64)
        binary[:7] = b"\x7fELF\x02\x01\x01"
        binary[16:18] = (2).to_bytes(2, "little")
        binary[18:20] = builder.MACHINES[arch].to_bytes(2, "little")
        binary_file = self.root / (name + ".elf")
        binary_file.write_bytes(binary)
        config_file = self.root / (name + ".config")
        config_file.write_text(config, encoding="utf8")
        return {"architecture": arch, "version": "v1.0", "binaryFile": binary_file.name,
                "binarySha256": builder.digest(binary), "configFile": config_file.name}

    @staticmethod
    def recipe(component):
        return {
            "schema": 1, "tunnelId": "forward-test", "technology": component,
            "iran": {"serverId": "ir-1", "outerIp": "192.0.2.10"},
            "foreign": {"serverId": "out-1", "outerIp": "198.51.100.10"},
        }

    def validate_worker_contract(self, pair, profile):
        identifier, files = pair
        host = HostFixture()
        prefix = f"{worker.PROFILE_ROOT}/{identifier}/"
        for name, data, _ in files:
            host.data[prefix + name] = data
        self.assertEqual(worker.sha(host.data[prefix + "manifest.json"]), profile["sha256"])
        apply = {"id": str(uuid4()), "profile": profile, "operation": "apply", "lease": "a" * 64}
        worker.perform(host, apply)
        self.assertEqual(host.journal(apply["id"])["result"]["detail"], "applied")
        rollback = {"id": str(uuid4()), "profile": profile, "operation": "rollback",
                    "rollbackOf": apply["id"], "lease": "b" * 64}
        worker.perform(host, rollback)
        self.assertEqual(host.journal(rollback["id"])["result"]["detail"], "restored")

    def test_forwarders_package_native_commands_and_private_assets(self):
        cases = {
            "GOST": ('{"services":[{"name":"reviewed"}]}', '{"services":[{"name":"peer"}]}', "-C"),
            "Backhaul": ('[server]\nskip_optz=true\ntoken="private-test"\n', "[client]\nskip_optz=true\n", "-c"),
            "Rathole": ('[server]\ndefault_token="private-test"\n', "[client]\n", "--server"),
        }
        certificate = b"test certificate"
        (self.root / "cert.pem").write_bytes(certificate)
        for component, (iran, foreign, arguments) in cases.items():
            with self.subTest(component=component):
                entry = self.entry("iran", iran)
                entry["assets"] = [{"name": "cert.pem", "file": "cert.pem", "sha256": builder.digest(certificate)}]
                inputs = {"iran": entry, "foreign": self.entry("foreign", foreign, "arm64")}
                recipe = self.recipe(component)
                pairs, enrollment = builder.build_forwarder(recipe, inputs, self.root)
                self.assertEqual(builder.build_forwarder(recipe, inputs, self.root), (pairs, enrollment))
                self.assertNotIn("private-test", json.dumps(enrollment))
                for side, profile in zip(builder.SIDES, enrollment["NODEGUARD_PROVISION_PROFILES"]):
                    self.assertEqual(profile["serverId"], recipe[side]["serverId"])
                    files = {name: (data, mode) for name, data, mode in pairs[side][1]}
                    unit = files[f"nodeguard-{profile['id']}.service"][0].decode()
                    flag = "--client" if component == "Rathole" and side == "foreign" else arguments
                    self.assertIn("service-bin " + flag + " /run/credentials/%n/service.", unit)
                    self.assertIn("DynamicUser=yes", unit)
                    self.assertNotIn("private-test", unit)
                    self.assertIn("ConditionArchitecture=" + ("x86-64" if side == "iran" else "arm64"), unit)
                    self.assertEqual(files["service-bin"][1], 0o755)
                    if side == "iran":
                        self.assertEqual(files["cert.pem"], (certificate, 0o600))
                    self.validate_worker_contract(pairs[side], profile)

    def test_v2bx_cli_and_rejects_unapproved_input(self):
        approved = self.entry("v2bx", '{"Cores":[],"Nodes":[{"ApiKey":"secret-key"}]}')
        for override, message in (
            ({"architecture": "arm64"}, "architecture"),
            ({"binarySha256": "a" * 64}, "digest"),
            ({"assets": [{"name": "../secret", "file": "x", "sha256": "b" * 64}]}, "credential name"),
        ):
            with self.assertRaisesRegex(ValueError, message):
                builder.build_profile("V2bX", "host", "out-1", {**approved, **override}, self.root)
        with self.assertRaisesRegex(ValueError, "skip_optz"):
            builder.build_profile("Backhaul", "iran", "ir-1", self.entry("unsafe", "[server]\n"), self.root)
        with self.assertRaisesRegex(ValueError, "foreign config"):
            builder.build_profile("Rathole", "foreign", "out-1", self.entry("wrong-role", "[server]\n"), self.root)

        inputs, output = self.root / "inputs.json", self.root / "packed"
        inputs.write_text(json.dumps(approved), encoding="utf8")
        subprocess.run([sys.executable, "-B", str(Path(builder.__file__)), "v2bx", "out-1", str(inputs), str(output)],
                       check=True, capture_output=True)
        enrollment = (output / "enrollment.json").read_text(encoding="utf8")
        self.assertNotIn("secret-key", enrollment)
        profile = json.loads(enrollment)["NODEGUARD_PROVISION_PROFILES"][0]
        service = output / "host" / profile["id"] / f"nodeguard-{profile['id']}.service"
        self.assertIn("service-bin server -c /run/credentials/%n/service.json", service.read_text(encoding="utf8"))

    def test_v2bx_auxiliary_files_use_credentials_and_preserve_certificates(self):
        config = {"Cores": [{"Type": "xray"}], "Nodes": [{"CertConfig": {"CertMode": "self", "CertFile": "cert.pem", "KeyFile": "key.pem"}}]}
        entry = self.entry("auxiliary", json.dumps(config))
        entry["assets"] = []
        for name, data in (("route.json", b'{"rules":[]}'), ("custom_outbound.json", b'[{"tag":"direct","protocol":"freedom"}]')):
            (self.root / name).write_bytes(data)
            entry["assets"].append({"name": name, "file": name, "sha256": builder.digest(data)})
        pair, profile = builder.build_profile("V2bX", "host", "out-1", entry, self.root, True)
        files = {name: data for name, data, _ in pair[1]}
        actual = json.loads(files["config.json"])
        for key, name in (("RouteConfigPath", "route.json"), ("OutboundConfigPath", "custom_outbound.json")):
            self.assertEqual(actual["Cores"][0][key], f"/run/credentials/nodeguard-{profile['id']}.service/{name}")
            self.assertIn(f"LoadCredential={name}:", files[f"nodeguard-{profile['id']}.service"].decode())
        self.assertEqual(actual["Nodes"][0]["CertConfig"]["CertFile"], f"/var/lib/nodeguard-{profile['id']}/cert.pem")
        config["Cores"] = [{"Type": "sing"}]
        (self.root / entry["configFile"]).write_text(json.dumps(config), encoding="utf8")
        with self.assertRaisesRegex(ValueError, "Xray"):
            builder.build_profile("V2bX", "host", "out-1", entry, self.root)

    def test_managed_v2bx_uses_absolute_writable_certificate_paths(self):
        for mode in ("http", "self", "dns"):
            config = {"Nodes": [{"CertConfig": {"CertMode": mode,
                      "CertFile": "fullchain.pem", "KeyFile": "private-key.pem"}}]}
            entry = self.entry("tls", json.dumps(config))
            package, profile = builder.build_profile("V2bX", "host", "out-1", entry, self.root, True)
            self.assertEqual(builder.build_profile("V2bX", "host", "out-1", entry, self.root, True), (package, profile))
            files = {name: data for name, data, _ in package[1]}
            state = "/var/lib/nodeguard-" + profile["id"]
            cert = json.loads(files["config.json"])["Nodes"][0]["CertConfig"]
            self.assertEqual(cert["CertFile"], state + "/fullchain.pem")
            self.assertEqual(cert["KeyFile"], state + "/private-key.pem")
            self.assertIn("WorkingDirectory=" + state, files["nodeguard-" + profile["id"] + ".service"].decode())
            path = "/etc/nodeguard/components/" + profile["id"] + "/config.json"
            self.assertEqual(set(worker.removed_cert_files(path, [{"CertConfig": cert}], [])),
                             {cert["CertFile"], cert["KeyFile"]})
            self.assertEqual(worker.removed_cert_files(path, [{"CertConfig": cert}], [{"CertConfig": cert}]), [])


if __name__ == "__main__":
    unittest.main()
