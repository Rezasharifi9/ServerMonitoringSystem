import base64
import copy
import gzip
from io import BytesIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import provision_worker as worker


class HostFixture:
    def __init__(self):
        self.data = {}
        self.records = {}
        self.delivered = set()
        self.removed = []
        self.enabled = False
        self.active = False
        self.congestion = "cubic"
        self.fail_restart = False
        self.invocations = []

    def read(self, path, _limit=None):
        if path not in self.data:
            raise FileNotFoundError(path)
        return self.data[path]

    def write(self, path, mode, callback):
        stream = BytesIO()
        callback(stream)
        self.data[path] = stream.getvalue()

    pending_claim = worker.Host.pending_claim
    clear_pending_claim = worker.Host.clear_pending_claim

    def snapshot(self, path):
        return copy.deepcopy(self.data.get(path))

    def save(self, path, snapshot):
        if snapshot is None:
            self.data.pop(path, None)
        else:
            self.data[path] = copy.deepcopy(snapshot)

    def call(self, binary, *args, require=True):
        action = args[0]
        if binary == worker.SYSCTL:
            if action == "-w":
                self.congestion = args[1].split("=", 1)[1]
            elif args[1].endswith("available_congestion_control"):
                return "reno cubic bbr"
            return self.congestion
        if action == "is-enabled":
            return "enabled" if self.enabled else "disabled" if unit_path() in self.data else "not-found"
        if action == "is-active":
            return "active" if self.active else "inactive"
        if action == "show":
            if "--property=LoadState" in args:
                return "not-found"
            invocation = self.invocations.pop(0) if self.invocations else "a" * 32
            state = "active" if self.active else "inactive"
            return f"ActiveState={state}\nResult=success\nInvocationID={invocation}"
        if action == "enable":
            self.enabled = True
        if action == "disable":
            self.enabled = False
        if action == "stop":
            self.active = False
        if action in ("restart", "start"):
            if action == "restart" and self.fail_restart:
                raise ValueError("fixture restart failed")
            self.active = True
        return ""

    def journal(self, key, data=None):
        if data is None:
            return copy.deepcopy(self.records[key])
        self.records[key] = copy.deepcopy(data)

    def mark_delivered(self, key):
        self.delivered.add(key)

    def journals(self):
        return [key for key in self.records if key not in self.delivered]

    def remove_tree(self, path):
        self.removed.append(path)


def unit_path():
    return "/etc/systemd/system/nodeguard-lab.service"


def encoded_file(text, mode=0o600):
    return {"content": base64.b64encode(text.encode()).decode(), "mode": mode}


def removal_job():
    return {"id": str(uuid4()), "lease": "a" * 64, "operation": "remove-v2bx", "profile": {
        "id": "remove-v2bx", "serverId": "exit-1", "component": "V2bX", "version": "1", "sha256": "a" * 64,
        "v2bxNode": {"apiHost": "https://panel.example", "nodeId": 7, "nodeType": "vmess"},
    }}


def job_for(host, *, bbr=False, bad_target=None, component="V2bX"):
    profile = {"id": "lab", "component": "BBR" if bbr else component, "version": "1.0", "serverId": "exit-1"}
    manifest = {key: profile[key] for key in ("id", "component", "version")}
    if not bbr:
        artifact = b"[Service]\nExecStart=/bin/true\n"
        target = bad_target or unit_path()
        host.data[worker.PROFILE_ROOT + "/lab/lab.service"] = artifact
        manifest.update(unit="nodeguard-lab.service", files=[{
            "source": "lab.service", "target": target, "sha256": worker.sha(artifact), "mode": 0o644,
        }])
    data = json.dumps(manifest).encode()
    host.data[worker.PROFILE_ROOT + "/lab/manifest.json"] = data
    profile["sha256"] = worker.sha(data)
    return {"id": str(uuid4()), "lease": "a" * 64, "profile": profile, "operation": "apply"}


