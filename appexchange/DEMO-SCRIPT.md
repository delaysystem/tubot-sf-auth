# TuBot — Reviewer Test Script (demo org)

Goal: prove install → connect → one-click setup → verified API access in
~15 minutes on a clean org.

## Preconditions

- Fresh Developer/scratch org with Messaging + Omni-Channel available.
- The managed package version under review installed.
- `Panel_Settings_Admin_Access` assigned to the tester.
- A Panel account (any Kinde-backed login) for the OAuth step.

## Script

1. **Install check.** Open the **Panel Agent Settings** tab (`Panel_Settings`).
   Expect the header "Panel OAuth 2.0 & Channel API Settings" with tabs
   Setup Wizard / Agent Settings / Messaging Backups.
2. **Panel login.** Agent Settings → **Login with Panel** → approve in the
   popup. Expect **Connected to Panel** + user email + tenant + owner/admin
   role. (Backend: PKCE code exchange; token in External Credential only.)
3. **Simple Setup.** Setup Wizard → confirm the pre-selected Integration
   user and Messaging Channel (or change them) → check the consent box →
   **Run Simple Setup**.
4. **Expected result.** All four rows green, ending in **"Simple Setup
   Complete — Channel registered and verified end to end."**
5. **Blind checks (independent of the UI).** In Developer Console / CLI:
   - `PermissionSetAssignment` for `Tubot_Salesforce_API_Read` exists on
     the chosen user.
   - The Messaging Channel is active; the queue has the user as member.
   - External Client App `Tubot_SF_Channel_API` exists with the OAuth
     client-credentials flow enabled and Run As = integration user.
   - `Tubot_API_Channel__c` row matches channel + user.
   - Authenticated `GET https://panel.tubot.lat/api/v1/salesforce/channels?orgId=<orgId>`
     lists the channel ID.
6. **Failure drill (optional).** Deactivate the chosen integration user,
   re-run: expect a clear "no longer available" step failure (fail-closed,
   no silent substitution).

## What not to test

- The collapsed **Advanced: Manual Setup Script** is break-glass only.
- Legacy manual UI (step wizard, connection details, per-channel API
  access) is intentionally hidden behind `showLegacySetupUi`; Simple
  Setup is the supported path.
