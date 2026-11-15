# Backup tunnel ownership

A backup can initially be assigned by POST /api/v1/tunnels with side=backup and an explicit nodeRef (inventory node ID or V2Board node key). Registration atomically writes the tunnel relationship and, for an existing inventory node, backupTunnelId and backupServerId. A second backup is rejected. V2Board imports derive an already registered backup from its nodeRef; import requests cannot select one.

The old nodes/:id/backup-route endpoint returns 410. PUT nodes/:id/routes explicitly assigns the primary, optional backup and active side from tunnels linked to the node. The node detail tunnel tab exposes these controls. The selected tunnels must use different Iran servers and the same foreign server. Selected roles are persisted atomically; unselected former backups become ordinary primary candidates so they do not block new backup registration. Shared selected routes cannot have their role changed across nodes.

If the original primary server is permanently lost, select the active backup as primary and choose no backup, then register a new backup. The old tunnel remains in inventory with installation history; this operation performs no remote deletion or SSH connection. A new primary candidate can also be registered and then selected explicitly. Relabeling the active tunnel does not change DNS; switching to a different tunnel requires fresh healthy telemetry and successful DNS synchronization. Active provisioning and failover operations block role changes. Deleting a selected primary cannot silently promote a backup.

Registration accepts no nodeDomain. New tunnel IDs are generated from node references and request identity; labels contain technology and role. Existing stored nodeDomain fields are removed by the monitor database migration. Existing IDs remain stable because agents, interfaces and deployment history reference them.

DNS switches resolve the domain from the current linked node; a bound V2Board node uses its current catalog host. Missing nodes, stale catalogs and IP-only hosts fail closed without falling back to an old tunnel domain. DNS observations and preflight resolve the same current node host.

Validation: npm run build; npm run test:backup; npm run test:management; npm run test:i18n. The backup regression uses an isolated database and mock DNS provider and covers registration, duplicates, replay, topology checks, disabled assignment APIs, domain rename, automatic switching, V2Board host changes and missing-node refusal.

These source changes do not deploy or rewrite a running production node's historical route selection. Existing inconsistent primary/backup associations require a verified data migration from explicit node references; domain matching must not be used to guess ownership.
