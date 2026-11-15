import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import iperf_receiver as receiver


class IperfReceiverFilterTest(unittest.TestCase):
    def setUp(self):
        self.unit = "nodeguard-iperf-rx-" + "a" * 24 + ".service"
        self.cgroup = "/system.slice/" + self.unit

    def test_requires_ingress_and_egress_in_the_service_cgroup(self):
        programs = [{"id": 1, "attach_type": "cgroup_inet_ingress"}, {"id": 2, "attach_type": "cgroup_inet_egress"}]
        with patch.object(Path, "read_text", return_value="0::" + self.cgroup), \
                patch.object(receiver, "bpftool_path", return_value="/usr/sbin/bpftool"), \
                patch.object(subprocess, "check_output", return_value=json.dumps(programs)) as call:
            receiver.verify_filters(self.unit)
        call.assert_called_once_with(
            ["/usr/sbin/bpftool", "-j", "cgroup", "show", str(Path("/sys/fs/cgroup") / self.cgroup.lstrip("/"))],
            timeout=5,
        )

    def test_refuses_missing_filter_or_wrong_cgroup(self):
        with patch.object(Path, "read_text", return_value="0::" + self.cgroup), \
                patch.object(receiver, "bpftool_path", return_value="/usr/sbin/bpftool"), \
                patch.object(subprocess, "check_output", return_value='[{"id":1,"attach_type":0}]'):
            with self.assertRaisesRegex(ValueError, "will stay closed"):
                receiver.verify_filters(self.unit)
        with patch.object(Path, "read_text", return_value="0::/system.slice/other.service"), \
                patch.object(subprocess, "check_output") as call:
            with self.assertRaisesRegex(ValueError, "own cgroup"):
                receiver.verify_filters(self.unit)
        call.assert_not_called()
