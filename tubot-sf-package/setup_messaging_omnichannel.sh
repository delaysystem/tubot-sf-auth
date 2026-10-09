#!/usr/bin/env bash

# ==============================================================================
# Automated End-to-End Embedded Messaging & Omni-Channel Deployment CLI
# ==============================================================================
# Orchestrates a hybrid pipeline of:
#   Phase 1: Metadata API (OmniChannelSettings, ServicePresenceStatus, Flow, CustomApp, FlexiPage, Layouts)
#   Phase 2: Programmatic Apex (Operational Queue, QueueSobject, GroupMember, PermSet, SetupEntityAccess, PermSetAssignment)
#   Phase 3: MessagingChannel Metadata (routing to active Omni-Channel flow & queue)
#   Phase 4: EmbeddedServiceConfig & Experience Site resolution
#   Phase 5: Connect REST API publish activation & client-side snippet generation
# ==============================================================================

set -eo pipefail

resolve_script_dir() {
    local script_path="${BASH_SOURCE[0]}"
    local script_parent

    while [[ -L "$script_path" ]]; do
        script_parent="$(CDPATH= cd -P -- "$(dirname -- "$script_path")" >/dev/null 2>&1 && pwd)"
        script_path="$(readlink "$script_path")"
        [[ "$script_path" == /* ]] || script_path="${script_parent}/${script_path}"
    done

    CDPATH= cd -P -- "$(dirname -- "$script_path")" >/dev/null 2>&1 && pwd
}

SCRIPT_DIR="$(resolve_script_dir)"
cd "$SCRIPT_DIR"

# Default configurations
TARGET_ORG=""
TARGET_USER=""
PANEL_API_BASE="${TUBOT_PANEL_API_URL:-https://panel.tubot.lat}"
PANEL_ACCESS_TOKEN="${TUBOT_PANEL_ACCESS_TOKEN:-}"
PANEL_CURL_CONFIG=""
SF_API_VERSION=""
QUEUE_DEV_NAME="Chat_Queue"
QUEUE_LABEL="Chat Queue"
ROUTING_CONFIG_NAME="Chat_Routing_Config"
CHANNEL_NAME="WebChat"
DEPLOYMENT_NAME="WebChatDeployment"
PRESENCE_STATUS="Available_Messaging"
PERM_SET_NAME="Omni_Channel_Messaging_Agent"
PERM_SET_LABEL="Omni-Channel Messaging Agent"
DRY_RUN=false
CONFIGURE_CHANNELS=""
ENABLE_HEADER_CUSTOM=false
STAGE_ARCHIVED_ASSETS=false
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

cleanup_panel_curl_config() {
    if [[ -n "$PANEL_CURL_CONFIG" && -f "$PANEL_CURL_CONFIG" ]]; then
        rm -f -- "$PANEL_CURL_CONFIG"
    fi
    return 0
}
trap cleanup_panel_curl_config EXIT

panel_http_call() {
    local method="$1" path="$2" body="${3:-}" request_file response_file http_code status_message
    local -a data_args=()
    request_file=$(mktemp)
    response_file=$(mktemp)
    chmod 600 "$request_file" "$response_file"
    if [[ -n "$body" ]]; then
        printf '%s' "$body" > "$request_file"
        data_args+=(--data-binary "@${request_file}")
    fi

    if ! http_code=$(curl --silent --show-error --connect-timeout 15 --max-time 180 \
        --config "$PANEL_CURL_CONFIG" --request "$method" \
        --output "$response_file" --write-out '%{http_code}' \
        "${data_args[@]}" \
        "${PANEL_API_BASE}${path}"); then
        rm -f -- "$request_file" "$response_file"
        log_error "Panel API transport failed for ${path}."
        return 1
    fi

    if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
        status_message=$(jq -r '.error_description // .message // .error // "request rejected"' "$response_file" 2>/dev/null || true)
        log_error "Panel API ${path} returned HTTP ${http_code}: ${status_message}" >&2
        rm -f -- "$request_file" "$response_file"
        return 1
    fi
    cat "$response_file"
    rm -f -- "$request_file" "$response_file"
}

salesforce_batch() {
    local requests="$1" halt_on_error="${2:-true}" payload response failed
    payload=$(jq -cn --arg orgId "$ORG_ID" --arg apiVersion "$SF_API_VERSION" \
        --argjson batchRequests "$requests" --argjson haltOnError "$halt_on_error" \
        '{orgId:$orgId,apiVersion:$apiVersion,batchRequests:$batchRequests,haltOnError:$haltOnError}')
    response=$(panel_http_call POST "/api/v1/salesforce/self-oauth/batch" "$payload") || return 1
    if ! jq -e '(.results | type == "array") and (.results | length > 0) and
        (all(.results[]; (.statusCode | type == "number") and .statusCode >= 200 and .statusCode < 300)) and
        (.hasErrors != true)' >/dev/null <<< "$response"; then
        failed=$(jq -r '[.results | to_entries[]? | select(.value.statusCode < 200 or .value.statusCode >= 300) |
            "request \(.key + 1) failed with HTTP \(.value.statusCode)"] | join("; ") // "Salesforce rejected the batch"' <<< "$response" 2>/dev/null || true)
        log_error "Salesforce batch failed: ${failed:-invalid batch response}" >&2
        return 1
    fi
    printf '%s\n' "$response"
}

salesforce_batch_complete_query_pages() {
    local response="$1" results pending page_requests page_response pages page_count rounds=0
    results=$(jq -ce '[.results[].result] | select(length > 0)' <<< "$response") || return 1

    while true; do
        pending=$(jq -cn --arg version "v${SF_API_VERSION}" --argjson results "$results" '
            [$results | to_entries[] | . as $row |
                ($row.value.nextRecordsUrl // null) as $url |
                select(($url | type) == "string" and ($url | length) > 0) |
                if ($url | startswith("/services/data/" + $version + "/query/")) then
                    {index:$row.key,url:($url | sub("^/services/data/"; ""))}
                else error("invalid Salesforce query locator") end
            ]' 2>/dev/null) || {
            log_error "Salesforce returned an invalid query locator."
            return 1
        }
        page_count=$(jq -r 'length' <<< "$pending")
        [[ "$page_count" -eq 0 ]] && break

        rounds=$((rounds + 1))
        if (( rounds > 1000 )); then
            log_error "Salesforce query exceeded the 1,000-page safety limit."
            return 1
        fi

        page_requests=$(jq -cn --argjson pending "$pending" \
            '[$pending[] | {method:"GET",url:.url}]')
        page_response=$(salesforce_batch "$page_requests") || return 1
        pages=$(jq -ce --argjson expected "$page_count" \
            '[.results[].result] | select(length == $expected)' <<< "$page_response") || {
            log_error "Salesforce returned an incomplete query page batch."
            return 1
        }
        results=$(jq -cn --argjson results "$results" --argjson pending "$pending" --argjson pages "$pages" '
            reduce range(0; ($pending | length)) as $page_index ($results;
                ($pending[$page_index].index) as $result_index |
                ($pages[$page_index] // {}) as $page |
                .[$result_index].records = ((.[$result_index].records // []) + ($page.records // [])) |
                .[$result_index].done = ($page.done // false) |
                .[$result_index].nextRecordsUrl = ($page.nextRecordsUrl // null)
            )') || return 1
    done

    jq -cn --argjson results "$results" \
        '{hasErrors:false,results:[$results[] | {statusCode:200,result:.}]}'
}

salesforce_query() {
    local soql="$1" requests response
    requests=$(jq -cn --arg version "v${SF_API_VERSION}" --arg soql "$soql" \
        '{haltOnError:true,batchRequests:[{method:"GET",url:($version+"/query/?q="+($soql|@uri))}]}')
    response=$(salesforce_batch "$(jq -c '.batchRequests' <<< "$requests")") || return 1
    response=$(salesforce_batch_complete_query_pages "$response") || return 1
    jq -c '{result:.results[0].result}' <<< "$response"
}

salesforce_query_group() {
    local queries="$1" requests response
    requests=$(jq -cn --arg version "v${SF_API_VERSION}" --argjson queries "$queries" \
        '{batchRequests:[$queries[] | {method:"GET",url:($version+"/query/?q="+(.|@uri))}]}')
    response=$(salesforce_batch "$(jq -c '.batchRequests' <<< "$requests")") || return 1
    response=$(salesforce_batch_complete_query_pages "$response") || return 1
    printf '%s\n' "$response"
}

salesforce_api_request() {
    local method="$1" path="$2" body="${3:-}" payload
    payload=$(jq -cn --arg orgId "$ORG_ID" --arg method "$method" --arg path "$path" \
        --arg requestBody "$body" '{orgId:$orgId,method:$method,path:$path} + (if $requestBody=="" then {} else {requestBody:$requestBody} end)')
    panel_http_call POST "/api/v1/salesforce/self-oauth/request" "$payload"
}

salesforce_tooling_query() {
    local soql="$1" query response
    query=$(jq -rn --arg soql "$soql" '$soql|@uri')
    response=$(salesforce_api_request GET "/services/data/v${SF_API_VERSION}/tooling/query/?q=${query}") || return 1
    jq -c '{result:.}' <<< "$response"
}

salesforce_cli_query() {
    local soql="$1"
    sf data query -q "$soql" --target-org "$TARGET_ORG" --json 2>/dev/null | jq -ce '.result'
}

salesforce_cli_tooling_query() {
    local soql="$1"
    sf data query --use-tooling-api -q "$soql" --target-org "$TARGET_ORG" --json 2>/dev/null | jq -ce '.result'
}

configure_header_custom_for_web_deployment() {
    if [[ ! "${DEPLOYMENT_NAME}" =~ ^[A-Za-z0-9_]+$ ]]; then
        log_error "Deployment name '${DEPLOYMENT_NAME}' is not a valid DeveloperName."
        return 1
    fi

    local deployment_json deployment_id deployment_type bundle_json bundle_id component_json
    local component_record_id current_component_id request_body verified_component_id

    deployment_json=$(salesforce_tooling_query \
        "SELECT Id, DeploymentType FROM EmbeddedServiceConfig WHERE DeveloperName = '${DEPLOYMENT_NAME}' LIMIT 1")
    deployment_id=$(echo "$deployment_json" | jq -r '.result.records[0].Id // empty')
    deployment_type=$(echo "$deployment_json" | jq -r '.result.records[0].DeploymentType // empty')

    if [[ -z "$deployment_id" ]]; then
        log_error "EmbeddedServiceConfig '${DEPLOYMENT_NAME}' was not found after deployment."
        return 1
    fi

    if [[ "$deployment_type" != "Web" ]]; then
        log_info "Skipping headerCustom: deployment '${DEPLOYMENT_NAME}' is '${deployment_type}', not Web."
        return 0
    fi

    bundle_json=$(salesforce_tooling_query \
        "SELECT Id FROM LightningComponentBundle WHERE DeveloperName = 'headerCustom' LIMIT 1")
    bundle_id=$(echo "$bundle_json" | jq -r '.result.records[0].Id // empty')
    if [[ -z "$bundle_id" ]]; then
        log_error "LightningComponentBundle 'headerCustom' was not found in ${TARGET_ORG}."
        return 1
    fi

    component_json=$(salesforce_tooling_query \
        "SELECT Id, CustomComponentId FROM EmbeddedServiceCustomComponent WHERE EmbeddedServiceConfigId = '${deployment_id}' AND CustomComponentType = 'MIAW_Header' LIMIT 1")
    component_record_id=$(echo "$component_json" | jq -r '.result.records[0].Id // empty')
    current_component_id=$(echo "$component_json" | jq -r '.result.records[0].CustomComponentId // empty')

    if [[ "$current_component_id" == "$bundle_id" ]]; then
        log_success "headerCustom is already configured on Web deployment '${DEPLOYMENT_NAME}'."
        return 0
    fi

    if [[ -n "$component_record_id" ]]; then
        request_body=$(jq -cn --arg componentId "$bundle_id" '{CustomComponentId: $componentId}')
        salesforce_api_request PATCH "/services/data/v${SF_API_VERSION}/tooling/sobjects/EmbeddedServiceCustomComponent/${component_record_id}" "$request_body" >/dev/null
    else
        request_body=$(jq -cn --arg deploymentId "$deployment_id" --arg componentId "$bundle_id" \
            '{EmbeddedServiceConfigId: $deploymentId, CustomComponentId: $componentId, CustomComponentType: "MIAW_Header"}')
        salesforce_api_request POST "/services/data/v${SF_API_VERSION}/tooling/sobjects/EmbeddedServiceCustomComponent" "$request_body" >/dev/null
    fi

    component_json=$(salesforce_cli_tooling_query \
        "SELECT CustomComponentId FROM EmbeddedServiceCustomComponent WHERE EmbeddedServiceConfigId = '${deployment_id}' AND CustomComponentType = 'MIAW_Header' LIMIT 1")
    verified_component_id=$(echo "$component_json" | jq -r '.records[0].CustomComponentId // empty')
    if [[ "$verified_component_id" != "$bundle_id" ]]; then
        log_error "headerCustom verification failed for Web deployment '${DEPLOYMENT_NAME}'."
        return 1
    fi

    log_success "Configured and verified headerCustom on Web deployment '${DEPLOYMENT_NAME}'."
}

show_help() {
    cat << EOF
Usage:
  ./setup_messaging_omnichannel.sh [options]

Options:
  -o, --target-org ALIAS       Target org username or alias (prompted if omitted)
  --panel-url URL              TuBot Panel base URL (default: https://panel.tubot.lat,
                               or TUBOT_PANEL_API_URL)
  TUBOT_PANEL_ACCESS_TOKEN     Panel OAuth bearer token (prompted securely if unset)
  -u, --user, -a, --agent, --agents IDENTIFIER
                               Target agent(s) (comma-separated names, usernames, emails, IDs, or 'default')
                               (prompted if omitted; enter 'default' to use the authenticated Salesforce user)
  -q, --queue NAME             Operational Queue DeveloperName (default: Chat_Queue)
  -l, --queue-label LABEL      Queue display label (default: Chat Queue)
  -r, --routing-config NAME    QueueRoutingConfig DeveloperName (default: Chat_Routing_Config)
  -c, --channel NAME           MessagingChannel DeveloperName (default: WebChat)
  -d, --deployment NAME        EmbeddedServiceConfig Name (default: WebChatDeployment)
  -p, --presence-status NAME   ServicePresenceStatus DeveloperName (default: Available_Messaging)
  -s, --perm-set NAME          PermissionSet DeveloperName (default: Omni_Channel_Messaging_Agent)
  --enable-header-custom       Set the MIAW header component to headerCustom when deployment is Web
  --stage-archived-assets      Use create_messaging_scratch.sh when setup assets are not staged
  --dry-run                    Validate metadata deployment without writing changes to org
  --configure-channels NAMES   After setup, reconfigure listed MessagingChannels (comma-separated
                               DeveloperNames, or 'ALL') to Omni-Flow t2 + AI_Bot_Holding_Queue_100
  --skip-channel-config        Skip the optional Phase 6 channel reconfiguration prompt
  -h, --help                   Display this help message

Examples:
  ./setup_messaging_omnichannel.sh --target-org my-org --agent "Agent Name"
  ./setup_messaging_omnichannel.sh -o my-org -a "Agent Name, agent@example.com"
  ./setup_messaging_omnichannel.sh -o my-org --configure-channels "WebChat,Data360_Channel"
  ./setup_messaging_omnichannel.sh -o my-org --configure-channels ALL
EOF
}

# Parse Command Line Arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--target-org)
            TARGET_ORG="$2"
            shift 2
            ;;
        --panel-url)
            PANEL_API_BASE="$2"
            shift 2
            ;;
        -u|--user|-a|--agent|--agents)
            TARGET_USER="$2"
            shift 2
            ;;
        -q|--queue)
            QUEUE_DEV_NAME="$2"
            shift 2
            ;;
        -l|--queue-label)
            QUEUE_LABEL="$2"
            shift 2
            ;;
        -r|--routing-config)
            ROUTING_CONFIG_NAME="$2"
            shift 2
            ;;
        -c|--channel)
            CHANNEL_NAME="$2"
            shift 2
            ;;
        -d|--deployment)
            DEPLOYMENT_NAME="$2"
            shift 2
            ;;
        -p|--presence-status)
            PRESENCE_STATUS="$2"
            shift 2
            ;;
        -s|--perm-set)
            PERM_SET_NAME="$2"
            shift 2
            ;;
        --enable-header-custom)
            ENABLE_HEADER_CUSTOM=true
            shift
            ;;
        --stage-archived-assets)
            STAGE_ARCHIVED_ASSETS=true
            shift
            ;;
        --configure-channels)
            CONFIGURE_CHANNELS="$2"
            shift 2
            ;;
        --skip-channel-config)
            CONFIGURE_CHANNELS="SKIP"
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
if ! command -v jq &> /dev/null; then
    log_error "'jq' is required but not installed."
    exit 1
fi
if ! command -v curl &> /dev/null; then
    log_error "'curl' is required but not installed."
    exit 1
fi

if [[ -z "$TARGET_ORG" ]]; then
    if [[ -t 0 ]]; then
        read -r -p "Target Salesforce org alias or username: " TARGET_ORG
    else
        log_error "Target org is required. Pass --target-org when running non-interactively."
        exit 1
    fi
fi
if [[ -z "$TARGET_ORG" ]]; then
    log_error "Target org cannot be empty."
    exit 1
fi

if [[ -z "$TARGET_USER" ]]; then
    if [[ -t 0 ]]; then
        read -r -p "Target agent identifier (or 'default' for the authenticated Salesforce user): " TARGET_USER
    else
        log_error "Target agent is required. Pass --agent when running non-interactively."
        exit 1
    fi
fi

for api_name in "$QUEUE_DEV_NAME" "$ROUTING_CONFIG_NAME" "$CHANNEL_NAME" "$DEPLOYMENT_NAME" "$PRESENCE_STATUS" "$PERM_SET_NAME"; do
    if [[ ! "$api_name" =~ ^[A-Za-z0-9_]{1,80}$ ]]; then
        log_error "Salesforce developer names must contain only letters, digits, or underscores."
        exit 1
    fi
done
if [[ -z "$TARGET_USER" ]]; then
    log_error "Target agent cannot be empty."
    exit 1
fi

REQUIRED_SETUP_SOURCES=(
    "force-app/main/default/servicePresenceStatuses"
    "force-app/main/default/queueRoutingConfigs"
    "force-app/main/default/presenceUserConfigs"
    "force-app/main/default/queues"
    "force-app/main/default/flows/t2.flow-meta.xml"
    "force-app/main/default/applications/standard__LightningService.app-meta.xml"
    "force-app/main/default/flexipages/Messaging_Session_Record_Page.flexipage-meta.xml"
    "force-app/main/default/flexipages/LightningService_UtilityBar.flexipage-meta.xml"
    "force-app/main/default/skills"
    "force-app/main/default/flows/defaultFlowTuBot.flow-meta.xml"
    "force-app/main/default/messagingChannels/${CHANNEL_NAME}.messagingChannel-meta.xml"
    "force-app/main/default/EmbeddedServiceConfig/${DEPLOYMENT_NAME}.EmbeddedServiceConfig-meta.xml"
)
MISSING_SETUP_SOURCES=()
for source_path in "${REQUIRED_SETUP_SOURCES[@]}"; do
    [[ -e "${SCRIPT_DIR}/${source_path}" ]] || MISSING_SETUP_SOURCES+=("${source_path}")
done

if [[ ${#MISSING_SETUP_SOURCES[@]} -gt 0 ]]; then
    log_warn "Messaging setup metadata is not staged in ${SCRIPT_DIR}."
    for source_path in "${MISSING_SETUP_SOURCES[@]}"; do
        log_info "Missing setup source: ${source_path}"
    done
    log_info "This checkout keeps dev-only setup metadata in archive/pre-appexchange-cleanup; create_messaging_scratch.sh stages it temporarily."

    if [[ "$DRY_RUN" == true ]]; then
        log_error "Cannot stage archived setup assets during --dry-run because the staging workflow performs org mutations."
        exit 1
    fi

    RUN_STAGED_WORKFLOW="$STAGE_ARCHIVED_ASSETS"
    if [[ "$RUN_STAGED_WORKFLOW" != true && -t 0 ]]; then
        read -r -p "Run the staged setup workflow against '${TARGET_ORG}' now? It will modify that org. [y/N]: " stage_answer
        [[ "$stage_answer" =~ ^[Yy]([Ee][Ss])?$ ]] && RUN_STAGED_WORKFLOW=true
    fi

    if [[ "$RUN_STAGED_WORKFLOW" != true ]]; then
        log_error "Setup cancelled. To run this script from a clean checkout, use --stage-archived-assets or run create_messaging_scratch.sh --use-existing-org '${TARGET_ORG}'."
        exit 1
    fi

    if [[ ! -f "${SCRIPT_DIR}/create_messaging_scratch.sh" ]]; then
        log_error "create_messaging_scratch.sh was not found next to this script."
        exit 1
    fi

    STAGED_WORKFLOW_ARGS=(
        --use-existing-org "${TARGET_ORG}"
        --user "${TARGET_USER}"
        --queue "${QUEUE_DEV_NAME}"
        --queue-label "${QUEUE_LABEL}"
        --routing-config "${ROUTING_CONFIG_NAME}"
    )
    [[ "$ENABLE_HEADER_CUSTOM" == true ]] && STAGED_WORKFLOW_ARGS+=(--enable-header-custom)
    [[ -n "$CONFIGURE_CHANNELS" && "$CONFIGURE_CHANNELS" != "SKIP" ]] && STAGED_WORKFLOW_ARGS+=(--configure-channels "${CONFIGURE_CHANNELS}")
    [[ "$CONFIGURE_CHANNELS" == "SKIP" ]] && STAGED_WORKFLOW_ARGS+=(--skip-channel-config)
    TUBOT_PANEL_API_URL="${PANEL_API_BASE}" exec bash "${SCRIPT_DIR}/create_messaging_scratch.sh" "${STAGED_WORKFLOW_ARGS[@]}"
fi

echo -e "${CYAN}${BOLD}"
echo "=========================================================================="
echo "    Salesforce Omni-Channel & Embedded Messaging Headless Setup CLI       "
echo "=========================================================================="
echo -e "${NC}"
log_info "Target Org:        ${BOLD}${TARGET_ORG}${NC}"
log_info "Target agent selection: ${BOLD}provided${NC}"
log_info "Routing Queue:     ${BOLD}${QUEUE_DEV_NAME}${NC} ('${QUEUE_LABEL}')"
log_info "Routing Config:    ${BOLD}${ROUTING_CONFIG_NAME}${NC}"
log_info "Messaging Channel: ${BOLD}${CHANNEL_NAME}${NC}"
log_info "Deployment Name:   ${BOLD}${DEPLOYMENT_NAME}${NC}"
log_info "Presence Status:   ${BOLD}${PRESENCE_STATUS}${NC}"
log_info "Dry Run Mode:      ${BOLD}${DRY_RUN}${NC}"
log_info "Panel API:         ${BOLD}${PANEL_API_BASE}${NC}"

# ==============================================================================
# Step 0: Introspect Target Org Connectivity & Session
# ==============================================================================
log_phase "Step 0: Checking Org Connectivity & Authentication"

ORG_DISPLAY_JSON=$(sf org display --target-org "${TARGET_ORG}" --json 2>/dev/null | \
    jq -c '{id:.result.id,instanceUrl:.result.instanceUrl,username:.result.username}' 2>/dev/null || true)
ORG_ID=$(echo "$ORG_DISPLAY_JSON" | jq -r '.id // empty')
INSTANCE_URL=$(echo "$ORG_DISPLAY_JSON" | jq -r '.instanceUrl // empty')
CONNECTED_USER=$(echo "$ORG_DISPLAY_JSON" | jq -r '.username // empty')
AUTHENTICATED_USER_ID=""

if [[ -z "$ORG_ID" || -z "$INSTANCE_URL" || -z "$CONNECTED_USER" ]]; then
    log_error "Failed to connect to target org '${TARGET_ORG}'. Please check your authentication ('sf org login')."
    exit 1
fi
if [[ ! "$CONNECTED_USER" =~ ^[A-Za-z0-9._+@-]+$ ]]; then
    log_error "Salesforce returned a username that cannot be safely resolved for this setup."
    exit 1
fi
CONNECTED_USER_JSON=$(sf data query -q "SELECT Id FROM User WHERE Username = '${CONNECTED_USER}' LIMIT 1" \
    --target-org "${TARGET_ORG}" --json 2>/dev/null || true)
AUTHENTICATED_USER_ID=$(jq -r '.result.records[0].Id // empty' <<< "$CONNECTED_USER_JSON" 2>/dev/null || true)
if [[ -z "$AUTHENTICATED_USER_ID" ]]; then
    log_error "Could not resolve the authenticated Salesforce user ID for this org."
    exit 1
fi

if [[ ! "$PANEL_API_BASE" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
    log_error "Panel URL must be an https origin with no path or query string."
    exit 1
fi
PANEL_API_BASE="${PANEL_API_BASE%/}"
SF_API_VERSION=$(jq -r '.sourceApiVersion // empty' "${SCRIPT_DIR}/sfdx-project.json")
if [[ ! "$SF_API_VERSION" =~ ^[0-9]{2,3}([.][0-9]{1,2})?$ ]]; then
    log_error "Could not resolve a Salesforce API version from sfdx-project.json."
    exit 1
fi

if [[ -z "$PANEL_ACCESS_TOKEN" ]]; then
    if [[ -t 0 ]]; then
        read -r -s -p "TuBot Panel OAuth access token: " PANEL_ACCESS_TOKEN
        echo
    else
        log_error "Panel OAuth token is required. Set TUBOT_PANEL_ACCESS_TOKEN for non-interactive runs."
        exit 1
    fi
fi
if [[ ! "$PANEL_ACCESS_TOKEN" =~ ^[A-Za-z0-9._~-]{16,4096}$ ]]; then
    log_error "Panel OAuth token has an unsupported format."
    exit 1
fi
umask 077
PANEL_CURL_CONFIG=$(mktemp)
printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
    "$PANEL_ACCESS_TOKEN" > "$PANEL_CURL_CONFIG"
chmod 600 "$PANEL_CURL_CONFIG"
unset PANEL_ACCESS_TOKEN

log_success "Connected to Org: ${ORG_ID} (${INSTANCE_URL})"
log_info "Authenticated Salesforce user identity resolved."

PANEL_OAUTH_STATUS=$(panel_http_call GET "/api/v1/salesforce/self-oauth?orgId=${ORG_ID}") || exit 1
PANEL_CONNECTED=$(jq -r '.connected // false' <<< "$PANEL_OAUTH_STATUS")
PANEL_ORG_ID=$(jq -r '.orgId // empty' <<< "$PANEL_OAUTH_STATUS")
PANEL_SF_USER_ID=$(jq -r '.salesforceUserId // empty' <<< "$PANEL_OAUTH_STATUS")
if [[ "$PANEL_CONNECTED" != "true" ]]; then
    log_error "TuBot Panel has no active Salesforce API connection for org ${ORG_ID}. Connect this org in Panel Settings first."
    exit 1
fi
if [[ "${PANEL_ORG_ID:0:15}" != "${ORG_ID:0:15}" || "${PANEL_SF_USER_ID:0:15}" != "${AUTHENTICATED_USER_ID:0:15}" ]]; then
    log_error "The Panel Salesforce connection does not match the selected Salesforce CLI org and user."
    exit 1
fi

ORG_IDENTITY_REQUESTS=$(jq -cn --arg version "v${SF_API_VERSION}" \
    '{batchRequests:[{method:"GET",url:($version+"/query/?q="+("SELECT Id, IsSandbox FROM Organization LIMIT 1"|@uri))}]}')
ORG_IDENTITY_RESULT=$(salesforce_batch "$(jq -c '.batchRequests' <<< "$ORG_IDENTITY_REQUESTS")") || exit 1
API_ORG_ID=$(jq -r '.results[0].result.records[0].Id // empty' <<< "$ORG_IDENTITY_RESULT")
if [[ "${API_ORG_ID:0:15}" != "${ORG_ID:0:15}" ]]; then
    log_error "The Salesforce API connection resolved to a different org than --target-org."
    exit 1
fi
log_success "Panel and Salesforce CLI are authenticated as the same user in org ${ORG_ID}."

# If target user contains 'default', substitute authenticated user into the string
ACTUAL_TARGET_USER=$(echo "$TARGET_USER" | sed -E "s/\bdefault\b/${CONNECTED_USER}/g")
log_info "Provisioning the selected Salesforce agent identity."

# ==============================================================================
# Phase 1: Deploy Foundational Metadata (Settings, Status, Flow, UI Components)
# ==============================================================================
log_phase "Phase 1: Deploying Foundational Metadata via Metadata API"

# Resolve Target Org Queue ID for Flow 't2' routing
FLOW_FILE="${SCRIPT_DIR}/force-app/main/default/flows/t2.flow-meta.xml"
TARGET_QUEUE_ID=$(salesforce_query "SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = '${QUEUE_DEV_NAME}' LIMIT 1" 2>/dev/null | jq -r '.result.records[0].Id // empty' || true)

if [[ -n "$TARGET_QUEUE_ID" && -f "$FLOW_FILE" ]]; then
    log_info "Configuring Flow 't2' queueId for ${TARGET_ORG}: ${TARGET_QUEUE_ID}"
    python3 -c "
import sys, re
file_path, q_id = sys.argv[1], sys.argv[2]
with open(file_path, 'r') as f:
    text = f.read()
text = re.sub(r'(<name>queueId</name>\s*<value>\s*<stringValue>)[^<]*(</stringValue>)', rf'\g<1>{q_id}\2', text)
with open(file_path, 'w') as f:
    f.write(text)
" "$FLOW_FILE" "$TARGET_QUEUE_ID"
fi

DEPLOY_CMD="sf project deploy start \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/settings\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/servicePresenceStatuses\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/queueRoutingConfigs\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/presenceUserConfigs\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/queues\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/flows/t2.flow-meta.xml\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/applications/standard__LightningService.app-meta.xml\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/flexipages/Messaging_Session_Record_Page.flexipage-meta.xml\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/flexipages/LightningService_UtilityBar.flexipage-meta.xml\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/objects/MessagingSession\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/objects/MCP_Config__c\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/objects/Tubot_Setting__mdt\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/skills\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/flows/defaultFlowTuBot.flow-meta.xml\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/classes/OmniChannelSetupService.cls\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/classes/OmniChannelSetupServiceTest.cls\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/classes/OmniChannelQueueSetupService.cls\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/classes/OmniChannelAgentProvisioningService.cls\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/classes/TargetSalesforceUserResolver.cls\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/classes/PanelAuthSupportService.cls\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/classes/TubotPackageFeatureGate.cls\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/classes/OmniSupervisorSetupService.cls\" \
  --source-dir \"${SCRIPT_DIR}/force-app/main/default/customPermissions/Manage_Tubot_API_Connections.customPermission-meta.xml\" \
  --target-org \"${TARGET_ORG}\" --wait ${WAIT_TIME}"

if [ "$DRY_RUN" = true ]; then
    DEPLOY_CMD="${DEPLOY_CMD} --dry-run"
    log_info "Running Phase 1 in DRY-RUN mode..."
fi

log_info "Executing Phase 1 deployment..."
eval "$DEPLOY_CMD"
log_success "Phase 1: Foundational metadata successfully deployed!"

if [ "$DRY_RUN" = true ]; then
    log_warn "Dry run mode requested. Stopping before executing Apex mutations and Connect REST publish."
    exit 0
fi

# ==============================================================================
# Phase 2: Programmatic Apex Operations (Queue, QSO, Membership, PermSet, SEA, PSA)
# ==============================================================================
log_phase "Phase 2: Programmatic Apex Operational Assembly & Agent Provisioning"

APEX_JSON_CONFIG=$(jq -cn --arg queueDevName "$QUEUE_DEV_NAME" --arg queueLabel "$QUEUE_LABEL" \
    --arg routingConfigDevName "$ROUTING_CONFIG_NAME" --arg userIdentifier "$ACTUAL_TARGET_USER" \
    --arg presenceStatusDevName "$PRESENCE_STATUS" --arg permSetDevName "$PERM_SET_NAME" \
    --arg permSetLabel "$PERM_SET_LABEL" \
    '{queueDevName:$queueDevName,queueLabel:$queueLabel,routingConfigDevName:$routingConfigDevName,
      userIdentifier:$userIdentifier,presenceStatusDevName:$presenceStatusDevName,
      permSetDevName:$permSetDevName,permSetLabel:$permSetLabel}')
APEX_JSON_LITERAL=$(jq -Rn --arg value "$APEX_JSON_CONFIG" '$value')
APEX_SCRIPT="String jsonConfig = ${APEX_JSON_LITERAL}; OmniChannelSetupService.executeSetupScript(jsonConfig);"

log_info "Executing Apex provisioning script on ${TARGET_ORG}..."
APEX_OUTPUT=$(echo "$APEX_SCRIPT" | sf apex run --target-org "${TARGET_ORG}" 2>&1 || true)

# Extract structured result from apex log
RAW_RESULT=$(echo "$APEX_OUTPUT" | grep -o '<<<OMNI_SETUP_RESULT>>>.*<<<END_OMNI_SETUP_RESULT>>>' || true)
RAW_RESULT="${RAW_RESULT#<<<OMNI_SETUP_RESULT>>>}"
RAW_RESULT="${RAW_RESULT%<<<END_OMNI_SETUP_RESULT>>>}"

if [[ -n "$RAW_RESULT" ]]; then
    PROV_SUCCESS=$(echo "$RAW_RESULT" | jq -r '.success')
    PROV_MSG=$(echo "$RAW_RESULT" | jq -r '.message')
    PROV_QUEUE_ID=$(echo "$RAW_RESULT" | jq -r '.queueId')
    PROV_PS_ID=$(echo "$RAW_RESULT" | jq -r '.permissionSetId')

    if [ "$PROV_SUCCESS" = "true" ]; then
        log_success "Apex Operational Setup Succeeded!"
        log_info "Queue ID:          ${PROV_QUEUE_ID} (${QUEUE_DEV_NAME})"
        log_info "Provisioned:       ${PROV_MSG}"
        log_info "PermissionSet ID:  ${PROV_PS_ID} (${PERM_SET_NAME})"

        # Ensure Flow 't2' contains the verified Queue ID
        if [[ -n "$PROV_QUEUE_ID" && "$PROV_QUEUE_ID" != "$TARGET_QUEUE_ID" && -f "$FLOW_FILE" ]]; then
            log_info "Updating Flow 't2' queueId with verified Queue ID (${PROV_QUEUE_ID}) and redeploying..."
            python3 -c "
import sys, re
file_path, q_id = sys.argv[1], sys.argv[2]
with open(file_path, 'r') as f:
    text = f.read()
text = re.sub(r'(<name>queueId</name>\s*<value>\s*<stringValue>)[^<]*(</stringValue>)', rf'\g<1>{q_id}\2', text)
with open(file_path, 'w') as f:
    f.write(text)
" "$FLOW_FILE" "$PROV_QUEUE_ID"
            sf project deploy start --source-dir "$FLOW_FILE" --target-org "${TARGET_ORG}" --wait ${WAIT_TIME}
        fi
    else
        log_error "Apex Operational Setup returned error: ${PROV_MSG}"
        echo "$RAW_RESULT" | jq -r '.logs[]?'
        exit 1
    fi
else
    log_warn "Apex execution finished without structured tags. Inspecting Apex output:"
    echo "$APEX_OUTPUT"
fi

# ==============================================================================
# Phase 3: Deploy MessagingChannel Metadata (Routing sessions to active Flow & Queue)
# ==============================================================================
log_phase "Phase 3: Deploying & Activating MessagingChannel Metadata"

MC_DEPLOY_CMD="sf project deploy start --source-dir \"${SCRIPT_DIR}/force-app/main/default/messagingChannels/${CHANNEL_NAME}.messagingChannel-meta.xml\" --target-org \"${TARGET_ORG}\" --wait ${WAIT_TIME}"
log_info "Executing: ${MC_DEPLOY_CMD}"
eval "$MC_DEPLOY_CMD"

# Activate MessagingChannel
log_info "Activating MessagingChannel '${CHANNEL_NAME}' (IsActive=true)..."
CHANNEL_RECORD=$(salesforce_query "SELECT Id, IsActive FROM MessagingChannel WHERE DeveloperName = '${CHANNEL_NAME}' LIMIT 1")
CHANNEL_RECORD_ID=$(jq -r '.result.records[0].Id // empty' <<< "$CHANNEL_RECORD")
if [[ -z "$CHANNEL_RECORD_ID" ]]; then
    log_error "MessagingChannel '${CHANNEL_NAME}' was not found after deployment."
    exit 1
fi
if [[ "$(jq -r '.result.records[0].IsActive // false' <<< "$CHANNEL_RECORD")" != "true" ]]; then
    ACTIVATE_REQUESTS=$(jq -cn --arg version "v${SF_API_VERSION}" --arg id "$CHANNEL_RECORD_ID" \
        '[{method:"PATCH",url:($version+"/sobjects/MessagingChannel/"+$id),richInput:{IsActive:true}}]')
    salesforce_batch "$ACTIVATE_REQUESTS" >/dev/null
fi
CHANNEL_RECORD=$(salesforce_cli_query "SELECT IsActive FROM MessagingChannel WHERE Id = '${CHANNEL_RECORD_ID}' LIMIT 1")
if [[ "$(jq -r '.records[0].IsActive // false' <<< "$CHANNEL_RECORD")" != "true" ]]; then
    log_error "MessagingChannel '${CHANNEL_NAME}' activation did not persist in Salesforce."
    exit 1
fi
log_success "Phase 3: MessagingChannel '${CHANNEL_NAME}' deployed, activated (IsActive=true), and linked to t2 & ${QUEUE_DEV_NAME}!"

# ==============================================================================
# Phase 4: EmbeddedServiceConfig & Experience Site Linking (Web Deployment)
# ==============================================================================
log_phase "Phase 4: Resolving Experience Cloud Site & EmbeddedServiceConfig (Web)"

# Query existing Experience Cloud Communities
COMMUNITY_LIST_REQUESTS=$(jq -cn --arg version "v${SF_API_VERSION}" '[{method:"GET",url:($version+"/connect/communities")}]')
COMMUNITIES_BATCH=$(salesforce_batch "$COMMUNITY_LIST_REQUESTS" false) || exit 1
COMMUNITIES_RESP=$(jq -c '.results[0].result // {}' <<< "${COMMUNITIES_BATCH:-{}}" 2>/dev/null || echo '{}')
COMMUNITY_ID=$(echo "$COMMUNITIES_RESP" | jq -r 'if type=="object" and .communities then .communities[0].id // empty else empty end')
COMMUNITY_NAME=$(echo "$COMMUNITIES_RESP" | jq -r 'if type=="object" and .communities then .communities[0].name // empty else empty end')
COMMUNITY_SITE_URL=$(echo "$COMMUNITIES_RESP" | jq -r 'if type=="object" and .communities then .communities[0].siteUrl // empty else empty end')

if [[ -z "$COMMUNITY_ID" ]]; then
    log_info "No existing Experience Cloud site detected. Creating Experience Cloud LWR site on the fly..."
    CREATE_SITE_BODY=$(jq -cn --arg name "ESW_${DEPLOYMENT_NAME}" --arg prefix "ESW${DEPLOYMENT_NAME}" \
        '{name:$name,templateName:"Build Your Own (LWR)",urlPathPrefix:$prefix}')
    CREATE_SITE_REQUESTS=$(jq -cn --arg version "v${SF_API_VERSION}" --argjson richInput "$CREATE_SITE_BODY" \
        '[{method:"POST",url:($version+"/connect/communities"),richInput:$richInput}]')
    CREATE_BATCH=$(salesforce_batch "$CREATE_SITE_REQUESTS" false) || exit 1
    CREATE_RESP=$(jq -c '.results[0].result // {}' <<< "${CREATE_BATCH:-{}}" 2>/dev/null || echo '{}')
    CREATE_JOB_ID=$(echo "$CREATE_RESP" | jq -r 'if type=="object" then .jobId // empty else empty end' 2>/dev/null || true)
    if [[ -n "$CREATE_JOB_ID" ]]; then
        log_info "Waiting for Experience Cloud site creation (Job ID: ${CREATE_JOB_ID})..."
        for i in {1..20}; do
            JOB_STATUS=$(salesforce_cli_query "SELECT Id, Status FROM BackgroundOperation WHERE Id = '${CREATE_JOB_ID}' LIMIT 1" 2>/dev/null | jq -r '.records[0].Status // empty' || true)
            if [[ "$JOB_STATUS" == "Complete" ]]; then
                log_success "Experience Cloud site created successfully!"
                break
            fi
            if [[ "$JOB_STATUS" == "Error" || "$JOB_STATUS" == "Failed" || "$JOB_STATUS" == "Aborted" ]]; then
                log_error "Salesforce Experience Cloud site creation ended with status '${JOB_STATUS}'."
                exit 1
            fi
            sleep 3
        done
        if [[ "$JOB_STATUS" != "Complete" ]]; then
            log_error "Salesforce Experience Cloud site creation did not complete within 60 seconds."
            exit 1
        fi
    else
        log_error "Salesforce did not return a background job ID for Experience Cloud site creation."
        exit 1
    fi
    COMMUNITIES_BATCH=$(salesforce_batch "$COMMUNITY_LIST_REQUESTS" false) || exit 1
    COMMUNITIES_RESP=$(jq -c '.results[0].result // {}' <<< "${COMMUNITIES_BATCH:-{}}" 2>/dev/null || echo '{}')
    COMMUNITY_ID=$(echo "$COMMUNITIES_RESP" | jq -r 'if type=="object" and .communities then .communities[0].id // empty else empty end')
    COMMUNITY_NAME=$(echo "$COMMUNITIES_RESP" | jq -r 'if type=="object" and .communities then .communities[0].name // empty else empty end')
    COMMUNITY_SITE_URL=$(echo "$COMMUNITIES_RESP" | jq -r 'if type=="object" and .communities then .communities[0].siteUrl // empty else empty end')
    if [[ -z "$COMMUNITY_ID" ]]; then
        log_error "Salesforce did not expose the created Experience Cloud site after job completion."
        exit 1
    fi
fi

if [[ -n "$COMMUNITY_ID" ]]; then
    log_info "Resolved Experience Cloud site: ${COMMUNITY_NAME} (${COMMUNITY_ID})"
    log_info "Site Base URL: ${COMMUNITY_SITE_URL}"
    # Activate Network to Live status
    log_info "Ensuring Experience Cloud Network (${COMMUNITY_ID}) is Active/Live..."
    NETWORK_UPDATE_REQUESTS=$(jq -cn --arg version "v${SF_API_VERSION}" --arg id "$COMMUNITY_ID" \
        '[{method:"PATCH",url:($version+"/sobjects/Network/"+$id),richInput:{Status:"Live"}}]')
    salesforce_batch "$NETWORK_UPDATE_REQUESTS" false >/dev/null
    NETWORK_STATUS=$(salesforce_cli_query "SELECT Status FROM Network WHERE Id = '${COMMUNITY_ID}' LIMIT 1")
    if [[ "$(jq -r '.records[0].Status // empty' <<< "$NETWORK_STATUS")" != "Live" ]]; then
        log_error "Experience Cloud Network '${COMMUNITY_ID}' did not persist in Live status."
        exit 1
    fi
fi

# Resolve Experience Cloud Site DeveloperName for EmbeddedServiceConfig metadata
RESOLVED_SITE=$(salesforce_cli_query "SELECT Id, Name FROM Site WHERE Name LIKE 'ESW_${DEPLOYMENT_NAME}%' ORDER BY Name DESC LIMIT 1" 2>/dev/null | jq -r '.records[0].Name // empty' || true)
if [[ -z "$RESOLVED_SITE" ]]; then
    RESOLVED_SITE="ESW_${DEPLOYMENT_NAME}1"
fi
log_info "Resolved Site DeveloperName for EmbeddedServiceConfig: ${RESOLVED_SITE}"

# Ensure EmbeddedServiceConfig is Web type
EXISTING_CONFIG=$(salesforce_tooling_query "SELECT Id, DeploymentType FROM EmbeddedServiceConfig WHERE DeveloperName = '${DEPLOYMENT_NAME}' LIMIT 1" 2>/dev/null || true)
EXISTING_ID=$(echo "$EXISTING_CONFIG" | jq -r '.result.records[0].Id // empty')
EXISTING_TYPE=$(echo "$EXISTING_CONFIG" | jq -r '.result.records[0].DeploymentType // empty')
if [[ -n "$EXISTING_ID" && "$EXISTING_TYPE" != "Web" ]]; then
    log_info "Existing deployment '${DEPLOYMENT_NAME}' has type '${EXISTING_TYPE}'. Removing to recreate as Web..."
    salesforce_api_request DELETE "/services/data/v${SF_API_VERSION}/tooling/sobjects/EmbeddedServiceConfig/${EXISTING_ID}" >/dev/null
    EXISTING_CONFIG=$(salesforce_cli_tooling_query "SELECT Id, DeploymentType FROM EmbeddedServiceConfig WHERE DeveloperName = '${DEPLOYMENT_NAME}' LIMIT 1")
    if [[ "$(jq -r '.records | length' <<< "$EXISTING_CONFIG")" -ne 0 ]]; then
        log_error "EmbeddedServiceConfig '${DEPLOYMENT_NAME}' was not removed from Salesforce."
        exit 1
    fi
fi

# Ensure local EmbeddedServiceConfig metadata file has Web and site set
ESC_FILE="${SCRIPT_DIR}/force-app/main/default/EmbeddedServiceConfig/${DEPLOYMENT_NAME}.EmbeddedServiceConfig-meta.xml"
if [[ -f "$ESC_FILE" ]]; then
    sed -i -E "s|<deploymentType>[^<]+</deploymentType>|<deploymentType>Web</deploymentType>|" "$ESC_FILE"
    if grep -q "<site>" "$ESC_FILE"; then
        sed -i -E "s|<site>[^<]+</site>|<site>${RESOLVED_SITE}</site>|" "$ESC_FILE"
    else
        sed -i -E "s|</EmbeddedServiceConfig>|    <site>${RESOLVED_SITE}</site>\n</EmbeddedServiceConfig>|" "$ESC_FILE"
    fi
fi

ESC_DEPLOY_CMD="sf project deploy start --metadata EmbeddedServiceConfig:${DEPLOYMENT_NAME} --target-org ${TARGET_ORG} --wait ${WAIT_TIME}"
log_info "Executing: ${ESC_DEPLOY_CMD}"
eval "$ESC_DEPLOY_CMD" || log_warn "EmbeddedServiceConfig metadata deploy note: already provisioned or using active site link."
log_success "Phase 4: EmbeddedServiceConfig metadata ready as Web deployment."

if [[ "$ENABLE_HEADER_CUSTOM" == true ]]; then
    configure_header_custom_for_web_deployment
fi

# ==============================================================================
# Phase 5: Activation & Publish (Connect REST API) + Client Snippet Generation
# ==============================================================================
log_phase "Phase 5: Publishing Client-Side Assets via Connect REST API & Snippet Assembly"

if [[ -n "$COMMUNITY_ID" ]]; then
    log_info "Triggering Connect REST API publish: POST /connect/communities/${COMMUNITY_ID}/publish"
    PUBLISH_REQUESTS=$(jq -cn --arg version "v${SF_API_VERSION}" --arg id "$COMMUNITY_ID" \
        '[{method:"POST",url:($version+"/connect/communities/"+$id+"/publish"),richInput:{}}]')
    PUBLISH_BATCH=$(salesforce_batch "$PUBLISH_REQUESTS" false) || exit 1
    PUBLISH_RESP=$(jq -c '.results[0].result // {}' <<< "${PUBLISH_BATCH:-{}}" 2>/dev/null || echo '{}')
    PUBLISH_JOB_ID=$(echo "$PUBLISH_RESP" | jq -r '.jobId // empty')
    if [[ -z "$PUBLISH_JOB_ID" ]]; then
        log_error "Salesforce did not return a publish job ID for the Experience Cloud site."
        exit 1
    fi
    log_info "Publish job initiated (Job ID: ${PUBLISH_JOB_ID}). Waiting for site assets to compile..."
    for i in {1..20}; do
        PUB_STATUS=$(salesforce_cli_query "SELECT Id, Status FROM BackgroundOperation WHERE Id = '${PUBLISH_JOB_ID}' LIMIT 1" 2>/dev/null | jq -r '.records[0].Status // empty' || true)
        if [[ "$PUB_STATUS" == "Complete" ]]; then
            log_success "Experience Cloud site published and live (BackgroundOperation: Complete)!"
            break
        fi
        if [[ "$PUB_STATUS" == "Error" || "$PUB_STATUS" == "Failed" || "$PUB_STATUS" == "Aborted" ]]; then
            log_error "Salesforce Experience Cloud publish ended with status '${PUB_STATUS}'."
            exit 1
        fi
        sleep 3
    done
    if [[ "$PUB_STATUS" != "Complete" ]]; then
        log_error "Salesforce Experience Cloud publish did not complete within 60 seconds."
        exit 1
    fi
fi

# Derive MyDomain base and SCRT2 URL
# e.g., https://orgfarm-9c01b1d16c-dev-ed.develop.my.salesforce.com -> https://orgfarm-9c01b1d16c-dev-ed.develop.my.salesforce-scrt.com
MY_DOMAIN_HOST=$(echo "$INSTANCE_URL" | sed -E 's|https?://([^/]+)|\1|')
MY_DOMAIN_PREFIX=$(echo "$MY_DOMAIN_HOST" | sed -E 's|\.(develop\.)?my\.salesforce\.com||')

# Detect if org is develop or prod domain
if [[ "$MY_DOMAIN_HOST" == *".develop."* ]]; then
    SCRT2_URL="https://${MY_DOMAIN_PREFIX}.develop.my.salesforce-scrt.com"
    if [[ -z "$COMMUNITY_SITE_URL" ]]; then
        COMMUNITY_SITE_URL="https://${MY_DOMAIN_PREFIX}.develop.my.site.com/ESW${DEPLOYMENT_NAME}"
    fi
else
    SCRT2_URL="https://${MY_DOMAIN_PREFIX}.my.salesforce-scrt.com"
    if [[ -z "$COMMUNITY_SITE_URL" ]]; then
        COMMUNITY_SITE_URL="https://${MY_DOMAIN_PREFIX}.my.site.com/ESW${DEPLOYMENT_NAME}"
    fi
fi

SNIPPET_DEPLOYMENT="${DEPLOYMENT_NAME}"

# Generate the front-end snippet
SNIPPET_FILE="${SCRIPT_DIR}/test_embedded_chat.html"
cat << EOF > "$SNIPPET_FILE"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Embedded Messaging Test Client</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: linear-gradient(135deg, #0b1528 0%, #172a4d 100%);
            color: #ffffff;
            margin: 0;
            padding: 40px;
            min-height: 100vh;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .container {
            max-width: 800px;
            width: 100%;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 32px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
        h1 { margin-top: 0; color: #0176D3; font-size: 28px; }
        .badge {
            display: inline-block;
            background: #2e844a;
            color: #ffffff;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: bold;
            margin-bottom: 20px;
        }
        .config-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        .config-table td { padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
        .config-table td.label { font-weight: bold; width: 220px; color: #9aaec7; }
        .config-table td.value { font-family: monospace; word-break: break-all; }
        .instructions { margin-top: 24px; padding: 16px; background: rgba(1, 118, 211, 0.1); border-left: 4px solid #0176D3; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Salesforce Embedded Messaging (MIAW)</h1>
        <div class="badge">Live Routed Omni-Channel Chat</div>
        <p>This page connects directly to your headless Salesforce Omni-Channel queue <strong>${QUEUE_DEV_NAME}</strong>.</p>

        <table class="config-table">
            <tr><td class="label">Org ID:</td><td class="value">${ORG_ID}</td></tr>
            <tr><td class="label">Deployment:</td><td class="value">${SNIPPET_DEPLOYMENT}</td></tr>
            <tr><td class="label">Site URL:</td><td class="value">${COMMUNITY_SITE_URL}</td></tr>
            <tr><td class="label">SCRT 2.0 URL:</td><td class="value">${SCRT2_URL}</td></tr>
            <tr><td class="label">Target Queue:</td><td class="value">${QUEUE_DEV_NAME}</td></tr>
            <tr><td class="label">Presence Status:</td><td class="value">${PRESENCE_STATUS}</td></tr>
        </table>

        <div class="instructions">
            <strong>Agent Testing Instructions:</strong>
            <ol>
                <li>Open the <strong>Service Console</strong> in Salesforce.</li>
                <li>In the bottom utility bar, open the <strong>Omni-Channel</strong> widget.</li>
                <li>Set your presence status to <strong>${PRESENCE_STATUS}</strong>.</li>
                <li>Click the chat bubble in the bottom right corner of this page to initiate an inbound session.</li>
            </ol>
        </div>
    </div>

    <!-- Salesforce Embedded Messaging (MIAW) Client Snippet -->
    <script type='text/javascript'>
        function initEmbeddedMessaging() {
            try {
                embeddedservice_bootstrap.settings.language = 'en_US';
                embeddedservice_bootstrap.init(
                    '${ORG_ID}',
                    '${SNIPPET_DEPLOYMENT}',
                    '${COMMUNITY_SITE_URL}',
                    {
                        scrt2URL: '${SCRT2_URL}'
                    }
                );
            } catch (err) {
                console.error('Error initializing Embedded Messaging:', err);
            }
        };

        // Salesforce Messaging for Web Native Client Event Listener (SSE)
        window.addEventListener("onEmbeddedMessageSent", (event) => {
            console.log("[Client Page] Native onEmbeddedMessageSent event captured:", event.detail);
        });
    </script>
    <script type='text/javascript' src='${COMMUNITY_SITE_URL}/assets/js/bootstrap.min.js' onload='initEmbeddedMessaging()'></script>
</body>
</html>
EOF

# ==============================================================================
# Phase 6 (Optional): Reconfigure Messaging Channels for Omni-Flow with t100
# ==============================================================================
# The t2 routing flow handles Omni-Channel session routing (skills-based with
# on-hold logic). The t100 record-triggered flow fires on MessagingSession
# updates (escalation, status changes) and invokes t2 as a subflow to re-route.
# AI_Bot_Holding_Queue_100 holds sessions while the AI processes them.
# This phase lets the user point any existing MessagingChannel at that pipeline.
# ==============================================================================

if [[ "$CONFIGURE_CHANNELS" == "SKIP" ]]; then
    log_info "Phase 6: Skipped (--skip-channel-config)"
else
    log_phase "Phase 6 (Optional): Reconfigure Messaging Channels for Omni-Flow (t2 + t100)"

    OMNI_FLOW_NAME="t2"
    OMNI_FALLBACK_QUEUE_NAME="AI_Bot_Holding_Queue_100"

    # Verify prerequisites: active t2 RoutingFlow + AI fallback queue
    PREREQUISITE_QUERIES=$(jq -cn --arg flow "SELECT DurableId FROM FlowDefinitionView WHERE ApiName = '${OMNI_FLOW_NAME}' AND IsActive = true LIMIT 1" \
        --arg queue "SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = '${OMNI_FALLBACK_QUEUE_NAME}' LIMIT 1" \
        --arg t100 "SELECT DurableId FROM FlowDefinitionView WHERE ApiName = 't100' AND IsActive = true LIMIT 1" \
        '[$flow,$queue,$t100]')
    PREREQUISITE_BATCH=$(salesforce_query_group "$PREREQUISITE_QUERIES")
    T2_FLOW_ID=$(jq -r '.results[0].result.records[0].DurableId // empty' <<< "$PREREQUISITE_BATCH")
    AI_QUEUE_ID=$(jq -r '.results[1].result.records[0].Id // empty' <<< "$PREREQUISITE_BATCH")
    T100_ID=$(jq -r '.results[2].result.records[0].DurableId // empty' <<< "$PREREQUISITE_BATCH")

    if [[ -z "$T2_FLOW_ID" ]]; then
        log_warn "Routing flow '${OMNI_FLOW_NAME}' not found or inactive. Skipping channel reconfiguration."
        log_info "Deploy the t2 and t100 flows first (see: bun scripts/restore-flows.ts --target-org ${TARGET_ORG})"
    elif [[ -z "$AI_QUEUE_ID" ]]; then
        log_warn "Fallback queue '${OMNI_FALLBACK_QUEUE_NAME}' not found. Skipping channel reconfiguration."
    else
        if [[ -n "$T100_ID" ]]; then
            log_success "Prerequisites: t2 routing flow (${T2_FLOW_ID}), t100 record-trigger active, ${OMNI_FALLBACK_QUEUE_NAME} (${AI_QUEUE_ID})"
        else
            log_warn "Record-triggered flow 't100' is not active; escalation re-routing will not fire automatically."
            log_info "t2 (${T2_FLOW_ID}) and ${OMNI_FALLBACK_QUEUE_NAME} (${AI_QUEUE_ID}) are available."
        fi

        # Discover all channels with current routing state
        ALL_CHANNELS=$(salesforce_query \
            "SELECT Id, MasterLabel, DeveloperName, MessageType, IsActive, SessionHandlerId, FallbackQueueId FROM MessagingChannel ORDER BY MasterLabel")
        TOTAL=$(echo "$ALL_CHANNELS" | jq -r '.result.totalSize // 0')

        if [[ "$TOTAL" -eq 0 ]]; then
            log_warn "No MessagingChannels found in ${TARGET_ORG}."
        else
            echo ""
            echo -e "${BOLD}Messaging Channels in ${TARGET_ORG}:${NC}"
            echo -e "────────────────────────────────────────────────────────────────"

            CONFIGURABLE_COUNT=0
            for i in $(seq 0 $((TOTAL - 1))); do
                C_LABEL=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$i].MasterLabel")
                C_DEV=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$i].DeveloperName")
                C_TYPE=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$i].MessageType")
                C_ACTIVE=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$i].IsActive")
                C_HANDLER=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$i].SessionHandlerId // empty")
                C_FB=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$i].FallbackQueueId // empty")

                # Classify current routing
                if [[ "$C_HANDLER" == "$T2_FLOW_ID" && "$C_FB" == "$AI_QUEUE_ID" ]]; then
                    C_STATUS="${GREEN}✓ Omni-Flow (t2 + AI fallback)${NC}"
                elif [[ -n "$C_HANDLER" && "$C_HANDLER" == 300* ]]; then
                    C_STATUS="${YELLOW}Flow-based (other)${NC}"
                    CONFIGURABLE_COUNT=$((CONFIGURABLE_COUNT + 1))
                elif [[ -n "$C_HANDLER" && "$C_HANDLER" == 0Xx* ]]; then
                    C_STATUS="${YELLOW}Agentforce Agent${NC}"
                    CONFIGURABLE_COUNT=$((CONFIGURABLE_COUNT + 1))
                elif [[ -n "$C_HANDLER" && "$C_HANDLER" == 00G* ]]; then
                    C_STATUS="Queue-based"
                    CONFIGURABLE_COUNT=$((CONFIGURABLE_COUNT + 1))
                else
                    C_STATUS="Unassigned"
                    CONFIGURABLE_COUNT=$((CONFIGURABLE_COUNT + 1))
                fi

                DOT="${RED}○${NC}"
                [[ "$C_ACTIVE" == "true" ]] && DOT="${GREEN}●${NC}"

                echo -e "  ${BOLD}$((i + 1)))${NC} ${DOT} ${C_LABEL} (${CYAN}${C_DEV}${NC}) [${C_TYPE}] — ${C_STATUS}"
            done
            echo ""

            if [[ "$CONFIGURABLE_COUNT" -eq 0 ]]; then
                log_success "All channels are already configured for Omni-Flow t2 + AI fallback."
            else
                # Determine selection: CLI flag, interactive prompt, or skip
                USER_SELECTION=""
                if [[ -n "$CONFIGURE_CHANNELS" && "$CONFIGURE_CHANNELS" != "SKIP" ]]; then
                    # Non-interactive: resolve DeveloperNames to indices
                    if [[ "$CONFIGURE_CHANNELS" == "ALL" ]]; then
                        USER_SELECTION=$(seq -s',' 1 "$TOTAL")
                        log_info "Auto-selecting all channels (--configure-channels ALL)"
                    else
                        RESOLVED_INDICES=""
                        IFS=',' read -ra NAMED_CHANNELS <<< "$CONFIGURE_CHANNELS"
                        for NAMED in "${NAMED_CHANNELS[@]}"; do
                            NAMED=$(echo "$NAMED" | tr -d ' ')
                            for j in $(seq 0 $((TOTAL - 1))); do
                                J_DEV=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$j].DeveloperName")
                                if [[ "$J_DEV" == "$NAMED" ]]; then
                                    RESOLVED_INDICES="${RESOLVED_INDICES}$((j + 1)),"
                                    break
                                fi
                            done
                        done
                        USER_SELECTION="${RESOLVED_INDICES%,}"
                        log_info "Targeting channels: ${CONFIGURE_CHANNELS} → indices [${USER_SELECTION}]"
                    fi
                elif [[ -t 0 ]]; then
                    # Interactive: prompt user
                    echo -e "${YELLOW}Select channel(s) to reconfigure for Omni-Flow with t100 (comma-separated numbers), or Enter to skip:${NC}"
                    read -r USER_SELECTION
                else
                    log_info "Non-interactive session; pass --configure-channels to reconfigure channels."
                fi

                if [[ -n "$USER_SELECTION" ]]; then
                    # Create disposable SFDX project (namespace-free) for retrieve-modify-deploy
                    OMNI_TMP=$(mktemp -d -t omni-flow-XXXXXX)
                    cat > "${OMNI_TMP}/sfdx-project.json" << 'SFDXEOF'
{"packageDirectories":[{"path":"force-app","default":true}],"namespace":"","sourceApiVersion":"67.0"}
SFDXEOF
                    mkdir -p "${OMNI_TMP}/force-app"

                    CONFIGURED_CHANNELS=()

                    IFS=',' read -ra PICKS <<< "$USER_SELECTION"
                    for PICK in "${PICKS[@]}"; do
                        PICK=$(echo "$PICK" | tr -d ' ')
                        if ! [[ "$PICK" =~ ^[0-9]+$ ]] || (( PICK < 1 || PICK > TOTAL )); then
                            log_warn "Invalid selection '${PICK}', skipping."
                            continue
                        fi

                        IDX=$((PICK - 1))
                        SEL_DEV=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$IDX].DeveloperName")
                        SEL_LABEL=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$IDX].MasterLabel")
                        SEL_HANDLER=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$IDX].SessionHandlerId // empty")
                        SEL_FB=$(echo "$ALL_CHANNELS" | jq -r ".result.records[$IDX].FallbackQueueId // empty")

                        # Skip if already configured
                        if [[ "$SEL_HANDLER" == "$T2_FLOW_ID" && "$SEL_FB" == "$AI_QUEUE_ID" ]]; then
                            log_info "'${SEL_LABEL}' already uses Omni-Flow t2 + AI fallback. Skipping."
                            continue
                        fi

                        log_info "Reconfiguring '${SEL_LABEL}' (${SEL_DEV})..."

                        # ── Retrieve channel metadata ──
                        rm -rf "${OMNI_TMP}/.ch-stage" "${OMNI_TMP}/.ch-verify"
                        (cd "${OMNI_TMP}" && sf project retrieve start \
                            --metadata "MessagingChannel:${SEL_DEV}" \
                            --target-org "${TARGET_ORG}" \
                            --output-dir ".ch-stage" --json 2>/dev/null) >/dev/null 2>&1 || true

                        MC_FILE="${OMNI_TMP}/.ch-stage/messagingChannels/${SEL_DEV}.messagingChannel-meta.xml"
                        if [[ ! -f "$MC_FILE" ]]; then
                            log_error "  Retrieve failed for '${SEL_DEV}'. Skipping."
                            continue
                        fi

                        # ── Show before state ──
                        B_TYPE=$(grep -oP '(?<=<sessionHandlerType>)[^<]+' "$MC_FILE" 2>/dev/null || echo "none")
                        B_FLOW=$(grep -oP '(?<=<sessionHandlerFlow>)[^<]+' "$MC_FILE" 2>/dev/null || echo "none")
                        B_QUEUE=$(grep -oP '(?<=<sessionHandlerQueue>)[^<]+' "$MC_FILE" 2>/dev/null || echo "none")
                        log_info "  Before: type=${B_TYPE} flow=${B_FLOW} queue=${B_QUEUE}"

                        # ── Modify XML: set sessionHandlerType=Flow, sessionHandlerFlow=t2,
                        #    sessionHandlerQueue=AI_Bot_Holding_Queue_100 ──
                        python3 -c "
import sys, re
path, flow_name, queue_name = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    xml = f.read()
def set_field(xml, tag, value):
    pattern = rf'<{tag}>[^<]*</{tag}>'
    repl = f'<{tag}>{value}</{tag}>'
    if re.search(pattern, xml):
        return re.sub(pattern, repl, xml)
    return xml.replace('</MessagingChannel>', f'    {repl}\n</MessagingChannel>')
xml = set_field(xml, 'sessionHandlerType', 'Flow')
xml = set_field(xml, 'sessionHandlerFlow', flow_name)
xml = set_field(xml, 'sessionHandlerQueue', queue_name)
with open(path, 'w') as f:
    f.write(xml)
" "$MC_FILE" "$OMNI_FLOW_NAME" "$OMNI_FALLBACK_QUEUE_NAME"

                        # ── Deploy ──
                        DEP_OUT=$(cd "${OMNI_TMP}" && sf project deploy start \
                            --source-dir ".ch-stage" \
                            --target-org "${TARGET_ORG}" \
                            --wait ${WAIT_TIME} --concise --json 2>/dev/null || true)
                        DEP_OK=$(echo "$DEP_OUT" | jq -r '.result.success // false')

                        if [[ "$DEP_OK" != "true" ]]; then
                            DEP_ERR=$(echo "$DEP_OUT" | jq -r '.result.details.componentFailures[0].problem // .message // "unknown"')
                            log_error "  Deploy failed: ${DEP_ERR}"
                            continue
                        fi

                        # ── Blind verify via re-retrieve ──
                        (cd "${OMNI_TMP}" && sf project retrieve start \
                            --metadata "MessagingChannel:${SEL_DEV}" \
                            --target-org "${TARGET_ORG}" \
                            --output-dir ".ch-verify" --json 2>/dev/null) >/dev/null 2>&1 || true

                        VF="${OMNI_TMP}/.ch-verify/messagingChannels/${SEL_DEV}.messagingChannel-meta.xml"
                        if [[ -f "$VF" ]]; then
                            A_TYPE=$(grep -oP '(?<=<sessionHandlerType>)[^<]+' "$VF" 2>/dev/null || echo "?")
                            A_FLOW=$(grep -oP '(?<=<sessionHandlerFlow>)[^<]+' "$VF" 2>/dev/null || echo "?")
                            A_QUEUE=$(grep -oP '(?<=<sessionHandlerQueue>)[^<]+' "$VF" 2>/dev/null || echo "?")

                            if [[ "$A_TYPE" == "Flow" && "$A_FLOW" == "$OMNI_FLOW_NAME" && "$A_QUEUE" == "$OMNI_FALLBACK_QUEUE_NAME" ]]; then
                                log_success "  ✓ Verified: type=Flow flow=${A_FLOW} queue=${A_QUEUE}"
                                CONFIGURED_CHANNELS+=("$SEL_DEV")
                            else
                                log_warn "  Verification mismatch: type=${A_TYPE} flow=${A_FLOW} queue=${A_QUEUE}"
                            fi
                        else
                            # Fallback: blind verify via SOQL
                            V_JSON=$(salesforce_query \
                                "SELECT SessionHandlerId, FallbackQueueId FROM MessagingChannel WHERE DeveloperName = '${SEL_DEV}' LIMIT 1")
                            V_H=$(echo "$V_JSON" | jq -r '.result.records[0].SessionHandlerId // empty')
                            V_F=$(echo "$V_JSON" | jq -r '.result.records[0].FallbackQueueId // empty')

                            if [[ "$V_H" == "$T2_FLOW_ID" && "$V_F" == "$AI_QUEUE_ID" ]]; then
                                log_success "  ✓ Verified (SOQL): handler=${V_H} fallback=${V_F}"
                                CONFIGURED_CHANNELS+=("$SEL_DEV")
                            else
                                log_warn "  Verification note: handler=${V_H} fallback=${V_F} (expected ${T2_FLOW_ID}, ${AI_QUEUE_ID})"
                            fi
                        fi

                        rm -rf "${OMNI_TMP}/.ch-stage" "${OMNI_TMP}/.ch-verify"
                    done

                    # Clean up temp project
                    rm -rf "$OMNI_TMP"

                    if [[ ${#CONFIGURED_CHANNELS[@]} -gt 0 ]]; then
                        log_success "Phase 6: Configured ${#CONFIGURED_CHANNELS[@]} channel(s) for Omni-Flow: ${CONFIGURED_CHANNELS[*]}"
                    else
                        log_warn "Phase 6: No channels were successfully reconfigured."
                    fi
                else
                    log_info "Skipping optional channel reconfiguration."
                fi
            fi
        fi
    fi
fi

chmod +x "${SCRIPT_DIR}/setup_messaging_omnichannel.sh"

echo -e "\n${GREEN}${BOLD}==========================================================================${NC}"
echo -e "${GREEN}${BOLD}    Omni-Channel & Embedded Messaging Setup Completed Successfully!       ${NC}"
echo -e "${GREEN}${BOLD}==========================================================================${NC}"
echo -e "Target Org ID:       ${BOLD}${ORG_ID}${NC}"
echo -e "Provisioned Agent:   ${BOLD}selected Salesforce user${NC}"
echo -e "Messaging Channel:   ${BOLD}${CHANNEL_NAME}${NC} (Active)"
echo -e "Queue:               ${BOLD}${QUEUE_DEV_NAME}${NC} (Id: ${PROV_QUEUE_ID:-resolved})"
echo -e "Permission Set:      ${BOLD}${PERM_SET_NAME}${NC} (Id: ${PROV_PS_ID:-resolved})"
echo -e "Presence Status:     ${BOLD}${PRESENCE_STATUS}${NC}"
echo -e "Deployment:          ${BOLD}${SNIPPET_DEPLOYMENT}${NC}"
echo -e "Test Client Page:    ${BOLD}${SNIPPET_FILE}${NC}"
echo ""
echo -e "${CYAN}${BOLD}--- Front-End Web Snippet (Paste into HTML <head>/<body>) ---${NC}"
cat << EOF
<script type='text/javascript'>
  function initEmbeddedMessaging() {
    try {
      embeddedservice_bootstrap.settings.language = 'en_US';
      embeddedservice_bootstrap.init(
        '${ORG_ID}',
        '${SNIPPET_DEPLOYMENT}',
        '${COMMUNITY_SITE_URL}',
        {
          scrt2URL: '${SCRT2_URL}'
        }
      );
    } catch (err) {
      console.error('Error loading Embedded Messaging:', err);
    }
  };
</script>
<script type='text/javascript' src='${COMMUNITY_SITE_URL}/assets/js/bootstrap.min.js' onload='initEmbeddedMessaging()'></script>
EOF
echo -e "${CYAN}${BOLD}------------------------------------------------------------${NC}\n"
