#!/usr/bin/env python3
"""
==============================================================================
TuBot Salesforce Org Audit (read-only health report)
==============================================================================
Reports what setup parts an org HAS and what is MISSING, without changing
anything:

  - Org access (connection, user, API permission, scratch vs production)
  - TuBot package (installed version)
  - Licenses & features (Integration user licenses, Messaging, Omni)
  - Permission sets (packaged + repair; existence and assignments)
  - Messaging channels and queues
  - Channel config records (tubot__Tubot_API_Channel__c)
  - Panel auth (credential rows, MCP identity/tokens, LIVE callout test)
  - Credential definitions (packaged vs unpackaged external/named/remote)
  - ECA registry (Tubot External Client Apps)
  - Panel-side channel credentials (when logged in)

Ground-truth rules: a definition merely existing is NOT health. Panel login
is effective only when credential rows exist AND the live callout succeeds;
the audit says so explicitly instead of trusting self-reported flags.

The target org is always picked interactively from authenticated orgs.
==============================================================================
"""

AUDIT_VERSION = "1.0.0"

import argparse
import contextlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Resolve sibling modules (shared sf/Panel helpers + teardown discovery).
for _candidate in [
    Path(__file__).resolve().parent,
    Path.cwd() / "tubot-sf-auth" / "tubot-sf-package" / "scripts",
]:
    if (_candidate / "tubot_postinstall.py").exists():
        sys.path.insert(0, str(_candidate))
        break

try:
    from tubot_postinstall import (  # noqa: E402
        BOLD,
        CYAN,
        DIM,
        GREEN,
        RED,
        RESET,
        YELLOW,
        check_panel_connection,
        log_error,
        log_info,
        log_phase,
        resolve_org,
        run_sf,
        select_target_org,
    )
    from tubot_teardown import (  # noqa: E402
        list_api_channel_records,
        list_credential_definitions,
        list_mcp_token_rows,
        list_panel_channels,
        list_panel_credential_rows,
        list_tubot_ecas,
    )
except ImportError as exc:
    print(f"[ERROR] Could not import sibling modules: {exc}", file=sys.stderr)
    print("[ERROR] Audit must run from tubot-sf-auth/tubot-sf-package/scripts/.", file=sys.stderr)
    sys.exit(1)


# ==============================================================================
# Check plumbing (fail-soft: audit never crashes on a probe failure)
# ==============================================================================
def probe(org: Dict[str, str], soql: str, tooling: bool = False) -> Tuple[bool, Any]:
    """Run a read-only query. Returns (ok, records-or-error-string)."""
    try:
        args = ["data", "query", "--query", soql, "--target-org", org["target_flag"]]
        if tooling:
            args.insert(2, "--use-tooling-api")
        res = run_sf(args)
    except Exception as exc:
        return False, str(exc)[:200]
    if res["returncode"] != 0:
        return False, (res.get("error_msg") or res["stderr"] or "query failed")[:200]
    return True, res["data"].get("result", {}).get("records", [])


def soft_call(label: str, func, *args) -> Tuple[bool, Any]:
    """Call a discovery helper that may sys.exit; degrade to unknown instead."""
    try:
        return True, func(*args)
    except SystemExit:
        return False, f"{label} probe unavailable"
    except Exception as exc:
        return False, (f"{label} probe error: {exc}")[:200]


def make_check(section: str, name: str, status: str, detail: str = "") -> Dict[str, str]:
    """status: OK | MISSING | WARN | INFO."""
    return {"section": section, "name": name, "status": status, "detail": detail}


STATUS_DOT = {"OK": GREEN + "\u25cf" + RESET, "MISSING": RED + "\u25cf" + RESET,
              "WARN": YELLOW + "\u25cf" + RESET, "INFO": DIM + "\u25cf" + RESET}


