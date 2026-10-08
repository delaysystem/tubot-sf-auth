# Panel connection and Salesforce API setup

This guide describes the workflows available in the installed `tubot` managed package. The package connects Panel through OAuth 2.0 PKCE and supports per-channel Salesforce API access through a packaged JWT execution client. There are no client secrets on any path: no pasting secrets, no Setup clicks to activate tokens, no Visualforce session handling.

## Install the package

Install a validated managed package version into a test or subscriber org. `PackagePostInstallHandler` initializes org-level defaults and queues assignment of `Panel_Settings_Admin_Access` to the user who started the install. A separate `Panel_Messaging_Session_Admin_Access` permission set covers optional Messaging Session fields; assign it only to users with a compatible Salesforce Messaging license.

Flow, queue, and routing configuration metadata with `IGNORE_` filenames is excluded from the package. Flow routing is off by default. The package keeps backup restore available for supported backup content.

## Packaged OAuth clients

Two External Client Apps ship inside the package (secret-less by design):

- `Tubot_Panel_Connection` — authorization code + PKCE (public client) for Panel login and user identification.
- `Tubot_Channel_API` — JWT-bearer-only execution client (`isConsumerSecretOptional=true`, certificate-registered, no client-credentials flow). Panel holds the RSA private key and mints short-lived tokens per request; Salesforce verifies the signature against the packaged certificate.

The JWT bearer flow pre-authorizes users through subscriber-side policy: the policies setup sets the execution client's permitted-users type to **Admin approved users are pre-authorized** and authorizes the unpackaged `Tubot_JWT_PreAuth` permission set. Only users holding that set can obtain tokens; everyone else fails the grant with `invalid_app_access` / `invalid_grant`.

## Connect Panel

1. Open **Panel Settings** in Salesforce.
2. Select **Connect with Panel (PKCE OAuth 2.0)** and complete authorization in the popup. Use the manual authorization-code fallback only if the popup does not return to Salesforce.
3. Salesforce stores the Panel token through the package's External Credential. This login uses PKCE S256 and does not require a client secret.

The package UI also includes the documented CLI/manual setup instructions for the separate PKCE Salesforce API connection used by package actions that run as the authorizing Salesforce user.

## Connect a channel (Simple Setup)

1. In **Panel Settings**, open Simple Setup and pick the Messaging Channel and the dedicated active integration user.
2. Run the one policies command shown by the ECA step (once per org; it uses your own authenticated CLI session and applies the unpackaged pre-authorization). Re-run it after every package install or upgrade: reinstalling resets subscriber ECA policies to defaults.
3. Finish the wizard. Registration sends identity only (org, channel, instance URL, integration user). Panel mints a JWT token, verifies via userinfo that the grant resolves to exactly this org and user, and only then stores the mapping. Failures surface as `preauth_required` (assign `Tubot_JWT_PreAuth` and retry) or `identity_mismatch`.
4. The wizard assigns `Tubot_Salesforce_API_Read` (API access only) to the integration user. Grant only additional object, field, and record access that the connected service requires.
5. Use **View Tool Proxy Endpoints** to inspect the tools available for the selected channel. Disconnect a channel to revoke its registration.

The same flow is available headlessly via `scripts/tubot_postinstall.py` (interactive wizard) and `scripts/tubot_auto_setup.py` (fully automatic); both register with the identity-only JWT payload and blind-verify every mutation.

## Backups and restore

The Panel Settings page lists supported messaging configuration backups and provides restore actions. When metadata restoration is asynchronous, use the job ID shown in the restore result to track the Salesforce deployment. Verify the resulting configuration in Salesforce after the job completes.

## Security notes

- There is no ECA consumer secret anywhere: nothing to paste, rotate per org, or leak from Setup pages, debug logs, or tickets.
- Panel login uses PKCE and has no client secret.
- The private JWT signing key lives only in Panel infrastructure (worker secret). The org holds only the public certificate inside the packaged ECA.
- Use a dedicated integration user for each channel and apply Salesforce least privilege to that user.
- Disconnect an unused channel to revoke its registration.
