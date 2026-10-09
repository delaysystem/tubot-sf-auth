#!/usr/bin/env python3
"""
==============================================================================
TuBot Salesforce Post-Install Wizard (Zero-Mock Interactive CLI)
==============================================================================
Runs the interactive post-install flow against ONE specific Salesforce org
(no scratch-org creation):

  0. Wizard lists authenticated orgs and lets the admin pick the target org.
  1. Detects and validates the target Salesforce org.
  1a. Shows a must-read WHAT/HOW/WHEN/WHY screen, then asks the admin to
      check one consent box per step below. Unchecked steps are skipped and
      the wizard continues with the rest; steps whose inputs were skipped
      are auto-skipped with the reason shown.
  2. Ensures the TuBot managed package is installed on that org.
  3. Queries active users, prompts for an Integration User, and assigns the
     Tubot_Salesforce_API_Read permission set (blind-verified, fail fast).
  4. Selects an existing MessagingChannel or creates a new Web Messaging
     Channel plus Omni-Queue (pure Python, no helper shell script needed).
  5. Verifies Panel authentication status (and guides the admin through Panel
     login in tubot__Panel_Settings if not already connected).
  6. Automatically provisions all external resources:
     - Configures the packaged JWT execution client using the authenticated CLI session.
     - Assigns subscriber pre-authorization to the selected integration user.
     - Registers channel identity with Panel, which verifies the JWT grant.
     - Creates/upserts tubot__Tubot_API_Channel__c in Salesforce.
  7. Blind-verifies state across Salesforce and Panel (Zero Mocks self-test).

Standalone & portable: this file uses only the Python standard library plus
the Salesforce CLI (`sf`) on PATH. It is served verbatim by the TuBot Panel
worker at /setup/tubot-postinstall.py so admins can bootstrap any org with a
single curl one-liner (shown in tubot__Panel_Settings):

  curl -fsSL <panel-base-url>/setup/tubot-postinstall.py -o tubot-postinstall.py \
    && python3 tubot-postinstall.py

Prerequisites on the workstation: Python 3.9+, curl, and Salesforce CLI
authenticated to the org (`sf org login web`; the wizard lists orgs to pick).
==============================================================================
"""

TUBOT_POSTINSTALL_VERSION = "1.1.1"

# Fallback TuBot package version used only when sfdx-project.json cannot be
# located (e.g. curl-downloaded standalone copy). Prefer --package-id.
POSTINSTALL_FALLBACK_PACKAGE_VERSION_ID = "04tg5000000F8lFAAS"

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Terminal colors and formatting
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
MAGENTA = "\033[35m"
CYAN = "\033[36m"
RED = "\033[31m"


def _supports_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    try:
        return sys.stdout.isatty()
    except Exception:
        return False


if not _supports_color():
    RESET = BOLD = DIM = GREEN = YELLOW = BLUE = MAGENTA = CYAN = RED = ""


def log_phase(title: str):
    print(f"\n{CYAN}{BOLD}===> {title}{RESET}")


def log_info(msg: str):
    print(f"{BLUE}[INFO]{RESET} {msg}")


def log_success(msg: str):
    print(f"{GREEN}[SUCCESS]{RESET} {msg}")


def log_warn(msg: str):
    print(f"{YELLOW}[WARN]{RESET} {msg}")


def log_error(msg: str):
    print(f"{RED}[ERROR]{RESET} {msg}")


def log_skip(step: str, reason: str):
    print(f"{YELLOW}[SKIP]{RESET} {step}: {reason}")


def prompt(text: str) -> str:
    """input() that fails fast with a clear error when stdin ends (e.g. piped runs)."""
    try:
        return input(text)
    except EOFError:
        log_error("Input stream ended before the wizard finished. Re-run interactively or use --non-interactive.")
        sys.exit(1)


