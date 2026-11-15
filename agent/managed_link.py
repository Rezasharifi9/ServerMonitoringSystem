#!/usr/bin/env python3
"""Bring a pinned NodeGuard point-to-point interface up or down."""

import argparse
import ipaddress
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess


LINK_TYPES = {"GRE": "gre", "IPIP": "ipip", "SIT": "sit", "GRE6": "ip6gre", "WireGuard": "wireguard", "Geneve": "geneve"}
IFNAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}\Z")
PROFILE = re.compile(r"link-(?:iran|foreign)-[a-f0-9]{24}\Z")


def address(value):
    if not isinstance(value, str):
        raise ValueError("Expected a host address")
    parsed = ipaddress.ip_address(value)
    if (parsed.is_unspecified or parsed.is_multicast or parsed.is_loopback or parsed.is_link_local
            or getattr(parsed, "scope_id", None)):
        raise ValueError("Expected an unscoped unicast address")
    return parsed


def link_config(config):
    expected = {"profileId", "technology", "interface", "mtu", "localOuter", "peerOuter", "localInner", "peerInner"}
    if "gre" in config:
        expected.add("gre")
        transport = config["gre"]
        if (config.get("technology") != "GRE" or not isinstance(transport, dict)
                or set(transport) != {"key", "port"}
                or type(transport["key"]) is not int or not 1 <= transport["key"] <= 4294967295
                or type(transport["port"]) is not int or not 1 <= transport["port"] <= 65535):
            raise ValueError("Invalid GRE UDP transport")
    if "forward" in config:
        expected.add("forward")
        forward = config["forward"]
        if not isinstance(forward, dict) or set(forward) != {"port", "targetPort"} or any(
                type(value) is not int or not 1 <= value <= 65535 for value in forward.values()):
            raise ValueError("Invalid TCP forwarding ports")
    if config.get("technology") == "Geneve":
        expected.add("vni")
        if type(config.get("vni")) is not int or not 1 <= config["vni"] <= 16777215:
            raise ValueError("Invalid Geneve VNI")
    if set(config) != expected or not PROFILE.fullmatch(config["profileId"]) or not IFNAME.fullmatch(config["interface"]):
        raise ValueError("Invalid managed link configuration")
    technology = config["technology"]
    if technology not in LINK_TYPES:
        raise ValueError("Unsupported tunnel technology")
    local, peer = address(config["localInner"]), address(config["peerInner"])
    outer, remote = address(config["localOuter"]), address(config["peerOuter"])
    if local == peer or local.version != peer.version or outer == remote or outer.version != remote.version:
        raise ValueError("Expected different local and peer addresses of the same family")
    if "forward" in config and local.version != outer.version:
        raise ValueError("iptables forwarding requires addresses of the same family")
    if technology in ("GRE", "SIT", "IPIP") and outer.version != 4 or technology == "GRE6" and outer.version != 6:
        raise ValueError("Invalid outer IP family for tunnel technology")
    if technology == "SIT" and local.version != 6 or technology == "IPIP" and local.version != 4:
        raise ValueError("Invalid inner IP family for tunnel technology")
    if type(config["mtu"]) is not int or not (1280 if local.version == 6 else 576) <= config["mtu"] <= 9000:
        raise ValueError("Invalid MTU")
    return local, peer, outer, remote


def system_command(binary, *args):
    executable = shutil.which(binary, path="/usr/sbin:/usr/bin:/sbin:/bin")
    if not executable:
        raise ValueError(f"Required executable {binary} is missing")
    response = subprocess.run([executable, *args], capture_output=True, text=True,
                              stdin=subprocess.DEVNULL, timeout=4, check=False)
    if response.returncode:
        # Preserve the kernel's diagnostic: a duplicate GRE tuple, unsupported
        # encapsulation and a busy UDP socket require different remedies.
        detail = " ".join(response.stderr.split())[:300]
        raise ValueError(f"{binary} failed while configuring the link: {detail}")
    return response.stdout


