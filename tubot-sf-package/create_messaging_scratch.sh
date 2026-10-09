#!/usr/bin/env bash
# ==============================================================================
# create_messaging_scratch.sh
#
# One-command scratch org for Messaging (MIAW) + Omni-Channel development:
#   Step 1: Create scratch org with Omni-Channel + Messaging enabled
#   Step 2: Deploy a simple MessagingSession queue + routing config, add user
#   Step 3: Stage archived omni/messaging metadata + real setup classes (temp)
#   Step 4: Deploy class closure + minimal admin permset, assign to user
#   Step 5: Activate Omni Supervisor (setup_omni_supervisor.sh)
#   Step 6: Add flow/queue/skill/route/messagingsession metadata
#           (setup_messaging_omnichannel.sh)
#   Step 7: Blind-verify everything in the target org, restore tree, summary
#
# Steps 3-6 reuse the archived pre-AppExchange metadata and the two setup
# scripts. All staging is fully reverted on exit (success or failure), so the
# working tree is left exactly as it was and the package source (force-app)
# is never polluted by dev-only metadata.
#
# Usage:
#   ./create_messaging_scratch.sh [OPTIONS]
#
# Options:
#   -d, --dev-hub ALIAS       Dev Hub alias (default: test2)
#   -a, --alias ALIAS         Alias for the new scratch org (default: tubot-msg-scratch)
#   -o, --use-existing-org ALIAS
#                             Provision an existing org instead of creating a
#                             scratch org (skips Step 1; for dev orgs or re-runs)
#   -e, --duration DAYS       Scratch org duration in days 1-30 (default: 7)
#   -u, --user IDENTIFIER     Queue member / agent / supervisor (Name, Username,
#                             Email, Id, or 'default' for the scratch admin)
#   -q, --queue NAME          Simple queue DeveloperName (default: Scratch_Msg_Queue)
#   --queue-label LABEL       Simple queue label (default: Scratch Msg Queue)
#   -r, --routing-config NAME Simple routing config DeveloperName
#                             (default: Scratch_Msg_Routing_Config)
#   --skip-queue              Skip the simple queue step
#   --skip-supervisor         Skip Omni Supervisor activation
#   --skip-messaging          Skip the flow/queue/skill/route metadata script
#   --enable-header-custom    Set headerCustom on Web deployments
#   --configure-channels NAMES
#                             Reconfigure selected messaging channels after setup
#   --skip-channel-config     Skip optional Phase 6 channel configuration
#   --keep-staged             Debug: do not restore the working tree on exit
#   -w, --wait MINUTES        Wait timeout in minutes (default: 15)
#   -h, --help                Show this help message
# ==============================================================================

set -eo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
    SCRIPT_PARENT="$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    [[ "$SCRIPT_PATH" == /* ]] || SCRIPT_PATH="${SCRIPT_PARENT}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
SCRIPT_FILE="${SCRIPT_DIR}/$(basename -- "$SCRIPT_PATH")"
cd "${SCRIPT_DIR}"

ARCHIVE_DIR="archive/pre-appexchange-cleanup"
FORCE_APP="force-app/main/default"

# ────────────────────────── Colors & Logging ──────────────────────────
CLR_RESET='\033[0m'
CLR_BOLD='\033[1m'
CLR_BLUE='\033[1;34m'
CLR_GREEN='\033[1;32m'
CLR_YELLOW='\033[1;33m'
CLR_RED='\033[1;31m'
CLR_CYAN='\033[1;36m'

log_info()    { echo -e "${CLR_BLUE}[INFO]${CLR_RESET} $1"; }
log_success() { echo -e "${CLR_GREEN}[SUCCESS]${CLR_RESET} $1"; }
log_warn()    { echo -e "${CLR_YELLOW}[WARN]${CLR_RESET} $1"; }
log_error()   { echo -e "${CLR_RED}[ERROR]${CLR_RESET} $1"; }
log_section() {
    echo -e "\n${CLR_BOLD}${CLR_CYAN}========================================================================${CLR_RESET}"
    echo -e "${CLR_BOLD}${CLR_CYAN}  $1${CLR_RESET}"
    echo -e "${CLR_BOLD}${CLR_CYAN}========================================================================${CLR_RESET}\n"
}

extract_json() { sed -n '/^[{\[]/,$p'; }

# ────────────────────────── Defaults ──────────────────────────
DEV_HUB="test2"
SCRATCH_ALIAS="tubot-msg-scratch"
USE_EXISTING_ORG=""
DURATION_DAYS=7
TARGET_USER="default"
QUEUE_DEV_NAME="Scratch_Msg_Queue"
QUEUE_LABEL="Scratch Msg Queue"
ROUTING_CONFIG_NAME="Scratch_Msg_Routing_Config"
ROUTING_CONFIG_LABEL="Scratch Msg Routing Config"
SKIP_QUEUE=false
SKIP_SUPERVISOR=false
SKIP_MESSAGING=false
ENABLE_HEADER_CUSTOM=false
CONFIGURE_CHANNELS=""
SKIP_CHANNEL_CONFIG=false
KEEP_STAGED=false
WAIT_TIME=15
SCRATCH_DEF="config/project-scratch-def-messaging.json"

usage() {
    sed -n '2,48p' "${SCRIPT_FILE}" | sed 's/^# \{0,1\}//'
    exit 0
}

