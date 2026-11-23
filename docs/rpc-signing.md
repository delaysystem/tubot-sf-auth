# RPC Signing: server-to-server keys for tubot-sf-auth

Every RPC method on `tubot-sf-auth` requires a per-caller, **per-org** HMAC
envelope. There are no anonymous calls: without a valid signature the worker
answers `401 rpc_unauthorized` (or warns-and-proceeds when warn mode is on).

Why: Cloudflare lets any worker in the account declare a service binding and
call public RPC methods, and RPC exposes no caller identity. The signature is
what proves which caller is asking — and the per-org binding proves which
Salesforce org it may act on. A leaked org key compromises only that org: the
derivation is one-way, so sibling orgs and the master key stay safe.

## How it works (protocol v2, per-org)

The caller appends one trailing argument named `signed` to every RPC call:

```ts
{ caller, org, timestamp, nonce, signature }
```

- `caller`: `"proxy"` | `"searcher"` | `"data360"` | `"conversation"`
- `org`: Salesforce org id (`/^[A-Za-z0-9]{15,18}$/`), the tenant the call acts on
- `timestamp`: 10-digit unix seconds, must be within ±60s
- `nonce`: 18 random bytes as base64url (24 chars), single-use
- `signature`: base64url of `HMAC-SHA256(orgKey, canonical)` via WebCrypto

with

```
orgKey   = HKDF-SHA256(masterCallerKey, salt "tubot-rpc-org-v1", info caller + "\n" + orgId)
canonical = caller + "\n" + org + "\n" + method + "\n" + timestamp + "\n" + nonce + "\n" + argsDigest
argsDigest = lowercase hex sha256 of stableJson(businessArgsArray)
```

`businessArgsArray` is the positional business args **excluding** the envelope,
and `stableJson` is recursive key-sorted JSON (`Uint8Array` encodes as a number
list). The exact functions are frozen — every repo ports them byte-for-byte
(see `src/rpc-signing.ts` here and `rpc-sign.*` in each caller). Both sides
derive the org key independently; the derivation must byte-match (covered by
the 4-way cross-check, see Testing).

Verification (`verifySignedRpcCall`, runs **first** in every method, before arg
validation) returns the verified org id:

1. `caller` must be a known id, else 401.
2. Look up `AUTH_CALLER_KEY_<CALLER>` (then `..._NEXT` for rotation overlap).
   Missing/short key fails closed **for that caller only**, other callers keep
   working.
3. `org` must be well-formed, else 401. (Org-less legacy envelopes are
   rejected; the dual-accept transition is over — see Rollout history.)
4. Timestamp shape + ±60s window, else 401.
5. Nonce shape + single-use claim in D1 table
   `salesforce_self_oauth_internal_nonce` (shared with the self-OAuth fetch
   HMAC), else 401 on replay.
6. Derive the org key per master key, recompute the v2 signature, compare
   timing-safe, else 401.
7. **Org binding** (`assertOrgBinding`): the method's tenant scope arg must be
   an object whose `orgId` equals the envelope org, else 401. Scope-first and
   ref-first methods bind arg 0; channel/options methods bind their documented
   index (`ORG_SCOPE_ARG_INDEX`); the two scopeless methods bind in their
   bodies instead (below). Missing or mismatched scope fails closed.

Scopeless methods (no tenant scope in args — the method body binds the
envelope org returned by the guard):

- `listConnectedOrgs`: filters rows to the calling org.
- `listExecutionUsersForChannel`: 401s unless every returned row belongs to
  the calling org.
- `listSnapshotTeams`: distinct teams holding ready snapshots for the
  calling org (covers teams with no channel row).

Callers must supply the org explicitly for these (wrapper-level parameter;
wire arity is unchanged).

## Current callers

| caller id | repo | auth key | caller env var |
|---|---|---|---|
| `proxy` | `tubot-sf-proxy` (`src/rpc-sign.ts`, `signedBroker`) | `AUTH_CALLER_KEY_PROXY` | `SF_AUTH_CALLER_KEY` |
| `searcher` | `1action-searcher` (`src/rpc-sign.ts`, `signedAuthBinding`) | `AUTH_CALLER_KEY_SEARCHER` | `SF_AUTH_CALLER_KEY` |
| `data360` | `tubot-sf-data360` (`src/rpc-sign.ts`, `SalesforceAuthBridge.sign`) | `AUTH_CALLER_KEY_DATA360` | `SF_AUTH_CALLER_KEY` |
| `conversation` | `1conversation-api` (`src/rpc-sign.ts`, `signedAuth`) | `AUTH_CALLER_KEY_CONVERSATION` | `SF_AUTH_CALLER_KEY` |
| `agentcode` | `agentcode` (`cli/sf-auth-sign.ts`, `signedAuthBinding`) | `AUTH_CALLER_KEY_AGENTCODE` | `SF_AUTH_CALLER_KEY` |

