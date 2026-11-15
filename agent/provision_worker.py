#!/usr/bin/env python3
"""Apply versioned NodeGuard host bundles and report a durable local result."""

import argparse
import base64
import gzip
import hashlib
from http.client import IncompleteRead
from ipaddress import ip_address
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, urlopen

from agent_credentials import agent_token, read_token_file, telemetry_url
from iperf_worker import Control, JOB_ID, LEASE
from managed_link import LINK_TYPES, configure as configure_link, prune_forward_rules
from nodeguard_agent import ID, NoRedirects, icmp_probe, tcp_probe
from provision_artifacts import MAX_BUNDLE_BYTES, bundle_limit


PROFILE_ROOT = "/etc/nodeguard/profiles"
JOURNAL_ROOT = "/var/lib/nodeguard/provision"
SYSCTL = "/usr/sbin/sysctl"
MODPROBE = "/usr/sbin/modprobe"
SYSTEMCTL = "/usr/bin/systemctl"
SYSTEMD_ANALYZE = "/usr/bin/systemd-analyze"
CONGESTION = "net.ipv4.tcp_congestion_control"
BBR_PATH = "/etc/sysctl.d/90-nodeguard-bbr.conf"
UNIT = re.compile(r"nodeguard-[a-zA-Z0-9_-]{1,60}\.service\Z")
RESERVED_PROFILES = {"agent", "iperf", "provision"}
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
JOURNAL_LIMIT = MAX_BUNDLE_BYTES * 4
STARTUP_STABILITY_SECONDS = 3
CLAIM_PATH = JOURNAL_ROOT + "/pending-claim.json"
PROVISION_REQUEST_TIMEOUT = 30
CLAIM_HEADERS = {"X-NodeGuard-Provision-Remove": "1", "X-NodeGuard-Provision-Download": "1",
                 "X-NodeGuard-Provision-Parallel": "1", "X-NodeGuard-V2bX-Restart": "1",
                 "X-NodeGuard-Provision-Iptables": "1", "X-NodeGuard-V2bX-Reinstall": "1",
                 "X-NodeGuard-V2bX-Remove": "1", "X-NodeGuard-Host-Reboot": "1", "X-NodeGuard-Service-Control": "1"}


GEODATA_RELEASE = "20261113232526"
GEODATA_ASSETS = {
    "geoip.dat": ("geoip-full.dat", 77347361, "8a044f44217d0a2ec0f768f0c8791d9b5a99379c0e2d5fc73ec4b647447e0c41"),
    "geosite.dat": ("geosite.dat", 7759488, "40bfe7773bae6fd7d068956bc143704b2accb45a7678613addba61a0781a561d"),
}


def geodata_varint(blob, pos, end):
    value = 0
    for shift in range(0, 70, 7):
        if pos >= end:
            raise ValueError("Truncated geodata integer")
        byte = blob[pos]
        pos += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, pos
    raise ValueError("Invalid geodata integer")


def geodata_fields(blob, start=0, end=None):
    end = len(blob) if end is None else end
    pos = start
    while pos < end:
        tag, pos = geodata_varint(blob, pos, end)
        if tag >> 3 == 0:
            raise ValueError("Invalid geodata field")
        wire = tag & 7
        if wire == 2:
            size, pos = geodata_varint(blob, pos, end)
            stop = pos + size
            if stop > end:
                raise ValueError("Truncated geodata field")
            yield tag >> 3, pos, stop
            pos = stop
        elif wire == 0:
            _, pos = geodata_varint(blob, pos, end)
        elif wire in (1, 5):
            pos += 8 if wire == 1 else 4
        else:
            raise ValueError("Unsupported geodata field")
        if pos > end:
            raise ValueError("Truncated geodata value")


def geodata_categories(blob):
    result = set()
    for number, start, end in geodata_fields(blob):
        if number == 1:
            for field, a, b in geodata_fields(blob, start, end):
                if field == 1:
                    result.add(blob[a:b].decode("utf8").lower())
                    break
    if not result:
        raise ValueError("Geodata contains no categories")
    return result


def required_categories(value, required):
    if isinstance(value, dict):
        for item in value.values():
            required_categories(item, required)
    elif isinstance(value, list):
        for item in value:
            required_categories(item, required)
    elif isinstance(value, str):
        for prefix, name in (("geoip:", "geoip.dat"), ("geosite:", "geosite.dat")):
            if value.startswith(prefix):
                category = value[len(prefix):].split("@", 1)[0].lower()
                if category.startswith("!"):
                    category = category[1:]
                required[name].add(category)


