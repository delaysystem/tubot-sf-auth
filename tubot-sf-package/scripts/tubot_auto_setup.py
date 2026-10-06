#!/usr/bin/env python3
"""TuBot Panel + Messaging auto-setup (zero-prompt, human-gate polling).

One command provisions everything a new Salesforce org needs for TuBot API
access, and parks (instead of dying) at the two gates that have no API:

  1. Panel login — the Panel OAuth token principal is minted only by the
     browser login flow in tubot__Panel_Settings (apex proves:
     "Panel_External_Credential.token no existe" until then).
  2. Messaging/Chat enablement — MessagingChannel + QueueRoutingConfig deploy
     is rejected ("Not available for deploy") and direct insert demands
     Enhanced Chat until a human enables Messaging/Omni-Channel in Setup
     (plus Digital Engagement licenses when the org has none).

Usage:
  python3 tubot_auto_setup.py --target-org <alias> [--wait-minutes 30]

With --wait-minutes > 0 the script prints the exact browser step + a
single-use frontdoor URL, opens the browser when possible, then polls until
the human finishes and resumes automatically. With --wait-minutes 0 it fails
fast at the first unmet gate with resume instructions (re-runs are idempotent).

Only the Python standard library + `sf` CLI on PATH. No hardcoding: every
org/user/channel/app value comes from flags or live org discovery.
"""

import argparse
import json
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tubot_postinstall as wiz

AUTO_SETUP_VERSION = "1.0.0"
POLL_INTERVAL_S = 60
PANEL_POLL_INTERVAL_S = 30
CREATE_RETRY_EVERY_N_POLLS = 5


def frontdoor_url(org: Dict[str, str], path: str) -> str:
    res = wiz.run_sf(["org", "open", "-p", path, "--target-org", org["target_flag"], "--url-only"])
    return res.get("data", {}).get("result", {}).get("url") or f"{org['instance_url']}{path}"


def maybe_open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception as e:
        wiz.log_warn(f"Could not open a browser automatically: {e}")


def existing_channels(org: Dict[str, str]) -> List[Dict[str, Any]]:
    res = wiz.run_sf(["data", "query", "--query",
                      "SELECT Id, DeveloperName, MasterLabel, MessageType, IsActive FROM MessagingChannel ORDER BY CreatedDate DESC",
                      "--target-org", org["target_flag"]])
    if res["returncode"] != 0:
        return []
    return res["data"].get("result", {}).get("records", [])


def messaging_licenses(org: Dict[str, str]) -> List[str]:
    res = wiz.run_sf(["data", "query", "--query",
                      "SELECT MasterLabel, TotalLicenses, Status FROM PermissionSetLicense "
                      "WHERE MasterLabel LIKE '%Messaging%' OR MasterLabel LIKE '%Digital%' LIMIT 10",
                      "--target-org", org["target_flag"]])
    if res["returncode"] != 0:
        return []
    return [f"{r.get('MasterLabel')} x{r.get('TotalLicenses')} ({r.get('Status')})"
            for r in res["data"].get("result", {}).get("records", [])]


def resolve_user_auto(org: Dict[str, str], requested: Optional[str]) -> Dict[str, str]:
    """Deterministic user resolution: flag match, else first Standard user."""
    if requested:
        return wiz.select_integration_user(org, requested, True)
    res = wiz.run_sf(["data", "query", "--query",
                      "SELECT Id, Name, Username, Email, UserType FROM User WHERE IsActive = true ORDER BY CreatedDate ASC",
                      "--target-org", org["target_flag"]])
    if res["returncode"] != 0:
        wiz.log_error(f"Failed to query active users: {res.get('error_msg') or res['stderr']}")
        sys.exit(1)
    records = res["data"].get("result", {}).get("records", [])
    eligible = [r for r in records if r.get("UserType") == "Standard"] or records
    if not eligible:
        wiz.log_error("No active users found in target Salesforce org.")
        sys.exit(1)
    chosen = eligible[0]
    wiz.log_success(f"Auto-selected Integration User: {chosen.get('Name')} ({chosen.get('Username')})")
    return {"id": chosen["Id"], "username": chosen["Username"],
            "name": chosen.get("Name", ""), "email": chosen.get("Email", "")}