def configure_forward(config, action):
    if config.get("technology") == "TCPForward":
        if set(config) != {"profileId", "technology", "localOuter", "peerInner", "forward"} or not re.fullmatch(r"nat-[a-f0-9]{24}", config["profileId"]):
            raise ValueError("Invalid standalone forwarding configuration")
        outer, peer = address(config["localOuter"]), address(config["peerInner"])
        if outer.version != peer.version or outer == peer:
            raise ValueError("Invalid forwarding endpoints")
        if set(config["forward"]) != {"port", "targetPort"} or any(type(port) is not int or not 1 <= port <= 65535 for port in config["forward"].values()):
            raise ValueError("Invalid TCP forwarding ports")
        local = outer
    else:
        local, peer, outer, _ = link_config(config)
    port, target = (str(config["forward"][key]) for key in ("port", "targetPort"))
    binary = "iptables" if local.version == 4 else "ip6tables"
    executable = shutil.which(binary, path="/usr/sbin:/usr/bin:/sbin:/bin")
    if not executable:
        if action == "down":
            return
        raise ValueError(f"Required executable {binary} is missing")
    destination = str(peer) + ":" + target if local.version == 4 else f"[{peer}]:{target}"
    marker = ["-m", "comment", "--comment", "nodeguard:" + config["profileId"]]
    incoming = ["-d", str(outer), "-p", "tcp", "--dport", port]
    tracked = ["-m", "conntrack", "--ctorigdst", str(outer), "--ctorigdstport", port]
    interface = config.get("interface")
    outgoing = ["-o", interface] if interface else []
    returning = ["-i", interface] if interface else []
    rules = [
        ("nat", "PREROUTING", [*incoming, *marker, "-j", "DNAT", "--to-destination", destination]),
        ("nat", "OUTPUT", [*incoming, *marker, "-j", "DNAT", "--to-destination", destination]),
        ("nat", "POSTROUTING", [*outgoing, "-d", str(peer), "-p", "tcp", "--dport", target,
                                 *tracked, *marker, "-j", "MASQUERADE"]),
        ("filter", "FORWARD", [*outgoing, "-d", str(peer), "-p", "tcp", "--dport", target,
                               *tracked, *marker, "-j", "ACCEPT"]),
        ("filter", "FORWARD", [*returning, "-s", str(peer), "-p", "tcp", "--sport", target,
                               *tracked, "--ctstate", "ESTABLISHED", *marker, "-j", "ACCEPT"]),
    ]
    if action == "up":
        setting = "net.ipv4.ip_forward" if local.version == 4 else "net.ipv6.conf.all.forwarding"
        system_command("sysctl", "-w", setting + "=1")
    for table, chain, args in rules:
        check = subprocess.run([executable, "-w", "3", "-t", table, "-C", chain, *args],
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=5, check=False)
        if check.returncode not in (0, 1):
            raise ValueError("Could not inspect the managed forwarding rule")
        if action == "up" and check.returncode == 1:
            system_command(binary, "-w", "3", "-t", table, "-I", chain, *args)
        if action == "down" and check.returncode == 0:
            system_command(binary, "-w", "3", "-t", table, "-D", chain, *args)


def prune_forward_rules(config):
    outer = address(config["localOuter"])
    binary = "iptables" if outer.version == 4 else "ip6tables"
    port = str(config["forward"]["port"])
    owner = "nodeguard:" + config["profileId"]
    for table, chains in (("nat", ("PREROUTING", "OUTPUT", "POSTROUTING")), ("filter", ("FORWARD",))):
        for chain in chains:
            listing = system_command(binary, "-w", "3", "-t", table, "-S", chain)
            for line in listing.splitlines():
                args = shlex.split(line)
                if args[:2] != ["-A", chain] or "!" in args:
                    continue
                def value(option):
                    return args[args.index(option) + 1] if option in args[:-1] else ""
                marker = value("--comment")
                if marker == owner or not re.fullmatch(r"nodeguard:(?:link-iran|nat)-[a-f0-9]{24}", marker):
                    continue
                if chain in ("PREROUTING", "OUTPUT"):
                    matches = value("-j") == "DNAT" and value("--dport") == port and value("-d") in (str(outer), f"{outer}/{outer.max_prefixlen}")
                else:
                    matches = value("--ctorigdstport") == port and value("--ctorigdst") in (str(outer), f"{outer}/{outer.max_prefixlen}")
                if matches and value("-p") == "tcp":
                    system_command(binary, "-w", "3", "-t", table, "-D", chain, *args[2:])


