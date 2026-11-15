#!/usr/bin/env python3
"""Install and enroll the NodeGuard telemetry Agent on a systemd host."""

import argparse
from base64 import b64decode
from getpass import getpass
from hashlib import sha256
from ipaddress import ip_address, ip_network
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError

BUNDLE = None  # NODEGUARD_EMBEDDED_BUNDLE
MODULES = (
    "agent_credentials.py", "nodeguard_agent.py", "nodeguard_enroll.py",
    "iperf_worker.py", "iperf_receiver.py", "provision_worker.py", "provision_artifacts.py", "managed_link.py",
)
SERVICE = "nodeguard-agent.service"
IPERF_SERVICE = "nodeguard-iperf.service"
PROVISION_SERVICE = "nodeguard-provision.service"
UNITS = (SERVICE, IPERF_SERVICE, PROVISION_SERVICE)
CONFIG_DIR = Path("/etc/nodeguard")
MODULE_DIR = Path("/opt/nodeguard/agent")
UNIT_DIR = Path("/etc/systemd/system")
MANAGED_UNIT = b"# Managed by the NodeGuard Agent installer.\n"
SYSTEMCTL = "/usr/bin/systemctl"
PYTHON = "/usr/bin/python3"
IPERF = "/usr/bin/iperf3"
RECEIVER_PATTERN = re.compile(r"nodeguard-iperf-rx-[a-f0-9]{24}\.service\Z")
PRIVATE_NETWORKS = tuple(ip_network(item) for item in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))


def payload():
    if BUNDLE is None:
        raise ValueError("Download a host-specific installer from the NodeGuard control plane")
    files = {name: b64decode(data, validate=True) for name, data in BUNDLE["files"].items()}
    if set(files) != {*MODULES, *UNITS} or any(not files[unit].startswith(MANAGED_UNIT) for unit in UNITS):
        raise ValueError("Installer payload is invalid")
    return BUNDLE["config"], files


def selected_units(args):
    units = [SERVICE]
    if args.with_iperf:
        units.append(IPERF_SERVICE)
    if args.with_provision:
        units.append(PROVISION_SERVICE)
    return units


def receiver_units(config):
    entries = config.get("iperfReceivers", [])
    if not isinstance(entries, list):
        raise ValueError("The backend could not provide a valid iperf receiver plan")
    binds = {}
    for item in entries:
        source, address = ip_address(item["sourceIp"]), ip_address(item["bindIp"])
        port = item["port"]
        if (type(port) is not int or not 1024 <= port <= 65535 or source == address or source.version != address.version
                or any(not any(ip in network for network in PRIVATE_NETWORKS) or getattr(ip, "scope_id", None)
                       for ip in (source, address))):
            raise ValueError("iperf receivers require distinct private same-family IPs and a non-privileged port")
        binds.setdefault((address, port), set()).add(source)
    units = {}
    for (address, port), peers in sorted(binds.items(), key=lambda item: (str(item[0][0]), item[0][1])):
        unit_id = sha256(f"{address}/{port}".encode()).hexdigest()[:24]
        allow = " ".join(f"{peer}/{peer.max_prefixlen}" for peer in sorted(peers))
        contents = MANAGED_UNIT.decode() + f"""[Unit]
Description=NodeGuard iperf3 receiver on {address} port {port}
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
DynamicUser=yes
IPAddressDeny=any
IPAddressAllow={allow}
ExecStartPre=+{PYTHON} -I /opt/nodeguard/agent/iperf_receiver.py %n
ExecStart={IPERF} --server -{address.version} --bind {address} --port {port} --server-max-duration 30 --server-bitrate-limit 100M
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
"""
        units[f"nodeguard-iperf-rx-{unit_id}.service"] = contents.encode()
    return units