def ensure_channel(org: Dict[str, str], user: Dict[str, str], args: argparse.Namespace) -> Dict[str, str]:
    wiz.log_phase("Auto: Resolving Messaging Channel")
    if args.channel:
        found = [c for c in existing_channels(org)
                 if args.channel in (c.get("Id"), c.get("DeveloperName"), c.get("MasterLabel"))]
        if found:
            return wiz.select_or_create_channel(org, user, args.channel, True, None)
        wiz.log_error(f"Requested channel '{args.channel}' not found (fail fast on explicit request).")
        sys.exit(1)
    channels = existing_channels(org)
    if channels:
        ch = channels[0]
        wiz.log_info(f"Auto-selecting newest existing channel {ch.get('DeveloperName')} ({ch.get('Id')}).")
        return wiz.select_or_create_channel(org, user, ch.get("DeveloperName") or ch["Id"], True, None)
    try:
        return wiz.create_channel_and_queue(org, user, "Web_Chat_Channel", "Web Chat Channel", None, True)
    except SystemExit:
        pass  # Diagnosed + parked below.
    return park_on_messaging_gate(org, user, args)


def park_on_messaging_gate(org: Dict[str, str], user: Dict[str, str], args: argparse.Namespace) -> Dict[str, str]:
    licenses = messaging_licenses(org)
    setup_url = frontdoor_url(org, "/lightning/setup/MessagingSettings/home")
    wiz.log_warn("MessagingChannel auto-creation failed: this org has Messaging/Chat disabled")
    wiz.log_warn("(metadata deploy rejected; direct insert requires Enhanced Chat).")
    if licenses:
        wiz.log_info(f"Messaging-related licenses present: {'; '.join(licenses)}")
    else:
        wiz.log_warn("No Messaging/Digital Engagement licenses found — the org may need them provisioned first.")
    print(f"\n{wizard_yellow()}Human step (~2 min): enable Messaging, then this script resumes itself:{wiz.RESET}")
    print("  1. Open (single-use, authenticated):")
    print(f"     {wiz.CYAN}{setup_url}{wiz.RESET}")
    print("  2. Setup Quick Find -> 'Messaging Settings' -> enable Messaging,")
    print("     or Setup -> 'Omni-Channel Settings' -> enable Enhanced Chat.")
    print("  3. Either create a Messaging Channel in Setup, or do nothing and")
    print("     this script will retry creating Web_Chat_Channel automatically.")
    if args.wait_minutes <= 0:
        wiz.log_error("Failing fast (--wait-minutes 0). Re-run this same command after enabling Messaging; it resumes.")
        sys.exit(1)
    maybe_open_browser(setup_url)
    deadline = time.time() + args.wait_minutes * 60
    polls = 0
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_S)
        polls += 1
        channels = existing_channels(org)
        if channels:
            ch = channels[0]
            wiz.log_success(f"Detected channel {ch.get('DeveloperName')} ({ch.get('Id')}). Resuming.")
            return wiz.select_or_create_channel(org, user, ch.get("DeveloperName") or ch["Id"], True, None)
        if polls % CREATE_RETRY_EVERY_N_POLLS == 0:
            wiz.log_info("Retrying automatic channel creation...")
            try:
                return wiz.create_channel_and_queue(org, user, "Web_Chat_Channel", "Web Chat Channel", None, True)
            except SystemExit:
                wiz.log_info("Still blocked. Continuing to wait for the Setup change...")
        else:
            wiz.log_info(f"Waiting for a Messaging Channel... ({int((deadline - time.time()) / 60)} min left)")
    wiz.log_error("Timed out waiting for Messaging enablement. Re-run to resume (idempotent).")
    sys.exit(1)


def wizard_yellow() -> str:
    return f"{wiz.YELLOW}{wiz.BOLD}"


