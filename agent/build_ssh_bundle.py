"""Build bundles for the control plane using pinned releases and existing Provision formats."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile
import urllib.request
import zipfile
import subprocess

# Embedded Windows Python uses a fixed import path. Prefer the helpers shipped with this release.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_service_bundle import build_profile
from build_forwarder_bundle import build_panel_forwarder
from build_tunnel_bundle import SOURCE, bundle_pair, service
from provision_artifacts import digest, encoded, manifest_bundle, write_bundle

VERSION = "v0.4.0"
RELEASES = {
    "amd64": ("64", "ba694f3285a5653ce75db305b37407f553490dc524012890bacec8f0c2770253"),
    "arm64": ("arm64-v8a", "02402839a2d7a67f077a299a27250ba96ec25f27ad22826198b8392d30b50ca3"),
}


def binary_for(architecture, folder):
    suffix, expected = RELEASES[architecture]
    asset = f"V2bX-linux-{suffix}.zip"
    archive = Path(__file__).resolve().parent / "releases" / VERSION / asset
    if not archive.is_file():
        archive = folder / "release.zip"
        url = f"https://github.com/wyx2685/V2bX/releases/download/{VERSION}/{asset}"
        with urllib.request.urlopen(url, timeout=18) as response, archive.open("xb") as target:
            total = 0
            while chunk := response.read(128 * 1024):
                total += len(chunk)
                if total > 96 * 1024 * 1024:
                    raise ValueError("Release archive too large")
                target.write(chunk)
    if archive.stat().st_size > 96 * 1024 * 1024:
        raise ValueError("Release archive too large")
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        while chunk := source.read(128 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError("Pinned release digest mismatch")
    binary = folder / "V2bX"
    with zipfile.ZipFile(archive) as source:
        info = source.getinfo("V2bX")
        if info.file_size > 96 * 1024 * 1024:
            raise ValueError("Release binary too large")
        with source.open(info) as executable, binary.open("xb") as target:
            shutil.copyfileobj(executable, target, 128 * 1024)
    return binary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = json.loads(args.input.read_text(encoding="utf8"))
    folder = args.input.parent
    if data["kind"] == "v2bx":
        architecture = data["architecture"]
        binary = binary_for(architecture, folder)
        config = folder / "v2bx-config.json"
        config.write_text(data["config"], encoding="utf8")
        entry = {"version": VERSION, "architecture": architecture, "binaryFile": binary.name,
                 "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "configFile": config.name}
        entry["assets"] = []
        for key, name in (("route", "route.json"), ("outbound", "custom_outbound.json")):
            text = data.get("v2bxFiles", {}).get(key)
            if text is not None:
                content = json.dumps(json.loads(text.lstrip("\ufeff")), ensure_ascii=False).encode()
                (folder / name).write_bytes(content)
                entry["assets"].append({"name": name, "file": name, "sha256": hashlib.sha256(content).hexdigest()})
        package, enrollment = build_profile("V2bX", "host", data["serverId"], entry, folder, bool(data.get("panelNode")))
        write_bundle(args.output, {"host": package}, {"NODEGUARD_PROVISION_PROFILES": [enrollment]})
    elif data["recipe"]["technology"] in ("Rathole", "Backhaul"):
        pairs, enrollment = build_panel_forwarder(data["recipe"], data["forwarder"], folder)
        write_bundle(args.output, pairs, enrollment)
    elif data["recipe"]["technology"] == "GOST":
        recipe = data["recipe"]
        port = recipe["port"]
        target_port = recipe.get("targetPort", port)
        runtime = SOURCE.read_bytes()
        config = {"technology": "TCPForward", "localOuter": recipe["iran"]["outerIp"],
                  "peerInner": recipe["foreign"]["outerIp"], "forward": {"port": port, "targetPort": target_port}}
        profile_id = "nat-" + digest(encoded([recipe["tunnelId"], config, digest(runtime)]))[:24]
        config["profileId"] = profile_id
        unit = "nodeguard-" + profile_id + ".service"
        files, checksum = manifest_bundle(profile_id, "GOST", "1.1", [
            (unit, "/etc/systemd/system/" + unit, service(profile_id, "forward.json"), 0o644),
            ("managed_link.py", "/opt/nodeguard/components/" + profile_id + "/managed_link.py", runtime, 0o644),
            ("forward.json", "/etc/nodeguard/components/" + profile_id + "/forward.json", encoded(config), 0o644),
        ])
        package = (profile_id, files)
        profile = {"id": profile_id, "serverId": recipe["iran"]["serverId"], "component": "GOST", "version": "1.1",
                   "sha256": checksum, "summary": f"iptables TCP :{port} -> {config['peerInner']}:{target_port}",
                   "forwardPort": port}
        if target_port != port:
            profile["forwardTargetPort"] = target_port
        foreign = recipe["foreign"]
        check = {"host": foreign["outerIp"], "port": target_port}
        key = "tcp-" + digest(encoded([recipe["tunnelId"], foreign["serverId"], check]))[:24]
        manifest = encoded({"id": key, "component": "GOST", "version": "1.1", "checkTcp": check})
        endpoint = {"id": key, "serverId": foreign["serverId"], "component": "GOST", "version": "1.1",
                    "sha256": digest(manifest), "summary": f"TCP target {check['host']}:{target_port}"}
        write_bundle(args.output, {"iran": package, "foreign": (key, [("manifest.json", manifest, 0o600)])}, {
            "NODEGUARD_PROVISION_PROFILES": [profile, endpoint],
            "NODEGUARD_TUNNEL_PROFILES": [{"tunnelId": recipe["tunnelId"], "iranProfileId": profile["id"], "foreignProfileId": key}],
        })
    else:
        recipe = data["recipe"]
        keys = data.get("keys")
        material = {side: (item["key"], item["publicKey"], item["port"]) for side, item in keys.items()} if keys else None
        pairs, enrollment = bundle_pair(recipe, material=material, gost_architecture=data.get("gostArchitecture", "amd64"))
        write_bundle(args.output, pairs, enrollment)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"NodeGuard bundle error: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1) from None
