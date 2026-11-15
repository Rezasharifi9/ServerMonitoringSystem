#!/usr/bin/env python3
"""Run bounded, explicitly enrolled iperf3 tasks for NodeGuard."""

import argparse
import ipaddress
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from agent_credentials import agent_token, read_explicit_token, telemetry_url
from nodeguard_agent import ID, NoRedirects


IPERF = "/usr/bin/iperf3"
NETWORKS = tuple(ipaddress.ip_network(network) for network in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7",
))
JOB_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
LEASE = re.compile(r"[a-f0-9]{64}\Z")


def private_ip(value):
    ip = ipaddress.ip_address(value)
    if "%" in value or not any(ip in network for network in NETWORKS):
        raise ValueError("Only registered private IPs are allowed")
    return str(ip)


def bounded_int(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def target_spec(item):
    for key in ("tunnelId", "receiverServerId"):
        if not ID.fullmatch(item[key]):
            raise ValueError("Invalid target ID")
    if not bounded_int(item["port"], 1024, 65535):
        raise ValueError("Invalid receiver port")
    source = private_ip(item["sourceIp"])
    peer = private_ip(item["peerIp"])
    if source == peer or ipaddress.ip_address(source).version != ipaddress.ip_address(peer).version:
        raise ValueError("Tunnel endpoints must be distinct and in the same address family")
    return {**item, "sourceIp": source, "peerIp": peer}


def iperf_args(job, targets):
    spec = job["config"]
    endpoint = job["endpoint"]
    enrolled = targets.get(spec["tunnelId"])
    if not enrolled or enrolled["receiverServerId"] != spec["destServerId"]:
        raise ValueError("Receiver is not enrolled on this worker")
    if (private_ip(endpoint["sourceIp"]) != enrolled["sourceIp"]
            or private_ip(endpoint["peerIp"]) != enrolled["peerIp"]
            or endpoint["port"] != enrolled["port"]):
        raise ValueError("Task target does not match local enrollment")
    if (spec["protocol"] not in ("tcp", "udp")
            or spec["direction"] not in ("upload", "download", "bidirectional")
            or not bounded_int(spec["durationSec"], 1, 30)
            or not bounded_int(spec["streams"], 1, 4)
            or not bounded_int(spec["bandwidthLimitMbps"], 1, 100)):
        raise ValueError("Test limits exceeded")

    lanes = spec["streams"] * (2 if spec["direction"] == "bidirectional" else 1)
    # iperf3's --bitrate applies per stream, not to their aggregate.
    rate = spec["bandwidthLimitMbps"] * 1_000_000 // lanes
    args = [
        IPERF, "--client", enrolled["peerIp"], "--bind", enrolled["sourceIp"],
        "--port", str(enrolled["port"]), "--json", "--time", str(spec["durationSec"]),
        "--parallel", str(spec["streams"]), "--bitrate", str(rate), "--connect-timeout", "3000",
    ]
    if spec["protocol"] == "udp":
        args.append("--udp")
    if spec["direction"] == "download":
        args.append("--reverse")
    elif spec["direction"] == "bidirectional":
        args.append("--bidir")
    return args


def finite(value, upper):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= upper:
        raise ValueError("Invalid metric")
    return value


def rates(report, direction, summary):
    primary = "sum_received" if summary else "sum"
    reverse = "sum_received_bidir_reverse" if summary else "sum_bidir_reverse"
    speed = lambda item: round(finite(item["bits_per_second"], 1_000_000_000) / 1_000_000, 3)
    if direction == "download":
        return {"downloadMbps": speed(report[primary])}
    result = {"uploadMbps": speed(report[primary])}
    if direction == "bidirectional":
        result["downloadMbps"] = speed(report[reverse])
    return result


def parse_result(raw, spec):
    data = json.loads(raw)
    if data.get("error"):
        raise ValueError("iperf3 returned an error")
    direction = spec["direction"]
    end = data["end"]
    result = rates(end, direction, True)
    result["samples"] = []
    last = 0
    for item in data["intervals"][:36]:
        if item["sum"].get("omitted"):
            continue
        t = round(finite(item["sum"]["end"], spec["durationSec"] + 5), 3)
        if t <= last:
            continue
        result["samples"].append({"t": t, **rates(item, direction, False)})
        last = t
    if spec["protocol"] == "udp":
        readings = [end["sum_received"]]
        if direction == "bidirectional":
            readings.append(end["sum_received_bidir_reverse"])
        for field, key, maximum in (("jitterMs", "jitter_ms", 30000), ("lossPct", "lost_percent", 100)):
            available = [finite(item[key], maximum) for item in readings if key in item]
            if available:
                result[field] = round(max(available), 3)
    return result


class Control:
    def __init__(self, endpoint, server_id, token, *, timeout=3):
        self.endpoint = endpoint
        self.server_id = server_id
        self.token = token
        self.opener = build_opener(NoRedirects())
        self.timeout = timeout

    def post(self, path, data, *, headers=None):
        body = json.dumps({"serverId": self.server_id, **data}, allow_nan=False).encode()
        request = Request(self.endpoint + path, data=body, method="POST", headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json", **(headers or {}),
        })
        with self.opener.open(request, timeout=self.timeout) as response:
            return json.loads(response.read(65537))["data"]

    def result(self, job, outcome):
        for _ in range(3):
            try:
                self.post(job["id"] + "/finish", {"lease": job["lease"], **outcome})
                return True
            except HTTPError as error:
                if error.code < 500:
                    return False
            except (URLError, TimeoutError, ValueError, KeyError):
                pass
            time.sleep(0.5)
        return False


