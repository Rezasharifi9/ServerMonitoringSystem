"""Build a local TCP forward using a pinned Linux GOST release."""

from io import BytesIO
from ipaddress import ip_address
from pathlib import Path
import tarfile
from urllib.request import urlopen

from provision_artifacts import bundle_limit, digest


VERSION = "3.3.2"
RELEASES = {
    "amd64": "162feb43b1c284dbea599cdfe898169931af875233060dedc19432c7a9d18274",
    "arm64": "10cabc396eb644de1104fd695759444d2a8bf7b83463a8ab8f96174041e5bd18",
}


def load_binary(architecture):
    expected = RELEASES[architecture]
    asset = f"gost_{VERSION}_linux_{architecture}.tar.gz"
    cached = Path(__file__).resolve().parent / "releases" / f"v{VERSION}" / asset
    limit = bundle_limit("GOST")
    if cached.is_file():
        source = cached.open("rb")
    else:
        source = urlopen(f"https://github.com/go-gost/gost/releases/download/v{VERSION}/{asset}", timeout=18)
    with source:
        archive = source.read(limit + 1)
    if len(archive) > limit or digest(archive) != expected:
        raise ValueError("GOST release archive differs from the pinned SHA-256")
    with tarfile.open(fileobj=BytesIO(archive), mode="r:gz") as release:
        member = release.getmember("gost")
        if not member.isfile() or not 0 < member.size < limit:
            raise ValueError("Invalid GOST executable in the pinned archive")
        with release.extractfile(member) as executable:
            return executable.read()


def forward_config(port, peer_ip, target_port=None):
    target_port = port if target_port is None else target_port
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid GOST forwarding port")
    if type(target_port) is not int or not 1 <= target_port <= 65535:
        raise ValueError("Invalid GOST destination port")
    peer = ip_address(peer_ip)
    host = f"[{peer}]" if peer.version == 6 else str(peer)
    target = f"{host}:{target_port}"
    return {"services": [{
        "name": "nodeguard-forward", "addr": f":{port}",
        "handler": {"type": "tcp"}, "listener": {"type": "tcp"},
        "forwarder": {"nodes": [{"name": "foreign", "addr": target}]},
    }]}
