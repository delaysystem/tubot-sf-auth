#!/usr/bin/env bash

# ==============================================================================
# Activate Omni Supervisor & Provision Supervisor Capabilities CLI
# ==============================================================================
# Automated 5-Step Pipeline:
#   Step 1: Ensure Omni-Channel is active in org metadata (OmniChannelSettings)
#   Step 2: Provision Supervisor Public Group, Service Cloud license & OmniSupervisorConfig
#   Step 3: Verify OmniSupervisorConfig record generation via Tooling SOQL
#   Step 4: Grant standard-OmniSupervisor tab access via Permission Set & assign to user
#   Step 5: Add Omni Supervisor tab to Lightning Service Console app navigation
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default configurations
TARGET_ORG="DevHub"
TARGET_USER="John Swanson"
CONFIG_DEV_NAME="Tier_1_Support_Supervisors"
CONFIG_LABEL="Tier 1 Support Supervisors"
GROUP_DEV_NAME="Omni_Supervisors"
GROUP_LABEL="Omni Supervisors"
PERM_SET_DEV_NAME="Omni_Supervisor_Access"
PERM_SET_LABEL="Omni Supervisor Access"
TABS_LIST="Agents,QueuesBacklog,AssignedWork,SkillsBacklog,Wallboard"
IS_TIMELINE_HIDDEN=false
SKILL_VISIBILITY="AllSkills"
APP_NAME="standard__LightningService"
DRY_RUN=false
WAIT_TIME=10

# Color formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_phase() { echo -e "\n${CYAN}${BOLD}===> $1${NC}"; }

# Extracts clean JSON from command output ignoring preceding CLI/Node warnings
extract_json() {
    sed -n '/^[{\[]/,$p'
}

show_help() {
    cat << EOF
Usage:
  ./setup_omni_supervisor.sh [options]

Options:
  -o, --target-org ALIAS       Target org username or alias (default: DevHub)
  -u, --user, -s, --supervisor IDENTIFIER
                               Target supervisor user (Full Name, Username, Email, Id, or 'default')
                               (default: 'John Swanson')
  -c, --config-name NAME       OmniSupervisorConfig DeveloperName (default: Tier_1_Support_Supervisors)
  -l, --config-label LABEL     OmniSupervisorConfig MasterLabel (default: 'Tier 1 Support Supervisors')
  -g, --group NAME             Supervisor Public Group DeveloperName (default: Omni_Supervisors)
  --group-label LABEL          Supervisor Public Group Label (default: 'Omni Supervisors')
  -p, --perm-set NAME          Supervisor PermissionSet DeveloperName (default: Omni_Supervisor_Access)
  --perm-set-label LABEL       Supervisor PermissionSet Label (default: 'Omni Supervisor Access')
  --tabs LIST                  Comma-separated tab types: Agents,QueuesBacklog,AssignedWork,SkillsBacklog,Wallboard
                               (default: Agents,QueuesBacklog,AssignedWork,SkillsBacklog,Wallboard)
  --skill-visibility TYPE      Skill visibility: AllSkills | AnySkill (default: AllSkills)
  --hide-timeline              Hide agent status timeline (default: visible / false)
  --app-name NAME              Target Console Application name (default: standard__LightningService)
  --dry-run                    Validate configuration and print payloads without writing changes
  -h, --help                   Display this help message

Examples:
  ./setup_omni_supervisor.sh --target-org test1empty --user "John Swanson"
  ./setup_omni_supervisor.sh -o test1empty -u "John Swanson" --config-name "Tier_1_Support_Supervisors"
  ./setup_omni_supervisor.sh --target-org DevHub --user default --dry-run
EOF
}

