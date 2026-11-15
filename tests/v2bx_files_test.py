import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import v2bx_files as editor


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.journal = TemporaryDirectory()
        self.addCleanup(self.journal.cleanup)
        self.root = patch.object(editor, 'TRANSACTION_ROOT', Path(self.journal.name))
        self.root.start(); self.addCleanup(self.root.stop)
        self.runner = patch.object(editor.subprocess, 'run')
        self.runner.start(); self.addCleanup(self.runner.stop)

    def test_replace_and_delete_restart_active_only(self):
        with TemporaryDirectory() as folder:
            config = Path(folder) / "config.json"
            route = Path(folder) / "route.json"
            outbound = Path(folder) / "custom_outbound.json"
            config.write_bytes(b"old config")
            outbound.write_bytes(b"old outbound")
            operations = [("a.service", True, {config: b"new config", route: b"new route", outbound: None}), ("b.service", False, {})]
            with patch.object(editor, "plans", return_value=operations), patch.object(editor, "call") as call, patch.object(editor.time, "sleep"):
                editor.apply({})
            self.assertEqual(config.read_bytes(), b"new config")
            self.assertEqual(route.read_bytes(), b"new route")
            self.assertFalse(outbound.exists())
            self.assertIn(unittest.mock.call("restart", "--", "a.service"), call.call_args_list)
            self.assertNotIn(unittest.mock.call("restart", "--", "b.service"), call.call_args_list)

    def test_restart_failure_restores_all_files(self):
        with TemporaryDirectory() as folder:
            config = Path(folder) / "config.json"
            route = Path(folder) / "route.json"
            config.write_bytes(b"original")
            operations = [("a.service", True, {config: b"replacement", route: b"new"})]
            failed = False
            def call(*args):
                nonlocal failed
                if args[0] == "is-active" and not failed:
                    failed = True
                    raise subprocess.CalledProcessError(1, "systemctl")
            with patch.object(editor, "plans", return_value=operations), patch.object(editor, "call", side_effect=call), patch.object(editor.time, "sleep"):
                with self.assertRaises(subprocess.CalledProcessError):
                    editor.apply({})
            self.assertEqual(config.read_bytes(), b"original")
            self.assertFalse(route.exists())

    def test_jsonc_preserves_urls(self):
        self.assertEqual(editor.parse(b'{/*note*/"url":"https://example.com", "rules":[],}'), {"url": "https://example.com", "rules": []})

    def test_global_apply_restarts_stopped_services_too(self):
        operations = [("active.service", True, {}), ("stopped.service", False, {})]
        with patch.object(editor, "plans", return_value=operations), patch.object(editor, "call") as call, patch.object(editor.time, "sleep"):
            editor.apply({}, restart_stopped=True)
        for unit in ("active.service", "stopped.service"):
            self.assertIn(unittest.mock.call("restart", "--", unit), call.call_args_list)
            self.assertIn(unittest.mock.call("is-active", "--quiet", "--", unit), call.call_args_list)

    def test_failed_global_apply_restores_stopped_service_state(self):
        operations = [("stopped.service", False, {})]
        def call(*args):
            if args[0] == "is-active":
                raise subprocess.CalledProcessError(1, "systemctl")
        with patch.object(editor, "plans", return_value=operations), patch.object(editor, "call", side_effect=call) as systemctl, patch.object(editor.time, "sleep"):
            with self.assertRaises(subprocess.CalledProcessError):
                editor.apply({}, restart_stopped=True)
        self.assertIn(unittest.mock.call("stop", "--", "stopped.service"), systemctl.call_args_list)

    def test_watchdog_must_arm_before_configuration_changes(self):
        with TemporaryDirectory() as folder:
            config = Path(folder) / 'config.json'; config.write_bytes(b'original')
            with patch.object(editor, 'plans', return_value=[('a.service', True, {config: b'new'})]), \
                 patch.object(editor, 'call'), \
                 patch.object(editor.subprocess, 'run', side_effect=OSError('watchdog unavailable')):
                with self.assertRaises(OSError):editor.apply({})
            self.assertEqual(config.read_bytes(), b'original')

    def test_active_service_without_original_listener_rolls_back(self):
        with TemporaryDirectory() as folder:
            config = Path(folder) / 'config.json'; config.write_bytes(b'original')
            def ports(unit, run):return [443] if config.read_bytes()==b'original' else []
            with patch.object(editor, 'plans', return_value=[('a.service', True, {config: b'new'})]), \
                 patch.object(editor, 'call'), patch.dict(editor._recovery, {'listening': ports}), \
                 patch.object(editor.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, 'listening ports'):editor.apply({})
            self.assertEqual(config.read_bytes(), b'original')
            state=json.loads(next(Path(self.journal.name).glob('*/state.json')).read_text())
            self.assertEqual(state['phase'],'rolled_back')

    def test_late_crash_after_first_active_check_rolls_back(self):
        with TemporaryDirectory() as folder:
            config=Path(folder)/'config.json'; config.write_bytes(b'original');checks=0
            def call(*args):
                nonlocal checks
                if args[0]=='is-active':
                    checks+=1
                    if checks==2:raise subprocess.CalledProcessError(1,'systemctl')
            with patch.object(editor,'plans',return_value=[('a.service',True,{config:b'new'})]), \
                 patch.object(editor,'call',side_effect=call),patch.object(editor.time,'sleep'):
                with self.assertRaises(subprocess.CalledProcessError):editor.apply({})
            self.assertEqual(config.read_bytes(),b'original')

    def test_recovery_failure_does_not_skip_other_services(self):
        operations=[('a.service',True,{}),('b.service',True,{})];restarts=0
        def call(*args):
            nonlocal restarts
            if args[0]=='restart' and args[-1]=='a.service':
                restarts+=1
                if restarts>1:raise subprocess.CalledProcessError(1,'systemctl')
            if args[0]=='is-active' and args[-1]=='a.service':raise subprocess.CalledProcessError(1,'systemctl')
        with patch.object(editor,'plans',return_value=operations),patch.object(editor,'call',side_effect=call) as ctl,patch.object(editor.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'service restoration failed'):editor.apply({})
        self.assertIn(unittest.mock.call('restart','--','b.service'),ctl.call_args_list)
        state=json.loads(next(Path(self.journal.name).glob('*/state.json')).read_text())
        self.assertEqual(state['phase'],'rolling_back')

    def test_interrupted_worker_restores_configuration(self):
        with TemporaryDirectory() as folder:
            config=Path(folder)/'config.json';config.write_bytes(b'original');original=editor.atomic
            def write(path,data,mode=0o600):
                original(path,data,mode)
                if path==config and data==b'new':raise KeyboardInterrupt()
            with patch.object(editor,'plans',return_value=[('a.service',True,{config:b'new'})]), \
                 patch.object(editor,'call'),patch.object(editor,'atomic',side_effect=write),patch.object(editor.time,'sleep'):
                with self.assertRaises(KeyboardInterrupt):editor.apply({})
            self.assertEqual(config.read_bytes(),b'original')

    def test_missing_geodata_is_rejected_before_restart(self):
        with TemporaryDirectory() as folder:
            unit='Environment="XRAY_LOCATION_ASSET='+folder+'"'
            files={'route':json.dumps({'rules':[{'ip':['geoip:private']}]}),'outbound':None}
            with self.assertRaisesRegex(FileNotFoundError,'geoip.dat'):editor.require_assets(files,unit)
            (Path(folder)/'geoip.dat').write_bytes(b'data')
            editor.require_assets(files,unit)

    def test_inactive_unloaded_unit_is_restarted_when_reset_failed_returns_error(self):
        def run(*args):
            if args[0]=='reset-failed':raise subprocess.CalledProcessError(1,'systemctl')
        ctl=unittest.mock.Mock(side_effect=run)
        editor._recovery['restore']({'files':{},'units':[{'name':'a.service','active':True,'ports':[]}],
                                    'restartStopped':False},ctl,lambda _:None)
        self.assertIn(unittest.mock.call('restart','--','a.service'),ctl.call_args_list)


if __name__ == "__main__":
    unittest.main()
