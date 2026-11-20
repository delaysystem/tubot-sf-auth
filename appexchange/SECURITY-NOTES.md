# TuBot security notes for AppExchange review

This document describes the package's current security controls. It avoids
claiming that a control passed a release check until the check has been run
against the version being submitted.

## Access to Panel Agent Settings

Salesforce controls who may install a managed package. A permission set
cannot be required before installation because it does not exist in the org
until the package is installed. After installation, Salesforce assigns
`Panel_Settings_Admin_Access` to the installer. An administrator can assign
the same permission set to additional users from Setup → Permission Sets →
Panel Settings Admin Access → Manage Assignments.

The settings tab is granted by the permission set. For managed-package
compatibility, the component retains its previously published AppPage,
RecordPage, and HomePage targets because Salesforce does not allow a later
package version to remove those targets. If a component is placed on one of
those pages, it checks access before loading settings data and shows a locked
state when the user is not assigned. Apex also
checks that the running user has a direct assignment to the packaged
`Panel_Settings_Admin_Access` permission set before performing settings,
connection, backup, restore, or Simple Setup operations. The authorization
query runs in system mode because Salesforce users cannot otherwise reliably
read their own permission-set assignment; it filters the result to the
current user and the package's namespace. A custom permission granted by a
different permission set does not satisfy this check.

`Tubot_JWT_PreAuth` is a separate subscriber permission set. It authorizes
the selected integration user to use the packaged Salesforce execution
client; it does not grant access to Panel Agent Settings.

## Data and credentials

- Salesforce-to-Panel calls use HTTPS and the platform Named Credential /
  External Credential framework. The Panel login bearer is held by the
  Salesforce credential store, not a custom setting or debug log.
- The package contains no consumer secret for either External Client App.
  The org contains the public JWT certificate; the signing key is held by
  the Panel Worker as a secret.
- Channel registration sends org, channel, instance URL, and integration
  user identity. Panel verifies the JWT grant and Salesforce userinfo before
  storing the registration. The package does not send an ECA client secret.
- During the Simple Setup policy step, the administrator approves a
  Salesforce OAuth popup. The Panel callback exchanges the single-use code
  and uses the resulting access token only in that request to discover,
  update, and read back the subscriber ECA policy. The token is revoked and
  discarded. The pending row contains only short-lived state material and
  the final non-sensitive result; callback URLs and credentials are excluded
  from automatic Worker invocation logs.
- Apex never reads or forwards a Salesforce session ID. The package does not
  embed analytics or third-party client SDKs.
- The package retains an inactive Axiom Remote Site Setting and an inactive
  BT Servant CSP Trusted Site for managed-package upgrade compatibility; the
  corresponding telemetry class is an empty stub, BT's Remote Site file is
  excluded from the package, and no current code sends data to either host.

The exact data flows and endpoint families are listed in
[`EXTERNAL-ENDPOINTS.md`](EXTERNAL-ENDPOINTS.md). Production and staging
Worker resources are separated; see
[`PRODUCTION-ACCESS.md`](PRODUCTION-ACCESS.md).

## Authorization and failure behavior

Controllers and service methods enforce the settings permission on the
server. Hiding the component or tab is only a usability measure; it is not
the authorization boundary. Missing permission, a missing packaged
permission-set definition, or an authorization lookup failure denies access.
Salesforce API grant failures and org/user identity mismatches stop
registration without storing a channel mapping.

The package uses user-mode data access for ordinary business records where
the running user's CRUD, FLS, or sharing rights should apply. The only
system-mode query introduced for the settings gate reads the current user's
assignment to the package's own settings permission set.

## Release evidence

Record the exact package version and date alongside the test, analyzer,
installation, and live subscriber checks performed for an AppExchange
submission. Historical scan reports must retain the environment they scanned;
a staging report is not evidence of a production scan.
