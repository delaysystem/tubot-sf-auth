# Salesforce auth Worker

This Worker is reachable only through Panel's `TUBOT_SF_AUTH` service binding. It stores encrypted External Client App credentials for each `(teamId, orgId, channelId)` and exposes read-only Salesforce query and record operations. Panel's D1 migration `0050_salesforce_channel_connections.sql` must be applied before the Worker receives traffic.

Set `SF_CREDENTIAL_ENCRYPTION_KEY` as a Wrangler secret containing a base64-encoded 32-byte random key. Keep the key stable: changing it without re-encrypting stored ECA secrets makes existing channel connections unusable. Panel also needs its existing `AES_MASTER_KEY` to encrypt channel secrets.

The Salesforce ECA needs client credentials flow, the `api` and `id` scopes, and a dedicated Run As integration user. The package's Panel settings page connects a selected Messaging Channel after an administrator enters the ECA consumer key and secret once.

Channel setup, ECA requirements, error codes, and recovery steps are documented in the companion app's channel-auth guide. The app automatically assigns its channel API permission set; ECA policy remains admin-controlled because Salesforce metadata deployment and secret exposure require org-level authority.

Run `bun run release:check` before deployment. This runs the auth worker tests, TypeScript checks, and a Wrangler dry run. Deploy using the workspace's `bun run deploy:changed` protocol.

Server-to-server callers authenticate with per-caller HMAC envelopes; see [RPC signing guide](docs/rpc-signing.md) for the protocol, provisioning, rotation, and how to add a caller.