# ==============================================================================
# Collectors (one per section)
# ==============================================================================
def collect_org(org: Dict[str, str]) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    checks: List[Dict[str, str]] = []
    facts: Dict[str, Any] = {"user_id": ""}
    username = org.get("username", "")
    ok, rows = probe(org, f"SELECT Id, Username, Profile.Name, Profile.PermissionsApiEnabled FROM User "
                          f"WHERE Username = '{username}' LIMIT 1")
    api_enabled: Optional[bool] = None
    profile = ""
    if ok and rows:
        facts["user_id"] = rows[0].get("Id", "")
        prof = rows[0].get("Profile") or {}
        if isinstance(prof, dict):
            profile = prof.get("Name", "")
            api_enabled = prof.get("PermissionsApiEnabled")
    facts.update({"username": username, "profile": profile, "api_enabled": api_enabled})
    checks.append(make_check("Org", "connection",
                             "OK", f"{org.get('alias')} ({org.get('org_id')}) as {username} [{profile}]"))
    if api_enabled is True:
        checks.append(make_check("Org", "api_enabled", "OK", "running user has API Enabled"))
    elif api_enabled is False:
        checks.append(make_check("Org", "api_enabled", "MISSING", "running user lacks API Enabled"))
    else:
        checks.append(make_check("Org", "api_enabled", "WARN", "could not read user permissions"))
    ok, rows = probe(org, "SELECT IsSandbox, OrganizationType, TrialExpirationDate FROM Organization LIMIT 1")
    if ok and rows:
        otype = rows[0].get("OrganizationType", "?")
        checks.append(make_check("Org", "org_type", "INFO",
                                 f"{otype} (sandbox={rows[0].get('IsSandbox')})"))
    else:
        checks.append(make_check("Org", "org_type", "WARN", "organization type unreadable"))
    return checks, facts


def collect_package(org: Dict[str, str]) -> List[Dict[str, str]]:
    res = run_sf(["package", "installed", "list", "--target-org", org["target_flag"]])
    if res["returncode"] != 0:
        return [make_check("Package", "tubot_installed", "WARN", "installed-package list unavailable")]
    found = [p for p in (res["data"].get("result") or [])
             if "tubot" in (p.get("SubscriberPackageName") or "").lower()]
    if not found:
        return [make_check("Package", "tubot_installed", "MISSING", "TuBot package not installed")]
    ver = found[0].get("SubscriberPackageVersionNumber", "?")
    return [make_check("Package", "tubot_installed", "OK", f"TuBot {ver} installed")]


def collect_licenses(org: Dict[str, str]) -> List[Dict[str, str]]:
    checks: List[Dict[str, str]] = []
    ok, rows = probe(org, "SELECT TotalLicenses, UsedLicenses FROM UserLicense "
                          "WHERE MasterLabel LIKE '%Integration%' OR LicenseDefinitionKey LIKE '%INTEGRATION%'")
    if not ok:
        checks.append(make_check("Licenses", "integration_licenses", "WARN", str(rows)))
    else:
        total = sum((r.get("TotalLicenses") or 0) for r in rows)
        used = sum((r.get("UsedLicenses") or 0) for r in rows)
        checks.append(make_check("Licenses", "integration_licenses", "INFO" if total else "WARN",
                                 f"{max(0, total - used)} of {total} Integration licenses available"))
    ok, rows = probe(org, "SELECT Id FROM MessagingChannel LIMIT 1")
    checks.append(make_check("Licenses", "messaging_objects",
                             "OK" if ok else "MISSING",
                             "MessagingChannel readable" if ok else f"Messaging not available ({rows})"))
    ok, rows = probe(org, "SELECT Id FROM QueueRoutingConfig LIMIT 1")
    checks.append(make_check("Licenses", "omni_objects",
                             "OK" if ok else "WARN",
                             "QueueRoutingConfig readable" if ok else f"Omni objects unreadable ({rows})"))
    ok, rows = probe(org, "SELECT Name FROM `Group` WHERE Type = 'Queue'".replace("`", ""))
    if ok:
        names = sorted(r.get("Name", "") for r in rows)
        checks.append(make_check("Licenses", "queues", "INFO" if names else "WARN",
                                 f"{len(names)} queue(s): {', '.join(names[:8])}" + ("..." if len(names) > 8 else "")))
    else:
        checks.append(make_check("Licenses", "queues", "WARN", str(rows)))
    return checks


