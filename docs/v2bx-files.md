# V2bX Route and Outbound files

Settings → General includes a shared file editor. Save stores an encrypted
global template without changing servers. **Apply to all and restart V2bX** saves
the template and visits every foreign server from the current inventory in turn.
For each server it replaces the files and paths, restarts every supported Xray
V2bX service (including stopped services), checks the service state, then updates
that server's saved copy. Failures roll back that host and do not stop the other
hosts. A per-host result list reports successes and errors. Keep Settings open
until the operation finishes; this is a foreground operation. Missing SSH access,
busy servers, missing installations, and unsupported cores are reported as errors.
Running the action again retries the current foreign-server list.

Foreign server details include an editor and JSON upload for `route.json` and
`custom_outbound.json`. Save replaces the panel copy for that server. Removing a
file in the editor and saving disables its path. Files are encrypted using the
control plane credential key and their content is excluded from audit entries.

Select **Apply now** to update an existing installation using the server's saved
SSH connection. This updates all supported V2bX Xray services on that host,
preserves other configuration fields and credentials, and restarts active
services. Failed restarts restore the previous files. The editor displays the
panel copy, not files independently changed on the host.

During installation, **Apply saved Route and Outbound files** controls whether
the saved files are included. Save editor changes before starting installation.
The files require an Xray core; sing configurations are rejected.

The official Xray configuration declares `RouteConfigPath` and
`OutboundConfigPath` in the Xray core configuration:
[V2bX Xray configuration](https://github.com/wyx2685/V2bX/blob/dev_new/conf/xray.go).
They belong in an entry of `Cores` with `Type: "xray"`, not in `Nodes`.

Managed installations use systemd credentials, so paths point to
`/run/credentials/nodeguard-<profile>.service/route.json` and
`/run/credentials/nodeguard-<profile>.service/custom_outbound.json`. Source files
are installed privately alongside the main configuration. Stock installations
use `/etc/V2bX/route.json` and `/etc/V2bX/custom_outbound.json`.

Apply-now changes do not regenerate the original immutable installation bundle.
Reinstalling that original bundle restores its original files; a fresh install
with the saved-files option builds a new bundle from the current saved copy.
