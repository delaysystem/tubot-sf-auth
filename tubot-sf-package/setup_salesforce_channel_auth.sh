#!/usr/bin/env bash

# ==============================================================================
# [DEPRECATED] Automated Salesforce Channel Auth (ECA) Setup CLI
# ==============================================================================
# NOTE: This shell script is DEPRECATED in favor of fully automated in-package
# provisioning via Salesforce Metadata API and Tooling API directly on package
# install/upgrade (see PackagePostInstallHandler & TubotAuthAutoSetupService).
#
# This script is retained solely for backward compatibility, manual CLI overrides,
# diagnostics, and standalone zero-mock verification (--verify-only).
#
# Prefer using Apex automated setup:
#   TubotAuthAutoSetupService.autoSetupAuth(channelId, integrationUserId)
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default configurations
TARGET_ORG="test1empty"
CHANNEL_NAME="WebChat"
TARGET_USER="default"
APP_NAME="Tubot_SF_Channel_API"
CONTACT_EMAIL=""
DRY_RUN=false
VERIFY_ONLY=false
WAIT_TIME=10

# Color formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_phase() { echo -e "\n${CYAN}${BOLD}===> $1${NC}"; }

show_help() {
    cat << EOF
Automated End-to-End Salesforce Channel Auth Setup CLI

Usage:
  ./setup_salesforce_channel_auth.sh [options]

Options:
  -o, --target-org ALIAS       Target Salesforce org alias or username (default: test1empty)
  -c, --channel NAME_OR_ID     MessagingChannel DeveloperName or Salesforce ID (default: WebChat)
  -u, --user IDENTIFIER        Integration User (username, email, 18-char ID, or 'default')
  -a, --app-name NAME          External Client App API Name (default: Tubot_SF_Channel_API)
  -e, --email EMAIL            Contact email for ECA (default: target user email)
  --verify-only                Skip deployment and execute real environment verification suite
  --dry-run                    Validate metadata deployment without writing changes to org
  -h, --help                   Display this help message

Examples:
  ./setup_salesforce_channel_auth.sh --target-org test1empty --channel WebChat --user default
  ./setup_salesforce_channel_auth.sh -o test1empty --verify-only
EOF
}

# Parse Command Line Arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--target-org)
            TARGET_ORG="$2"
            shift 2
            ;;
        -c|--channel)
            CHANNEL_NAME="$2"
            shift 2
            ;;
        -u|--user)
            TARGET_USER="$2"
            shift 2
            ;;
        -a|--app-name)
            APP_NAME="$2"
            shift 2
            ;;
        -e|--email)
            CONTACT_EMAIL="$2"
            shift 2
            ;;
        --verify-only)
            VERIFY_ONLY=true
            shift
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
            log_error "Unknown argument: $1"
            show_help
            exit 1
            ;;
    esac
done

# Deprecation Warning
echo -e "${YELLOW}${BOLD}[DEPRECATED] setup_salesforce_channel_auth.sh is DEPRECATED.${NC}"
echo -e "${YELLOW}Auth setup is now automated natively via Metadata API & Tooling API on package install.${NC}"
echo -e "${YELLOW}Apex entry point: TubotAuthAutoSetupService.autoSetupAuth()${NC}\n"

# Ensure Salesforce CLI is installed
if ! command -v sf &> /dev/null; then
    log_error "Salesforce CLI ('sf') is not installed or not in PATH."
    exit 1
fi

# Ensure Bun or Node is installed
RUNNER=""
if command -v bun &> /dev/null; then
    RUNNER="bun"
elif command -v node &> /dev/null; then
    RUNNER="node"
else
    log_error "Neither Bun nor Node.js is installed or in PATH."
    exit 1
fi

log_phase "Phase 1: Environment & Org Validation"
log_info "Connecting to target org: ${TARGET_ORG}..."

ORG_DISPLAY_JSON=$(sf org display --target-org "${TARGET_ORG}" --json)
STATUS=$(echo "${ORG_DISPLAY_JSON}" | jq -r '.status')
if [[ "${STATUS}" != "0" ]]; then
    log_error "Could not authenticate with org '${TARGET_ORG}'."
    exit 1
fi

INSTANCE_URL=$(echo "${ORG_DISPLAY_JSON}" | jq -r '.result.instanceUrl')
ORG_ID=$(echo "${ORG_DISPLAY_JSON}" | jq -r '.result.id')
CONNECTED_USERNAME=$(echo "${ORG_DISPLAY_JSON}" | jq -r '.result.username')

log_success "Authenticated to ${TARGET_ORG} (${ORG_ID}) at ${INSTANCE_URL}"

