# TuBot — Administrator Setup Guide (Simple Setup)

Package: `TuBot` (`tubot` namespace) · Setup surface: the **Panel Agent Settings**
 Lightning tab (`tubot__Panel_Settings`), **Setup Wizard** tab.

Version under review: **1.3.0.1** · Subscriber Package Version ID
`04tg5000000F8lFAAS` (install URL:
`https://login.salesforce.com/packaging/installPackage.apexp?p0=04tg5000000F8lFAAS`).

## 1. Install

Install the managed package version under review, then assign the
`Panel_Settings_Admin_Access` permission set to the setup admin.

## 2. Connect Panel (OAuth PKCE, no client secret)

1. Open **Panel Agent Settings → Agent Settings**.
2. Click **Connect with Panel (PKCE OAuth 2.0)**. A popup opens
   `https://panel.tubot.lat/oauth/authorize` (OAuth 2.0 authorization code
   + PKCE S256, `response_type=code`).
3. Approve access. Salesforce polls Panel for the code, exchanges it for
   tokens, and stores the bearer **only** in the `Panel_External_Credential`
   principal. API calls route via `callout:Panel_Named_Credential`.
4. The header shows **Connected to Panel** with the user email, tenant,
   role, and settings-edit grant.

## 3. Run Simple Setup (the supported path, one click)

1. Open **Panel Agent Settings → Setup Wizard**.
2. Confirm the auto-selected **Integration user** and **Messaging Channel**
   (change either with the dropdowns if needed).
3. Check **"I understand Simple Setup will create the items above in this org"**.
4. Click **Run Simple Setup**. It executes, in order:
   1. Confirms the integration user and assigns `Tubot_Salesforce_API_Read`.
   2. Reuses the selected Messaging Channel (or deploys a Web Messaging
      channel + Omni-Queue + routing config and activates it).
   3. Provisions the `Tubot_SF_Channel_API` External Client App (OAuth
      client-credentials flow, Run As = integration user) via the Metadata
      API, in three phases.
   4. Registers the channel credentials with Panel and blind-verifies:
      OAuth token grant, Run-As identity match, Panel listing, local record.
5. Expected result: **"Simple Setup Complete — Channel registered and
   verified end to end."** with all four rows green.

## 4. If a step fails

- The failing row shows the underlying service message verbatim (Panel
  HTTP errors, permission propagation delays, Messaging-disabled guidance).
- "API permission assignment is still being prepared. Retry in a moment."
  means the async grant had not propagated: wait ~1 minute and re-run
  (the flow resumes; nothing is duplicated).
- "This org has Messaging disabled" means the admin must enable Messaging
  (Setup → Messaging Settings) or Enhanced Chat (Setup → Omni-Channel
  Settings) once, then re-run.

## 5. Advanced (break-glass only)

The collapsed **Advanced: Manual Setup Script** section shows the
equivalent standalone Python wizard one-liner. It is not required for
setup and exists for offline review.
