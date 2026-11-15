"""Manifest format shared by the local NodeGuard package builders."""

from hashlib import sha256
import json
import os


MAX_BUNDLE_BYTES = 96 * 1024 * 1024


def bundle_limit(component):
    return MAX_BUNDLE_BYTES if component == "V2bX" else 64 * 1024 * 1024


def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode()


def digest(data):
    return sha256(data).hexdigest()


def manifest_bundle(profile, component, version, artifacts):
    manifest = encoded({
        "id": profile, "component": component, "version": version, "unit": f"nodeguard-{profile}.service",
        "files": [{"source": name, "target": target, "sha256": digest(data), "mode": mode}
                  for name, target, data, mode in artifacts],
    })
    files = [("manifest.json", manifest, 0o644)] + [(name, data, mode) for name, _, data, mode in artifacts]
    return files, digest(manifest)


def write_bundle(output, pairs, enrollment):
    output.mkdir(mode=0o700)
    for side, (profile, files) in pairs.items():
        directory = output / side / profile
        (output / side).mkdir(mode=0o700)
        directory.mkdir(mode=0o700)
        for name, data, mode in files:
            with os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode), "wb") as stream:
                stream.write(data)
    (output / "enrollment.json").write_bytes(encoded(enrollment))