def run_sf(args: List[str], cwd: Optional[str] = None, timeout: int = 600) -> Dict[str, Any]:
    """Execute an sf CLI command and return parsed JSON result."""
    cmd = ["sf"] + args
    if "--json" not in cmd:
        cmd.append("--json")
    env = dict(os.environ)
    env["SF_SKIP_NEW_VERSION_CHECK"] = "true"
    env["SF_DISABLE_TELEMETRY"] = "true"
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            env=env,
        )
    except FileNotFoundError:
        log_error("Salesforce CLI ('sf') is not installed or not in PATH.")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        log_error(f"Command timed out after {timeout} seconds: {' '.join(cmd)}")
        sys.exit(1)

    raw_stdout = (proc.stdout or "").strip()
    candidate_json = raw_stdout
    first_brace = raw_stdout.find("{")
    first_bracket = raw_stdout.find("[")
    first_json_idx = -1
    if first_brace != -1 and first_bracket != -1:
        first_json_idx = min(first_brace, first_bracket)
    elif first_brace != -1:
        first_json_idx = first_brace
    elif first_bracket != -1:
        first_json_idx = first_bracket

    if first_json_idx > 0:
        candidate_json = raw_stdout[first_json_idx:]

    try:
        data = json.loads(candidate_json) if candidate_json else {}
    except json.JSONDecodeError:
        data = {"status": proc.returncode, "raw_stdout": proc.stdout, "raw_stderr": proc.stderr}

    # Extract meaningful error message if failed
    err_msg = ""
    if proc.returncode != 0:
        if isinstance(data, dict):
            err_msg = data.get("message") or ""
            if not err_msg and "result" in data:
                res = data["result"]
                if isinstance(res, list) and res and isinstance(res[0], dict):
                    err_msg = res[0].get("error") or res[0].get("state") or ""
                elif isinstance(res, dict):
                    # Deploy/delete failures: surface component problems, not raw JSON.
                    try:
                        cfs = (res.get("details") or {}).get("componentFailures", []) or []
                        err_msg = "; ".join(f"{c.get('componentType')}: {c.get('problem')}" for c in cfs)
                    except Exception:
                        err_msg = ""
        if not err_msg:
            # Filter out warning lines (e.g. CLI update warnings or oclif banners)
            filtered_stderr = "\n".join(
                l for l in proc.stderr.splitlines()
                if "Warning:" not in l and not l.strip().startswith("›")
            ).strip()
            err_msg = filtered_stderr or proc.stdout.strip()

    return {"returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr, "data": data, "error_msg": err_msg}


def sf_error(res: Dict[str, Any]) -> str:
    """Extract a clean, meaningful error message from a run_sf result, filtering CLI warnings."""
    if not isinstance(res, dict):
        return str(res)
    if res.get("error_msg"):
        return res["error_msg"]
    data = res.get("data")
    if isinstance(data, dict):
        if data.get("message"):
            return str(data["message"])
        result = data.get("result")
        if isinstance(result, list) and result and isinstance(result[0], dict):
            msg = result[0].get("error") or result[0].get("state")
            if msg:
                return str(msg)
        elif isinstance(result, dict):
            try:
                cfs = (result.get("details") or {}).get("componentFailures", []) or []
                if cfs:
                    return "; ".join(f"{c.get('componentType')}: {c.get('problem')}" for c in cfs)
            except Exception:
                pass
    stderr_lines = [
        l.strip()
        for l in (res.get("stderr") or "").splitlines()
        if l.strip() and "Warning:" not in l and not l.strip().startswith("›")
    ]
    if stderr_lines:
        return "\n".join(stderr_lines)
    stdout = (res.get("stdout") or "").strip()
    if stdout:
        return stdout[-300:]
    return (res.get("stderr") or "Unknown CLI error").strip()



def run_apex(code: str, target_org: str) -> Tuple[bool, str]:
    """Execute Anonymous Apex and return success and log output."""
    cmd = ["sf", "apex", "run"]
    if target_org:
        cmd.extend(["--target-org", target_org])
    try:
        proc = subprocess.run(
            cmd,
            input=code,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
        output = proc.stdout + "\n" + proc.stderr
        success = proc.returncode == 0 and "Compiled successfully" in output and "Error (" not in output
        return success, output
    except Exception as e:
        return False, str(e)


def extract_debug_values(output: str, prefix: str) -> List[str]:
    """Extract DEBUG lines starting with prefix."""
    values = []
    pattern = re.compile(rf"USER_DEBUG\|\[\d+\]\|DEBUG\|{re.escape(prefix)}(.*)")
    for line in output.splitlines():
        match = pattern.search(line)
        if match:
            values.append(match.group(1).strip())
    return values


# ==============================================================================
# Step 0: Target Org Selection (wizard)
# ==============================================================================
def list_authenticated_orgs() -> List[Dict[str, Any]]:
    """List orgs the local sf CLI is authenticated to (non-scratch + active scratch)."""
    res = run_sf(["org", "list"])
    if res["returncode"] != 0:
        log_error(f"Failed to list authenticated orgs: {sf_error(res)}")
        sys.exit(1)
    result = res["data"].get("result", {})
    orgs: List[Dict[str, Any]] = []
    for entry in (result.get("nonScratchOrgs") or []):
        orgs.append({
            "alias": entry.get("alias") or "",
            "username": entry.get("username") or "",
            "org_id": entry.get("orgId") or "",
            "instance_url": entry.get("instanceUrl") or "",
            "is_default": bool(entry.get("isDefaultUsername")),
            "is_scratch": False,
            "status": entry.get("connectedStatus") or "",
        })
    for entry in (result.get("scratchOrgs") or []):
        if entry.get("status") != "Active" or entry.get("isExpired"):
            continue
        orgs.append({
            "alias": entry.get("alias") or "",
            "username": entry.get("username") or "",
            "org_id": entry.get("orgId") or "",
            "instance_url": entry.get("instanceUrl") or "",
            "is_default": bool(entry.get("isDefaultUsername")),
            "is_scratch": True,
            "status": entry.get("status") or "",
        })
    return [o for o in orgs if o["alias"] or o["username"]]


def select_target_org(non_interactive: bool) -> str:
    """Let the user pick the target org from authenticated orgs.

    Always prompts — the script never auto-selects an org, even when only
    one is authenticated. Returns the alias (or username) for sf commands.
    """
    log_phase("Step 0: Selecting Target Org")
    orgs = list_authenticated_orgs()
    if not orgs:
        log_error("No authenticated Salesforce orgs found. Run 'sf org login web' first, then retry.")
        sys.exit(1)

    if non_interactive:
        log_error("Target org must be selected interactively. Re-run without --non-interactive and pick the org.")
        sys.exit(1)

    default_index = 1
    for idx, o in enumerate(orgs, start=1):
        if o["is_default"]:
            default_index = idx
            break

    print(f"\n{BOLD}Authenticated Salesforce Orgs:{RESET}")
    for idx, o in enumerate(orgs, start=1):
        label = o["alias"] or o["username"]
        detail = o["username"] if o["alias"] else o["org_id"]
        tags = ""
        if o["is_default"]:
            tags += f" {GREEN}[Default]{RESET}"
        if o["is_scratch"]:
            tags += f" {CYAN}[Scratch]{RESET}"
        print(f"  [{idx}] {BOLD}{label}{RESET} ({detail} | {o['org_id']}){tags}")

    while True:
        choice_str = prompt(f"\nSelect Target Org [1-{len(orgs)}] (default {default_index}): ").strip()
        if not choice_str:
            choice_str = str(default_index)
        if choice_str.isdigit():
            c_int = int(choice_str)
            if 1 <= c_int <= len(orgs):
                chosen = orgs[c_int - 1]
                break
        print(f"{RED}Invalid choice. Enter a number between 1 and {len(orgs)}.{RESET}")

    log_success(f"Selected Target Org: {BOLD}{chosen['alias'] or chosen['username']}{RESET} ({chosen['org_id']})")
    return chosen["alias"] or chosen["username"]


# ==============================================================================
# Step 1: Org Resolution
# ==============================================================================
def resolve_org(target_org: Optional[str]) -> Dict[str, str]:
    log_phase("Step 1: Connecting to Salesforce Org")
    args = ["org", "display"]
    if target_org:
        args.extend(["--target-org", target_org])
    res = run_sf(args)
    if res["returncode"] != 0:
        log_error(f"Failed to connect to Salesforce org: {sf_error(res)}")
        sys.exit(1)

    result = res["data"].get("result", {})
    org_id = result.get("id")
    instance_url = result.get("instanceUrl")
    username = result.get("username")
    alias = result.get("alias") or username

    if not org_id or not instance_url:
        log_error("Could not determine org ID or instance URL from sf org display.")
        sys.exit(1)

    log_success(f"Connected to Org: {BOLD}{alias}{RESET} ({org_id}) at {instance_url}")
    log_info(f"Active Connected User: {username}")

    sandbox_res = run_sf(["data", "query", "--query", "SELECT IsSandbox FROM Organization LIMIT 1", "--target-org", target_org or alias])
    sandbox_records = sandbox_res["data"].get("result", {}).get("records", []) if sandbox_res["returncode"] == 0 else []
    is_sandbox = bool(sandbox_records and sandbox_records[0].get("IsSandbox"))

    return {
        "org_id": org_id,
        "instance_url": instance_url.rstrip("/"),
        "username": username,
        "alias": alias,
        "target_flag": target_org or alias,
        "is_sandbox": is_sandbox,
    }


# ==============================================================================
# Step 2: Integration User Selection
# ==============================================================================
def select_integration_user(org: Dict[str, str], requested_user: Optional[str], non_interactive: bool) -> Dict[str, str]:
    log_phase("Step 2: Resolving Integration User")
    soql = (
        "SELECT Id, Name, Username, Email, UserType, IsActive, Profile.Name "
        "FROM User WHERE IsActive = true ORDER BY CreatedDate ASC"
    )
    res = run_sf(["data", "query", "--query", soql, "--target-org", org["target_flag"]])
    if res["returncode"] != 0:
        log_error(f"Failed to query active users: {sf_error(res)}")
        sys.exit(1)

    records = res["data"].get("result", {}).get("records", [])
    if not records:
        log_error("No active users found in target Salesforce org.")
        sys.exit(1)

    # Filter standard / eligible users (exclude internal system users like CloudIntegrationUser, AutomatedProcess)
    eligible = [r for r in records if r.get("UserType") == "Standard"]
    if not eligible:
        eligible = records

    # If requested via flag, match directly
    if requested_user:
        matched = None
        for u in records:
            if requested_user in (u.get("Id"), u.get("Username"), u.get("Email"), u.get("Name")):
                matched = u
                break
        if matched:
            log_success(f"Selected Integration User: {BOLD}{matched.get('Name')}{RESET} ({matched.get('Username')})")
            return {
                "id": matched["Id"],
                "username": matched["Username"],
                "name": matched.get("Name", ""),
                "email": matched.get("Email", ""),
            }
        else:
            log_error(f"Integration user '{requested_user}' not found in active org users.")
            sys.exit(1)

    if non_interactive:
        # Default to first integration user or standard user
        chosen = eligible[0]
        log_info(f"Non-interactive mode: auto-selecting {chosen.get('Name')} ({chosen.get('Username')})")
        return {
            "id": chosen["Id"],
            "username": chosen["Username"],
            "name": chosen.get("Name", ""),
            "email": chosen.get("Email", ""),
        }

    # Interactive prompt
    print(f"\n{BOLD}Available Active Users:{RESET}")
    default_index = 1
    for idx, u in enumerate(eligible, start=1):
        uname = u.get("Username")
        name = u.get("Name")
        email = u.get("Email")
        prof = (u.get("Profile") or {}).get("Name", "N/A")
        is_rec = "integration" in (name + " " + prof + " " + uname).lower() and "platform" not in (name + " " + uname).lower()
        rec_tag = f" {GREEN}[Recommended]{RESET}" if is_rec else ""
        if is_rec and default_index == 1:
            default_index = idx
        print(f"  [{idx}] {BOLD}{name}{RESET} ({uname}) | Profile: {prof} | Email: {email}{rec_tag}")

    while True:
        choice_str = prompt(f"\nSelect Integration User [1-{len(eligible)}] (default {default_index}): ").strip()
        if not choice_str:
            choice_str = str(default_index)
        if choice_str.isdigit():
            c_int = int(choice_str)
            if 1 <= c_int <= len(eligible):
                chosen = eligible[c_int - 1]
                break
        print(f"{RED}Invalid choice. Enter a number between 1 and {len(eligible)}.{RESET}")

    log_success(f"Selected Integration User: {BOLD}{chosen.get('Name')}{RESET} ({chosen.get('Username')})")
    return {
        "id": chosen["Id"],
        "username": chosen["Username"],
        "name": chosen.get("Name", ""),
        "email": chosen.get("Email", ""),
    }


# ==============================================================================
# Step 3: Messaging Channel Selection / Creation
# ==============================================================================
DEFAULT_QUEUE_NAME = "Omni_Web_Queue"
DEFAULT_QUEUE_LABEL = "Omni Web Queue"
DEFAULT_ROUTING_CONFIG_NAME = "Web_Chat_Routing_Config"
DEFAULT_ROUTING_CONFIG_LABEL = "Web Chat Routing Config"


def select_or_create_channel(
    org: Dict[str, str],
    user: Optional[Dict[str, str]],
    requested_channel: Optional[str],
    non_interactive: bool,
    channel_defaults: Optional[Dict[str, str]] = None,
) -> Optional[Dict[str, str]]:
    """Select/activate an existing channel, or create one when a user is set.

    `user` is None when the integration-user consent box was unchecked. In
    that case selecting an existing channel still works, but creating a new
    channel (which must enroll the user in the Omni-Queue) is not possible
    and the step returns None instead of exiting.
    """
    log_phase("Step 3: Resolving Messaging Channel")

    soql = "SELECT Id, DeveloperName, MasterLabel, MessageType, IsActive FROM MessagingChannel ORDER BY CreatedDate DESC"
    res = run_sf(["data", "query", "--query", soql, "--target-org", org["target_flag"]])
    existing = res["data"].get("result", {}).get("records", []) if res["returncode"] == 0 else []

    # If requested by flag, match directly
    if requested_channel:
        matched = None
        for ch in existing:
            if requested_channel in (ch.get("Id"), ch.get("DeveloperName"), ch.get("MasterLabel")):
                matched = ch
                break
        if matched:
            ch_id = matched["Id"]
            if not matched.get("IsActive"):
                log_info(f"Activating channel {matched.get('DeveloperName')} ({ch_id})...")
                run_sf(["data", "update", "record", "--sobject", "MessagingChannel", "--record-id", ch_id, "--values", "IsActive=true", "--target-org", org["target_flag"]])
            log_success(f"Selected Messaging Channel: {BOLD}{matched.get('MasterLabel')}{RESET} ({matched.get('DeveloperName')}, Id: {ch_id})")
            return {
                "id": ch_id,
                "developer_name": matched.get("DeveloperName"),
                "label": matched.get("MasterLabel"),
            }
        else:
            log_error(f"Requested channel '{requested_channel}' not found.")
            sys.exit(1)

    # Prompt user
    if non_interactive:
        if existing:
            ch = existing[0]
            log_info(f"Non-interactive mode: auto-selecting existing channel {ch.get('DeveloperName')}")
            return {"id": ch["Id"], "developer_name": ch.get("DeveloperName"), "label": ch.get("MasterLabel")}
        elif user is not None:
            # Auto-create
            return create_channel_and_queue(org, user, "Web_Chat_Channel", "Web Chat Channel",
                                            channel_defaults, non_interactive)
        else:
            log_skip("Messaging channel setup", "no existing channel and the integration-user step was skipped (creation needs a user)")
            return None

    if not existing and user is None:
        log_skip("Messaging channel setup", "no existing channel to select and the integration-user step was skipped (creation needs a user)")
        return None

    print(f"\n{BOLD}Available Messaging Channels:{RESET}")
    for idx, ch in enumerate(existing, start=1):
        status = f"{GREEN}Active{RESET}" if ch.get("IsActive") else f"{YELLOW}Inactive{RESET}"
        print(f"  [{idx}] {BOLD}{ch.get('MasterLabel')}{RESET} (DevName: {ch.get('DeveloperName')} | Type: {ch.get('MessageType')} | {status} | Id: {ch.get('Id')})")

    create_option_idx: Optional[int] = None
    if user is not None:
        create_option_idx = len(existing) + 1
        print(f"  [{create_option_idx}] {BOLD}{CYAN}+ Create a new Web Messaging Channel & Omni-Queue automatically{RESET}")
    else:
        print(f"  {DIM}(Channel creation is unavailable because the integration-user step was skipped.){RESET}")

    max_choice = create_option_idx if create_option_idx is not None else len(existing)
    default_choice = 1 if existing else (create_option_idx or 1)
    while True:
        choice_str = prompt(f"\nSelect Messaging Channel [1-{max_choice}] (default {default_choice}): ").strip()
        if not choice_str:
            choice_str = str(default_choice)
        if choice_str.isdigit():
            c_int = int(choice_str)
            if 1 <= c_int <= len(existing):
                ch = existing[c_int - 1]
                ch_id = ch["Id"]
                if not ch.get("IsActive"):
                    log_info(f"Activating channel {ch.get('DeveloperName')}...")
                    run_sf(["data", "update", "record", "--sobject", "MessagingChannel", "--record-id", ch_id, "--values", "IsActive=true", "--target-org", org["target_flag"]])
                log_success(f"Selected Messaging Channel: {BOLD}{ch.get('MasterLabel')}{RESET} ({ch.get('DeveloperName')}, Id: {ch_id})")
                return {"id": ch_id, "developer_name": ch.get("DeveloperName"), "label": ch.get("MasterLabel")}
            elif create_option_idx is not None and c_int == create_option_idx and user is not None:
                ch_name = prompt("Enter Channel DeveloperName [Web_Chat_Channel]: ").strip() or "Web_Chat_Channel"
                ch_label = prompt("Enter Channel Label [Web Chat Channel]: ").strip() or "Web Chat Channel"
                return create_channel_and_queue(org, user, ch_name, ch_label,
                                                channel_defaults, non_interactive)
        print(f"{RED}Invalid selection. Choose between 1 and {max_choice}.{RESET}")


def is_messaging_enablement_failure(failures_text: Optional[str]) -> bool:
    """True when the deploy rejection is the known disabled-Messaging gate."""
    return "Not available for deploy" in (failures_text or "")


def messaging_enablement_gate(org: Dict[str, str], non_interactive: bool) -> bool:
    """Human gate for orgs with Messaging/Omni-Channel disabled.

    Prints the exact Setup steps (plus license evidence and an authenticated
    Settings link). Returns True when the caller should retry the deploy,
    False to abort. Non-interactive callers always fail fast with resume
    instructions; the step is idempotent so a re-run resumes.
    """
    lic_res = run_sf(["data", "query", "--query",
                      "SELECT MasterLabel, TotalLicenses, Status FROM PermissionSetLicense "
                      "WHERE MasterLabel LIKE '%Messaging%' OR MasterLabel LIKE '%Digital%' LIMIT 10",
                      "--target-org", org["target_flag"]])
    licenses = []
    if lic_res["returncode"] == 0:
        for r in lic_res["data"].get("result", {}).get("records", []):
            licenses.append(f"{r.get('MasterLabel')} x{r.get('TotalLicenses')} ({r.get('Status')})")
    frontdoor_res = run_sf(["org", "open", "-p", "/lightning/setup/MessagingSettings/home",
                            "--target-org", org["target_flag"], "--url-only"])
    setup_url = frontdoor_res.get("data", {}).get("result", {}).get("url") or \
        f"{org['instance_url']}/lightning/setup/MessagingSettings/home"
    log_warn("MessagingChannel auto-creation failed: this org has Messaging/Chat disabled.")
    log_warn("Metadata deploy rejects MessagingChannel + QueueRoutingConfig until a human enables it.")
    if licenses:
        log_info(f"Messaging-related licenses present: {'; '.join(licenses)}")
    else:
        log_warn("No Messaging/Digital Engagement licenses found — the org may need them provisioned first.")
    print(f"\n{YELLOW}{BOLD}Human step (~2 min): enable Messaging, then continue:{RESET}")
    print("  1. Open (single-use, authenticated):")
    print(f"     {CYAN}{setup_url}{RESET}")
    print("  2. Setup Quick Find -> 'Messaging Settings' -> enable Messaging,")
    print("     or Setup -> 'Omni-Channel Settings' -> enable Enhanced Chat.")
    print("  3. Return here and retry — this step resumes automatically.")
    if non_interactive:
        log_error("Failing fast (non-interactive). Re-run this same command after enabling Messaging; it resumes.")
        return False
    open_browser = prompt("\nOpen Messaging Settings in your browser now? [Y/n]: ").strip().lower()
    if open_browser in ("", "y", "yes"):
        try:
            subprocess.run(["sf", "org", "open", "-p", "/lightning/setup/MessagingSettings/home",
                            "--target-org", org["target_flag"]],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            try:
                webbrowser.open(setup_url)
            except Exception:
                log_info(f"Please open the URL manually: {setup_url}")
    while True:
        choice = prompt(f"\n{BOLD}Press Enter to retry channel creation (or 'q' to quit)...{RESET}").strip().lower()
        if choice in ("", "retry", "r", "y", "yes"):
            return True
        if choice in ("q", "quit", "n", "no"):
            return False
        print(f"{RED}Type Enter to retry or 'q' to quit.{RESET}")


def create_channel_and_queue(
    org: Dict[str, str],
    user: Dict[str, str],
    channel_name: str,
    channel_label: str,
    channel_defaults: Optional[Dict[str, str]] = None,
    non_interactive: bool = False,
) -> Dict[str, str]:
    """Create a Web MessagingChannel plus Omni-Queue using only `sf` CLI calls.

    Pure-Python port of the channel/queue creation flow (no bash or jq needed
    so the curl-downloaded standalone copy works on Windows, Linux, and macOS):
      1. Generates QueueRoutingConfig + Queue + MessagingChannel metadata.
      2. Deploys via `sf project deploy start`.
      2b. On the disabled-Messaging gate ("Not available for deploy"), prints
          the Setup steps and retries after the human enables it (fail fast
          with resume instructions when non-interactive).
      3. Activates the channel (IsActive = true).
      4. Enrolls the integration user into the queue (GroupMember), falling
         back to the connected admin user when the member insert is rejected.
      5. Blind-verifies channel activation and queue membership via SOQL.
    """
    defaults = channel_defaults or {}
    queue_name = defaults.get("queue_name") or DEFAULT_QUEUE_NAME
    queue_label = defaults.get("queue_label") or DEFAULT_QUEUE_LABEL
    routing_name = defaults.get("routing_config_name") or DEFAULT_ROUTING_CONFIG_NAME
    routing_label = defaults.get("routing_config_label") or DEFAULT_ROUTING_CONFIG_LABEL

    log_info(f"Automating creation of Web Messaging Channel '{channel_name}' and Omni-Queue...")

    with tempfile.TemporaryDirectory() as temp_dir:
        with open(os.path.join(temp_dir, "sfdx-project.json"), "w") as f:
            json.dump({
                "packageDirectories": [{"path": "force-app", "default": True}],
                "name": "messaging-channel-setup",
                "namespace": "",
                "sfdcLoginUrl": "https://login.salesforce.com",
                "sourceApiVersion": "67.0",
            }, f, indent=2)

        source_root = os.path.join(temp_dir, "force-app", "main", "default")

        routing_dir = os.path.join(source_root, "queueRoutingConfigs")
        os.makedirs(routing_dir, exist_ok=True)
        with open(os.path.join(routing_dir, f"{routing_name}.queueRoutingConfig-meta.xml"), "w") as f:
            f.write(f"""<?xml version="1.0" encoding="UTF-8"?>
<QueueRoutingConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <capacityWeight>1.0</capacityWeight>
    <isAttributeBased>false</isAttributeBased>
    <label>{routing_label}</label>
    <pushTimeout>20</pushTimeout>
    <routingModel>LEAST_ACTIVE</routingModel>
    <routingPriority>1</routingPriority>
</QueueRoutingConfig>
""")

        queue_dir = os.path.join(source_root, "queues")
        os.makedirs(queue_dir, exist_ok=True)
        with open(os.path.join(queue_dir, f"{queue_name}.queue-meta.xml"), "w") as f:
            f.write(f"""<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesIncludeBosses>false</doesIncludeBosses>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <name>{queue_label}</name>
    <queueRoutingConfig>{routing_name}</queueRoutingConfig>
    <queueSobject>
        <sobjectType>MessagingSession</sobjectType>
    </queueSobject>
</Queue>
""")

        channel_dir = os.path.join(source_root, "messagingChannels")
        os.makedirs(channel_dir, exist_ok=True)
        with open(os.path.join(channel_dir, f"{channel_name}.messagingChannel-meta.xml"), "w") as f:
            f.write(f"""<?xml version="1.0" encoding="UTF-8"?>
<MessagingChannel xmlns="http://soap.sforce.com/2006/04/metadata">
    <automatedResponses>
        <autoResponseContentType>TextResponse</autoResponseContentType>
        <language>en_US</language>
        <response>You&apos;ve opted out of receiving messages from us, so we won&apos;t contact you again.</response>
        <type>OptOutConfirmation</type>
    </automatedResponses>
    <automatedResponses>
        <autoResponseContentType>TextResponse</autoResponseContentType>
        <language>en_US</language>
        <response>Text STOP to opt out of further messages.</response>
        <type>HelpResponse</type>
    </automatedResponses>
    <masterLabel>{channel_label}</masterLabel>
    <messagingChannelType>EmbeddedMessaging</messagingChannelType>
    <messagingKeywords>
        <keyword>cancel</keyword>
        <keyword>end</keyword>
        <keyword>quit</keyword>
        <keyword>stop</keyword>
        <keyword>stopall</keyword>
        <keyword>unsubscribe</keyword>
        <keywordType>OptOut</keywordType>
        <language>en_US</language>
    </messagingKeywords>
    <messagingKeywords>
        <keyword>help</keyword>
        <keywordType>Help</keywordType>
        <language>en_US</language>
    </messagingKeywords>
    <sessionHandlerQueue>{queue_name}</sessionHandlerQueue>
    <sessionHandlerType>Queue</sessionHandlerType>
</MessagingChannel>
""")

        deploy_res = run_sf(
            ["project", "deploy", "start", "--target-org", org["target_flag"],
             "--source-dir", os.path.join(temp_dir, "force-app"),
             "--wait", "10", "--ignore-conflicts"],
            cwd=temp_dir,
        )
        if deploy_res["returncode"] != 0:
            failures = ""
            try:
                details = deploy_res["data"].get("result", {}).get("details", {})
                comp_failures = details.get("componentFailures", []) or []
                failures = "\n".join(
                    f"{cf.get('componentType')}: {cf.get('problem')}" for cf in comp_failures
                )
            except Exception:
                failures = ""
            blob = failures or deploy_res.get("error_msg") or deploy_res["stderr"] or deploy_res["stdout"]
            if is_messaging_enablement_failure(blob):
                if messaging_enablement_gate(org, non_interactive):
                    log_info("Retrying MessagingChannel deployment...")
                    return create_channel_and_queue(org, user, channel_name, channel_label,
                                                    channel_defaults, non_interactive)
                sys.exit(1)
            log_error(f"MessagingChannel metadata deployment failed:\n{blob}")
            sys.exit(1)

    # Query the deployed channel and activate it.
    ch_query = (
        "SELECT Id, DeveloperName, MasterLabel, MessageType, IsActive FROM MessagingChannel "
        f"WHERE DeveloperName = '{channel_name}' LIMIT 1"
    )
    ch_res = run_sf(["data", "query", "--query", ch_query, "--target-org", org["target_flag"]])
    ch_records = ch_res["data"].get("result", {}).get("records", [])
    if not ch_records:
        log_error(f"MessagingChannel '{channel_name}' was not found after deployment.")
        sys.exit(1)
    ch_id = ch_records[0]["Id"]
    dev_name = ch_records[0].get("DeveloperName", channel_name)
    label = ch_records[0].get("MasterLabel", channel_label)

    act_res = run_sf([
        "data", "update", "record", "--sobject", "MessagingChannel",
        "--record-id", ch_id, "--values", "IsActive=true",
        "--target-org", org["target_flag"],
    ])
    if act_res["returncode"] != 0:
        run_sf([
            "data", "update", "record", "--sobject", "MessagingChannel",
            "--where", f"DeveloperName='{channel_name}'", "--values", "IsActive=true",
            "--target-org", org["target_flag"],
        ])

    # Enroll the integration user into the Omni-Queue.
    q_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id, Name, DeveloperName FROM Group WHERE Type = 'Queue' AND DeveloperName = '{queue_name}' LIMIT 1",
        "--target-org", org["target_flag"],
    ])
    q_records = q_res["data"].get("result", {}).get("records", [])
    if not q_records:
        log_error(f"Queue '{queue_name}' was not found in org.")
        sys.exit(1)
    queue_id = q_records[0]["Id"]

    member_id = _ensure_queue_member(org, queue_id, user["id"], user.get("name", user["id"]))
    if not member_id:
        # Fall back to the connected admin user.
        admin_res = run_sf([
            "data", "query", "--query",
            f"SELECT Id, Name, Username FROM User WHERE Username = '{org['username']}' LIMIT 1",
            "--target-org", org["target_flag"],
        ])
        admin_records = admin_res["data"].get("result", {}).get("records", [])
        if not admin_records:
            log_error(f"Failed to enroll user '{user['id']}' into Queue '{queue_name}'.")
            sys.exit(1)
        log_warn(f"Could not add user '{user['id']}' to Queue '{queue_name}'. Enrolling connected admin user instead...")
        member_id = _ensure_queue_member(org, queue_id, admin_records[0]["Id"], admin_records[0].get("Name", ""))
        if not member_id:
            log_error(f"Failed to enroll user '{user['id']}' or connected user '{org['username']}' into Queue '{queue_name}'.")
            sys.exit(1)
        log_success(f"Enrolled connected user '{admin_records[0].get('Name')}' into Queue '{queue_name}' (GroupMember: {member_id})")
    else:
        log_success(f"User '{user.get('name')}' enrolled in Queue '{queue_name}' (GroupMember: {member_id})")

    # Blind verification: channel active + membership present.
    verify_ch = run_sf([
        "data", "query", "--query",
        f"SELECT Id, IsActive FROM MessagingChannel WHERE Id = '{ch_id}'",
        "--target-org", org["target_flag"],
    ])
    verify_records = verify_ch["data"].get("result", {}).get("records", [])
    verify_member = run_sf([
        "data", "query", "--query",
        f"SELECT Id FROM GroupMember WHERE Id = '{member_id}'",
        "--target-org", org["target_flag"],
    ])
    member_count = verify_member["data"].get("result", {}).get("totalSize", 0)
    if not verify_records or not verify_records[0].get("IsActive") or (member_count or 0) < 1:
        log_error("Verification assertion failed! Target state does not match expected truth.")
        sys.exit(1)

    log_success(f"Channel & Queue Created: {BOLD}{label}{RESET} ({dev_name}, Id: {ch_id})")
    return {"id": ch_id, "developer_name": dev_name, "label": label}


def _ensure_queue_member(org: Dict[str, str], queue_id: str, user_id: str, display_name: str) -> Optional[str]:
    """Return the GroupMember Id for user in queue, creating it if needed."""
    check_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id FROM GroupMember WHERE GroupId = '{queue_id}' AND UserOrGroupId = '{user_id}' LIMIT 1",
        "--target-org", org["target_flag"],
    ])
    existing = check_res["data"].get("result", {}).get("records", [])
    if existing:
        log_info(f"User '{display_name}' is already a member of the queue (GroupMember: {existing[0]['Id']})")
        return existing[0]["Id"]

    add_res = run_sf([
        "data", "create", "record", "--sobject", "GroupMember",
        "--values", f"GroupId='{queue_id}' UserOrGroupId='{user_id}'",
        "--target-org", org["target_flag"],
    ])
    return add_res["data"].get("result", {}).get("id")


