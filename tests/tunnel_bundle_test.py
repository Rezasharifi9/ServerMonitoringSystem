import base64
import copy
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import build_tunnel_bundle as builder
import managed_link as link
import provision_worker as worker
from provision_worker_test import HostFixture


def recipe(technology="GRE"):
    return {
        "schema": 1, "tunnelId": "staging-link", "technology": technology, "mtu": 1400,
        "iran": {"serverId": "ir-test", "interfaceName": "ng-iran", "innerIp": "10.89.0.1", "outerIp": "192.0.2.10"},
        "foreign": {"serverId": "out-test", "interfaceName": "ng-out", "innerIp": "10.89.0.2", "outerIp": "198.51.100.10"},
    }


def files_for(pair):
    return {name: (data, mode) for name, data, mode in pair[1]}


def key(value):
    return base64.b64encode(bytes([value]) * 32).decode()


class InterfaceFixture:
    def __init__(self):
        self.interfaces = {}
        self.indices = {}
        self.calls = []
        self.fail_on = None
        self.listeners = {}

    def __call__(self, binary, *args):
        self.calls.append((binary, *args))
        if args == self.fail_on:
            raise ValueError("fixture failed")
        if args == ("-json", "link", "show"):
            return json.dumps([{"ifname": name, "ifalias": alias, "ifindex": self.indices.get(name, 1)}
                               for name, alias in self.interfaces.items()])
        if args == ("-details", "-json", "link", "show"):
            return "[]"
        if args == ("fou", "show"):
            return "\n".join(self.listeners.values())
        if args[:2] == ("fou", "add"):
            port = args[3]
            if port in self.listeners:
                raise ValueError("UDP port already in use")
            self.listeners[port] = " ".join(args[2:])
        if args[:2] == ("fou", "del"):
            del self.listeners[args[3]]
        if args[:3] == ("-json", "-6", "route"):
            return "[]"
        if args[:3] == ("link", "add", "name"):
            name = args[3]
            if name in self.interfaces:
                raise ValueError("already exists")
            self.interfaces[name] = None
            self.indices[name] = len(self.calls) + 1
        if args[:3] == ("link", "set", "dev") and args[4:5] == ("alias",):
            self.interfaces[args[3]] = args[5]
        if args[:3] == ("link", "delete", "dev"):
            del self.interfaces[args[3]]
        return ""


