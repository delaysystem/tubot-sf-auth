# Security Audit Report — tubot-sf-auth Backend Worker

**Prepared for:** Salesforce AppExchange security review (supporting evidence)
**Target:** `tubot-sf-auth-staging` Cloudflare Worker (`src/index.ts` and
support modules, D1-backed Salesforce credential broker)
**Assessment dates:** 2026-10-05 – 2026-10-06
**Method:** Manual code audit, regression-test witnessing, dependency audit,
configuration and deployment review. No DAST was possible or attempted: the
worker exposes no public HTTP surface (see 2.2).
**Report version:** 1.0 — 2026-10-06

## 1. Executive summary

The `tubot-sf-auth` worker brokers Salesforce credentials and user-data
caching for bound backend services. It is private by configuration
(`workers_dev: false`, `preview_urls: false`), so its attack surface is its
service-binding API, its D1 data handling, and its Salesforce upstream calls
— all of which were audited at source level.

Result: **one finding, remediated and verified** (tenant scoping of the
callable-tools credential lookup). No High findings. Dependency audit shows
zero advisories affecting the shipped runtime (one High advisory exists in
the local-dev toolchain only; see 6.5). Full suite green: **852 tests pass,
0 fail, across 79 files**; `tsc --noEmit` clean. The remediated code is live
at 100% rollout (version `53438b79`, verified to contain the fix — see 7.3).

This report builds on the prior endpoint-hardening package in this directory
(`OWASP-AUTH-REMEDIATION.md` with its JSON evidence), which remediated
tenant-scope enforcement, cache isolation, body limits, and SSRF-adjacent
issues; those controls were re-confirmed present during this audit and are
not re-litigated here.

## 2. Scope

### 2.1 In scope

- Service-binding API authentication and authorization (`authorized()`,
  HMAC-signed internal endpoints, active-grant rechecks).
- Credential lifecycle: registration, AES-GCM-256 storage, rotation,
  revocation, deletion.
- Tenant isolation across cache, tokens, execution users, and the
  new-panel tenant bridge client.
- Self-OAuth (Panel-authorized org connection) flow: state, PKCE, token
  exchange, identity verification, API proxy allowlisting.
- Salesforce upstream request construction (SOQL escaping, URL/path
  allowlists, SOAP handling), body limits, error handling, and logging
  hygiene (no secret/PII logging).
- Dependency posture (`bun audit`) and deployment configuration
  (`wrangler.jsonc`, secrets inventory, rollout state).

### 2.2 Out of scope (stated explicitly)

- **DAST / penetration testing over HTTP.** The worker has no `workers.dev`
  URL, no routes, and no custom domain; there is no endpoint for ZAP/Burp
  to reach. Dynamic verification was performed through the project's own
  suites (which execute real SQL, real crypto, and HTTP-level handler tests)
  plus deployment and configuration inspection.
- **Live Salesforce org testing.** No test-org mutations were performed;
  Salesforce-facing behavior was verified through handler tests with
  recorded-shape upstream stubs plus strict request-construction review,
  not against a live org.
- **The Salesforce managed package (Apex/LWC)** and **the Panel web app**
  (covered by its own ZAP report in
  `tubot-new-panel/security-review/OWASP-ZAP-REPORT.md`).

## 3. Methodology and evidence

1. Full read of the request path: `fetch` handler → `handle()` routing →
   `requestScope`/`authorized` gates → per-route handlers in `src/index.ts`.
2. Targeted review of trust boundaries: `src/request-security.ts`
   (scope + body limits), `src/tenant-bridge.ts` (bridge client),
   `src/agent-script.ts` (credential discovery), `src/cache-helper.ts`
   (tenant-scoped cache), self-OAuth functions, `token()` issuance.
3. Secret/credential grep review (no plaintext storage, no logging of
   tokens/secrets/PII).
4. Witnessed verification: `bun test` (full suite), `bun run typecheck`,
   `bun audit --json`, `wrangler deployments list` / `versions view`,
   secret-name inventory (names only, values never read).
5. Fix verification for the single finding: new committed regression tests
   proven to fail on the pre-fix implementation (stash-based fail-first run
   plus a forced-old-behavior mutation check), then green after the fix.

## 4. Control assessment (confirmed present)

