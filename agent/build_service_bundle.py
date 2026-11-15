#!/usr/bin/env python3
"""Package approved Linux binaries and configs for NodeGuard Provision."""

import argparse
from ipaddress import IPv4Address
import json
from pathlib import Path
import re
import tomllib

from provision_artifacts import bundle_limit, digest, encoded, manifest_bundle, write_bundle


SIDES = ("iran", "foreign")
FORWARDERS = ("GOST", "Backhaul", "Rathole")
MACHINES = {"amd64": 62, "arm64": 183}
ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}\Z")
VERSION = re.compile(r"[a-zA-Z0-9_.+-]{1,64}\Z")
ASSET = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}\Z")
CREDENTIALS_LIMIT = 900 * 1024


def read_file(root, file, limit):
    if not isinstance(file, str) or not file:
        raise ValueError("Expected a local file path")
    path = root / file
    if not path.is_file() or path.stat().st_size > limit:
        raise ValueError("Input must be a regular file within the bundle size limit")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if not data or len(data) > limit:
        raise ValueError("Empty or oversized input file")
    return data


def binary_for(root, entry, limit):
    binary = read_file(root, entry["binaryFile"], limit)
    machine = MACHINES.get(entry["architecture"])
    if not machine or len(binary) < 64 or binary[:7] != b"\x7fELF\x02\x01\x01":
        raise ValueError("Expected a 64-bit little-endian Linux ELF binary")
    if int.from_bytes(binary[18:20], "little") != machine or int.from_bytes(binary[16:18], "little") not in (2, 3):
        raise ValueError("ELF architecture or executable type differs from the input")
    if digest(binary) != entry["binarySha256"]:
        raise ValueError("Binary digest differs from the approved SHA-256")
    return binary


def config_for(component, side, data):
    try:
        text = data.decode("utf-8-sig")
        value = tomllib.loads(text) if component in ("Backhaul", "Rathole") else json.loads(text)
    except ValueError:
        # TOML/JSON parser errors can include literal configuration values.
        raise ValueError("Service config is not valid UTF-8 JSON or TOML for this component") from None
    if not isinstance(value, dict):
        raise ValueError("Expected a service configuration object")
    if component == "GOST":
        if not isinstance(value.get("services"), list) or not value["services"]:
            raise ValueError("GOST v3 config requires at least one service")
        return "service.json", "-C"
    if component == "V2bX":
        if not isinstance(value.get("Nodes"), list) or not value["Nodes"]:
            raise ValueError("V2bX config requires at least one node")
        return "service.json", "server -c"
    role = "server" if side == "iran" else "client"
    options = value.get(role)
    other = "client" if role == "server" else "server"
    if not isinstance(options, dict) or other in value:
        raise ValueError(f"The {side} config must only define the {role} side")
    if component == "Backhaul":
        if options.get("skip_optz") is not True:
            raise ValueError("Backhaul requires skip_optz=true; host optimizations are managed separately")
        return "service.toml", "-c"
    return "service.toml", "--" + role


def service_unit(profile, config, arguments, names, architecture, component, managed_state=False, restart_seconds=0, limit_nofile=None):
    config_path = "/etc/nodeguard/components/" + profile
    executable = "/opt/nodeguard/components/" + profile + "/service-bin"
    credentials = "\n".join(f"LoadCredential={name}:{config_path}/{name}" for name in names)
    workspace = f"StateDirectory=nodeguard-{profile}\nStateDirectoryMode=0700\nWorkingDirectory=/var/lib/nodeguard-{profile}" if managed_state else "WorkingDirectory=/run/credentials/%n"
    arch = "x86-64" if architecture == "amd64" else "arm64"
    accounting = "IPAccounting=yes\n" if component in FORWARDERS else ""
    periodic = f"RuntimeMaxSec={restart_seconds}\n" if restart_seconds else ""
    limits = f"LimitNOFILE={limit_nofile}\n" if limit_nofile is not None else ""
    restart = "always" if restart_seconds else "on-failure"
    return f"""[Unit]
Description=NodeGuard managed {component} service {profile}
Wants=network-online.target
After=network-online.target
ConditionArchitecture={arch}

[Service]
Type=exec
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
{accounting}{credentials}
{workspace}
ExecStart={executable} {arguments} /run/credentials/%n/{config}
{limits}{periodic}Restart={restart}
RestartSec=3
TimeoutStopSec=12

[Install]
WantedBy=multi-user.target
""".encode()