# ==============================================================================
# Step 4: Panel Login Verification
# ==============================================================================
def check_panel_connection(org: Dict[str, str]) -> Tuple[bool, Dict[str, Any]]:
    """Test Panel Named Credential connection via Anonymous Apex callout."""
    apex_code = """
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:tubot__Panel_Named_Credential/api/v1/subscription');
req.setMethod('GET');
Http http = new Http();
try {
    HttpResponse res = http.send(req);
    System.debug('SUBSCRIPTION_STATUS=' + res.getStatusCode());
    System.debug('SUBSCRIPTION_BODY=' + res.getBody());
} catch (Exception ex) {
    System.debug('SUBSCRIPTION_ERROR=' + ex.getMessage());
}
"""
    success, output = run_apex(apex_code, org["target_flag"])
    if not success:
        return False, {"error": "Apex execution failed", "output": output}

    statuses = extract_debug_values(output, "SUBSCRIPTION_STATUS=")
    bodies = extract_debug_values(output, "SUBSCRIPTION_BODY=")

    if statuses and statuses[0] == "200" and bodies:
        try:
            body_json = json.loads(bodies[0])
            return True, body_json
        except json.JSONDecodeError:
            return True, {"raw": bodies[0]}

    return False, {"output": output}


def verify_and_prompt_panel_login(org: Dict[str, str], non_interactive: bool) -> Dict[str, Any]:
    log_phase("Step 4: Verifying Panel Connection")
    log_info("Checking existing Panel Named Credential authorization...")

    is_connected, details = check_panel_connection(org)
    if is_connected:
        team_id = details.get("teamId", "N/A")
        team_name = details.get("teamName", "N/A")
        sub = details.get("subscription", {})
        plan = sub.get("planName", "Active")
        log_success(f"Panel connection verified! Team: {BOLD}{team_name}{RESET} ({team_id}) | Plan: {plan}")
        return {"team_id": team_id, "team_name": team_name, "details": details}

    log_warn("Salesforce org is not connected to Panel.")
    # Retrieve one-time authenticated frontdoor URL via `sf org open --url-only`
    frontdoor_res = run_sf([
        "org", "open",
        "-p", "/lightning/n/tubot__Panel_Settings",
        "--target-org", org["target_flag"],
        "--url-only",
    ])
    frontdoor_url = frontdoor_res.get("data", {}).get("result", {}).get("url") or f"{org['instance_url']}/lightning/n/tubot__Panel_Settings"

    print(f"\n{YELLOW}{BOLD}Panel Authentication Required:{RESET}")
    print(f"  To authorize this Salesforce org with Panel:")
    print(f"  1. Authenticated link (no password required):")
    print(f"     {CYAN}{frontdoor_url}{RESET}")
    print(f"  2. Click 'Connect Panel' / 'Log in with Panel' in Salesforce to complete authorization.")

    if non_interactive:
        log_error("Panel is not authenticated and running in non-interactive mode. Please log in first.")
        sys.exit(1)

    open_browser = prompt(f"\nWould you like to open Panel Settings in your browser with 'sf org open'? [Y/n]: ").strip().lower()
    if open_browser in ("", "y", "yes"):
        log_info("Opening Salesforce Panel Settings in your default browser via sf org open...")
        try:
            subprocess.run([
                "sf", "org", "open",
                "-p", "/lightning/n/tubot__Panel_Settings",
                "--target-org", org["target_flag"],
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            # Fallback to webbrowser with frontdoor_url
            try:
                webbrowser.open(frontdoor_url)
            except Exception:
                log_info(f"Please open the URL manually: {frontdoor_url}")

    while True:
        prompt(f"\n{BOLD}Press Enter once you have completed Panel authorization in your browser...{RESET}")
        log_info("Retesting Panel connection...")
        is_connected, details = check_panel_connection(org)
        if is_connected:
            team_id = details.get("teamId", "N/A")
            team_name = details.get("teamName", "N/A")
            log_success(f"Panel connected successfully! Team: {BOLD}{team_name}{RESET} ({team_id})")
            return {"team_id": team_id, "team_name": team_name, "details": details}
        log_warn("Panel connection test returned non-200. Please ensure login completed in Salesforce.")


# ==============================================================================
# Step 5: Automated External Setup (ECA, Perms, Registration)
# ==============================================================================
API_READ_PERMISSION_SET_NAME = "Tubot_Salesforce_API_Read"
# Packaged JWT execution client (ships in the managed package; no per-org ECA
# deploy, no consumer secret anywhere). Subscriber pre-authorization lives in
# the unpackaged Tubot_JWT_PreAuth set, applied by setup-eca-policies.mjs.
PACKAGED_EXECUTION_APP_NAME = "Tubot_Channel_API"
JWT_PREAUTH_SET_NAME = "Tubot_JWT_PreAuth"


def resolve_api_permission_set_id(org: Dict[str, str]) -> Optional[str]:
    """Return the Id of the packaged API read permission set, if installed.

    Matches the base Name with or without a namespace prefix, mirroring
    TubotSetupWizardController.resolvePermissionSetId in Apex.
    """
    soql = (
        "SELECT Id, Name FROM PermissionSet "
        f"WHERE Name = '{API_READ_PERMISSION_SET_NAME}' "
        f"OR Name LIKE '%__{API_READ_PERMISSION_SET_NAME}' LIMIT 1"
    )
    res = run_sf(["data", "query", "--query", soql, "--target-org", org["target_flag"]])
    records = res["data"].get("result", {}).get("records", [])
    return records[0]["Id"] if records else None


def is_api_permission_set_assigned(org: Dict[str, str], perm_id: str, user_id: str) -> bool:
    """Re-read the assignment from the target org (ground truth, never cached)."""
    assign_query = (
        "SELECT Id FROM PermissionSetAssignment "
        f"WHERE AssigneeId = '{user_id}' AND PermissionSetId = '{perm_id}' LIMIT 1"
    )
    a_res = run_sf(["data", "query", "--query", assign_query, "--target-org", org["target_flag"]])
    return bool(a_res["data"].get("result", {}).get("records", []))


def ensure_permission_set(org: Dict[str, str], user: Dict[str, str]):
    """Assign Tubot_Salesforce_API_Read to the integration user (fail fast).

    Runs atomically with user selection so no later failure or skip can
    leave the user without API access. Exits non-zero with an explicit
    reason instead of warning and continuing unassigned.
    """
    log_info("Verifying API Permission Set assignment for integration user...")
    perm_id = resolve_api_permission_set_id(org)
    if not perm_id:
        log_error(
            f"PermissionSet '{API_READ_PERMISSION_SET_NAME}' not found on org '{org['alias']}'. "
            "Install the TuBot package first (re-run with the 'package' step checked)."
        )
        sys.exit(1)

    if is_api_permission_set_assigned(org, perm_id, user["id"]):
        log_success(f"PermissionSet '{API_READ_PERMISSION_SET_NAME}' already assigned to {user['username']}.")
        return

    log_info(f"Assigning '{API_READ_PERMISSION_SET_NAME}' to user {user['username']}...")
    c_res = run_sf([
        "data", "create", "record",
        "--sobject", "PermissionSetAssignment",
        "--values", f"AssigneeId='{user['id']}' PermissionSetId='{perm_id}'",
        "--target-org", org["target_flag"]
    ])
    if c_res["returncode"] != 0:
        # Tolerate only the idempotent resume case (the assignment landed anyway).
        if is_api_permission_set_assigned(org, perm_id, user["id"]):
            log_success(f"PermissionSet '{API_READ_PERMISSION_SET_NAME}' already assigned to {user['username']}.")
            return
        err = c_res.get("error_msg") or c_res["stderr"] or c_res["stdout"]
        log_error(f"Could not assign PermissionSet '{API_READ_PERMISSION_SET_NAME}' to {user['username']}: {err}")
        sys.exit(1)

    # Blind-verify: re-read the assignment from the target, never trust the create response.
    if not is_api_permission_set_assigned(org, perm_id, user["id"]):
        log_error(
            f"PermissionSet '{API_READ_PERMISSION_SET_NAME}' assignment to {user['username']} "
            "could not be verified in the target org. Fix the underlying error and re-run."
        )
        sys.exit(1)
    log_success(f"PermissionSet '{API_READ_PERMISSION_SET_NAME}' assigned and verified for {user['username']}.")


def ensure_packaged_execution_client(org: Dict[str, Any], user: Dict[str, str]) -> None:
    """Confirm the packaged JWT execution client and pre-authorize the user.

    No ECA is deployed (both OAuth clients ship in the managed package) and
    no secret is extracted: Panel holds the JWT signing key and mints
    short-lived tokens per request. This step runs setup-eca-policies.mjs
    (creates the unpackaged Tubot_JWT_PreAuth set and locks the subscriber
    policies to admin-approved pre-authorization), assigns that set to the
    integration user, and blind-verifies the assignment.
    """
    log_info(f"Confirming packaged execution client '{PACKAGED_EXECUTION_APP_NAME}'...")
    app_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id FROM ExternalClientApplication WHERE DeveloperName = '{PACKAGED_EXECUTION_APP_NAME}' LIMIT 1",
        "--target-org", org["target_flag"],
    ])
    apps = app_res["data"].get("result", {}).get("records", []) if app_res["returncode"] == 0 else []
    if not apps:
        log_error(
            f"Packaged app '{PACKAGED_EXECUTION_APP_NAME}' is not installed on org '{org['alias']}'. "
            "Install or upgrade the TuBot package first (re-run with the 'package' step checked)."
        )
        sys.exit(1)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    policies_script = os.path.join(script_dir, "setup-eca-policies.mjs")
    log_info("Applying subscriber pre-authorization policies (setup-eca-policies.mjs)...")
    proc = subprocess.run(
        ["bun", policies_script, "--target-org", org["target_flag"]],
        cwd=script_dir, capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        log_error(f"Pre-authorization policies setup failed:\n{proc.stderr or proc.stdout}")
        sys.exit(1)
    log_success("Pre-authorization policies applied.")

    assign_jwt_preauth_set(org, user)


def assign_jwt_preauth_set(org: Dict[str, Any], user: Dict[str, str]) -> None:
    """Assign the unpackaged Tubot_JWT_PreAuth set to the user (verified)."""
    ps_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id FROM PermissionSet WHERE Name = '{JWT_PREAUTH_SET_NAME}' AND NamespacePrefix = null LIMIT 1",
        "--target-org", org["target_flag"],
    ])
    sets = ps_res["data"].get("result", {}).get("records", []) if ps_res["returncode"] == 0 else []
    if not sets:
        log_error(
            f"PermissionSet '{JWT_PREAUTH_SET_NAME}' not found on org '{org['alias']}'. "
            "The policies setup did not complete; re-run with the 'eca' step checked."
        )
        sys.exit(1)
    ps_id = sets[0]["Id"]
    if is_permission_set_assigned(org, ps_id, user["id"]):
        log_success(f"PermissionSet '{JWT_PREAUTH_SET_NAME}' already assigned to {user['username']}.")
        return
    log_info(f"Assigning '{JWT_PREAUTH_SET_NAME}' to user {user['username']}...")
    c_res = run_sf([
        "data", "create", "record",
        "--sobject", "PermissionSetAssignment",
        "--values", f"AssigneeId='{user['id']}' PermissionSetId='{ps_id}'",
        "--target-org", org["target_flag"],
    ])
    if c_res["returncode"] != 0 and not is_permission_set_assigned(org, ps_id, user["id"]):
        err = c_res.get("error_msg") or c_res["stderr"] or c_res["stdout"]
        log_error(f"Could not assign PermissionSet '{JWT_PREAUTH_SET_NAME}' to {user['username']}: {err}")
        sys.exit(1)
    if not is_permission_set_assigned(org, ps_id, user["id"]):
        log_error(
            f"PermissionSet '{JWT_PREAUTH_SET_NAME}' assignment to {user['username']} "
            "could not be verified in the target org. Fix the underlying error and re-run."
        )
        sys.exit(1)
    log_success(f"PermissionSet '{JWT_PREAUTH_SET_NAME}' assigned and verified for {user['username']}.")


