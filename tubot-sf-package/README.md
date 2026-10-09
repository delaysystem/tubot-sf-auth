# TuBot Salesforce Managed Package

This Salesforce DX project builds the namespaced `TuBot` second-generation managed package (`tubot` namespace). The package provides the Panel Settings Lightning page, Panel OAuth connection, channel-scoped Salesforce API setup, messaging configuration backup and restore, and the supporting Apex services and permission sets.

The package is prepared for AppExchange release validation. Salesforce has not approved an AppExchange listing; the package still requires the AppExchange security review and release process.

## Package contents

- `panelLoginSettings` Lightning Web Component for Panel login, configuration, and Salesforce channel setup.
- Apex services for PKCE-based Panel OAuth, External Client App setup, channel-scoped API access, backup/restore, and package installation defaults.
- `Panel_Settings_Admin_Access` for package administration. It is assigned to the installer when the org's user license permits the packaged access.
- `Panel_Messaging_Session_Admin_Access` for optional Messaging Session field access. Assign it only to users whose Salesforce licenses support Messaging.
- `Tubot_Salesforce_API_Read` for the dedicated ECA integration user; it grants API access only.

Optional flow routing and org-specific Messaging Channel setup are not part of the base `TuBot` package. Flow routing remains disabled in that package. Restore remains available for supported backup content.

## TuBot Extra messaging package (internal)

`tubot-sf-extra` is an internal, managed 2GP package in the `tubot` namespace that depends on `TuBot@1.10.0-1`. It contains the Messaging Session escalation quick action and Apex field updater, the `newBubble` and `nububble2` text bubble components, the custom header components, the routing flows, and the standard Messaging Session layout with the escalation action. The eight MessagingSession fields used by escalation are owned by the base package dependency, so Extra references them without packaging duplicate field metadata. Select the header components manually in Web Embedded Messaging setup.

The packaged `TubotExtraPostInstallHandler` invokes the packaged `TubotExtraCreateOmniRecords` Flow to create the `Chat_Routing_Config` and `Holding_Routing_Config` routing records and the `TuBot_On_Hold_DO_NOT_EDIT` skill. The handler then creates the `Chat_Queue` and `AI_Bot_Holding_Queue_100` queues with their `MessagingSession` and `MessagingEndUser` memberships, and attaches each routing record to its queue. This is idempotent across installs and upgrades. Salesforce doesn't package `QueueRoutingConfig` or `Skill` as 2GP metadata, so the Flow creates them as org records at install time. Setup runs from the package without an external shell deployment. The package uses the `tubot` namespace because automatic Apex install handlers are available for managed 2GP packages.

The `TuBot Extra t2` and `defaultFlowTuBot` routing flows can be selected in Web Embedded Messaging setup. `t100` is a Draft template only. The packaged layout adds the action to the standard `MessagingSession-Messaging Session Layout`; subscriber-created layouts are not changed. The package uses the existing `tubot` namespace, matching the base `TuBot` package.

The custom header performs local-only inbound handling. It copies inbound message text containing `echo199` into a bubble in the header, and shows `not implemented` for other inbound messages. It does not invoke Apex, `fetch`, or an external gateway. The local header test checks inbound detection, agent-message filtering, bubble content, and that no fetch is made.

Escalation updates `Escalate_To_Human__c`, `Escalation_Reason__c`, `AI_Conversation_Summary__c`, `varTargetQueueName__c`, `varRouting__c`, `varSkillLevel__c`, `varTargetSkillName__c`, and `varFlowHuman__c` using user-mode DML. Assign `TuBot_Extra_Messaging_Access` to each user who should run the action. The Apex tests assert that all eight MessagingSession values persist and that the Chat_Queue fallback is applied when routing inputs are blank. Updating these fields doesn't invoke an Omni-Channel flow by itself; deploy and select a routing flow for the channel to process them.

Run the local header logic tests with:

```bash
npm install
npm run test:lwc
```

Create a managed `tubot-sf-extra` package version from the Dev Hub. The configured post-install handler runs automatically when the version is installed:

```bash
sf package version create \
  --package tubot-sf-extra \
  --target-dev-hub <dev-hub-alias> \
  --installation-key-bypass \
  --code-coverage \
  --wait 60
```

The package is for internal installation and is not intended for AppExchange upload. If Salesforce reports that the Dev Hub has reached its daily package-version limit, retry after the limit resets.

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

### Resolve or create an install URL

`scripts/package-install-url.mjs` compares the local package source fingerprint with version tags in the selected Dev Hub. If a version matches, it prints that version's install URL. If no version matches, it creates a validated beta version with package tests and coverage, checks its coverage, and prints the new URL. The first run creates a fingerprinted version because existing versions without source tags cannot be compared reliably. When the configured `versionNumber` has already been released, the script advances to the next minor version because patch versioning is not enabled for this namespace, and updates the version name's numeric suffix when present. Optionally supply a verification org to run the repository's additional live source coverage gate before creation.

```bash
bun scripts/package-install-url.mjs \
  --target-dev-hub <dev-hub-alias>
```

Add `--promote` to promote a matching beta or to create and promote a new version. Promotion is irreversible. Use `--check-only` to query the Dev Hub without creating or promoting a version; it exits with status 2 when the source fingerprint is not present.

## Verification and security review

See [`security-review/README.md`](security-review/README.md) for static-analysis results and the release test report. The security-review directory contains the saved analyzer output and Salesforce CLI verification artifacts.

For Panel connection setup and External Client App instructions, see [Automated Salesforce Channel API Setup](SALESFORCE_CHANNEL_AUTH.md).