def build_profile(component, side, server_id, entry, root, managed_state=False):
    fields = {"version", "architecture", "binaryFile", "binarySha256", "configFile"}
    if not isinstance(entry, dict) or set(entry) - (fields | {"assets", "restartSeconds", "limitNofile"}) or not fields <= set(entry):
        raise ValueError("Invalid approved service inputs")
    restart_seconds = entry.get("restartSeconds", 0)
    if type(restart_seconds) is not int or restart_seconds not in (0, 1800, 3600, 7200, 14400, 21600, 43200, 86400):
        raise ValueError("Invalid managed restart interval")
    limit_nofile = entry.get("limitNofile")
    if limit_nofile is not None and (type(limit_nofile) is not int or not 1024 <= limit_nofile <= 1048576):
        raise ValueError("Invalid file descriptor limit")
    if not ID.fullmatch(server_id) or not VERSION.fullmatch(entry["version"]):
        raise ValueError("Invalid server ID or service version")
    limit = bundle_limit(component)
    binary = binary_for(root, entry, limit)
    config = read_file(root, entry["configFile"], CREDENTIALS_LIMIT)
    config_name, arguments = config_for(component, side, config)
    if component == "Backhaul":
        managed_state = True
    if component == "V2bX":
        managed_state = managed_state or any(
            node.get("CertConfig", {}).get("CertMode") in ("http", "dns", "self")
            for node in json.loads(config.decode("utf-8-sig"))["Nodes"])
    if component == "V2bX" and managed_state:
        config_name = "config.json"
    materials = {config_name: config}
    assets = entry.get("assets", [])
    if not isinstance(assets, list) or len(assets) > 8:
        raise ValueError("At most eight credential assets are supported")
    for item in assets:
        if not isinstance(item, dict) or set(item) != {"name", "file", "sha256"}:
            raise ValueError("Invalid credential asset")
        name = item["name"]
        if not ASSET.fullmatch(name) or name in materials or name in ("manifest.json", "service-bin") or name.endswith(".service"):
            raise ValueError("Invalid or duplicate credential name")
        data = read_file(root, item["file"], CREDENTIALS_LIMIT)
        if digest(data) != item["sha256"]:
            raise ValueError("Asset digest differs from the approved SHA-256")
        materials[name] = data

    if sum(map(len, materials.values())) > CREDENTIALS_LIMIT:
        raise ValueError("Credential assets exceed 900 KiB")
    names = sorted(materials)
    arch = entry["architecture"]
    version = entry["version"]
    template = service_unit("template", config_name, arguments, names, arch, component, managed_state, restart_seconds, limit_nofile)
    fingerprint = digest(encoded([server_id, component, side, version, arch, digest(binary), digest(template),
                                  [(name, digest(materials[name])) for name in names]]))
    profile = "svc-" + fingerprint[:24]
    if component == "V2bX" and any(name in materials for name in ("route.json", "custom_outbound.json")):
        value = json.loads(materials[config_name].decode("utf-8-sig"))
        cores = [core for core in value.get("Cores", []) if core.get("Type") == "xray"]
        if not cores:
            raise ValueError("Route and Outbound files require an Xray core")
        for core in cores:
            for key, name in (("RouteConfigPath", "route.json"), ("OutboundConfigPath", "custom_outbound.json")):
                if name in materials:
                    core[key] = f"/run/credentials/nodeguard-{profile}.service/{name}"
        config = encoded(value)
        materials[config_name] = config
    if component in ("Rathole", "Backhaul"):
        from build_forwarder_bundle import native_toml
        native = tomllib.loads(materials[config_name].decode("utf-8-sig"))
        def paths(value):
            for key, item in value.items():
                if isinstance(item, dict):
                    paths(item)
                elif key in ("tls_cert", "tls_key", "pkcs12", "trusted_root", "sniffer_log") and isinstance(item, str):
                    if item.startswith("@CREDENTIALS@/"):
                        value[key] = item.replace("@CREDENTIALS@", f"/run/credentials/nodeguard-{profile}.service", 1)
                    elif item.startswith("@STATE@/"):
                        value[key] = item.replace("@STATE@", f"/var/lib/nodeguard-{profile}", 1)
        paths(native)
        materials[config_name] = native_toml(native).encode()
    if component == "V2bX" and managed_state:
        # Xray resolves relative certificate paths against the executable directory,
        # whereas V2bX/lego writes them against the working directory.
        value = json.loads(config.decode("utf-8-sig"))
        for node in value["Nodes"]:
            cert = node.get("CertConfig", {})
            for key in ("CertFile", "KeyFile"):
                name = cert.get(key)
                if isinstance(name, str) and ASSET.fullmatch(name):
                    if cert.get("CertMode") == "file":
                        if name not in materials:
                            raise ValueError("V2bX certificate file requires a credential asset")
                        cert[key] = f"/run/credentials/nodeguard-{profile}.service/{name}"
                    else:
                        cert[key] = f"/var/lib/nodeguard-{profile}/{name}"
        materials[config_name] = encoded(value)
    unit = f"nodeguard-{profile}.service"
    config_path = f"/etc/nodeguard/components/{profile}"
    artifacts = [
        (unit, "/etc/systemd/system/" + unit, service_unit(profile, config_name, arguments, names, arch, component, managed_state, restart_seconds, limit_nofile), 0o644),
        ("service-bin", f"/opt/nodeguard/components/{profile}/service-bin", binary, 0o755),
        *((name, config_path + "/" + name, materials[name], 0o600) for name in names),
    ]
    if sum(len(artifact[2]) for artifact in artifacts) > limit:
        raise ValueError("Artifacts exceed the Provision worker size limit")
    files, checksum = manifest_bundle(profile, component, version, artifacts)
    entry = {"id": profile, "serverId": server_id, "component": component, "version": version, "sha256": checksum,
             "summary": f"{component} / {arch} / {side}"}
    return (profile, files), entry


