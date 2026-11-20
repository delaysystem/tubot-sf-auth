# Production endpoints and package access

## Production Worker routing

The production Panel is served at `https://panel.tubot.lat` by
`tubot-new-panel`. Its `SF_AUTH` service binding targets `tubot-sf-auth`.
Both production Workers use the production D1 database. The base
configuration and the named `production` environment point at these same
production services, so a plain deploy cannot silently select staging.

Use the project scripts for release work:

```sh
cd tubot-new-panel && bun run deploy
cd tubot-sf-auth && bun run deploy
```

Staging remains an explicit, separate environment (`tubot-new-panel-staging`
and `tubot-sf-auth-staging`) with its own staging D1 database. Deploy staging
only with `bun run deploy:staging`. Local development uses the local Wrangler
configuration and must not be deployed.

The Panel OAuth redirect allowlist follows the selected Worker environment:
production accepts the production Panel worker and `panel.tubot.lat`, staging
accepts the staging Panel worker and `staging-panel.tubot.lat`, and localhost
callbacks are accepted only in development. Salesforce org callback domains are
validated separately.
Neither Salesforce Auth Worker hostname nor arbitrary `*.tubot.lat` hosts are
Panel callback destinations.

## Salesforce access model

The Salesforce platform's package-install permissions determine who may
install or upgrade TuBot. Salesforce cannot use a permission set included in
the package to gate that installation, because the set is created only after
installation.

After installation, the post-install handler assigns
`Panel_Settings_Admin_Access` to the installing user. To grant another user
access, open Setup → Permission Sets → Panel Settings Admin Access → Manage
Assignments and add that user. Removing the assignment revokes Panel Settings
access. The settings Lightning tab is granted through the package permission
set, and the Apex controllers/services independently enforce the same
assignment before returning settings or performing mutations. Salesforce
does not permit a managed package upgrade to remove the component's existing
AppPage, RecordPage, and HomePage metadata targets. Users without the set see
the locked component state on those pages, and the component makes no data
calls for them.

`Tubot_JWT_PreAuth` remains separate: Simple Setup assigns it to the selected
integration user for Salesforce JWT authorization. It does not grant access
to the Panel settings page.

## Simple Setup policy authorization

The ECA policy popup returns to the production Panel Worker. The callback
receives the Salesforce authorization code and keeps the exchanged access
token in request-local memory while it performs the Metadata API policy
change and readback. The encrypted PKCE verifier is removed from the pending
row before the callback contacts Salesforce. The token is revoked and
discarded; neither code nor token is written to D1, KV, or logs. While the
flow is pending, D1 holds the org/state context and encrypted verifier. After
completion it retains only the safe result, error category, and verification
time. The final JWT registration check independently verifies that Salesforce
honors the pre-authorization.

The documentation and source tree retain staging references for isolated
staging configuration and historical scan evidence. Those are not production
endpoints. Historical reports must not be relabeled as production scans.

## Release evidence

The non-beta managed package version `1.7.0.1` was promoted on 2026-10-08
(package version ID `04tg5000000FG4TAAW`). Salesforce reports 76% Apex code
coverage and a passed coverage gate. It is installed in the separate package
validation subscriber; the targeted permission-gate Apex test passed there.
The AppExchange-profile Code Analyzer run for this exact package source
recorded zero violations. The live production Panel setup endpoint returns
401 without the Panel bearer token. The production Panel Worker deployment
was checked after deployment. Release validation did not target
`tubot-verify-120`; its user-tested installation was left intact.

This evidence does not represent Salesforce AppExchange Security Review
approval. The inactive Axiom Remote Site Setting remains in the package for
the managed-package lineage reason above; disclose it in the submission and
include the removal limitation evidence with the reviewer materials.