# ────────────────────────── Parse Arguments ──────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dev-hub)       DEV_HUB="$2"; shift 2 ;;
        -a|--alias)         SCRATCH_ALIAS="$2"; shift 2 ;;
        -o|--use-existing-org) USE_EXISTING_ORG="$2"; shift 2 ;;
        -e|--duration)      DURATION_DAYS="$2"; shift 2 ;;
        -u|--user)          TARGET_USER="$2"; shift 2 ;;
        -q|--queue)         QUEUE_DEV_NAME="$2"; shift 2 ;;
        --queue-label)      QUEUE_LABEL="$2"; shift 2 ;;
        -r|--routing-config) ROUTING_CONFIG_NAME="$2"; shift 2 ;;
        --skip-queue)       SKIP_QUEUE=true; shift ;;
        --skip-supervisor)  SKIP_SUPERVISOR=true; shift ;;
        --skip-messaging)   SKIP_MESSAGING=true; shift ;;
        --enable-header-custom) ENABLE_HEADER_CUSTOM=true; shift ;;
        --configure-channels) CONFIGURE_CHANNELS="$2"; shift 2 ;;
        --skip-channel-config) SKIP_CHANNEL_CONFIG=true; shift ;;
        --keep-staged)      KEEP_STAGED=true; shift ;;
        -w|--wait)          WAIT_TIME="$2"; shift 2 ;;
        -h|--help)          usage ;;
        *)                  log_error "Unknown option: $1"; usage ;;
    esac
done

# ────────────────────────── Staging tracker (reverted on exit) ──────────────────────────
STAGE_BACKUP="$(mktemp -d -t msg-scratch-backup-XXXXXX)"
QUEUE_TMP=""
STAGED_NEW=()
STAGED_OVERWRITE=()
HAD_OMNI_SETTINGS=false
HAD_SUP_PERMSET=false
MSG_SCRIPT_MODE=""

stage() {
    local src="$1" dst="$2"
    if [ ! -f "${src}" ]; then
        log_error "Staging source missing: ${src}"
        exit 1
    fi
    mkdir -p "$(dirname "${dst}")"
    if [ -f "${dst}" ]; then
        cp "${dst}" "${STAGE_BACKUP}/$(echo "${dst}" | tr '/' '_')"
        STAGED_OVERWRITE+=("${dst}")
    else
        STAGED_NEW+=("${dst}")
    fi
    cp "${src}" "${dst}"
}

cleanup_staging() {
    local code=$?
    if [ "${KEEP_STAGED}" = true ]; then
        log_warn "Keeping staged files in place (--keep-staged). Backup dir: ${STAGE_BACKUP}"
        return 0
    fi
    # Restore overwritten files
    for dst in ${STAGED_OVERWRITE[@]+"${STAGED_OVERWRITE[@]}"}; do
        cp "${STAGE_BACKUP}/$(echo "${dst}" | tr '/' '_')" "${dst}" 2>/dev/null || true
    done
    # Remove newly staged files
    for dst in ${STAGED_NEW[@]+"${STAGED_NEW[@]}"}; do
        rm -f "${dst}" 2>/dev/null || true
    done
    # Remove side-effect files created by the sub-scripts (only if new)
    if [ "${HAD_OMNI_SETTINGS}" = false ]; then
        rm -f "${FORCE_APP}/settings/OmniChannel.settings-meta.xml" 2>/dev/null || true
    fi
    if [ "${HAD_SUP_PERMSET}" = false ]; then
        rm -f "${FORCE_APP}/permissionsets/Omni_Supervisor_Access.permissionset-meta.xml" 2>/dev/null || true
    fi
    rm -f "${FORCE_APP}/permissionsets/Scratch_Tubot_Admin_Access.permissionset-meta.xml" 2>/dev/null || true
    # Restore tracked files mutated by the sub-scripts
    if [ -f "${STAGE_BACKUP}/test_embedded_chat.html" ]; then
        cp "${STAGE_BACKUP}/test_embedded_chat.html" "test_embedded_chat.html" 2>/dev/null || true
    fi
    if [ -n "${MSG_SCRIPT_MODE}" ]; then
        chmod "${MSG_SCRIPT_MODE}" "setup_messaging_omnichannel.sh" 2>/dev/null || true
    fi
    # Drop dirs left empty by staging
    for d in skills flows queues queueRoutingConfigs servicePresenceStatuses \
             presenceUserConfigs messagingChannels EmbeddedServiceConfig \
             applications flexipages; do
        rmdir "${FORCE_APP}/${d}" 2>/dev/null || true
    done
    [ -n "${QUEUE_TMP}" ] && rm -rf "${QUEUE_TMP}" 2>/dev/null || true
    rm -rf "${STAGE_BACKUP}" 2>/dev/null || true
    return ${code}
}
trap cleanup_staging EXIT

# ────────────────────────── Pre-flight ──────────────────────────
log_section "TuBot Messaging Scratch Org"
log_info "Dev Hub         : ${DEV_HUB}"
log_info "Scratch Alias   : ${SCRATCH_ALIAS}"
log_info "Duration        : ${DURATION_DAYS} days"
log_info "User            : ${TARGET_USER}"
log_info "Simple Queue    : ${QUEUE_DEV_NAME} (${QUEUE_LABEL})"
log_info "Routing Config  : ${ROUTING_CONFIG_NAME}"
log_info "Skip Queue      : ${SKIP_QUEUE}"
log_info "Skip Supervisor : ${SKIP_SUPERVISOR}"
log_info "Skip Messaging  : ${SKIP_MESSAGING}"
[ -n "${USE_EXISTING_ORG}" ] && log_info "Existing Org    : ${USE_EXISTING_ORG} (Step 1 create skipped)"

