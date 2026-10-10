#!/usr/bin/env python3
"""
==============================================================================
TuBot Salesforce De-Setup (Teardown) Wizard (Zero-Mock Interactive CLI)
==============================================================================
Reverses the post-install and returns the org to bare state, removing the
TuBot managed package itself and every related artifact. The wizard always
lists authenticated orgs and requires the user to pick the target — it
never auto-selects an org.

Removes (with per-run confirmation):
  1. Panel-side channel + execution-user credentials (via Named Credential
     callout, before logout).
  2. tubot__Tubot_API_Channel__c records ("integration user config").
  3. Tubot_Salesforce_API_Read permission set assignments for those users.
  4. Legacy local External Client App metadata (default Tubot_SF_Channel_API).
     Packaged ECAs are removed by the package uninstall instead.
  5. Panel login (UserExternalCredential rows plus legacy MCP token fields).
  6. Unpackaged credential definitions (repair-deployed Panel External /
     Named Credential, Panel remote site, repair permission set).
  7. Tubot_JWT_PreAuth assignments (all users) and all unpackaged TuBot
     permission sets.
  8. Subscriber ECA pre-authorization policies for the packaged app.
  9. Active TuBot package flows are deactivated, then every installed TuBot
     managed package version is uninstalled.

Kept by design: MessagingChannels (and their queues) only. Everything else
TuBot-related goes, including admin permission set assignments granted by
setup (re-run setup to restore them).

Every deletion is blind-verified by re-querying ground truth. Run with
--inventory-only to preview without deleting anything.
==============================================================================
"""

TEARDOWN_VERSION = "1.2.3"

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Resolve the canonical post-install module (shared sf/Panel helpers).
_POSTINSTALL_CANDIDATES = [
    Path(__file__).resolve().parent,
    Path(__file__).resolve().parent.parent.parent.parent / "scripts",
    Path.cwd() / "tubot-sf-auth" / "tubot-sf-package" / "scripts",
]
for _candidate in _POSTINSTALL_CANDIDATES:
    if (_candidate / "tubot_postinstall.py").exists():
        sys.path.insert(0, str(_candidate))
        break

try:
    from tubot_postinstall import (  # noqa: E402
        BOLD,
        CYAN,
        RESET,
        extract_debug_values,
        log_error,
        log_info,
        log_phase,
        log_success,
        log_warn,
        prompt,
        resolve_org,
        run_apex,
        run_sf,
        select_target_org,
        sf_error,
    )
except ImportError:
    try:
        from tubot_postinstall import (  # noqa: E402
            BOLD,
            CYAN,
            RESET,
            extract_debug_values,
            log_error,
            log_info,
            log_phase,
            log_success,
            log_warn,
            prompt,
            resolve_org,
            run_apex,
            run_sf,
            select_target_org,
        )
        def sf_error(res: Dict[str, Any]) -> str:  # type: ignore
            if not isinstance(res, dict):
                return str(res)
            return res.get("error_msg") or res.get("stderr") or res.get("stdout") or "Unknown error"
    except ImportError as exc:
        print(f"[ERROR] Could not import tubot_postinstall module: {exc}", file=sys.stderr)
        print("[ERROR] Teardown must run from tubot-sf-auth/tubot-sf-package/scripts/ (or alongside it).", file=sys.stderr)
        sys.exit(1)


# ==============================================================================
# Inventory (read-only discovery)
# ==============================================================================
def _is_invalid_type_error(res: Dict[str, Any]) -> bool:
    """Return True if Salesforce returned INVALID_TYPE / sObject not supported."""
    err = (
        (res.get("error_msg") or "")
        + "\n"
        + (res.get("stderr") or "")
        + "\n"
        + (res.get("stdout") or "")
        + "\n"
        + sf_error(res)
    ).lower()
    data = res.get("data")
    if isinstance(data, dict):
        if str(data.get("name", "")).lower() == "invalid_type":
            return True
        if str(data.get("data", {}).get("errorCode", "")).lower() == "invalid_type":
            return True
    return "invalid_type" in err or "not supported" in err


def list_api_channel_records(org: Dict[str, str], channel_filter: Optional[str] = None) -> List[Dict[str, Any]]:
    """List tubot__Tubot_API_Channel__c records, optionally filtered to one channel."""
    soql = (
        "SELECT Id, tubot__Channel_Id__c, tubot__Integration_User_Id__c, tubot__Team_Id__c "
        "FROM tubot__Tubot_API_Channel__c ORDER BY CreatedDate DESC"
    )
    res = run_sf(["data", "query", "--query", soql, "--target-org", org["target_flag"]])
    if res["returncode"] != 0:
        if _is_invalid_type_error(res):
            return []
        log_error(f"Failed to query Tubot API channel records: {sf_error(res)}")
        sys.exit(1)
    records = (res["data"].get("result") or {}).get("records", []) or []
    if channel_filter:
        records = [r for r in records if channel_filter in (r.get("Id"), r.get("tubot__Channel_Id__c"))]
    return records


def list_api_perm_assignments(org: Dict[str, str], user_ids: List[str]) -> List[Dict[str, Any]]:
    """List Tubot_Salesforce_API_Read assignments for the given users."""
    if not user_ids:
        return []
    perm_res = run_sf([
        "data", "query", "--query",
        "SELECT Id FROM PermissionSet WHERE Name = 'Tubot_Salesforce_API_Read' LIMIT 1",
        "--target-org", org["target_flag"],
    ])
    perm_records = perm_res["data"].get("result", {}).get("records", [])
    if not perm_records:
        return []
    perm_id = perm_records[0]["Id"]
    quoted = ",".join(f"'{u}'" for u in sorted(set(user_ids)) if u)
    assign_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id, AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = '{perm_id}' AND AssigneeId IN ({quoted})",
        "--target-org", org["target_flag"],
    ])
    return assign_res["data"].get("result", {}).get("records", [])


def list_panel_credential_rows(org: Dict[str, str]) -> List[Dict[str, Any]]:
    """List UserExternalCredential rows holding the Panel login (both namespaces)."""
    res = run_sf([
        "data", "query", "--query",
        "SELECT Id, ExternalCredential.DeveloperName, ExternalCredential.NamespacePrefix "
        "FROM UserExternalCredential WHERE ExternalCredential.DeveloperName = 'Panel_External_Credential'",
        "--target-org", org["target_flag"],
    ])
    if res["returncode"] == 0:
        return res["data"].get("result", {}).get("records", [])
    # Fallback: resolve credential Ids first, then match rows by Id.
    cred_res = run_sf([
        "data", "query", "--query",
        "SELECT Id FROM ExternalCredential WHERE DeveloperName = 'Panel_External_Credential'",
        "--target-org", org["target_flag"],
    ])
    cred_ids = [r["Id"] for r in cred_res["data"].get("result", {}).get("records", [])]
    if not cred_ids:
        return []
    quoted = ",".join(f"'{c}'" for c in cred_ids)
    row_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id FROM UserExternalCredential WHERE ExternalCredentialId IN ({quoted})",
        "--target-org", org["target_flag"],
    ])
    if row_res["returncode"] != 0:
        return []
    return row_res["data"].get("result", {}).get("records", [])