- **Private by default.** No public routes; all callers arrive via service
  bindings. Internal self-OAuth and channel-lifecycle routes additionally
  require HMAC-SHA256 signatures with 10-digit timestamps (±60 s skew),
  single-use 24-char nonces tracked in D1 (replay-safe), and
  constant-time signature comparison.
- **Channel authentication.** Every data route gates on `requestScope`
  (team/org/channel + ≥32-char channel secret) followed by `authorized()`,
  which verifies the secret hash AND re-checks the live Panel grant
  (`salesforce_channel_connection` + unexpired `oauth_token`) on every
  call — revocation takes effect immediately. Conflicting scope
  representations across headers/body/query are rejected (403).
- **Encryption at rest.** Client secrets and refresh tokens are AES-GCM-256
  encrypted with a 32-byte key from a Worker secret; key missing/invalid
  fails closed (500, no plaintext fallback). OAuth access/refresh tokens
  are stored as SHA-256 hashes (dual-read retained only for pre-hash rows).
- **Tenant isolation.** Cache keys embed the full tenant triple and rows
  are re-validated on read; token-cache keys include the credential IV so
  rotation invalidates cached tokens; bridge credential cache entries are
  cloned per serve and expire after 60 s.
- **Self-OAuth done right.** State is stored hashed, single-use
  (`UPDATE … RETURNING` consume), 10-minute expiry; PKCE S256 enforced;
  post-exchange identity call verifies the token belongs to the expected
  org AND user; the API proxy allowlists paths (`/services/data/…`, SOAP
  describe/query only), methods, headers, and body size (5.5 MB).
- **Upstream safety.** Instance URLs restricted to `https:`, no
  credentials/port/path, Salesforce-domain suffix allowlist (SSRF-safe
  base); SOQL values escaped (`'` → `\'`); SOAP versions validated before
  interpolation; XML tag names restricted to bounded identifiers.
- **Abuse limits.** 64 KB bounded body reader counts streamed bytes
  independent of Content-Length (413 on overflow); the signed self-OAuth
  proxy retains a documented 10 MB allowance behind HMAC auth.
- **Failure hygiene.** Top-level handler maps all errors to safe codes;
  logs carry codes/request IDs only — no tokens, secrets, or PII.
  Security-error paths return 401/403/404 without tenant enumeration
  beyond what the caller already proved.

## 5. Findings

### 5.1 [Remediated] Callable-tools credential lookup ignored the authenticated tenant scope

- **Severity:** Low (exploitable only if one Salesforce channel were ever
  enrolled under two teams; channel IDs are globally unique, so no live
  collision is believed to exist — defense in depth).
- **Location:** `getCallableToolUrlsForChannel` in `src/agent-script.ts`.
- **Description:** the HTTP endpoint authenticates the tenant and passes
  `teamId`/`orgId` into capability discovery, but discovery resolved
  credentials with channel-ID-only `LIMIT 1` lookups
  (`findCredentialByChannelId`, including 15-char prefix fallback),
  ignoring the authenticated scope. On a cross-team channel-ID collision
  the worker would have minted a Salesforce token for the wrong tenant's
  enrollment.
- **Fix (in assessed tree, `src/agent-script.ts`):** new exported
  `findCredentialByScope(db, teamId, orgId, channelId)` exact-triple lookup,
  used whenever full scope is known (the HTTP path); partial-scope and
  label-filling paths now verify a discovered row against any known half
  instead of trusting first-match. RPC callers without scope keep legacy
  channel-only discovery (bound-service trust model, unchanged).
- **Verification:** 3 new committed tests in `src/callable-tools.test.ts`
  (exact-triple resolution incl. negatives; two-team/one-channel collision
  asserting the token request hits the scoped tenant's instance; unknown
  scope rejects). Proven meaningful: the collision test fails against the
  pre-fix implementation and under a forced-old-behavior mutation, and
  passes with the fix. Full suite green (852/852), typecheck clean.
- **Live state:** shipped in the active deployment (see 7.3).

## 6. Residual notes and accepted positions

- **6.1 SHA-256 (unsalted, single-round) for secret/token hashes.**
  Acceptable as used: inputs are high-entropy random values (≥32-char
  channel secrets, 192-bit tokens), not passwords — there is no
  dictionary/rainbow-table threat. Comparisons are constant-time.
