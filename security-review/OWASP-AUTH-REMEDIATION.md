# sf-auth remediation and static analysis

## Scope

Only `tubot-sf-auth` was edited and deployed, following the final scope instruction.
The temporary Data360 source/tooling changes were restored. Findings in Data360,
retrieve64, parser, and agentcode remain in the [historical baseline](OWASP-ENDPOINTS.md).
The original 16-check evidence is retained in `owasp-endpoints-before.json`.

## Fixes

- Cache reads, writes, ETags, purges, token requests and conversation HTTP routes
  verify the exact team/org/channel and channel secret against an unexpired Panel
  grant **before** using cached data. Conflicting body/header/query scopes fail.
- Cache RPC methods require the same active authorization. Credential discovery
  no longer falls back to the first org. Private token RPC discovery rechecks its
  active grant; partially supplied credentials cannot select that discovery path.
- `sf_user_data_cache_v2` uses keys encoded from team, org, channel and object ID.
  Legacy cache rows are retained and not returned. New caches start cold and the
  table is initialized on the first authorized cache operation.
- Cache purge validates tags before deleting rows, scopes purge tags to the tenant,
  and propagates storage errors instead of reporting dummy success.
- Implicit user-data payloads exclude the authorization credential fields.
- Request limits count actual streamed bytes, independently of Content-Length.
  Ordinary requests are limited to 64,000 bytes; the signed self-OAuth request
  proxy retains its existing 10,000,000-byte allowance. Signature verification
  also uses the bounded reader.
- SOAP API versions are validated before interpolation. XML extraction tag names
  are restricted to bounded identifiers. Prompt repair never traverses inherited
  objects and rejects prototype-related paths.
- Wrangler was upgraded to 4.145.0. `bun audit --json` reports **zero dependency
  vulnerabilities**, including development dependencies.

## Verification

| Check | Result |
| --- | --- |
| Bun suite | 94 passed, 0 failed; 557 assertions across 8 files |
| Security regression tests | 13 tests using actual SQLite SQL and independent state queries |
| TypeScript | `bunx tsc --noEmit` passed |
| Local endpoint probes | 7/7 passed |
| Deployed Worker probes | 7/7 passed through a remote service binding |
| Independent D1 check | Scoped-cache table count remained 0 before and after rejected live writes |
| Dependency audit | 0 findings |
| Static analysis | 173 applicable security rules on all 5 production TypeScript files; 0 scan errors |

The live probes returned 401 for anonymous cache reads/writes/purges and token
requests, 413 for an oversized body without Content-Length, and 401 for missing
self-OAuth signatures. D1 verification used an independent Wrangler CLI query;
the probes created no cache table and wrote no cache records. Authorized tenant
isolation and purge behavior were independently checked against actual SQLite.
No live Salesforce record was mutated.

The Worker remains private (`workers_dev: false`, `preview_urls: false`). The
deployed version and its active 100% rollout were independently checked using
`wrangler deployments list`; see `owasp-auth-deployment.json`.
Deployment used a frozen sf-auth snapshot matching the static-analysis source
hashes. Unrelated Flow-context changes arriving in the shared workspace were
preserved and excluded from that snapshot and the security commit.

## Static analysis result

Used [Opengrep](https://github.com/opengrep/opengrep) 1.30.0 and 184 configured
security rules from the pinned [Semgrep community rules](https://github.com/semgrep/semgrep-rules)
commit `a84ff9cc2453ca91d581380de4b8b3f272f6f4be`. 173 rules were applicable to
the scanned languages. The rule set includes OWASP mappings for injection,
misconfiguration, integrity, authentication, SSRF and related checks.

There are **7 raw audit warnings**, with suppression disabled:

- Five XML-template warnings: SOAP XML is sent to Salesforce; tokens, names and
  async IDs are XML-escaped, and API versions now have numeric validation.
- One dynamic-regex warning: tag names are bounded validated identifiers; all
  call sites use fixed expected SOAP tags.
- One object-traversal warning: unsafe prototype keys are rejected; traversal
  requires an own property and creates null-prototype objects. Regression tests
  cover rejected prototype paths and inherited object isolation.

Review found **0 confirmed High or Moderate vulnerabilities** among these warnings.
This is a manual assessment, distinct from the raw scanner count. No findings were
hidden, excluded by rule ID, or silenced with suppression comments. Evidence for
each warning is in `owasp-static-triage.json`; complete raw output is in
`owasp-static-analysis.json`. Tests are excluded from the production-source scan.

## API compatibility

HTTP data/cache callers must supply `teamId`, `orgId`, `channelId`, and
`channelSecret`, either in the supported JSON scope fields or `x-team-id`,
`x-org-id`, `x-channel-id`, and `x-channel-secret` headers. Credentials are not
accepted in URLs. Query scope IDs must agree with body/header IDs.

Cache/conversation RPC callers must pass these fields in the authorization
options argument. Requests lacking authorization now fail rather than receiving
shared cached data. Callers in services scheduled for rewrite were not modified.

## Reproduction

```sh
bun install --frozen-lockfile
bun test src
bunx tsc --noEmit
bun security-review/owasp-endpoints.ts
bun security-review/run-static.ts
bun audit --json
```

The static runner downloads the pinned Linux analyzer, verifies its SHA-256,
uses the checked-in rules and regenerates the raw report with suppression disabled.
Tool/rule provenance and source hashes are in `static-analysis-provenance.json`.
Test, CLI and dependency evidence is in `owasp-auth-verification.json`.
