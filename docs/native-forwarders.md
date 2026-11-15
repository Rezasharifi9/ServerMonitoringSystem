# Panel-managed Rathole and Backhaul

Open a Rathole or Backhaul tunnel and use its configuration card, or select the
route under Deployments. Save the settings, then deploy or rebuild. Iran runs
the native server and the foreign host runs the native client. Both hosts need
Agent 0.5.2 or newer; update older Agents from the server page.

## Supported configuration

Rathole: independent bind/remote addresses (including bracketed IPv6), shared
and per-service tokens, any number of named TCP/UDP services up to the package
limit, heartbeat interval/timeout, retry intervals, TCP_NODELAY, TCP keepalive,
HTTP/SOCKS proxy, TCP/TLS/Noise/WebSocket transports, WebSocket TLS, TLS hostname,
trusted root and PKCS#12 identity/password, and Noise pattern/private/public keys.
Service names and every native field can also be edited in the full editor.
The schema matches the pinned v0.5.0 binary, rather than unreleased main-branch
options such as `prefer_ipv6`.

Backhaul: TCP, TCPMUX, UDP, WS, WSS, WSMUX and WSSMUX; port mappings and ranges;
bind/remote addresses; token; UDP-over-TCP; NODELAY; keepalive, heartbeat,
retry/dial timeout; connection and aggressive pools; channel size; all SMUX
fields (including upstream's `mux_recievebuffer` spelling); log level; sniffer,
web monitor and traffic log filename; pprof; TLS key/certificate; edge/CDN IP;
MSS, socket receive/send buffers and proxy protocol.

Both support separate amd64/arm64 host choices, file descriptor limits and
periodic restarts (off, 30 minutes, 1/2/4/6/12/24 hours). The latter uses
systemd RuntimeMaxSec/Restart so it is installed and removed with the managed
unit and never modifies a user's crontab. Core selection includes official
Rathole and the two amd64 modified Musixal builds. Certificate and X25519
generation are panel actions; users can also upload their own credentials.

Start, stop and restart can target either host or both through the Agent queue.
Destroy/rebuild/rollback retain the existing paired deployment workflow.
Journal logs are collected from both hosts and linked from the configuration
card. Health requires an active server service and an established client
control connection; this is explicitly labeled separately from an application
traffic test. Existing configured HTTPS probes take precedence.

Global host operations such as BBR and reboot remain on the linked server
pages. Backhaul runs with `skip_optz=true`; its process does not rewrite global
kernel settings. Traffic logs use a filename in the service's writable state
directory. Private TLS files use the managed credential directory, not arbitrary
paths in /root. Existing unmanaged shell installations are not overwritten.

## Delivery and ownership

The API validates both roles, matching transports, service names/protocols and
tokens, supported field names, asset names, canonical base64 and size limits.
Settings, tokens, private keys and credential files are AES-GCM encrypted in
`provider_credentials` under a per-tunnel scope and removed on inventory
deletion. The full editor is restricted to tunnel/deploy/server administrators;
its query cache is partitioned by actor and role and discarded on unmount.
Audit events contain no configuration values. Agent journal collection redacts
the actual configured secrets before sending messages.

`build_forwarder_bundle.py` converts validated native options into quoted TOML
and paired pinned service packages. Archive URLs, versions, architectures,
members and SHA-256 hashes are fixed in `forwarder_releases.json`. Archives can
be cached under `agent/releases/forwarders/<sha256>` or downloaded with normal
TLS verification. Only the expected executable is extracted, never archive
paths. ELF architecture and executable hashes are checked by the existing
service builder. Windows downloads use OS-trusted curl without disabling TLS
verification.

Units run as DynamicUser with systemd LoadCredential and bounded file/state
ownership. Lifecycle commands require the exact successful original job,
matching pinned files and a managed forwarder unit. Old Workers cannot claim
new service-control jobs. Package/config changes cause an explicit conflict,
not an unscoped systemctl action. Interrupted operations retain the durable
Agent journal and existing review flow.

Agent 0.5.1 also reads managed native-service cgroup state when the system bus
rejects its DynamicUser UID. The unit must have the exact managed Rathole or
Backhaul description. This preserves unprivileged telemetry. Host-scoped secret
values arrive in the authenticated telemetry plan so log redaction works without
granting the Agent access to root-only credential files. Plans are bounded to
1 MiB and redaction values to 64 KiB per host configuration.

Agent 0.5.2 reserves log capacity for managed tunnels even when V2bX fills its
log allocation. Both sources share the existing 100-entry report limit. Tests
cover one busy V2bX unit and 100 units without starving native logs.

Successful start/stop/restart jobs retain ownership of the original installation.
Only successful remove/rollback jobs invalidate it. This ensures later rebuilds
and destroys remove both original units, including after lifecycle operations.

Final removal acknowledgements remain terminal even after inventory/history
purge. An authenticated retry for a retired provisioning job returns 409, which
the existing Worker durably archives, rather than retrying a 404 indefinitely.
Authentication still runs before the retired-job check. Regression coverage
includes both authenticated and anonymous retries.

## Sources reviewed

- [Musixal Rathole installer v2](https://github.com/Musixal/Rathole-Tunnel/blob/ed49cdd88945d366141fa473dc996a6c0e57983d/rathole_v2.sh): install/core selection, IPv4/IPv6, tokens, services, heartbeats, NODELAY, status, restart, removal and periodic resets.
- [Rathole v0.5.0 configuration](https://github.com/rathole-org/rathole/blob/v0.5.0/src/config.rs) and [transport documentation](https://github.com/rathole-org/rathole/blob/main/docs/transport.md).
- [Backhaul v0.7.2 configuration](https://github.com/Musixal/Backhaul/blob/v0.7.2/config/config.go) and [README](https://github.com/Musixal/Backhaul).

Upstream license/source references remain available through these repositories
and the pinned binary registry; the wrapper's GPL-3.0 and Backhaul's AGPL-3.0
are independent from the panel's original configuration and delivery code.

## Validation

- Production Next build, TypeScript and targeted ESLint passed.
- Python suite: 74 tests run, 3 platform-specific skips, no failures.
- `tests/forwarder-settings.mjs`: permissions, encrypted persistence, schemas,
  token/service agreement, assets, real paired package build, Agent queue,
  capability negotiation, idempotency, service results, Noise and TLS passed.
- Browser: Rathole and Backhaul native forms, paired service add/remove,
  advanced editor errors, generated credentials and saved settings passed.
- Actual authenticated panel API → existing Agent queue → both authorized Linux
  hosts passed 13 transport cases: Rathole TCP/TLS/Noise/WebSocket/WebSocket+TLS
  (TCP and UDP payloads in every case), and Backhaul TCP/UDP-over-TCP/TCPMUX/
  UDP/WS/WSMUX/WSS/WSSMUX. Each case verified every installed artifact hash and
  mode, exact role-specific native TOML, durable Agent job/profile digest,
  DynamicUser, file descriptor limit and restart runtime. TCP cases also tested
  stop/start/restart on both hosts followed by another payload exchange.
  SSH was used for a loopback echo fixture and read-only installed-state checks;
  tunnel installation, rebuilding and removal were issued by the panel/Agent.
- Management and i18n checks passed. The broad pre-existing backend suite
  stopped in its GRE registration fixture: it requests a recipe for an extra
  same-node route that conflicts with an existing Iran listening port
  (`TUNNEL_PORT_EXISTS`, tests/backend.mjs around line 1322). The native-forwarder
  end-to-end tests are separate and passed; no GRE conflict rule was relaxed.

## Published installation

Published `app-run-forwarders-agentfix-20261113-r3` to the active panel on
2026-11-13 after the transport matrix passed. The preceding
`app-run-forwarders-agentfix-20261113-r2` and the runner backup remain available for
rollback. No schema changed in this corrective release; the verified database
backup remains `C:/ProgramData/NodeGuard/data/pre-forwarders-20261113-r3.sqlite`.
The authenticated production API, HTTPS deployments page, native configuration
JavaScript asset and all six cached upstream archives passed checks. Both hosts
report Agent 0.5.2 online; the existing GRE route has zero loss and about 79 ms
RTT. Temporary test routes are separate from customer traffic.

The final release also passed another panel-issued WSSMUX installation and
paired rebuild, exact installed-config/artifact checks, payload echo, and
redacted journal ingestion from both hosts (two tunnel entries each). Both
temporary units were then removed by the Agent through inventory deletion.
Final checks found no QA listeners, both provisioning Workers polling normally,
and four of four GRE ping replies in each direction with zero loss (about
77 ms). The temporary candidate scheduled task was removed.

Local evidence: `.nodeguard/native-panel-e2e-final-result.json`. It contains
transport outcomes, host roles, Agent job IDs, artifact verification results,
systemd runtime settings and cleanup identities; no configuration secrets.