if ! command -v sf &> /dev/null; then
    log_error "Salesforce CLI ('sf') is not installed or not in PATH."
    exit 1
fi
if ! command -v jq &> /dev/null; then
    log_error "'jq' is required but not installed."
    exit 1
fi
if [ ! -f "${SCRATCH_DEF}" ]; then
    log_error "Scratch org definition not found: ${SCRATCH_DEF}"
    exit 1
fi
for req in "setup_omni_supervisor.sh" "setup_messaging_omnichannel.sh" "${ARCHIVE_DIR}"; do
    if [ ! -e "${req}" ]; then
        log_error "Required ${req} not found next to this script."
        exit 1
    fi
done

if [ -n "${USE_EXISTING_ORG}" ]; then
    SCRATCH_ALIAS="${USE_EXISTING_ORG}"
    log_info "Verifying connection to existing org: ${SCRATCH_ALIAS}..."
    EXISTING_INFO=$(sf org display --target-org "${SCRATCH_ALIAS}" --json 2>/dev/null | extract_json || true)
    if [ "$(echo "${EXISTING_INFO}" | jq -r '.status // 1')" != "0" ]; then
        log_error "Could not connect to org '${SCRATCH_ALIAS}'."
        exit 1
    fi
else
    log_info "Verifying connection to Dev Hub: ${DEV_HUB}..."
    DEVHUB_INFO=$(sf org display --target-org "${DEV_HUB}" --json 2>/dev/null | extract_json || true)
    if [ "$(echo "${DEVHUB_INFO}" | jq -r '.status // 1')" != "0" ]; then
        log_error "Could not connect to Dev Hub '${DEV_HUB}'. Run 'sf org login web -a ${DEV_HUB}' first."
        exit 1
    fi
    log_success "Dev Hub Connected: $(echo "${DEVHUB_INFO}" | jq -r '.result.username')"
fi

# ────────────────────────── Step 1: Create Scratch Org ──────────────────────────
if [ -n "${USE_EXISTING_ORG}" ]; then
    log_section "Step 1: Using Existing Org (--use-existing-org)"
    log_info "Skipping scratch org creation (dev-hub/duration flags ignored)."
    SCRATCH_USERNAME=$(echo "${EXISTING_INFO}" | jq -r '.result.username // empty')
    SCRATCH_ORG_ID=$(echo "${EXISTING_INFO}" | jq -r '.result.id // empty')
    SCRATCH_LOGIN_URL=$(echo "${EXISTING_INFO}" | jq -r '.result.instanceUrl // empty')
    log_success "Target Org: ${SCRATCH_ALIAS}"
    log_info "Username    : ${SCRATCH_USERNAME}"
    log_info "Org ID      : ${SCRATCH_ORG_ID}"
    log_info "Instance    : ${SCRATCH_LOGIN_URL}"
else
    log_section "Step 1: Creating Scratch Org (Omni-Channel + Messaging)"
    log_info "Definition file: ${SCRATCH_DEF}"

    CREATE_OUTPUT=$(sf org create scratch \
        --target-dev-hub "${DEV_HUB}" \
        --definition-file "${SCRATCH_DEF}" \
        --alias "${SCRATCH_ALIAS}" \
        --duration-days "${DURATION_DAYS}" \
        --wait "${WAIT_TIME}" \
        --set-default \
        --json 2>/dev/null | extract_json || true)

    if [ "$(echo "${CREATE_OUTPUT}" | jq -r '.status // 1')" != "0" ]; then
        log_error "Failed to create scratch org. CLI Output:"
        echo "${CREATE_OUTPUT}" | jq . 2>/dev/null || echo "${CREATE_OUTPUT}"
        exit 1
    fi

    SCRATCH_USERNAME=$(echo "${CREATE_OUTPUT}" | jq -r '.result.username // empty')
    SCRATCH_ORG_ID=$(echo "${CREATE_OUTPUT}" | jq -r '.result.orgId // empty')
    SCRATCH_LOGIN_URL=$(echo "${CREATE_OUTPUT}" | jq -r '.result.instanceUrl // empty')
    log_success "Scratch Org Created Successfully!"
    log_info "Username    : ${SCRATCH_USERNAME}"
    log_info "Org ID      : ${SCRATCH_ORG_ID}"
    log_info "Instance    : ${SCRATCH_LOGIN_URL}"
fi

# ────────────────────────── Resolve Target User ──────────────────────────
if [[ "${TARGET_USER}" == "default" || "${TARGET_USER}" == "current" ]]; then
    RESOLVED_USER="${SCRATCH_USERNAME}"
else
    RESOLVED_USER="${TARGET_USER}"