MCP_TOKEN_FIELDS = [
    "tubot__Panel_Access_Token__c",
    "tubot__Panel_Refresh_Token__c",
    "tubot__Panel_Team_Id__c",
    "tubot__Panel_Team_Name__c",
    "tubot__Panel_User_Email__c",
    "tubot__Panel_User_Role__c",
    "tubot__Panel_Permissions__c",
    "tubot__Self_Org_ECA_Client_Id__c",
]


def list_mcp_token_rows(org: Dict[str, str]) -> List[Dict[str, Any]]:
    """List MCP config rows with populated legacy token/identity fields.

    The config row itself and public fields (Base URL, Client Id) are kept;
    only session/secret fields are cleared. Returns [] when the object is
    absent (older package) or no row holds tokens.
    """
    fields = ", ".join(["Id", "SetupOwnerId"] + MCP_TOKEN_FIELDS)
    res = run_sf([
        "data", "query", "--query", f"SELECT {fields} FROM tubot__MCP_Config__c",
        "--target-org", org["target_flag"],
    ])
    if res["returncode"] != 0:
        if _is_invalid_type_error(res):
            log_info("MCP config object absent (older package or uninstalled); nothing legacy to clear.")
            return []
        log_error(f"Failed to query MCP config: {sf_error(res)}")
        sys.exit(1)
    populated = []
    for row in (res["data"].get("result") or {}).get("records", []) or []:
        if any((row.get(f) or "") for f in MCP_TOKEN_FIELDS):
            populated.append(row)
    return populated


# Setup-owned unpackaged credential definitions. ONLY namespace-less entries
# with these exact DeveloperNames are ever deleted; packaged (tubot__*)
# definitions are package-owned and listed as kept.
CREDENTIAL_DEFINITION_ALLOWLIST = {
    "ExternalCredential": {"Panel_External_Credential"},
    "NamedCredential": {"Panel_Named_Credential"},
    "RemoteSiteSetting": {"Panel_Tubot_Active"},
    "PermissionSet": {"TuBot_Panel_External_Credential_Admin_Repair"},
}


def list_credential_definitions(org: Dict[str, str]) -> Dict[str, Any]:
    """Inventory setup-owned credential definitions (delete vs package-kept)."""
    flag = org["target_flag"]
    ext_res = run_sf([
        "data", "query", "--use-tooling-api", "--query",
        "SELECT DeveloperName, NamespacePrefix FROM ExternalCredential",
        "--target-org", flag,
    ])
    if ext_res["returncode"] != 0:
        log_error(f"Failed to query ExternalCredential: {sf_error(ext_res)}")
        sys.exit(1)
    named_res = run_sf([
        "data", "query", "--query",
        "SELECT DeveloperName, NamespacePrefix FROM NamedCredential",
        "--target-org", flag,
    ])
    if named_res["returncode"] != 0:
        log_error(f"Failed to query NamedCredential: {sf_error(named_res)}")
        sys.exit(1)
    site_res = run_sf([
        "data", "query", "--use-tooling-api", "--query",
        # Tooling API rejects a multi-row RemoteProxy query when FullName is
        # selected. SiteName is the RemoteSiteSetting metadata name for local
        # entries; namespaced entries are kept above as package-owned.
        "SELECT SiteName, NamespacePrefix FROM RemoteProxy",
        "--target-org", flag,
    ])
    if site_res["returncode"] != 0:
        log_error(f"Failed to query remote sites: {sf_error(site_res)}")
        sys.exit(1)
    perm_res = run_sf([
        "data", "query", "--query",
        "SELECT Id, Name, NamespacePrefix FROM PermissionSet "
        "WHERE Name = 'TuBot_Panel_External_Credential_Admin_Repair'",
        "--target-org", flag,
    ])
    if perm_res["returncode"] != 0:
        log_error(f"Failed to query repair permission set: {sf_error(perm_res)}")
        sys.exit(1)

    delete: List[Tuple[str, str]] = []
    kept: List[str] = []
    for meta, res, name_field in (("ExternalCredential", ext_res, "DeveloperName"),
                                  ("NamedCredential", named_res, "DeveloperName"),
                                  ("RemoteSiteSetting", site_res, "SiteName")):
        for row in res["data"].get("result", {}).get("records", []):
            dev = row.get(name_field) or ""
            ns = row.get("NamespacePrefix") or ""
            if dev not in CREDENTIAL_DEFINITION_ALLOWLIST[meta]:
                continue
            if ns:
                kept.append(f"{meta} {ns}__{dev} (package-owned)")
            else:
                delete.append((meta, row.get("FullName") or dev))
    repair_assignments: List[Dict[str, Any]] = []
    repair_perm = None
    for row in perm_res["data"].get("result", {}).get("records", []):
        if not (row.get("NamespacePrefix") or ""):
            repair_perm = row
    if repair_perm:
        delete.append(("PermissionSet", repair_perm["Name"]))
        assign_res = run_sf([
            "data", "query", "--query",
            f"SELECT Id, AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = '{repair_perm['Id']}'",
            "--target-org", flag,
        ])
        repair_assignments = assign_res["data"].get("result", {}).get("records", [])
    return {"delete": delete, "kept": sorted(kept), "repair_assignments": repair_assignments}


def _sf_access_token(org: Dict[str, str]) -> str:
    res = run_sf(["org", "auth", "show-access-token", "--target-org", org["target_flag"]])
    if res["returncode"] != 0:
        log_error("Failed to retrieve access token.")
        sys.exit(1)
    token = res["data"].get("result", {}).get("accessToken")
    if not token:
        log_error("Access token response did not contain a token.")
        sys.exit(1)
    return token


def list_tubot_ecas(org: Dict[str, str]) -> Optional[List[Dict[str, Any]]]:
    """List Tubot External Client Apps from the OAuth usage registry (None = unknown)."""
    try:
        token = _sf_access_token(org)
        url = f"{org['instance_url']}/services/data/v67.0/apps/oauth/usage"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        with urllib.request.urlopen(req) as resp:
            usage = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        log_warn(f"Could not read External Client App registry: {exc}")
        return None
    return [a for a in usage.get("apps", []) if (a.get("developerName") or "").startswith("Tubot")]


def list_panel_channels(org: Dict[str, str]) -> Tuple[bool, List[Dict[str, Any]]]:
    """List Panel-side channel credentials for this org. connected=False when logged out."""
    apex_code = f"""
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:tubot__Panel_Named_Credential/api/v1/salesforce/channels?orgId={org['org_id']}');
req.setMethod('GET');
Http http = new Http();
HttpResponse res = http.send(req);
System.debug('LIST_STATUS=' + res.getStatusCode());
System.debug('LIST_BODY=' + res.getBody());
"""
    success, output = run_apex(apex_code, org["target_flag"])
    if not success:
        return False, []
    statuses = extract_debug_values(output, "LIST_STATUS=")
    bodies = extract_debug_values(output, "LIST_BODY=")
    if not statuses or statuses[0] != "200" or not bodies:
        return False, []
    try:
        return True, json.loads(bodies[0]).get("channels", [])
    except json.JSONDecodeError:
        return True, []