# Check Panel connection status
log_info "Checking Panel connection status in target org..."
PANEL_CHECK_APEX="
PanelAuthController.AuthStatusDTO status = PanelAuthController.getPanelAuthStatus();
System.debug('PANEL_RESULT:CONNECTED=' + status.isConnected + ';TEAM_ID=' + status.teamId);
"
PANEL_STATUS_OUTPUT=$(sf apex run --target-org "${TARGET_ORG}" <<< "${PANEL_CHECK_APEX}")
PANEL_CONNECTED=$(echo "${PANEL_STATUS_OUTPUT}" | grep 'USER_DEBUG' | grep 'PANEL_RESULT:' | sed -E 's/.*CONNECTED=([^;]+);.*/\1/' | head -n 1)
TEAM_ID=$(echo "${PANEL_STATUS_OUTPUT}" | grep 'USER_DEBUG' | grep 'PANEL_RESULT:' | sed -E 's/.*TEAM_ID=([^;]+).*/\1/' | head -n 1)

if [[ "${PANEL_CONNECTED}" != "true" ]]; then
    log_warn "Panel is not connected in this org. Connect Panel via Panel Settings before connecting channels."
else
    log_success "Panel connected for team: ${TEAM_ID}"
fi

# Resolve Integration User
log_info "Resolving integration user: ${TARGET_USER}..."
if [[ "${TARGET_USER}" == "default" ]]; then
    USER_QUERY="SELECT Id, Username, Email FROM User WHERE Username = '${CONNECTED_USERNAME}' LIMIT 1"
elif [[ "${TARGET_USER}" =~ ^[a-zA-Z0-9]{15,18}$ ]]; then
    USER_QUERY="SELECT Id, Username, Email FROM User WHERE Id = '${TARGET_USER}' AND IsActive = true LIMIT 1"
else
    USER_QUERY="SELECT Id, Username, Email FROM User WHERE (Username = '${TARGET_USER}' OR Email = '${TARGET_USER}' OR Name = '${TARGET_USER}') AND IsActive = true LIMIT 1"
fi

USER_RES=$(sf data query --query "${USER_QUERY}" --target-org "${TARGET_ORG}" --json)
USER_ID=$(echo "${USER_RES}" | jq -r '.result.records[0].Id // empty')
USER_USERNAME=$(echo "${USER_RES}" | jq -r '.result.records[0].Username // empty')
USER_EMAIL=$(echo "${USER_RES}" | jq -r '.result.records[0].Email // empty')

if [[ -z "${USER_ID}" ]]; then
    log_error "Could not resolve active integration user for '${TARGET_USER}' in org '${TARGET_ORG}'."
    exit 1
fi

if [[ -z "${CONTACT_EMAIL}" ]]; then
    CONTACT_EMAIL="${USER_EMAIL}"
fi

log_success "Resolved integration user: ${USER_USERNAME} (Id: ${USER_ID}, Email: ${CONTACT_EMAIL})"

# Resolve Messaging Channel
log_info "Resolving Messaging Channel: ${CHANNEL_NAME}..."
if [[ "${CHANNEL_NAME}" =~ ^[a-zA-Z0-9]{15,18}$ ]]; then
    CHANNEL_QUERY="SELECT Id, DeveloperName, MessageType FROM MessagingChannel WHERE Id = '${CHANNEL_NAME}' LIMIT 1"
else
    CHANNEL_QUERY="SELECT Id, DeveloperName, MessageType FROM MessagingChannel WHERE DeveloperName = '${CHANNEL_NAME}' LIMIT 1"
fi
CHANNEL_RES=$(sf data query --query "${CHANNEL_QUERY}" --target-org "${TARGET_ORG}" --json)
CHANNEL_ID=$(echo "${CHANNEL_RES}" | jq -r '.result.records[0].Id // empty')
RESOLVED_CHANNEL_NAME=$(echo "${CHANNEL_RES}" | jq -r '.result.records[0].DeveloperName // empty')

if [[ -z "${CHANNEL_ID}" ]]; then
    log_error "Messaging Channel '${CHANNEL_NAME}' not found in org '${TARGET_ORG}'."
    exit 1
fi
log_success "Resolved Messaging Channel: ${RESOLVED_CHANNEL_NAME} (Id: ${CHANNEL_ID})"

if [[ "${VERIFY_ONLY}" == "true" ]]; then
    log_phase "Verification Suite Only Mode Requested"
    log_info "Fetching existing ECA credentials for verification..."
    ${RUNNER} -e "
    import('./scripts/setup-salesforce-eca.mjs').then(async (m) => {
        const creds = await m.fetchCredentials('${TARGET_ORG}', '${APP_NAME}');
        await m.verifyConnection('${TARGET_ORG}', creds.clientId, creds.clientSecret, creds.instanceUrl, creds.orgId, '${CHANNEL_ID}');
    }).catch((e) => {
        console.error('Verification failed:', e.message);
        process.exit(1);
    });
    "
    exit 0