def is_permission_set_assigned(org: Dict[str, Any], perm_id: str, user_id: str) -> bool:
    """Blind-check a PermissionSetAssignment directly in the target org."""
    q_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = '{perm_id}' AND AssigneeId = '{user_id}' LIMIT 1",
        "--target-org", org["target_flag"],
    ])
    records = q_res["data"].get("result", {}).get("records", []) if q_res["returncode"] == 0 else []
    return len(records) > 0


def register_channel_with_panel(
    org: Dict[str, Any],
    channel: Dict[str, str],
    user: Dict[str, str],
) -> None:
    """Register the channel with Panel via Named Credential Callout.

    JWT shape: the org sends identity only (no client credentials exist on
    this path). Panel mints a token with the packaged execution client,
    verifies the grant resolves to this org/user via userinfo, then stores
    the mapping. HTTP 201 with verified.username means the grant was proven
    live; 422 preauth_required means the user lacks Tubot_JWT_PreAuth.
    """
    log_info(f"Registering channel '{channel['label']}' with Panel API...")
    payload_json = json.dumps({
        "orgId": org["org_id"],
        "channelId": channel["id"],
        "instanceUrl": org["instance_url"],
        "integrationUserId": user["id"],
        "integrationUsername": user["username"],
        "isSandbox": bool(org.get("is_sandbox")),
    })

    # Escape for Apex string
    apex_payload = payload_json.replace("\\", "\\\\").replace("'", "\\'")

    apex_code = f"""
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:tubot__Panel_Named_Credential/api/v1/salesforce/channels');
req.setMethod('POST');
req.setHeader('Content-Type', 'application/json');
req.setBody('{apex_payload}');
Http http = new Http();
HttpResponse res = http.send(req);
System.debug('REG_STATUS=' + res.getStatusCode());
System.debug('REG_BODY=' + res.getBody());
"""
    success, output = run_apex(apex_code, org["target_flag"])
    if not success:
        log_error(f"Anonymous Apex registration callout failed:\n{output}")
        sys.exit(1)

    statuses = extract_debug_values(output, "REG_STATUS=")
    bodies = extract_debug_values(output, "REG_BODY=")

    if not statuses or statuses[0] != "201":
        body = bodies[0] if bodies else output
        hint = ""
        if "preauth_required" in body:
            hint = (
                f"\nThe integration user is not pre-authorized. Assign '{JWT_PREAUTH_SET_NAME}' "
                "to the user (re-run with the 'eca' step checked) and retry."
            )
        log_error(f"Panel rejected channel registration (HTTP {statuses[0] if statuses else 'unknown'}):\n{body}{hint}")
        sys.exit(1)

    verified_user = None
    try:
        verified_user = (json.loads(bodies[0]).get("verified") or {}).get("username")
    except (ValueError, IndexError):
        verified_user = None
    if verified_user and verified_user != user["username"]:
        log_error(
            f"Panel verified a different identity ('{verified_user}') than the selected "
            f"integration user ('{user['username']}'). Refusing to continue."
        )
        sys.exit(1)
    log_success(f"Channel registered with Panel; JWT grant verified for {user['username']}.")