def secure_mode(path, file_type):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not file_type(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError(f"Expected a root-owned, non-writable-by-others path: {path}")
    return info.st_mode


def directory(path):
    if path == Path("/"):
        return
    directory(path.parent)
    if secure_mode(path, stat.S_ISDIR) is None:
        path.mkdir(mode=0o755)


def allow_agent_access(path, required):
    mode = secure_mode(path, stat.S_ISDIR)
    if mode is None:
        raise ValueError(f"Agent directory is missing: {path}")
    permissions = stat.S_IMODE(mode)
    if permissions & required != required:
        path.chmod(permissions | required)


def sync_directory(path):
    fd = os.open(path, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def put(path, content, mode=0o644):
    secure_mode(path, stat.S_ISREG)
    with NamedTemporaryFile(dir=path.parent, prefix=".nodeguard-", delete=False) as file:
        candidate = Path(file.name)
        try:
            os.fchmod(file.fileno(), mode)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
            file.close()
            os.replace(candidate, path)
            sync_directory(path.parent)
        finally:
            candidate.unlink(missing_ok=True)


def config_for_host(defaults, path, interface):
    exists = secure_mode(path, stat.S_ISREG) is not None
    config = json.loads(path.read_text(encoding="utf8")) if exists else dict(defaults)
    if not isinstance(config, dict) or any(config.get(field) != defaults[field] for field in ("serverId", "endpoint", "tokenFile")):
        raise ValueError("Existing agent.json belongs to a different installation; preserve it and migrate it manually")
    if interface:
        config["interface"] = interface
    return config, not exists or bool(interface)


def system_ready():
    if sys.platform != "linux" or os.geteuid() != 0 or not Path("/run/systemd/system").is_dir():
        raise ValueError("Installation requires root on a Linux host running systemd")
    import grp

    if subprocess.run([PYTHON, "-I", "-c", "import sys; sys.exit(sys.version_info < (3, 8))"], timeout=5).returncode:
        raise ValueError("Install Python 3.8 or newer at /usr/bin/python3")
    version = subprocess.check_output([SYSTEMCTL, "--version"], text=True, timeout=5)
    match = re.match(r"systemd (\d+)", version)
    if not match or int(match[1]) < 245:
        raise ValueError("systemd 245 or newer is required")
    try:
        grp.getgrnam("systemd-journal")
    except KeyError:
        raise ValueError("The systemd-journal group is required") from None


def prepare_prerequisites():
    if sys.platform != "linux" or os.geteuid() != 0:
        raise ValueError("Installation requires root on Linux")
    release = Path("/etc/os-release").read_text()
    if not re.search(r'^ID=["\']?ubuntu["\']?$', release, re.M):
        return
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    packages = ["ca-certificates"]
    if not Path("/etc/ssl/certs/ca-certificates.crt").exists():
        subprocess.run(["/usr/bin/apt-get", "-o", "DPkg::Lock::Timeout=180", "update"], env=env, check=True, timeout=240)
        subprocess.run(["/usr/bin/apt-get", "-o", "DPkg::Lock::Timeout=180", "install", "-y", *packages], env=env, check=True, timeout=240)


def compatible_units(units, token):
    # Ubuntu 20.04 ships systemd 245 without LoadCredential. A dedicated static
    # service account gets a private token copy; the root credential stays 0600.
    version = subprocess.check_output([SYSTEMCTL, "--version"], text=True, timeout=5)
    match = re.match(r"systemd (\d+)", version)
    if not match or int(match[1]) >= 247:
        return units
    import pwd
    try:
        account = pwd.getpwnam("nodeguard-agent")
    except KeyError:
        subprocess.run(["/usr/sbin/useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent",
                        "--shell", "/usr/sbin/nologin", "nodeguard-agent"], check=True, timeout=15)
        account = pwd.getpwnam("nodeguard-agent")
    private = Path("/var/lib/nodeguard-credentials")
    directory(private)
    private.chmod(0o711)
    target = private / "agent.token"
    # Only the root-owned directory controls replacement of this file.
    if target.is_symlink():
        raise ValueError("Unexpected credential symlink")
    with NamedTemporaryFile(dir=private, delete=False) as stream:
        pending = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), 0o400)
            stream.write(token.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), account.pw_uid, account.pw_gid)
            stream.close()
            os.replace(pending, target)
        finally:
            pending.unlink(missing_ok=True)
    adapted = {}
    for name, raw in units.items():
        text = raw.decode()
        if "LoadCredential=agent-token:" in text:
            text = re.sub(r"(?m)^LoadCredential=agent-token:.*\n", "", text)
            text = text.replace("DynamicUser=yes", "User=nodeguard-agent")
            text = text.replace("${CREDENTIALS_DIRECTORY}/agent-token", str(target))
        adapted[name] = text.encode()
    return adapted


def install(defaults, files, args):
    print("NODEGUARD_PHASE:prerequisites", file=sys.stderr, flush=True)
    prepare_prerequisites()
    system_ready()
    import fcntl

    for path in (CONFIG_DIR, MODULE_DIR, UNIT_DIR):
        directory(path)
    # The dynamic user traverses the config path and Python lists the installed module directory.
    allow_agent_access(CONFIG_DIR, 0o011)
    allow_agent_access(MODULE_DIR.parent, 0o011)
    allow_agent_access(MODULE_DIR, 0o055)
    lock_path = CONFIG_DIR / ".agent-install.lock"
    fd = os.open(lock_path, os.O_NOFOLLOW | os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "r+") as lock:
        secure_mode(lock_path, stat.S_ISREG)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install_service(defaults, files, args)


def stale_receivers(desired):
    return sorted(
        path for path in UNIT_DIR.glob("nodeguard-iperf-rx-*.service")
        if path.name not in desired and RECEIVER_PATTERN.fullmatch(path.name)
        and secure_mode(path, stat.S_ISREG) is not None and path.read_bytes().startswith(MANAGED_UNIT)
    )


def preflight_receiver_tools():
    from iperf_receiver import bpftool_path

    bpftool_path()
    output = subprocess.check_output([IPERF, "--help"], text=True, timeout=5, stderr=subprocess.STDOUT)
    if not all(flag in output for flag in ("--server-max-duration", "--server-bitrate-limit")):
        raise ValueError("This iperf3 version lacks the required server time and bitrate limits")