def stop_process(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def failed(code):
    return {"outcome": "failed", "error": code}


def perform(control, job, targets, requested_at):
    try:
        if job["config"]["sourceServerId"] != control.server_id:
            return failed("target")
        args = iperf_args(job, targets)
    except (ValueError, KeyError, TypeError):
        return failed("target")

    try:
        if control.post(job["id"] + "/control", {"lease": job["lease"]})["stop"]:
            return {"outcome": "cancelled"}
    except (URLError, TimeoutError, ValueError, KeyError):
        return failed("lease")

    limit = job["config"]["durationSec"]
    hard_deadline = min(requested_at + job["leaseMs"] / 1000 - 2, time.monotonic() + limit + 6)
    if hard_deadline - time.monotonic() < limit + 2:
        return failed("lease")

    with tempfile.TemporaryFile() as output:
        try:
            child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                                     env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
        except OSError:
            return failed("launch")
        next_check = time.monotonic() + 0.2
        try:
            while child.poll() is None:
                now = time.monotonic()
                if now >= hard_deadline:
                    return failed("timeout")
                if now >= next_check:
                    try:
                        if control.post(job["id"] + "/control", {"lease": job["lease"]})["stop"]:
                            return {"outcome": "cancelled"}
                    except (URLError, TimeoutError, ValueError, KeyError):
                        return failed("lease")
                    next_check = time.monotonic() + 1.5
                time.sleep(0.2)
        finally:
            stop_process(child)

        if child.returncode:
            return failed("exit")
        try:
            output.seek(0)
            data = output.read(1_048_577)
            if len(data) > 1_048_576:
                return failed("output")
            return {"outcome": "completed", "result": parse_result(data, job["config"])}
        except (ValueError, KeyError, TypeError):
            return failed("output")


def configured_targets(config):
    targets = {}
    for item in config.get("iperfTargets", []):
        target = target_spec(item)
        key = target["tunnelId"]
        if key in targets:
            raise ValueError("Duplicate tunnel")
        targets[key] = target
    if not targets:
        raise ValueError("At least one iperfTargets entry is required")
    return targets


def settings():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--token-file", type=Path)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf8"))
        url = telemetry_url(config["endpoint"])
        if not ID.fullmatch(config["serverId"]):
            raise ValueError("Invalid server ID")
        token = read_explicit_token(args.token_file) if args.token_file else agent_token(config)
        targets = configured_targets(config)
        base = url._replace(path="/api/v1/agent/jobs/").geturl()
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    return args.once, Control(base, config["serverId"], token), targets


def main():
    once, control, targets = settings()
    while True:
        requested_at = time.monotonic()
        try:
            job = control.post("claim", {})
            if job:
                if (not JOB_ID.fullmatch(job["id"]) or not LEASE.fullmatch(job["lease"])
                        or not bounded_int(job["leaseMs"], 19000, 48000)):
                    raise ValueError("Invalid lease")
                outcome = perform(control, job, targets, requested_at)
                if not control.result(job, outcome):
                    print("Result delivery failed; the job will expire without re-execution", file=sys.stderr)
                    if once:
                        return 1
        except HTTPError as error:
            print(f"Job API HTTP {error.code}", file=sys.stderr)
            if once or error.code in (401, 403):
                return 1
        except (URLError, TimeoutError, ValueError, KeyError, TypeError):
            print("Job API unavailable or response invalid", file=sys.stderr)
            if once:
                return 1
        if once:
            return 0
        time.sleep(3)


if __name__ == "__main__":
    sys.exit(main())