# ==============================================================================
# Deletes (each blind-verified)
# ==============================================================================
def list_installed_tubot_packages(org: Dict[str, str]) -> List[Dict[str, Any]]:
    """List installed TuBot package versions (any version, beta or released)."""
    # 1. Fast path: Tooling API query (resilient SOQL, no packaging plugin dependency)
    soql = (
        "SELECT Id, SubscriberPackageId, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, "
        "SubscriberPackageVersion.Id, SubscriberPackageVersion.Name, "
        "SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, "
        "SubscriberPackageVersion.PatchVersion, SubscriberPackageVersion.BuildNumber "
        "FROM InstalledSubscriberPackage"
    )
    t_res = run_sf(["data", "query", "--use-tooling-api", "--query", soql, "--target-org", org["target_flag"]])
    if t_res["returncode"] == 0:
        found = []
        for r in t_res["data"].get("result", {}).get("records", []) or []:
            sp = r.get("SubscriberPackage") or {}
            spv = r.get("SubscriberPackageVersion") or {}
            name = sp.get("Name") or ""
            if "tubot" in name.lower():
                v_num = f"{spv.get('MajorVersion', 0)}.{spv.get('MinorVersion', 0)}.{spv.get('PatchVersion', 0)}.{spv.get('BuildNumber', 0)}"
                found.append({
                    "Id": r.get("Id"),
                    "SubscriberPackageId": r.get("SubscriberPackageId"),
                    "SubscriberPackageName": name,
                    "SubscriberPackageNamespace": sp.get("NamespacePrefix") or "",
                    "SubscriberPackageVersionId": spv.get("Id") or "",
                    "SubscriberPackageVersionName": spv.get("Name") or "",
                    "SubscriberPackageVersionNumber": v_num,
                    "VersionSettings": "packageId",
                })
        return found

    # 2. Fallback: sf package installed list with retries for transient network fetch errors
    last_res = None
    for attempt in range(2):
        res = run_sf(["package", "installed", "list", "--target-org", org["target_flag"]])
        if res["returncode"] == 0:
            found = []
            for row in res["data"].get("result", []) or []:
                name = row.get("SubscriberPackageName") or ""
                if "tubot" in name.lower():
                    found.append(row)
            return found
        last_res = res
        time.sleep(2)

    log_error(f"Failed to list installed packages: {sf_error(last_res or t_res)}")
    sys.exit(1)


def list_active_tubot_flows(org: Dict[str, str]) -> Optional[List[Dict[str, Any]]]:
    """List active managed Flow definitions owned by TuBot's namespace."""
    res = run_sf([
        "data", "query", "--use-tooling-api", "--query",
        "SELECT Id, DeveloperName, NamespacePrefix, ActiveVersionId "
        "FROM FlowDefinition WHERE NamespacePrefix = 'tubot' AND ActiveVersionId != null",
        "--target-org", org["target_flag"],
    ])
    if res["returncode"] != 0:
        return None
    # FlowDefinitionView is a standard-API view whose Id values use a
    # FlowDefinitionView-specific prefix (3dd), even though its URL contains
    # the underlying FlowDefinition ID (300). Deactivation must PATCH the
    # Tooling API FlowDefinition record, so query FlowDefinition directly and
    # normalize its DeveloperName for the callers that display ApiName.
    records = res["data"].get("result", {}).get("records", [])
    for record in records:
        record["ApiName"] = record.get("DeveloperName")
    return records


def list_unpackaged_tubot_permsets(org: Dict[str, str]) -> List[Dict[str, Any]]:
    """List unpackaged (subscriber) TuBot permission sets by known names."""
    names = ",".join(f"'{n}'" for n in UNPACKAGED_TUBOT_PERMSETS)
    res = run_sf([
        "data", "query", "--query",
        f"SELECT Id, Name FROM PermissionSet WHERE Name IN ({names}) AND NamespacePrefix = null",
        "--target-org", org["target_flag"],
    ])
    if res["returncode"] != 0:
        log_error(f"Failed to query unpackaged permission sets: {sf_error(res)}")
        sys.exit(1)
    return res["data"].get("result", {}).get("records", [])


def list_jwt_preauth_assignments(org: Dict[str, str]) -> List[Dict[str, Any]]:
    """List ALL Tubot_JWT_PreAuth assignments (any user)."""
    res = run_sf([
        "data", "query", "--query",
        "SELECT Id FROM PermissionSet WHERE Name = 'Tubot_JWT_PreAuth' AND NamespacePrefix = null LIMIT 1",
        "--target-org", org["target_flag"],
    ])
    sets = res["data"].get("result", {}).get("records", []) if res["returncode"] == 0 else []
    if not sets:
        return []
    assign_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id, AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = '{sets[0]['Id']}'",
        "--target-org", org["target_flag"],
    ])
    return assign_res["data"].get("result", {}).get("records", []) if assign_res["returncode"] == 0 else []


def find_subscriber_policies_name(org: Dict[str, str]) -> Optional[str]:
    """Discover the subscriber ECA policies record for the packaged app.

    Returns the metadata record name, or None when no subscriber policies
    exist (already gone, e.g. removed by a package uninstall).
    """
    # Fast path: query ExtlClntAppOauthPlcyCnfg via Tooling API (~1-2s)
    soql = (
        "SELECT Id, DeveloperName, ExternalClientApplication.DeveloperName "
        "FROM ExtlClntAppOauthPlcyCnfg"
    )
    res = run_sf(["data", "query", "--use-tooling-api", "--query", soql, "--target-org", org["target_flag"]])
    if res["returncode"] == 0:
        for r in res["data"].get("result", {}).get("records", []) or []:
            eca = (r.get("ExternalClientApplication") or {}).get("DeveloperName") or ""
            if eca.endswith("Tubot_Channel_API"):
                return r.get("DeveloperName")
        return None

    # Fallback: metadata retrieve via temporary project
    with tempfile.TemporaryDirectory() as temp_dir:
        with open(os.path.join(temp_dir, "sfdx-project.json"), "w") as f:
            json.dump({
                "packageDirectories": [{"path": "force-app", "default": True}],
                "name": "tubot-teardown-policies", "namespace": "",
                "sfdcLoginUrl": "https://login.salesforce.com", "sourceApiVersion": "67.0",
            }, f)
        os.makedirs(os.path.join(temp_dir, "force-app"), exist_ok=True)
        res = run_sf([
            "project", "retrieve", "start", "--metadata", "ExtlClntAppOauthConfigurablePolicies",
            "--target-org", org["target_flag"],
        ], cwd=temp_dir)
        if res["returncode"] != 0:
            return None
        policies_dir = os.path.join(temp_dir, "force-app", "main", "default", "extlClntAppOauthPolicies")
        if not os.path.isdir(policies_dir):
            return None
        for name in os.listdir(policies_dir):
            if not name.endswith(".ecaOauthPlcy-meta.xml"):
                continue
            with open(os.path.join(policies_dir, name)) as f:
                body = f.read()
            if re.search(r"<externalClientApplication>(\w+__)?Tubot_Channel_API</externalClientApplication>", body):
                return name[: -len(".ecaOauthPlcy-meta.xml")]
    return None


