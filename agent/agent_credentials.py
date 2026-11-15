"""Local credential handling shared by NodeGuard processes."""

import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit


HEX_TOKEN = re.compile(r"[a-f0-9]{64}\Z")
SYSTEMD_CREDENTIALS = Path("/run/credentials")


def validate_token(token):
    if not 32 <= len(token) <= 256 or any(char.isspace() for char in token):
        raise ValueError("Set NODEGUARD_AGENT_TOKEN or configure a private tokenFile")
    return token


def token_path(config):
    value = config.get("tokenFile")
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError("tokenFile must be an absolute path")
    return Path(value)


def _protected_credential(info, root_forbidden, service_forbidden):
    if info.st_gid != 0:
        return False
    if info.st_uid == 0:
        return not (info.st_mode & root_forbidden)
    # Older systemd gives a DynamicUser ownership of its read-only credential.
    return info.st_uid == os.geteuid() and not (info.st_mode & service_forbidden)


def _read_token_file(path, *, service=False):
    if path.is_symlink():
        raise ValueError("tokenFile must not be a symlink")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "r", encoding="ascii") as stream:
        info = os.fstat(stream.fileno())
        mode = info.st_mode
        if service:
            # systemd may expose the service's read ACL through the group mode bits.
            if not stat.S_ISREG(mode) or not _protected_credential(info, 0o337, 0o377):
                raise ValueError("Expected a protected, read-only systemd credential")
        elif not stat.S_ISREG(mode) or (os.name == "posix" and mode & 0o077):
            raise ValueError("tokenFile must be a private regular file (mode 0600)")
        return validate_token(stream.read(258).rstrip("\r\n"))


def read_token_file(path):
    return _read_token_file(path)


def read_explicit_token(path):
    directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if directory and path == Path(directory) / "agent-token":
        credentials = path.parent
        if credentials.parent != SYSTEMD_CREDENTIALS:
            raise ValueError("Expected a credential directory under /run/credentials")
        info = credentials.lstat()
        if not stat.S_ISDIR(info.st_mode) or not _protected_credential(info, 0o027, 0o277):
            raise ValueError("Expected a protected systemd credential directory")
        return _read_token_file(path, service=True)
    return read_token_file(path)


def agent_token(config):
    env_token = os.environ.get("NODEGUARD_AGENT_TOKEN")
    return validate_token(env_token) if env_token else read_token_file(token_path(config))


def telemetry_url(value):
    url = urlsplit(value)
    local = url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
    if not (url.scheme == "https" or local) or not url.hostname or url.username or url.password or url.query or url.fragment or url.path != "/api/v1/agent/telemetry":
        raise ValueError("Set endpoint to the HTTPS telemetry URL (HTTP is supported on loopback)")
    return url