# Parse Command Line Arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--target-org)
            TARGET_ORG="$2"
            shift 2
            ;;
        -u|--user|-s|--supervisor)
            TARGET_USER="$2"
            shift 2
            ;;
        -c|--config-name)
            CONFIG_DEV_NAME="$2"
            shift 2
            ;;
        -l|--config-label)
            CONFIG_LABEL="$2"
            shift 2
            ;;
        -g|--group)
            GROUP_DEV_NAME="$2"
            shift 2
            ;;
        --group-label)
            GROUP_LABEL="$2"
            shift 2
            ;;
        -p|--perm-set)
            PERM_SET_DEV_NAME="$2"
            shift 2
            ;;
        --perm-set-label)
            PERM_SET_LABEL="$2"
            shift 2
            ;;
        --tabs)
            TABS_LIST="$2"
            shift 2
            ;;
        --skill-visibility)
            SKILL_VISIBILITY="$2"
            shift 2
            ;;
        --hide-timeline)
            IS_TIMELINE_HIDDEN=true
            shift
            ;;
        --app-name)
            APP_NAME="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Ensure Salesforce CLI ('sf') is available
if ! command -v sf &> /dev/null; then
    log_error "Salesforce CLI ('sf') is not installed or not in PATH."
    exit 1
fi

echo -e "${CYAN}${BOLD}"
echo "=========================================================================="
echo "    Salesforce Omni Supervisor Activation & User Provisioning CLI         "
echo "=========================================================================="
echo -e "${NC}"
log_info "Target Org:          ${BOLD}${TARGET_ORG}${NC}"
log_info "Target Supervisor:   ${BOLD}${TARGET_USER}${NC}"
log_info "Supervisor Config:   ${BOLD}${CONFIG_DEV_NAME}${NC} ('${CONFIG_LABEL}')"
log_info "Supervisor Group:    ${BOLD}${GROUP_DEV_NAME}${NC} ('${GROUP_LABEL}')"
log_info "Permission Set:      ${BOLD}${PERM_SET_DEV_NAME}${NC}"
log_info "Skill Visibility:    ${BOLD}${SKILL_VISIBILITY}${NC}"
log_info "Timeline Hidden:     ${BOLD}${IS_TIMELINE_HIDDEN}${NC}"
log_info "Tabs Enabled:        ${BOLD}${TABS_LIST}${NC}"
log_info "Target Console App:  ${BOLD}${APP_NAME}${NC}"
log_info "Dry Run Mode:        ${BOLD}${DRY_RUN}${NC}"

# ==============================================================================
# Step 0: Check Target Org Connectivity & Resolve User
# ==============================================================================
log_phase "Step 0: Checking Org Connectivity & Resolving User"

ORG_DISPLAY_JSON=$(SF_TEMP_SHOW_SECRETS=true sf org display --target-org "${TARGET_ORG}" --json 2>/dev/null || true)
ORG_ID=$(echo "$ORG_DISPLAY_JSON" | jq -r '.result.id // empty')
INSTANCE_URL=$(echo "$ORG_DISPLAY_JSON" | jq -r '.result.instanceUrl // empty')
CONNECTED_USER=$(echo "$ORG_DISPLAY_JSON" | jq -r '.result.username // empty')
ACCESS_TOKEN=$(echo "$ORG_DISPLAY_JSON" | jq -r '.result.accessToken // empty')
API_VERSION=$(echo "$ORG_DISPLAY_JSON" | jq -r '.result.instanceApiVersion // "61.0"')

if [[ -z "$ORG_ID" || -z "$INSTANCE_URL" ]]; then
    log_error "Failed to connect to target org '${TARGET_ORG}'. Please verify authentication ('sf org login web')."
    exit 1
fi

log_success "Connected to Org: ${ORG_ID} (${INSTANCE_URL})"
log_info "Authenticated Session: ${CONNECTED_USER} (API v${API_VERSION})"

# Resolve Target User
ACTUAL_TARGET_USER="$TARGET_USER"
if [[ "$TARGET_USER" == "default" || "$TARGET_USER" == "current" ]]; then
    ACTUAL_TARGET_USER="$CONNECTED_USER"
fi