class TunnelBundleTest(unittest.TestCase):
    def test_native_gre_is_paired_without_udp_listener_and_changes_profile(self):
        pairs, enrollment = builder.bundle_pair({**recipe(), "greTransport": "native"})
        udp, _ = builder.bundle_pair({**recipe(), "greTransport": "udp"})
        for side in builder.SIDES:
            config = json.loads(files_for(pairs[side])["link.json"][0])
            self.assertNotIn("gre", config)
            self.assertNotEqual(pairs[side][0], udp[side][0])
            host = InterfaceFixture()
            link.configure(config, "up", Path("."), host)
            self.assertFalse(host.listeners)
            self.assertFalse(any("fou" in call for call in host.calls))
            link.configure(config, "down", Path("."), host)
            self.assertFalse(host.interfaces)
        self.assertTrue(all("Native GRE" in p["summary"] for p in enrollment["NODEGUARD_PROVISION_PROFILES"]))

    def test_invalid_gre_transport_is_rejected(self):
        for data in ({**recipe(), "greTransport": "invalid"}, {**recipe("SIT"), "greTransport": "native"}):
            with self.assertRaisesRegex(ValueError, "GRE transport"):
                builder.bundle_pair(data)

    def test_gre_udp_transport_is_paired_isolated_and_lifecycle_owned(self):
        pairs, _ = builder.bundle_pair(recipe())
        configs = [json.loads(files_for(pairs[side])["link.json"][0]) for side in builder.SIDES]
        self.assertEqual(configs[0]["gre"], configs[1]["gre"])
        other, _ = builder.bundle_pair({**recipe(), "tunnelId": "another-link"})
        self.assertNotEqual(configs[0]["gre"], json.loads(files_for(other["iran"])["link.json"][0])["gre"])
        config = configs[0]
        host = InterfaceFixture()
        link.configure(config, "up", Path("."), host)
        self.assertEqual(len(host.listeners), 1)
        create = next(call for call in host.calls if call[1:4] == ("link", "add", "name"))
        self.assertIn("fou", create)
        self.assertIn(str(config["gre"]["key"]), create)
        link.configure(config, "up", Path("."), host)
        self.assertEqual(len(host.listeners), 1)
        link.configure(config, "down", Path("."), host)
        self.assertFalse(host.listeners)
        self.assertFalse(host.interfaces)
        host.fail_on = ("link", "set", "dev", "ng-iran", "up")
        with self.assertRaises(ValueError):
            link.configure(config, "up", Path("."), host)
        self.assertFalse(host.listeners)
        self.assertFalse(host.interfaces)

    def test_gre_raw_legacy_and_foreign_listener_are_preserved(self):
        pairs, _ = builder.bundle_pair(recipe())
        config = json.loads(files_for(pairs["iran"])["link.json"][0])
        host = InterfaceFixture()
        port = str(config["gre"]["port"])
        host.listeners[port] = f"port {port} ipproto 47"
        with self.assertRaisesRegex(ValueError, "already in use"):
            link.configure(config, "up", Path("."), host)
        self.assertIn(port, host.listeners)
        self.assertFalse(host.interfaces)
        del config["gre"]
        link.configure(config, "up", Path("."), host)
        link.configure(config, "down", Path("."), host)
        self.assertIn(port, host.listeners)
        self.assertFalse(any("fou" in call for call in host.calls if "add" in call and "link" in call))

    def test_gre_udp_rejects_invalid_transport(self):
        pairs, _ = builder.bundle_pair(recipe())
        config = json.loads(files_for(pairs["iran"])["link.json"][0])
        for transport in ({"key": 0, "port": 1234}, {"key": 1, "port": 65536}, {"key": True, "port": 1234}):
            with self.assertRaisesRegex(ValueError, "GRE UDP"):
                link.link_config({**config, "gre": transport})

    def test_prune_replaces_only_old_managed_forwarding_for_the_same_port(self):
        pairs, _ = builder.bundle_pair({**recipe(), "port": 2083})
        config = json.loads(files_for(pairs["iran"])["link.json"][0])
        previous = "nodeguard:link-iran-" + "a" * 24
        def listing(_binary, *_args):
            if _args[-2:] != ("-S", "PREROUTING"):
                return ""
            prefix = "-A PREROUTING -d 192.0.2.10/32 -p tcp --dport "
            return "\n".join(f"{prefix}{port} -m comment --comment {owner} -j DNAT --to-destination 10.89.0.4:443"
                             for port, owner in [(2083, previous), (2033, previous), (2083, "manual")])
        with patch.object(link, "system_command", side_effect=listing) as command:
            link.prune_forward_rules(config)
        removals = [call.args for call in command.call_args_list if "-D" in call.args]
        self.assertEqual(len(removals), 1)
        self.assertIn(previous, removals[0])
        self.assertIn("2083", removals[0])

    def test_registered_port_packages_iptables_only_on_source(self):
        spec = {**recipe(), "port": 8443, "targetPort": 9443}
        pairs, enrollment = builder.bundle_pair(spec)
        changed, _ = builder.bundle_pair({**spec, "port": 8444})
        with self.assertRaisesRegex(ValueError, "forwarding ports"):
            builder.bundle_pair({**spec, "port": 65536})
        iran = files_for(pairs["iran"])
        self.assertNotIn("gost", iran)
        self.assertEqual(json.loads(iran["link.json"][0])["forward"], {"port": 8443, "targetPort": 9443})
        self.assertNotEqual(pairs["iran"][0], changed["iran"][0])
        self.assertEqual(pairs["foreign"], changed["foreign"])
        self.assertNotIn("forward", json.loads(files_for(pairs["foreign"])["link.json"][0]))
        self.assertEqual(enrollment["NODEGUARD_PROVISION_PROFILES"][0]["forwardPort"], 8443)
        self.assertEqual(enrollment["NODEGUARD_PROVISION_PROFILES"][0]["forwardTargetPort"], 9443)

    def test_iptables_rules_are_scoped_and_remove_only_exact_matches(self):
        pairs, _ = builder.bundle_pair({**recipe(), "port": 8443, "targetPort": 9443})
        config = json.loads(files_for(pairs["iran"])["link.json"][0])
        with patch.object(link.shutil, "which", return_value="/usr/sbin/iptables"), \
                patch.object(link.subprocess, "run") as probe, patch.object(link, "system_command") as command:
            probe.return_value.returncode = 1
            link.configure_forward(config, "up")
            inserted = [call.args for call in command.call_args_list[1:]]
            self.assertEqual(len(inserted), 5)
            self.assertTrue(all("-I" in item and "nodeguard:" + config["profileId"] in item for item in inserted))
            self.assertIn("192.0.2.10", inserted[0])
            self.assertIn("10.89.0.2:9443", inserted[0])
            command.reset_mock()
            probe.return_value.returncode = 0
            link.configure_forward(config, "down")
            self.assertEqual([call.args for call in command.call_args_list],
                             [tuple("-D" if value == "-I" else value for value in item) for item in inserted])

    def test_profile_digests_worker_apply_and_rollback_for_both_sides(self):
        spec = recipe()
        pairs, enrollment = builder.bundle_pair(spec)
        self.assertEqual(builder.bundle_pair(spec), (pairs, enrollment))
        registration = enrollment["NODEGUARD_TUNNEL_PROFILES"][0]
        self.assertEqual(registration["iranProfileId"], pairs["iran"][0])
        self.assertEqual(registration["foreignProfileId"], pairs["foreign"][0])
        for profile, side in zip(enrollment["NODEGUARD_PROVISION_PROFILES"], builder.SIDES):
            with self.subTest(side=side):
                host = HostFixture()
                folder = f"{worker.PROFILE_ROOT}/{profile['id']}/"
                files = files_for(pairs[side])
                for name, (data, _) in files.items():
                    host.data[folder + name] = data
                self.assertEqual(worker.sha(host.data[folder + "manifest.json"]), profile["sha256"])
                self.assertEqual(profile["serverId"], spec[side]["serverId"])
                apply = {"id": str(uuid4()), "profile": profile, "operation": "apply", "lease": "a" * 64}
                worker.perform(host, apply)
                self.assertEqual(host.journal(apply["id"])["result"]["detail"], "applied")
                self.assertTrue(host.active)
                rollback = {"id": str(uuid4()), "profile": profile, "operation": "rollback", "rollbackOf": apply["id"], "lease": "b" * 64}
                worker.perform(host, rollback)
                self.assertEqual(host.journal(rollback["id"])["result"]["detail"], "restored")
                self.assertFalse(host.active)
                self.assertTrue(all(name.startswith(folder) for name in host.data))

    def test_address_families_and_wireguard_secrets(self):
        for technology in ("GRE6", "SIT", "IPIP"):
            spec = recipe(technology)
            if technology in ("GRE6", "SIT"):
                spec["iran"]["innerIp"], spec["foreign"]["innerIp"] = "fd44::1", "fd44::2"
            if technology == "GRE6":
                spec["iran"]["outerIp"], spec["foreign"]["outerIp"] = "2001:db8:1::1", "2001:db8:2::1"
            pairs, _ = builder.bundle_pair(spec)
            config = json.loads(files_for(pairs["iran"])["link.json"][0])
            command = InterfaceFixture()
            link.configure(config, "up", Path("."), command)
            self.assertTrue(any(link.LINK_TYPES[technology] in args and "add" in args for args in command.calls))
            if technology in ("GRE6", "SIT"):
                self.assertIn(("ip", "-6", "route", "add", "fd44::2/128", "dev", config["interface"]), command.calls)

        spec = recipe("WireGuard")
        material = {"iran": (key(1), key(2), 51111), "foreign": (key(3), key(4), 52222)}
        pairs, enrollment = builder.bundle_pair(spec, material=material)
        iran = files_for(pairs["iran"])
        wireguard, mode = iran["wireguard.conf"]
        self.assertEqual(mode, 0o600)
        self.assertIn(key(1).encode(), wireguard)
        self.assertNotIn(key(3).encode(), wireguard)
        self.assertIn(f"PublicKey = {key(4)}".encode(), wireguard)
        self.assertIn(b"AllowedIPs = 10.89.0.2/32", wireguard)
        self.assertNotIn(key(1), json.dumps(enrollment))
        self.assertNotIn(key(1).encode(), iran["manifest.json"][0])
        with self.assertRaises(ValueError):
            builder.bundle_pair(spec, material={"iran": material["iran"], "foreign": (key(3), key(2), 52222)})

    def test_collision_and_partial_failure_preserve_other_interfaces(self):
        pairs, _ = builder.bundle_pair(recipe())
        config = json.loads(files_for(pairs["iran"])["link.json"][0])
        command = InterfaceFixture()
        command.interfaces = {"ng-iran": "external", "eth0": "physical"}
        for action in ("up", "down"):
            with self.assertRaisesRegex(ValueError, "another configuration"):
                link.configure(config, action, Path("."), command)
        self.assertEqual(command.interfaces, {"ng-iran": "external", "eth0": "physical"})
        del command.interfaces["ng-iran"]
        for failure in (("link", "set", "dev", "ng-iran", "up"),
                        ("link", "set", "dev", "ng-iran", "alias", "nodeguard:" + config["profileId"])):
            command.fail_on = failure
            with self.assertRaisesRegex(ValueError, "fixture failed"):
                link.configure(config, "up", Path("."), command)
            self.assertEqual(command.interfaces, {"eth0": "physical"})
        command.fail_on = None
        link.configure(config, "up", Path("."), command)
        link.configure(config, "down", Path("."), command)
        self.assertEqual(command.interfaces, {"eth0": "physical"})

    def test_cli_requires_review_of_missing_foreign_interface_and_exclusive_output(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            input_path, output = root / "recipe.json", root / "output"
            spec = recipe()
            spec["foreign"]["interfaceName"] = ""
            input_path.write_text(json.dumps(spec), encoding="utf8")
            args = [sys.executable, "-B", str(Path(builder.__file__)), str(input_path), str(output)]
            missing = subprocess.run(args, capture_output=True, check=False)
            self.assertNotEqual(missing.returncode, 0)
            self.assertFalse(output.exists())
            subprocess.run([*args, "--foreign-interface", "ng-out"], capture_output=True, check=True)
            saved = json.loads((output / "enrollment.json").read_text(encoding="utf8"))
            self.assertEqual(len(saved["NODEGUARD_PROVISION_PROFILES"]), 2)
            self.assertNotEqual(subprocess.run([*args, "--foreign-interface", "ng-out"], capture_output=True).returncode, 0)
            invalid = copy.deepcopy(spec)
            invalid["iran"]["innerIp"] = "224.0.0.1"
            with self.assertRaises(ValueError):
                builder.bundle_pair(invalid, "ng-out")


if __name__ == "__main__":
    unittest.main()
