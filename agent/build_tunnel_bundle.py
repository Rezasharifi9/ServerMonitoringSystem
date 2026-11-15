#!/usr/bin/env python3
"""Build two local, pinned Provision bundles from a NodeGuard tunnel recipe."""

import argparse
import base64
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

from managed_link import IFNAME, LINK_TYPES, address, link_config
from provision_artifacts import digest, encoded, manifest_bundle, write_bundle


VERSION = "1.2"
SIDES = ("iran", "foreign")
IDENTIFIER = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}\Z")
SOURCE = Path(__file__).with_name("managed_link.py")


def validate_key(value):
    raw = base64.b64decode(value, validate=True)
    if len(raw) != 32 or not any(raw) or base64.b64encode(raw).decode() != value:
        raise ValueError("Invalid WireGuard key")
    return value


def wg_public(private):
    binary = shutil.which("wg")
    if not binary:
        raise ValueError("Install wireguard-tools to derive the public keys")
    result = subprocess.run([binary, "pubkey"], input=private + "\n", capture_output=True, text=True, timeout=10, check=False)
    if result.returncode:
        raise ValueError("WireGuard could not derive the public key")
    return validate_key(result.stdout.strip())


def service(profile, config="link.json"):
    base = "/etc/nodeguard/components/" + profile
    program = "/usr/bin/python3 /opt/nodeguard/components/" + profile + "/managed_link.py"
    return f"""[Unit]
Description=NodeGuard managed point-to-point link {profile}
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={program} up {base}/{config}
ExecStopPost={program} down {base}/{config}
TimeoutStartSec=15
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
""".encode()


def checked_recipe(recipe, foreign_interface):
    if set(recipe) - {"port", "targetPort", "greTransport"} != {"schema", "tunnelId", "technology", "mtu", *SIDES} or type(recipe["schema"]) is not int or recipe["schema"] != 1:
        raise ValueError("Unsupported tunnel recipe")
    if "greTransport" in recipe and (recipe["technology"] != "GRE" or recipe["greTransport"] not in ("native", "udp")):
        raise ValueError("Invalid GRE transport")
    if "targetPort" in recipe and "port" not in recipe:
        raise ValueError("TCP destination port requires a listener")
    if "targetPort" in recipe and (type(recipe["targetPort"]) is not int or not 1 <= recipe["targetPort"] <= 65535):
        raise ValueError("Invalid TCP destination port")
    if not IDENTIFIER.fullmatch(recipe["tunnelId"]) or recipe["technology"] not in LINK_TYPES:
        raise ValueError("Unsupported tunnel identifier or technology")
    endpoints = {}
    for side in SIDES:
        item = recipe[side]
        if set(item) != {"serverId", "interfaceName", "innerIp", "outerIp"} or not IDENTIFIER.fullmatch(item["serverId"]):
            raise ValueError("Invalid tunnel endpoint")
        interface = item["interfaceName"]
        if side == "foreign" and foreign_interface:
            if interface and interface != foreign_interface:
                raise ValueError("Foreign interface differs from the registered topology")
            interface = foreign_interface
        if not isinstance(interface, str) or not IFNAME.fullmatch(interface):
            raise ValueError("Both interface names are needed; use --foreign-interface if the recipe leaves it empty")
        endpoints[side] = {**item, "interfaceName": interface, "innerIp": str(address(item["innerIp"])), "outerIp": str(address(item["outerIp"]))}
    if endpoints["iran"]["serverId"] == endpoints["foreign"]["serverId"]:
        raise ValueError("Two distinct hosts are required")
    return endpoints


def wireguard_conf(material, side, peer_side, peer):
    private, _, port = material[side]
    _, public, peer_port = material[peer_side]
    inner, outer = address(peer["innerIp"]), address(peer["outerIp"])
    endpoint = f"[{outer}]" if outer.version == 6 else str(outer)
    return (f"[Interface]\nPrivateKey = {private}\nListenPort = {port}\n\n"
            f"[Peer]\nPublicKey = {public}\nEndpoint = {endpoint}:{peer_port}\n"
            f"AllowedIPs = {inner}/{inner.max_prefixlen}\nPersistentKeepalive = 25\n").encode()


