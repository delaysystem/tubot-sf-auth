# Agent metadata snapshots

Agent snapshots use the registered channel's Salesforce integration user. When a dedicated metadata user is connected, extraction uses that registered user; otherwise it uses the primary integration user and requires compatible metadata permissions. They do not use the administrator's Salesforce CLI session for extraction. CLI is used separately for verification and explicit administrator setup.

TuBot Activation now provisions and registers this access in package v1 and v2. The administrator CLI helper below remains available for explicit maintenance.

## Access prerequisite

Salesforce Metadata API requires **Modify Metadata Through Metadata API Functions**, including for retrieval. Salesforce also requires View Setup and View Roles. This permission permits metadata writes; the snapshot service exposes retrieval operations only.

The extraction user must have a compatible license. An Analytics Cloud Integration User cannot receive this permission. System Analytics users cannot change licenses. The supported optional provisioning creates a dedicated metadata user with an available Salesforce Integration user license and Salesforce API Integration permission-set license. The primary SOQL user stays registered. The helper never purchases licenses or grants Modify All Data. If Einstein Prompt Templates licenses are available, it assigns one and grants read access to the GenAiPromptTemplate object and Manage Prompt Templates; this is required when planner metadata references prompt templates. Salesforce requires Manage Prompt Templates even for Metadata API retrieval; it also allows template editing. Prompt execution is not granted.

From `tubot-sf-auth`:

```sh
# Plan only; makes no changes.
bun scripts/agent-metadata-access.ts --target-org <alias>
# Existing compatible integration user.
bun scripts/agent-metadata-access.ts --target-org <alias> --apply
# Provision and register a separate API-only metadata user.
bun scripts/agent-metadata-access.ts --target-org <alias> --apply --create-metadata-user
```

The setup command independently queries each assignment after changing it. It is repeatable, reuses its dedicated user on later runs, and discovers the registered users from the package's namespaced or unnamespaced channel schema. Run the API smoke check to verify the primary connection after provisioning:

```sh
bun scripts/jwt-api-smoke.ts --target-org <alias>
```

## API

All operations use `POST /api/v1/salesforce/channels/{channelId}/agents/{operation}` on the active Panel environment, with the normal Panel bearer token. The org and channel must belong to that token's tenant. A dedicated user is registered only after a real JWT identity check and successful metadata discovery. The snapshot manifest records its execution user ID. Caller-supplied credentials, instance URLs, and tenant IDs are never used.

| Operation | Body in addition to `orgId` | Scope | Result |
| --- | --- | --- | --- |
| `verify` | none | write | Start/resume a real Metadata API retrieval check; HTTP 202 while pending, then `ready: true` |
| `connect` | `metadataUserId`, `metadataUsername` | write | Verify JWT identity and Metadata API access, then register the dedicated user |
| `list` | none | read | Agent names, types, available authoring versions, supported metadata inventory |
| `extract` | `agentName`, optional `agentType` (default `Bot`) | write | HTTP 202 with `jobId` |
| `advance` | `jobId` | write | Poll one Metadata API retrieval and start the next dependency batch |
| `status` | `jobId` | read | Persisted status and final manifest; no upstream request |
| `download` | `jobId` | read | ZIP containing original files and `manifest.json` |

Call `list`, choose an agent, call `extract`, then call `advance` approximately every two seconds until status is `complete`, `incomplete`, or `failed`. `status` does not advance a job. Retrieval jobs survive interrupted callers and serialize concurrent advance requests with a database lease. Jobs expire after one hour when next advanced. Start a new extraction if a terminal job fails.

`incomplete` means Salesforce returned warnings, omitted requested metadata, or traversal reached a safety limit. Its archive remains downloadable and the manifest describes the gaps. A failed refresh does not replace or delete previous successful snapshots.

## Contents and limits

Snapshots follow actual planner/topic/action/prompt references and include all discovered authoring versions for the chosen agent. Embedded topic/action definitions, schemas, Agent Script, graph files, Bot XML, and referenced prompt templates are preserved. Flow/Apex references are recorded, but their source is excluded. Customer records and conversation history are excluded.

Original legacy Agent Script and graph files can be Base64 encoded by Salesforce; the service preserves those bytes. File SHA-256 values refer to the original bytes, allowing direct comparison to Metadata API archives retrieved by CLI.

API versions are negotiated from the org. Legacy Bot/planner metadata uses the highest advertised version at or below v67 because Salesforce replaced that representation in v68; newer agent roots use the latest supported version. A snapshot includes both representations when the selected agent has both. Each component records its retrieval API version. Unsupported dependencies are reported explicitly.

Safety limits are 12 MB per compressed retrieve archive, 24 MB per expanded snapshot, 2,000 files/components, and 20 dependency rounds. D1 stores file contents in 48 KB chunks under authenticated team/org/channel/job keys. Downloads verify stored hashes before returning the archive. Channel teardown deletes its snapshots through cascading foreign keys.

## Live verification

```sh
bun scripts/agent-snapshot-live.ts --target-org test2 --agent Coral_Cloud_Employee_Agent
bun scripts/agent-snapshot-live.ts --target-org test1empty --agent Data360Agent
bun scripts/agent-snapshot-isolation-live.ts test2 test1empty
```

The verifier lists agents first, exercises concurrent job advancement, extracts through Panel/sf-auth with the real integration user, exercises download, retrieves the exact selected components independently through CLI, and compares every original file hash. It then reads actual BLOB chunks from remote D1 and recomputes hashes independently. Use `--job-id <id>` to resume verification of an existing job after an interrupted caller. It writes a manifest and identity evidence under `/tmp/tubot-agent-verification-<alias>`; it never prints credentials or agent file contents.

Verified against the registered production connections on 2026-10-10:

| Org alias | Selected agent | Files matching CLI and D1 | Snapshot result |
| --- | --- | --- | --- |
| test2 | Coral_Cloud_Employee_Agent | 37 | Complete, no warnings |
| test1empty | Data360Agent | 49 | Incomplete: Salesforce cannot return the referenced standard `SvcCopilotTmpl__AgentforceServiceAgent` BotTemplate |

The standard-template omission is explicit in the Data360Agent manifest. All returned files, including both legacy and modern agent representations, match the independent CLI retrieval. Each primary integration user's SOQL smoke check also passed after dedicated-user provisioning.

Bidirectional live isolation checks passed for status and download: each org can read its own snapshot and receives HTTP 404 for the other org's job ID. Supplying a different tenant ID in the request body does not change the authenticated scope.