def collect_permsets(org: Dict[str, str], user_id: str) -> List[Dict[str, str]]:
    checks: List[Dict[str, str]] = []
    bases = ["Tubot_Salesforce_API_Read", "Panel_Settings_Admin_Access", "Tubot_Channel_Connection_Admin_Access"]
    conds = " OR ".join([f"Name = '{b}' OR Name LIKE '%__{b}'" for b in bases])
    ok, rows = probe(org, f"SELECT Id, Name, NamespacePrefix FROM PermissionSet WHERE {conds}")
    found = {(r.get("Name") or "").split("__")[-1]: r for r in (rows if ok else [])}
    mine: Dict[str, bool] = {}
    if found:
        ids = ",".join(f"'{r['Id']}'" for r in found.values())
        ok2, rows2 = probe(org, f"SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '{user_id}' "
                                f"AND PermissionSetId IN ({ids})")
        mine = {r["PermissionSetId"] for r in (rows2 if ok2 else [])}
    for base in bases:
        row = found.get(base)
        if row is None:
            checks.append(make_check("Permsets", base, "MISSING", "permission set not found"))
        else:
            ns = row.get("NamespacePrefix") or "-"
            assigned = row["Id"] in mine
            checks.append(make_check("Permsets", base, "OK" if assigned else "WARN",
                                     f"exists [{ns}], " + ("assigned to you" if assigned else "NOT assigned to you")))
    ok, rows = probe(org, "SELECT Id, Assignee.Username FROM PermissionSetAssignment "
                          "WHERE PermissionSet.Name = 'Tubot_Salesforce_API_Read'")
    if ok:
        users = sorted({(r.get("Assignee") or {}).get("Username", "?") for r in rows})
        checks.append(make_check("Permsets", "api_read_assignees", "INFO" if users else "WARN",
                                 ("assigned to: " + ", ".join(users)) if users else "assigned to nobody"))
    else:
        checks.append(make_check("Permsets", "api_read_assignees", "WARN", str(rows)))
    ok, rows = probe(org, "SELECT Id FROM PermissionSet WHERE Name = 'TuBot_Panel_External_Credential_Admin_Repair'")
    checks.append(make_check("Permsets", "repair_permset", "INFO" if (ok and rows) else "INFO",
                             "repair permset present" if (ok and rows) else "repair permset absent (recreated by setup when needed)"))
    return checks


def collect_channels(org: Dict[str, str]) -> List[Dict[str, str]]:
    ok, rows = probe(org, "SELECT DeveloperName, MasterLabel, IsActive FROM MessagingChannel ORDER BY CreatedDate DESC")
    if not ok:
        return [make_check("Channels", "messaging_channels", "WARN", str(rows))]
    if not rows:
        return [make_check("Channels", "messaging_channels", "WARN", "no MessagingChannels in org")]
    detail = "; ".join(f"{r.get('DeveloperName')}({'active' if r.get('IsActive') else 'inactive'})" for r in rows[:10])
    return [make_check("Channels", "messaging_channels", "OK", f"{len(rows)} channel(s): {detail}")]


def collect_records(org: Dict[str, str], channel_filter: Optional[str] = None) -> List[Dict[str, str]]:
    ok, records = soft_call("channel records", list_api_channel_records, org, channel_filter)
    if not ok:
        return [make_check("Records", "channel_configs", "WARN", str(records))]
    if not records:
        return [make_check("Records", "channel_configs", "INFO", "no tubot__Tubot_API_Channel__c rows")]
    detail = "; ".join(f"{r.get('tubot__Channel_Id__c')} via {r.get('tubot__Integration_User_Id__c')}" for r in records[:10])
    return [make_check("Records", "channel_configs", "OK", f"{len(records)} row(s): {detail}")]