def upsert_salesforce_api_channel_record(
    org: Dict[str, str],
    channel: Dict[str, str],
    user: Dict[str, str],
    team_id: str,
) -> str:
    """Upsert tubot__Tubot_API_Channel__c record in Salesforce."""
    log_info("Synchronizing tubot__Tubot_API_Channel__c record in Salesforce...")
    conn_key = f"{channel['id']}:{user['id']}"

    # Check if record exists
    check_query = f"SELECT Id FROM tubot__Tubot_API_Channel__c WHERE tubot__Channel_Id__c = '{channel['id']}' AND tubot__Integration_User_Id__c = '{user['id']}' LIMIT 1"
    q_res = run_sf(["data", "query", "--query", check_query, "--target-org", org["target_flag"]])
    existing = q_res["data"].get("result", {}).get("records", [])

    if existing:
        rec_id = existing[0]["Id"]
        log_info(f"Existing tubot__Tubot_API_Channel__c record found ({rec_id}). Updating...")
        run_sf([
            "data", "update", "record",
            "--sobject", "tubot__Tubot_API_Channel__c",
            "--record-id", rec_id,
            "--values", f"tubot__Team_Id__c='{team_id}' tubot__Connection_Key__c='{conn_key}' tubot__Assignment_Owned__c=true",
            "--target-org", org["target_flag"]
        ])
    else:
        log_info("Creating new tubot__Tubot_API_Channel__c record...")
        c_res = run_sf([
            "data", "create", "record",
            "--sobject", "tubot__Tubot_API_Channel__c",
            "--values", f"tubot__Channel_Id__c='{channel['id']}' tubot__Integration_User_Id__c='{user['id']}' tubot__Team_Id__c='{team_id}' tubot__Connection_Key__c='{conn_key}' tubot__Assignment_Owned__c=true",
            "--target-org", org["target_flag"]
        ])
        rec_id = c_res["data"].get("result", {}).get("id")
        if not rec_id:
            log_error(f"Failed to create tubot__Tubot_API_Channel__c record: {c_res['stderr'] or c_res['stdout']}")
            sys.exit(1)

    log_success(f"Salesforce channel record saved: {BOLD}{rec_id}{RESET}")
    return rec_id


# ==============================================================================
# Step 6: Blind Verification Protocol (Zero Mocks)
# ==============================================================================
def verify_setup(
    org: Dict[str, Any],
    channel: Dict[str, str],
    user: Dict[str, str],
    record_id: str,
) -> None:
    log_phase("Step 6: Real-World Blind Verification (Zero Mocks)")

    # 1. JWT grant + identity were already proven live: registration returns
    # 201 only after Panel mints with the packaged execution client and
    # matches userinfo to this org/user. Here we re-assert the durable state.
    log_info("1. Verifying JWT pre-authorization assignment in the target org...")
    ps_res = run_sf([
        "data", "query", "--query",
        f"SELECT Id FROM PermissionSet WHERE Name = '{JWT_PREAUTH_SET_NAME}' AND NamespacePrefix = null LIMIT 1",
        "--target-org", org["target_flag"],
    ])
    preauth_sets = ps_res["data"].get("result", {}).get("records", []) if ps_res["returncode"] == 0 else []
    if not preauth_sets or not is_permission_set_assigned(org, preauth_sets[0]["Id"], user["id"]):
        log_error(
            f"PermissionSet '{JWT_PREAUTH_SET_NAME}' is NOT assigned to {user['username']}. "
            "Re-run post-install with the 'eca' step checked."
        )
        sys.exit(1)
    log_success(f"JWT pre-authorization verified for {BOLD}{user['username']}{RESET}")

    # 2. Verify Channel in Panel API
    log_info("2. Verifying registered channel connection in Panel API...")
    apex_list = f"""
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:tubot__Panel_Named_Credential/api/v1/salesforce/channels?orgId={org['org_id']}');
req.setMethod('GET');
Http http = new Http();
HttpResponse res = http.send(req);
System.debug('LIST_STATUS=' + res.getStatusCode());
System.debug('LIST_BODY=' + res.getBody());
"""
    success, output = run_apex(apex_list, org["target_flag"])
    statuses = extract_debug_values(output, "LIST_STATUS=")
    bodies = extract_debug_values(output, "LIST_BODY=")

    if not statuses or statuses[0] != "200":
        log_error("Failed to query Panel channels API.")
        sys.exit(1)

    panel_channels = json.loads(bodies[0]).get("channels", []) if bodies else []
    found = any(c.get("channelId") == channel["id"] for c in panel_channels)
    if not found:
        log_error(f"Channel {channel['id']} was not found in Panel active connections.")
        sys.exit(1)
    log_success(f"Panel active channel verified: {BOLD}{channel['id']}{RESET}")

    # 3. Verify Ground Truth in Salesforce
    log_info("3. Asserting ground truth in Salesforce database...")
    soql = f"SELECT Id, tubot__Channel_Id__c, tubot__Integration_User_Id__c, tubot__Team_Id__c FROM tubot__Tubot_API_Channel__c WHERE Id = '{record_id}'"
    v_res = run_sf(["data", "query", "--query", soql, "--target-org", org["target_flag"]])
    records = v_res["data"].get("result", {}).get("records", [])
    if not records:
        log_error(f"Record {record_id} not found in Salesforce via independent query.")
        sys.exit(1)
    log_success(f"Salesforce record verified: {records[0]['Id']}")

    # 4. Verify API Permission Set assignment (post-install must leave it assigned)
    log_info("4. Verifying Tubot API Read permission set assignment...")
    api_ps_id = resolve_api_permission_set_id(org)
    if not api_ps_id:
        log_error(f"PermissionSet '{API_READ_PERMISSION_SET_NAME}' not found on the org.")
        sys.exit(1)
    if not is_api_permission_set_assigned(org, api_ps_id, user["id"]):
        log_error(
            f"PermissionSet '{API_READ_PERMISSION_SET_NAME}' is NOT assigned to {user['username']}. "
            "Re-run post-install with the 'integration-user' step checked."
        )
        sys.exit(1)
    log_success(f"Permission set assignment verified for {BOLD}{user['username']}{RESET}")

    log_success(f"{BOLD}✔ All blind verification checks passed cleanly!{RESET}")