Panel does **not** use RPC: it calls the `/internal/*` fetch routes, which keep
their own HMAC scheme (`SELF_OAUTH_NEW_PANEL_HMAC_KEY`). Fetch and RPC guards
are independent.

## Provisioning keys

Keys are opaque strings, minimum 32 characters. Generate with:

```bash
openssl rand -hex 32   # 64 chars, store via stdin only, never echo
```

Set the same value on both ends (example: staging proxy pair):

```bash
cd tubot-sf-auth
printf '%s' "$KEY" | bunx wrangler secret put AUTH_CALLER_KEY_PROXY --env staging
cd ../tubot-sf-proxy
printf '%s' "$KEY" | bunx wrangler secret put SF_AUTH_CALLER_KEY --env staging
```

Only provision keys for callers that exist in that environment. Prod currently
provisions `PROXY` and `DATA360` (searcher and conv-api are staging-only
workers); a caller with no key fails closed with an explicit config error.

The staging web tester can use its own `SF_AUTH_SNAPSHOT_CALLER_KEY`. Set the same value in `AUTH_CALLER_KEY_AGENTCODE_SNAPSHOTS` on Salesforce Auth. This credential authorizes per-org envelopes for the connected-org, snapshot-team, snapshot-list, and snapshot-read methods. The gateway credentials keep their existing scope and rotation slots.

## Rotation (zero downtime, drilled)

The verifier accepts the current key **or** the `_NEXT` key:

```bash
# 1. Stage the new key on auth (both accepted from here on)
printf '%s' "$NEW" | bunx wrangler secret put AUTH_CALLER_KEY_<C>_NEXT --env staging
# 2. Swap the caller to the new key
printf '%s' "$NEW" | bunx wrangler secret put SF_AUTH_CALLER_KEY   # (+ --env flag per repo)
# 3. Verify live traffic still passes, then promote + clear
printf '%s' "$NEW" | bunx wrangler secret put AUTH_CALLER_KEY_<C> --env staging
bunx wrangler secret delete AUTH_CALLER_KEY_<C>_NEXT --env staging
```

## Warn mode and rollout

`AUTH_RPC_WARN_MODE=1` makes verification failures warn-and-proceed instead of
rejecting. Rollout sequence per environment:

1. Provision keys, deploy auth with warn mode on.
2. Deploy the signed callers, verify live traffic passes.
3. Delete `AUTH_RPC_WARN_MODE` (enforce), re-verify positives plus one
   negative (wrong key must fail fast with `rpc_unauthorized`).

### Rollout history: v1 universal → v2 per-org (completed)

The v1 protocol (org-less envelopes, universal caller keys) was migrated to v2
with zero downtime per environment:

1. Deploy auth with dual-accept (`AUTH_RPC_ALLOW_LEGACY=1` accepts v1
   envelopes alongside v2).
2. Deploy the v2 callers; verify positives (sweep, data360 export, broker
   authorize) plus live negatives via a gated probe worker (cross-org with a
   valid `_NEXT`-derived signature must 401; garbage must 401; legacy must
   pass while the flag is on).
3. Delete `AUTH_RPC_ALLOW_LEGACY` (per-org-only), re-verify: positives hold,
   legacy now 401s.
4. Delete the probe `_NEXT` keys and the probe worker.

No new secrets were provisioned: org keys derive from the existing master
caller keys, so rotation re-keys all orgs at once (per-org revocation is out
of scope by design).

### Searcher discovery under per-org keys

`listConnectedOrgs` can no longer enumerate every tenant in one call, so the
searcher drives discovery from orgs it already knows:

- Sweep trigger, probe-inputs, and `/internal/*` routes pass their validated
  `body.orgId`/route org explicitly (loose-validated routes map malformed ids
  to the same 404 as before — no behavior change).
- `handleSweepMessage` self-fetches with `message.orgId` when no listing is
  injected.
- The queue consumer resolves one listing per org group in the batch
  (mixed-org batches work; a listing failure still acks the batch unrecorded).
- `runCycle` drives candidates from its own `org_scan` ledger (orgs enter it
  via the validated sweep trigger path) and resolves each candidate's live
  connection with a per-org listing, skipping disconnected/malformed rows.

## Adding a new caller

Auth side (`tubot-sf-auth`):