def prepare_v2bx_geodata(host, spec):
    documents = {}
    for path, file in spec["files"].items():
        if file and path.endswith(".json"):
            documents[path] = json.loads(base64.b64decode(file["content"]))
    config = next((value for path, value in documents.items()
                   if path.endswith(("/config.json", "/service.json")) and isinstance(value, dict)
                   and isinstance(value.get("Nodes"), list)), None)
    if config is None:
        return
    cores = [core for core in config.get("Cores", []) if core.get("Type") == "xray"]
    if not cores:
        return
    required = {"geoip.dat": {"private"}, "geosite.dat": set()}
    for value in documents.values():
        required_categories(value, required)
    for directory in sorted({core.get("AssetPath") or "/etc/V2bX" for core in cores}):
        path = PurePosixPath(directory)
        if not path.is_absolute() or ".." in path.parts or str(path) == "/":
            raise ValueError("Invalid Xray AssetPath")
        folder = host.path(str(path))
        host.parent(folder / "geoip.dat", create=True)
        # Stage every missing file before installing any of them. Existing valid
        # datasets are preserved; custom datasets are never silently overwritten.
        with tempfile.TemporaryDirectory(prefix=".nodeguard-geodata-", dir=folder) as staging:
            pending = []
            for name, (source, size, checksum) in GEODATA_ASSETS.items():
                target = str(path / name)
                try:
                    data = host.read(target, 100 * 1024 * 1024)
                except FileNotFoundError:
                    data = None
                if data is not None:
                    if not required[name] <= geodata_categories(data):
                        raise ValueError("Existing " + name + " lacks required categories")
                    continue
                candidate = Path(staging) / name
                digest = hashlib.sha256()
                total = 0
                deadline = time.monotonic() + 240
                url = "https://github.com/XTLS/Xray-rules-dat/releases/download/" + GEODATA_RELEASE + "/" + source
                with urlopen(Request(url, headers={"User-Agent": "NodeGuard-Agent"}), timeout=30) as response, candidate.open("xb") as output:
                    if urlsplit(response.geturl()).scheme != "https":
                        raise ValueError("Geodata download requires HTTPS")
                    while True:
                        chunk = response.read(256 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > size or time.monotonic() > deadline:
                            raise ValueError("Geodata download exceeded limits")
                        digest.update(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if total != size or digest.hexdigest() != checksum:
                    raise ValueError("Geodata SHA-256 or size mismatch")
                if not required[name] <= geodata_categories(candidate.read_bytes()):
                    raise ValueError("Downloaded " + name + " lacks required categories")
                pending.append((candidate, target))
            for candidate, target in pending:
                # Host.write checks all parent ownership and writes atomically.
                def copy(output, candidate=candidate):
                    with candidate.open("rb") as source:
                        while chunk := source.read(256 * 1024):
                            output.write(chunk)
                host.write(target, 0o644, copy)


class Conflict(Exception):
    """Existing host state differs from the journal."""


class ListenerConflict(ValueError):
    """A listener belongs to a different managed service."""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def path_parts(value):
    path = PurePosixPath(value)
    if str(path) != value or any(part in ("..", ".") for part in path.parts):
        raise ValueError("Invalid path")
    return path


class Host:
    def __init__(self, root=Path("/"), owner=0):
        self.root = root
        self.owner = owner

    def path(self, value):
        path = path_parts(value)
        if not path.is_absolute():
            raise ValueError("Expected absolute host path")
        return self.root.joinpath(*path.parts[1:])

    def trust(self, path, directory):
        info = path.lstat()
        right_kind = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
        if not right_kind or info.st_uid != self.owner or info.st_mode & 0o022:
            raise ValueError("Expected root-owned file or directory with restricted permissions")
        return info

    def parent(self, path, create=False):
        relative = path.parent.relative_to(self.root)
        current = self.root
        self.trust(current, True)
        for name in relative.parts:
            current = current / name
            if create:
                current.mkdir(mode=0o755, exist_ok=True)
            self.trust(current, True)

    def read(self, value, limit=MAX_BUNDLE_BYTES):
        path = self.path(value)
        self.parent(path)
        if self.trust(path, False).st_size > limit:
            raise ValueError("File too large")
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("File too large")
        return data

    def snapshot(self, value):
        path = self.path(value)
        try:
            content = self.read(value)
        except FileNotFoundError:
            return None
        return {"content": base64.b64encode(content).decode(), "mode": stat.S_IMODE(self.trust(path, False).st_mode)}

    def process_cgroup(self, pid):
        # /proc/PID is owned by the process user, including DynamicUser services.
        # Read only this kernel metadata; retain root ownership checks for configs.
        if not re.fullmatch(r"[1-9][0-9]{0,9}", str(pid)):
            raise ValueError("Invalid process ID")
        directory = self.path("/proc/" + str(pid))
        self.parent(directory)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
            raise ValueError("Invalid process directory")
        fd = os.open(directory / "cgroup", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
                raise ValueError("Invalid process metadata")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                data = stream.read(65537)
            if len(data) > 65536:
                raise ValueError("Process metadata too large")
            return data.decode()
        finally:
            os.close(fd)

    def save(self, value, snapshot):
        if snapshot is None:
            path = self.path(value)
            self.parent(path)
            path.unlink(missing_ok=True)
            self.sync(path.parent)
            return
        self.write(value, snapshot["mode"], lambda stream: stream.write(base64.b64decode(snapshot["content"], validate=True)))

    def write(self, value, mode, write_content):
        path = self.path(value)
        self.parent(path, create=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".nodeguard-", delete=False) as stream:
            temp = Path(stream.name)
            try:
                write_content(stream)
                stream.flush()
                os.chmod(temp, mode)
                os.fsync(stream.fileno())
                stream.close()
                os.replace(temp, path)
                self.sync(path.parent)
            finally:
                temp.unlink(missing_ok=True)

    @staticmethod
    def sync(directory):
        if os.name == "posix":
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def remove_tree(self, value):
        parts = path_parts(value).parts
        profile = parts[4] if len(parts) == 5 and parts[:4] == ("/", "opt", "nodeguard", "components") else None
        etc_profile = parts[4] if len(parts) == 5 and parts[:4] == ("/", "etc", "nodeguard", "components") else None
        state = parts[3] if len(parts) == 4 and parts[:3] == ("/", "var", "lib") else None
        allowed = value in ("/etc/V2bX", "/usr/local/V2bX")
        allowed = allowed or bool(profile and re.fullmatch(r"svc-[a-f0-9]{24}", profile))
        allowed = allowed or bool(etc_profile and re.fullmatch(r"svc-[a-f0-9]{24}", etc_profile))
        allowed = allowed or bool(state and re.fullmatch(r"nodeguard-svc-[a-f0-9]{24}", state))
        if not allowed:
            raise ValueError("Refusing to remove this path")
        path = self.path(value)
        if not path.exists():
            return
        if path.is_symlink() or not path.is_dir():
            raise ValueError("Expected a directory")
        self.parent(path)
        shutil.rmtree(path)
        self.sync(path.parent)

    def call(self, binary, *args, require=True):
        result = subprocess.run([binary, *args], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=18, check=False)
        if require and result.returncode:
            raise ValueError("Host command failed")
        return result.stdout.strip()

    def journal(self, key, data=None):
        if not JOB_ID.fullmatch(key):
            raise ValueError("Invalid job ID")
        value = JOURNAL_ROOT + "/" + key + ".json"
        if data is None:
            try:
                return json.loads(self.read(value, JOURNAL_LIMIT))
            except FileNotFoundError:
                return json.loads(self.read(JOURNAL_ROOT + "/" + key + ".done", JOURNAL_LIMIT))

        def write_json(stream):
            for chunk in json.JSONEncoder().iterencode(data):
                stream.write(chunk.encode())

        self.write(value, 0o600, write_json)

    def mark_delivered(self, key):
        if not JOB_ID.fullmatch(key):
            raise ValueError("Invalid job ID")
        folder = self.path(JOURNAL_ROOT)
        os.replace(folder / (key + ".json"), folder / (key + ".done"))
        self.sync(folder)

    def journals(self):
        folder = self.path(JOURNAL_ROOT)
        return [path.stem for path in folder.glob("*.json") if JOB_ID.fullmatch(path.stem)]

    def pending_claim(self):
        try:
            pending = json.loads(self.read(CLAIM_PATH, 1024))
        except FileNotFoundError:
            pending = {"claimId": os.urandom(32).hex()}
            self.write(CLAIM_PATH, 0o600, lambda stream: stream.write(json.dumps(pending).encode()))
        if (not isinstance(pending, dict) or set(pending) != {"claimId"}
                or not isinstance(pending["claimId"], str) or not LEASE.fullmatch(pending["claimId"])):
            raise ValueError("Invalid pending claim journal")
        return pending["claimId"]

    def clear_pending_claim(self, claim_id):
        # The worker lock serializes callers; never erase another request's marker.
        pending = json.loads(self.read(CLAIM_PATH, 1024))
        if pending != {"claimId": claim_id}:
            raise Conflict("Pending claim changed outside this operation")
        self.save(CLAIM_PATH, None)


def bundle(host, profile, download=None):
    key = profile["id"]
    if key in RESERVED_PROFILES or key.startswith("iperf-rx-") or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}", key) or not DIGEST.fullmatch(profile["sha256"]):
        raise ValueError("Invalid profile")
    folder = PROFILE_ROOT + "/" + key
    read = download or (lambda name, limit: host.read(folder + "/" + name, limit))
    raw = read("manifest.json", 16384)
    if sha(raw) != profile["sha256"]:
        raise ValueError("Profile digest differs from the approved preview")
    manifest = json.loads(raw)
    if any(manifest.get(field) != profile[field] for field in ("id", "component", "version")):
        raise ValueError("Bundle does not match its enrollment")

    if manifest["component"] == "GOST" and set(manifest) == {"id", "component", "version", "checkTcp"}:
        check = manifest["checkTcp"]
        if set(check) != {"host", "port"} or type(check["port"]) is not int or not 1 <= check["port"] <= 65535:
            raise ValueError("Invalid TCP check")
        return {"bbr": False, "unit": None, "files": {}, "tcpCheck": {"host": str(ip_address(check["host"])), "port": check["port"]}}

    unit = manifest.get("unit")
    files = {}
    if manifest["component"] == "BBR":
        if set(manifest) != {"id", "component", "version"}:
            raise ValueError("BBR uses the built-in recipe")
        available = "net.ipv4.tcp_available_congestion_control"
        if "bbr" not in host.call(SYSCTL, "-n", available).split():
            try:
                host.call(MODPROBE, "tcp_bbr", require=False)
            except FileNotFoundError:
                pass
            if "bbr" not in host.call(SYSCTL, "-n", available).split():
                raise ValueError("BBR is unavailable on this host")
        data = (CONGESTION + " = bbr\n").encode()
        return {"bbr": True, "unit": None, "files": {BBR_PATH: {"content": base64.b64encode(data).decode(), "mode": 0o644}}}

    items = manifest.get("files")
    if set(manifest) != {"id", "component", "version", "unit", "files"} or not isinstance(unit, str) or not UNIT.fullmatch(unit) or unit != f"nodeguard-{key}.service":
        raise ValueError("A managed systemd unit is required")
    if not isinstance(items, list) or not 1 <= len(items) <= 12:
        raise ValueError("File count is outside the supported range")
    unit_path = "/etc/systemd/system/" + unit
    limit = bundle_limit(profile["component"])
    total = 0
    for item in items:
        source = path_parts(item["source"])
        target = item["target"]
        mode = item["mode"]
        if set(item) != {"source", "target", "sha256", "mode"} or source.is_absolute() or target in files:
            raise ValueError("Invalid bundle file")
        path_parts(target)
        if target != unit_path and not target.startswith((f"/opt/nodeguard/components/{key}/", f"/etc/nodeguard/components/{key}/")):
            raise ValueError("File target is outside the managed directories")
        if mode not in (0o600, 0o644, 0o755) or (target == unit_path and mode != 0o644):
            raise ValueError("Invalid file mode")
        data = read(str(source), limit - total)
        total += len(data)
        if sha(data) != item["sha256"] or total > limit:
            raise ValueError("Bundle artifact is invalid or too large")
        files[target] = {"content": base64.b64encode(data).decode(), "mode": mode}
    if unit_path not in files:
        raise ValueError("The enrolled service unit is missing")
    return {"bbr": False, "unit": unit, "files": files}


def baseline(host, spec, component):
    if "tcpCheck" in spec:
        return {}
    before = {target: host.snapshot(target) for target in spec["files"]}
    if sum(len(item["content"]) for item in before.values() if item) > bundle_limit(component) * 4 // 3 + 4:
        raise ValueError("Backup exceeds local journal limit")
    if spec["bbr"]:
        old = host.call(SYSCTL, "-n", CONGESTION)
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,15}", old):
            raise ValueError("Invalid kernel congestion control value")
        return {"files": before, "congestion": old}
    unit = spec["unit"]
    unit_path = "/etc/systemd/system/" + unit
    enabled = host.call(SYSTEMCTL, "is-enabled", "--", unit, require=False)
    active = host.call(SYSTEMCTL, "is-active", "--", unit, require=False)
    if before[unit_path] is None and enabled in ("not-found", "") and active == "failed":
        # systemd can retain the failed state after an unsuccessful install removed its unit.
        active = "inactive"
    if enabled not in ("enabled", "disabled", "not-found", "") or active not in ("active", "inactive", ""):
        raise ValueError("Existing unit is not in a supported state")
    if before[unit_path] is None and (enabled not in ("not-found", "") or active == "active"):
        raise ValueError("Service exists outside the managed unit path")
    return {"files": before, "enabled": enabled == "enabled", "active": active == "active"}


def active_invocation(host, unit):
    status = host.call(SYSTEMCTL, "show", "--property=ActiveState", "--property=InvocationID", "--property=Result", "--", unit)
    properties = dict(line.split("=", 1) for line in status.splitlines() if "=" in line)
    invocation = properties.get("InvocationID", "")
    if (properties.get("ActiveState") != "active" or properties.get("Result") != "success"
            or not re.fullmatch(r"[a-f0-9]{32}", invocation) or invocation == "0" * 32):
        raise ValueError("Unit did not become active")
    return invocation


def verify_startup(host, unit):
    invocation = active_invocation(host, unit)
    time.sleep(STARTUP_STABILITY_SECONDS)
    if active_invocation(host, unit) != invocation:
        raise ValueError("Unit restarted during startup verification")


def verify_v2bx_startup(host, unit, timeout=150):
    # V2bX starts its core before requesting certificates. It can later exit
    # with status 0 on node/certificate errors, so ActiveState alone is not ready.
    invocation = active_invocation(host, unit)
    deadline = time.monotonic() + timeout
    while True:
        if active_invocation(host, unit) != invocation:
            raise ValueError("V2bX restarted before its nodes were ready")
        output = host.call("/usr/bin/journalctl", "--no-pager", "--output=cat", "-n", "120",
                           "_SYSTEMD_INVOCATION_ID=" + invocation)
        if re.search(r"\b(?:Run nodes failed|Start core failed|Read config failed)\b", output):
            raise ValueError("V2bX node startup failed; check certificate and API settings")
        if re.search(r"\bNodes started\b", output):
            return
        if time.monotonic() >= deadline:
            raise ValueError("V2bX nodes did not become ready")
        time.sleep(1)


def apply(host, spec):
    if check := spec.get("tcpCheck"):
        if not tcp_probe(check["host"], check["port"])["ok"]:
            raise ValueError("TCP target did not accept a connection")
        return
    for target, value in spec["files"].items():
        host.save(target, value)
    if spec["bbr"]:
        host.call(SYSCTL, "-w", CONGESTION + "=bbr")
        if host.call(SYSCTL, "-n", CONGESTION) != "bbr":
            raise ValueError("Kernel did not confirm BBR")
        return
    unit = spec["unit"]
    host.call(SYSTEMD_ANALYZE, "verify", "/etc/systemd/system/" + unit)
    host.call(SYSTEMCTL, "daemon-reload")
    host.call(SYSTEMCTL, "enable", "--", unit)
    host.call(SYSTEMCTL, "restart", "--", unit)
    verify_startup(host, unit)
    config = service_config(spec, "config.json")
    if config and isinstance(config.get("Nodes"), list):
        verify_v2bx_startup(host, unit)


def listener_ports(spec):
    """Only local bind ports; never include remote destination ports."""
    ports = set()

    def add(protocol, value):
        port = int(str(value).rsplit(":", 1)[-1])
        if not 1 <= port <= 65535:
            raise ValueError("Invalid listener port")
        ports.add((protocol, port))

    for name in ("link.json", "forward.json"):
        config = service_config(spec, name)
        if config:
            if config.get("forward"):
                add("tcp", config["forward"]["port"])
            if config.get("gre"):
                add("udp", config["gre"]["port"])
    for path, file in spec["files"].items():
        if not path.endswith(("/service.json", "/gost.json", "/service.toml", ".conf")):
            continue
        text = base64.b64decode(file["content"])
        if path.endswith(("/service.json", "/gost.json")):
            config = json.loads(text)
            for service in config.get("services", []):
                if service.get("addr") and str(service["addr"]).rsplit(":", 1)[-1] != "0":
                    add(service.get("listener", {}).get("type", "tcp"), service["addr"])
        elif path.endswith("/service.toml"):
            config = listener_toml(text.decode("utf-8-sig"))
            server = config.get("server", {})
            if server.get("bind_addr"):
                transport = server.get("transport", "tcp")
                add("udp" if isinstance(transport, str) and transport in ("quic", "kcp") else "tcp", server["bind_addr"])
            for service in server.get("services", {}).values():
                add(service.get("type", "tcp"), service["bind_addr"])
            for mapping in server.get("ports", []):
                local = str(mapping).split("=", 1)[0].strip()
                if "-" in local:
                    first, last = map(int, local.split("-", 1))
                    if not 1 <= first <= last <= 65535:
                        raise ValueError("Invalid listener range")
                    for port in range(first, last + 1):
                        add("tcp", port)
                else:
                    add("tcp", local)
        elif path.endswith(".conf"):
            for port in re.findall(r"(?m)^ListenPort\s*=\s*(\d+)\s*$", text.decode()):
                add("udp", port)
    return ports


def listener_toml(text):
    try:
        import tomllib
    except ImportError:
        # The installer supports Python 3.8+. Panel-generated native TOML uses
        # JSON strings and arrays; inspect only listener fields on older hosts.
        config, table = {}, None
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("["):
                tokens = re.findall(r'"(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+', line)
                keys = [json.loads(token) if token.startswith('"') else token for token in tokens]
                table = config
                for key in keys:
                    table = table.setdefault(key, {})
            elif table is not None and "=" in line:
                key, value = line.split("=", 1)
                key = key.strip().strip('"')
                if key in ("bind_addr", "ports", "type", "transport"):
                    try:
                        table[key] = json.loads(value.strip())
                    except ValueError:
                        raise ValueError("Listener TOML requires Python 3.11 or panel-generated values") from None
        return config
    return tomllib.loads(text)


def replacement_services(host, spec, component):
    """Resolve socket owners before any mutation and journal their prior state."""
    if spec["bbr"] or "tcpCheck" in spec:
        return {}
    units = set()
    if component == "V2bX":
        for unit in ("V2bX.service", "v2bx.service"):
            if host.call(SYSTEMCTL, "show", "--property=LoadState", "--value", "--", unit, require=False) == "loaded":
                units.add(unit)
    for protocol, port in sorted(listener_ports(spec)):
        if protocol not in ("tcp", "udp"):
            raise ValueError("Unsupported listener protocol")
        output = host.call("/usr/bin/ss", "-H", "-lntp" if protocol == "tcp" else "-lnup", "sport", "=", ":" + str(port))
        for line in output.splitlines():
            pids = re.findall(r"pid=(\d+)", line)
            if not pids:
                raise ValueError("Listener owner could not be identified")
            for pid in pids:
                cgroup = host.process_cgroup(pid)
                names = re.findall(r"/([^/\n]+\.service)(?:/|$)", cgroup, re.MULTILINE)
                if len(set(names)) != 1:
                    raise ValueError("Listener is not managed by a host service")
                units.add(names[0])
    units.discard(spec["unit"])
    if component in ("Backhaul", "Rathole") and any(UNIT.fullmatch(unit) for unit in units):
        raise ListenerConflict("A different managed tunnel owns this listener; use independent ports")
    states = {}
    for unit in sorted(units):
        if (not re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", unit)
                or unit.startswith(("ssh@", "sshd@", "nodeguard-iperf-rx-"))
                or unit in ("ssh.service", "sshd.service", "nodeguard-agent.service", "nodeguard-provision.service", "nodeguard-iperf.service")):
            raise ValueError("Refusing to replace a protected service")
        states[unit] = {
            "active": host.call(SYSTEMCTL, "is-active", "--", unit, require=False) == "active",
            "enabled": host.call(SYSTEMCTL, "is-enabled", "--", unit, require=False) == "enabled",
        }
    return states


def stop_replaced_services(host, states):
    for unit in states:
        host.call(SYSTEMCTL, "stop", "--", unit)
        host.call(SYSTEMCTL, "disable", "--", unit)
        if host.call(SYSTEMCTL, "is-active", "--", unit, require=False) not in ("inactive", "failed", ""):
            raise ValueError("Previous listener did not stop")


def restore_replaced_services(host, states):
    for unit, state in states.items():
        if state["enabled"]:
            host.call(SYSTEMCTL, "enable", "--", unit)
        if state["active"]:
            host.call(SYSTEMCTL, "start", "--", unit)
            verify_startup(host, unit)


def restore(host, spec, before, partial=False):
    if "tcpCheck" in spec:
        return
    for target, desired in spec["files"].items():
        current = host.snapshot(target)
        original = before["files"][target]
        if current != desired and not (partial and current == original):
            raise Conflict("Configuration changed outside this operation")
    if spec["bbr"]:
        current = host.call(SYSCTL, "-n", CONGESTION)
        if current != "bbr" and not (partial and current == before["congestion"]):
            raise Conflict("Congestion control changed outside this operation")
        if host.snapshot(BBR_PATH) != before["files"][BBR_PATH]:
            host.save(BBR_PATH, before["files"][BBR_PATH])
        host.call(SYSCTL, "-w", CONGESTION + "=" + before["congestion"])
        if host.call(SYSCTL, "-n", CONGESTION) != before["congestion"]:
            raise ValueError("Kernel did not restore congestion control")
        return
    unit = spec["unit"]
    host.call(SYSTEMCTL, "stop", "--", unit, require=not partial)
    host.call(SYSTEMCTL, "disable", "--", unit, require=not partial)
    for target, snapshot in before["files"].items():
        if host.snapshot(target) != snapshot:
            host.save(target, snapshot)
    host.call(SYSTEMCTL, "daemon-reload")
    if before["enabled"]:
        host.call(SYSTEMCTL, "enable", "--", unit)
    if before["active"]:
        host.call(SYSTEMCTL, "start", "--", unit)
        verify_startup(host, unit)
    else:
        active = host.call(SYSTEMCTL, "is-active", "--", unit, require=False)
        if active == "failed":
            host.call(SYSTEMCTL, "reset-failed", "--", unit)
            active = host.call(SYSTEMCTL, "is-active", "--", unit, require=False)
        if active not in ("inactive", ""):
            raise ValueError("Service did not restore its prior state")
    restore_replaced_services(host, before.get("replacedServices", {}))


def remove(host, spec, profile):
    if "tcpCheck" in spec:
        return
    unit = spec["unit"]
    unit_path = "/etc/systemd/system/" + unit
    current = {target: host.snapshot(target) for target in spec["files"]}
    if any(snapshot is not None and snapshot != spec["files"][target] for target, snapshot in current.items()):
        raise Conflict("Configuration changed outside NodeGuard")
    if current[unit_path] is not None:
        host.call(SYSTEMCTL, "stop", "--", unit)
        host.call(SYSTEMCTL, "disable", "--", unit)
    elif host.call(SYSTEMCTL, "is-enabled", "--", unit, require=False) not in ("not-found", ""):
        raise Conflict("Service exists outside the managed unit path")
    if host.call(SYSTEMCTL, "is-active", "--", unit, require=False) not in ("inactive", ""):
        raise Conflict("The managed unit is still active")

    # The installed unit normally removes the link in ExecStopPost. Also handle an
    # inactive unit or an interrupted removal using the pinned link configuration.
    config_path = Path("/etc/nodeguard/components") / profile["id"] / "link.json"
    link = spec["files"].get(config_path.as_posix())
    if link and profile["component"] in LINK_TYPES and profile["id"].startswith("link-"):
        config = json.loads(base64.b64decode(link["content"], validate=True))
        if config["profileId"] != profile["id"]:
            raise Conflict("Link ownership does not match the profile")
        configure_link(config, "down", config_path.parent)
    for target, snapshot in current.items():
        if snapshot is not None:
            host.save(target, None)
    host.call(SYSTEMCTL, "daemon-reload")


def fetch_artifact(control, job, name, limit, deadline):
    def request(offset):
        fields = {"serverId": control.server_id, "lease": job["lease"], "name": name}
        if offset is not None:
            fields["offset"] = offset
        return Request(control.endpoint + job["id"] + "/artifact", data=json.dumps(fields).encode(), headers={
            "Authorization": "Bearer " + control.token, "Content-Type": "application/json",
            "X-NodeGuard-Artifact-Gzip": "1",
        })

    data = bytearray()
    total = None
    offset = 0
    while total is None or len(data) < total:
        for attempt in range(3):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Provision package download deadline exceeded")
            try:
                with control.opener.open(request(offset), timeout=min(25, remaining)) as response:
                    if response.status == 200 and not data:
                        payload = response.read(limit + 1)
                        if len(payload) > limit:
                            raise ValueError("Provision artifact exceeds the manifest limit")
                        return payload
                    part = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                    if response.status != 206 or not part:
                        raise ValueError("Invalid provision artifact range")
                    start, end, size = map(int, part.groups())
                    if start != len(data) or not start <= end < size <= limit or end - start >= 1024 * 1024 or total not in (None, size):
                        raise ValueError("Invalid provision artifact range")
                    expected = end - start + 1
                    if response.headers.get("X-NodeGuard-Artifact-Encoding") == "gzip":
                        with gzip.GzipFile(fileobj=response) as compressed:
                            payload = compressed.read(expected + 1)
                    else:
                        payload = response.read(expected + 1)
                    if len(payload) != expected:
                        raise OSError("Incomplete provision artifact range")
                    total = size
                    break
            except HTTPError as error:
                error.close()
                if error.code == 422 and offset == 0 and attempt < 2:
                    # A panel from before range support accepts only the original request body.
                    offset = None
                    continue
                if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                    raise
            except (OSError, EOFError, IncompleteRead):
                if attempt == 2:
                    raise OSError("Provision artifact download interrupted") from None
        data.extend(payload)
        offset = len(data)
    return bytes(data)


def progress(control, job, step):
    if control and job.get("download"):
        try:
            control.post(job["id"] + "/progress", {"lease": job["lease"], "step": step})
        except (OSError, ValueError, KeyError):
            pass  # The durable finish result remains authoritative.


def service_config(spec, name):
    return next((json.loads(base64.b64decode(file["content"])) for path, file in spec["files"].items()
                 if path.endswith("/" + name)), None)


class ForwardingCheckError(ValueError):
    pass


def check_iptables_forwarding(config):
    ports = config["forward"]
    if not tcp_probe(config["peerInner"], ports["targetPort"])["ok"]:
        raise ForwardingCheckError("tcp_target_unreachable")
    if not tcp_probe(config["localOuter"], ports["port"])["ok"]:
        raise ForwardingCheckError("tcp_forward_unreachable")


def verify_path(control, job, spec):
    link = service_config(spec, "link.json") if job.get("verify") else None
    if link:
        result = icmp_probe(link["peerInner"], link["interface"])
        if not result or result["packetLoss"] == 100:
            raise ValueError("Tunnel peer did not answer ICMP")
        progress(control, job, "icmp")
        if link.get("forward"):
            check_iptables_forwarding(link)
            progress(control, job, "tcp")
    direct = service_config(spec, "forward.json")
    if direct:
        check_iptables_forwarding(direct)
        progress(control, job, "tcp")
    forwarding = service_config(spec, "gost.json") if link else (
        service_config(spec, "service.json") if job["profile"]["component"] == "GOST" and job["profile"].get("forwardPort") else None)
    if forwarding:
        service = forwarding["services"][0]
        target = urlsplit("tcp://" + service["forwarder"]["nodes"][0]["addr"])
        port = int(service["addr"].rsplit(":", 1)[1])
        if not tcp_probe(target.hostname, target.port)["ok"] or not tcp_probe("127.0.0.1", port)["ok"]:
            raise ValueError("GOST destination or listener did not accept TCP")
        progress(control, job, "tcp")
    return bool(job.get("verify") and (link or forwarding or direct))


def install_forwarding_dependency(spec):
    link = service_config(spec, "link.json") or service_config(spec, "forward.json")
    if not link or not link.get("forward"):
        return
    path = "/usr/sbin:/usr/bin:/sbin:/bin"
    binary = "iptables" if ip_address(link["localOuter"]).version == 4 else "ip6tables"
    if shutil.which(binary, path=path):
        return
    for name, args in (("apt-get", ["-y", "install", "iptables"]), ("dnf", ["-y", "install", "iptables"]),
                       ("yum", ["-y", "install", "iptables"]), ("apk", ["add", "iptables"])):
        if installer := shutil.which(name, path=path):
            env = {"PATH": path, "DEBIAN_FRONTEND": "noninteractive", "LC_ALL": "C"}
            result = subprocess.run([installer, *args], stdin=subprocess.DEVNULL, capture_output=True,
                                    timeout=120, env=env, check=False)
            if result.returncode and name == "apt-get":
                subprocess.run([installer, "update"], stdin=subprocess.DEVNULL, capture_output=True, timeout=120, env=env, check=True)
                subprocess.run([installer, *args], stdin=subprocess.DEVNULL, capture_output=True, timeout=120, env=env, check=True)
            break
    if not shutil.which(binary, path=path):
        raise ValueError("iptables could not be installed")


def v2bx_identity(node):
    kind = node["NodeType"].lower()
    return (node["ApiHost"].rstrip("/"), node["ApiKey"], int(node["NodeID"]), "vmess" if kind == "v2ray" else kind)


def parse_v2bx_config(raw):
    quoted = r'("(?:[^"\\]|\\.)*")'
    text = re.sub(quoted + r"|//[^\r\n]*|/\*.*?\*/", lambda match: match[1] or " ", raw.decode("utf-8-sig"), flags=re.DOTALL)
    text = re.sub(quoted + r"|,(?=\s*[}\]])", lambda match: match[1] or "", text)
    return json.loads(text)


def running_v2bx_config(host, unit):
    pid = host.call(SYSTEMCTL, "show", "--property=MainPID", "--value", "--", unit, require=False)
    if not pid.isdecimal() or int(pid) < 2:
        return None
    proc = host.path("/proc/" + pid)
    args = (proc / "cmdline").read_bytes().decode().strip("\0").split("\0")
    path = "/etc/V2bX/config.json"
    for index, arg in enumerate(args):
        if arg in ("--config", "-c"):
            path = args[index + 1]
            break
        if arg.startswith(("--config=", "-c=")):
            path = arg.split("=", 1)[1]
            break
    base = proc / "root" if path.startswith("/") else proc / "cwd"
    with (base / path.lstrip("/")).open("rb") as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("Existing V2bX configuration exceeds the supported size")
    return parse_v2bx_config(raw)


def attach_v2bx(host, spec):
    desired = service_config(spec, "config.json") or service_config(spec, "service.json")
    identities = {v2bx_identity(node) for node in desired["Nodes"]}
    units = v2bx_units(host) | {spec["unit"]}
    for unit in sorted(units):
        current = running_v2bx_config(host, unit)
        if current is None:
            continue
        existing = {v2bx_identity(node) for node in current["Nodes"]}
        if identities <= existing:
            for endpoint, token, node_id, kind in identities:
                if urlsplit(endpoint).scheme != "https":
                    raise ValueError("V2bX attachment requires an HTTPS panel endpoint")
                url = endpoint + "/api/v1/server/UniProxy/config?" + urlencode({"node_type": kind, "node_id": node_id, "token": token})
                with build_opener(NoRedirects()).open(url, timeout=8) as response:
                    config = json.loads(response.read(256 * 1024))
                    port = config.get("server_port") if isinstance(config, dict) else None
                    if not str(port).isdigit() or not 1 <= int(port) <= 65535:
                        raise ValueError("V2Board returned an invalid configuration")
            active_invocation(host, unit)
            return True
        if unit == spec["unit"] or any((old[0], old[2], old[3]) == (new[0], new[2], new[3]) for old in existing for new in identities):
            raise ValueError("A running V2bX service already owns this panel node with different credentials")
    return False


def v2bx_units(host):
    units = {"V2bX.service", "v2bx.service"}
    for unit in host.path("/etc/systemd/system").glob("nodeguard-svc-*.service"):
        if UNIT.fullmatch(unit.name) and "Description=NodeGuard managed V2bX service " in host.read(
                "/etc/systemd/system/" + unit.name, 16384).decode():
            units.add(unit.name)
    return units


def installed_v2bx_units(host):
    names = v2bx_units(host)
    installed = set()
    for unit in sorted(names):
        status = host.call(SYSTEMCTL, "show", "--property=Id", "--property=LoadState", "--", unit, require=False)
        properties = dict(line.split("=", 1) for line in status.splitlines() if "=" in line)
        name = properties.get("Id")
        if properties.get("LoadState") == "loaded" and name in names:
            installed.add(name)
    if not installed:
        raise ValueError("No V2bX service is installed")
    return sorted(installed)


MANAGED_PROFILE = re.compile(r"svc-[a-f0-9]{24}\Z")
V2BX_NODE_TYPES = {"vmess", "vless", "shadowsocks", "trojan", "hysteria", "hysteria2"}
CERT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")


def managed_profile(unit):
    prefix, suffix = "nodeguard-", ".service"
    if unit.startswith(prefix) and unit.endswith(suffix):
        profile = unit[len(prefix):-len(suffix)]
        if MANAGED_PROFILE.fullmatch(profile):
            return profile
    return None


def v2bx_removal_target(profile):
    node = profile.get("v2bxNode")
    if not isinstance(node, dict) or set(node) != {"apiHost", "nodeId", "nodeType"}:
        raise ValueError("Invalid V2bX node")
    host = node["apiHost"]
    parsed = urlsplit(host) if isinstance(host, str) else None
    if (not isinstance(host, str) or len(host) > 2048 or not parsed or parsed.scheme != "https" or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("Invalid V2bX panel address")
    node_id = node["nodeId"]
    if type(node_id) is not int or not 1 <= node_id <= 10 ** 15:
        raise ValueError("Invalid V2bX node id")
    kind = node["nodeType"]
    if kind not in V2BX_NODE_TYPES:
        raise ValueError("Invalid V2bX node type")
    return host.rstrip("/"), node_id, kind


def node_matches(node, target):
    try:
        endpoint, _, node_id, kind = v2bx_identity(node)
    except (KeyError, TypeError, ValueError):
        return False
    host, wanted_id, wanted_kind = target
    kinds = {"hysteria", "hysteria2"} if wanted_kind in ("hysteria", "hysteria2") else {wanted_kind}
    return endpoint == host and node_id == wanted_id and kind in kinds


def config_flag(command):
    try:
        args = shlex.split(command, posix=True)
    except ValueError:
        return None
    for index, arg in enumerate(args):
        if arg in ("--config", "-c") and index + 1 < len(args):
            return args[index + 1]
        if arg.startswith(("--config=", "-c=")):
            return arg.split("=", 1)[1]
    return None


def unit_config_path(text):
    credential = re.search(r"(?m)^LoadCredential=(?:config|service)\.json:(\S+)\s*$", text)
    if credential:
        return credential.group(1)
    command = re.search(r"(?m)^ExecStart=(.*\S)\s*$", text)
    if not command:
        return None
    path = config_flag(command.group(1))
    if not path or path.startswith("/run/") or "%" in path or ".." in path.split("/"):
        return None
    return path


def safe_config_path(unit, path):
    profile = managed_profile(unit)
    if profile:
        folder = "/etc/nodeguard/components/" + profile
        return path in (folder + "/config.json", folder + "/service.json")
    return unit in ("V2bX.service", "v2bx.service") and path == "/etc/V2bX/config.json"


def load_v2bx_unit_config(host, unit):
    if not UNIT.fullmatch(unit) and unit not in ("V2bX.service", "v2bx.service"):
        raise ValueError("Unrecognized V2bX unit")
    text = host.read("/etc/systemd/system/" + unit, 16384).decode()
    path = unit_config_path(text)
    if not path or not safe_config_path(unit, path):
        raise ValueError("V2bX configuration path is not supported")
    snapshot = host.snapshot(path)
    if snapshot is None:
        raise ValueError("V2bX configuration file is missing")
    raw = base64.b64decode(snapshot["content"])
    if len(raw) > 1024 * 1024:
        raise ValueError("Existing V2bX configuration exceeds the supported size")
    config = parse_v2bx_config(raw)
    if not isinstance(config, dict) or not isinstance(config.get("Nodes"), list):
        raise ValueError("V2bX configuration has no node list")
    return path, config, snapshot["mode"], text


def cert_names(node):
    cert = node.get("CertConfig")
    if not isinstance(cert, dict):
        return []
    return [cert[key] for key in ("CertFile", "KeyFile") if isinstance(cert.get(key), str) and CERT_NAME.fullmatch(cert[key])]


def removed_cert_files(config_path, removed, remaining):
    kept = {name for node in remaining for name in cert_names(node)}
    folder = str(PurePosixPath(config_path).parent)
    profile = PurePosixPath(folder).name
    directories = [folder]
    if MANAGED_PROFILE.fullmatch(profile):
        directories.append("/var/lib/nodeguard-" + profile)
    # Only accept absolute certificate paths inside this service's state directory.
    state = "/var/lib/nodeguard-" + profile + "/"
    def state_files(nodes):
        return {path for node in nodes if isinstance(node.get("CertConfig"), dict)
                for path in (node["CertConfig"].get("CertFile"), node["CertConfig"].get("KeyFile"))
                if isinstance(path, str) and MANAGED_PROFILE.fullmatch(profile)
                and path.startswith(state) and CERT_NAME.fullmatch(path[len(state):])}
    absolute = state_files(removed) - state_files(remaining)
    paths = []
    for node in removed:
        for name in cert_names(node):
            if name in kept:
                continue
            paths.extend(directory + "/" + name for directory in directories)
    return paths + sorted(absolute)


def write_v2bx_config(host, path, config, mode):
    payload = (json.dumps(config, indent=2) + "\n").encode()
    host.save(path, {"content": base64.b64encode(payload).decode(), "mode": mode})


def purge_roots(unit, config_path, unit_text):
    profile = managed_profile(unit)
    if profile and safe_config_path(unit, config_path):
        return [
            "/opt/nodeguard/components/" + profile,
            "/etc/nodeguard/components/" + profile,
            "/var/lib/nodeguard-" + profile,
        ]
    if unit not in ("V2bX.service", "v2bx.service") or config_path != "/etc/V2bX/config.json":
        return []
    roots = ["/etc/V2bX"]
    command = re.search(r"(?m)^ExecStart=(.*\S)\s*$", unit_text)
    if command:
        try:
            binary = shlex.split(command.group(1), posix=True)[0]
        except (ValueError, IndexError):
            binary = ""
        if binary.startswith("/usr/local/V2bX/") and ".." not in binary.split("/"):
            roots.append("/usr/local/V2bX")
    return roots


def purge_v2bx_unit(host, unit, config_path, unit_text):
    host.call(SYSTEMCTL, "stop", "--", unit)
    host.call(SYSTEMCTL, "disable", "--", unit)
    active = host.call(SYSTEMCTL, "is-active", "--", unit, require=False)
    if active == "failed":
        host.call(SYSTEMCTL, "reset-failed", "--", unit, require=False)
        active = host.call(SYSTEMCTL, "is-active", "--", unit, require=False)
    if active not in ("inactive", "unknown", ""):
        raise Conflict("V2bX stayed active")
    roots = purge_roots(unit, config_path, unit_text)
    try:
        for root in roots:
            host.remove_tree(root)
        covered = any(config_path == root or config_path.startswith(root + "/") for root in roots)
        if not covered:
            host.save(config_path, None)
        host.save("/etc/systemd/system/" + unit, None)
        host.call(SYSTEMCTL, "daemon-reload")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise Conflict("V2bX removal was interrupted") from error


def excise_v2bx_node(host, unit, path, config, mode, removed, unit_text):
    remaining = [node for node in config["Nodes"] if node not in removed]
    if not remaining:
        original = host.snapshot(path)
        try:
            host.call(SYSTEMCTL, "stop", "--", unit)
            write_v2bx_config(host, path, {**config, "Nodes": []}, mode)
            host.call(SYSTEMCTL, "disable", "--", unit)
        except (OSError, ValueError, subprocess.SubprocessError):
            if original is not None:
                host.save(path, original)
            host.call(SYSTEMCTL, "restart", "--", unit)
            raise
        return
    updated = {**config, "Nodes": remaining}
    if isinstance(config.get("Cores"), list) and all(isinstance(node.get("Core"), str) for node in remaining):
        used = {node["Core"] for node in remaining}
        updated["Cores"] = [core for core in config["Cores"] if isinstance(core, dict) and core.get("Type") in used]
    original = host.snapshot(path)
    write_v2bx_config(host, path, updated, mode)
    certs = removed_cert_files(path, removed, remaining)
    saved = {cert: host.snapshot(cert) for cert in certs}
    for cert, snapshot in saved.items():
        if snapshot is not None:
            host.save(cert, None)
    try:
        host.call(SYSTEMCTL, "restart", "--", unit)
        verify_startup(host, unit)
    except (OSError, ValueError, subprocess.SubprocessError):
        if original is not None:
            host.save(path, original)
        for cert, snapshot in saved.items():
            if snapshot is not None:
                host.save(cert, snapshot)
        try:
            host.call(SYSTEMCTL, "restart", "--", unit)
            verify_startup(host, unit)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise Conflict("V2bX node removal could not be restored") from error
        raise ValueError("restart_failed")


def remove_v2bx_node(host, job):
    target = v2bx_removal_target(job["profile"])
    plans = []
    for unit in installed_v2bx_units(host):
        path, config, mode, text = load_v2bx_unit_config(host, unit)
        removed = [node for node in config["Nodes"] if isinstance(node, dict) and node_matches(node, target)]
        if removed:
            plans.append((unit, path, config, mode, removed, text))
    if not plans:
        raise ValueError("This panel node is not installed on V2bX")
    started = False
    try:
        for unit, path, config, mode, removed, text in plans:
            started = True
            excise_v2bx_node(host, unit, path, config, mode, removed, text)
    except ValueError as error:
        if str(error) == "restart_failed" and len(plans) == 1:
            raise
        if started:
            raise Conflict("V2bX node removal was interrupted") from error
        raise


def reinstall_v2bx(host, job, record):
    previous = host.journal(job["rollbackOf"])
    if previous["profile"] != job["profile"] or previous["operation"] != "apply" or previous["result"]["detail"] not in ("applied", "verified"):
        raise ValueError("Original V2bX installation does not match")
    spec = previous["spec"]
    unit = spec["unit"]
    if job["profile"]["component"] != "V2bX" or not unit.startswith("nodeguard-svc-") or unit not in v2bx_units(host):
        raise ValueError("Expected a NodeGuard-managed V2bX unit")
    if any(host.snapshot(target) != desired for target, desired in spec["files"].items()):
        raise Conflict("Managed V2bX files changed after installation")
    prepare_v2bx_geodata(host, spec)
    host.journal(job["id"], {**record, "phase": "mutating", "spec": spec})
    host.call(SYSTEMCTL, "stop", "--", unit)
    try:
        for target in spec["files"]:
            host.save(target, None)
        apply(host, spec)
    except (OSError, ValueError, subprocess.SubprocessError):
        for target, snapshot in spec["files"].items():
            host.save(target, snapshot)
        host.call(SYSTEMCTL, "daemon-reload")
        host.call(SYSTEMCTL, "restart", "--", unit)
        verify_startup(host, unit)
        return False
    return True


def perform(host, job, control=None):
    key = job["id"]
    if not JOB_ID.fullmatch(key) or not LEASE.fullmatch(job["lease"]):
        raise ValueError("Invalid claim")
    base = {"id": key, "lease": job["lease"], "profile": job["profile"], "operation": job["operation"]}
    record = {**base, "phase": "ready"}
    host.journal(key, record)

    def outcome(status, detail):
        host.journal(key, {**record, "phase": "reported", "result": {"status": status, "detail": detail}})

    if job["operation"] in ("start-service", "stop-service", "restart-service"):
        try:
            previous = host.journal(job["rollbackOf"])
            if (previous["operation"] != "apply" or previous["profile"] != job["profile"]
                    or previous["result"]["status"] != "succeeded" or job["profile"]["component"] not in ("Rathole", "Backhaul")):
                raise ValueError("Service control requires a successful managed forwarder installation")
            spec = previous["spec"]
            if not re.fullmatch(r"nodeguard-svc-[a-f0-9]{24}\.service", spec["unit"]):
                raise ValueError("Unsupported managed service")
            if any(host.snapshot(target) != snapshot for target, snapshot in spec["files"].items()):
                raise Conflict("Service configuration changed outside NodeGuard")
            action = job["operation"].removesuffix("-service")
            record = {**base, "phase": "mutating"}
            host.journal(key, record)
            host.call(SYSTEMCTL, action, "--", spec["unit"])
            if action == "stop":
                if host.call(SYSTEMCTL, "is-active", "--", spec["unit"], require=False) not in ("inactive", "failed", ""):
                    raise ValueError("Service did not stop")
            else:
                verify_startup(host, spec["unit"])
            outcome("succeeded", {"start": "started", "stop": "stopped", "restart": "restarted"}[action])
        except Conflict:
            outcome("review", "external_change")
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            outcome("failed", "restart_failed")
        return

    if job["operation"] == "reboot":
        try:
            host.call(SYSTEMCTL, "reboot", "--no-block")
        except (OSError, subprocess.SubprocessError):
            outcome("failed", "restart_failed")
            return
        outcome("succeeded", "rebooted")
        return
    if job["operation"] == "remove-v2bx":
        try:
            remove_v2bx_node(host, job)
        except Conflict:
            outcome("review", "external_change")
        except ValueError as error:
            outcome("failed", "restart_failed" if str(error) == "restart_failed" else "preflight")
        except (OSError, KeyError, TypeError, subprocess.SubprocessError):
            outcome("review", "agent_error")
        else:
            outcome("succeeded", "removed")
        return
    if job["operation"] == "restart-v2bx":
        if job.get("rollbackOf"):
            try:
                try:
                    host.journal(job["rollbackOf"])
                except FileNotFoundError:
                    # A rebuilt host has neither the old journal nor the package.
                    # Use the approved panel artifact and the normal fresh-install
                    # preflight/rollback path; never bypass external-change checks.
                    if not job.get("download") or any(
                        host.call(SYSTEMCTL, "show", "--property=LoadState", "--value", "--", unit, require=False) == "loaded"
                        for unit in v2bx_units(host)
                    ):
                        raise ValueError("Fresh V2bX recovery requires an empty host and an approved package")
                    perform(host, {**job, "operation": "apply", "rollbackOf": None}, control)
                    return
                done = reinstall_v2bx(host, job, record)
                outcome("succeeded", "restarted") if done else outcome("failed", "restart_failed")
            except (OSError, ValueError, KeyError, TypeError, Conflict, subprocess.SubprocessError):
                outcome("review", "agent_error")
            return
        try:
            units = installed_v2bx_units(host)
        except (OSError, ValueError, subprocess.SubprocessError):
            outcome("failed", "preflight")
            return
        host.journal(key, {**record, "phase": "mutating"})
        try:
            for unit in units:
                host.call(SYSTEMCTL, "restart", "--", unit)
                verify_startup(host, unit)
        except (OSError, ValueError, subprocess.SubprocessError):
            outcome("failed", "restart_failed")
        else:
            outcome("succeeded", "restarted")
        return
    try:
        if job["operation"] in ("rollback", "remove"):
            previous = host.journal(job["rollbackOf"])
            if previous["profile"] != job["profile"] or previous["operation"] != "apply" or previous["result"]["status"] != "succeeded":
                raise ValueError("Original job does not match the rollback")
            spec, before = previous["spec"], previous["before"]
            if job["operation"] == "remove" and (spec["bbr"] or job["profile"]["component"] not in (*LINK_TYPES, "GOST", "Backhaul", "Rathole", "Geneve")):
                raise ValueError("Only tunnel packages can be removed")
        elif job["operation"] == "apply":
            deadline = time.monotonic() + 720
            download = (lambda name, limit: fetch_artifact(control, job, name, limit, deadline)) if job.get("download") else None
            spec = bundle(host, job["profile"], download)
            progress(control, job, "package")
            if job["profile"]["component"] == "V2bX":
                prepare_v2bx_geodata(host, spec)
            before = baseline(host, spec, job["profile"]["component"])
            install_forwarding_dependency(spec)
            before["replacedServices"] = replacement_services(host, spec, job["profile"]["component"])
        else:
            raise ValueError("Unknown action")
    except ListenerConflict:
        outcome("failed", "listener_conflict")
        return
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        outcome("failed", "preflight")
        return

    record = {**base, "phase": "mutating"}
    if job["operation"] == "apply":
        record.update(spec=spec, before=before)
    host.journal(key, record)
    try:
        if job["operation"] == "remove":
            remove(host, spec, job["profile"])
            outcome("succeeded", "removed")
        elif job["operation"] == "rollback":
            restore(host, spec, before)
            outcome("succeeded", "restored")
        else:
            stop_replaced_services(host, before.get("replacedServices", {}))
            apply(host, spec)
            progress(control, job, "tcp" if "tcpCheck" in spec else "service")
            deadline = time.monotonic() + (90 if job.get("waitForPeer") else 0)
            while True:
                try:
                    verified = verify_path(control, job, spec)
                    break
                except ValueError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(3)
            forwarding = service_config(spec, "forward.json") or service_config(spec, "link.json")
            if verified and forwarding and forwarding.get("forward"):
                prune_forward_rules(forwarding)
            outcome("succeeded", "verified" if verified else "applied")
    except Conflict:
        outcome("review", "external_change")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        if job["operation"] != "apply":
            outcome("review", "agent_error")
            return
        try:
            restore(host, spec, before, partial=True)
            outcome("failed", str(error) if isinstance(error, ForwardingCheckError) else "reverted")
        except (OSError, ValueError, Conflict, subprocess.SubprocessError):
            outcome("review", "agent_error")


def flush(host, control):
    for key in host.journals():
        job = host.journal(key)
        if job.get("delivered"):
            host.mark_delivered(key)
            continue
        if job["phase"] != "reported":
            job.update(phase="reported", result={"status": "review", "detail": "interrupted"})
            host.journal(key, job)
        try:
            control.post(key + "/finish", {"lease": job["lease"], **job["result"]})
        except HTTPError as error:
            if error.code != 409:
                raise
        host.mark_delivered(key)


def poll_once(host, control):
    # Deliver durable outcomes before asking for another task. If a process died
    # after mutation, flush reports interrupted state instead of executing twice.
    flush(host, control)
    claim_id = host.pending_claim()
    job = control.post("claim", {"claimId": claim_id}, headers=CLAIM_HEADERS)
    if job:
        if job["profile"]["serverId"] != control.server_id or job["lease"] != claim_id:
            raise ValueError("Job does not match this Agent's pending claim")
        perform(host, job, control)
        flush(host, control)
    # Timeouts, incomplete responses and crashes retain the marker. A retry then
    # retrieves the same lease, including after the worker has restarted.
    host.clear_pending_claim(claim_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--token-file", type=Path)
    args = parser.parse_args()
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("The Provision worker must run as root on Linux")
    import fcntl
    config = json.loads(args.config.read_text(encoding="utf8"))
    try:
        url = telemetry_url(config["endpoint"])
        token = read_token_file(args.token_file) if args.token_file else agent_token(config)
        if not ID.fullmatch(config["serverId"]):
            raise ValueError("Invalid server ID")
    except (OSError, KeyError, TypeError, ValueError) as error:
        parser.error(str(error))
    host = Host()
    folder = host.path(JOURNAL_ROOT)
    host.parent(folder / "worker.lock", create=True)
    os.chmod(folder, 0o700)
    lock = os.open(folder / "worker.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    control = Control(url._replace(path="/api/v1/agent/provision/").geturl(), config["serverId"], token,
                      timeout=PROVISION_REQUEST_TIMEOUT)
    while True:
        try:
            poll_once(host, control)
        except HTTPError as error:
            print("Provision API HTTP", error.code, flush=True)
            if args.once or error.code in (401, 403):
                return 1
        except (URLError, TimeoutError, ValueError, KeyError, TypeError, OSError, IncompleteRead) as error:
            print("Provision worker will retry after", type(error).__name__, flush=True)
            if args.once:
                return 1
        if args.once:
            return 0
        time.sleep(5)


if __name__ == "__main__":
    raise SystemExit(main())