fi
USER_ID=""; USER_NAME=""; USER_USERNAME=""
for attempt in 1 2 3 4 5 6; do
    USER_RES=$(sf data query \
        -q "SELECT Id, Name, Username, Email FROM User WHERE (Name = '${RESOLVED_USER}' OR Username = '${RESOLVED_USER}' OR Email = '${RESOLVED_USER}') AND IsActive = true ORDER BY LastLoginDate DESC NULLS LAST LIMIT 1" \
        --target-org "${SCRATCH_ALIAS}" --json 2>/dev/null | extract_json || true)
    USER_ID=$(echo "${USER_RES}" | jq -r '.result.records[0].Id // empty')
    USER_NAME=$(echo "${USER_RES}" | jq -r '.result.records[0].Name // empty')
    USER_USERNAME=$(echo "${USER_RES}" | jq -r '.result.records[0].Username // empty')
    if [ -n "${USER_ID}" ]; then
        break
    fi
    if [[ "${RESOLVED_USER}" =~ ^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$ ]]; then
        USER_RES=$(sf data query \
            -q "SELECT Id, Name, Username, Email FROM User WHERE Id = '${RESOLVED_USER}' AND IsActive = true LIMIT 1" \
            --target-org "${SCRATCH_ALIAS}" --json 2>/dev/null | extract_json || true)
        USER_ID=$(echo "${USER_RES}" | jq -r '.result.records[0].Id // empty')
        USER_NAME=$(echo "${USER_RES}" | jq -r '.result.records[0].Name // empty')
        USER_USERNAME=$(echo "${USER_RES}" | jq -r '.result.records[0].Username // empty')
        if [ -n "${USER_ID}" ]; then
            break
        fi
    fi
    if [ "${attempt}" -lt 6 ]; then
        log_info "User lookup retry ${attempt}/6 in 15s (fresh scratch orgs need a moment)..."
        sleep 15
    fi
done
if [ -z "${USER_ID}" ]; then
    log_error "Could not resolve active user '${TARGET_USER}' in scratch org '${SCRATCH_ALIAS}'."
    exit 1
fi
log_success "Target User: ${USER_NAME} (${USER_USERNAME}, Id: ${USER_ID})"

# ────────────────────────── Step 2: Simple MessagingSession Queue ──────────────────────────
if [ "${SKIP_QUEUE}" = true ]; then
    log_section "Step 2: Skipped (--skip-queue)"
else
    log_section "Step 2: Simple MessagingSession Queue + User Membership"
    QUEUE_TMP=$(mktemp -d -t sf-msgqueue-XXXXXX)
    mkdir -p "${QUEUE_TMP}/force-app/main/default/queueRoutingConfigs" \
             "${QUEUE_TMP}/force-app/main/default/queues"
    cat << EOF > "${QUEUE_TMP}/sfdx-project.json"
{
  "packageDirectories": [{ "path": "force-app", "default": true }],
  "name": "scratch-msg-queue",
  "namespace": "",
  "sfdcLoginUrl": "https://login.salesforce.com",
  "sourceApiVersion": "67.0"
}
EOF
    cat << EOF > "${QUEUE_TMP}/force-app/main/default/queueRoutingConfigs/${ROUTING_CONFIG_NAME}.queueRoutingConfig-meta.xml"
<?xml version="1.0" encoding="UTF-8"?>
<QueueRoutingConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <capacityWeight>1.0</capacityWeight>
    <isAttributeBased>false</isAttributeBased>
    <label>${ROUTING_CONFIG_LABEL}</label>
    <pushTimeout>20</pushTimeout>
    <routingModel>LEAST_ACTIVE</routingModel>
    <routingPriority>1</routingPriority>
</QueueRoutingConfig>
EOF
    cat << EOF > "${QUEUE_TMP}/force-app/main/default/queues/${QUEUE_DEV_NAME}.queue-meta.xml"
<?xml version="1.0" encoding="UTF-8"?>
<Queue xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesIncludeBosses>false</doesIncludeBosses>
    <doesSendEmailToMembers>false</doesSendEmailToMembers>
    <name>${QUEUE_LABEL}</name>
    <queueRoutingConfig>${ROUTING_CONFIG_NAME}</queueRoutingConfig>
    <queueSobject>
        <sobjectType>MessagingSession</sobjectType>
    </queueSobject>
</Queue>
EOF
    log_info "Deploying routing config + queue..."
    QUEUE_DEPLOY=$(cd "${QUEUE_TMP}" && sf project deploy start \
        --target-org "${SCRATCH_ALIAS}" --source-dir force-app \
        --wait "${WAIT_TIME}" --ignore-conflicts --json 2>/dev/null | extract_json || true)
    if [ "$(echo "${QUEUE_DEPLOY}" | jq -r '.status // 1')" != "0" ]; then
        log_error "Queue metadata deploy failed:"
        echo "${QUEUE_DEPLOY}" | jq -r '.result.details.componentFailures[]? | "\(.componentType) \(.fullName): \(.problem)"' 2>/dev/null \
            || echo "${QUEUE_DEPLOY}" | jq -c '{status, message}' 2>/dev/null || echo "${QUEUE_DEPLOY}"
        exit 1
    fi
    log_success "Queue metadata deployed."

    QUEUE_RES=$(sf data query -q "SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = '${QUEUE_DEV_NAME}' LIMIT 1" \
        --target-org "${SCRATCH_ALIAS}" --json 2>/dev/null | extract_json || true)
    SIMPLE_QUEUE_ID=$(echo "${QUEUE_RES}" | jq -r '.result.records[0].Id // empty')
    if [ -z "${SIMPLE_QUEUE_ID}" ]; then
        log_error "Queue '${QUEUE_DEV_NAME}' not found after deploy."
        exit 1
    fi
    MEM_RES=$(sf data query -q "SELECT Id FROM GroupMember WHERE GroupId = '${SIMPLE_QUEUE_ID}' AND UserOrGroupId = '${USER_ID}' LIMIT 1" \
        --target-org "${SCRATCH_ALIAS}" --json 2>/dev/null | extract_json || true)
    SIMPLE_MEMBER_ID=$(echo "${MEM_RES}" | jq -r '.result.records[0].Id // empty')
    if [ -z "${SIMPLE_MEMBER_ID}" ]; then
        ADD_RES=$(sf data create record --sobject GroupMember \
            --values "GroupId='${SIMPLE_QUEUE_ID}' UserOrGroupId='${USER_ID}'" \
            --target-org "${SCRATCH_ALIAS}" --json 2>/dev/null | extract_json || true)
        SIMPLE_MEMBER_ID=$(echo "${ADD_RES}" | jq -r '.result.id // empty')
        if [ -z "${SIMPLE_MEMBER_ID}" ]; then
            log_error "Failed to add user to queue: $(echo "${ADD_RES}" | jq -r '.message // "unknown error"')"
            exit 1
        fi
    fi
    log_success "User '${USER_NAME}' is in queue '${QUEUE_DEV_NAME}' (GroupMember: ${SIMPLE_MEMBER_ID})"