1. Add the id to `RpcCallerId` in `src/rpc-signing.ts` (+ `isCallerId`,
   `RpcSigningEnv`, `callerSigningKeys` suffix) and to `AuthEnv` in
   `src/index.ts`.
2. New RPC methods must call `verifySignedRpcCall` **first**. The reflective
   test fails the suite if any public entrypoint method lacks the guard.

Caller side:

1. Port `stableJson` + HKDF `deriveOrgKey` + v2 `signRpcArgs` exactly (copy
   `tubot-sf-proxy/src/rpc-sign.ts`).
2. Route **every** auth-RPC call site through one choke-point wrapper that
   resolves the envelope org from the method's tenant scope (explicit
   wrapper-level parameter for the scopeless methods), appends the trailing
   `signed` arg, and throws fail-fast when `SF_AUTH_CALLER_KEY` is
   missing/short or the org is malformed. Never send unsigned.
3. Do **not** wrap the binding in `new Proxy()`: Proxy-wrapped RPC stubs break
   dispatch live (every call 1101s). Use an explicit-method plain object.
4. Tests: envelope shape, fail-fast, per-org KDF determinism/distinctness,
   and a fixed-vector test that recomputes the signature inline with raw
   WebCrypto (no shared code).

Then verify cross-compat by execution: sign with the new caller module and
verify with auth's `verifyPerOrgEnvelopeSignature` in one `bun` script
(tampered org/args must reject, sibling-org scope must reject).

## Testing

```bash
cd tubot-sf-auth       && bun test src/rpc-signing.test.ts   # 23 tests
cd agentcode           && bun test test/sf-auth-sign.test.ts test/sf-auth-source.test.ts  # 15 tests
cd tubot-sf-proxy      && bun test src/rpc-sign.test.ts      # 12 tests
cd 1action-searcher    && bunx vitest run test/rpc-sign.spec.ts  # 9 tests
cd tubot-sf-data360    && bunx vitest run test/auth-client.spec.ts  # 11 tests
cd 1conversation-api   && bunx vitest run --config <plain-forks-config> test/rpc-sign.spec.ts  # 8 tests;
  # the repo vitest config forces the cloudflare pool, which needs a live service
  # binding; the spec is runtime-free so a plain forks config runs it anywhere
```

The auth suite covers valid/tampered/replayed/expired/unknown-caller,
per-caller fail-closed, warn-mode proceed, the reflective all-methods guard
test, plus per-org vectors, org/scope mismatch and missing-scope rejection,
scopeless filtering, legacy dual-accept, and the cross-org matrix.

Cross-worker proof is a `bun` script (kept out of tree, e.g. `/tmp/xcheck-*.ts`,
so it never rots into a stub): every caller signer verifies against auth's
real verifier with fixed inputs, KDF byte-matches across all five ports, and
the cross-org/cross-caller/legacy matrix rejects.

## Troubleshooting

| symptom | likely cause |
|---|---|
| `401 rpc_unauthorized` | wrong key on one end, clock skew > 60s, stale/envelope arg mismatch (caller and guard must hash identical arg arrays — pass explicit `undefined` for omitted optionals), **or envelope org ≠ scope `orgId`** (including missing scope on a scoped method) |
| `401` on `listExecutionUsersForChannel` with a valid signature | channel belongs to a different org than the envelope |
| `listConnectedOrgs` returns fewer rows than before | expected: v2 filters to the calling org; cross-org enumeration is gone by design |
| `503` signing config error | caller key missing/short on auth side |
| caller throws `rpc_caller_key_not_configured` at runtime | `SF_AUTH_CALLER_KEY` missing/short on the caller worker |
| caller throws `rpc_org_not_configured` / `org is missing or malformed` | scope/options lack a well-formed `orgId` at the call site — fix the caller to pass its tenant scope |
| 1101 on every call, unit tests green | binding wrapped in `new Proxy()` — rewrite as explicit methods |
| replay false positives | nonce D1 table missing/unreachable — check the `salesforce_self_oauth_internal_nonce` table exists in the bound DB |

## Properties and non-goals

- Guarantees: caller authentication, per-org request authorization,
  per-request integrity, replay resistance, per-caller **and per-org** blast
  radius, key rotation without downtime.
- Does not encrypt payloads (binding transport is already off-internet) and
  does not authenticate the panel fetch routes (separate HMAC scheme).
- Human tooling keeps simple bearers where interactive signing is impractical
  (e.g. sweep driver scripts).
- No per-org revocation: rotating a master caller key re-keys all its orgs at
  once (accepted; rotation is drilled and zero-downtime).