def ensure_panel(org: Dict[str, str], args: argparse.Namespace) -> Dict[str, Any]:
    wiz.log_phase("Auto: Verifying Panel Connection")
    connected, details = wiz.check_panel_connection(org)
    if connected:
        wiz.log_success(f"Panel already connected: {details.get('teamName')} ({details.get('teamId')}).")
        return {"team_id": details.get("teamId", "N/A"), "team_name": details.get("teamName", "N/A"), "details": details}
    panel_url = frontdoor_url(org, "/lightning/n/tubot__Panel_Settings")
    print(f"\n{wizard_yellow()}Human step (~1 min): Panel login, then this script resumes itself:{wiz.RESET}")
    print("  1. Open (single-use, authenticated):")
    print(f"     {wiz.CYAN}{panel_url}{wiz.RESET}")
    print("  2. Click 'Connect Panel' / 'Log in with Panel' to mint the Panel OAuth token.")
    if args.wait_minutes <= 0:
        wiz.log_error("Failing fast (--wait-minutes 0). Re-run this same command after Panel login; it resumes.")
        sys.exit(1)
    maybe_open_browser(panel_url)
    deadline = time.time() + args.wait_minutes * 60
    while time.time() < deadline:
        time.sleep(PANEL_POLL_INTERVAL_S)
        connected, details = wiz.check_panel_connection(org)
        if connected:
            wiz.log_success(f"Panel connected: {details.get('teamName')} ({details.get('teamId')}). Resuming.")
            return {"team_id": details.get("teamId", "N/A"), "team_name": details.get("teamName", "N/A"), "details": details}
        wiz.log_info(f"Waiting for Panel login... ({int((deadline - time.time()) / 60)} min left)")
    wiz.log_error("Timed out waiting for Panel login. Re-run to resume (idempotent).")
    sys.exit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="TuBot Panel + Messaging auto-setup (zero-prompt).")
    parser.add_argument("--target-org", help="sf alias/username of the org to provision (no default).")
    parser.add_argument("-u", "--integration-user", help="Integration User (Username, Email, or ID). Default: first Standard user.")
    parser.add_argument("-c", "--channel", help="MessagingChannel (DeveloperName or ID). Default: newest existing, else auto-create.")
    parser.add_argument("-n", "--app-name", default="Tubot_SF_Channel_API", help="ECA DeveloperName.")
    parser.add_argument("--package-id", help="TuBot package version ID (default: latest in sfdx-project.json).")
    parser.add_argument("--skip-package-install", action="store_true", help="Skip package verification/installation.")
    parser.add_argument("--skip-verify", action="store_true", help="Skip post-setup blind verification.")
    parser.add_argument("--wait-minutes", type=int, default=30, help="Minutes to poll at each human gate (0 = fail fast).")
    parser.add_argument("--json", action="store_true", help="Output JSON result only.")
    parser.add_argument("--version", action="store_true", help="Print version and exit.")
    return parser


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    if args.version:
        print(AUTO_SETUP_VERSION)
        return
    if not args.target_org:
        parser.error("--target-org is required (no default org is ever assumed).")

    org = wiz.resolve_org(args.target_org)
    if not args.skip_package_install:
        wiz.ensure_tubot_package_installed(org["target_flag"], package_id=args.package_id)
    user = resolve_user_auto(org, args.integration_user)

    # Fully automatic first: ECA deploy + credential extraction need no human.
    wiz.log_phase("Auto: External Client App Provisioning")
    wiz.ensure_permission_set(org, user)
    wiz.deploy_external_client_app(org, user, args.app_name)
    client_id, client_secret = wiz.extract_eca_credentials(org, args.app_name)

    channel = ensure_channel(org, user, args)
    panel_conn = ensure_panel(org, args)

    wiz.register_channel_with_panel(org, channel, user, client_id, client_secret)
    record_id = wiz.upsert_salesforce_api_channel_record(org, channel, user, panel_conn["team_id"])
    if not args.skip_verify:
        wiz.verify_setup(org, channel, user, client_id, client_secret, record_id)

    result = {"success": True, "auto_setup_version": AUTO_SETUP_VERSION,
              "org": {"alias": org["alias"], "org_id": org["org_id"]},
              "user": {"name": user["name"], "username": user["username"]},
              "channel": channel, "panel": {"teamId": panel_conn["team_id"], "teamName": panel_conn["team_name"]},
              "eca": {"appName": args.app_name, "clientId": client_id},
              "salesforceChannelRecordId": record_id}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\n{wiz.GREEN}{wiz.BOLD}TuBot auto-setup complete!{wiz.RESET}\n"
              f"  Org: {org['alias']} ({org['org_id']})\n"
              f"  User: {user['name']} ({user['username']})\n"
              f"  Channel: {channel['label']} ({channel['developer_name']}, Id: {channel['id']})\n"
              f"  Panel team: {panel_conn['team_name']} ({panel_conn['team_id']})\n"
              f"  ECA: {args.app_name} ({client_id[:12]}...)\n"
              f"  Channel record: {record_id}\n")


if __name__ == "__main__":
    main()
