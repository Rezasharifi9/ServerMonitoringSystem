import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import iperf_worker as worker


TARGET = {
    "tunnelId": "tun-main", "receiverServerId": "exit-1",
    "sourceIp": "10.20.0.1", "peerIp": "10.20.0.2", "port": 5201,
}
JOB = {
    "id": "test", "lease": "token", "leaseMs": 19000, "endpoint": TARGET,
    "config": {
        "tunnelId": "tun-main", "sourceServerId": "ir-main", "destServerId": "exit-1",
        "protocol": "udp", "direction": "bidirectional", "durationSec": 1, "streams": 2,
        "bandwidthLimitMbps": 20,
    },
}
FIXTURE = {
    "intervals": [
        {"sum": {"end": 1, "bits_per_second": 6000000},
         "sum_bidir_reverse": {"bits_per_second": 8000000}},
    ],
    "end": {
        "sum_received": {"bits_per_second": 5000000, "jitter_ms": 0.7, "lost_percent": 0.3},
        "sum_received_bidir_reverse": {"bits_per_second": 8000000, "jitter_ms": 0.8, "lost_percent": 0.2},
    },
}


class ControlFixture:
    server_id = "ir-main"

    def __init__(self, stop):
        self.stop = stop

    def post(self, _path, _data):
        return {"stop": self.stop}


class IperfWorkerTest(unittest.TestCase):
    def test_aggregate_cap(self):
        args = worker.iperf_args(JOB, {"tun-main": TARGET})
        self.assertEqual(args[args.index("--bitrate") + 1], "5000000")
        self.assertIn("--bidir", args)
        self.assertIn("--udp", args)
        self.assertNotIn("--reverse", args)

    def test_local_target_lock(self):
        for address in ("10.20.0.7", "127.0.0.1", "8.8.8.8"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                worker.iperf_args({**JOB, "endpoint": {**TARGET, "peerIp": address}}, {"tun-main": TARGET})

    def test_udp_result(self):
        parsed = worker.parse_result(json.dumps(FIXTURE), JOB["config"])
        self.assertEqual(parsed["uploadMbps"], 5)
        self.assertEqual(parsed["downloadMbps"], 8)
        self.assertEqual(parsed["jitterMs"], 0.8)
        self.assertEqual(parsed["lossPct"], 0.3)
        self.assertEqual(parsed["samples"], [{"t": 1, "uploadMbps": 6, "downloadMbps": 8}])

    def test_reverse_result(self):
        spec = {**JOB["config"], "direction": "download", "protocol": "tcp"}
        parsed = worker.parse_result(json.dumps(FIXTURE), spec)
        self.assertEqual(parsed, {"downloadMbps": 5, "samples": [{"t": 1, "downloadMbps": 6}]})

    def test_worker_runs_subprocess_and_returns_result(self):
        fake_iperf = [sys.executable, "-c", "print(" + repr(json.dumps(FIXTURE)) + ")"]
        with patch.object(worker, "iperf_args", return_value=fake_iperf):
            result = worker.perform(ControlFixture(False), JOB, {}, time.monotonic())
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["result"]["downloadMbps"], 8)

    def test_worker_terminates_on_cancel(self):
        class CancelAfterStart(ControlFixture):
            checks = 0

            def post(self, _path, _data):
                self.checks += 1
                return {"stop": self.checks > 1}

        fake_iperf = [sys.executable, "-c", "import time; time.sleep(20)"]
        with patch.object(worker, "iperf_args", return_value=fake_iperf):
            result = worker.perform(CancelAfterStart(False), JOB, {}, time.monotonic())
        self.assertEqual(result, {"outcome": "cancelled"})


if __name__ == "__main__":
    unittest.main()
