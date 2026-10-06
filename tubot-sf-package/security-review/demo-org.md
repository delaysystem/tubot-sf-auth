# Reviewer demo org

Dedicated Developer Edition org for the Salesforce AppExchange security
review. Contains only the TuBot managed package plus stock DE metadata.

- Org ID: `00DgK00000bWYCYUA4`
- Login URL: `https://orgfarm-06a94faaa6-dev-ed.develop.my.salesforce.com`
- Admin username: `emalteaproductions.a7a833b11b01@agentforce.com`
- Password: handed to the reviewer out of band (generated 2026-10-06, do
  not commit it here).
- Installed package: TuBot **1.2.0.2** (`04tg5000000F489AAC`), released.

## Reviewer click path

1. Log in as the admin user above.
2. Open the **Panel Settings** tab (`/lightning/n/tubot__Panel_Settings`).
3. **Settings tab**: shows disconnected state, Panel base URL
   (`https://panel.tubot.lat`), client ID, and connection status. The
   **Connect Panel** button starts the OAuth 2.0 PKCE login against Panel;
   the reviewer needs Panel demo credentials (provided separately) or may
   leave the org disconnected — every control fails closed with an
   explanatory message.
4. **Setup Wizard**: health check reports named credential presence,
   permission state, and connection state. Permission-set assignment and
   ECA guidance steps are exercisable without Panel access.
5. **Messaging / backup controls**: backup capture runs against org
   metadata; restore and channel-connect actions require a completed
   post-install plus Panel access and fail closed otherwise.
6. Permission sets (all four assigned to the admin):
   `Panel_Settings_Admin_Access`, `Tubot_Channel_Connection_Admin_Access`,
   `Tubot_Salesforce_API_Read`, `Panel_Messaging_Session_Admin_Access`.

## Verified state (2026-10-06, independent CLI queries)

- Installed version is 1.2.0.2 in the `tubot` namespace.
- Post-install assigned `Panel_Settings_Admin_Access` to the installer;
  the other three permsets were assigned for the demo.
- Org defaults present: messaging filter `ALL`, agent keyword `agent`,
  flow routing off; Panel base URL `https://panel.tubot.lat`, stock
  client ID, null legacy token fields.
- Named credential, remote sites (Panel active, Axiom inactive), tab
  `tubot__Panel_Settings`, and LWC `tubot__panelLoginSettings` present.

## House rules for the review window

- Do not install other packages or modify admin credentials; the review
  references this exact state.
- Panel-side demo data (if the reviewer connects) lives in the Panel
  demo team, not in this org.
- To rotate the reviewer password after the review: `sf org generate
  password --target-org test3`.