fi

# ────────────────────────── Step 3: Stage Archived Metadata (temp) ──────────────────────────
NEED_STAGING=true
if [ "${SKIP_SUPERVISOR}" = true ] && [ "${SKIP_MESSAGING}" = true ]; then
    NEED_STAGING=false
fi

if [ "${NEED_STAGING}" = true ]; then
    log_section "Step 3: Staging Archived Omni/Messaging Metadata (temporary)"

    # Snapshot pre-existing state BEFORE staging, for side-effect files the
    # sub-scripts write (restored/removed on exit)
    [ -f "${FORCE_APP}/settings/OmniChannel.settings-meta.xml" ] && HAD_OMNI_SETTINGS=true
    [ -f "${FORCE_APP}/permissionsets/Omni_Supervisor_Access.permissionset-meta.xml" ] && HAD_SUP_PERMSET=true
    [ -f "test_embedded_chat.html" ] && cp "test_embedded_chat.html" "${STAGE_BACKUP}/test_embedded_chat.html"
    MSG_SCRIPT_MODE=$(stat -c %a "setup_messaging_omnichannel.sh" 2>/dev/null || true)

    # Omni-Channel settings with skills-based routing ON (the t2/defaultFlowTuBot
    # flows use the addSkillRequirements action, which the org rejects otherwise).
    # The supervisor script reuses this file instead of generating its default.
    if [ "${HAD_OMNI_SETTINGS}" = true ]; then
        cp "${FORCE_APP}/settings/OmniChannel.settings-meta.xml" "${STAGE_BACKUP}/force-app_main_default_settings_OmniChannel.settings-meta.xml"
        STAGED_OVERWRITE+=("${FORCE_APP}/settings/OmniChannel.settings-meta.xml")
    else
        STAGED_NEW+=("${FORCE_APP}/settings/OmniChannel.settings-meta.xml")
    fi
    cat << 'EOF' > "${FORCE_APP}/settings/OmniChannel.settings-meta.xml"
<?xml version="1.0" encoding="UTF-8"?>
<OmniChannelSettings xmlns="http://soap.sforce.com/2006/04/metadata">
    <enableOmniAutoLoginPrompt>false</enableOmniAutoLoginPrompt>
    <enableOmniChannel>true</enableOmniChannel>
    <enableOmniSecondaryRoutingPriority>false</enableOmniSecondaryRoutingPriority>
    <enableOmniSkillsRouting>true</enableOmniSkillsRouting>
    <enableOmniStatusCapModel>false</enableOmniStatusCapModel>