def build_forwarder(recipe, inputs, root):
    if (not isinstance(recipe, dict) or set(recipe) - {"port", "targetPort"} != {"schema", "tunnelId", "technology", *SIDES}
            or type(recipe["schema"]) is not int or recipe["schema"] != 1):
        raise ValueError("Unsupported forwarder recipe")
    if "port" in recipe and (type(recipe["port"]) is not int or not 1 <= recipe["port"] <= 65535):
        raise ValueError("Invalid forwarding port")
    if "targetPort" in recipe and ("port" not in recipe or type(recipe["targetPort"]) is not int or not 1 <= recipe["targetPort"] <= 65535):
        raise ValueError("Invalid forwarding destination port")
    component = recipe["technology"]
    if component not in FORWARDERS or not ID.fullmatch(recipe["tunnelId"]) or not isinstance(inputs, dict) or set(inputs) != set(SIDES):
        raise ValueError("Expected the Iran and foreign inputs for a forwarder")
    servers = {}
    for side in SIDES:
        endpoint = recipe[side]
        if not isinstance(endpoint, dict) or set(endpoint) != {"serverId", "outerIp"} or not ID.fullmatch(endpoint["serverId"]):
            raise ValueError("Invalid forwarder endpoint")
        if not isinstance(endpoint["outerIp"], str):
            raise ValueError("Expected an IPv4 address for the registered host")
        IPv4Address(endpoint["outerIp"])
        servers[side] = endpoint["serverId"]
    if servers["iran"] == servers["foreign"]:
        raise ValueError("Two distinct hosts are required")
    pairs, profiles = {}, []
    for side in SIDES:
        pairs[side], entry = build_profile(component, side, servers[side], inputs[side], root)
        profiles.append(entry)
    return pairs, {
        "NODEGUARD_PROVISION_PROFILES": profiles,
        "NODEGUARD_TUNNEL_PROFILES": [{
            "tunnelId": recipe["tunnelId"], "iranProfileId": pairs["iran"][0], "foreignProfileId": pairs["foreign"][0],
        }],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    paired = commands.add_parser("forwarder")
    paired.add_argument("recipe", type=Path)
    standalone = commands.add_parser("v2bx")
    standalone.add_argument("server_id")
    for command in (paired, standalone):
        command.add_argument("inputs", type=Path)
        command.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        inputs = json.loads(args.inputs.read_text(encoding="utf-8-sig"))
        if args.mode == "forwarder":
            recipe = json.loads(args.recipe.read_text(encoding="utf-8-sig"))
            packages, enrollment = build_forwarder(recipe, inputs, args.inputs.parent)
        else:
            package, profile = build_profile("V2bX", "host", args.server_id, inputs, args.inputs.parent)
            packages, enrollment = {"host": package}, {"NODEGUARD_PROVISION_PROFILES": [profile]}
        write_bundle(args.output, packages, enrollment)
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f"NodeGuard bundle: {error}\n")
    print("Built local bundles and enrollment.json.")


if __name__ == "__main__":
    main()