def get_latest_package_version_id() -> str:
    """Read the latest TuBot package version ID from sfdx-project.json or fallback."""
    script_dir = Path(__file__).resolve().parent
    candidates = [
        script_dir.parent / "sfdx-project.json",
        script_dir.parent / "tubot-sf-auth" / "tubot-sf-package" / "sfdx-project.json",
        script_dir / "sfdx-project.json",
        Path("tubot-sf-auth/tubot-sf-package/sfdx-project.json"),
    ]
    for c in candidates:
        if c.exists():
            try:
                with open(c, "r") as f:
                    data = json.load(f)
                aliases = data.get("packageAliases", {})
                tubot_versions = []
                for k, v in aliases.items():
                    if k.startswith("TuBot@") and v.startswith("04t"):
                        m = re.search(r"TuBot@(\d+)\.(\d+)\.(\d+)-(\d+)", k)
                        if m:
                            ver_tuple = (
                                int(m.group(1)),
                                int(m.group(2)),
                                int(m.group(3)),
                                int(m.group(4)),
                            )
                            tubot_versions.append((ver_tuple, v))
                if tubot_versions:
                    tubot_versions.sort(key=lambda x: x[0], reverse=True)
                    return tubot_versions[0][1]
            except Exception:
                pass
    return POSTINSTALL_FALLBACK_PACKAGE_VERSION_ID


def query_installed_packages(target_org: str) -> List[Dict[str, Any]]:
    """Query installed packages via fast Tooling API with fallback to sf package installed list."""
    soql = (
        "SELECT Id, SubscriberPackageId, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, "
        "SubscriberPackageVersion.Id, SubscriberPackageVersion.Name, "
        "SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, "
        "SubscriberPackageVersion.PatchVersion, SubscriberPackageVersion.BuildNumber "
        "FROM InstalledSubscriberPackage"
    )
    t_res = run_sf(["data", "query", "--use-tooling-api", "--query", soql, "--target-org", target_org])
    if t_res["returncode"] == 0:
        records = t_res["data"].get("result", {}).get("records", []) or []
        pkgs = []
        for r in records:
            sp = r.get("SubscriberPackage") or {}
            spv = r.get("SubscriberPackageVersion") or {}
            v_num = f"{spv.get('MajorVersion', 0)}.{spv.get('MinorVersion', 0)}.{spv.get('PatchVersion', 0)}.{spv.get('BuildNumber', 0)}"
            pkgs.append({
                "Id": r.get("Id"),
                "SubscriberPackageId": r.get("SubscriberPackageId"),
                "SubscriberPackageName": sp.get("Name") or "",
                "SubscriberPackageNamespace": sp.get("NamespacePrefix") or "",
                "SubscriberPackageVersionId": spv.get("Id") or "",
                "SubscriberPackageVersionName": spv.get("Name") or "",
                "SubscriberPackageVersionNumber": v_num,
                "VersionSettings": "packageId",
            })
        return pkgs

    # Fallback to sf package installed list with retry
    for attempt in range(2):
        res = run_sf(["package", "installed", "list", "--target-org", target_org])
        if res["returncode"] == 0:
            return res["data"].get("result", []) or []
        if attempt < 1:
            time.sleep(2)
    return []


def is_tubot_package_installed(target_org: str) -> Tuple[bool, Optional[str], Optional[str]]:
    """Check if TuBot package is already installed on the target org."""
    for pkg in query_installed_packages(target_org):
        name = pkg.get("SubscriberPackageName") or ""
        pkg_id = pkg.get("SubscriberPackageVersionId") or ""
        ver = pkg.get("SubscriberPackageVersionNumber") or ""
        if name.lower() == "tubot" or "tubot" in name.lower():
            return True, f"{name} {ver} ({pkg_id})", pkg_id
    return False, None, None


def ensure_tubot_package_installed(
    target_org: str,
    package_id: Optional[str] = None,
    skip_install: bool = False,
) -> bool:
    """Ensure the TuBot managed package is installed and configured on the org."""
    if skip_install:
        log_info("Skipping TuBot managed package check/installation as requested.")
        return True

    log_phase("Package Validation: TuBot 2GP Managed Package")
    pkg_to_install = package_id or get_latest_package_version_id()
    installed, details, installed_pkg_id = is_tubot_package_installed(target_org)
    if installed and installed_pkg_id == pkg_to_install:
        log_success(f"TuBot package is up to date on '{target_org}': {BOLD}{details}{RESET}")
    else:
        if installed:
            log_info(f"Upgrading TuBot package on '{target_org}' from {details} to {BOLD}{pkg_to_install}{RESET}...")
        else:
            log_info(f"TuBot package not found on org '{target_org}'.")
            log_info(f"Installing TuBot managed package ({BOLD}{pkg_to_install}{RESET}) - this may take 1-2 minutes...")

        install_res = run_sf([
            "package", "install",
            "--package", pkg_to_install,
            "--target-org", target_org,
            "--wait", "15",
            "--no-prompt",
        ], timeout=900)

        if install_res["returncode"] != 0:
            err = install_res.get("error_msg") or install_res["stderr"] or install_res["stdout"]
            log_error(f"Failed to install TuBot package '{pkg_to_install}': {err}")
            sys.exit(1)

        log_success(f"TuBot managed package '{pkg_to_install}' installed successfully!")

    # Ensure admin permission sets are assigned
    log_info("Ensuring admin permission sets are assigned...")
    for permset in ["tubot__Panel_Settings_Admin_Access"]:
        p_res = run_sf(["org", "assign", "permset", "--name", permset, "--target-org", target_org])
        if p_res["returncode"] == 0:
            log_success(f"Permission set '{permset}' assigned.")
        else:
            err = p_res.get("error_msg") or p_res["stderr"]
            if "Duplicate PermissionSetAssignment" in err:
                log_info(f"Permission set '{permset}' is already assigned.")
            else:
                log_warn(f"Note on permission set '{permset}': {err}")

    # Ensure User External Credentials permissions for Panel OAuth token storage
    ensure_user_external_credential_access(target_org)

    # Verify Custom Tab Panel_Settings is accessible
    tab_res = run_sf([
        "data", "query",
        "--use-tooling-api",
        "--query", "SELECT Id, DeveloperName, NamespacePrefix FROM CustomTab WHERE DeveloperName = 'Panel_Settings' AND NamespacePrefix = 'tubot' LIMIT 1",
        "--target-org", target_org,
    ])
    tabs = tab_res["data"].get("result", {}).get("records", [])
    if tabs:
        log_success("Custom Tab 'tubot__Panel_Settings' is verified and available.")
    else:
        log_warn("Custom Tab 'tubot__Panel_Settings' not found via Tooling API query; please verify package contents.")

    return True