- **6.2 Channel-ID-only discovery retained for scopeless RPC.**
  `getTokenForChannel` and unscoped callable-tools RPC keep first-match
  discovery for back-compat with bound services. Accepted: RPC callers are
  bound Cloudflare services, not the internet; all HTTP paths now pin
  exact scope (5.1).
- **6.3 10 MB allowance on the signed self-OAuth request proxy.**
  Documented and HMAC-gated; ordinary routes stay at 64 KB. Accepted.
- **6.4 In-memory caches (tokens, bridge credentials/tenants, 60 s TTL).**
  Per-isolate by Workers design; revocation visibility lags at most the
  TTL. Accepted for the scanner/proxy cadence; keys are tenant-qualified.
- **6.5 `sharp` High advisory in the dev toolchain (GHSA-wq5f-xc86-pv6w,
  via `miniflare ← wrangler`, devDependencies only).** Not shippable to
  the Worker: `sharp` is a native Node module used by the local simulator,
  and the shipped runtime dependency set is `fflate` alone (zero
  advisories; the 907 KB worker bundle cannot contain it). Action: upgrade
  `wrangler` when a release carries `sharp ≥ 0.35.5`; no code change
  indicated. (The advisory postdates the earlier clean audit as the
  database entry is new.)
- **6.6 Dirty-worktree deploys (process observation, not a code flaw).**
  The shared checkout routinely carries unrelated uncommitted changes, and
  at least one staging deploy shipped the whole worktree (see 7.3). No
  incident resulted, but audit artifacts should keep following the
  established frozen-snapshot practice (deploy exactly the reviewed tree
  for security releases; commit-then-deploy otherwise).

## 7. Verification log

- **Tests:** `bun test` → 852 pass, 0 fail, 3942 assertions, 79 files
  (2026-10-06). Includes the 3 new tests for 5.1 plus the pre-existing
  security regression coverage referenced in `OWASP-AUTH-REMEDIATION.md`.
- **Types:** `bun run typecheck` (`tsc --noEmit`) → clean.
- **Dependencies:** `bun audit --json` → zero advisories on the runtime
  set (`fflate`); one High confined to the `wrangler` dev toolchain (6.5).
- **Configuration:** `workers_dev: false`, `preview_urls: false`; secrets
  present (names only): `BRIDGE_SHARED_SECRET`, `MAILSLURP_API_KEY`,
  `SELF_OAUTH_INTERNAL_HMAC_KEY`, `SF_CREDENTIAL_ENCRYPTION_KEY`;
  bindings: staging D1, `NEW_PANEL` and `RETRIEVE64` service bindings.
- **Deployment lineage:** fix-bearing version `7336a20e` promoted to 100%
  on 2026-10-06 05:17 UTC; superseded by `53438b79` on 2026-10-06 19:41 UTC
  (100% rollout, confirmed via `wrangler deployments list`). The later
  deploy ran from this shared worktree: local wrangler temp-dir
  create/cleanup timestamps match the version creation to the second, and
  a same-minute local build from that worktree contains the fix's SQL
  marker string (a string with zero occurrences at HEAD), so the active
  version includes the 5.1 fix. Remote bundle content was not downloaded
  (API token file unreadable from the audit sandbox); provenance rests on
  the timestamp + marker evidence above.

## 8. Limitations

- Without a public HTTP surface, assessment is necessarily white-box
  (source, tests, config) rather than black-box penetration testing.
- Live-Salesforce behavior was reviewed statically and through handler
  tests, not exercised against a real org; a connected-org test pass
  remains a recommended (out-of-band) follow-up before production
  promotion of unrelated in-flight flow changes.
- Findings are point-in-time for the assessed tree; the committed
  regression tests pin the remediated behavior so it cannot silently
  regress.

## 9. Evidence index

- This directory: `OWASP-AUTH-REMEDIATION.md` + JSON evidence (prior
  endpoint-hardening package, controls re-confirmed in section 4).
- Fix: `src/agent-script.ts` (`findCredentialByScope`, scoped discovery),
  `src/callable-tools.test.ts` (3 regression tests).
- Verification commands (all re-runnable): `bun test`, `bun run typecheck`,
  `bun audit --json`, `wrangler deployments list`, `wrangler versions view
  <id>`, `wrangler secret list` (names only).