</OmniChannelSettings>
EOF

    # Real setup classes over the AppExchange stub versions (restored on exit)
    for cls in OmniChannelSetupService OmniChannelQueueSetupService \
               OmniChannelAgentProvisioningService TargetSalesforceUserResolver; do
        stage "${ARCHIVE_DIR}/classes/${cls}.cls" "${FORCE_APP}/classes/${cls}.cls"
        stage "${ARCHIVE_DIR}/classes/${cls}.cls-meta.xml" "${FORCE_APP}/classes/${cls}.cls-meta.xml"
    done
    stage "${ARCHIVE_DIR}/classes/OmniSupervisorSetupService.cls" "${FORCE_APP}/classes/OmniSupervisorSetupService.cls"
    stage "${ARCHIVE_DIR}/classes/OmniSupervisorSetupService.cls-meta.xml" "${FORCE_APP}/classes/OmniSupervisorSetupService.cls-meta.xml"

    # Flow / queue / skill / route / messaging metadata (un-archived names)
    stage "${ARCHIVE_DIR}/servicePresenceStatuses/Available_Messaging.servicePresenceStatus-meta.xml" \
        "${FORCE_APP}/servicePresenceStatuses/Available_Messaging.servicePresenceStatus-meta.xml"
    stage "${ARCHIVE_DIR}/queueRoutingConfigs/IGNORE_Chat_Routing_Config.queueRoutingConfig-meta.xml" \
        "${FORCE_APP}/queueRoutingConfigs/Chat_Routing_Config.queueRoutingConfig-meta.xml"
    stage "${ARCHIVE_DIR}/queueRoutingConfigs/IGNORE_Holding_Routing_Config.queueRoutingConfig-meta.xml" \
        "${FORCE_APP}/queueRoutingConfigs/Holding_Routing_Config.queueRoutingConfig-meta.xml"
    stage "${ARCHIVE_DIR}/presenceUserConfigs/default_presence_config.presenceUserConfig-meta.xml" \
        "${FORCE_APP}/presenceUserConfigs/default_presence_config.presenceUserConfig-meta.xml"
    stage "${ARCHIVE_DIR}/queues/IGNORE_Chat_Queue.queue-meta.xml" \
        "${FORCE_APP}/queues/Chat_Queue.queue-meta.xml"
    stage "${ARCHIVE_DIR}/queues/IGNORE_AI_Bot_Holding_Queue_100.queue-meta.xml" \
        "${FORCE_APP}/queues/AI_Bot_Holding_Queue_100.queue-meta.xml"
    stage "${ARCHIVE_DIR}/flows/IGNORE_t2.flow-meta.xml" \
        "${FORCE_APP}/flows/t2.flow-meta.xml"
    stage "${ARCHIVE_DIR}/flows/IGNORE_defaultFlowTuBot.flow-meta.xml" \
        "${FORCE_APP}/flows/defaultFlowTuBot.flow-meta.xml"
    stage "${ARCHIVE_DIR}/skills/IGNORE_TuBot_On_Hold_DO_NOT_EDIT.skill-meta.xml" \
        "${FORCE_APP}/skills/TuBot_On_Hold_DO_NOT_EDIT.skill-meta.xml"
    stage "${ARCHIVE_DIR}/applications/standard__LightningService.app-meta.xml" \
        "${FORCE_APP}/applications/standard__LightningService.app-meta.xml"
    stage "${ARCHIVE_DIR}/flexipages/IGNORE_Messaging_Session_Record_Page.flexipage-meta.xml" \
        "${FORCE_APP}/flexipages/Messaging_Session_Record_Page.flexipage-meta.xml"
    stage "${ARCHIVE_DIR}/flexipages/LightningService_UtilityBar.flexipage-meta.xml" \
        "${FORCE_APP}/flexipages/LightningService_UtilityBar.flexipage-meta.xml"
    stage "${ARCHIVE_DIR}/messagingChannels/WebChat.messagingChannel-meta.xml" \
        "${FORCE_APP}/messagingChannels/WebChat.messagingChannel-meta.xml"
    stage "${ARCHIVE_DIR}/EmbeddedServiceConfig/WebChatDeployment.EmbeddedServiceConfig-meta.xml" \
        "${FORCE_APP}/EmbeddedServiceConfig/WebChatDeployment.EmbeddedServiceConfig-meta.xml"
    # The archived branding set does not exist in a fresh scratch org; the
    # deployment works without it, so drop the reference from the staged copy.
    sed -i '/<branding>.*<\/branding>/d' "${FORCE_APP}/EmbeddedServiceConfig/WebChatDeployment.EmbeddedServiceConfig-meta.xml"

    # The repo .forceignore deliberately excludes dev-only omni/messaging
    # metadata from deploys. Neutralize it for this run (restored on exit),
    # otherwise every sub-script deploy silently no-ops with status 0.
    cp ".forceignore" "${STAGE_BACKUP}/.forceignore"
    STAGED_OVERWRITE+=(".forceignore")
    printf '# Temporary minimal ignore for messaging scratch provisioning (restored on exit)\npackage.xml\n' > ".forceignore"

    # Minimal admin permset: only the custom permission the setup Apex gates on.
    # (The package permset references namespaced credentials and cannot deploy
    # standalone to a scratch org.)
    mkdir -p "${FORCE_APP}/permissionsets"
    cat << 'EOF' > "${FORCE_APP}/permissionsets/Scratch_Tubot_Admin_Access.permissionset-meta.xml"
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Scratch-only: satisfies the TuBot setup permission gate</description>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Scratch TuBot Admin Access</label>
    <customPermissions><enabled>true</enabled><name>Manage_Tubot_API_Connections</name></customPermissions>
