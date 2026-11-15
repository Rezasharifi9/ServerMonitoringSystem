"""Fixed SSH entry point for bootstrapping the NodeGuard Agent."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory

LIMIT = 1024 * 1024
PYTHON = "/usr/bin/python3"
SHA = re.compile(r"[a-f0-9]{64}\Z")


def receive(stream, path, size, checksum):
    if type(size) is not int or not 0 <= size <= LIMIT or not SHA.fullmatch(checksum):
        raise ValueError("Invalid file envelope")
    digest = hashlib.sha256()
    with path.open("xb") as output:
        while size:
            chunk = stream.read(min(size, 128 * 1024))
            if not chunk:
                raise ValueError("Incomplete upload")
            size -= len(chunk)
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    if digest.hexdigest() != checksum:
        raise ValueError("Upload checksum mismatch")


def bootstrap(stream, message):
    interface = message["interface"]
    if interface is not None and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,14}", interface):
        raise ValueError("Invalid interface")
    code = message["code"]
    if code is not None and not SHA.fullmatch(code):
        raise ValueError("Invalid invitation")
    print("NODEGUARD_PHASE:upload", file=sys.stderr, flush=True)
    with TemporaryDirectory() as folder:
        installer = Path(folder) / "install.py"
        if message["size"] > 1024 * 1024:
            raise ValueError("Oversized installer")
        receive(stream, installer, message["size"], message["sha256"])
        if stream.read(1):
            raise ValueError("Unexpected trailing data")
        command = [PYTHON, "-I", str(installer), "--with-provision"]
        if interface is None and code is not None:
            routes = Path("/proc/net/route").read_text().splitlines()[1:]
            defaults = [row.split() for row in routes if len(row.split()) >= 7]
            default = min((row for row in defaults if row[1] == "00000000" and int(row[3], 16) & 1),
                          key=lambda row: int(row[6]), default=None)
            if default is not None:
                interface = default[0]
        if interface:
            command.extend(["--interface", interface])
        if code is None:
            command.append("--reuse-credential")
        else:
            command.extend(["--install", "--stdin-code"])
        subprocess.run(command, input=(code + "\n").encode() if code else b"", timeout=480,
                       stdout=subprocess.DEVNULL, check=True)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        if os.geteuid() != 0:
            raise ValueError("Root required")
        stream = sys.stdin.buffer
        message = json.loads(stream.readline(32768))
        if message["kind"] == "agent":
            bootstrap(stream, message)
        else:
            raise ValueError("Unknown operation")
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        sys.exit(1)