def configure(config, action, folder, command=system_command):
    local, peer, outer, remote = link_config(config)
    interface = config["interface"]
    alias = "nodeguard:" + config["profileId"]
    technology = config["technology"]
    transport = config.get("gre")

    def fou_args():
        return ["port", str(transport["port"]), "ipproto", "47", "local", str(outer),
                "peer", str(remote), "peer_port", str(transport["port"])]

    def remove_listener():
        if not transport:
            return
        # Only remove this exact endpoint-bound listener, never a wildcard or
        # another peer's listener. Keep it if another interface still uses it.
        links = json.loads(command("ip", "-details", "-json", "link", "show"))
        if any(item.get("linkinfo", {}).get("info_data", {}).get("encap", {}).get("sport") == transport["port"] for item in links):
            return
        expected = " ".join(fou_args())
        if any(" ".join(line.split()) == expected for line in command("ip", "fou", "show").splitlines()):
            command("ip", "fou", "del", "port", str(transport["port"]), "local", str(outer),
                    "peer", str(remote), "peer_port", str(transport["port"]))

    def current_link():
        links = json.loads(command("ip", "-json", "link", "show"))
        return next((item for item in links if item["ifname"] == interface), None)

    def remove_owned():
        found = current_link()
        if found is not None:
            if found.get("ifalias") != alias:
                raise ValueError("This interface is owned by another configuration")
            command("ip", "link", "delete", "dev", interface)
            remove_listener()

    if action not in ("up", "down"):
        raise ValueError("Invalid link action")
    remove_owned()
    if action == "down":
        if "forward" in config:
            configure_forward(config, action)
        return

    args = ["link", "add", "name", interface, "type", LINK_TYPES[technology]]
    if technology == "Geneve":
        args.extend(["id", str(config["vni"]), "remote", str(remote), "dstport", "6081"])
    elif technology != "WireGuard":
        args.extend(["local", str(outer), "remote", str(remote)])
    listener_created = False
    if transport:
        command("modprobe", "fou")
        args.extend(["key", str(transport["key"]), "ttl", "64", "encap", "fou",
                     "encap-sport", str(transport["port"]), "encap-dport", str(transport["port"])])
        command("ip", "fou", "add", *fou_args())
        listener_created = True
    try:
        command("ip", *args)
    except (OSError, ValueError, subprocess.SubprocessError):
        if listener_created:
            remove_listener()
        raise
    created = current_link()
    if not created or type(created.get("ifindex")) is not int or created.get("ifalias"):
        raise ValueError("The newly created interface could not be identified")
    try:
        # iproute2 can ignore an alias passed while creating a tunnel.
        command("ip", "link", "set", "dev", interface, "alias", alias)
        if technology == "WireGuard":
            command("wg", "setconf", interface, str(folder / "wireguard.conf"))
        command("ip", "link", "set", "dev", interface, "mtu", str(config["mtu"]))
        command("ip", f"-{local.version}", "address", "add", str(local), "peer",
                f"{peer}/{peer.max_prefixlen}", "dev", interface)
        command("ip", "link", "set", "dev", interface, "up")
        if local.version == 6:
            destination = f"{peer}/{peer.max_prefixlen}"
            routes = json.loads(command("ip", "-json", "-6", "route", "show", "exact", destination, "dev", interface))
            if not routes:
                command("ip", "-6", "route", "add", destination, "dev", interface)
        if "forward" in config:
            configure_forward(config, action)
    except (OSError, ValueError, subprocess.SubprocessError):
        found = current_link()
        if found and found.get("ifindex") == created["ifindex"] and found.get("ifalias") in (None, alias):
            command("ip", "link", "delete", "dev", interface)
        if listener_created:
            remove_listener()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("up", "down"))
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf8"))
        if config.get("technology") == "TCPForward":
            configure_forward(config, args.action)
        else:
            configure(config, args.action, args.config.parent)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"NodeGuard link: {error}\n")


if __name__ == "__main__":
    main()
