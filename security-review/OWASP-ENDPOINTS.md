# OWASP API endpoint review — 2026-09-30

Historical baseline. The subsequent **sf-auth-only** fixes and verification are in
[OWASP-AUTH-REMEDIATION.md](OWASP-AUTH-REMEDIATION.md). Original probe evidence is
preserved in `owasp-endpoints-before.json`; the current `owasp-endpoints.json`
covers the seven sf-auth checks.

## Result

Reviewed `tubot-sf-auth`, `tubot-sf-data360`, `retrieve64`, `tubot-sf-parser`, and
`tubot-agentcode`. The 16 targeted security checks produced **4 passes and 12 failures**.
Auth's existing baseline suite passed **78/78 tests (483 assertions)**.
These services do not currently meet the project's zero trust and tenant isolation requirements.

Checks map to [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/).
This is a targeted local review, not a full penetration test or AppExchange approval.

## Findings

Severity below is reviewer-assigned from observed behavior, not an automated scanner score.

| Priority | Service / category | Evidence and impact | Required correction |
| --- | --- | --- | --- |
| High | retrieve64 / API1, API5 | `GET /definitions/victim` returns another org/channel's metadata (200). `DELETE /definitions/victim` calls the registry deletion method without credentials (200). See `src/index.ts` definition routes around 481–525. | Authenticate and authorize tenant ownership before registry access. Scope registry operations to the verified tenant. |
| High | data360 / API1, API2 | `/api/v1/context?userId=victim&channelId=other-channel` returns a cached private response (200) before checking credentials. The actual cache match branch around `src/index.ts:1097` precedes authentication. | Authenticate before every cache lookup, including 304 responses; include verified tenant and permissions in cache keys. |
| High | data360 / API7, API2 | `SalesforceAuthBridge.resolveToken` sends an explicit bearer token to `http://127.0.0.1:8080/services/oauth2/userinfo`. The audit intercepted this request. A blocked network request still produces a resolved connection. `src/auth-client.ts:15–40` also only rejects 401/403. | Enforce canonical Salesforce HTTPS hosts; reject redirects to untrusted hosts; require successful identity verification and matching requested org/user; fail closed on all verification failures. |
| High, internal boundary | sf-auth / API1, API5 | Cache read routes return victim data (200) and cache writes execute an INSERT (201) without channel authorization. User-data schema has `user_id` as its only primary key and SELECT/UPSERT use only that ID. See `src/index.ts:1603` onwards and `src/cache-helper.ts:288–365`. | Require a verified grant/channel scope and composite tenant keys before cache reads/writes. Migrate existing records safely. |
| Moderate | data360 / API5 | Unauthenticated POST `/api/data360/cache/purge` invokes `ctx.cache.purge` with attacker-supplied tenant tags. The audit records the actual invocation, not merely a success response. | Authorize tenant-scoped purge tags and restrict privileged purge operations. |
| Moderate | parser and agentcode / API2, API4 | Unauthenticated expression translation and CEL precompile both execute (200). HTTP handlers expose compute operations without an authentication gate; parser uses `request.json()` without an application body bound. Other compute routes require further resource-budget testing. | Verify authenticated caller/service access; bound input size, batch size, expression complexity, concurrency, and execution cost. |
| Moderate | sf-auth / API4 | A JSON body exceeding 64,000 bytes without Content-Length executes a cache INSERT (201). Ordinary parser checks only the supplied Content-Length. Signed self-OAuth additionally checks real body bytes. | Enforce bytes while streaming before parsing, independent of Content-Length. |

The sf-auth Wrangler configuration explicitly sets `workers_dev: false` and is intended
for service bindings. Its finding concerns missing tenant authorization inside that
trusted service boundary; this audit does **not** establish public Internet exposure.
Other Worker configs lack that explicit setting; deployed routes, Access policies and
network reachability were not verified, so public exploitability remains unconfirmed.

## Dependency audit

`bun audit --json` was run for all five projects. Each lockfile reports the same
**2 High, 5 Moderate, 3 Low advisories in undici**. These are shared advisories, not
50 unique vulnerabilities. Raw advisory IDs, affected versions and URLs are in
`owasp-dependencies.json`.

In sf-auth, `bun pm why undici` shows `undici@7.29.0` through
`miniflare -> wrangler`, both development tooling. The advisories require
`undici >=7.29.1`. The two High advisories are WebSocket subprotocol denial of
service and TLS validation bypass in BalancedPool. This is **not evidence that the
deployed Workers use vulnerable undici**; verify each dependency path and upgrade
compatible tooling/lockfiles, then rerun the audit.

## Passing controls

- Missing and forged self-OAuth service signatures return 401.
- Missing channel scope fields fail before database access (400).
- Missing context fields are rejected (400).

Existing auth baseline tests cover further channel-secret and grant validation,
live tool resolution, unsafe API targets and structured errors. They are not proof
that all sibling endpoint authorization is correct.

## Reproduction and limits

From `tubot-sf-auth`:

```sh
bun install --frozen-lockfile
bun test src
bun security-review/owasp-endpoints.ts
bun audit --json
```

The endpoint audit imports actual Worker handlers and the actual Data360 auth bridge.
Fixtures record SQL bindings, registry calls and cache purge calls. All network
requests are blocked/intercepted. Victim data and tokens are synthetic audit markers.
The script exits 1 on failed or inconclusive checks and regenerates
`owasp-endpoints.json`. Install data360's dependencies with Bun if needed.

The cache fixture deliberately returns a victim row; recorded SQL confirms reads
contain no tenant predicate. No live database, Durable Object, Salesforce record,
credential, or cache was mutated. Consequently this does not claim live target
verification under the project's blind testing protocol. No destructive probes,
load testing, or production deployment were performed.

Runtime code was not changed. Pre-existing/concurrent changes in sf-auth and
retrieve64 were preserved and excluded from the audit commit. The observed behavior
reflects the workspace at audit time. Subsequent fixes must rerun these checks and
independently verify any real target mutation.
