# Panel connection and Salesforce API setup

This guide describes the workflows available in the installed `tubot` managed package. The package connects Panel through OAuth 2.0 PKCE and supports per-channel Salesforce API access through a packaged JWT execution client. There are no client secrets on any path: no pasting secrets, no Setup clicks to activate tokens, no Visualforce session handling.

## Install the package

Install a validated managed package version into a test or subscriber org. `PackagePostInstallHandler` initializes org-level defaults and queues assignment of `Panel_Settings_Admin_Access` to the user who started the install. A separate `Panel_Messaging_Session_Admin_Access` permission set covers optional Messaging Session fields; assign it only to users with a compatible Salesforce Messaging license.

Salesforce's package-install permissions control who can install or upgrade the package; the package permission set cannot gate installation before it exists. After installation, only users directly assigned `Panel_Settings_Admin_Access` can open or operate Panel Agent Settings. The installing user receives this set automatically. To grant another user access, go to Setup → Permission Sets → Panel Settings Admin Access → Manage Assignments. The Lightning tab is exposed only through this set, and Apex independently checks the running user's assignment before returning settings or performing mutations.

Flow, queue, and routing configuration metadata with `IGNORE_` filenames is excluded from the package. Flow routing is off by default. The package keeps backup restore available for supported backup content.

## Packaged OAuth clients

Two External Client Apps ship inside the package (secret-less by design):

- `Tubot_Panel_Connection` — authorization code + PKCE (public client) for Panel login and user identification.
- `Tubot_Channel_API` — JWT-bearer-only execution client (`isConsumerSecretOptional=true`, certificate-registered, no client-credentials flow). Panel holds the RSA private key and mints short-lived tokens per request; Salesforce verifies the signature against the packaged certificate.

The JWT bearer flow pre-authorizes users through subscriber-side policy: the policies setup sets the execution client's permitted-users type to **Admin approved users are pre-authorized** and authorizes the unpackaged `Tubot_JWT_PreAuth` permission set. Only users holding that set can obtain tokens; everyone else fails the grant with `invalid_app_access` / `invalid_grant`.

## Connect Panel

1. Open **Panel Settings** in Salesforce.
2. Select **Connect with Panel (PKCE OAuth 2.0)** and complete authorization in the popup. The page polls Panel and connects automatically once approved — no further clicks needed. If the popup is closed or approval times out, simply connect again.
3. Salesforce stores the Panel token through the package's External Credential. This login uses PKCE S256 and does not require a client secret.

The ECA setup popup below is separate from Panel login. It grants temporary Salesforce API access only for the subscriber policy change.

## Connect a channel (Simple Setup)

1. In **Panel Settings**, open Simple Setup and pick the Messaging Channel and the dedicated active integration user.
2. Read the ECA disclosure and select **Authorize & continue**. Apex creates the subscriber-only `Tubot_JWT_PreAuth` permission set if needed and assigns the selected integration user. A Salesforce popup asks an administrator to approve API access. In one callback request, Panel exchanges the PKCE code, checks the actual org identity, discovers the installed policy record, changes permitted users to **Admin approved users are pre-authorized**, preserves existing permission-set attachments while adding `Tubot_JWT_PreAuth`, and reads the policy back. It then revokes and discards the temporary token. The wizard polls the safe outcome and continues automatically.
3. Finish the wizard. Registration sends identity only (org, channel, instance URL, integration user). Panel mints a JWT token, verifies via userinfo that the grant resolves to exactly this org and user, and only then stores the mapping. Failures surface as `preauth_required` (assign `Tubot_JWT_PreAuth` and retry) or `identity_mismatch`.
4. The wizard assigns `Tubot_Salesforce_API_Read` (API access only) to the integration user. Grant only additional object, field, and record access that the connected service requires.
5. Use **View Tool Proxy Endpoints** to inspect the tools available for the selected channel. Disconnect a channel to revoke its registration.

To decline the popup, select **Show manual steps instead**. In Setup → External Client Apps → External Client App Manager → TuBot Channel API → Policies, set permitted users to **Admin approved users are pre-authorized** and add `Tubot_JWT_PreAuth` without removing existing attachments. In Setup → Users, confirm the selected integration user's permission-set assignment, then select **Re-check & continue**. Registration's live JWT grant is the final policy check; permission-set existence alone is not proof. Retry Simple Setup if an installation or upgrade resets the policy.

The collapsed advanced alternative retains `bun scripts/setup-eca-policies.mjs --target-org <alias>`. The CLI workflows in `scripts/tubot_postinstall.py` and `scripts/tubot_auto_setup.py` use the administrator's authenticated CLI session for the policy change. Browser Simple Setup does not require either script.

## Ephemeral setup storage and verification

`POST /api/v1/salesforce/setup-oauth` and its status/audit endpoints require the existing Panel bearer. State is scoped to the initiating team and Salesforce org, expires after ten minutes, and is consumed atomically once. The PKCE verifier is AES-GCM encrypted while pending and removed before the callback contacts Salesforce. The callback never sends an authorization code or Salesforce token to a Durable Object, KV, D1, or a log. Only fixed outcome/error identifiers and a verification timestamp are recorded.

The worker requests only `api`, rejects and revokes an unexpected refresh token, and revokes the access token on success or failure. Automatic invocation logging and tracing are disabled because callback URLs contain codes. No raw Salesforce errors are returned or logged. Infrastructure outside the worker must also avoid recording callback query strings.

Run `bun scripts/verify-setup-oauth-live.ts status <org-alias> <state>` and `audit <org-alias>` from `tubot-new-panel` for independent CLI checks through the installed Named Credential. The audit returns the setup table schema and tenant-scoped outcome rows, without verifier contents. Combine this snapshot with review of the storage-write paths and logging configuration; a snapshot alone cannot prove a credential was never stored. `verify-setup-soap-live.ts <scratch-org-alias>` exercises the real SOAP helper and independently retrieves policy metadata through Salesforce CLI.

## Backups and restore

The Panel Settings page lists supported messaging configuration backups and provides restore actions. When metadata restoration is asynchronous, use the job ID shown in the restore result to track the Salesforce deployment. Verify the resulting configuration in Salesforce after the job completes.

## Security notes

- There is no ECA consumer secret anywhere: nothing to paste, rotate per org, or leak from Setup pages, debug logs, or tickets.
- Panel login uses PKCE and has no client secret.
- The private JWT signing key lives only in Panel infrastructure (worker secret). The org holds only the public certificate inside the packaged ECA.
- Use a dedicated integration user for each channel and apply Salesforce least privilege to that user.
- `Panel_Settings_Admin_Access` grants Panel settings administration; `Tubot_JWT_PreAuth` separately grants the selected integration user permission to obtain JWT grants. Assign each only as broadly as needed.
- Disconnect an unused channel to revoke its registration.
