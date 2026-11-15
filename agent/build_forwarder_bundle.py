"""Build paired native Rathole/Backhaul configs from encrypted panel settings."""
import base64
import json
from pathlib import Path
import re
import tarfile
import urllib.request
import zipfile
import sys
import subprocess

from build_service_bundle import build_forwarder
from provision_artifacts import digest

RELEASES = json.loads(Path(__file__).with_name("forwarder_releases.json").read_text())
LIMIT = 64 * 1024 * 1024


def native_toml(value, path=()):
    if not isinstance(value, dict):
        raise ValueError("Expected native configuration options")
    lines = ["[" + ".".join(json.dumps(key) for key in path) + "]"] if path else []
    for key, item in value.items():
        if isinstance(item, dict):
            continue
        if not isinstance(key, str) or not (type(item) in (str, int, bool) or isinstance(item, list) and all(type(x) in (str, int, bool) for x in item)):
            raise ValueError("Unsupported native configuration value")
        lines.append(json.dumps(key) + " = " + json.dumps(item, ensure_ascii=False))
    for key, item in value.items():
        if isinstance(item, dict):
            lines.append(native_toml(item, (*path, key)))
    return "\n".join(lines) + "\n"


def release_binary(component, core, arch, root):
    release = RELEASES.get(f"{component}:{core}:{arch}")
    if not release:
        raise ValueError("Unsupported core or architecture")
    cache = Path(__file__).parent / "releases" / "forwarders" / release["sha256"]
    archive = root / (component + "-" + arch + (".zip" if release["url"].endswith(".zip") else ".tar.gz"))
    if cache.is_file():
        data = cache.read_bytes()
    else:
        if sys.platform == "win32":
            # Windows curl uses the OS trust store, including enterprise roots.
            # Certificate verification remains enabled; never use --insecure.
            subprocess.run(["curl.exe", "--fail", "--location", "--silent", "--show-error", "--max-time", "40", "--max-filesize", str(LIMIT),
                            "--output", str(archive), release["url"]], capture_output=True, timeout=45, check=True)
            data = archive.read_bytes()
        else:
            with urllib.request.urlopen(release["url"], timeout=35) as response:
                data = response.read(LIMIT + 1)
    if len(data) > LIMIT or digest(data) != release["sha256"]:
        raise ValueError("Pinned forwarder archive digest mismatch")
    archive.write_bytes(data)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as source:
            info = source.getinfo(release["member"])
            if info.file_size > LIMIT:
                raise ValueError("Oversized forwarder executable")
            binary = source.read(info)
    else:
        with tarfile.open(archive, "r:gz") as source:
            info = source.getmember(release["member"])
            if not info.isfile() or info.size > LIMIT:
                raise ValueError("Invalid forwarder executable")
            binary = source.extractfile(info).read(LIMIT + 1)
    path = root / (component + "-" + arch + ".bin")
    path.write_bytes(binary)
    return path, release["version"], digest(binary)


def build_panel_forwarder(recipe, settings, root):
    component = recipe["technology"]
    if component not in ("Backhaul", "Rathole") or settings["technology"] != component:
        raise ValueError("Forwarder settings differ from the route")
    inputs = {}
    configs = {}
    for side, role in (("iran", "server"), ("foreign", "client")):
        host = settings[side]
        options = json.loads(json.dumps(host["options"]))
        configs[side] = options
        assets = []
        seen = set()
        for asset in host["assets"]:
            name = asset["name"]
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", name) or name in seen:
                raise ValueError("Invalid or duplicate credential asset")
            seen.add(name)
            content = base64.b64decode(asset["content"], validate=True)
            if not content or len(content) > 900 * 1024:
                raise ValueError("Invalid credential asset size")
            path = root / (side + "-" + name)
            path.write_bytes(content)
            assets.append({"name": name, "file": path.name, "sha256": digest(content)})
        paths = ("tls_cert", "tls_key") if component == "Backhaul" else ()
        for key in paths:
            if options.get(key):
                if options[key] not in seen:
                    raise ValueError("TLS file must reference an uploaded credential")
                options[key] = "@CREDENTIALS@/" + options[key]
        if component == "Backhaul":
            log = options.get("sniffer_log", "traffic.json")
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", log):
                raise ValueError("Traffic log must be a filename inside the managed service state directory")
            options["sniffer_log"] = "@STATE@/" + log
        else:
            tls = options.get("transport", {}).get("tls", {})
            for key in ("pkcs12", "trusted_root"):
                if tls.get(key):
                    if tls[key] not in seen:
                        raise ValueError("TLS file must reference an uploaded credential")
                    tls[key] = "@CREDENTIALS@/" + tls[key]
        config = root / (side + ".toml")
        config.write_text(native_toml({role: options}), encoding="utf8")
        binary, version, checksum = release_binary(component, settings["core"], host["architecture"], root)
        inputs[side] = {"version": version, "architecture": host["architecture"], "binaryFile": binary.name,
                        "binarySha256": checksum, "configFile": config.name, "assets": assets,
                        "restartSeconds": host["restartSeconds"], "limitNofile": host.get("limitNofile", 1048576)}
    server, client = configs["iran"], configs["foreign"]
    token = "default_token" if component == "Rathole" else "token"
    if not server.get(token) or server[token] != client.get(token):
        raise ValueError("Both tunnel tokens must match")
    if component == "Rathole":
        if not server.get("services") or set(server["services"]) != set(client.get("services", {})):
            raise ValueError("Both sides must define the same named services")
        if any(item["type"] != client["services"][name]["type"] for name, item in server["services"].items()):
            raise ValueError("Service protocols must match")
        if server["transport"]["type"] != client["transport"]["type"]:
            raise ValueError("Both transport types must match")
    elif server["transport"] != client["transport"]:
        raise ValueError("Both transport types must match")
    return build_forwarder(recipe, inputs, root)