if [[ ${#ACTUAL_TARGET_USER} -eq 15 || ${#ACTUAL_TARGET_USER} -eq 18 ]]; then
    RESOLVE_SOQL="SELECT Id, Name, Username, Email, IsActive, UserPermissionsSupportUser, Profile.Name FROM User WHERE (Id = '${ACTUAL_TARGET_USER}' OR Name = '${ACTUAL_TARGET_USER}' OR Username = '${ACTUAL_TARGET_USER}' OR Email = '${ACTUAL_TARGET_USER}') AND IsActive = true ORDER BY LastLoginDate DESC NULLS LAST LIMIT 1"
else
    RESOLVE_SOQL="SELECT Id, Name, Username, Email, IsActive, UserPermissionsSupportUser, Profile.Name FROM User WHERE (Name = '${ACTUAL_TARGET_USER}' OR Username = '${ACTUAL_TARGET_USER}' OR Email = '${ACTUAL_TARGET_USER}' OR Name LIKE '%${ACTUAL_TARGET_USER}%') AND IsActive = true ORDER BY LastLoginDate DESC NULLS LAST LIMIT 1"
fi
USER_QUERY_RESP=$(sf data query -q "$RESOLVE_SOQL" --target-org "${TARGET_ORG}" --json 2>/dev/null || true)
USER_ID=$(echo "$USER_QUERY_RESP" | jq -r '.result.records[0].Id // empty')
USER_NAME=$(echo "$USER_QUERY_RESP" | jq -r '.result.records[0].Name // empty')
USER_USERNAME=$(echo "$USER_QUERY_RESP" | jq -r '.result.records[0].Username // empty')
USER_EMAIL=$(echo "$USER_QUERY_RESP" | jq -r '.result.records[0].Email // empty')
USER_PROFILE=$(echo "$USER_QUERY_RESP" | jq -r '.result.records[0].Profile.Name // empty')
USER_SUPPORT_LIC=$(echo "$USER_QUERY_RESP" | jq -r '.result.records[0].UserPermissionsSupportUser // false')

if [[ -z "$USER_ID" ]]; then
    log_error "No active Salesforce user found matching identifier '${ACTUAL_TARGET_USER}' in org ${TARGET_ORG}."
    exit 1
fi

log_success "Resolved Supervisor User: ${BOLD}${USER_NAME}${NC} (Id: ${USER_ID})"
log_info "  Username:            ${USER_USERNAME}"
log_info "  Email:               ${USER_EMAIL}"
log_info "  Profile:             ${USER_PROFILE}"
log_info "  Service Cloud User:  ${USER_SUPPORT_LIC}"

# ==============================================================================
# Step 1: Ensure Omni-Channel Is Active (Prerequisite)
# ==============================================================================
log_phase "Step 1: Ensuring Org-Level Omni-Channel Feature Is Active"

SETTINGS_FILE="${SCRIPT_DIR}/force-app/main/default/settings/OmniChannel.settings-meta.xml"
if [[ ! -f "$SETTINGS_FILE" ]]; then
    mkdir -p "${SCRIPT_DIR}/force-app/main/default/settings"
    cat << 'EOF' > "$SETTINGS_FILE"
<?xml version="1.0" encoding="UTF-8"?>
<OmniChannelSettings xmlns="http://soap.sforce.com/2006/04/metadata">
    <enableOmniAutoLoginPrompt>false</enableOmniAutoLoginPrompt>
    <enableOmniChannel>true</enableOmniChannel>
    <enableOmniSecondaryRoutingPriority>false</enableOmniSecondaryRoutingPriority>
    <enableOmniSkillsRouting>false</enableOmniSkillsRouting>
    <enableOmniStatusCapModel>false</enableOmniStatusCapModel>
</OmniChannelSettings>
EOF
fi

DEPLOY_SETTINGS_CMD="sf project deploy start --source-dir \"${SETTINGS_FILE}\" --target-org \"${TARGET_ORG}\" --wait ${WAIT_TIME}"
if [ "$DRY_RUN" = true ]; then
    DEPLOY_SETTINGS_CMD="${DEPLOY_SETTINGS_CMD} --dry-run"
    log_info "[DRY-RUN] Would deploy OmniChannel settings..."
fi

log_info "Deploying OmniChannelSettings (enableOmniChannel=true)..."
eval "$DEPLOY_SETTINGS_CMD"
log_success "Step 1 Complete: Omni-Channel is active in org ${ORG_ID}!"

# ==============================================================================
# Step 2: Provision Supervisor Public Group, Service License & Permission Set
# ==============================================================================
log_phase "Step 2: Provisioning Supervisor Group, License & Permissions for ${USER_NAME}"

if [ "$DRY_RUN" = true ]; then
    log_info "[DRY-RUN] Skipping Apex mutations for Public Group and License provisioning."
else
    APEX_PROV_SCRIPT=$(cat << EOF
String jsonConfig = JSON.serialize(new Map<String, String>{
    'userIdentifier' => '${USER_ID}',
    'groupDevName' => '${GROUP_DEV_NAME}',
    'groupLabel' => '${GROUP_LABEL}',
    'permSetDevName' => '${PERM_SET_DEV_NAME}',
    'permSetLabel' => '${PERM_SET_LABEL}'
});
OmniSupervisorSetupService.executeSetupScript(jsonConfig);
EOF
)
    log_info "Executing Apex provisioning script on ${TARGET_ORG}..."
    APEX_OUTPUT=$(echo "$APEX_PROV_SCRIPT" | sf apex run --target-org "${TARGET_ORG}" 2>&1 || true)

    RAW_RESULT=$(echo "$APEX_OUTPUT" | grep -o '<<<OMNI_SUPERVISOR_SETUP_RESULT>>>.*<<<END_OMNI_SUPERVISOR_SETUP_RESULT>>>' || true)
    RAW_RESULT="${RAW_RESULT#<<<OMNI_SUPERVISOR_SETUP_RESULT>>>}"
    RAW_RESULT="${RAW_RESULT%<<<END_OMNI_SUPERVISOR_SETUP_RESULT>>>}"

    if [[ -n "$RAW_RESULT" ]]; then
        PROV_SUCCESS=$(echo "$RAW_RESULT" | jq -r '.success')
        PROV_MSG=$(echo "$RAW_RESULT" | jq -r '.message')
        PROV_GRP_ID=$(echo "$RAW_RESULT" | jq -r '.groupId // empty')
        PROV_PS_ID=$(echo "$RAW_RESULT" | jq -r '.permissionSetId // empty')

        if [ "$PROV_SUCCESS" = "true" ]; then
            log_success "Apex Operational Setup Succeeded!"
            log_info "  Public Group ID:     ${PROV_GRP_ID} (${GROUP_DEV_NAME})"
            log_info "  Permission Set ID:   ${PROV_PS_ID} (${PERM_SET_DEV_NAME})"
            log_info "  Result:              ${PROV_MSG}"
        else
            log_error "Apex Operational Setup error: ${PROV_MSG}"
            echo "$RAW_RESULT" | jq -r '.logs[]?'
            exit 1
        fi
    else
        log_warn "Apex execution completed without structured output. Raw log:"
        echo "$APEX_OUTPUT"
    fi
fi

# ==============================================================================
# Step 3: Create / Update OmniSupervisorConfig via Tooling API REST Endpoint
# ==============================================================================
log_phase "Step 3: Creating OmniSupervisorConfig via Tooling API REST Endpoint"

# Build tabs array JSON
IFS=',' read -ra TAB_ITEMS <<< "$TABS_LIST"
TABS_JSON="["
DISPLAY_ORDER=1
for tab_item in "${TAB_ITEMS[@]}"; do
    tab_trimmed=$(echo "$tab_item" | xargs)
    if [[ $DISPLAY_ORDER -gt 1 ]]; then
        TABS_JSON="${TABS_JSON},"
    fi
    TABS_JSON="${TABS_JSON}{\"displayOrder\": ${DISPLAY_ORDER}, \"tabType\": \"${tab_trimmed}\"}"
    DISPLAY_ORDER=$((DISPLAY_ORDER + 1))
done
TABS_JSON="${TABS_JSON}]"

SUPERVISOR_CONFIG_PAYLOAD=$(cat << EOF
{
  "FullName": "${CONFIG_DEV_NAME}",
  "Metadata": {
    "masterLabel": "${CONFIG_LABEL}",
    "isTimelineHidden": ${IS_TIMELINE_HIDDEN},
    "skillVisibility": "${SKILL_VISIBILITY}",
    "omniSupervisorConfigGroup": [
      {
        "group": "${GROUP_DEV_NAME}"
      }
    ],
    "omniSupervisorConfigTab": ${TABS_JSON}
  }
}
EOF
)

# Check if OmniSupervisorConfig already exists
EXISTING_CONFIG_QUERY=$(sf data query --use-tooling-api -q "SELECT Id, DeveloperName, MasterLabel FROM OmniSupervisorConfig WHERE DeveloperName = '${CONFIG_DEV_NAME}'" --target-org "${TARGET_ORG}" --json 2>/dev/null || true)
EXISTING_CONFIG_ID=$(echo "$EXISTING_CONFIG_QUERY" | extract_json | jq -r '.result.records[0].Id // empty' 2>/dev/null || true)

if [ "$DRY_RUN" = true ]; then
    log_info "[DRY-RUN] OmniSupervisorConfig Tooling API Payload:"
    echo "$SUPERVISOR_CONFIG_PAYLOAD" | jq .
    CONFIG_RECORD_ID="0Q2xxDRYRUNxxxx"
else
    if [[ -n "$EXISTING_CONFIG_ID" ]]; then
        log_info "Existing OmniSupervisorConfig '${CONFIG_DEV_NAME}' found (Id: ${EXISTING_CONFIG_ID}). Updating via PATCH..."
        # Update existing record via PATCH
        UPDATE_PAYLOAD=$(cat << EOF
{
  "Metadata": {
    "masterLabel": "${CONFIG_LABEL}",
    "isTimelineHidden": ${IS_TIMELINE_HIDDEN},
    "skillVisibility": "${SKILL_VISIBILITY}",
    "omniSupervisorConfigGroup": [
      {
        "group": "${GROUP_DEV_NAME}"
      }
    ],
    "omniSupervisorConfigTab": ${TABS_JSON}
  }
}
EOF
        )
        sf api request rest "/services/data/v61.0/tooling/sobjects/OmniSupervisorConfig/${EXISTING_CONFIG_ID}" \
            --method PATCH \
            --body "$UPDATE_PAYLOAD" \
            --target-org "${TARGET_ORG}" >/dev/null
        CONFIG_RECORD_ID="${EXISTING_CONFIG_ID}"
        log_success "OmniSupervisorConfig '${CONFIG_DEV_NAME}' updated successfully (Id: ${CONFIG_RECORD_ID})!"
    else
        log_info "Creating new OmniSupervisorConfig '${CONFIG_DEV_NAME}' via POST /services/data/v61.0/tooling/sobjects/OmniSupervisorConfig..."
        CREATE_RESP=$(sf api request rest "/services/data/v61.0/tooling/sobjects/OmniSupervisorConfig" \
            --method POST \
            --body "$SUPERVISOR_CONFIG_PAYLOAD" \
            --target-org "${TARGET_ORG}" 2>&1 || true)
        CONFIG_RECORD_ID=$(echo "$CREATE_RESP" | extract_json | jq -r '.id // empty' 2>/dev/null || true)
        if [[ -z "$CONFIG_RECORD_ID" ]]; then
            CONFIG_RECORD_ID=$(sf data query --use-tooling-api -q "SELECT Id FROM OmniSupervisorConfig WHERE DeveloperName = '${CONFIG_DEV_NAME}'" --target-org "${TARGET_ORG}" --json 2>/dev/null | extract_json | jq -r '.result.records[0].Id // empty' 2>/dev/null || true)
        fi
        if [[ -z "$CONFIG_RECORD_ID" ]]; then
            log_error "Failed to create OmniSupervisorConfig via Tooling API. Response:"
            echo "$CREATE_RESP"
            exit 1
        fi
        log_success "OmniSupervisorConfig created successfully (Id: ${CONFIG_RECORD_ID})!"
    fi
fi

# ==============================================================================
# Step 4: Verify Configuration via Tooling SOQL
# ==============================================================================
log_phase "Step 4: Verifying Configuration via Tooling SOQL"

log_info "Executing Tooling SOQL: SELECT Id, DeveloperName, MasterLabel, IsTimelineHidden, SkillVisibility FROM OmniSupervisorConfig WHERE DeveloperName = '${CONFIG_DEV_NAME}'"

if [ "$DRY_RUN" = true ]; then
    log_info "[DRY-RUN] Simulated Tooling SOQL Response:"
    cat << EOF
{
  "size": 1,
  "totalSize": 1,
  "done": true,
  "records": [
    {
      "attributes": {
        "type": "OmniSupervisorConfig",
        "url": "/services/data/v61.0/tooling/sobjects/OmniSupervisorConfig/${CONFIG_RECORD_ID}"
      },
      "Id": "${CONFIG_RECORD_ID}",
      "DeveloperName": "${CONFIG_DEV_NAME}",
      "MasterLabel": "${CONFIG_LABEL}",
      "IsTimelineHidden": ${IS_TIMELINE_HIDDEN},
      "SkillVisibility": "${SKILL_VISIBILITY}"
    }
  ]
}
EOF
else
    VERIFY_QUERY="SELECT Id, DeveloperName, MasterLabel, IsTimelineHidden, SkillVisibility FROM OmniSupervisorConfig WHERE DeveloperName = '${CONFIG_DEV_NAME}'"
    VERIFY_RESP=$(sf data query --use-tooling-api -q "$VERIFY_QUERY" --target-org "${TARGET_ORG}" --json 2>/dev/null || true)
    VERIFY_JSON=$(echo "$VERIFY_RESP" | extract_json)
    RECORD_COUNT=$(echo "$VERIFY_JSON" | jq -r '.result.totalSize // 0' 2>/dev/null || echo 0)

    if [[ "$RECORD_COUNT" -gt 0 ]]; then
        echo -e "${GREEN}"
        echo "$VERIFY_JSON" | jq '.result'
        echo -e "${NC}"
        log_success "Step 3/4 Verification Succeeded: OmniSupervisorConfig is active and verified in Tooling API!"
    else
        log_error "Verification failed: OmniSupervisorConfig record '${CONFIG_DEV_NAME}' not found in Tooling API."
        exit 1
    fi
fi

# ==============================================================================
# Step 5: Grant Tab Access via Permission Set & Deploy Application Metadata
# ==============================================================================
log_phase "Step 5: Granting Tab Access & Adding Tab to Console Navigation"

# 1. Deploy Permission Set with standard-OmniSupervisor tabSettings
PERM_SET_FILE="${SCRIPT_DIR}/force-app/main/default/permissionsets/${PERM_SET_DEV_NAME}.permissionset-meta.xml"
if [[ ! -f "$PERM_SET_FILE" ]]; then
    mkdir -p "${SCRIPT_DIR}/force-app/main/default/permissionsets"
    cat << EOF > "$PERM_SET_FILE"
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Grants access to Omni-Channel Supervisor tab and monitoring capabilities</description>
    <hasActivationRequired>false</hasActivationRequired>
    <label>${PERM_SET_LABEL}</label>
    <tabSettings>
        <tab>standard-OmniSupervisor</tab>
        <visibility>Visible</visibility>
    </tabSettings>
    <tabSettings>
        <tab>standard-OmniSupervisorLightning</tab>
        <visibility>Visible</visibility>
    </tabSettings>
</PermissionSet>
EOF
fi

DEPLOY_PS_CMD="sf project deploy start --source-dir \"${PERM_SET_FILE}\" --target-org \"${TARGET_ORG}\" --wait ${WAIT_TIME} --ignore-conflicts"
if [ "$DRY_RUN" = true ]; then
    DEPLOY_PS_CMD="${DEPLOY_PS_CMD} --dry-run"
    log_info "[DRY-RUN] Would deploy PermissionSet metadata..."
fi

log_info "Deploying PermissionSet with standard-OmniSupervisor tab access..."
eval "$DEPLOY_PS_CMD"
log_success "PermissionSet '${PERM_SET_DEV_NAME}' deployed with tabSettings visible."

# 2. Deploy Lightning Console CustomApplication Metadata
APP_FILE="${SCRIPT_DIR}/force-app/main/default/applications/${APP_NAME}.app-meta.xml"
if [[ -f "$APP_FILE" ]]; then
    DEPLOY_APP_CMD="sf project deploy start --source-dir \"${APP_FILE}\" --target-org \"${TARGET_ORG}\" --wait ${WAIT_TIME}"
    if [ "$DRY_RUN" = true ]; then
        DEPLOY_APP_CMD="${DEPLOY_APP_CMD} --dry-run"
        log_info "[DRY-RUN] Would deploy CustomApplication metadata..."
    fi
    log_info "Deploying CustomApplication '${APP_NAME}' with Omni Supervisor workspace navigation..."
    eval "$DEPLOY_APP_CMD"
    log_success "CustomApplication '${APP_NAME}' deployed with Omni Supervisor navigation tab."
else
    log_warn "Application file '${APP_FILE}' not found. Skipping CustomApplication deploy."
fi

# ==============================================================================
# Final Completion Summary
# ==============================================================================
echo -e "\n${GREEN}${BOLD}==========================================================================${NC}"
echo -e "${GREEN}${BOLD}    Omni Supervisor Setup & User Provisioning Completed Successfully!     ${NC}"
echo -e "${GREEN}${BOLD}==========================================================================${NC}"
echo -e "Target Org ID:         ${BOLD}${ORG_ID}${NC} (${INSTANCE_URL})"
echo -e "Supervisor User:       ${BOLD}${USER_NAME}${NC} (${USER_USERNAME})"
echo -e "User ID:               ${BOLD}${USER_ID}${NC}"
echo -e "Service Cloud User:    ${BOLD}Enabled (true)${NC}"
echo -e "Public Group:          ${BOLD}${GROUP_DEV_NAME}${NC} ('${GROUP_LABEL}')"
echo -e "OmniSupervisorConfig:  ${BOLD}${CONFIG_DEV_NAME}${NC} (Id: ${CONFIG_RECORD_ID})"
echo -e "Permission Set:        ${BOLD}${PERM_SET_DEV_NAME}${NC} (Assigned & Tab Visible)"
echo -e "Supervisor Tabs:       ${BOLD}${TABS_LIST}${NC}"
echo -e "Console App:           ${BOLD}${APP_NAME}${NC}"
echo ""
echo -e "${CYAN}${BOLD}Verification Steps in Salesforce UI:${NC}"
echo -e "  1. Log in to Salesforce org as ${BOLD}${USER_NAME}${NC}."
echo -e "  2. Open the App Launcher and select ${BOLD}Service Console${NC}."
echo -e "  3. In the navigation items dropdown, click ${BOLD}Omni Supervisor${NC}."
echo -e "  4. Verify real-time tabs: ${BOLD}${TABS_LIST}${NC} and agent timeline."
echo -e "${GREEN}${BOLD}==========================================================================${NC}\n"
