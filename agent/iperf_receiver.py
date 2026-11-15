#!/usr/bin/env python3
"""Fail closed before starting an iperf3 listener if its cgroup lacks IP filters."""

import argparse
import json
from pathlib import Path
import re
from shutil import which
import subprocess

UNIT = re.compile(r"nodeguard-iperf-rx-[a-f0-9]{24}\.service\Z")
SAFE_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"


def bpftool_path():
    path = which("bpftool", path=SAFE_PATH)
    if not path:
        raise ValueError("Install bpftool to verify the receiver's cgroup network filters")
    return path


def verify_filters(unit):
    if not UNIT.fullmatch(unit):
        raise ValueError("Expected a NodeGuard iperf receiver service")
    unified = next((line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines()
                    if line.startswith("0::")), None)
    if not unified or Path(unified).name != unit or ".." in Path(unified).parts:
        raise ValueError("The receiver must run in its own cgroup v2 service")
    cgroup = Path("/sys/fs/cgroup") / unified.lstrip("/")
    output = subprocess.check_output([bpftool_path(), "-j", "cgroup", "show", str(cgroup)], timeout=5)
    programs = json.loads(output)
    if not isinstance(programs, list):
        raise ValueError("Unexpected bpftool response")
    attached = {item["attach_type"] for item in programs if isinstance(item, dict)
                and isinstance(item.get("id"), int) and item["id"] > 0
                and isinstance(item.get("attach_type"), (int, str))}
    if not (attached & {0, "ingress", "cgroup_inet_ingress"}) or not (attached & {1, "egress", "cgroup_inet_egress"}):
        raise ValueError("Required ingress and egress IP filters are missing; the listener will stay closed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("unit")
    args = parser.parse_args()
    try:
        verify_filters(args.unit)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
