# GRE deployment transport

New GRE bundles (version 1.2) use kernel GRE over UDP (FOU). Both sides derive
the same nonzero GRE key and UDP port from the tunnel ID. The UDP listener is
bound to the local public IP, remote public IP and remote source port. The
profile summary includes the transport port. TCP forwarding ports remain
independent from the tunnel's UDP transport port.

This addresses two separate failures: protocol-47 packets carrying inner IPv4
may be dropped before reaching the peer, and Linux rejects multiple unkeyed
GRE interfaces with the same public endpoint pair even when interface names
differ. A link being UP does not prove that its peer is reachable.

`managed_link.py` creates the listener, interface, addresses and ownership alias.
Restart removes and recreates only the owned interface and exact listener.
Partial failures clean up newly allocated listeners. A listener used by another
interface is retained. Existing configs without `gre` retain their raw GRE
behavior. Busy ports fail without replacing foreign listeners.

Hosts need the `fou` kernel module and iproute2 FOU support. Upgrade the Agent
helper on both target hosts before deploying this format: the Provision worker
imports `managed_link.py` for the removal fallback. New Agent installer packages
include this helper. Bundled systemd units use their own pinned runtime.

## Production verification on 2026-11-13

The active panel's `agent/build_tunnel_bundle.py` and `agent/managed_link.py` were
updated, with previous versions backed up under
`C:\ProgramData\NodeGuard\data\gre-panel-backup-20261113-r1`.
Both target hosts' Agent helpers were updated with `.pre-gre-udp` backups.

The panel route between `IR-94.182.129.110` and `DE-109.70.74.197` was installed
and rebuilt through `/api/v1/provision/deploy`. Both removal jobs and both
replacement installation jobs succeeded. Both deployments ended with
`succeeded / verify / link_verified`. The authenticated workspace API confirmed
`healthy`, zero loss and approximately 76 ms RTT.

The panel-managed interface is `ng2578dfc365a3`, with inner addresses
`10.254.0.1` (Iran) and `10.254.0.2` (foreign), MTU 1320 and UDP port 32912.
Ten unbound pings and three full-MTU nonfragmenting pings passed in each
direction after the final rebuild.

The temporary standalone `nodeguard-gre-fou.service`, `germany_GRE` interface
and UDP 47821 listener were removed. The standalone service/script were moved
to `/root/gre-panel-repair-20261113/` on each host. One orphan foreign-side
service for a route absent from current inventory/bindings was disabled:
`nodeguard-link-foreign-29d921c6505a6ad7ed1675b2.service`. It duplicated the
peer route for `10.254.0.1` and sent echo replies toward a different Iran host.
Its installed files were retained; interface and routing diagnostics are in
`/root/gre-panel-repair-20261113/` on the foreign host.

Validation: tunnel/service bundle tests (13 passed); Provision worker tests
(21 passed, one skipped); live kernel up/up/down test confirmed FOU cleanup;
panel install and rebuild, live health, two-way ICMP and full-MTU checks passed.
