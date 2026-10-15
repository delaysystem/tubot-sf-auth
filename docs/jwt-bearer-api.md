# tubot-sf-auth — JWT bearer API changes

Server-to-server Salesforce calls use the JWT bearer flow against the
packaged `Tubot_Channel_API` execution client. Panel holds the RSA private
key (`TUBOT_JWT_PRIVATE_KEY` worker secret) and exposes a private
`PanelJwtSigner` Worker RPC to `tubot-sf-auth`; the key never leaves Panel.
The org holds only the public certificate in the packaged ECA. Tokens are
minted per request with a 3-minute assertion and verified against userinfo
before use.

Every Salesforce API call uses the packaged JWT execution client. There is
no per-channel OAuth client ID or secret storage, credential fallback, or
client-credentials grant.

## Credential source

The auth Worker loads the exact team/org/channel identity from New Panel's
`panel_salesforce_channels` row. It requires an instance URL, Salesforce user
ID, username, and sandbox bit. The Worker mints a short-lived JWT assertion
for that username and verifies `organization_id` and `user_id` through
Salesforce userinfo before using the token. The cache key includes tenant
scope, org, channel, username, sandbox status, and metadata-user registration
version.

Additional execution-user rows refer to the registered channel identity; they
do not carry separate OAuth credentials. Registration is performed by New
Panel's identity-only `POST /api/v1/salesforce/channels` endpoint, which
verifies the JWT grant before storing the mapping. Any supplied
`clientId`/`clientSecret` values are rejected.

## Token fetch errors (JWT rows)

`fetchToken` posts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
with the signed assertion to the registered org's token endpoint:

- `500 jwt_private_key_misconfigured` — worker secret missing or not a
  private key; never retryable by the caller.
- `422 salesforce_preauth_required` — Salesforce answered
  `invalid_app_access` or `invalid_grant`: the user lacks
  `Tubot_JWT_PreAuth`, or subscriber policies were reset by a
  reinstall/upgrade. Fix: re-run Simple Setup's **Authorize & continue**
  policy step, or follow its manual Setup instructions, confirm the set
  assignment, and retry. The policies CLI script remains an advanced alternative.
- `422 salesforce_identity_mismatch` — the grant resolved to a different
  org or user than the registered mapping (fail closed, never stored).

## Panel credentials in D1

Panel channel and execution-user rows are stored in `panel_salesforce_channels`
and `panel_salesforce_execution_users` in the shared D1 database. The auth
Worker reads these rows directly; channel API credentials are never stored
in D1 or returned through an HTTP proxy route. `SF_CREDENTIAL_ENCRYPTION_KEY`
only protects the separate, short-lived Salesforce setup OAuth state.

## Rotation

One global keypair serves all tenants. To rotate: generate a new RSA-2048
pair, register the new certificate on the packaged ECA (ship a package
upgrade), then replace `TUBOT_JWT_PRIVATE_KEY` on the production Panel
Worker. Rotate the isolated staging Panel secret separately. The auth
Workers use the private signing RPC and do not store a copy of the key.
Grants in flight use 3-minute assertions, so the production cutover needs
no drain beyond the deploy itself. There are no per-org secrets to rotate.

## Browser Simple Setup policy authorization

This flow is hosted exclusively on `tubot-new-panel`. Apex prepares the
subscriber permission set and assignment by DML, then starts authorization
in a separate transaction using the existing Panel Named Credential.
`POST /api/v1/salesforce/setup-oauth` returns an opaque state and the
packaged Panel Connection client's Salesforce PKCE authorize URL with
`scope=api`. Status polling requires the same Panel team and org.

The Salesforce callback consumes ten-minute, single-use state, decrypts
and clears the verifier, exchanges the code in request-local memory,
checks org identity, and performs Metadata SOAP discovery/update/readback
at API 67.0. Existing policy fields and permission-set attachments are
preserved. Token revocation is awaited on every path that obtained a token;
revocation failure is surfaced as failure. No administrator code or token
is sent to storage or logged. Only a safe outcome is persisted. The final
channel-registration JWT grant independently proves pre-authorization.
