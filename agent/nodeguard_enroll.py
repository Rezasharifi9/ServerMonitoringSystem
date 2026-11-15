#!/usr/bin/env python3
"""Redeem a NodeGuard invitation and store the host credential locally."""

import argparse
from getpass import getpass
import json
import os
from pathlib import Path
from secrets import token_hex
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from agent_credentials import HEX_TOKEN, read_token_file, telemetry_url, token_path
from nodeguard_agent import ID, NoRedirects


def prepare_credential(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        token = read_token_file(path)
        if not HEX_TOKEN.fullmatch(token):
            raise ValueError("Use an empty tokenFile path for a new enrollment")
        return token
    token = token_hex(32)
    with os.fdopen(fd, "w", encoding="ascii") as stream:
        stream.write(token + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    return token


def enroll(config, code):
    endpoint = telemetry_url(config["endpoint"])._replace(path="/api/v1/agent/enroll").geturl()
    server_id = config["serverId"]
    if not ID.fullmatch(server_id) or not HEX_TOKEN.fullmatch(code):
        raise ValueError("Server ID or enrollment code is invalid")
    token = prepare_credential(token_path(config))
    payload = json.dumps({"serverId": server_id, "credential": token}).encode()
    request = Request(endpoint, data=payload, headers={
        "Authorization": "Bearer " + code,
        "Content-Type": "application/json",
    }, method="POST")
    with build_opener(NoRedirects()).open(request, timeout=10) as response:
        result = json.load(response)
        if response.status != 200 or result.get("data", {}).get("enrolled") is not True:
            raise ValueError("The control plane did not confirm enrollment")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--stdin-code", action="store_true", help="Read the one-time code from standard input")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf8"))
        code = sys.stdin.readline().strip() if args.stdin_code else getpass("NodeGuard enrollment code: ").strip()
        enroll(config, code)
    except HTTPError as error:
        parser.error("NodeGuard rejected enrollment with HTTP " + str(error.code))
    except (URLError, OSError, ValueError, KeyError, TypeError):
        parser.error("Enrollment did not finish. Check config, tokenFile permissions, and control plane connectivity.")
    print("NodeGuard Agent enrolled. The credential is stored in tokenFile.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