def collect_panel_auth(org: Dict[str, str]) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    checks: List[Dict[str, str]] = []
    facts: Dict[str, Any] = {"rows": 0, "live_ok": False, "mcp_identity": False, "mcp_tokens": False}
    ok, rows = soft_call("credential rows", list_panel_credential_rows, org)
    nrows = len(rows) if ok else 0
    facts["rows"] = nrows
    checks.append(make_check("PanelAuth", "credential_rows",
                             "OK" if nrows else ("WARN" if ok else "WARN"),
                             f"{nrows} UserExternalCredential row(s) for Panel" if ok else str(rows)))
    ok, mcp_rows = soft_call("mcp config", list_mcp_token_rows, org)
    if not ok:
        checks.append(make_check("PanelAuth", "mcp_tokens", "WARN", str(mcp_rows)))
    else:
        facts["mcp_tokens"] = bool(mcp_rows)
        checks.append(make_check("PanelAuth", "mcp_tokens", "INFO" if not mcp_rows else "WARN",
                                 "no legacy tokens stored" if not mcp_rows
                                 else f"{len(mcp_rows)} MCP row(s) hold legacy tokens"))
    ok, idrows = probe(org, "SELECT tubot__Panel_Team_Id__c, tubot__Panel_User_Email__c FROM tubot__MCP_Config__c LIMIT 1")
    if ok and idrows and (idrows[0].get("tubot__Panel_Team_Id__c") or ""):
        facts["mcp_identity"] = True
        checks.append(make_check("PanelAuth", "mcp_identity", "OK",
                                 f"team {idrows[0].get('tubot__Panel_Team_Id__c')} ({idrows[0].get('tubot__Panel_User_Email__c') or '?'})"))
    elif ok:
        checks.append(make_check("PanelAuth", "mcp_identity", "INFO", "no MCP team identity stored"))
    else:
        checks.append(make_check("PanelAuth", "mcp_identity", "INFO", "MCP config unreadable (older package?)"))
    try:
        live_ok, info = check_panel_connection(org)
    except Exception as exc:
        live_ok, info = False, {"team_name": f"check error: {exc}"[:150]}
    facts["live_ok"] = live_ok
    checks.append(make_check("PanelAuth", "live_callout", "OK" if live_ok else "MISSING",
                             f"Panel team: {info.get('team_name')}" if live_ok
                             else "live Panel callout failed (not logged in)"))
    effective = nrows > 0 and live_ok
    facts["effective"] = effective
    if nrows > 0 and not live_ok:
        checks.append(make_check("PanelAuth", "verdict", "WARN",
                                 "credential rows exist but live callout FAILS: token invalid or revoked server-side"))
    elif live_ok:
        checks.append(make_check("PanelAuth", "verdict", "OK", "Panel login effective (rows + live callout agree)"))
    else:
        checks.append(make_check("PanelAuth", "verdict", "INFO", "not logged into Panel (no rows, callout fails)"))
    return checks, facts


def collect_definitions(org: Dict[str, str]) -> List[Dict[str, str]]:
    ok, defs = soft_call("credential definitions", list_credential_definitions, org)
    if not ok:
        return [make_check("Definitions", "credential_definitions", "WARN", str(defs))]
    checks: List[Dict[str, str]] = []
    delete = [f"{m}:{n}" for m, n in defs["delete"]]
    checks.append(make_check("Definitions", "unpackaged_setup_defs", "INFO",
                             ("present: " + ", ".join(delete)) if delete else "none present (fully bare)"))
    checks.append(make_check("Definitions", "packaged_defs", "INFO" if defs["kept"] else "WARN",
                             ("present: " + ", ".join(defs["kept"])) if defs["kept"]
                             else "packaged Panel credential definitions MISSING (package install incomplete?)"))
    checks.append(make_check("Definitions", "principals_note", "INFO",
                             "principals are not SOQL-queryable; the live callout is the functional principal test"))
    return checks


def collect_eca(org: Dict[str, str]) -> List[Dict[str, str]]:
    ok, ecas = soft_call("eca registry", list_tubot_ecas, org)
    if not ok or ecas is None:
        return [make_check("ECA", "tubot_ecas", "WARN", "OAuth registry unreadable")]
    if not ecas:
        return [make_check("ECA", "tubot_ecas", "INFO", "no Tubot ECAs registered")]
    names = sorted(a.get("developerName", "?") for a in ecas)
    return [make_check("ECA", "tubot_ecas", "OK", f"{len(names)} app(s): {', '.join(names)}")]


def collect_panel_side(org: Dict[str, str], connected: bool) -> List[Dict[str, str]]:
    if not connected:
        return [make_check("PanelSide", "panel_channels", "INFO", "skipped (org not logged into Panel)")]
    ok, channels = soft_call("panel channels", list_panel_channels, org)
    if not ok:
        return [make_check("PanelSide", "panel_channels", "WARN", str(channels))]
    ids = [c.get("channelId", "?") for c in channels]
    return [make_check("PanelSide", "panel_channels", "INFO",
                       f"{len(ids)} Panel-side channel(s): {', '.join(ids)}" if ids else "Panel holds no channels for this org")]