</PermissionSet>
EOF
    STAGED_NEW+=("${FORCE_APP}/permissionsets/Scratch_Tubot_Admin_Access.permissionset-meta.xml")

    log_success "Staged $((${#STAGED_NEW[@]} + ${#STAGED_OVERWRITE[@]})) files (will be reverted on exit)."

    # ────────────────────────── Step 4: Closure Deploy + Permset ──────────────────────────
    log_section "Step 4: Deploying Setup Class Closure + Admin Permset"
    CLOSURE_DEPLOY=$(sf project deploy start \
        --source-dir "${FORCE_APP}/settings/OmniChannel.settings-meta.xml" \
        --source-dir "${FORCE_APP}/classes/OmniChannelSetupService.cls" \
        --source-dir "${FORCE_APP}/classes/OmniChannelQueueSetupService.cls" \
        --source-dir "${FORCE_APP}/classes/OmniChannelAgentProvisioningService.cls" \
        --source-dir "${FORCE_APP}/classes/OmniSupervisorSetupService.cls" \
        --source-dir "${FORCE_APP}/classes/TargetSalesforceUserResolver.cls" \
        --source-dir "${FORCE_APP}/classes/PanelAuthSupportService.cls" \
        --source-dir "${FORCE_APP}/classes/TubotPackageFeatureGate.cls" \
        --source-dir "${FORCE_APP}/objects/MCP_Config__c" \
        --source-dir "${FORCE_APP}/customPermissions/Manage_Tubot_API_Connections.customPermission-meta.xml" \
        --source-dir "${FORCE_APP}/permissionsets/Scratch_Tubot_Admin_Access.permissionset-meta.xml" \
        --target-org "${SCRATCH_ALIAS}" --wait "${WAIT_TIME}" --json 2>/dev/null | extract_json || true)
    if [ "$(echo "${CLOSURE_DEPLOY}" | jq -r '.status // 1')" != "0" ]; then
        log_error "Closure deploy failed:"
        echo "${CLOSURE_DEPLOY}" | jq -r '.result.details.componentFailures[]? | "\(.componentType) \(.fullName): \(.problem)"' 2>/dev/null \
            || echo "${CLOSURE_DEPLOY}" | jq -c '{status, message}' 2>/dev/null || echo "${CLOSURE_DEPLOY}"
        exit 1
    fi
    log_success "Setup class closure deployed."
    for cls in OmniChannelSetupService OmniChannelQueueSetupService \
               OmniChannelAgentProvisioningService OmniSupervisorSetupService \
               TargetSalesforceUserResolver PanelAuthSupportService TubotPackageFeatureGate; do
        if ! echo "${CLOSURE_DEPLOY}" | jq -e --arg c "${cls}" '.result.files[]? | select(.fullName == $c)' > /dev/null 2>&1; then
            log_error "Closure deploy skipped ${cls} (possible .forceignore/source-tracking skip)."
            exit 1
        fi
    done
    log_success "All 7 closure classes confirmed deployed."

    log_info "Assigning scratch admin permset to ${USER_USERNAME}..."
    ASSIGN_ARGS=(--on-behalf-of "${SCRATCH_USERNAME}")
    if [ "${USER_USERNAME}" != "${SCRATCH_USERNAME}" ]; then
        ASSIGN_ARGS+=(--on-behalf-of "${USER_USERNAME}")
    fi
    ASSIGN_RES=$(sf org assign permset --name Scratch_Tubot_Admin_Access \
        --target-org "${SCRATCH_ALIAS}" "${ASSIGN_ARGS[@]}" \
        --json 2>/dev/null | extract_json || true)
    if [ "$(echo "${ASSIGN_RES}" | jq -r '.status // 1')" != "0" ]; then
        log_error "Permset assignment failed: $(echo "${ASSIGN_RES}" | jq -r '.message // "unknown error"')"
        exit 1
    fi
    log_success "Admin permset assigned."
else
    log_section "Steps 3-4: Skipped (supervisor + messaging both skipped)"
fi

# ────────────────────────── Step 5: Omni Supervisor ──────────────────────────
if [ "${SKIP_SUPERVISOR}" = true ]; then
    log_section "Step 5: Skipped (--skip-supervisor)"
else
    log_section "Step 5: Activating Omni Supervisor"
    bash ./setup_omni_supervisor.sh \
        --target-org "${SCRATCH_ALIAS}" \
        --user "${USER_USERNAME}"
    log_success "Omni Supervisor activation script finished."
fi

# ────────────────────────── Step 6: Flow/Queue/Skill/Route Metadata ──────────────────────────
if [ "${SKIP_MESSAGING}" = true ]; then
    log_section "Step 6: Skipped (--skip-messaging)"
else
    log_section "Step 6: Flow/Queue/Skill/Route/MessagingSession Metadata"
    MESSAGING_SETUP_ARGS=(
        --target-org "${SCRATCH_ALIAS}" \
        --agent "${USER_USERNAME}" \
        --queue "Chat_Queue" \
        --queue-label "Chat Queue" \
        --routing-config "Chat_Routing_Config" \
        --channel "WebChat" \
        --deployment "WebChatDeployment" \
        --presence-status "Available_Messaging" \
        --perm-set "Omni_Channel_Messaging_Agent"
    )
    [[ "${ENABLE_HEADER_CUSTOM}" = true ]] && MESSAGING_SETUP_ARGS+=(--enable-header-custom)
    [[ -n "${CONFIGURE_CHANNELS}" ]] && MESSAGING_SETUP_ARGS+=(--configure-channels "${CONFIGURE_CHANNELS}")
    [[ "${SKIP_CHANNEL_CONFIG}" = true ]] && MESSAGING_SETUP_ARGS+=(--skip-channel-config)
    bash ./setup_messaging_omnichannel.sh "${MESSAGING_SETUP_ARGS[@]}"
    log_success "Messaging metadata script finished."
    # Preserve the generated web snippet outside the repo before tree restore
    if [ -f "test_embedded_chat.html" ]; then
        cp "test_embedded_chat.html" "/tmp/embedded_chat_${SCRATCH_ALIAS}.html" 2>/dev/null || true
        log_info "Web snippet preserved at: /tmp/embedded_chat_${SCRATCH_ALIAS}.html"
    fi
fi

# ────────────────────────── Step 7: Blind Verification ──────────────────────────
log_section "Step 7: Blind Verification (target ground truth)"
FAILURES=()

check() {
    local name="$1" actual="$2" expected="$3"
    if [ "${actual}" = "${expected}" ]; then
        log_success "PASS: ${name} (${actual})"
    else
        log_error "FAIL: ${name} (expected '${expected}', got '${actual}')"
        FAILURES+=("${name}")
    fi
}

