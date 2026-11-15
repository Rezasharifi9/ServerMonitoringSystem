# Virtualizor integration

NodeGuard uses the Virtualizor **Enduser API**, not the administrator API.

1. Generate an API Key / API Password pair in the Virtualizor enduser panel.
2. Ensure the control plane has `NODEGUARD_CREDENTIAL_KEY` configured (64 hexadecimal characters), as required for other encrypted provider credentials.
3. In monitoring mode, open **Settings → Integrations → Virtualizor**. Save the public HTTPS panel URL (usually `https://panel.example.com:4083`), API Key and API Password.
4. Open an Iran server's details, select **Virtualizor**, and enter its VPS ID. Verify the returned hostname and IP before issuing commands. The credentials must have access to that VPS.

The tab displays power status, hostname, IP, virtualization, OS, CPU cores, RAM, disk and bandwidth allowance when supplied by the provider. It supports start, graceful shutdown, restart and forced power off, with a confirmation dialog. Refresh status after a command: acceptance does not imply that the guest has completed the operation. After a network error, refresh before retrying a command.

Settings require `settings.edit`, binding requires `server.configure`, and power commands require `server.restart`. The API rejects non-Iran server targets and simulation mode. Credentials and per-server bindings use encrypted provider storage; API responses expose only selected VPS fields. Requests enforce public HTTPS destinations, validate DNS at connection time, keep TLS verification enabled, disallow redirects and have a 15-second timeout. Power requests are never retried automatically. Settings, binding and command requests/acceptance are audited.

One Virtualizor account/panel is configured globally. Changing the panel URL requires reconnecting each VPS binding. If changing the account on the same panel, review each VPS binding before issuing commands. A VPS ID is not globally unique across panels. Disconnecting a binding does not change or delete the VPS.

Official references:
- https://www.virtualizor.com/docs/enduser/api/authentication
- https://www.virtualizor.com/docs/enduser-api/vps-info/
- https://www.virtualizor.com/docs/enduser-api/restart-vm/
- https://www.virtualizor.com/docs/enduser-api/stop-vm/

Validation: `node --experimental-transform-types tests/virtualizor.mjs`.