# ==============================================================================
# Verdict + report
# ==============================================================================
def build_verdict(checks: List[Dict[str, str]], facts: Dict[str, Any]) -> Dict[str, Any]:
    by_name = {(c["section"], c["name"]): c["status"] for c in checks}
    items = [
        ("package", "TuBot package installed", by_name.get(("Package", "tubot_installed")) == "OK",
         "install the package"),
        ("api_permset", "API permission set exists", by_name.get(("Permsets", "Tubot_Salesforce_API_Read")) in ("OK", "WARN"),
         "install/upgrade the package"),
        ("channel", "at least one MessagingChannel", by_name.get(("Channels", "messaging_channels")) == "OK",
         "create a channel (post-install does it)"),
        ("records", "channel config record(s)", by_name.get(("Records", "channel_configs")) == "OK",
         "run the post-install wizard"),
        ("eca", "Tubot ECA registered", by_name.get(("ECA", "tubot_ecas")) == "OK",
         "run the post-install wizard"),
        ("panel", "Panel login effective", bool(facts.get("effective")),
         "sign in via Panel Settings, then re-run post-install"),
    ]
    missing = [f"{label} -> {action}" for _, label, have, action in items if not have]
    return {"complete": not missing,
            "items": [{"key": k, "label": label, "have": have} for k, label, have, _ in items],
            "missing": missing}


def print_report(org: Dict[str, str], checks: List[Dict[str, str]], verdict: Dict[str, Any]) -> None:
    print(f"\n{BOLD}{CYAN}=============================================================================={RESET}")
    print(f"{BOLD}{CYAN}TuBot Org Audit v{AUDIT_VERSION}: {org.get('alias')} ({org.get('org_id')}){RESET}")
    print(f"{BOLD}{CYAN}=============================================================================={RESET}")
    section = ""
    for c in checks:
        if c["section"] != section:
            section = c["section"]
            print(f"\n{BOLD}[{section}]{RESET}")
        dot = STATUS_DOT.get(c["status"], "?")
        line = f"  {dot} {c['name']}: {c['status']}"
        if c["detail"]:
            line += f" -- {c['detail']}"
        print(line)
    print(f"\n{BOLD}[Verdict]{RESET}")
    for item in verdict["items"]:
        mark = f"{GREEN}have{RESET}" if item["have"] else f"{RED}need{RESET}"
        print(f"  [{mark}] {item['label']}")
    if verdict["complete"]:
        print(f"\n{GREEN}{BOLD}Setup complete: nothing missing.{RESET}\n")
    else:
        print(f"\n{YELLOW}{BOLD}Missing:{RESET}")
        for m in verdict["missing"]:
            print(f"  - {m}")
        print()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="TuBot Salesforce Org Audit: read-only report of setup parts present vs missing"
    )
    parser.add_argument("--json", action="store_true", help="Output JSON report only")
    parser.add_argument("--version", action="store_true", help="Print audit version and exit")
    return parser


def _collect_report() -> Dict[str, Any]:
    # Org selection is ALWAYS interactive (never auto-selected).
    target_org = select_target_org(False)
    org = resolve_org(target_org)
    log_phase("Collecting org state (read-only)")

    checks: List[Dict[str, str]] = []
    facts: Dict[str, Any] = {}
    org_checks, org_facts = collect_org(org)
    checks.extend(org_checks)
    facts.update(org_facts)
    user_id = facts.get("user_id") or ""
    checks.extend(collect_package(org))
    checks.extend(collect_licenses(org))
    checks.extend(collect_permsets(org, user_id))
    checks.extend(collect_channels(org))
    checks.extend(collect_records(org))
    auth_checks, auth_facts = collect_panel_auth(org)
    checks.extend(auth_checks)
    facts.update(auth_facts)
    checks.extend(collect_definitions(org))
    checks.extend(collect_eca(org))
    checks.extend(collect_panel_side(org, facts.get("live_ok", False)))
    verdict = build_verdict(checks, facts)

    return {"success": True, "audit_version": AUDIT_VERSION,
            "org": {"alias": org.get("alias"), "org_id": org.get("org_id"),
                    "instance_url": org.get("instance_url"), "username": facts.get("username")},
            "checks": checks, "verdict": verdict}


def run_audit(args: argparse.Namespace) -> Dict[str, Any]:
    if args.json:
        # Keep stdout pure JSON: wizard chatter goes to stderr, stdin still works.
        with contextlib.redirect_stdout(sys.stderr):
            report = _collect_report()
        print(json.dumps(report, indent=2))
        return report
    report = _collect_report()
    print_report(report["org"], report["checks"], report["verdict"])
    return report


def main(argv: Optional[List[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(AUDIT_VERSION)
        return
    run_audit(args)


if __name__ == "__main__":
    main()
