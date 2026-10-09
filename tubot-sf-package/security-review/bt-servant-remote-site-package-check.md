# BT Servant Remote Site package check

Checked 2026-10-08 by creating two 2GP package versions from isolated copies of the same package source. Both copies included the project `.forceignore`; the no-BT copy omitted only `force-app/main/default/remoteSiteSettings/IGNORE_BT_Servant_WhatsApp_Gateway.remoteSite-meta.xml`.

| Build | Package version | Subscriber package version ID | Code coverage | Coverage gate | Released |
| --- | --- | --- | ---: | --- | --- |
| Control, BT Remote Site retained | 1.5.0.3 | `04tg5000000FFy1AAG` | 76% | Passed | No |
| BT Remote Site omitted | 1.5.0.4 | `04tg5000000FFzdAAG` | 76% | Passed | No |

A separate Dev Hub package-version query confirmed both candidates exist, `HasPassedCodeCoverageCheck=true`, and `IsReleased=false`. This confirms Salesforce can create and validate the candidate without the BT Remote Site setting. Neither candidate was promoted; this check does not claim that promotion or installation was tested.

The first isolated build attempt had a false failure because the temporary source copy lacked `.forceignore`, which excludes the `MessagingSession` override. Repeating both builds with the project `.forceignore` made the control and no-BT builds succeed, so that initial error was unrelated to the BT setting.

## Salesforce Code Analyzer

Ran against the no-BT candidate source using the AppExchange and Recommended:Security selectors:

```sh
sf code-analyzer run --workspace ./force-app --rule-selector AppExchange --rule-selector Recommended:Security --output-file security-review/code-analyzer-appexchange.html --view table
```

The analyzer command exited 0 and reported three Moderate findings:

- `pmd:AvoidHardcodedCredentialsInFieldDecls` at `SimpleSetupEcaStep.cls:12:33` (`OAUTH_PATH` flagged by the credential heuristic).
- `pmd:AvoidHardcodedCredentialsInFieldDecls` at `TubotSetupWizardController.cls:13:32` (`JWT_PREAUTH_PERMISSION_SET` flagged by the JWT heuristic).
- `pmd:ProtectSensitiveData` at `objects/Tubot_API_Channel__c/fields/Connection_Key__c.field-meta.xml:1:1`.

The PMD engine also hit a parser exception while processing `lwc/panelLoginSettings/panelLoginSettings.js` (`Cannot invoke Name.visit ... because this.varName is null`). The report therefore records the findings returned by the other engines, but the PMD analysis is incomplete and needs a clean rerun after resolving or excluding that parser failure.

[HTML analyzer report](code-analyzer-appexchange.html)