def _run_in_temp_project(sf_args: List[str], timeout: int = 600) -> Dict[str, Any]:
    """Run an sf project command from a minimal temp DX project directory.

    Commands like `project delete source` refuse to run outside a project
    (RequiresProjectError), so metadata deletes always run here.
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        with open(os.path.join(temp_dir, "sfdx-project.json"), "w") as f:
            json.dump({
                "packageDirectories": [{"path": "force-app", "default": True}],
                "name": "tubot-teardown",
                "namespace": "",
                "sfdcLoginUrl": "https://login.salesforce.com",
                "sourceApiVersion": "67.0",
            }, f, indent=2)
        os.makedirs(os.path.join(temp_dir, "force-app", "main", "default"), exist_ok=True)
        return run_sf(sf_args, cwd=temp_dir, timeout=timeout)
def _panel_delete(org: Dict[str, str], path: str) -> Tuple[bool, str]:
    """DELETE a Panel salesforce route via Named Credential callout.

    200/204/404 all mean clean (404 = already gone).
    """
    apex_code = f"""
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:tubot__Panel_Named_Credential{path}');
req.setMethod('DELETE');
Http http = new Http();
HttpResponse res = http.send(req);
System.debug('DEL_STATUS=' + res.getStatusCode());
System.debug('DEL_BODY=' + res.getBody());
"""
    success, output = run_apex(apex_code, org["target_flag"])
    if not success:
        return False, "apex callout failed"
    statuses = extract_debug_values(output, "DEL_STATUS=")
    bodies = extract_debug_values(output, "DEL_BODY=")
    status = statuses[0] if statuses else "unknown"
    if status in ("200", "204", "404"):
        return True, status
    return False, f"HTTP {status}: {(bodies[0] if bodies else output)[-300:]}"


def _panel_list_execution_users(org: Dict[str, str], channel_id: str) -> List[str]:
    """List Panel-side execution user ids for a channel (best effort)."""
    apex_code = f"""
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:tubot__Panel_Named_Credential/api/v1/salesforce/channels/{channel_id}/execution-users?orgId={org['org_id']}');
req.setMethod('GET');
Http http = new Http();
HttpResponse res = http.send(req);
System.debug('EXEC_STATUS=' + res.getStatusCode());
System.debug('EXEC_BODY=' + res.getBody());
"""
    success, output = run_apex(apex_code, org["target_flag"])
    if not success:
        return []
    statuses = extract_debug_values(output, "EXEC_STATUS=")
    bodies = extract_debug_values(output, "EXEC_BODY=")
    if not statuses or statuses[0] != "200" or not bodies:
        return []
    try:
        users = json.loads(bodies[0]).get("executionUsers", [])
    except (json.JSONDecodeError, AttributeError):
        return []
    ids = []
    for u in users:
        if not isinstance(u, dict):
            continue
        uid = u.get("integrationUserId") or u.get("integration_user_id") or u.get("userId") or u.get("id")
        if uid:
            ids.append(uid)
    return ids


def panel_revoke_channel(org: Dict[str, str], channel_id: str) -> Tuple[bool, List[str]]:
    """Revoke one channel's Panel-side credentials (execution users, then channel)."""
    problems: List[str] = []
    for uid in _panel_list_execution_users(org, channel_id):
        ok, detail = _panel_delete(org, f"/api/v1/salesforce/channels/{channel_id}/execution-users/{uid}?orgId={org['org_id']}")
        if ok:
            log_info(f"Panel execution user revoked: {uid} ({detail})")
        else:
            problems.append(f"execution user {uid}: {detail}")
    ok, detail = _panel_delete(org, f"/api/v1/salesforce/channels/{channel_id}?orgId={org['org_id']}")
    if ok:
        log_success(f"Panel channel credentials revoked: {channel_id} ({detail})")
    else:
        problems.append(f"channel {channel_id}: {detail}")
    return (len(problems) == 0), problems


def delete_api_channel_records(org: Dict[str, str], records: List[Dict[str, Any]]) -> List[str]:
    """Delete tubot__Tubot_API_Channel__c records. Returns failed Ids."""
    failed: List[str] = []
    for rec in records:
        res = run_sf([
            "data", "delete", "record", "--sobject", "tubot__Tubot_API_Channel__c",
            "--record-id", rec["Id"], "--target-org", org["target_flag"],
        ])
        if res["returncode"] == 0:
            log_success(f"Deleted channel config record {rec['Id']} (channel {rec.get('tubot__Channel_Id__c')})")
        else:
            log_warn(f"Could not delete record {rec['Id']}: {sf_error(res)}")
            failed.append(rec["Id"])
    return failed


def delete_perm_assignments(org: Dict[str, str], assignments: List[Dict[str, Any]]) -> List[str]:
    """Delete permission set assignments. Returns failed Ids."""
    failed: List[str] = []
    for a in assignments:
        res = run_sf([
            "data", "delete", "record", "--sobject", "PermissionSetAssignment",
            "--record-id", a["Id"], "--target-org", org["target_flag"],
        ])
        if res["returncode"] == 0:
            log_success(f"Removed permission from user {a.get('AssigneeId')}")
        else:
            log_warn(f"Could not remove assignment {a['Id']}: {sf_error(res)}")
            failed.append(a["Id"])
    return failed


def delete_eca(org: Dict[str, str], app_name: str) -> bool:
    """Delete an External Client App and verify it left the OAuth registry."""
    for attempt in (1, 2):
        res = _run_in_temp_project([
            "project", "delete", "source",
            "--metadata", f"ExternalClientApplication:{app_name}",
            "--target-org", org["target_flag"], "--no-prompt",
        ])
        if res["returncode"] != 0:
            log_warn(f"ECA delete attempt {attempt} note: {sf_error(res)}")
        time.sleep(5)
        remaining = list_tubot_ecas(org)
        names = [(a.get("developerName") or "") for a in remaining] if remaining is not None else None
        if names is not None and app_name not in names:
            log_success(f"External Client App '{app_name}' deleted and verified gone.")
            return True
        if attempt == 1:
            log_info(f"ECA '{app_name}' still registered; retrying delete...")
    log_error(
        f"ECA '{app_name}' is still present. Delete it manually in Setup > "
        "External Client App Manager, then re-run teardown to verify."
    )
    return False


def delete_panel_credentials(org: Dict[str, str], rows: List[Dict[str, Any]]) -> List[str]:
    """Delete UserExternalCredential rows holding the Panel login. Returns failed Ids."""
    failed: List[str] = []
    for row in rows:
        res = run_sf([
            "data", "delete", "record", "--sobject", "UserExternalCredential",
            "--record-id", row["Id"], "--target-org", org["target_flag"],
        ])
        if res["returncode"] == 0:
            log_success(f"Removed Panel login credential row {row['Id']}")
        else:
            log_warn(f"Could not remove credential row {row['Id']}: {sf_error(res)}")
            failed.append(row["Id"])
    return failed


def clear_mcp_tokens(org: Dict[str, str], rows: List[Dict[str, Any]]) -> List[str]:
    """Clear legacy token/identity fields on MCP config rows. Returns failed Ids."""
    failed: List[str] = []
    values = " ".join(f"{f}=''" for f in MCP_TOKEN_FIELDS)
    for row in rows:
        res = run_sf([
            "data", "update", "record", "--sobject", "tubot__MCP_Config__c",
            "--record-id", row["Id"], "--values", values,
            "--target-org", org["target_flag"],
        ])
        if res["returncode"] == 0:
            log_success(f"Cleared legacy tokens on MCP config row {row['Id']}")
        else:
            log_warn(f"Could not clear MCP row {row['Id']}: {sf_error(res)}")
            failed.append(row["Id"])
    return failed


