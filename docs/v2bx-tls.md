# V2bX certificate paths and panel settings

NodeGuard pins wyx2685/V2bX v0.4.0. Its protocol configuration is read live
from `/api/v1/server/UniProxy/config`, using the panel server token and the
selected NodeID/NodeType. Transport paths, TCP HTTP headers, Reality keys,
flow, encryption, routes and bandwidth remain controlled by this API.
Putting those fields in NodeGuard's local node options does not override the API.

Certificate options are local V2bX settings. NodeGuard reads TLS mode from
UniProxy, and obtains certificate SNI/insecure settings from both UniProxy and
the admin node record. This is necessary because V2Board's VMess response
does not include its admin `tlsSettings`. CamelCase and snake_case fields are
handled, with camelCase taking priority as in V2bX's parser.

TLS uses HTTP-01 certificates unless the node explicitly allows insecure
certificates, in which case the existing self-signed policy applies. Reality
and plain VMess/VLESS do not request certificates. Trojan and Hysteria require
TLS. HTTP-01 requires the certificate domain to resolve to this server and
public TCP port 80 to reach V2bX during issuance/renewal. It cannot validate a
domain terminating only at another tunnel endpoint without forwarding the challenge.

Relative certificate filenames are unsafe: lego writes relative to the service
working directory, while Xray can resolve the same name under the binary
directory. Managed bundles therefore set absolute certificate/key paths under
`/var/lib/nodeguard-<profile>/`, which systemd creates with mode 0700 for the
dynamic service user. Supplied file-mode credential assets use absolute systemd
credential paths. The installation files remain read-only to the service.

For a previously installed service reporting a missing file under
`/opt/nodeguard/components/`, deploy the updated NodeGuard code and perform a
fresh installation from the selected V2Board node so the bundle is regenerated.
Restarting or replaying an old bundle preserves its old paths. Confirm issuance
and startup in the new service journal. No production server was accessed by
the local regression tests.

The pinned Xray backend accepts TCP, WS, gRPC, HTTPUpgrade and SplitHTTP/XHTTP
for VMess/VLESS, and TCP, WS and gRPC for Trojan. Unsupported transports are
rejected before building an installation instead of being silently substituted.

Validation:

    node tests/v2bx-config.mjs
    python -B -m unittest discover -s tests -p service_bundle_test.py
    python -B -m unittest discover -s tests -p provision_worker_test.py

Upstream references:

- https://github.com/wyx2685/V2bX/blob/v0.4.0/api/panel/node.go
- https://github.com/wyx2685/V2bX/blob/v0.4.0/node/cert.go
- https://github.com/wyx2685/V2bX/blob/v0.4.0/core/xray/inbound.go