def ensure_user_external_credential_access(target_org: str) -> bool:
    """
    Ensure the active user has full CRUD + ViewAllRecords on UserExternalCredential.
    This resolves PANEL_CREDENTIAL_ACCESS_REQUIRED during Panel token exchange.
    """
    log_info("Ensuring User External Credentials permissions for Panel token storage...")

    # First attempt: run the official repair script if available
    script_dir = Path(__file__).resolve().parent
    candidates = [
        script_dir / "repair-panel-external-credential-access.mjs",
        script_dir.parent / "tubot-sf-auth" / "tubot-sf-package" / "scripts" / "repair-panel-external-credential-access.mjs",
        Path("tubot-sf-auth/tubot-sf-package/scripts/repair-panel-external-credential-access.mjs"),
    ]
    for script in candidates:
        if script.exists():
            try:
                proc = subprocess.run(
                    ["bun", str(script), "--target-org", target_org],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                if proc.returncode == 0:
                    log_success("User External Credentials access verified via repair script.")
                    return True
                else:
                    log_warn(f"Repair script output: {proc.stderr or proc.stdout}")
            except Exception as e:
                log_warn(f"Could not execute repair script via bun: {e}")
            break

    # Fallback: Deploy TuBot_Panel_External_Credential_Admin_Repair metadata directly
    log_info("Deploying Panel_External_Credential, Panel_Named_Credential, and repair permission set directly...")
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        (temp_path / "sfdx-project.json").write_text(json.dumps({
            "packageDirectories": [{"path": "force-app", "default": True}],
            "sourceApiVersion": "67.0",
        }))
        
        # Check if tubot package external credential exists
        has_tubot_pkg = False
        check_pkg = run_sf([
            "data", "query",
            "--target-org", target_org,
            "--use-tooling-api",
            "--query", "SELECT Id, DeveloperName FROM ExternalCredential WHERE DeveloperName = 'Panel_External_Credential' AND NamespacePrefix = 'tubot' LIMIT 1"
        ])
        if check_pkg["returncode"] == 0 and check_pkg["data"].get("result", {}).get("records"):
            has_tubot_pkg = True

        ext_cred_dir = temp_path / "force-app" / "main" / "default" / "externalCredentials"
        ext_cred_dir.mkdir(parents=True, exist_ok=True)
        (ext_cred_dir / "Panel_External_Credential.externalCredential-meta.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<ExternalCredential xmlns="http://soap.sforce.com/2006/04/metadata">\n'
            '    <authenticationProtocol>Custom</authenticationProtocol>\n'
            '    <externalCredentialParameters>\n'
            '        <parameterGroup>DefaultGroup</parameterGroup>\n'
            '        <parameterName>Panel_Principal</parameterName>\n'
            '        <parameterType>NamedPrincipal</parameterType>\n'
            '        <sequenceNumber>1</sequenceNumber>\n'
            '    </externalCredentialParameters>\n'
            '    <externalCredentialParameters>\n'
            '        <parameterGroup>DefaultGroup</parameterGroup>\n'
            '        <parameterName>Authorization</parameterName>\n'
            '        <parameterType>AuthHeader</parameterType>\n'
            '        <parameterValue>Bearer {!$Credential.Panel_External_Credential.token}</parameterValue>\n'
            '        <sequenceNumber>2</sequenceNumber>\n'
            '    </externalCredentialParameters>\n'
            '    <label>Panel External Credential</label>\n'
            '</ExternalCredential>\n'
        )

        named_cred_dir = temp_path / "force-app" / "main" / "default" / "namedCredentials"
        named_cred_dir.mkdir(parents=True, exist_ok=True)
        (named_cred_dir / "Panel_Named_Credential.namedCredential-meta.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">\n'
            '    <allowMergeFieldsInBody>false</allowMergeFieldsInBody>\n'
            '    <allowMergeFieldsInHeader>true</allowMergeFieldsInHeader>\n'
            '    <calloutStatus>Enabled</calloutStatus>\n'
            '    <generateAuthorizationHeader>true</generateAuthorizationHeader>\n'
            '    <label>Panel Named Credential</label>\n'
            '    <namedCredentialParameters>\n'
            '        <parameterName>Url</parameterName>\n'
            '        <parameterType>Url</parameterType>\n'
            '        <parameterValue>https://tubot-new-panel.emalteaproductions.workers.dev</parameterValue>\n'
            '    </namedCredentialParameters>\n'
            '    <namedCredentialParameters>\n'
            '        <externalCredential>Panel_External_Credential</externalCredential>\n'
            '        <parameterName>ExternalCredential</parameterName>\n'
            '        <parameterType>Authentication</parameterType>\n'
            '    </namedCredentialParameters>\n'
            '    <namedCredentialType>SecuredEndpoint</namedCredentialType>\n'
            '</NamedCredential>\n'
        )

        remote_site_dir = temp_path / "force-app" / "main" / "default" / "remoteSiteSettings"
        remote_site_dir.mkdir(parents=True, exist_ok=True)
        (remote_site_dir / "Panel_Tubot_Active.remoteSite-meta.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">\n'
            '    <description>Active remote site setting for TuBot Panel polling and callouts</description>\n'
            '    <disableProtocolSecurity>false</disableProtocolSecurity>\n'
            '    <isActive>true</isActive>\n'
            '    <url>https://tubot-new-panel.emalteaproductions.workers.dev</url>\n'
            '</RemoteSiteSetting>\n'
        )

        principals_xml = (
            '    <externalCredentialPrincipalAccesses>\n'
            '        <enabled>true</enabled>\n'
            '        <externalCredentialPrincipal>Panel_External_Credential-Panel_Principal</externalCredentialPrincipal>\n'
            '    </externalCredentialPrincipalAccesses>\n'
        )
        if has_tubot_pkg:
            principals_xml += (
                '    <externalCredentialPrincipalAccesses>\n'
                '        <enabled>true</enabled>\n'
                '        <externalCredentialPrincipal>tubot__Panel_External_Credential-Panel_Principal</externalCredentialPrincipal>\n'
                '    </externalCredentialPrincipalAccesses>\n'
            )

        perm_dir = temp_path / "force-app" / "main" / "default" / "permissionsets"
        perm_dir.mkdir(parents=True, exist_ok=True)
        (perm_dir / "TuBot_Panel_External_Credential_Admin_Repair.permissionset-meta.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n'
            '    <description>Provides User External Credential access required to connect Panel from TuBot Settings.</description>\n'
            '    <hasActivationRequired>false</hasActivationRequired>\n'
            '    <label>TuBot Panel External Credential Admin Repair</label>\n'
            f'{principals_xml}'
            '    <objectPermissions>\n'
            '        <allowCreate>true</allowCreate>\n'
            '        <allowDelete>true</allowDelete>\n'
            '        <allowEdit>true</allowEdit>\n'
            '        <allowRead>true</allowRead>\n'
            '        <modifyAllRecords>false</modifyAllRecords>\n'
            '        <object>UserExternalCredential</object>\n'
            '        <viewAllRecords>true</viewAllRecords>\n'
            '    </objectPermissions>\n'
            '</PermissionSet>\n'
        )

        deploy_res = run_sf([
            "project", "deploy", "start",
            "--source-dir", str(temp_path / "force-app"),
            "--target-org", target_org,
            "--ignore-conflicts",
            "--wait", "10",
        ], cwd=str(temp_path))
        if deploy_res["returncode"] != 0:
            log_warn(f"PermissionSet deployment note: {deploy_res.get('error_msg') or deploy_res['stderr']}")

    # Assign permission set to user
    assign_res = run_sf([
        "org", "assign", "permset",
        "--name", "TuBot_Panel_External_Credential_Admin_Repair",
        "--target-org", target_org,
    ])
    if assign_res["returncode"] == 0:
        log_success("PermissionSet 'TuBot_Panel_External_Credential_Admin_Repair' assigned to user.")
    else:
        err = assign_res.get("error_msg") or assign_res["stderr"]
        if "Duplicate PermissionSetAssignment" in err:
            log_info("PermissionSet 'TuBot_Panel_External_Credential_Admin_Repair' already assigned.")
        else:
            log_warn(f"Note on assigning repair permset: {err}")

    return True


# ==============================================================================
# Consent Gate: must-read info + per-step checkboxes
# ==============================================================================
POSTINSTALL_CONSENT_STEPS = [
    {
        "id": "package",
        "title": "Managed package install / upgrade",
        "what": "Installs (or upgrades) the TuBot 2GP managed package on the target org, assigns the TuBot admin permission sets, and repairs Panel external-credential access.",
        "why": "Later steps need the packaged objects, tabs, and credentials to exist.",
    },
    {
        "id": "integration-user",
        "title": "Integration user setup",
        "what": "Lists active users, lets you pick the integration user, and assigns the Tubot_Salesforce_API_Read permission set to it.",
        "why": "Panel calls Salesforce as this user; channel creation, the External Client App, registration, and verification all run in its context.",
    },
    {
        "id": "channel",
        "title": "Messaging channel setup",
        "what": "Selects (and activates) an existing MessagingChannel, or creates a new Web Messaging channel with an Omni-Queue and enrolls the integration user.",
        "why": "The channel is the chat endpoint Panel delivers messages to.",
    },
    {
        "id": "panel-login",
        "title": "Panel connection check",
        "what": "Tests the Panel link via the org Named Credential and, if not connected, walks you through Panel login in tubot__Panel_Settings (browser).",
        "why": "Registration and verification call Panel through this connection.",
    },
    {
        "id": "eca",
        "title": "Packaged execution client + pre-authorization",
        "what": "Uses your authenticated CLI session to configure subscriber policies and assign Tubot_JWT_PreAuth. Browser alternative: Panel Settings → Simple Setup → Authorize & continue; or use its manual Setup steps.",
        "why": "Panel mints short-lived JWT tokens only for pre-authorized users.",
    },
    {
        "id": "registration",
        "title": "Panel registration + Salesforce link record",
        "what": "Sends the channel identity to Panel (Panel proves the JWT grant live before storing) and creates/updates the tubot__Tubot_API_Channel__c link record in Salesforce.",
        "why": "This is the stored join between org, channel, user, and Panel team.",
    },
    {
        "id": "verify",
        "title": "Blind verification",
        "what": "Re-reads every mutation from Salesforce and Panel (pre-authorization, channel list, link record, API permission set) and asserts ground truth.",
        "why": "Proves the setup really landed instead of trusting success messages.",
    },
]

POSTINSTALL_CONSENT_IDS = [s["id"] for s in POSTINSTALL_CONSENT_STEPS]


def print_postinstall_info(org: Dict[str, str]) -> None:
    """Must-read screen: WHAT / HOW / WHEN / WHY. Waits for acknowledgement."""
    print(f"\n{BOLD}{CYAN}=============================================================================={RESET}")
    print(f"{BOLD}{CYAN}Before you continue: what this wizard does (please read){RESET}")
    print(f"{BOLD}{CYAN}=============================================================================={RESET}")
    print("Browser alternative: Panel Settings → Simple Setup offers an ephemeral Salesforce approval popup")
    print("and manual Setup instructions. The browser flow does not require this CLI wizard.")
    print(f"\n{BOLD}WHAT{RESET} this wizard does, in order:")
    for idx, step in enumerate(POSTINSTALL_CONSENT_STEPS, start=1):
        print(f"  {idx}. {BOLD}{step['title']}{RESET} [{step['id']}]")
        print(f"     {step['what']}")
    print(f"\n{BOLD}HOW{RESET} it works:")
    print("  - Runs Salesforce CLI (`sf`) commands and metadata deploys against the org below,")
    print("    plus Panel API calls made through the org's Panel Named Credential.")
    print("  - Every mutation is re-read back from the target system (blind verification);")
    print("    nothing is assumed from a success message alone.")
    print(f"\n{BOLD}WHEN{RESET} changes apply:")
    print(f"  - Immediately, right now, and ONLY to this org: {BOLD}{org['alias']}{RESET} ({org['org_id']})")
    print("  - Re-running is safe: each step detects existing state and resumes or upgrades")
    print("    instead of duplicating anything.")
    print(f"\n{BOLD}WHY{RESET} each part exists:")
    print("  - Panel needs a channel id, OAuth credentials scoped to an integration user,")
    print("    and a stored link record to deliver and answer chats.")
    print("  - Salesforce needs the TuBot package, an active channel + queue, and the")
    print("    External Client App for those pieces to exist.")
    print(f"\n{BOLD}YOUR CHOICE:{RESET} on the next screen you check one box per step above.")
    print("  Unchecked steps are skipped and the wizard continues with the rest.")
    print("  Steps whose inputs were skipped (e.g. credentials without a user) are also")
    print("  skipped, with the reason shown. Re-run any time to finish skipped steps.")
    prompt(f"\n{BOLD}Press Enter to continue to the consent checkboxes...{RESET}")


def parse_step_list(value: Optional[str]) -> Optional[set]:
    """Parse a comma/space-separated step-id list. None means 'flag not given'."""
    if value is None:
        return None
    wanted = {t.strip().lower() for t in re.split(r"[,\s]+", value.strip()) if t.strip()}
    unknown = sorted(wanted - set(POSTINSTALL_CONSENT_IDS))
    if unknown:
        log_error(f"Unknown post-install step(s): {', '.join(unknown)}. Valid steps: {', '.join(POSTINSTALL_CONSENT_IDS)}")
        sys.exit(1)
    return wanted


def resolve_consent(args: argparse.Namespace) -> Dict[str, bool]:
    """Compute the initial checkbox state from CLI flags (before interactive toggles)."""
    only = parse_step_list(getattr(args, "only_steps", None))
    skip = parse_step_list(getattr(args, "skip_steps", None)) or set()
    if getattr(args, "skip_package_install", False):
        skip.add("package")
    if getattr(args, "skip_verify", False):
        skip.add("verify")
    if only is not None:
        return {step_id: (step_id in only and step_id not in skip) for step_id in POSTINSTALL_CONSENT_IDS}
    return {step_id: step_id not in skip for step_id in POSTINSTALL_CONSENT_IDS}


def prompt_consent(initial: Dict[str, bool]) -> Dict[str, bool]:
    """Interactive checkbox toggles. Empty input confirms the current selection."""
    consent = dict(initial)
    print(f"\n{BOLD}Check what this run is allowed to do (unchecked steps are skipped):{RESET}")
    print(f"{DIM}Type numbers to toggle (e.g. \"2 5\"), \"all\", or \"none\". Press Enter on an empty line to continue.{RESET}")
    while True:
        print("")
        for idx, step in enumerate(POSTINSTALL_CONSENT_STEPS, start=1):
            box = f"{GREEN}[x]{RESET}" if consent[step["id"]] else f"{DIM}[ ]{RESET}"
            print(f"  [{idx}] {box} {BOLD}{step['title']}{RESET} [{step['id']}]")
            print(f"       {DIM}{step['what']}{RESET}")
        raw = prompt("\nToggle (numbers/all/none, empty = continue): ").strip().lower()
        if raw in ("", "done", "continue", "ok"):
            if not any(consent.values()):
                confirm = prompt(f"{YELLOW}Nothing is checked: the wizard will only connect and exit. Continue anyway? [y/N]: {RESET}").strip().lower()
                if confirm not in ("y", "yes"):
                    continue
            break
        if raw in ("all", "a", "*"):
            consent = {k: True for k in consent}
            continue
        if raw in ("none", "n", "clear", "0"):
            consent = {k: False for k in consent}
            continue
        tokens = [t for t in re.split(r"[,\s]+", raw) if t]
        valid = True
        for tok in tokens:
            if tok.isdigit() and 1 <= int(tok) <= len(POSTINSTALL_CONSENT_STEPS):
                step_id = POSTINSTALL_CONSENT_STEPS[int(tok) - 1]["id"]
                consent[step_id] = not consent[step_id]
            else:
                print(f"{RED}Invalid choice '{tok}'. Use numbers 1-{len(POSTINSTALL_CONSENT_STEPS)}, 'all', 'none', or Enter to continue.{RESET}")
                valid = False
                break
        if valid:
            picked = ", ".join(sid for sid in POSTINSTALL_CONSENT_IDS if consent[sid]) or "none"
            log_info(f"Currently checked: {picked}")
    picked = [sid for sid in POSTINSTALL_CONSENT_IDS if consent[sid]]
    skipped = [sid for sid in POSTINSTALL_CONSENT_IDS if not consent[sid]]
    if skipped:
        log_warn(f"Skipped by your choice: {', '.join(skipped)}. The wizard will continue with: {', '.join(picked) or 'nothing'}.")
    else:
        log_success("All steps checked. Running the full post-install.")
    return consent


# ==============================================================================
# Post-Install Orchestrator (specific org, no scratch creation)
# ==============================================================================
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="TuBot Salesforce Post-Install Wizard: interactive channel setup for one specific org (Zero-Mock CLI)"
    )
    parser.add_argument("-u", "--integration-user", help="Salesforce Integration User (Username, Email, or ID)")
    parser.add_argument("-c", "--channel", help="MessagingChannel (DeveloperName or ID)")
    parser.add_argument("-n", "--app-name", default="Tubot_SF_Channel_API", help="Deprecated and ignored: the JWT execution client ships in the package.")
    parser.add_argument("-q", "--queue-name", default=DEFAULT_QUEUE_NAME, help=f"Omni-Queue DeveloperName for new channels (default: {DEFAULT_QUEUE_NAME})")
    parser.add_argument("--queue-label", default=DEFAULT_QUEUE_LABEL, help=f"Omni-Queue label for new channels (default: {DEFAULT_QUEUE_LABEL})")
    parser.add_argument("-r", "--routing-config", dest="routing_config_name", default=DEFAULT_ROUTING_CONFIG_NAME, help=f"QueueRoutingConfig DeveloperName for new channels (default: {DEFAULT_ROUTING_CONFIG_NAME})")
    parser.add_argument("--routing-config-label", default=DEFAULT_ROUTING_CONFIG_LABEL, help=f"QueueRoutingConfig label for new channels (default: {DEFAULT_ROUTING_CONFIG_LABEL})")
    parser.add_argument("--skip-package-install", action="store_true", help="Skip automatic TuBot managed package verification and installation (same as unchecking 'package')")
    parser.add_argument("-p", "--package-id", "--package-version-id", dest="package_id", help="TuBot managed package version ID to install (default: latest in sfdx-project.json)")
    parser.add_argument("--non-interactive", action="store_true", help="Assume defaults for user/channel prompts and auto-accept all consent boxes (narrow with --skip-steps/--only-steps; target org selection stays interactive)")
    parser.add_argument("--skip-verify", action="store_true", help="Skip post-setup verification self-test (same as unchecking 'verify')")
    parser.add_argument("--skip-steps", help="Comma-separated consent steps to skip (valid: package, integration-user, channel, panel-login, eca, registration, verify)")
    parser.add_argument("--only-steps", help="Comma-separated consent steps to run; all other steps are skipped")
    parser.add_argument("--json", action="store_true", help="Output JSON result only")
    parser.add_argument("--version", action="store_true", help="Print post-install module version and exit")
    return parser