QRY="--target-org ${SCRATCH_ALIAS} --json"
if [ "${SKIP_QUEUE}" = false ]; then
    V_QUEUE=$(sf data query -q "SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = '${QUEUE_DEV_NAME}' LIMIT 1" ${QRY} 2>/dev/null | jq -r '.result.records[0].Id // empty')
    check "simple queue ${QUEUE_DEV_NAME} exists" "$([ -n "${V_QUEUE}" ] && echo yes || echo no)" "yes"
    if [ -n "${V_QUEUE}" ]; then
        V_MEM=$(sf data query -q "SELECT Id FROM GroupMember WHERE GroupId = '${V_QUEUE}' AND UserOrGroupId = '${USER_ID}' LIMIT 1" ${QRY} 2>/dev/null | jq -r '.result.totalSize // 0')
        check "user ${USER_NAME} in queue ${QUEUE_DEV_NAME}" "${V_MEM}" "1"
    else
        FAILURES+=("user membership (queue missing)")
    fi
fi

if [ "${SKIP_SUPERVISOR}" = false ]; then
    V_SUP=$(sf data query --use-tooling-api -q "SELECT Id FROM OmniSupervisorConfig WHERE DeveloperName = 'Tier_1_Support_Supervisors' LIMIT 1" ${QRY} 2>/dev/null | jq -r '.result.totalSize // 0')
    check "OmniSupervisorConfig Tier_1_Support_Supervisors exists" "${V_SUP}" "1"
    V_SG=$(sf data query -q "SELECT Id FROM Group WHERE Type = 'Regular' AND DeveloperName = 'Omni_Supervisors' LIMIT 1" ${QRY} 2>/dev/null | jq -r '.result.records[0].Id // empty')
    if [ -n "${V_SG}" ]; then
        V_SGM=$(sf data query -q "SELECT Id FROM GroupMember WHERE GroupId = '${V_SG}' AND UserOrGroupId = '${USER_ID}' LIMIT 1" ${QRY} 2>/dev/null | jq -r '.result.totalSize // 0')
        check "user ${USER_NAME} in Omni_Supervisors group" "${V_SGM}" "1"
    else
        log_error "FAIL: Omni_Supervisors group missing"
        FAILURES+=("Omni_Supervisors group")
    fi
fi

if [ "${SKIP_MESSAGING}" = false ]; then
    V_CHATQ=$(sf data query -q "SELECT DeveloperName FROM Group WHERE Type = 'Queue' AND DeveloperName IN ('Chat_Queue','AI_Bot_Holding_Queue_100')" ${QRY} 2>/dev/null | jq -r '.result.totalSize // 0')
    check "Chat_Queue + AI_Bot_Holding_Queue_100 exist" "${V_CHATQ}" "2"
    V_ROUTE=$(sf data query --use-tooling-api -q "SELECT DeveloperName FROM QueueRoutingConfig WHERE DeveloperName IN ('Chat_Routing_Config','Holding_Routing_Config')" ${QRY} 2>/dev/null | jq -r '.result.totalSize // 0')
    check "Chat + Holding routing configs exist" "${V_ROUTE}" "2"
    V_SKILL=$(sf data query --use-tooling-api -q "SELECT Id FROM Skill WHERE DeveloperName = 'TuBot_On_Hold_DO_NOT_EDIT' LIMIT 1" ${QRY} 2>/dev/null | jq -r '.result.totalSize // 0')
    check "skill TuBot_On_Hold_DO_NOT_EDIT exists" "${V_SKILL}" "1"
    V_FLOWS=$(sf data query --use-tooling-api -q "SELECT Definition.DeveloperName FROM Flow WHERE Definition.DeveloperName IN ('t2','defaultFlowTuBot') AND Status = 'Active'" ${QRY} 2>/dev/null | jq -r '.result.totalSize // 0')
    check "flows t2 + defaultFlowTuBot active" "${V_FLOWS}" "2"
    V_CHAN=$(sf data query -q "SELECT IsActive FROM MessagingChannel WHERE DeveloperName = 'WebChat' LIMIT 1" ${QRY} 2>/dev/null | jq -r '.result.records[0].IsActive // false')
    check "MessagingChannel WebChat active" "${V_CHAN}" "true"
    V_PRES=$(sf data query --use-tooling-api -q "SELECT Id FROM ServicePresenceStatus WHERE DeveloperName = 'Available_Messaging' LIMIT 1" ${QRY} 2>/dev/null | jq -r '.result.totalSize // 0')
    check "presence status Available_Messaging exists" "${V_PRES}" "1"
fi

if [ "${#FAILURES[@]}" -gt 0 ]; then
    log_error "Verification failed for: ${FAILURES[*]}"
    exit 1
fi
log_success "All blind verification checks passed."

# ────────────────────────── Done ──────────────────────────
log_section "Messaging Scratch Org Ready"
log_success "Scratch Org  : ${SCRATCH_ALIAS} (${SCRATCH_USERNAME})"
log_success "Org ID       : ${SCRATCH_ORG_ID}"
[ "${SKIP_QUEUE}" = false ] && log_success "Queue        : ${QUEUE_DEV_NAME} (member: ${USER_NAME})"
[ "${SKIP_SUPERVISOR}" = false ] && log_success "Supervisor   : Tier_1_Support_Supervisors active for ${USER_NAME}"
[ "${SKIP_MESSAGING}" = false ] && log_success "Messaging    : WebChat channel + t2 flow + Chat_Queue live"
log_info "Open the org:"
log_info "  sf org open -o ${SCRATCH_ALIAS}"
log_info "Working tree restored (staging reverted)."
echo ""
