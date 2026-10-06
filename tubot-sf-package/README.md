# TuBot Salesforce Managed Package

This Salesforce DX project builds the namespaced `TuBot` second-generation managed package (`tubot` namespace). The package provides the Panel Settings Lightning page, Panel OAuth connection, channel-scoped Salesforce API setup, messaging configuration backup and restore, and the supporting Apex services and permission sets.

The package is prepared for AppExchange release validation. Salesforce has not approved an AppExchange listing; the package still requires the AppExchange security review and release process.

## Package contents

- `panelLoginSettings` Lightning Web Component for Panel login, configuration, and Salesforce channel setup.
- Apex services for PKCE-based Panel OAuth, External Client App setup, channel-scoped API access, backup/restore, and package installation defaults.
- `Panel_Settings_Admin_Access` for package administration. It is assigned to the installer when the org's user license permits the packaged access.
- `Panel_Messaging_Session_Admin_Access` for optional Messaging Session field access. Assign it only to users whose Salesforce licenses support Messaging.
- `Tubot_Salesforce_API_Read` for the dedicated ECA integration user; it grants API access only.

Flow, queue, routing-config, Messaging Channel, and other disabled metadata remain in source with `IGNORE_` filenames or are excluded by `.forceignore`. They are not part of the distributable package. Flow routing is off by default. Restore remains available for supported backup content.

## Build and install

Prerequisites: Salesforce CLI (`sf`), a Dev Hub with 2GP enabled, and the registered `tubot` namespace.

Create a package version with the package's tests and coverage validation:

```bash
sf package version create \
  --package TuBot \
  --target-dev-hub <dev-hub-alias> \
  --installation-key-bypass \
  --code-coverage \
  --wait 30
```

Salesforce requires at least 75% cumulative Apex coverage for a managed package version, with every packaged trigger at 100%. The current source contains no packaged triggers. The repository coverage gate checks both requirements against the exact candidate source:

```bash
bun scripts/check-release-coverage.mjs --target-org <verification-org>
```

Install a validated beta version into a test org:

```bash
sf package install \
  --package <subscriber-package-version-id> \
  --target-org <test-org-alias> \
  --wait 30 \
  --no-prompt
```

`PackagePostInstallHandler` initializes org-level messaging defaults, clears legacy plaintext Panel token fields, and attempts to assign the core admin permission set asynchronously. Flow routing remains disabled unless an administrator changes the setting. The optional Messaging Session permission set may require a Messaging-capable user license.

The helper script `deploy_package.sh --mode package` checks the candidate source coverage, creates a package version with `--code-coverage`, checks the resulting version report, and only then installs or promotes it. Do not promote a version until the AppExchange security review and release approvals are complete.

## Verification and security review

See [`security-review/README.md`](security-review/README.md) for static-analysis results and the release test report. The security-review directory contains the saved analyzer output and Salesforce CLI verification artifacts.

For Panel connection setup and External Client App instructions, see [Automated Salesforce Channel API Setup](SALESFORCE_CHANNEL_AUTH.md).