def run_postinstall(args: argparse.Namespace) -> Dict[str, Any]:
    """Execute the full post-install flow against one specific org.

    Shared by the standalone CLI entrypoint and by scripts/setup_channel.py
    (which adds optional scratch-org creation on top). Returns the result
    payload; exits the process on any failure (fail fast, zero mocks).
    """
    if not args.json:
        print(f"\n{BOLD}{CYAN}=============================================================================={RESET}")
        print(f"{BOLD}{CYAN}TuBot Salesforce Post-Install Wizard v{TUBOT_POSTINSTALL_VERSION}{RESET}")
        print(f"{BOLD}{CYAN}=============================================================================={RESET}")

    # 0. Select Target Org via wizard (setup_channel.py may preselect after scratch creation)
    target_org = getattr(args, "target_org", None) or select_target_org(args.non_interactive)

    # 1. Resolve Org
    org = resolve_org(target_org)

    # 1a. Must-read info + consent checkboxes (unchecked steps are skipped below)
    consent = resolve_consent(args)
    if args.non_interactive:
        flag_skipped = [sid for sid in POSTINSTALL_CONSENT_IDS if not consent[sid]]
        if flag_skipped:
            log_warn(f"Non-interactive mode: skipping steps {', '.join(flag_skipped)}; all other steps auto-accepted.")
        else:
            log_info("Non-interactive mode: all post-install steps auto-accepted.")
    else:
        print_postinstall_info(org)
        consent = prompt_consent(consent)
    auto_skipped: List[str] = []

    # 1b. Ensure TuBot Package is installed on target org
    if consent["package"]:
        ensure_tubot_package_installed(org["target_flag"], package_id=args.package_id)
    else:
        log_skip("Managed package install", "not checked; steps needing packaged objects may fail")

    # 2. Select Integration User (+ assign API permission set atomically, so no
    # later failure or skip can leave the user without API access)
    user: Optional[Dict[str, str]] = None
    if consent["integration-user"]:
        user = select_integration_user(org, args.integration_user, args.non_interactive)
        ensure_permission_set(org, user)
    else:
        log_skip("Integration user setup", "not checked")

    # 3. Select or Create Channel
    channel_defaults = {
        "queue_name": getattr(args, "queue_name", DEFAULT_QUEUE_NAME),
        "queue_label": getattr(args, "queue_label", DEFAULT_QUEUE_LABEL),
        "routing_config_name": getattr(args, "routing_config_name", DEFAULT_ROUTING_CONFIG_NAME),
        "routing_config_label": getattr(args, "routing_config_label", DEFAULT_ROUTING_CONFIG_LABEL),
    }
    channel: Optional[Dict[str, str]] = None
    if consent["channel"]:
        channel = select_or_create_channel(org, user, args.channel, args.non_interactive, channel_defaults)
        if channel is None:
            auto_skipped.append("channel")
    else:
        log_skip("Messaging channel setup", "not checked")

    # 4. Verify Panel Connection
    panel_conn: Optional[Dict[str, Any]] = None
    if consent["panel-login"]:
        panel_conn = verify_and_prompt_panel_login(org, args.non_interactive)
    else:
        log_skip("Panel connection check", "not checked")

    # 5. Automated External Setup (API permission set assignment already ran
    # atomically with user selection in Step 2)
    log_phase("Step 5: Automated External Provisioning")
    eca_ready = False
    if consent["eca"]:
        if user is None:
            auto_skipped.append("eca")
            log_skip("Execution client pre-authorization", "requires the integration-user step")
        else:
            ensure_packaged_execution_client(org, user)
            eca_ready = True
    else:
        log_skip("Execution client pre-authorization", "not checked")
    record_id: Optional[str] = None
    if consent["registration"]:
        missing_inputs = [
            name
            for name, val in (
                ("messaging channel", channel),
                ("integration user", user),
                ("Panel connection", panel_conn),
            )
            if val is None
        ]
        if not eca_ready:
            missing_inputs.append("execution client pre-authorization")
        if missing_inputs:
            auto_skipped.append("registration")
            log_skip("Panel registration", f"requires skipped input(s): {', '.join(missing_inputs)}")
        else:
            assert channel is not None and user is not None
            assert panel_conn is not None
            register_channel_with_panel(org, channel, user)
            record_id = upsert_salesforce_api_channel_record(org, channel, user, panel_conn["team_id"])
    else:
        log_skip("Panel registration", "not checked")

    # 6. Verify
    if consent["verify"]:
        missing_inputs = [
            name
            for name, val in (
                ("messaging channel", channel),
                ("integration user", user),
                ("channel link record", record_id),
            )
            if val is None
        ]
        if missing_inputs:
            auto_skipped.append("verify")
            log_skip("Blind verification", f"requires skipped input(s): {', '.join(missing_inputs)}")
        else:
            assert channel is not None and user is not None
            assert record_id is not None
            verify_setup(org, channel, user, record_id)
    else:
        log_skip("Blind verification", "not checked")

    skipped_steps = [sid for sid in POSTINSTALL_CONSENT_IDS if not consent[sid]]
    result = {
        "success": True,
        "postinstall_version": TUBOT_POSTINSTALL_VERSION,
        "org": org,
        "consent": consent,
        "skipped_steps": skipped_steps,
        "auto_skipped_steps": auto_skipped,
        "user": user,
        "channel": channel,
        "panel": (
            {
                "teamId": panel_conn["team_id"],
                "teamName": panel_conn["team_name"],
            }
            if panel_conn
            else None
        ),
        "eca": {
            "appName": PACKAGED_EXECUTION_APP_NAME,
            "preAuthSet": JWT_PREAUTH_SET_NAME,
            "preAuthorized": eca_ready,
        },
        "salesforceChannelRecordId": record_id,
    }

    # Output Summary
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if skipped_steps or auto_skipped:
            print(f"\n{YELLOW}{BOLD}TuBot Salesforce Post-Install finished with skipped steps.{RESET}\n")
            print(f"  {BOLD}Skipped by your choice:{RESET}  {', '.join(skipped_steps) or 'none'}")
            print(f"  {BOLD}Auto-skipped (missing inputs):{RESET} {', '.join(auto_skipped) or 'none'}")
            print(f"  {DIM}Re-run the wizard and check the skipped boxes to finish setup.{RESET}\n")
        else:
            print(f"\n{GREEN}{BOLD}TuBot Salesforce Post-Install is Complete!{RESET}\n")
        print(f"  {BOLD}Salesforce Org:{RESET}            {org['alias']} ({org['org_id']})")
        print(f"  {BOLD}Integration User:{RESET}          {user['name'] + ' (' + user['username'] + ')' if user else 'skipped'}")
        print(f"  {BOLD}Messaging Channel:{RESET}         {channel['label'] + ' (' + channel['developer_name'] + ', Id: ' + channel['id'] + ')' if channel else 'skipped'}")
        print(f"  {BOLD}Panel Team:{RESET}                {panel_conn['team_name'] + ' (' + panel_conn['team_id'] + ')' if panel_conn else 'skipped'}")
        print(f"  {BOLD}Execution Client:{RESET}         {PACKAGED_EXECUTION_APP_NAME} (packaged, JWT)")
        print(f"  {BOLD}Pre-Authorized:{RESET}            {JWT_PREAUTH_SET_NAME if eca_ready else 'skipped'}")
        print(f"  {BOLD}Tubot API Channel Record:{RESET} {record_id or 'skipped'}\n")

    return result


def main(argv: Optional[List[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(TUBOT_POSTINSTALL_VERSION)
        return
    run_postinstall(args)


if __name__ == "__main__":
    main()
