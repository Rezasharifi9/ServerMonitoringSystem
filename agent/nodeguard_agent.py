#!/usr/bin/env python3
"""Read-only Linux reporter for the NodeGuard v1 telemetry API."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import ipaddress
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
from threading import Event, Lock, Thread
import time
try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None  # Python 3.8–3.10 have no standard-library TOML parser.
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

from agent_credentials import agent_token, read_explicit_token, telemetry_url


SEVERITIES = ("CRITICAL", "CRITICAL", "CRITICAL", "ERROR", "WARNING", "INFO", "INFO", "DEBUG")
ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}\Z")
INTERFACE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,14}\Z")
UNIT = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,100}\.service\Z")
MANAGED_SERVICE = re.compile(r"nodeguard-(svc-[a-f0-9]{24})\.service\Z")
SYSTEM_UNITS = Path("/etc/systemd/system")
SYSTEM_SLICE = Path("/sys/fs/cgroup/system.slice")


def iso_time(epoch=None):
    return dt.datetime.fromtimestamp(epoch if epoch is not None else time.time(), dt.timezone.utc).isoformat(timespec="milliseconds")


def percent(used, total):
    return round(100 * used / total, 2) if total else 0


def safe_command(binary, arguments, timeout):
    try:
        return subprocess.run(
            [binary, *arguments], capture_output=True, text=True, errors="replace",
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def cpu_ticks():
    fields = [int(field) for field in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
    return sum(fields) - fields[3] - fields[4], sum(fields)


def memory():
    fields = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    total, available = (int(fields[key].split()[0]) for key in ("MemTotal", "MemAvailable"))
    return percent(total - available, total), total * 1024


def disk():
    usage = os.statvfs("/")
    return percent(usage.f_blocks - usage.f_bavail, usage.f_blocks), usage.f_blocks * usage.f_frsize


def disk_counters():
    counters = {}
    for device in Path("/sys/block").glob("*"):
        if device.name.startswith(("loop", "ram", "zram")):
            continue
        try:
            if any((device / "slaves").iterdir()):
                continue  # Count I/O on backing devices only.
            fields = (device / "stat").read_text().split()
            counters[device.name] = (int(fields[2]) * 512, int(fields[6]) * 512)
        except (OSError, ValueError, IndexError):
            continue
    return counters


def disk_rates(previous, current, elapsed):
    read = write = 0
    measured = False
    for device in previous.keys() & current.keys():
        old_read, old_write = previous[device]
        new_read, new_write = current[device]
        if new_read >= old_read and new_write >= old_write:
            read += new_read - old_read
            write += new_write - old_write
            measured = True
    if measured:
        return {"readMiBps": round(read / elapsed / 1024**2, 3), "writeMiBps": round(write / elapsed / 1024**2, 3)}
    return None


def interface_state(interface):
    directory = Path("/sys/class/net") / interface
    counters = tuple(int((directory / "statistics" / name).read_text()) for name in ("rx_bytes", "tx_bytes"))
    up = bool(int((directory / "flags").read_text(), 16) & 1)
    return counters, int((directory / "mtu").read_text()), up


def icmp_probe(peer, interface=None):
    arguments = ["-n", "-q", "-c", "3", "-W", "1", "-w", "4"]
    if interface:
        arguments.extend(["-I", interface])
    reply = safe_command("/usr/bin/ping", [*arguments, "--", peer], 5)
    if reply is None or reply.returncode > 1:
        return None
    loss = re.search(r"([\d.]+)% packet loss", reply.stdout)
    delay = re.search(r"= [\d.]+/([\d.]+)/[\d.]+/([\d.]+) ms", reply.stdout)
    if not loss:
        return None
    return {"rttMs": float(delay[1]) if delay else None, "jitterMs": float(delay[2]) if delay else None,
            "packetLoss": float(loss[1])}


PROBE_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
PING_ATTEMPTS = 10
_batch_guard = Lock()
_batch_thread = None


def probe_ip(value):
    if not isinstance(value, str) or "%" in value:
        raise ValueError("address")
    address = ipaddress.ip_address(value)
    if address.is_multicast or address.is_unspecified or address.is_loopback or address.is_link_local:
        raise ValueError("address")
    return str(address)


def private_tunnel_ip(value):
    address = ipaddress.ip_address(probe_ip(value))
    if not address.is_private:
        raise ValueError("address")
    return str(address)


def ping_rtts(peer, interface=None, count=PING_ATTEMPTS):
    if count != PING_ATTEMPTS:
        raise ValueError("count")
    arguments = ["-n", "-c", str(PING_ATTEMPTS), "-W", "1", "-w", "14"]
    if interface is not None:
        if not INTERFACE.fullmatch(interface):
            raise ValueError("interface")
        arguments.extend(["-I", interface])
    arguments.extend(["--", probe_ip(peer)])
    reply = safe_command("/usr/bin/ping", arguments, 16)
    if reply is None or reply.returncode > 1:
        return []
    return [float(value) for value in re.findall(r"time[=<]([\d.]+)\s*ms", reply.stdout)][:PING_ATTEMPTS]


def speedtest_installed():
    return Path("/usr/bin/speedtest").is_file()


def iperf_installed():
    return Path("/usr/bin/iperf3").is_file()


def finite_number(value, upper):
    if type(value) not in (int, float) or value != value or value in (float("inf"), float("-inf")) or not 0 <= value <= upper:
        raise ValueError("metric")
    return value


def speedtest_download_mbps(interface=None):
    if interface is not None and not INTERFACE.fullmatch(interface):
        raise ValueError("interface")
    if not speedtest_installed():
        return None, "speedtest_missing"
    arguments = ["--accept-license", "--accept-gdpr", "--format=json"]
    if interface:
        arguments.extend(["--interface", interface])
    reply = safe_command("/usr/bin/speedtest", arguments, 75)
    if reply is None or reply.returncode:
        return None, "bandwidth_failed"
    try:
        bandwidth = json.loads(reply.stdout)["download"]["bandwidth"]
        return round(finite_number(bandwidth, 10_000_000_000) * 8 / 1_000_000, 3), None
    except (ValueError, KeyError, TypeError):
        return None, "bandwidth_failed"


def iperf_download_mbps(spec):
    if not isinstance(spec, dict) or spec.get("seconds") != 8 or spec.get("mbps") != 100:
        raise ValueError("iperf")
    if type(spec.get("port")) is not int or not 1024 <= spec["port"] <= 65535:
        raise ValueError("iperf")
    source = private_tunnel_ip(spec.get("sourceIp"))
    peer = private_tunnel_ip(spec.get("peerIp"))
    if source == peer or ipaddress.ip_address(source).version != ipaddress.ip_address(peer).version:
        raise ValueError("iperf")
    if not iperf_installed():
        return None, "iperf_missing"
    reply = safe_command("/usr/bin/iperf3", [
        "--client", peer, "--bind", source, "--port", str(spec["port"]), "--json", "--time", "8",
        "--parallel", "1", "--bitrate", str(100_000_000), "--connect-timeout", "3000", "--reverse",
    ], 20)
    if reply is None or reply.returncode:
        return None, "bandwidth_failed"
    try:
        report = json.loads(reply.stdout)
        if report.get("error"):
            return None, "bandwidth_failed"
        return round(finite_number(report["end"]["sum_received"]["bits_per_second"], 1_000_000_000) / 1_000_000, 3), None
    except (ValueError, KeyError, TypeError):
        return None, "bandwidth_failed"


def measure_bandwidth(probe):
    if probe.get("bandwidth") == "iperf":
        return iperf_download_mbps(probe.get("iperf"))
    if probe.get("bandwidth") == "speedtest":
        return speedtest_download_mbps(probe.get("interface") if probe.get("mode") == "gre" else None)
    raise ValueError("bandwidth")


def execute_speed_batch(probe):
    if not isinstance(probe, dict) or not PROBE_ID.fullmatch(str(probe.get("id", ""))):
        raise ValueError("id")
    mode = probe.get("mode")
    if mode not in ("gre", "internet") or probe.get("pingCount") != PING_ATTEMPTS:
        raise ValueError("probe")
    if mode == "internet":
        peer, interface = "1.1.1.1", None
        if probe.get("bandwidth") != "speedtest":
            raise ValueError("bandwidth")
    else:
        peer, interface = probe.get("peer"), probe.get("interface")
    try:
        pings = ping_rtts(peer, interface)
    except ValueError:
        pings = []
    bandwidth = error = None
    try:
        bandwidth, error = measure_bandwidth(probe)
    except ValueError:
        error = "bandwidth_failed"
    if not pings:
        error = "ping_failed"
        bandwidth = None
    elif bandwidth is not None:
        error = None
    elif not error:
        error = "bandwidth_failed"
    return {"id": probe["id"], "pingsMs": pings, "bandwidthMbps": bandwidth, "error": error}


def _deliver_speed_batch(config, token, probe):
    probe_id = probe.get("id") if isinstance(probe, dict) else None
    try:
        result = execute_speed_batch(probe)
    except Exception:
        result = {"id": probe_id, "pingsMs": [], "error": "target"}
    if not isinstance(result.get("id"), str):
        return
    payload = {"serverId": config["serverId"], "id": result["id"], "pingsMs": result.get("pingsMs") or []}
    if result.get("bandwidthMbps") is not None:
        payload["bandwidthMbps"] = result["bandwidthMbps"]
    if result.get("error"):
        payload["error"] = result["error"]
    try:
        send(build_opener(NoRedirects()), config["endpoint"] + "/speed-batch", token, payload)
    except (HTTPError, URLError, TimeoutError, OSError):
        print("Speed batch result was not delivered", file=sys.stderr)


def start_speed_batch(config, token, plan):
    try:
        probes = plan.get("speedBatches") if isinstance(plan, dict) else None
        if not isinstance(probes, list) or not probes or not isinstance(probes[0], dict):
            return
        probe = probes[0]
        if not PROBE_ID.fullmatch(str(probe.get("id", ""))):
            return
        global _batch_thread
        with _batch_guard:
            if _batch_thread is not None and _batch_thread.is_alive():
                return
            _batch_thread = Thread(target=_deliver_speed_batch, args=(config, token, probe), name="speed-batch", daemon=True)
            _batch_thread.start()
    except Exception:
        print("Speed batch was not started", file=sys.stderr)


def tcp_probe(peer, port):
    started = time.monotonic()
    try:
        with socket.create_connection((peer, port), timeout=3):
            ok = True
    except OSError:
        ok = False
    return {"ok": ok, "elapsedMs": round((time.monotonic() - started) * 1000)}


def probe_tunnel(item, rates):
    measured_at = iso_time()
    try:
        _, mtu, up = interface_state(item["interface"])
    except FileNotFoundError:
        return {"tunnelId": item["id"], "measuredAt": measured_at, "mtu": item.get("mtu", 1400),
                "status": "offline", "rttMs": 0, "jitterMs": 0, "packetLoss": 100,
                **({"rxMbps": 0, "txMbps": 0} if rates is not None else {})}
    except OSError:
        return None
    if not 576 <= mtu <= 9000:
        return None
    rtt = jitter = 0
    loss = 100
    if up:
        reply = icmp_probe(item["peer"], item["interface"])
        if reply is None:
            return None
        loss = reply["packetLoss"]
        rtt, jitter = reply["rttMs"] or 0, reply["jitterMs"] or 0
    rx, tx = (rates or {}).get(item["interface"], (0, 0))
    return {
        "tunnelId": item["id"], "measuredAt": measured_at, "mtu": mtu, "status": "offline" if loss == 100 else "degraded" if loss >= 2 else "healthy",
        "rttMs": rtt, "jitterMs": jitter, "packetLoss": loss,
        **({"rxMbps": rx, "txMbps": tx} if rates is not None else {}),
    }


def forwarder_probe(probe):
    measured_at = iso_time()
    started = time.monotonic()
    reply = safe_command("/usr/bin/curl", [
        "--disable", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
        "--connect-to", f"::127.0.0.1:{probe['localPort']}", "--noproxy", "*", "--proto", "=https",
        "--connect-timeout", "3", "--max-time", "5", "--max-filesize", "4096", "--url", probe["url"],
    ], 6)
    expected = str(probe.get("expectedStatus", 204))
    return {"tunnelId": probe["id"], "measuredAt": measured_at,
            "ok": bool(reply and not reply.returncode and reply.stdout.strip() == expected),
            "elapsedMs": round((time.monotonic() - started) * 1000)}


def redact_forwarder_logs(unit, entries, configured_secrets=None):
    match = MANAGED_SERVICE.fullmatch(unit)
    secrets = [] if configured_secrets is None else configured_secrets
    if not isinstance(secrets, list) or any(not isinstance(secret, str) or not secret for secret in secrets):
        return []
    def collect(value):
        if not isinstance(value, dict):
            return
        for key, item in value.items():
            if isinstance(item, str) and any(part in key.lower() for part in ("token", "password", "private_key")) and item:
                secrets.append(item)
            elif isinstance(item, dict):
                collect(item)
    try:
        if match and configured_secrets is None:
            if tomllib is None:
                # Without a parser we cannot identify every configured secret.
                # Keep telemetry available, but withhold these logs entirely.
                return []
            collect(tomllib.loads((Path("/etc/nodeguard/components") / match[1] / "service.toml").read_text()))
    except (OSError, ValueError):
        # Do not publish unredacted logs if the source configuration is absent.
        return []
    for entry in entries:
        for secret in secrets:
            entry["message"] = entry["message"].replace(secret, "[redacted]")
        entry["message"] = re.sub(r'(?i)((?:token|password|private_key)["\x27]?\s*[=:]\s*)[^\s,}]+', r'\1[redacted]', entry["message"])
    return entries


def native_forwarder_probe(item):
    started = time.monotonic()
    port = item.get("controlPort")
    if not MANAGED_SERVICE.fullmatch(item.get("unit", "")) or type(port) is not int or not 1 <= port <= 65535:
        return None
    connected = safe_command("/usr/bin/ss", ["-Htn", "state", "established", "sport", "=", ":" + str(port)], 3)
    return {"tunnelId": item["id"], "measuredAt": iso_time(),
            "ok": native_service_health(item["unit"]) == "running" and bool(connected and not connected.returncode and connected.stdout.strip()),
            "elapsedMs": round((time.monotonic() - started) * 1000)}


def native_service_health(unit):
    match = MANAGED_SERVICE.fullmatch(unit)
    if not match:
        return None
    health = service_health(unit)
    if health is not None:
        return health
    # The system bus can reject systemd DynamicUser UIDs. Read the same
    # read-only cgroup evidence used for managed V2bX, without gaining root.
    try:
        text = (SYSTEM_UNITS / unit).read_text()
        if not any(f"Description=NodeGuard managed {kind} service {match[1]}" in text.splitlines() for kind in ("Rathole", "Backhaul")):
            return None
        events = dict(line.split() for line in (SYSTEM_SLICE / unit / "cgroup.events").read_text().splitlines())
        return "running" if events.get("populated") == "1" else "stopped"
    except FileNotFoundError:
        return "stopped"
    except (OSError, ValueError):
        return None


def proxy_probe(probe):
    started = time.monotonic()
    reply = safe_command("/usr/bin/curl", [
        "--disable", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
        "--proxy", f"socks5h://127.0.0.1:{probe['proxyPort']}", "--noproxy", "",
        "--proto", "=https", "--connect-timeout", "3", "--max-time", "5", "--url", probe["url"],
    ], 6)
    code = int(reply.stdout) if reply and reply.stdout.isdigit() and int(reply.stdout) >= 100 else None
    result = {
        "nodeId": probe["nodeId"], "ok": bool(reply and not reply.returncode and code == probe.get("expectedStatus", 204)),
        "elapsedMs": round((time.monotonic() - started) * 1000),
    }
    if "side" in probe:
        result["side"] = probe["side"]
    if code is not None:
        result["httpStatus"] = code
    return result


def service_health(unit):
    reply = safe_command("/usr/bin/systemctl", ["show", "--property=LoadState", "--property=ActiveState", "--", unit], 3)
    if not reply or reply.returncode:
        return None
    properties = dict(line.split("=", 1) for line in reply.stdout.splitlines() if "=" in line)
    if properties.get("LoadState") != "loaded":
        return None
    state = properties.get("ActiveState")
    if state == "active":
        return "running"
    if state in ("inactive", "failed"):
        return "stopped"
    return "degraded"


def managed_v2bx_units():
    # Some system buses reject transient service UIDs. NodeGuard units use the default system slice.
    if not SYSTEM_SLICE.is_dir():
        return []
    units = []
    for unit in SYSTEM_UNITS.glob("nodeguard-svc-*.service"):
        match = MANAGED_SERVICE.fullmatch(unit.name)
        if not match:
            continue
        try:
            description = "Description=NodeGuard managed V2bX service " + match[1]
            if description not in unit.read_text(encoding="utf-8").splitlines():
                continue
            try:
                events = (SYSTEM_SLICE / unit.name / "cgroup.events").read_text().splitlines()
            except FileNotFoundError:
                events = ["populated 0"]
        except (OSError, UnicodeError):
            continue
        if "populated 1" in events:
            units.append((unit.name, "degraded" if "frozen 1" in events else "running"))
        elif "populated 0" in events:
            units.append((unit.name, "stopped"))
    return units


def managed_v2bx_from_cgroups():
    units = managed_v2bx_units()
    active = [unit for unit in units if unit[1] != "stopped"]
    selected = active or units
    return selected[0] if len(selected) == 1 else None


def observed_v2bx(configured):
    configured_health = service_health(configured) if configured else None
    if configured_health == "running":
        return configured, configured_health
    reply = safe_command("/usr/bin/systemctl", [
        "list-units", "--all", "--type=service", "--plain", "--no-legend", "--no-pager", "nodeguard-svc-*.service",
    ], 3)
    if reply and not reply.returncode:
        units = []
        for line in reply.stdout.splitlines():
            parts = line.split(maxsplit=4)
            match = MANAGED_SERVICE.fullmatch(parts[0]) if len(parts) == 5 else None
            if match and parts[4] == "NodeGuard managed V2bX service " + match[1]:
                units.append(parts[0])
        if len(units) == 1:
            health = service_health(units[0])
            if health is not None:
                return units[0], health
    if fallback := managed_v2bx_from_cgroups():
        return fallback
    return configured, configured_health


def v2bx_tag(message):
    if message.startswith("{"):
        try:
            pairs = json.loads(message, object_pairs_hook=list)
            data = dict(pairs)
        except ValueError:
            return None
        if len(data) == len(pairs) and isinstance(data.get("msg"), str) and isinstance(data.get("level"), str):
            return data.get("tag") if isinstance(data.get("tag"), str) else None
        return None
    if not message.startswith(("time=", "level=")):
        return None
    try:
        tokens = shlex.split(message)
    except ValueError:
        return None
    keys = [token.partition("=") for token in tokens]
    tags = [value for key, separator, value in keys if key == "tag" and separator]
    return tags[0] if len(tags) == 1 and {"level", "msg"} <= {key for key, separator, _ in keys if separator} else None


def journal(unit, cursor, tags=None, limit=80, include_debug=False, urgent=False):
    arguments = ["--no-pager", "--output=json", "--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT", "--lines=+" + str(limit), "--unit=" + unit]
    arguments.append("--after-cursor=" + cursor if cursor else "--since=-10min")
    reply = safe_command("/usr/bin/journalctl", arguments, 5)
    if not reply or reply.returncode:
        return [], cursor
    entries = []
    last_cursor = cursor
    for line in reply.stdout.splitlines():
        try:
            entry = json.loads(line)
            entry_cursor = entry.get("__CURSOR")
            if isinstance(entry_cursor, str) and entry_cursor:
                last_cursor = entry_cursor
            message = entry.get("MESSAGE")
            if not isinstance(message, str) or not message:
                continue
            timestamp = iso_time(int(entry["__REALTIME_TIMESTAMP"]) / 1_000_000)
            level = SEVERITIES[min(7, max(0, int(entry.get("PRIORITY", 6))))]
            # Go services often send every structured message at journald INFO priority.
            try:
                if message.startswith("{"):
                    structured_level = json.loads(message).get("level", "")
                else:
                    levels = [part.partition("=")[2] for part in shlex.split(message) if part.startswith("level=")]
                    structured_level = levels[0] if len(levels) == 1 else ""
                level = {"debug": "DEBUG", "trace": "DEBUG", "info": "INFO", "warn": "WARNING",
                         "warning": "WARNING", "error": "ERROR", "fatal": "CRITICAL", "panic": "CRITICAL"}.get(str(structured_level).lower(), level)
            except (ValueError, AttributeError):
                pass
            if level == "DEBUG" and not include_debug:
                continue
            if urgent and level not in ("ERROR", "CRITICAL"):
                continue
            node_id = tags.get(v2bx_tag(message)) if tags and entry.get("_SYSTEMD_UNIT") == unit else None
            message = re.sub(r"([?&](?:token|api[_-]?key)=)[^&\s\"']+", r"\1[redacted]", message, flags=re.IGNORECASE)
            message = "".join(char if char >= " " or char in "\n\t" else " " for char in message)
            log = {"ts": timestamp, "severity": level, "source": "v2bx-node" if node_id else "v2bx-shared",
                   "message": message.encode("utf8", "replace")[:768].decode("utf8", "ignore")}
            if node_id:
                log["nodeId"] = node_id
            if isinstance(entry_cursor, str) and entry_cursor:
                log["eventKey"] = sha256(entry_cursor.encode()).hexdigest()
            entries.append(log)
        except (ValueError, KeyError, TypeError):
            continue
    return entries, last_cursor


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send(opener, endpoint, token, report):
    payload = json.dumps(report, ensure_ascii=False).encode()
    request = Request(endpoint, data=payload, headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
    }, method="POST")
    with opener.open(request, timeout=10) as response:
        return response.status == 200


def get_plan(opener, config, token):
    request = Request(config["endpoint"] + "/plan", data=json.dumps({"serverId": config["serverId"]}).encode(),
                      headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with opener.open(request, timeout=10) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Telemetry plan exceeds the supported size")
        return json.loads(raw)["data"]


def watch_settings(config, token, wake):
    opener = build_opener(NoRedirects())
    version = None
    while True:
        fields = {"serverId": config["serverId"]}
        if version:
            fields["version"] = version
        request = Request(config["endpoint"] + "/settings", data=json.dumps(fields).encode(),
                          headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with opener.open(request, timeout=26) as response:
                current = json.loads(response.read(4096))["data"]["version"]
            if current != version:
                version = current
                wake.set()
        except HTTPError as error:
            error.close()
            if error.code in (401, 403, 404):
                return
            time.sleep(5)
        except (OSError, ValueError, KeyError):
            time.sleep(5)


def counter_rates(counters, previous):
    now = time.monotonic()
    elapsed = max(0.01, now - previous[0])
    values = {name: tuple(round((new - old) * 8 / elapsed / 1_000_000, 3) for new, old in zip(counters[name], previous[1][name]))
              for name in counters.keys() & previous[1].keys()
              if all(new >= old for new, old in zip(counters[name], previous[1][name]))}
    return values, (now, counters)


def interface_counters(names):
    counters = {}
    for name in names:
        try:
            counters[name] = interface_state(name)[0]
        except OSError:
            continue
    return counters


def service_counters(unit):
    if not UNIT.fullmatch(unit):
        return None
    reply = safe_command("/usr/bin/systemctl", ["show", "--property=IPIngressBytes", "--property=IPEgressBytes", "--", unit], 3)
    if not reply or reply.returncode:
        return None
    properties = dict(line.split("=", 1) for line in reply.stdout.splitlines() if "=" in line)
    values = tuple(properties.get(key, "") for key in ("IPIngressBytes", "IPEgressBytes"))
    if all(value.isdecimal() and int(value) < 2**64 - 1 for value in values):
        return tuple(map(int, values))
    return None


class Sampler:
    def __init__(self, config):
        self.config = config
        self.cpu = cpu_ticks()
        self.disk = (time.monotonic(), disk_counters())
        self.traffic = (time.monotonic(), interface_counters([config["interface"]]))
        self.tunnel_traffic = (0, {})
        self.hardware_sent = None
        self.hardware_at = 0
        state = os.environ.get("STATE_DIRECTORY")
        self.cursor_path = Path(state) / "v2bx-cursors.json" if state else None
        self.cursors = {}
        if self.cursor_path:
            try:
                saved = json.loads(self.cursor_path.read_text())
                self.cursors = {unit: cursor for unit, cursor in saved.items() if UNIT.fullmatch(unit.removesuffix("#urgent")) and isinstance(cursor, str)}
            except (OSError, ValueError, AttributeError):
                pass

    def acknowledge(self, cursors):
        if cursors == self.cursors:
            return
        self.cursors = cursors
        if self.cursor_path:
            try:
                pending = self.cursor_path.with_suffix(".tmp")
                pending.write_text(json.dumps(cursors))
                pending.replace(self.cursor_path)
            except OSError:
                print("Unable to persist V2bX journal cursors", file=sys.stderr)

    def report(self, plan):
        config = self.config
        due = [key for key, when in plan["due"].items() if time.time() * 1000 >= when]
        report = {"serverId": config["serverId"], "reportId": str(uuid4()), "version": "0.5.6", "streams": due,
                  "uptimeSec": int(float(Path("/proc/uptime").read_text().split()[0]))}
        if "cpu" in due:
            now = cpu_ticks()
            report["cpu"] = percent(now[0] - self.cpu[0], now[1] - self.cpu[1])
            self.cpu = now
        if "ram" in due:
            report["ram"] = memory()[0]
        if "disk" in due:
            report["disk"], disk_bytes = disk()
            hardware = {"cpuCores": os.cpu_count() or 1, "ramBytes": memory()[1], "diskBytes": disk_bytes}
            if hardware != self.hardware_sent or time.monotonic() - self.hardware_at >= 86400:
                report["hardware"] = hardware
                self.hardware_sent, self.hardware_at = hardware, time.monotonic()
            now, counters = time.monotonic(), disk_counters()
            rates = disk_rates(self.disk[1], counters, max(0.01, now - self.disk[0]))
            if rates:
                report["diskIo"] = rates
            self.disk = (now, counters)
        if "traffic" in due:
            values, self.traffic = counter_rates(interface_counters([config["interface"]]), self.traffic)
            if config["interface"] in values:
                report["rxMbps"], report["txMbps"] = values[config["interface"]]
            else:
                due.remove("traffic")
        if "serverPing" in due:
            result = icmp_probe(urlsplit(config["endpoint"]).hostname)
            if result:
                report["serverPing"] = {key: result[key] for key in ("rttMs", "packetLoss")}
        tunnels = plan["tunnels"]
        if "tunnelTraffic" in due:
            interfaces = interface_counters({item["interface"] for item in tunnels})
            counters = {item["id"]: interfaces[item["interface"]] for item in tunnels if item["interface"] in interfaces}
            for item in plan.get("forwarderUnits", []):
                if counts := service_counters(item["unit"]):
                    counters[item["id"]] = counts
            values, self.tunnel_traffic = counter_rates(counters, self.tunnel_traffic)
            report["tunnelTraffic"] = [dict(tunnelId=key, rxMbps=rx, txMbps=tx) for key, (rx, tx) in values.items()][:128]
        if "tunnelProbe" in due:
            with ThreadPoolExecutor(max_workers=16) as pool:
                report["tunnels"] = [item for item in pool.map(lambda tunnel: probe_tunnel(tunnel, None), tunnels) if item]
            forwarders = {item["id"]: forwarder_probe(item) for item in config.get("forwarderProbes", [])}
            for item in plan.get("nativeForwarders", []):
                if item["id"] in forwarders:
                    continue
                if result := native_forwarder_probe(item):
                    forwarders[item["id"]] = result
            for item in plan["tcpForwards"]:
                if item["id"] not in forwarders:
                    listener = tcp_probe(item.get("listenHost") or "127.0.0.1", item["port"])
                    target = tcp_probe(item["target"], item["targetPort"]) if listener["ok"] else listener
                    forwarders[item["id"]] = {"tunnelId": item["id"], "measuredAt": iso_time(), **target}
            report["forwarderChecks"] = list(forwarders.values())[:12]
        if "proxy" in due:
            report["proxyProbes"] = [proxy_probe(probe) for probe in config.get("proxyProbes", [])]
        cursors = dict(self.cursors)
        native_units = [item for item in plan.get("nativeForwarderLogs", []) if MANAGED_SERVICE.fullmatch(item["unit"])][:12] if "logs" in due else []
        v2bx_budget = 100 - min(48, 8 * len(native_units))
        v2bx_logs = "logs" in due and plan.get("v2bxLogs", True)
        urgent_logs = "service" in due and plan.get("v2bxLogs", True) and not v2bx_logs
        if v2bx_logs or "service" in due:
            units = dict(managed_v2bx_units())
            for name in {config.get("v2bxUnit"), "V2bX.service", "v2bx.service"} - {None}:
                health = service_health(name)
                if health is not None:
                    units[name] = health
            active = {health for health in units.values()}
            if "service" in due and active:
                report["v2bx"] = "running" if active == {"running"} else "stopped" if active == {"stopped"} else "degraded"
            if (v2bx_logs or urgent_logs) and units:
                names = sorted(units)[:v2bx_budget]
                report["logs"] = []
                for name in names:
                    cursor_key = name + "#urgent" if urgent_logs else name
                    entries, cursor = journal(name, cursors.get(cursor_key), config.get("v2bxLogTags"), v2bx_budget // len(names),
                                              time.time() < config.get("debugLogsUntil", 0), urgent_logs)
                    report["logs"].extend(entries)
                    if cursor:
                        cursors[cursor_key] = cursor
        report["observedAt"] = iso_time()
        if "logs" in due:
            entries = report.setdefault("logs", [])
            for item in native_units:
                unit = item["unit"]
                remaining = 100 - len(entries)
                if remaining <= 0:
                    break
                logs, cursor = journal(unit, cursors.get(unit), limit=min(8, remaining))
                for entry in redact_forwarder_logs(unit, logs, item.get("redact")):
                    entry["source"] = "tunnel"
                    entry["message"] = ("[" + item["id"] + "] " + entry["message"])[:2048]
                    entries.append(entry)
                if cursor:
                    cursors[unit] = cursor
        return report, cursors


def validate_config(config):
    debug_until = config.get("debugLogsUntil", 0)
    if isinstance(debug_until, bool) or not isinstance(debug_until, (int, float)) or not math.isfinite(debug_until) or debug_until < 0:
        raise ValueError("Invalid debugLogsUntil timestamp")
    telemetry_url(config.get("endpoint", ""))
    if not ID.fullmatch(config.get("serverId", "")) or not INTERFACE.fullmatch(config.get("interface", "")):
        raise ValueError("Invalid serverId or interface")
    unit = config.get("v2bxUnit")
    if unit is not None and not UNIT.fullmatch(unit):
        raise ValueError("Invalid v2bxUnit")
    tags = config.get("v2bxLogTags", {})
    if (not isinstance(tags, dict) or len(tags) > 256 or (tags and not unit)
            or any(not isinstance(tag, str) or not 1 <= len(tag) <= 256 or not isinstance(node, str)
                   or not ID.fullmatch(node) for tag, node in tags.items())):
        raise ValueError("v2bxLogTags must map exact service tags to NodeGuard node IDs")
    interval = config.get("intervalSec", 20)
    if not isinstance(interval, int) or not 5 <= interval <= 120:
        raise ValueError("intervalSec must be from 5 to 120 seconds")
    tunnels = config.get("tunnels", [])
    if len(tunnels) > 12:
        raise ValueError("At most 12 tunnel probes may be configured")
    ids = set()
    for tunnel in tunnels:
        if not ID.fullmatch(tunnel.get("id", "")) or not INTERFACE.fullmatch(tunnel.get("interface", "")) or tunnel["id"] in ids:
            raise ValueError("Invalid or duplicate tunnel")
        ids.add(tunnel["id"])
        tunnel["peer"] = str(ipaddress.ip_address(tunnel["peer"]))
    forwarding = config.get("forwarderProbes", [])
    if not isinstance(forwarding, list) or len(forwarding) > 6:
        raise ValueError("At most six forwarder probes may be configured")
    for probe in forwarding:
        target = urlsplit(probe["url"])
        port = probe.get("localPort")
        expected = probe.get("expectedStatus", 204)
        if (not ID.fullmatch(probe.get("id", "")) or probe["id"] in ids
                or type(port) is not int or not 1 <= port <= 65535
                or type(expected) is not int or not 200 <= expected <= 299
                or target.scheme != "https" or not target.hostname or target.username or target.password
                or target.query or target.fragment):
            raise ValueError("Forwarder probe requires a unique tunnel, local TCP port and HTTPS health URL")
        ids.add(probe["id"])
    probes = config.get("proxyProbes", [])
    if len(probes) > 4:
        raise ValueError("At most four proxy probes may be configured")
    probe_ids = set()
    for probe in probes:
        target = urlsplit(probe["url"])
        side = probe.get("side", "active")
        key = (probe["nodeId"], side)
        if (not ID.fullmatch(probe["nodeId"]) or key in probe_ids or side not in ("active", "primary", "backup")
                or not isinstance(probe["proxyPort"], int) or not 1 <= probe["proxyPort"] <= 65535
                or not 200 <= probe.get("expectedStatus", 204) <= 299
                or target.scheme != "https" or not target.hostname or target.username or target.password
                or target.query or target.fragment):
            raise ValueError("Proxy probe requires a unique node, local SOCKS port and HTTPS probe URL")
        probe_ids.add(key)


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--token-file", type=Path, help="Use a private systemd credential file")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf8"))
        validate_config(config)
        token = read_explicit_token(args.token_file) if args.token_file else agent_token(config)
    except (OSError, KeyError, TypeError, ValueError) as error:
        parser.error(str(error))
    return args.once, config, token



def main():
    once, config, token = options()
    opener = build_opener(NoRedirects())
    sampler = Sampler(config)
    wake = Event()
    if not once:
        Thread(target=watch_settings, args=(config, token, wake), daemon=True).start()
    pending = None
    last_contact = -float("inf")
    while True:
        started = time.monotonic()
        if pending is not None and started - pending_at > 240:
            pending = None
        try:
            if pending is None:
                plan = get_plan(opener, config, token)
                if not once:
                    start_speed_batch(config, token, plan)
                if once or started - last_contact >= plan.get("heartbeatSec", 20) or any(
                        time.time() * 1000 >= due for due in plan["due"].values()):
                    pending, pending_cursor = sampler.report(plan)
                    pending_at = time.monotonic()
            if pending is not None and send(opener, config["endpoint"], token, pending):
                sampler.acknowledge(pending_cursor)
                pending = None
                last_contact = time.monotonic()
            if pending is None:
                targets = {item["id"]: item for item in plan["tunnels"]}
                for ping in plan.get("pings", []):
                    target = targets.get(ping["tunnelId"])
                    result = icmp_probe(target["peer"], target["interface"]) if target else None
                    send(opener, config["endpoint"] + "/tunnel-ping", token,
                         {"id": ping["id"], "serverId": config["serverId"], "result": result})
        except HTTPError as error:
            print(f"Telemetry HTTP {error.code}", file=sys.stderr)
            if 400 <= error.code < 500 and error.code != 429:
                if once or error.code in (401, 403):
                    return 1
                pending = None
        except (URLError, TimeoutError):
            print("Telemetry transport unavailable; retrying the same report", file=sys.stderr)
        if once:
            return int(pending is not None)
        wake.wait(max(1, min(5, config.get("intervalSec", 20)) - (time.monotonic() - started)))
        wake.clear()


if __name__ == "__main__":
    sys.exit(main())
