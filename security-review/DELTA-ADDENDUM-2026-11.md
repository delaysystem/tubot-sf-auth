# tubot-sf-auth — Delta Addendum (2026-11-02)

Addendum to `SECURITY-AUDIT-REPORT.md` (2026-10-06). Reviews every `src/`
change since Oct 6 for security impact. Verdict: no findings; controls
hold or improved.

## Deltas reviewed (all with tests, all live-proven per commit messages)

- `409eb21` browser-turn verify pass-through (`knownEntries`): skips a
  duplicate Salesforce entries fetch when the proxy's same-serve sync
  entries match. Provenance traced: entries come only from
  `broker.browserSync()` (server-side Salesforce read); the echo path
  passes `undefined` (fresh fetch). Session-binding check stays live in
  both paths. Contract in `tubot-sf-proxy/src/contracts.ts` ("never
  populated from client input") holds at both call sites. Secure.
- `f40e858` + `e3ed7e5` VF test-page origin allow-list: bootstrap-content
  fallback matches the deployment name exactly (`===`, `DEPLOYMENT_RE`
  validated); suffix checks carry a leading-dot boundary
  (`.my.salesforce-scrt.com`), so no sibling-domain bypass. Proxy-side
  match remains exact-match. Secure.
- `0629839` Web deployments accepted for proxy registration: widens
  eligibility, not authority — channel-match still enforced, Mobile still
  rejected, nothing mints v2 tokens with the deployment. Secure.
- `af5b530` echo idempotency claim, `30d070f` session_pending retry code,
  `6482c26` definition-twin flip: state-machine/logic changes; no trust-
  boundary or credential-handling impact. Skimmed, no concern.

## Standing confirmations (re-verified live this audit)

- `getTokenForChannel` RPC verifies the signed envelope; scope inside is
  caller-asserted, which is exactly why data360's HTTP layer (fixed in
  D2, see tubot-sf-data360 report) must authenticate before asserting.
- No other consumer regressions from the data360/laya fixes: sf-auth calls
  data360 only via the HMAC-signed binding client (`/api/cache/agent(s)`,
  untouched routes).
