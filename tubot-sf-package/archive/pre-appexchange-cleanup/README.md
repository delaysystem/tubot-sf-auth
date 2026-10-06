# Archive: pre-AppExchange cleanup (2026-10-06)

Files moved out of `force-app/` so they no longer ship in the managed package.
Nothing here is referenced by live package code (verified by repo-wide grep at
move time). Kept for history only — do not deploy.

Contents:
- `classes/IGNORE_*`, `lwc/IGNORE_*`, `flows/IGNORE_*` and other `IGNORE_*`
  metadata: disabled work-in-progress never wired to live code.
- `bots-Test/`: sample `Test` bot.
- `HeaderCustomController.cls`: `global` REST stub that only returned HTTP 410.
- `bots/Data360Agent/`: sample bot with zero code references.
- `messagingChannels/`, `EmbeddedServiceConfig/`, `sites/`,
  `digitalExperiences/`: sample/test Embedded Service deployments, including
  scratch-org usernames and domains. Real subscribers get channels via
  post-install, never these samples.
- `applications/`: retrieved standard apps plus demo console apps.
- `presenceUserConfigs/`, `servicePresenceStatuses/`, `layouts/`: demo Omni
  leftovers.
- `classes/OmniSupervisorSetupService*` + `permissionsets/Omni_Supervisor_Access`:
  uncalled setup service and its permset.
- `classes/EmbeddedDeploymentAdminController*`,
  `classes/PanelAgentSettingsController*`,
  `classes/SessionFieldAdminController*`: disabled-endpoint stubs (`reject()`
  + throw) with no callers outside their own rejection tests, which were
  removed with them.
- `classes/OmniChannelSetupService*`, `OmniChannelAgentProvisioningService*`,
  `OmniChannelQueueSetupService*`, `TargetSalesforceUserResolver*`:
  self-contained Omni setup cluster, unreachable from the UI, scripts,
  install handler, or any live class.
- `classes/PackageSessionFlsInitializer*`: only caller was the
  `PackagePostInstallHandler.initializeSessionFieldsFls()` wrapper, which was
  never invoked from `onInstall`; FLS provisioning now flows through the live
  `SessionField*` pipeline services. Archived with the wrapper's removal.

## Deprecated stubs shipped in 1.2.0+ (2026-10-06)

Released versions 1.1.0.4/1.0.0.16 lock component deletion (2GP requires a
Partner entitlement to delete released metadata), so the archived originals
above could not stay deleted: `force-app` carries inert documented stubs
under the same component names (9 empty classes, 3 empty test classes, the
410-only `HeaderCustomController`, the inactive `Axiom_API` remote site, and
the 3 legacy token fields). The archive keeps the last real implementations
for history. Once the metadata-removal entitlement is granted, delete the
stubs from `force-app` and cut a new version — do not restore from here.

All of the above was already excluded from package versions by `.forceignore`,
so archiving changes source only — the shipped package is byte-identical.

If any of this is ever revived, move it back into `force-app/main/default/`
and add live references plus tests.