fi

# Run setup through orchestrator
log_phase "Phase 2 & 3 & 4 & 5: Automated ECA Generation, Credential Extraction, & Channel Registration"
EXTRA_ARGS=()
if [[ "${DRY_RUN}" == "true" ]]; then
    EXTRA_ARGS+=("--dry-run")
else
    EXTRA_ARGS+=("--connect" "--verify")
fi

${RUNNER} "${SCRIPT_DIR}/scripts/setup-salesforce-eca.mjs" \
    --target-org "${TARGET_ORG}" \
    --integration-user "${USER_USERNAME}" \
    --contact-email "${CONTACT_EMAIL}" \
    --app-name "${APP_NAME}" \
    --channel-id "${CHANNEL_ID}" \
    "${EXTRA_ARGS[@]}"

log_phase "Phase 6: Final Verification with Salesforce CLI (Real Environment, Zero Mocks)"

log_info "1. Verifying tubot__Tubot_API_Channel__c record in Salesforce via SOQL..."
CHANNEL_RECORD_QUERY="SELECT Id, tubot__Channel_Id__c, tubot__Integration_User_Id__c, tubot__Team_Id__c FROM tubot__Tubot_API_Channel__c WHERE tubot__Channel_Id__c = '${CHANNEL_ID}' LIMIT 1"
CHANNEL_RECORD_JSON=$(sf data query --query "${CHANNEL_RECORD_QUERY}" --target-org "${TARGET_ORG}" --json)
RECORD_COUNT=$(echo "${CHANNEL_RECORD_JSON}" | jq -r '.result.totalSize // 0')

if [[ "${RECORD_COUNT}" -gt 0 ]]; then
    RECORD_ID=$(echo "${CHANNEL_RECORD_JSON}" | jq -r '.result.records[0].Id')
    log_success "Verified Salesforce custom object record: tubot__Tubot_API_Channel__c [${RECORD_ID}] exists!"
else
    log_error "tubot__Tubot_API_Channel__c record not found for channel ${CHANNEL_ID} in org ${TARGET_ORG}."
    exit 1
fi

log_info "2. Verifying live data proxy query through channel..."
PROXY_QUERY_APEX="
Map<String, Object> req = new Map<String, Object>{
    'orgId' => UserInfo.getOrganizationId(),
    'soql' => 'SELECT Id, Name FROM User WHERE IsActive = true LIMIT 1'
};
HttpResponse res = PanelAuthController.executePanelCallout(
    '/api/v1/salesforce/channels/${CHANNEL_ID}/query',
    'POST',
    JSON.serialize(req),
    null,
    null
);
System.debug('PROXY_VERIFICATION_STATUS=' + res.getStatusCode());
System.debug('PROXY_VERIFICATION_BODY=' + res.getBody());
"
PROXY_RESULT=$(sf apex run --target-org "${TARGET_ORG}" <<< "${PROXY_QUERY_APEX}")
PROXY_STATUS=$(echo "${PROXY_RESULT}" | grep 'USER_DEBUG' | grep -o 'PROXY_VERIFICATION_STATUS=[0-9]\+' | cut -d'=' -f2 | head -n 1)

if [[ "${PROXY_STATUS}" == "200" ]]; then
    log_success "Channel proxy query successfully returned real records from Salesforce org (HTTP 200)!"
else
    log_error "Proxy query returned status ${PROXY_STATUS}. Output: ${PROXY_RESULT}"
    exit 1
fi

log_phase "Summary & Confirmation"
cat << EOF
${GREEN}${BOLD}==============================================================================
         AUTOMATED SALESFORCE CHANNEL AUTH SETUP COMPLETED SUCCESSFULLY!
==============================================================================${NC}
Target Org:            ${TARGET_ORG} (${ORG_ID})
Instance URL:          ${INSTANCE_URL}
Messaging Channel:     ${RESOLVED_CHANNEL_NAME} (${CHANNEL_ID})
Integration User:      ${USER_USERNAME} (${USER_ID})
External Client App:   ${APP_NAME}
OAuth Scopes:          Api, OpenID (Client Credentials Flow enabled)
Permissions:           Tubot_Salesforce_API_Read assigned
Channel Connection:    Active in Panel & registered in D1 database
Verification:          Real environment verified (OAuth + Identity + SOQL Proxy)
==============================================================================
EOF
