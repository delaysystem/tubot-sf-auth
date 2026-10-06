# Panel connection and Salesforce API setup

This guide describes the workflows available in the installed `tubot` managed package. The package connects Panel through OAuth 2.0 PKCE, supports per-channel Salesforce API access through External Client Apps (ECAs), and includes a separate PKCE connection for package API actions.

## Install the package

Install a validated managed package version into a test or subscriber org. `PackagePostInstallHandler` initializes org-level defaults and queues assignment of `Panel_Settings_Admin_Access` to the user who started the install. A separate `Panel_Messaging_Session_Admin_Access` permission set covers optional Messaging Session fields; assign it only to users with a compatible Salesforce Messaging license.

Flow, queue, and routing configuration metadata with `IGNORE_` filenames is excluded from the package. Flow routing is off by default. The package keeps backup restore available for supported backup content.

## Connect Panel

1. Open **Panel Settings** in Salesforce.
2. Select **Connect with Panel (PKCE OAuth 2.0)** and complete authorization in the popup. Use the manual authorization-code fallback only if the popup does not return to Salesforce.
3. Salesforce stores the Panel token through the package's External Credential. This login uses PKCE S256 and does not require a client secret.

The self-org PKCE setup command only provisions the Salesforce External Client App and stores its consumer key. It does not log in to Panel or authorize this Salesforce org. Connect Panel first, then select **Connect Salesforce API** to finish the self-org authorization.

## Connect a channel ECA

Channel API access uses an External Client App with the client credentials flow. It is separate from the PKCE Panel login.

1. In **Panel Settings**, select a Messaging Channel and enter the ID of a dedicated active integration user.
2. In Salesforce Setup, create or select a Local External Client App with OAuth enabled, the `api` and `openid` scopes, and client credentials flow enabled in both OAuth settings and policies. Set **Run As** to the selected integration user.
3. Copy that ECA's consumer key and secret into the matching Panel Settings fields, then select **Connect channel API access**. The secret is sent over TLS to Panel and is not saved in Salesforce records or logged by the package.
4. The package assigns `Tubot_Salesforce_API_Read` to the selected integration user. Grant only additional object, field, and record access that the connected service requires.
5. Use **View Tool Proxy Endpoints** to inspect the tools available for the selected channel. Add additional execution users when needed; each ECA has one Run As user. Disconnect a channel to revoke its grant.

The package UI also includes the documented CLI/manual setup instructions for the separate PKCE Salesforce API connection. The CLI helper discovers the package setting's live API names, so it works with both namespaced managed installs and unnamespaced source deployments. It creates or updates its dedicated PKCE-only ECA, saves only the consumer key, and never requests or stores a client secret. Follow those instructions from the **Salesforce API connection** section when enabling package actions that run as the authorizing Salesforce user.

## Backups and restore

The Panel Settings page lists supported messaging configuration backups and provides restore actions. When metadata restoration is asynchronous, use the job ID shown in the restore result to track the Salesforce deployment. Verify the resulting configuration in Salesforce after the job completes.

## Security notes

- Do not paste an ECA consumer secret into tickets, debug logs, or chat. The channel connection sends it once to Panel over TLS.
- Panel login uses PKCE and has no client secret.
- Use a dedicated integration user for each ECA and apply Salesforce least privilege to that user.
- Disconnect an unused channel and revoke its external grant.