class ProvisionWorkerTest(unittest.TestCase):
    def test_v2bx_waits_for_nodes_after_core_and_certificate_setup(self):
        host = unittest.mock.Mock()
        invocation = "a" * 32
        host.call.side_effect = ["Core xray started", 'level=info msg="Nodes started"']
        with patch.object(worker, "active_invocation", return_value=invocation), patch.object(worker.time, "sleep") as sleep:
            worker.verify_v2bx_startup(host, "nodeguard-lab.service")
        sleep.assert_called_once_with(1)
        self.assertTrue(all("_SYSTEMD_INVOCATION_ID=" + invocation in call.args for call in host.call.call_args_list))

    def test_v2bx_certificate_failure_is_not_a_successful_install(self):
        host = unittest.mock.Mock()
        host.call.return_value = 'level=error msg="Run nodes failed" err="request cert error"'
        with patch.object(worker, "active_invocation", return_value="a" * 32):
            with self.assertRaisesRegex(ValueError, "certificate"):
                worker.verify_v2bx_startup(host, "nodeguard-lab.service")

    def test_v2bx_clean_exit_before_nodes_ready_is_rejected(self):
        host = unittest.mock.Mock()
        with patch.object(worker, "active_invocation", side_effect=["a" * 32, ValueError("Unit did not become active")]):
            with self.assertRaises(ValueError):
                worker.verify_v2bx_startup(host, "nodeguard-lab.service")

    def setUp(self):
        sleep = patch.object(worker.time, "sleep")
        self.sleep = sleep.start()
        self.addCleanup(sleep.stop)

    def test_lost_claim_response_is_retried_with_same_durable_id(self):
        host = HostFixture()
        template = job_for(host)
        claims, finished = [], []

        class ControlFixture:
            server_id = template["profile"]["serverId"]

            def post(self, path, body, **_kwargs):
                if path == "claim":
                    claims.append(body["claimId"])
                    if len(claims) == 1:
                        raise TimeoutError("Response lost after the server assigned the job")
                    return {**template, "lease": body["claimId"]}
                finished.append(body)

        with patch.object(worker, "apply", wraps=worker.apply) as apply:
            with self.assertRaises(TimeoutError):
                worker.poll_once(host, ControlFixture())
            apply.assert_not_called()
            pending = host.pending_claim()
            # A fresh Control instance models the process restarting with only
            # the host's durable files available.
            worker.poll_once(host, ControlFixture())
            apply.assert_called_once()
        self.assertEqual(claims, [pending, pending])
        self.assertNotIn(worker.CLAIM_PATH, host.data)
        self.assertEqual(len(finished), 1)
        self.assertEqual(finished[0]["status"], "succeeded")

    def test_finish_response_loss_does_not_execute_again(self):
        host = HostFixture()
        template = job_for(host)
        claim_ids, finish_calls = [], []

        class ControlFixture:
            server_id = template["profile"]["serverId"]

            def post(self, path, body, **_kwargs):
                if path == "claim":
                    claim_ids.append(body["claimId"])
                    return None if finish_calls else {**template, "lease": body["claimId"]}
                finish_calls.append(body)
                if len(finish_calls) == 1:
                    raise TimeoutError("Finish response lost")

        with patch.object(worker, "apply", wraps=worker.apply) as apply:
            with self.assertRaises(TimeoutError):
                worker.poll_once(host, ControlFixture())
            worker.poll_once(host, ControlFixture())
            apply.assert_called_once()
        self.assertEqual(claim_ids[0], claim_ids[1])
        self.assertEqual(finish_calls[0], finish_calls[1])
        self.assertNotIn(worker.CLAIM_PATH, host.data)

    def test_pending_claim_is_retired_when_queue_is_empty(self):
        host = HostFixture()
        control = SimpleNamespace(server_id="exit-1", post=unittest.mock.Mock(return_value=None))
        worker.poll_once(host, control)
        self.assertNotIn(worker.CLAIM_PATH, host.data)
        self.assertEqual(control.post.call_args.args[0], "claim")
        self.assertRegex(control.post.call_args.args[1]["claimId"], r"^[a-f0-9]{64}$")

    def test_corrupt_claim_is_not_replaced_or_sent(self):
        host = HostFixture()
        host.data[worker.CLAIM_PATH] = b'{"claimId":"broken"}'
        control = SimpleNamespace(server_id="exit-1", post=unittest.mock.Mock())
        with self.assertRaises(ValueError):
            worker.poll_once(host, control)
        control.post.assert_not_called()
        self.assertIn(worker.CLAIM_PATH, host.data)

    def test_provision_timeout_is_configurable_without_changing_iperf_default(self):
        from iperf_worker import Control
        self.assertEqual(Control("https://panel.example/", "exit-1", "a" * 64).timeout, 3)
        control = Control("https://panel.example/", "exit-1", "a" * 64, timeout=worker.PROVISION_REQUEST_TIMEOUT)
        response = BytesIO(b'{"data":null}')
        control.opener = SimpleNamespace(open=unittest.mock.Mock(return_value=response))
        control.post("claim", {})
        self.assertEqual(control.opener.open.call_args.kwargs["timeout"], 30)

    def test_systemd_apply_and_rollback(self):
        host = HostFixture()
        job = job_for(host)
        worker.perform(host, job)
        self.assertTrue(host.active and host.enabled)
        self.assertEqual(host.journal(job["id"])["result"]["detail"], "applied")
        rollback = {**job, "id": str(uuid4()), "operation": "rollback", "rollbackOf": job["id"]}
        worker.perform(host, rollback)
        self.assertFalse(host.active or host.enabled)
        self.assertIsNone(host.snapshot(unit_path()))
        self.assertEqual(host.journal(rollback["id"])["result"]["detail"], "restored")

    def test_retry_after_failed_unit_was_removed(self):
        host = HostFixture()
        job = job_for(host, component="GRE")
        original_call = host.call

        def call(binary, action, *args, **kwargs):
            if action == "is-active" and unit_path() not in host.data:
                return "failed"
            return original_call(binary, action, *args, **kwargs)

        with patch.object(host, "call", side_effect=call):
            worker.perform(host, job)
        self.assertEqual(host.journal(job["id"])["result"]["detail"], "applied")

    def test_artifact_retries_only_the_interrupted_range(self):
        def response(payload, content_range, *, compressed=False):
            result = BytesIO(gzip.compress(payload) if compressed else payload)
            result.status = 206
            result.headers = {"Content-Range": content_range}
            if compressed:
                result.headers["X-NodeGuard-Artifact-Encoding"] = "gzip"
            return result

        with patch.object(worker.time, "monotonic", return_value=0):
            opener = SimpleNamespace(open=unittest.mock.Mock(side_effect=[
                response(b"abc", "bytes 0-2/6"),
                TimeoutError(),
                response(b"def", "bytes 3-5/6", compressed=True),
            ]))
            control = SimpleNamespace(endpoint="https://panel.example/", token="token", server_id="iran", opener=opener)
            job = {"id": str(uuid4()), "lease": "a" * 64}
            self.assertEqual(worker.fetch_artifact(control, job, "gost", 6, 60), b"abcdef")
        self.assertEqual([json.loads(call.args[0].data)["offset"] for call in opener.open.call_args_list], [0, 3, 3])

    def test_v2bx_install_replaces_instead_of_attaching(self):
        host = HostFixture()
        job = job_for(host)
        with patch.object(worker, "attach_v2bx") as attach, patch.object(worker, "apply") as apply:
            worker.perform(host, job)
        attach.assert_not_called()
        apply.assert_called_once()
        self.assertEqual(host.journal(job["id"])["result"], {"status": "succeeded", "detail": "applied"})

    def test_listener_ports_exclude_remote_destinations(self):
        spec = {"files": {
            "/etc/test/forward.json": encoded_file(json.dumps({"forward": {"port": 443, "targetPort": 8443}})),
            "/etc/test/service.toml": encoded_file('[server]\nbind_addr="0.0.0.0:9000"\nports=["8000-8002=127.0.0.1:22"]'),
        }}
        self.assertEqual(worker.listener_ports(spec), {("tcp", p) for p in (443, 9000, 8000, 8001, 8002)})

    def test_native_listener_toml_on_python_without_tomllib(self):
        text = '["server"]\n"bind_addr" = "0.0.0.0:9000"\n["server"."services"."test.name"]\n"bind_addr" = "0.0.0.0:443"\n"type" = "tcp"\n'
        with patch.dict(sys.modules, {"tomllib": None}):
            config = worker.listener_toml(text)
        self.assertEqual(config["server"]["bind_addr"], "0.0.0.0:9000")
        self.assertEqual(config["server"]["services"]["test.name"]["bind_addr"], "0.0.0.0:443")

    def test_socket_owner_is_journaled_and_protected_ssh_is_rejected(self):
        host = unittest.mock.Mock()
        host.call.side_effect = [ 'LISTEN 0 128 *:443 *:* users:(("old",pid=123,fd=4))', "active", "enabled"]
        host.process_cgroup.return_value = "0::/system.slice/old.service\n"
        spec = {"bbr": False, "unit": "nodeguard-new.service", "files": {
            "/etc/test/forward.json": encoded_file('{"forward":{"port":443,"targetPort":8443}}')}}
        self.assertEqual(worker.replacement_services(host, spec, "GRE"), {"old.service": {"active": True, "enabled": True}})
        host.call.side_effect = ['LISTEN users:(("sshd",pid=123,fd=4))']
        host.process_cgroup.return_value = "0::/system.slice/ssh.service\n"
        with self.assertRaisesRegex(ValueError, "protected"):
            worker.replacement_services(host, spec, "GRE")

    def test_backhaul_does_not_replace_another_managed_tunnel(self):
        host = unittest.mock.Mock()
        unit = "nodeguard-svc-" + "a" * 24 + ".service"
        host.call.return_value = 'LISTEN users:(("service-bin",pid=123,fd=4))'
        host.process_cgroup.return_value = "0::/system.slice/" + unit + "\n"
        spec = {"bbr": False, "unit": "nodeguard-new.service", "files": {
            "/etc/test/service.toml": encoded_file('[server]\nbind_addr="0.0.0.0:3080"\nports=["2023"]')}}
        with self.assertRaises(worker.ListenerConflict):
            worker.replacement_services(host, spec, "Backhaul")
        self.assertFalse(any(call.args[1:2] == ("stop",) for call in host.call.call_args_list))

    @unittest.skipUnless(os.name == "posix", "Linux proc metadata")
    def test_dynamic_user_process_cgroup_does_not_weaken_config_checks(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "proc" / "123"
            folder.mkdir(parents=True)
            metadata = folder / "cgroup"
            metadata.write_text("0::/system.slice/test.service\n")
            folder.chmod(0o555)
            metadata.chmod(0o444)
            host = worker.Host(root, owner=root.stat().st_uid)
            # The kernel exposes metadata owned by the dynamic process UID.
            if os.getuid() == 0:
                os.chown(folder, 65534, 65534)
                os.chown(metadata, 65534, 65534)
                with self.assertRaises(ValueError):
                    host.read("/proc/123/cgroup")
            self.assertEqual(host.process_cgroup("123"), "0::/system.slice/test.service\n")
            with self.assertRaises(ValueError):
                host.process_cgroup("../123")

    def test_listener_collision_is_reported_before_mutation(self):
        host = HostFixture()
        job = job_for(host)
        with patch.object(worker, "replacement_services", side_effect=worker.ListenerConflict("occupied")), \
                patch.object(worker, "apply") as apply:
            worker.perform(host, job)
        apply.assert_not_called()
        self.assertEqual(host.journal(job["id"])["result"], {"status": "failed", "detail": "listener_conflict"})

    def test_failed_apply_restores_replaced_services(self):
        host = HostFixture()
        job = job_for(host)
        states = {"old.service": {"enabled": True, "active": True}}
        with patch.object(worker, "replacement_services", return_value=states), \
                patch.object(worker, "stop_replaced_services") as stop, \
                patch.object(worker, "restore_replaced_services") as restore, \
                patch.object(worker, "apply", side_effect=ValueError("failed")):
            worker.perform(host, job)
        stop.assert_called_once_with(host, states)
        restore.assert_called_once_with(host, states)
        self.assertEqual(host.journal(job["id"])["result"]["detail"], "reverted")

    def test_existing_v2bx_json_with_comments_and_trailing_commas(self):
        config = worker.parse_v2bx_config(b'''{/* custom */"Nodes":[{
          "ApiHost":"https://panel.example/", // host
          "ApiKey":"a//b", "NodeID":7, "NodeType":"V2ray",
        },],}''')
        self.assertEqual(worker.v2bx_identity(config["Nodes"][0]), ("https://panel.example", "a//b", 7, "vmess"))

    def test_v2bx_restart_deduplicates_alias_and_verifies_service(self):
        host = HostFixture()
        job = {**job_for(host), "operation": "restart-v2bx"}
        with TemporaryDirectory() as units:
            host.path = lambda path: Path(units)
            original_call = host.call

            def call(binary, action, *args, **kwargs):
                if action == "show" and args[0] == "--property=Id":
                    return "Id=V2bX.service\nLoadState=loaded"
                return original_call(binary, action, *args, **kwargs)

            with patch.object(host, "call", side_effect=call) as commands:
                worker.perform(host, job)
        restarts = [call.args[-1] for call in commands.call_args_list if call.args[1] == "restart"]
        self.assertEqual(restarts, ["V2bX.service"])
        self.assertEqual(host.journal(job["id"])["result"], {"status": "succeeded", "detail": "restarted"})

    def test_v2bx_reinstall_removes_and_reapplies_verified_files(self):
        host = HostFixture()
        original = job_for(host)
        unit = "nodeguard-svc-" + "a" * 24 + ".service"
        target = "/etc/systemd/system/" + unit
        saved = {"content": base64.b64encode(b"managed").decode(), "mode": 0o644}
        host.data[target] = saved
        host.journal(original["id"], {"profile": original["profile"], "operation": "apply",
            "result": {"detail": "applied"}, "spec": {"unit": unit, "files": {target: saved}}})
        job = {**original, "id": str(uuid4()), "operation": "restart-v2bx", "rollbackOf": original["id"]}
        with patch.object(worker, "v2bx_units", return_value={unit}), \
                patch.object(worker, "apply", side_effect=lambda *_: host.save(target, saved)), \
                patch.object(host, "save", wraps=host.save) as save:
            worker.perform(host, job)
        self.assertEqual([call.args for call in save.call_args_list], [(target, None), (target, saved)])
        self.assertEqual(host.journal(job["id"])["result"], {"status": "succeeded", "detail": "restarted"})

    def test_rebuilt_host_reinstalls_v2bx_from_panel_package(self):
        host = HostFixture()
        original = job_for(host)
        artifacts = dict(host.data)
        host.data.clear()
        job = {**original, "operation": "restart-v2bx", "rollbackOf": str(uuid4()), "download": True}
        journal = host.journal

        def read_journal(key, data=None):
            if data is None and key == job["rollbackOf"]:
                raise FileNotFoundError(key)
            return journal(key, data)

        def fetch(_control, _job, name, _limit, _deadline):
            return artifacts[worker.PROFILE_ROOT + "/lab/" + name]

        with patch.object(host, "journal", side_effect=read_journal), \
                patch.object(worker, "v2bx_units", return_value={"V2bX.service"}), \
                patch.object(worker, "fetch_artifact", side_effect=fetch):
            worker.perform(host, job)
        self.assertEqual(host.journal(job["id"])["result"], {"status": "succeeded", "detail": "applied"})
        self.assertTrue(host.active and host.enabled)

    def test_missing_journal_does_not_overwrite_existing_v2bx(self):
        host = HostFixture()
        original = job_for(host)
        job = {**original, "operation": "restart-v2bx", "rollbackOf": str(uuid4()), "download": True}
        journal = host.journal

        def read_journal(key, data=None):
            if data is None and key == job["rollbackOf"]:
                raise FileNotFoundError(key)
            return journal(key, data)

        with patch.object(host, "journal", side_effect=read_journal), \
                patch.object(worker, "v2bx_units", return_value={"V2bX.service"}), \
                patch.object(host, "call", return_value="loaded"), \
                patch.object(worker, "apply") as apply:
            worker.perform(host, job)
        apply.assert_not_called()
        self.assertEqual(host.journal(job["id"])["result"]["status"], "review")

    def test_v2bx_node_removal_keeps_the_other_node_and_drops_its_certificate(self):
        host = HostFixture()
        profile = "svc-" + "ab" * 12
        unit = "nodeguard-" + profile + ".service"
        config_path = "/etc/nodeguard/components/" + profile + "/config.json"
        kept = {"ApiHost": "https://panel.example/", "ApiKey": "other", "NodeID": 8, "NodeType": "vless", "Core": "sing"}
        removed = {"ApiHost": "https://panel.example", "ApiKey": "secret", "NodeID": 7, "NodeType": "V2ray", "Core": "xray",
                   "CertConfig": {"CertFile": "fullchain-vmess-7.pem", "KeyFile": "private-key-vmess-7.pem"}}
        host.data["/etc/systemd/system/" + unit] = (
            "[Service]\nLoadCredential=config.json:" + config_path + "\n"
            "ExecStart=/opt/nodeguard/components/" + profile + "/service-bin server -c /run/credentials/%n/config.json\n"
        ).encode()
        host.data[config_path] = encoded_file(json.dumps({"Cores": [{"Type": "xray"}, {"Type": "sing"}], "Nodes": [removed, kept]}))
        cert = "/etc/nodeguard/components/" + profile + "/fullchain-vmess-7.pem"
        state_cert = "/var/lib/nodeguard-" + profile + "/private-key-vmess-7.pem"
        host.data[cert] = encoded_file("cert")
        host.data[state_cert] = encoded_file("key")
        job = removal_job()
        with patch.object(worker, "installed_v2bx_units", return_value=[unit]):
            worker.perform(host, job)
        saved = json.loads(base64.b64decode(host.data[config_path]["content"]))
        self.assertEqual(saved["Nodes"], [kept])
        self.assertEqual(saved["Cores"], [{"Type": "sing"}])
        self.assertNotIn(cert, host.data)
        self.assertNotIn(state_cert, host.data)
        self.assertEqual(host.removed, [])
        self.assertEqual(host.journal(job["id"])["result"], {"status": "succeeded", "detail": "removed"})

    def test_v2bx_last_node_removal_preserves_core_and_unit(self):
        host = HostFixture()
        profile = "svc-" + "cd" * 12
        unit = "nodeguard-" + profile + ".service"
        config_path = "/etc/nodeguard/components/" + profile + "/config.json"
        host.data["/etc/systemd/system/" + unit] = ("[Service]\nLoadCredential=config.json:" + config_path + "\n").encode()
        host.data[config_path] = encoded_file(json.dumps({"Nodes": [
            {"ApiHost": "https://panel.example", "ApiKey": "secret", "NodeID": 7, "NodeType": "vmess"},
        ]}))
        job = removal_job()
        with patch.object(worker, "installed_v2bx_units", return_value=[unit]):
            worker.perform(host, job)
        self.assertEqual(host.removed, [])
        self.assertIn("/etc/systemd/system/" + unit, host.data)
        self.assertEqual(json.loads(base64.b64decode(host.data[config_path]["content"])), {"Nodes": []})
        self.assertFalse(host.active or host.enabled)
        self.assertEqual(host.journal(job["id"])["result"], {"status": "succeeded", "detail": "removed"})

    def test_stock_v2bx_removal_preserves_standard_installation(self):
        host = HostFixture()
        config_path = "/etc/V2bX/config.json"
        host.data["/etc/systemd/system/V2bX.service"] = b"[Service]\nExecStart=/usr/local/V2bX/V2bX server -c /etc/V2bX/config.json\n"
        host.data[config_path] = encoded_file(json.dumps({"Nodes": [
            {"ApiHost": "https://panel.example", "ApiKey": "secret", "NodeID": 7, "NodeType": "vmess"},
        ]}))
        job = removal_job()
        with patch.object(worker, "installed_v2bx_units", return_value=["V2bX.service"]):
            worker.perform(host, job)
        self.assertEqual(host.removed, [])
        self.assertIn("/etc/systemd/system/V2bX.service", host.data)
        self.assertEqual(json.loads(base64.b64decode(host.data[config_path]["content"]))["Nodes"], [])
        self.assertFalse(host.active or host.enabled)
        self.assertEqual(host.journal(job["id"])["result"], {"status": "succeeded", "detail": "removed"})

    def test_missing_v2bx_node_is_rejected_before_any_change(self):
        host = HostFixture()
        profile = "svc-" + "ef" * 12
        unit = "nodeguard-" + profile + ".service"
        config_path = "/etc/nodeguard/components/" + profile + "/config.json"
        host.data["/etc/systemd/system/" + unit] = ("[Service]\nLoadCredential=config.json:" + config_path + "\n").encode()
        original = encoded_file(json.dumps({"Nodes": [
            {"ApiHost": "https://panel.example", "ApiKey": "secret", "NodeID": 9, "NodeType": "vmess"},
        ]}))
        host.data[config_path] = original
        job = removal_job()
        with patch.object(worker, "installed_v2bx_units", return_value=[unit]):
            worker.perform(host, job)
        self.assertEqual(host.data[config_path], original)
        self.assertEqual(host.removed, [])
        self.assertEqual(host.journal(job["id"])["result"], {"status": "failed", "detail": "preflight"})

    def test_failed_v2bx_node_restart_restores_the_shared_configuration(self):
        host = HostFixture()
        profile = "svc-" + "ab" * 12
        unit = "nodeguard-" + profile + ".service"
        config_path = "/etc/nodeguard/components/" + profile + "/config.json"
        nodes = [
            {"ApiHost": "https://panel.example", "ApiKey": "secret", "NodeID": 7, "NodeType": "vmess", "Core": "xray"},
            {"ApiHost": "https://panel.example", "ApiKey": "other", "NodeID": 8, "NodeType": "vless", "Core": "xray"},
        ]
        host.data["/etc/systemd/system/" + unit] = ("[Service]\nLoadCredential=config.json:" + config_path + "\n").encode()
        original = encoded_file(json.dumps({"Cores": [{"Type": "xray"}], "Nodes": nodes}))
        host.data[config_path] = copy.deepcopy(original)
        job = removal_job()
        original_call = host.call
        restarts = {"count": 0}

        def call(*args, **kwargs):
            if len(args) > 1 and args[1] == "restart":
                restarts["count"] += 1
                if restarts["count"] == 1:
                    raise ValueError("fixture restart failed")
            return original_call(*args, **kwargs)

        with patch.object(worker, "installed_v2bx_units", return_value=[unit]), patch.object(host, "call", side_effect=call):
            worker.perform(host, job)
        self.assertEqual(json.loads(base64.b64decode(host.data[config_path]["content"])), json.loads(base64.b64decode(original["content"])))
        self.assertEqual(restarts["count"], 2)
        self.assertEqual(host.journal(job["id"])["result"], {"status": "failed", "detail": "restart_failed"})

    def test_link_verification_checks_bound_peer_and_gost_ports(self):
        host = HostFixture()
        job = {**job_for(host, component="GRE"), "download": True, "verify": True}
        def artifact(data):
            return {"content": base64.b64encode(json.dumps(data).encode()).decode()}
        spec = {"files": {
            "/test/link.json": artifact({"peerInner": "10.0.0.2", "interface": "gre1"}),
            "/test/gost.json": artifact({"services": [{"addr": ":443", "forwarder": {"nodes": [{"addr": "10.0.0.2:8443"}]}}]}),
        }}
        with patch.object(worker, "icmp_probe", return_value={"packetLoss": 0}) as icmp, \
                patch.object(worker, "tcp_probe", return_value={"ok": True}) as tcp:
            self.assertTrue(worker.verify_path(None, job, spec))
        icmp.assert_called_once_with("10.0.0.2", "gre1")
        self.assertEqual([call.args for call in tcp.call_args_list], [("10.0.0.2", 8443), ("127.0.0.1", 443)])

    def test_remove_clears_installed_service_and_can_be_retried(self):
        host = HostFixture()
        job = job_for(host, component="GRE")
        host.data[unit_path()] = {"content": base64.b64encode(b"prior version").decode(), "mode": 0o644}
        worker.perform(host, job)
        for _ in range(2):
            removal = {**job, "id": str(uuid4()), "operation": "remove", "rollbackOf": job["id"]}
            worker.perform(host, removal)
            self.assertEqual(host.journal(removal["id"])["result"], {"status": "succeeded", "detail": "removed"})
            self.assertFalse(host.active or host.enabled)
            self.assertIsNone(host.snapshot(unit_path()))
        self.assertIn(worker.PROFILE_ROOT + "/lab/manifest.json", host.data)

    def test_remove_preserves_changed_files_and_running_service(self):
        host = HostFixture()
        job = job_for(host, component="GRE")
        worker.perform(host, job)
        changed = {"content": base64.b64encode(b"externally changed unit").decode(), "mode": 0o644}
        host.data[unit_path()] = changed
        removal = {**job, "id": str(uuid4()), "operation": "remove", "rollbackOf": job["id"]}
        worker.perform(host, removal)
        self.assertEqual(host.journal(removal["id"])["result"], {"status": "review", "detail": "external_change"})
        self.assertEqual(host.snapshot(unit_path()), changed)
        self.assertTrue(host.active and host.enabled)

    def test_active_service_that_restarts_during_verification_is_reverted(self):
        host = HostFixture()
        host.invocations = ["a" * 32, "b" * 32]
        job = job_for(host)
        worker.perform(host, job)
        self.sleep.assert_called_once_with(worker.STARTUP_STABILITY_SECONDS)
        self.assertFalse(host.active or host.enabled)
        self.assertIsNone(host.snapshot(unit_path()))
        self.assertEqual(host.journal(job["id"])["result"], {"status": "failed", "detail": "reverted"})

    def test_install_failure_restores_prior_service(self):
        host = HostFixture()
        before = {"content": base64.b64encode(b"prior unit").decode(), "mode": 0o644}
        host.data[unit_path()] = before
        host.active = host.enabled = True
        host.fail_restart = True
        job = job_for(host)
        worker.perform(host, job)
        self.assertEqual(host.snapshot(unit_path()), before)
        self.assertTrue(host.active and host.enabled)
        self.assertEqual(host.journal(job["id"])["result"]["detail"], "reverted")

    def test_external_change_blocks_rollback(self):
        host = HostFixture()
        job = job_for(host, bbr=True)
        worker.perform(host, job)
        self.assertEqual(host.congestion, "bbr")
        foreign = {"content": base64.b64encode(b"external").decode(), "mode": 0o644}
        host.data[worker.BBR_PATH] = foreign
        rollback = {**job, "id": str(uuid4()), "operation": "rollback", "rollbackOf": job["id"]}
        worker.perform(host, rollback)
        self.assertEqual(host.snapshot(worker.BBR_PATH), foreign)
        self.assertEqual(host.journal(rollback["id"])["result"], {"status": "review", "detail": "external_change"})

    def test_bbr_rollback_restores_runtime_value(self):
        host = HostFixture()
        job = job_for(host, bbr=True)
        worker.perform(host, job)
        self.assertEqual(host.congestion, "bbr")
        rollback = {**job, "id": str(uuid4()), "operation": "rollback", "rollbackOf": job["id"]}
        worker.perform(host, rollback)
        self.assertEqual(host.congestion, "cubic")
        self.assertIsNone(host.snapshot(worker.BBR_PATH))
        self.assertEqual(host.journal(rollback["id"])["result"]["detail"], "restored")

    def test_digest_and_path_checks(self):
        host = HostFixture()
        job = job_for(host, bad_target="/etc/shadow")
        worker.perform(host, job)
        self.assertEqual(host.journal(job["id"])["result"]["detail"], "preflight")
        job = job_for(host)
        job["profile"]["sha256"] = "b" * 64
        worker.perform(host, job)
        self.assertEqual(host.journal(job["id"])["result"]["detail"], "preflight")
        self.assertIsNone(host.snapshot(unit_path()))

    @unittest.skipUnless(os.name == "posix", "Provision journals use POSIX file ownership")
    def test_delivered_journal_is_preserved_for_rollback_without_being_polled(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            host = worker.Host(root, owner=root.stat().st_uid)
            old_key, key = str(uuid4()), str(uuid4())
            host.journal(old_key, {"phase": "reported", "delivered": True, "spec": {"files": {}}})
            host.journal(key, {"phase": "reported", "lease": "a" * 64,
                               "result": {"status": "succeeded", "detail": "applied"}, "before": {"files": {}}})
            calls = []

            class ControlFixture:
                def post(self, path, body):
                    calls.append((path, body))

            worker.flush(host, ControlFixture())
            worker.flush(host, ControlFixture())
            self.assertEqual(host.journals(), [])
            self.assertEqual(calls, [(key + "/finish", {"lease": "a" * 64, "status": "succeeded", "detail": "applied"})])
            self.assertEqual(host.journal(old_key)["spec"], {"files": {}})
            self.assertEqual(host.journal(key)["before"], {"files": {}})

    def test_interrupted_job_is_reported_without_reexecution(self):
        host = HostFixture()
        job = job_for(host)
        host.journal(job["id"], {**job, "phase": "mutating"})
        calls = []
        class ControlFixture:
            def post(self, path, body):
                calls.append((path, body))
        worker.flush(host, ControlFixture())
        worker.flush(host, ControlFixture())
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["detail"], "interrupted")
        self.assertIsNone(host.snapshot(unit_path()))


if __name__ == "__main__":
    unittest.main()