def bundle_pair(recipe, foreign_interface=None, material=None, *, gost_architecture="amd64"):
    endpoints = checked_recipe(recipe, foreign_interface)
    technology = recipe["technology"]
    if technology == "WireGuard":
        if not material or set(material) != set(SIDES):
            raise ValueError("WireGuard requires both local private keys and listen ports")
        for private, public, port in material.values():
            validate_key(private)
            validate_key(public)
            if type(port) is not int or not 1 <= port <= 65535:
                raise ValueError("Invalid WireGuard port")
        if len({item[1] for item in material.values()}) != 2:
            raise ValueError("WireGuard peers must have different keys")
    elif material:
        raise ValueError("Only WireGuard uses key material")

    forward_port = recipe.get("port")
    runtime = SOURCE.read_bytes()
    pairs = {}
    profiles = []
    for side, peer_side in (SIDES, SIDES[::-1]):
        local, peer = endpoints[side], endpoints[peer_side]
        forwarding = side == "iran" and forward_port is not None
        wireguard = wireguard_conf(material, side, peer_side, peer) if material else None
        config = {
            "technology": technology, "interface": local["interfaceName"], "mtu": recipe["mtu"],
            "localOuter": local["outerIp"], "peerOuter": peer["outerIp"], "localInner": local["innerIp"], "peerInner": peer["innerIp"],
        }
        if technology == "GRE" and recipe.get("greTransport", "udp") == "udp":
            # Both endpoints must derive the same transport independently of the
            # profile digest (which differs between sides and forwarding ports).
            identity = digest(recipe["tunnelId"].encode())
            config["gre"] = {"key": 1 + int(identity[:8], 16) % 4294967295,
                             "port": 20000 + int(identity[8:16], 16) % 40000}
        if forwarding:
            config["forward"] = {"port": forward_port, "targetPort": recipe.get("targetPort", forward_port)}
        if technology == "Geneve":
            config["vni"] = 1 + int(digest(recipe["tunnelId"].encode())[:6], 16) % 16777215
        inputs = [recipe["tunnelId"], VERSION, local["serverId"], peer["serverId"], config,
                  digest(runtime), digest(service("template")), digest(wireguard) if wireguard else None]
        fingerprint = digest(encoded(inputs))
        profile = f"link-{side}-{fingerprint[:24]}"
        config["profileId"] = profile
        link_config(config)
        unit = "nodeguard-" + profile + ".service"
        components = "/etc/nodeguard/components/" + profile
        artifacts = [
            (unit, "/etc/systemd/system/" + unit, service(profile), 0o644),
            ("managed_link.py", "/opt/nodeguard/components/" + profile + "/managed_link.py", runtime, 0o644),
            ("link.json", components + "/link.json", encoded(config), 0o644),
        ]
        if wireguard:
            artifacts.append(("wireguard.conf", components + "/wireguard.conf", wireguard, 0o600))
        files, checksum = manifest_bundle(profile, technology, VERSION, artifacts)
        pairs[side] = (profile, files)
        entry = {
            "id": profile, "serverId": local["serverId"], "component": technology, "version": VERSION,
            "sha256": checksum, "summary": f"{technology} / {local['interfaceName']} → {peer['innerIp']}",
        }
        if technology == "GRE":
            entry["greTransport"] = recipe.get("greTransport", "udp")
            entry["summary"] += f" / GRE over UDP :{config['gre']['port']}" if "gre" in config else " / Native GRE (IP protocol 47)"
        if forwarding:
            entry["forwardPort"] = forward_port
            target_port = recipe.get("targetPort") or forward_port
            if target_port != forward_port:
                entry["forwardTargetPort"] = target_port
            entry["summary"] += f" / iptables TCP :{forward_port}"
            if target_port != forward_port:
                entry["summary"] += f" → :{target_port}"
        profiles.append(entry)
    enrollment = {
        "NODEGUARD_PROVISION_PROFILES": profiles,
        "NODEGUARD_TUNNEL_PROFILES": [{
            "tunnelId": recipe["tunnelId"], "iranProfileId": pairs["iran"][0], "foreignProfileId": pairs["foreign"][0],
        }],
    }
    return pairs, enrollment


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recipe", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--foreign-interface")
    parser.add_argument("--gost-architecture", choices=("amd64", "arm64"), default="amd64", help=argparse.SUPPRESS)
    for side in SIDES:
        parser.add_argument(f"--{side}-key-file", type=Path)
        parser.add_argument(f"--{side}-port", type=int)
    args = parser.parse_args()
    try:
        recipe = json.loads(args.recipe.read_text(encoding="utf8"))
        material = None
        if recipe["technology"] == "WireGuard":
            material = {}
            for side in SIDES:
                path, port = getattr(args, side + "_key_file"), getattr(args, side + "_port")
                if not path or port is None:
                    raise ValueError("Both key files and both UDP ports are required for WireGuard")
                private = validate_key(path.read_text(encoding="ascii").strip())
                material[side] = private, wg_public(private), port
        elif any(getattr(args, side + "_key_file") or getattr(args, side + "_port") is not None for side in SIDES):
            raise ValueError("Only WireGuard accepts keys and ports")
        pairs, enrollment = bundle_pair(recipe, args.foreign_interface, material, gost_architecture=args.gost_architecture)
        write_bundle(args.output, pairs, enrollment)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError, tarfile.TarError) as error:
        parser.exit(1, f"NodeGuard bundle: {error}\n")
    print("Built both bundles and enrollment.json.")


if __name__ == "__main__":
    main()
