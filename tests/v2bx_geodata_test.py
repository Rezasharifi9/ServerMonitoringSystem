import base64
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import provision_worker as worker
geo = worker


def dataset(category):
    name = category.encode()
    entry = b"\x0a" + bytes([len(name)]) + name
    return b"\x0a" + bytes([len(entry)]) + entry


def spec():
    config = {"Nodes": [{}], "Cores": [{"Type": "xray"}]}
    route = {"rules": [{"ip": ["geoip:private"], "domain": ["geosite:google@ads"]}]}
    return {"files": {"/etc/nodeguard/components/lab/" + name: {
        "content": base64.b64encode(json.dumps(value).encode()).decode(), "mode": 0o600}
        for name, value in (("config.json", config), ("route.json", route))}}


class GeodataTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.host = worker.Host(Path(self.temp.name), owner=os.getuid() if hasattr(os, "getuid") else 0)
        if os.name == "nt":
            # Windows mode/uid bits do not model Linux ownership. Exercise the
            # real atomic IO here; Linux runs retain Host.trust checks.
            trust = patch.object(self.host, "trust", side_effect=lambda path, directory: path.lstat())
            trust.start()
            self.addCleanup(trust.stop)
        self.blobs = {"geoip.dat": dataset("private"), "geosite.dat": dataset("google")}
        assets = {name: (name, len(data), sha256(data).hexdigest()) for name, data in self.blobs.items()}
        self.asset_patch = patch.object(geo, "GEODATA_ASSETS", assets)
        self.asset_patch.start()
        self.addCleanup(self.asset_patch.stop)

    def download(self, request, **kwargs):
        data = self.blobs[request.full_url.rsplit("/", 1)[1]]
        response = BytesIO(data)
        response.geturl = lambda: request.full_url
        return response

    def test_downloads_verified_assets_before_config_exists(self):
        with patch.object(geo, "urlopen", side_effect=self.download) as download:
            geo.prepare_v2bx_geodata(self.host, spec())
        self.assertEqual(download.call_count, 2)
        for name, blob in self.blobs.items():
            self.assertEqual(self.host.read("/etc/V2bX/" + name), blob)
        self.assertFalse(self.host.path("/etc/nodeguard/components/lab/config.json").exists())
        with patch.object(geo, "urlopen", side_effect=AssertionError("must preserve existing data")):
            geo.prepare_v2bx_geodata(self.host, spec())

    def test_bad_second_download_does_not_install_first(self):
        self.blobs["geosite.dat"] = b"corrupt"
        with patch.object(geo, "urlopen", side_effect=self.download):
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                geo.prepare_v2bx_geodata(self.host, spec())
        self.assertFalse(self.host.path("/etc/V2bX/geoip.dat").exists())

    def test_incompatible_existing_data_is_preserved_and_rejected(self):
        blob = dataset("wrong")
        self.host.write("/etc/V2bX/geoip.dat", 0o644, lambda out: out.write(blob))
        with self.assertRaisesRegex(ValueError, "required categories"):
            geo.prepare_v2bx_geodata(self.host, spec())
        self.assertEqual(self.host.read("/etc/V2bX/geoip.dat"), blob)

    def test_other_cores_do_not_download(self):
        value = spec()
        path = "/etc/nodeguard/components/lab/config.json"
        value["files"][path]["content"] = base64.b64encode(json.dumps({"Nodes": [{}], "Cores": [{"Type": "sing"}]}).encode()).decode()
        with patch.object(geo, "urlopen") as download:
            geo.prepare_v2bx_geodata(self.host, value)
        download.assert_not_called()

    def test_invalid_download_aborts_before_baseline_or_service_changes(self):
        host = unittest.mock.Mock()
        job = {"id": "12345678-1234-1234-1234-123456789abc", "lease": "a" * 64,
               "profile": {"component": "V2bX"}, "operation": "apply"}
        with patch.object(worker, "bundle", return_value=spec()), \
                patch.object(worker, "prepare_v2bx_geodata", side_effect=ValueError("download failed")), \
                patch.object(worker, "baseline") as baseline, patch.object(worker, "apply") as apply:
            worker.perform(host, job)
        baseline.assert_not_called()
        apply.assert_not_called()
        host.call.assert_not_called()
        self.assertEqual(host.journal.call_args.args[1]["result"], {"status": "failed", "detail": "preflight"})


if __name__ == "__main__":
    unittest.main()
