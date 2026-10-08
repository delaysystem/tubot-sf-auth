# tubot-sf-auth — JWT bearer API changes

Server-to-server Salesforce calls moved from per-channel ECA client
secrets to the JWT bearer flow against the packaged `Tubot_Channel_API`
execution client. Panel holds the RSA private key (`TUBOT_JWT_PRIVATE_KEY`
worker secret); the org holds only the public certificate in the packaged
ECA. Tokens are minted per request with a 3-minute assertion and verified
against userinfo before use.

Legacy rows that still carry an encrypted per-row secret keep the
client-credentials grant byte-for-byte. New registrations are JWT-only.

## Credential rows

`salesforce_auth_credential` gained two mint columns (migration
`0004_jwt_credential_rows.sql`):

- `integration_username TEXT NULL` — the JWT `sub` (pre-authorized user).
- `is_sandbox INTEGER NULL` — `1` selects the `test.salesforce.com`
  audience, `0` selects `login.salesforce.com`.

A row is a JWT row when `integration_username` is non-empty and
`is_sandbox` is 0/1 (`jwtRow()`); its `client_secret_cipher/iv` are NULL
and `client_id` is the packaged execution client constant. The token cache
keys JWT rows by username instead of secret IV.

## POST /internal/channels/register

Registration shape selects the flow:

- JWT registration: omit `clientSecret` (or send null/empty) and send
  `integrationUsername` (1–254 chars) plus boolean `isSandbox`.
  `clientId` is ignored and forced to the packaged execution client.
  Missing username/environment → 400 `invalid_connection` ("JWT
  registration requires the integration username and environment.").
- Legacy registration: `clientId` + `clientSecret` as before.

Both paths prove the grant before storing: the worker mints, then matches
userinfo `organization_id`/`user_id` against the request, and only then
upserts (201 `{ ok: true }`).

## Token fetch errors (JWT rows)

`fetchToken` posts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
with the signed assertion to the row's `instance_url`:

- `500 jwt_private_key_misconfigured` — worker secret missing or not a
  private key; never retryable by the caller.
- `422 salesforce_preauth_required` — Salesforce answered
  `invalid_app_access`, or `invalid_grant` on a JWT row: the user lacks
  `Tubot_JWT_PreAuth`, or subscriber policies were reset by a
  reinstall/upgrade. Fix: re-run `setup-eca-policies.mjs`, confirm the
  set assignment, retry.
- `422 salesforce_identity_mismatch` — the grant resolved to a different
  org or user than the registered mapping (fail closed, never stored).

Legacy rows keep the existing `salesforce_invalid_client_credentials` /
`salesforce_oauth_not_configured` mapping unchanged.

## Tenant bridge (Panel ⇄ auth worker)

`POST /internal/bridge/credential` now also returns `integrationUsername`
(string|null) and `isSandbox` (boolean|null). JWT rows return
`clientSecret: null` with both fields set; the bridge validator rejects a
null secret without a username/sandbox pair (`bridge_invalid_response`),
so half-migrated rows fail closed instead of minting as the wrong user.

## Rotation

One global keypair serves all tenants. To rotate: generate a new RSA-2048
pair, register the new certificate on the packaged ECA (ship a package
upgrade), then replace `TUBOT_JWT_PRIVATE_KEY` on every worker
(staging + production for both `tubot-sf-auth` and `tubot-new-panel`).
Grants in flight use 3-minute assertions, so the cutover needs no drain
beyond the deploy itself. There are no per-org secrets to rotate.