# Deletion order: referencing objects before referenced ones.
_DEFINITION_DELETE_RANK = {"PermissionSet": 0, "NamedCredential": 1, "ExternalCredential": 2, "RemoteSiteSetting": 3}


def delete_credential_definitions(
    org: Dict[str, str],
    targets: List[Tuple[str, str]],
    repair_assignments: List[Dict[str, Any]],
) -> List[str]:
    """Delete unpackaged credential definitions. Returns failed labels.

    Refuses any namespaced (package-owned) target outright.
    """
    failed: List[str] = []
    for a in repair_assignments:
        res = run_sf([
            "data", "delete", "record", "--sobject", "PermissionSetAssignment",
            "--record-id", a["Id"], "--target-org", org["target_flag"],
        ])
        if res["returncode"] == 0:
            log_success(f"Removed repair permission from user {a.get('AssigneeId')}")
        else:
            log_warn(f"Could not remove repair assignment {a['Id']}: {sf_error(res)}")
            failed.append(f"repair assignment {a['Id']}")
    for meta, name in sorted(targets, key=lambda t: _DEFINITION_DELETE_RANK.get(t[0], 9)):
        label = f"{meta}:{name}"
        if "__" in name:
            log_error(f"Refusing to delete possibly-packaged definition '{label}'.")
            failed.append(label)
            continue
        res = _run_in_temp_project([
            "project", "delete", "source",
            "--metadata", label,
            "--target-org", org["target_flag"], "--no-prompt",
        ])
        if res["returncode"] == 0:
            log_success(f"Deleted {label}.")
        else:
            log_warn(f"Could not delete {label}: {sf_error(res)[-300:]}")
            failed.append(label)
    return failed


def uninstall_package(org: Dict[str, str], version_id: str) -> bool:
    """Uninstall one TuBot package version and verify it left the org.

    Idempotent: already-gone counts as success. Uninstall is asynchronous
    server-side, so completion is polled (up to ~10 minutes) rather than
    trusted from a single response. Packaged assignments are stripped first
    because Salesforce blocks uninstall while they exist.
    """
    assign_res = run_sf([
        "data", "query", "--query",
        "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.NamespacePrefix = 'tubot'",
        "--target-org", org["target_flag"],
    ])
    for assignment in assign_res["data"].get("result", {}).get("records", []):
        run_sf([
            "data", "delete", "record", "--sobject", "PermissionSetAssignment",
            "--record-id", assignment["Id"], "--target-org", org["target_flag"],
        ])
    for req_attempt in range(3):
        res = run_sf([
            "package", "uninstall", "--package", version_id,
            "--target-org", org["target_flag"], "--wait", "20",
        ], timeout=1500)
        blob = ((res.get("error_msg") or "") + "\n" + (res.get("stderr") or "") + "\n" + (res.get("stdout") or "")).lower()
        if "not installed in this subscriber org" in blob:
            log_success(f"Package version {version_id} is already gone (idempotent).")
            return True
        if res["returncode"] != 0:
            log_warn(f"Package uninstall note: {sf_error(res)[-300:]}")
            # A rejected uninstall (for example, because another TuBot
            # package still references it) is not an asynchronous request.
            # Check current state once and let the caller remove other
            # packages before retrying this version.
            remaining = [p for p in list_installed_tubot_packages(org) if p.get("SubscriberPackageVersionId") == version_id]
            if not remaining:
                log_success(f"Package version {version_id} uninstalled and verified gone.")
                return True
            return False
        for poll in range(4):
            time.sleep(30)
            remaining = [p for p in list_installed_tubot_packages(org) if p.get("SubscriberPackageVersionId") == version_id]
            if not remaining:
                log_success(f"Package version {version_id} uninstalled and verified gone.")
                return True
        log_info(f"Uninstall request {req_attempt + 1} did not complete; retrying...")
    log_error(f"Package version {version_id} is still installed after retries.")
    return False


def deactivate_tubot_flows(org: Dict[str, str]) -> List[str]:
    """Deactivate active packaged TuBot flows before uninstalling their package.

    Salesforce blocks package uninstall while a packaged Flow is active. The
    FlowDefinition Tooling API represents deactivation as activeVersionNumber 0.
    Only definitions whose NamespacePrefix is exactly ``tubot`` are changed.
    Returns failed flow API names; callers must skip package uninstall if any
    flow could not be deactivated and verified.
    """
    flows = list_active_tubot_flows(org)
    if flows is None:
        log_error("Could not enumerate active TuBot package flows before uninstall.")
        return ["could not enumerate active TuBot flows"]
    if not flows:
        log_success("No active TuBot package flows need deactivation.")
        return []

    failed: List[str] = []
    for flow in flows:
        flow_id = flow.get("Id")
        flow_name = flow.get("ApiName") or flow_id or "unknown flow"
        if not flow_id:
            log_warn(f"Could not resolve a FlowDefinition ID for {flow_name}.")
            failed.append(str(flow_name))
            continue
        res = run_sf([
            "api", "request", "rest",
            f"/services/data/v67.0/tooling/sobjects/FlowDefinition/{flow_id}",
            "--method", "PATCH",
            "--body", json.dumps({"Metadata": {"activeVersionNumber": 0}}),
            "--target-org", org["target_flag"],
        ])
        if res["returncode"] == 0:
            log_success(f"Deactivated TuBot flow {flow_name}.")
        else:
            log_warn(f"Could not deactivate TuBot flow {flow_name}: {sf_error(res)}")
            failed.append(str(flow_name))

    remaining = list_active_tubot_flows(org)
    if remaining is None:
        log_error("Could not verify TuBot flow deactivation; package uninstall is unsafe.")
        failed.append("could not verify TuBot flow deactivation")
        return failed
    remaining_names = [flow.get("ApiName") or flow.get("Id") or "unknown flow" for flow in remaining]
    if remaining_names:
        log_error("TuBot flows are still active: " + ", ".join(remaining_names))
        failed.extend(str(name) for name in remaining_names if str(name) not in failed)
    elif not failed:
        log_success("Verified: all active TuBot package flows are deactivated.")
    return failed


def delete_unpackaged_permsets(org: Dict[str, str], permsets: List[Dict[str, Any]]) -> List[str]:
    """Delete unpackaged TuBot permission sets. Returns failed names.

    Refuses any namespaced (package-owned) set outright. All assignments
    to each set are removed before the set itself is deleted.
    """
    failed: List[str] = []
    for perm in permsets:
        name = perm.get("Name") or ""
        if "__" in name:
            log_error(f"Refusing to delete possibly-packaged permission set '{name}'.")
            failed.append(name)
            continue
        assign_res = run_sf([
            "data", "query", "--query",
            f"SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = '{perm['Id']}'",
            "--target-org", org["target_flag"],
        ])
        for assignment in assign_res["data"].get("result", {}).get("records", []):
            del_res = run_sf([
                "data", "delete", "record", "--sobject", "PermissionSetAssignment",
                "--record-id", assignment["Id"], "--target-org", org["target_flag"],
            ])
            if del_res["returncode"] != 0:
                failed.append(f"assignment {assignment['Id']} ({name})")
        res = _run_in_temp_project([
            "project", "delete", "source",
            "--metadata", f"PermissionSet:{name}",
            "--target-org", org["target_flag"], "--no-prompt",
        ])
        if res["returncode"] == 0:
            log_success(f"Deleted unpackaged permission set '{name}'.")
        else:
            log_warn(f"Could not delete permission set '{name}': {sf_error(res)[-300:]}")
            failed.append(name)
    return failed