def install_service(defaults, files, args):
    print("NODEGUARD_PHASE:installation", file=sys.stderr, flush=True)
    config_path = CONFIG_DIR / "agent.json"
    config, write_config = config_for_host(defaults, config_path, args.interface)
    if args.sync_tunnels:
        observed = {item["id"]: item for item in config.get("tunnels", [])}
        for item in defaults.get("tunnels", []):
            observed.setdefault(item["id"], item)
        config["tunnels"] = list(observed.values())
        write_config = True
    token = Path(config["tokenFile"])
    pending = token.with_suffix(".token.pending")
    desired_receivers = receiver_units(defaults) if args.sync_iperf_receivers else {}
    units = {name: files[name] for name in selected_units(args)}
    units.update(desired_receivers)
    stale = stale_receivers(desired_receivers) if args.sync_iperf_receivers else []
    secure_mode(token, stat.S_ISREG)
    secure_mode(pending, stat.S_ISREG)
    for name in units:
        unit = UNIT_DIR / name
        if secure_mode(unit, stat.S_ISREG) is not None and not unit.read_bytes().startswith(MANAGED_UNIT):
            raise ValueError(f"An independently managed {name} already exists")

    for name in MODULES:
        put(MODULE_DIR / name, files[name])
    sys.path.insert(0, str(MODULE_DIR))
    from agent_credentials import read_token_file
    from iperf_worker import configured_targets
    from nodeguard_agent import validate_config
    from nodeguard_enroll import enroll

    validate_config(config)
    if not (Path("/sys/class/net") / config["interface"]).is_dir():
        raise ValueError("The selected uplink is absent; use --interface with the host interface name")
    if args.with_iperf:
        if not config.get("iperfTargets") and defaults.get("iperfTargets"):
            config["iperfTargets"] = defaults["iperfTargets"]
            write_config = True
        configured_targets(config)
        if not os.access(IPERF, os.X_OK):
            raise ValueError("Install iperf3 at /usr/bin/iperf3 before enabling its worker")
    if desired_receivers:
        preflight_receiver_tools()
    if args.with_provision:
        directory(CONFIG_DIR / "profiles")
    print("NODEGUARD_PHASE:enrollment", file=sys.stderr, flush=True)
    if args.reuse_credential:
        read_token_file(token)
    else:
        code = sys.stdin.readline().strip() if args.stdin_code else getpass("NodeGuard enrollment code: ").strip()
        enroll({**config, "tokenFile": str(pending)}, code)
        os.replace(pending, token)
        sync_directory(CONFIG_DIR)
    if write_config:
        put(config_path, json.dumps(config, indent=2).encode("utf8") + b"\n")
    units = compatible_units(units, token)
    print("NODEGUARD_PHASE:services", file=sys.stderr, flush=True)
    for name, content in units.items():
        put(UNIT_DIR / name, content)
    if stale:
        subprocess.run([SYSTEMCTL, "disable", "--now", *(path.name for path in stale)], check=True, timeout=30)
        for path in stale:
            path.unlink()
        sync_directory(UNIT_DIR)
    subprocess.run([SYSTEMCTL, "daemon-reload"], check=True, timeout=30)
    for command in ("enable", "restart"):
        subprocess.run([SYSTEMCTL, command, *units], check=True, timeout=30)
    for unit in units:
        subprocess.run([SYSTEMCTL, "is-active", "--quiet", unit], check=True, timeout=10)
    print("NodeGuard services started: " + ", ".join(units) + ". Check the Agent heartbeat in NodeGuard.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="Preview the initial configuration and file hashes")
    action.add_argument("--install", action="store_true", help="Enroll and start the telemetry service")
    action.add_argument("--reuse-credential", action="store_true", help="Install or restart with the existing credential")
    parser.add_argument("--interface", help="Network interface used for host traffic counters")
    parser.add_argument("--with-iperf", action="store_true", help="Enable the unprivileged iperf3 worker")
    parser.add_argument("--with-provision", action="store_true", help="Enable the root worker for approved packages")
    parser.add_argument("--sync-tunnels", action="store_true", help="Add registered interface probes from the current download")
    parser.add_argument("--sync-iperf-receivers", action="store_true", help="Apply the receiver plan from this download")
    parser.add_argument("--stdin-code", action="store_true", help="Read the enrollment code from standard input")
    args = parser.parse_args()
    if args.stdin_code and not args.install:
        parser.error("--stdin-code requires --install")
    try:
        defaults, files = payload()
        if args.check:
            config = {**defaults, **({"interface": args.interface} if args.interface else {})}
            receivers = receiver_units(config) if args.sync_iperf_receivers else {}
            print(json.dumps({
                "config": config, "services": [*selected_units(args), *receivers],
                "sha256": {name: sha256(data).hexdigest() for name, data in {**files, **receivers}.items()},
            }, indent=2))
        else:
            install(defaults, files, args)
    except HTTPError as error:
        parser.error("Enrollment was rejected with HTTP " + str(error.code))
    except URLError:
        parser.error("Enrollment could not reach NodeGuard. Retry with the same code and pending credential.")
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