def delete_subscriber_policies(org: Dict[str, str], policies_name: str) -> bool:
    """Delete the subscriber ECA policies record for the packaged app."""
    res = _run_in_temp_project([
        "project", "delete", "source",
        "--metadata", f"ExtlClntAppOauthConfigurablePolicies:{policies_name}",
        "--target-org", org["target_flag"], "--no-prompt",
    ])
    if res["returncode"] != 0:
        log_warn(f"Policies delete note: {sf_error(res)[-300:]}")
    time.sleep(3)
    if find_subscriber_policies_name(org) is None:
        log_success(f"Subscriber ECA policies '{policies_name}' deleted and verified gone.")
        return True
    log_error(f"Subscriber ECA policies '{policies_name}' are still present.")
    return False


# ==============================================================================
# Orchestrator
# ==============================================================================
def confirm_yes_no(text: str, default_no: bool = True) -> bool:
    suffix = "[y/N]" if default_no else "[Y/n]"
    ans = prompt(f"{text} {suffix}: ").strip().lower()
    if not ans:
        return not default_no
    return ans in ("y", "yes")


UNPACKAGED_TUBOT_PERMSETS = [
    "Tubot_JWT_PreAuth",
    "Panel_Settings_Admin_Access",
    "Panel_Messaging_Session_Admin_Access",
    "Tubot_Channel_Connection_Admin_Access",
    "Tubot_Salesforce_API_Read",
]
PACKAGED_ECA_NAMES = ["Tubot_Channel_API", "Tubot_Panel_Connection"]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="TuBot Salesforce De-Setup Wizard: remove the package and all setup artifacts, keeping only MessagingChannels"
    )
    parser.add_argument("-o", "--target-org", help="Salesforce org username or alias (bypasses interactive org selection)")
    parser.add_argument("-c", "--channel", help="Limit teardown to one channel config (record Id or channel Id)")
    parser.add_argument("-n", "--app-name", default="Tubot_SF_Channel_API", help="Legacy local ECA DeveloperName to remove (default: Tubot_SF_Channel_API)")
    parser.add_argument("--skip-panel", action="store_true", help="Skip Panel-side credential revocation (local cleanup only)")
    parser.add_argument("--inventory-only", action="store_true", help="List setup artifacts without deleting anything")
    parser.add_argument("--non-interactive", action="store_true", help="Skip confirmation prompts (requires --force; org selection stays interactive unless --target-org is provided)")
    parser.add_argument("--force", action="store_true", help="Confirm all deletions without prompting (requires --non-interactive)")
    parser.add_argument("--json", action="store_true", help="Output JSON result only")
    parser.add_argument("--version", action="store_true", help="Print teardown version and exit")
    return parser


def run_teardown(args: argparse.Namespace) -> Dict[str, Any]:
    """Inventory setup artifacts, confirm, delete in dependency order, verify."""
    if not args.json:
        print(f"\n{BOLD}{CYAN}=============================================================================={RESET}")
        print(f"{BOLD}{CYAN}TuBot Salesforce De-Setup (Teardown) Wizard v{TEARDOWN_VERSION}{RESET}")
        print(f"{BOLD}{CYAN}=============================================================================={RESET}")

    scripted = bool(args.non_interactive and args.force)
    if args.non_interactive and not args.force:
        log_error("Refusing destructive teardown without --force. Re-run with --non-interactive --force, or interactively.")
        sys.exit(1)

    # 0. Org selection (interactive unless --target-org is provided).
    target_org = getattr(args, "target_org", None) or select_target_org(False)
    org = resolve_org(target_org)

    # Step 2: inventory.
    log_phase("Step 2: Inventory of setup artifacts")
    log_info("Querying channel configs, permissions, and credential records...")
    records = list_api_channel_records(org, args.channel)
    user_ids = [r.get("tubot__Integration_User_Id__c") for r in records if r.get("tubot__Integration_User_Id__c")]
    assignments = list_api_perm_assignments(org, user_ids)
    cred_rows = list_panel_credential_rows(org)
    mcp_rows = list_mcp_token_rows(org)
    cred_defs = list_credential_definitions(org)
    log_info("Querying External Client Apps and pre-authorizations...")
    ecas = list_tubot_ecas(org)
    panel_connected, panel_channels = (False, []) if args.skip_panel else list_panel_channels(org)
    panel_ids = [c.get("channelId") for c in panel_channels if c.get("channelId")]
    record_ids = [r.get("tubot__Channel_Id__c") for r in records if r.get("tubot__Channel_Id__c")]
    if args.channel:
        panel_ids = [c for c in panel_ids if c == args.channel or c in record_ids]
    revoke_targets = sorted(set(record_ids) | set(panel_ids))
    eca_names = sorted((a.get("developerName") or "") for a in ecas) if ecas is not None else None
    target_eca_present = bool(eca_names is not None and args.app_name in eca_names)
    other_ecas = [n for n in (eca_names or []) if n != args.app_name]
    jwt_assignments = list_jwt_preauth_assignments(org)
    unpackaged_permsets = list_unpackaged_tubot_permsets(org)
    log_info("Querying subscriber policies and installed packages...")
    subscriber_policies = find_subscriber_policies_name(org)
    installed_packages = list_installed_tubot_packages(org)
    active_tubot_flows = list_active_tubot_flows(org)
    if active_tubot_flows is None:
        log_error("Could not query active TuBot flows; refusing to begin teardown without a complete inventory.")
        sys.exit(1)

    inventory = {
        "channel_config_records": len(records),
        "api_permission_assignments": len(assignments),
        "panel_credential_rows": len(cred_rows),
        "mcp_token_rows": len(mcp_rows),
        "credential_definitions_to_delete": [f"{m}:{n}" for m, n in cred_defs["delete"]],
        "credential_definitions_kept": cred_defs["kept"],
        "repair_permission_assignments": len(cred_defs["repair_assignments"]),
        "panel_connected": panel_connected,
        "panel_channels_for_org": len(panel_ids),
        "target_eca_present": target_eca_present,
        "other_tubot_ecas": other_ecas,
        "eca_registry_known": eca_names is not None,
        "jwt_preauth_assignments": len(jwt_assignments),
        "unpackaged_permsets": [p.get("Name") for p in unpackaged_permsets],
        "subscriber_policies": subscriber_policies,
        "installed_packages": [
            f"{p.get('SubscriberPackageName')} {p.get('SubscriberPackageVersionNumber')}"
            for p in installed_packages
        ],
        "active_package_flows_to_deactivate": [
            flow.get("ApiName") or flow.get("Id") for flow in active_tubot_flows
        ],
    }
    if not args.json:
        print(f"  Channel config records (tubot__Tubot_API_Channel__c): {len(records)}")
        for r in records:
            print(f"    - {r['Id']} channel={r.get('tubot__Channel_Id__c')} user={r.get('tubot__Integration_User_Id__c')} team={r.get('tubot__Team_Id__c')}")
        print(f"  API permission assignments to remove: {len(assignments)}")
        print(f"  Panel login credential rows: {len(cred_rows)} (Panel connected: {panel_connected})")
        print(f"  MCP rows with legacy tokens: {len(mcp_rows)}")
        print(f"  Credential definitions to delete: {len(cred_defs['delete'])} (+{len(cred_defs['repair_assignments'])} repair assignments)")
        for meta, name in cred_defs["delete"]:
            print(f"    - {meta}:{name}")
        if cred_defs["kept"]:
            print(f"  Packaged definitions kept: {', '.join(cred_defs['kept'])}")
        print(f"  Panel-side channels to revoke: {len(revoke_targets)}")
        for c in revoke_targets:
            print(f"    - {c}")
        print(f"  ECA '{args.app_name}': {'present' if target_eca_present else 'absent' if eca_names is not None else 'unknown'}")
        if other_ecas:
            print(f"  Other Tubot ECAs found: {', '.join(other_ecas)}")
        print(f"  JWT pre-auth assignments: {len(jwt_assignments)}")
        print(f"  Unpackaged TuBot permission sets: {', '.join(p.get('Name') for p in unpackaged_permsets) or 'none'}")
        print(f"  Subscriber ECA policies: {subscriber_policies or 'none'}")
        print(f"  Installed TuBot packages: {', '.join(inventory['installed_packages']) or 'none'}")
        print(f"  Active TuBot package flows to deactivate: {', '.join(inventory['active_package_flows_to_deactivate']) or 'none'}")
        print("  MessagingChannels: always kept")

    if args.inventory_only:
        result = {"success": True, "teardown_version": TEARDOWN_VERSION, "org": org, "inventory": inventory, "deleted": {}, "failed": []}
        if args.json:
            print(json.dumps(result, indent=2))
        return result

    nothing = (
        not records and not assignments and not cred_rows and not revoke_targets
        and not target_eca_present and not other_ecas
        and not mcp_rows and not cred_defs["delete"]
        and not jwt_assignments and not unpackaged_permsets
        and subscriber_policies is None and not installed_packages and not active_tubot_flows
    )
    if nothing and eca_names is not None:
        log_success("Org is already bare (only MessagingChannels remain). Nothing to delete.")
        result = {"success": True, "teardown_version": TEARDOWN_VERSION, "org": org, "inventory": inventory, "deleted": {}, "failed": []}
        if args.json:
            print(json.dumps(result, indent=2))
        return result

    # Destructive gate: typed YES (skipped only when scripted).
    if not scripted:
        typed = prompt(f"\n{BOLD}Type YES in capitals to delete the above and de-setup {org['alias']}:{RESET} ").strip()
        if typed != "YES":
            log_info("Aborted by user; nothing deleted.")
            sys.exit(1)

    deleted: Dict[str, Any] = {"panel_channels_revoked": [], "channel_config_records": [], "api_permission_assignments": [],
                               "ecas": [], "panel_credential_rows": [], "mcp_token_rows": [],
                               "credential_definitions": [], "jwt_preauth_assignments": [],
                               "unpackaged_permsets": [], "subscriber_policies": None, "packages": []}
    failed: List[str] = []

    # Step 3: Panel-side revocation first (needs the login still present).
    if revoke_targets and not args.skip_panel:
        if not panel_connected:
            log_warn("Org is not logged into Panel; Panel-side credentials (if any) cannot be revoked blind. Continuing locally.")
            failed.append("panel-side revocation skipped: org not logged into Panel")
        else:
            log_phase("Step 3: Revoking Panel-side credentials")
            for cid in revoke_targets:
                ok, problems = panel_revoke_channel(org, cid)
                if ok:
                    deleted["panel_channels_revoked"].append(cid)
                else:
                    failed.extend(problems)

    # Step 4: channel config records.
    if records:
        log_phase("Step 4: Deleting channel config records")
        failed_ids = delete_api_channel_records(org, records)
        deleted["channel_config_records"] = [r["Id"] for r in records if r["Id"] not in failed_ids]
        failed.extend(f"record {i}" for i in failed_ids)

    # Step 5: API permission assignments.
    if assignments:
        log_phase("Step 5: Removing API permission assignments")
        failed_ids = delete_perm_assignments(org, assignments)
        deleted["api_permission_assignments"] = [a["Id"] for a in assignments if a["Id"] not in failed_ids]
        failed.extend(f"assignment {i}" for i in failed_ids)

    # Step 6: legacy local ECAs (target + optionally other Tubot ECAs found).
    # Packaged ECAs are skipped here: managed components cannot be metadata-
    # deleted and are removed by the package uninstall in step 11.
    eca_targets = [args.app_name] if target_eca_present and args.app_name not in PACKAGED_ECA_NAMES else []
    if args.app_name in PACKAGED_ECA_NAMES and target_eca_present:
        log_info(f"ECA '{args.app_name}' is packaged; it goes with the package uninstall.")
    if other_ecas and not args.non_interactive:
        for name in other_ecas:
            if name in PACKAGED_ECA_NAMES:
                log_info(f"ECA '{name}' is packaged; it goes with the package uninstall.")
                continue
            if confirm_yes_no(f"Also delete Tubot ECA '{name}'?", default_no=True):
                eca_targets.append(name)
    elif other_ecas:
        log_info(f"Keeping other Tubot ECAs in scripted mode: {', '.join(other_ecas)}")
    if eca_targets:
        log_phase("Step 6: Deleting External Client Apps")
        for name in eca_targets:
            if delete_eca(org, name):
                deleted["ecas"].append(name)
            else:
                failed.append(f"eca {name}")

    # Step 7: Panel login credentials.
    if cred_rows or mcp_rows:
        log_phase("Step 7: Removing Panel login")
    if cred_rows:
        failed_ids = delete_panel_credentials(org, cred_rows)
        deleted["panel_credential_rows"] = [r["Id"] for r in cred_rows if r["Id"] not in failed_ids]
        failed.extend(f"credential row {i}" for i in failed_ids)
    if mcp_rows:
        failed_mcp = clear_mcp_tokens(org, mcp_rows)
        deleted["mcp_token_rows"] = [r["Id"] for r in mcp_rows if r["Id"] not in failed_mcp]
        failed.extend(f"mcp row {i}" for i in failed_mcp)

    # Step 8: MessagingChannels are always kept (no action).

    # Step 9: unpackaged credential definitions (after all Panel callouts).
    if cred_defs["delete"]:
        log_phase("Step 9: Deleting unpackaged credential definitions")
        def_failed = delete_credential_definitions(org, cred_defs["delete"], cred_defs["repair_assignments"])
        deleted["credential_definitions"] = [
            f"{m}:{n}" for m, n in cred_defs["delete"] if f"{m}:{n}" not in def_failed
        ]
        failed.extend(def_failed)

    # Step 10: JWT pre-auth assignments, unpackaged permission sets, and
    # subscriber ECA policies (before the uninstall so nothing subscriber-
    # owned can block it).
    if jwt_assignments:
        log_phase("Step 10: Removing JWT pre-authorization assignments")
        failed_ids = delete_perm_assignments(org, jwt_assignments)
        deleted["jwt_preauth_assignments"] = [a["Id"] for a in jwt_assignments if a["Id"] not in failed_ids]
        failed.extend(f"jwt assignment {i}" for i in failed_ids)
    if unpackaged_permsets:
        log_phase("Step 10: Deleting unpackaged TuBot permission sets")
        perm_failed = delete_unpackaged_permsets(org, unpackaged_permsets)
        deleted["unpackaged_permsets"] = [
            p.get("Name") for p in unpackaged_permsets if p.get("Name") not in perm_failed
        ]
        failed.extend(perm_failed)
    if subscriber_policies:
        log_phase("Step 10: Deleting subscriber ECA policies")
        if delete_subscriber_policies(org, subscriber_policies):
            deleted["subscriber_policies"] = subscriber_policies
        else:
            failed.append(f"policies {subscriber_policies}")

    # Step 11: deactivate package flows before uninstalling TuBot packages.
    if installed_packages:
        log_phase("Step 11: Deactivating packaged TuBot flows")
        flow_failures = deactivate_tubot_flows(org)
        if flow_failures:
            failed.extend(f"active flow {name}" for name in flow_failures)
            log_error("Skipping package uninstall because one or more TuBot flows remain active.")
        else:
            log_phase("Step 11: Uninstalling the TuBot packages")
            pending_packages = list(installed_packages)
            while pending_packages:
                still_pending: List[Dict[str, Any]] = []
                for pkg in pending_packages:
                    version_id = pkg.get("SubscriberPackageVersionId")
                    if not version_id:
                        failed.append(f"package {pkg.get('SubscriberPackageName') or 'unknown'} has no version ID")
                        continue
                    if uninstall_package(org, version_id):
                        deleted["packages"].append(
                            f"{pkg.get('SubscriberPackageName')} {pkg.get('SubscriberPackageVersionNumber')}"
                        )
                    else:
                        still_pending.append(pkg)
                if len(still_pending) == len(pending_packages):
                    failed.extend(
                        f"package {pkg.get('SubscriberPackageVersionId')}"
                        for pkg in still_pending
                    )
                    break
                pending_packages = still_pending

    # Step 12: blind re-verification of ground truth.
    log_phase("Step 12: Verifying bare state")
    verify_failed: List[str] = []
    if list_api_channel_records(org, args.channel):
        verify_failed.append("channel config records remain")
    else:
        log_success("Verified: no channel config records remain.")
    if list_api_perm_assignments(org, user_ids):
        verify_failed.append("API permission assignments remain")
    else:
        log_success("Verified: no API permission assignments remain for de-setup users.")
    if deleted["ecas"] and eca_names is not None:
        after = list_tubot_ecas(org)
        after_names = [(a.get("developerName") or "") for a in after] if after is not None else []
        missing = [n for n in deleted["ecas"] if n in after_names]
        if missing:
            verify_failed.append(f"ECAs still registered: {', '.join(missing)}")
        else:
            log_success("Verified: deleted ECAs left the OAuth registry.")
    if list_panel_credential_rows(org):
        verify_failed.append("Panel credential rows remain")
    else:
        log_success("Verified: no Panel login credential rows remain.")
    if list_mcp_token_rows(org):
        verify_failed.append("MCP legacy tokens remain")
    else:
        log_success("Verified: no legacy MCP tokens remain.")
    after_defs = list_credential_definitions(org)
    if after_defs["delete"]:
        verify_failed.append(
            "credential definitions remain: " + ", ".join(f"{m}:{n}" for m, n in after_defs["delete"])
        )
    else:
        log_success("Verified: unpackaged credential definitions are gone.")
    if revoke_targets and not args.skip_panel:
        if not panel_connected:
            log_info("Panel state unverifiable: org was not logged into Panel.")
        else:
            _still_connected, still_channels = list_panel_channels(org)
            leftover = [c.get("channelId") for c in still_channels if c.get("channelId") in revoke_targets]
            if leftover:
                verify_failed.append(f"Panel still lists channels: {', '.join(leftover)}")
            else:
                log_success("Verified: Panel no longer lists revoked channels.")
    if list_jwt_preauth_assignments(org):
        verify_failed.append("JWT pre-auth assignments remain")
    else:
        log_success("Verified: no JWT pre-auth assignments remain.")
    remaining_sets = list_unpackaged_tubot_permsets(org)
    if remaining_sets:
        verify_failed.append(
            "unpackaged permission sets remain: " + ", ".join(p.get("Name") or "" for p in remaining_sets)
        )
    else:
        log_success("Verified: no unpackaged TuBot permission sets remain.")
    if find_subscriber_policies_name(org) is not None:
        verify_failed.append("subscriber ECA policies remain")
    else:
        log_success("Verified: no subscriber ECA policies remain.")
    remaining_pkgs = list_installed_tubot_packages(org)
    if remaining_pkgs:
        verify_failed.append(
            "packages still installed: "
            + ", ".join(p.get("SubscriberPackageVersionNumber") or "" for p in remaining_pkgs)
        )
    else:
        log_success("Verified: no TuBot package installed.")
    remaining_active_flows = list_active_tubot_flows(org)
    if remaining_active_flows is None:
        verify_failed.append("could not verify active TuBot flows")
    elif remaining_active_flows:
        verify_failed.append(
            "active TuBot flows remain: "
            + ", ".join(flow.get("ApiName") or flow.get("Id") or "unknown" for flow in remaining_active_flows)
        )
    else:
        log_success("Verified: no active TuBot package flows remain.")
    after_ecas = list_tubot_ecas(org)
    after_names = [(a.get("developerName") or "") for a in after_ecas] if after_ecas is not None else []
    leftover_ecas = [n for n in after_names if "tubot" in n.lower() or "panel_connection" in n.lower()]
    if leftover_ecas:
        verify_failed.append(f"TuBot ECAs still registered: {', '.join(sorted(set(leftover_ecas)))}")
    else:
        log_success("Verified: no TuBot ECAs remain registered.")

    failed.extend(verify_failed)
    ok = not failed
    if ok:
        log_success("De-setup complete: org is bare (only MessagingChannels remain).")
    else:
        log_warn(f"De-setup finished with {len(failed)} unresolved item(s); see summary.")

    result = {"success": ok, "teardown_version": TEARDOWN_VERSION, "org": org,
              "inventory": inventory, "deleted": deleted, "failed": failed}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\n  Deleted: Panel channels={len(deleted['panel_channels_revoked'])} "
              f"records={len(deleted['channel_config_records'])} "
              f"assignments={len(deleted['api_permission_assignments'])} "
              f"ecas={deleted['ecas']} credRows={len(deleted['panel_credential_rows'])} "
              f"mcpRows={len(deleted['mcp_token_rows'])} credDefs={deleted['credential_definitions']} "
              f"jwtAssignments={len(deleted['jwt_preauth_assignments'])} "
              f"permsets={deleted['unpackaged_permsets']} "
              f"policies={deleted['subscriber_policies']} "
              f"packages={deleted['packages']}")
        if failed:
            print("  Unresolved:")
            for f in failed:
                print(f"    - {f}")
        print("  Kept: MessagingChannels (+ queues) only.")
        if cred_defs["kept"]:
            print(f"  Packaged definitions noted (removed with the package): {', '.join(cred_defs['kept'])}")
    if not ok:
        sys.exit(1)
    return result


def main(argv: Optional[List[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(TEARDOWN_VERSION)
        return
    run_teardown(args)


if __name__ == "__main__":
    main()
