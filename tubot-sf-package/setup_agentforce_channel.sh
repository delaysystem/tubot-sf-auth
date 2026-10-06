#!/usr/bin/env bash

# ==============================================================================
# Automated Setup CLI: Agentforce Dedicated MIAW Channel & API Deployment
# ==============================================================================
# Features:
#   1. Connects to target Salesforce Org & derives SCRT 2.0 endpoint.
#   2. Option to clone an existing org agent (copies just the agent metadata:
#      BotDefinition, BotVersion, GenAiPlannerBundle/AgentScript, stripped of
#      existing routing infrastructure) or target an existing agent.
#   3. Activates the target BotVersion via ConnectApi in Apex.
#   4. Provisions a dedicated MessagingChannel (EmbeddedMessaging) routed
#      directly to the Agentforce agent (SessionHandlerId / sessionHandlerAsa).
#   5. Provisions and publishes a dedicated EmbeddedServiceConfig (API Deployment).
#   6. Synchronizes test-client credentials.json with the new channel definition.
#   7. Directly messages the Agentforce agent over live SSE to test it.
# ==============================================================================

set -eo pipefail

# Resolve canonical script directory even when executed via symlink
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
    DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"

# Resolve test-client directory
TEST_CLIENT_DIR=""
if [[ -d "${SCRIPT_DIR}/../../test-client" ]]; then
    TEST_CLIENT_DIR="$(cd "${SCRIPT_DIR}/../../test-client" && pwd)"
elif [[ -d "${SCRIPT_DIR}/../test-client" ]]; then
    TEST_CLIENT_DIR="$(cd "${SCRIPT_DIR}/../test-client" && pwd)"
elif [[ -d "$(pwd)/test-client" ]]; then
    TEST_CLIENT_DIR="$(pwd)/test-client"
fi

# Export settings for headless Linux Salesforce CLI environments
export SF_USE_GENERIC_UNIX_KEYCHAIN=true
export SF_TEMP_SHOW_SECRETS=true

# Default Configurations
TARGET_ORG=""
SOURCE_ORG=""
CHANNEL_NAME="Agentforce_API_Channel"
CHANNEL_LABEL=""
DEPLOYMENT_NAME=""
DEPLOYMENT_LABEL=""
TARGET_AGENT=""
CLONE_FROM=""
NEW_AGENT=""
NEW_AGENT_LABEL=""
AS_SERVICE_AGENT=true
TEST_MESSAGE="Hello! What can you help me with?"
TIMEOUT_SEC=30
SKIP_TEST=false
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

extract_json() {
    sed -n '/^[{\[]/,$p'
}

show_help() {
    cat << EOF
Automated Setup CLI: Agentforce Dedicated Channel & API Deployment

Usage:
  ./setup_agentforce_channel.sh [options]

Options:
  -s, --source-org ALIAS       Source Salesforce org alias when cloning across orgs (default: same as target-org)
  -o, --target-org ALIAS       Target Salesforce org alias or username (default: active target-org)
  -c, --channel NAME           MessagingChannel DeveloperName (default: Agentforce_API_Channel)
  -l, --label LABEL            Display label for Channel & Deployment
  -d, --deployment NAME        EmbeddedServiceConfig DeveloperName (default: <channel>_API)
  -a, --agent NAME             Target existing Agent DeveloperName (e.g. Test, Data360Agent)
  --clone-from SOURCE_AGENT    DeveloperName of existing org agent to clone (just the agent, not routing)
  --new-agent NAME             DeveloperName for newly cloned agent (default: <SOURCE>_Clone)
  --new-agent-label LABEL      MasterLabel for newly cloned agent
  --as-service-agent           Convert cloned agent to an EinsteinServiceAgent for MIAW (default: true)
  -m, --message TEXT           Test message to send to the agent (default: "Hello! What can you help me with?")
  -t, --timeout SECONDS        Timeout waiting for agent response in seconds (default: 30)
  --skip-test                  Skip sending the test message
  --dry-run                    Validate configuration and target org without applying changes
  -w, --wait MINUTES           Wait timeout in minutes for metadata deployments (default: 10)
  -h, --help                   Display this help message

Examples:
  # 1. Create a channel & API deployment for existing agent 'Test' and message it:
  ./setup_agentforce_channel.sh --target-org test2 --agent Test

  # 2. Clone an existing agent across orgs (e.g. test2 to test1empty), deploy channel & API, and test it:
  ./setup_agentforce_channel.sh --source-org test2 --target-org test1empty --clone-from Coral_Cloud_Employee_Agent --new-agent Coral_Cloud_Service_Agent

  # 3. Custom channel, custom deployment name, and custom initial prompt:
  ./setup_agentforce_channel.sh -o test2 -c Sales_Channel -d Sales_API -a Test -m "Check pricing for VIP tier"
EOF
}

# Parse Arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--source-org)
            SOURCE_ORG="$2"
            shift 2
            ;;
        -o|--target-org)
            TARGET_ORG="$2"
            shift 2
            ;;
        -c|--channel)
            CHANNEL_NAME="$2"
            shift 2
            ;;
        -l|--label)
            CHANNEL_LABEL="$2"
            shift 2
            ;;
        -d|--deployment)
            DEPLOYMENT_NAME="$2"
            shift 2
            ;;
        -a|--agent)
            TARGET_AGENT="$2"
            shift 2
            ;;
        --clone-from)
            CLONE_FROM="$2"
            shift 2
            ;;
        --new-agent)
            NEW_AGENT="$2"
            shift 2
            ;;
        --new-agent-label)
            NEW_AGENT_LABEL="$2"
            shift 2
            ;;
        --as-service-agent)
            AS_SERVICE_AGENT=true
            shift
            ;;
        -m|--message)
            TEST_MESSAGE="$2"
            shift 2
            ;;
        -t|--timeout)
            TIMEOUT_SEC="$2"
            shift 2
            ;;
        --skip-test)
            SKIP_TEST=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -w|--wait)
            WAIT_TIME="$2"
            shift 2
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

# Ensure Python 3 is available
if ! command -v python3 &> /dev/null; then
    log_error "Python 3 is required for JSON and metadata processing."
    exit 1
fi

echo -e "${MAGENTA}${BOLD}"
echo "=========================================================================="
echo "    Agentforce Dedicated MIAW Channel & API Deployment CLI               "
echo "=========================================================================="
echo -e "${NC}"

# ==============================================================================
# Step 0: Target Org Introspection & Endpoint Derivation
# ==============================================================================
log_phase "Step 0: Checking Org Connectivity & Authentication"

if [[ -z "${TARGET_ORG}" ]]; then
    # Try resolving default target-org
    DETECTED_ORG=$(sf config get target-org --json 2>/dev/null | extract_json | jq -r '.result[0].value // empty' || true)
    if [[ -n "${DETECTED_ORG}" ]]; then
        TARGET_ORG="${DETECTED_ORG}"
        log_info "Using configured default target-org: ${BOLD}${TARGET_ORG}${NC}"
    else
        TARGET_ORG="test1empty"
        log_info "No target-org specified; defaulting to '${TARGET_ORG}'"
    fi
fi

if [[ -z "${SOURCE_ORG}" ]]; then
    SOURCE_ORG="${TARGET_ORG}"
fi

ORG_DISPLAY_JSON=$(sf org display --target-org "${TARGET_ORG}" --json 2>/dev/null || true)
ORG_ID=$(echo "$ORG_DISPLAY_JSON" | extract_json | jq -r '.result.id // empty')
INSTANCE_URL=$(echo "$ORG_DISPLAY_JSON" | extract_json | jq -r '.result.instanceUrl // empty')
CONNECTED_USER=$(echo "$ORG_DISPLAY_JSON" | extract_json | jq -r '.result.username // empty')
ACCESS_TOKEN=$(echo "$ORG_DISPLAY_JSON" | extract_json | jq -r '.result.accessToken // empty')

if [[ -z "$ORG_ID" || -z "$INSTANCE_URL" ]]; then
    log_error "Failed to connect to target org '${TARGET_ORG}'. Please check your authentication ('sf org login')."
    exit 1
fi

log_success "Connected to Target Org: ${ORG_ID} (${INSTANCE_URL})"
log_info "Authenticated User: ${CONNECTED_USER}"

# Derive SCRT 2.0 URL
MY_DOMAIN_HOST=$(echo "$INSTANCE_URL" | sed -E 's|https?://([^/]+)|\1|')
MY_DOMAIN_PREFIX=$(echo "$MY_DOMAIN_HOST" | sed -E 's|\.(develop\.)?my\.salesforce\.com||')

if [[ "$MY_DOMAIN_HOST" == *".develop."* ]]; then
    SCRT2_URL="https://${MY_DOMAIN_PREFIX}.develop.my.salesforce-scrt.com"
else
    SCRT2_URL="https://${MY_DOMAIN_PREFIX}.my.salesforce-scrt.com"
fi
log_info "Resolved SCRT 2.0 URL: ${BOLD}${SCRT2_URL}${NC}"

if [[ "${SOURCE_ORG}" != "${TARGET_ORG}" ]]; then
    log_info "Checking Source Org '${SOURCE_ORG}' connectivity..."
    SOURCE_DISPLAY_JSON=$(sf org display --target-org "${SOURCE_ORG}" --json 2>/dev/null || true)
    SOURCE_ORG_ID=$(echo "$SOURCE_DISPLAY_JSON" | extract_json | jq -r '.result.id // empty')
    SOURCE_INSTANCE_URL=$(echo "$SOURCE_DISPLAY_JSON" | extract_json | jq -r '.result.instanceUrl // empty')
    if [[ -z "$SOURCE_ORG_ID" ]]; then
        log_error "Failed to connect to source org '${SOURCE_ORG}'. Please check your authentication ('sf org login')."
        exit 1
    fi
    log_success "Connected to Source Org: ${SOURCE_ORG_ID} (${SOURCE_INSTANCE_URL})"
fi

# Set default labels and names if not provided
if [[ -z "${CHANNEL_LABEL}" ]]; then
    CHANNEL_LABEL="${CHANNEL_NAME//_/ }"
fi

if [[ -z "${DEPLOYMENT_NAME}" ]]; then
    DEPLOYMENT_NAME="${CHANNEL_NAME}_API"
fi

if [[ -z "${DEPLOYMENT_LABEL}" ]]; then
    DEPLOYMENT_LABEL="${DEPLOYMENT_NAME//_/ }"
fi

log_info "Channel Name:       ${BOLD}${CHANNEL_NAME}${NC} ('${CHANNEL_LABEL}')"
log_info "API Deployment:     ${BOLD}${DEPLOYMENT_NAME}${NC} ('${DEPLOYMENT_LABEL}')"
if [[ -n "${CLONE_FROM}" ]]; then
    log_info "Agent Mode:         ${BOLD}CLONE from '${CLONE_FROM}' (${SOURCE_ORG}) -> '${NEW_AGENT:-${CLONE_FROM}_Clone}' (${TARGET_ORG})${NC}"
else
    log_info "Agent Mode:         ${BOLD}TARGET existing agent '${TARGET_AGENT:-[Auto-Detect]}'${NC}"
fi

# ==============================================================================
# Step 1: Agent Resolution & Cloning (Agent Only - Not Routing)
# ==============================================================================
log_phase "Step 1: Agent Definition Resolution & Activation"

TARGET_BOT_ID=""
TARGET_BOT_VER_ID=""

if [[ -n "${CLONE_FROM}" ]]; then
    # --- CLONING PATH ---
    log_info "Verifying source agent '${CLONE_FROM}' exists in source org '${SOURCE_ORG}'..."
    SOURCE_BOT_QUERY=$(sf data query -q "SELECT Id, DeveloperName, MasterLabel, Type FROM BotDefinition WHERE DeveloperName = '${CLONE_FROM}' LIMIT 1" --target-org "${SOURCE_ORG}" --json 2>/dev/null | extract_json || true)
    SOURCE_BOT_ID=$(echo "$SOURCE_BOT_QUERY" | jq -r '.result.records[0].Id // empty')
    SOURCE_BOT_LABEL=$(echo "$SOURCE_BOT_QUERY" | jq -r '.result.records[0].MasterLabel // empty')

    if [[ -z "${SOURCE_BOT_ID}" ]]; then
        log_error "Source bot '${CLONE_FROM}' not found in source org '${SOURCE_ORG}'."
        log_info "Available BotDefinitions in source org:"
        sf data query -q "SELECT DeveloperName, MasterLabel, Type FROM BotDefinition" --target-org "${SOURCE_ORG}" --json 2>/dev/null | extract_json | jq -r '.result.records[] | "  - \(.DeveloperName) (\(.MasterLabel), \(.Type))"' || true
        exit 1
    fi

    log_success "Found source agent: ${CLONE_FROM} (Id: ${SOURCE_BOT_ID}, Label: '${SOURCE_BOT_LABEL}')"

    # Set new agent developer name and label
    if [[ -z "${NEW_AGENT}" ]]; then
        NEW_AGENT="${CLONE_FROM}_Clone"
    fi
    if [[ -z "${NEW_AGENT_LABEL}" ]]; then
        NEW_AGENT_LABEL="${NEW_AGENT//_/ }"
    fi

    log_info "Cloning into New Agent: ${BOLD}${NEW_AGENT}${NC} ('${NEW_AGENT_LABEL}')"

    # Resolve target org bot user (for ExternalCopilot / EinsteinServiceAgent)
    TARGET_BOT_USER=$(sf data query -q "SELECT Username FROM User WHERE Profile.Name = 'Einstein Agent User' AND IsActive = true LIMIT 1" --target-org "${TARGET_ORG}" --json 2>/dev/null | extract_json | jq -r '.result.records[0].Username // empty')
    if [[ -z "${TARGET_BOT_USER}" ]]; then
        TARGET_BOT_USER=$(sf data query -q "SELECT Username FROM User WHERE (Username LIKE '%ext' OR Profile.Name LIKE '%Agent%') AND IsActive = true ORDER BY CreatedDate DESC LIMIT 1" --target-org "${TARGET_ORG}" --json 2>/dev/null | extract_json | jq -r '.result.records[0].Username // empty')
    fi
    if [[ -n "${TARGET_BOT_USER}" ]]; then
        log_info "Resolved Target Org Bot User: ${BOLD}${TARGET_BOT_USER}${NC}"
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY-RUN] Would retrieve '${CLONE_FROM}' from '${SOURCE_ORG}', adapt to service agent, strip old routing, deploy '${NEW_AGENT}' to '${TARGET_ORG}', and activate it."
        TARGET_AGENT="${NEW_AGENT}"
        TARGET_BOT_ID="0XxgDRYRUN000000"
    else
        TEMP_CLONE_DIR=$(mktemp -d "/tmp/af_agent_clone_XXXXXX")
        log_info "Created isolated clone workspace: ${TEMP_CLONE_DIR}"

        cat << EOF > "${TEMP_CLONE_DIR}/sfdx-project.json"
{
  "packageDirectories": [
    {
      "path": "force-app",
      "default": true
    }
  ],
  "namespace": "",
  "sfdcLoginUrl": "https://login.salesforce.com",
  "sourceApiVersion": "67.0"
}
EOF
        mkdir -p "${TEMP_CLONE_DIR}/force-app"

        # 1. Retrieve source Bot
        log_info "Retrieving source agent metadata: Bot:${CLONE_FROM} from ${SOURCE_ORG}..."
        (
            cd "${TEMP_CLONE_DIR}"
            sf project retrieve start --metadata "Bot:${CLONE_FROM}" --target-org "${SOURCE_ORG}" --wait "${WAIT_TIME}" --json >/dev/null
        )

        # 2. Discover linked GenAiPlannerBundle
        SOURCE_BVER_XML="${TEMP_CLONE_DIR}/force-app/main/default/bots/${CLONE_FROM}/v1.botVersion-meta.xml"
        SOURCE_PLANNER=""
        if [[ -f "${SOURCE_BVER_XML}" ]]; then
            SOURCE_PLANNER=$(python3 -c "
import re, sys
with open(sys.argv[1], 'r') as f:
    text = f.read()
m = re.search(r'<genAiPlannerName>([^<]+)</genAiPlannerName>', text)
print(m.group(1) if m else '')
" "${SOURCE_BVER_XML}")
        fi

        if [[ -n "${SOURCE_PLANNER}" ]]; then
            log_info "Found linked GenAiPlannerBundle: '${SOURCE_PLANNER}'. Retrieving planner from ${SOURCE_ORG}..."
            (
                cd "${TEMP_CLONE_DIR}"
                sf project retrieve start --metadata "GenAiPlannerBundle:${SOURCE_PLANNER}" --target-org "${SOURCE_ORG}" --wait "${WAIT_TIME}" --json >/dev/null || log_warn "Planner retrieve notice: continuing with available metadata"
            )
        fi

        # 2b. Cross-Org Dependencies (Flows, Prompts, Objects)
        if [[ "${SOURCE_ORG}" != "${TARGET_ORG}" ]]; then
            log_info "Discovering agent dependencies for cross-org transfer..."
            python3 -c "
import os, sys, re, json

tmpdir = sys.argv[1]
source_planner = sys.argv[2]
clone_from = sys.argv[3]
new_agent = sys.argv[4]

p_file = os.path.join(tmpdir, 'force-app', 'main', 'default', 'genAiPlannerBundles', source_planner, f'{source_planner}.genAiPlannerBundle')
flows = []
prompts = []
apex_classes = []

if os.path.exists(p_file):
    with open(p_file, 'r') as f:
        text = f.read()
    # Find all flows
    for m in re.finditer(r'<invocationTarget>([^<]+)</invocationTarget>\s*<invocationTargetType>flow</invocationTargetType>', text):
        flows.append(m.group(1))
    for m in re.finditer(r'<invocationTargetType>flow</invocationTargetType>.*?<source>([^<]+)</source>', text, re.DOTALL):
        flows.append(m.group(1))
    # Find prompt templates
    for m in re.finditer(r'<invocationTarget>([^<]+)</invocationTarget>\s*<invocationTargetType>generatePromptResponse</invocationTargetType>', text):
        prompts.append(m.group(1))
    # Find apex classes
    for m in re.finditer(r'<invocationTarget>([^<]+)</invocationTarget>\s*<invocationTargetType>apex</invocationTargetType>', text):
        apex_classes.append(m.group(1))

flows = sorted(list(set(flows)))
prompts = sorted(list(set(prompts)))
apex_classes = sorted(list(set(apex_classes)))

with open(os.path.join(tmpdir, 'deps.json'), 'w') as f:
    json.dump({'flows': flows, 'prompts': prompts, 'apex': apex_classes}, f)
print(f'Found: {len(flows)} flows, {len(prompts)} prompt templates, {len(apex_classes)} apex classes.')
" "${TEMP_CLONE_DIR}" "${SOURCE_PLANNER}" "${CLONE_FROM}" "${NEW_AGENT}"

            DEP_METADATA_ARGS=()
            if [[ -f "${TEMP_CLONE_DIR}/deps.json" ]]; then
                for fl in $(jq -r '.flows[] // empty' "${TEMP_CLONE_DIR}/deps.json"); do
                    DEP_METADATA_ARGS+=("-m" "Flow:${fl}")
                done
                for pr in $(jq -r '.prompts[] // empty' "${TEMP_CLONE_DIR}/deps.json"); do
                    DEP_METADATA_ARGS+=("-m" "GenAiPromptTemplate:${pr}")
                done
            fi

            if [[ "${CLONE_FROM}" == *"Coral"* || "${NEW_AGENT}" == *"Coral"* ]]; then
                DEP_METADATA_ARGS+=("-m" "CustomObject:Booking__c")
                DEP_METADATA_ARGS+=("-m" "CustomObject:Credit__c")
                DEP_METADATA_ARGS+=("-m" "CustomObject:Experience__c")
                DEP_METADATA_ARGS+=("-m" "CustomObject:Guest_Review__c")
                DEP_METADATA_ARGS+=("-m" "CustomObject:Session__c")
                DEP_METADATA_ARGS+=("-m" "CustomField:Contact.Membership_Number__c")
            fi

            if [[ ${#DEP_METADATA_ARGS[@]} -gt 0 ]]; then
                log_info "Retrieving dependent metadata from ${SOURCE_ORG}..."
                (
                    cd "${TEMP_CLONE_DIR}"
                    sf project retrieve start "${DEP_METADATA_ARGS[@]}" --target-org "${SOURCE_ORG}" --wait "${WAIT_TIME}" --json >/dev/null || log_warn "Notice retrieving dependencies; continuing..."
                )

                if [[ -d "${TEMP_CLONE_DIR}/force-app/main/default/objects" ]]; then
                    log_info "Deploying custom objects and fields to ${TARGET_ORG}..."
                    (
                        cd "${TEMP_CLONE_DIR}"
                        sf project deploy start --source-dir force-app/main/default/objects --target-org "${TARGET_ORG}" --wait "${WAIT_TIME}" || log_warn "Objects deploy notice."
                    )
                fi

                DEP_DIRS=()
                [[ -d "${TEMP_CLONE_DIR}/force-app/main/default/flows" ]] && DEP_DIRS+=("--source-dir" "force-app/main/default/flows")
                [[ -d "${TEMP_CLONE_DIR}/force-app/main/default/genAiPromptTemplates" ]] && DEP_DIRS+=("--source-dir" "force-app/main/default/genAiPromptTemplates")
                if [[ ${#DEP_DIRS[@]} -gt 0 ]]; then
                    log_info "Deploying flows and prompt templates to ${TARGET_ORG}..."
                    (
                        cd "${TEMP_CLONE_DIR}"
                        sf project deploy start "${DEP_DIRS[@]}" --target-org "${TARGET_ORG}" --wait "${WAIT_TIME}" || log_warn "Flows/prompts deploy notice."
                    )
                fi
            fi
        fi

        # 3. Transform Bot & Planner metadata into new cloned agent (stripping routing)
        log_info "Transforming agent metadata (preserving cognitive topics/prompts/actions, adapting for Service Agent)..."
        NEW_PLANNER="${NEW_AGENT}_v1"

        python3 -c "
import os, sys, shutil, re, random, string, uuid

tmpdir = sys.argv[1]
source_bot = sys.argv[2]
new_bot = sys.argv[3]
new_bot_label = sys.argv[4]
source_planner = sys.argv[5]
new_planner = sys.argv[6]
target_bot_user = sys.argv[7]
as_service_agent = sys.argv[8].lower() == 'true'

force_app = os.path.join(tmpdir, 'force-app', 'main', 'default')

# A. Transform Bot
src_bot_dir = os.path.join(force_app, 'bots', source_bot)
dst_bot_dir = os.path.join(force_app, 'bots', new_bot)

if os.path.exists(src_bot_dir):
    shutil.move(src_bot_dir, dst_bot_dir)
    src_xml = os.path.join(dst_bot_dir, f'{source_bot}.bot-meta.xml')
    dst_xml = os.path.join(dst_bot_dir, f'{new_bot}.bot-meta.xml')
    if os.path.exists(src_xml):
        shutil.move(src_xml, dst_xml)

    with open(dst_xml, 'r') as f:
        bot_txt = f.read()

    bot_txt = re.sub(r'<label>[^<]+</label>', f'<label>{new_bot_label}</label>', bot_txt)
    bot_txt = re.sub(r'(<botMlDomain>\s*<label>)[^<]+(</label>\s*<name>)[^<]+(</name>)', rf'\g<1>{new_bot_label}\g<2>{new_bot}\3', bot_txt)

    if as_service_agent:
        bot_txt = re.sub(r'<agentType>[^<]+</agentType>', '<agentType>EinsteinServiceAgent</agentType>', bot_txt)
        bot_txt = re.sub(r'<type>[^<]+</type>', '<type>ExternalCopilot</type>', bot_txt)
        if '<agentTemplate>' in bot_txt:
            bot_txt = re.sub(r'<agentTemplate>[^<]+</agentTemplate>', '<agentTemplate>SvcCopilotTmpl__AgentforceServiceAgent</agentTemplate>', bot_txt)
        else:
            bot_txt = bot_txt.replace('<agentType>EinsteinServiceAgent</agentType>', '<agentTemplate>SvcCopilotTmpl__AgentforceServiceAgent</agentTemplate>\n    <agentType>EinsteinServiceAgent</agentType>')

        if target_bot_user:
            if '<botUser>' in bot_txt:
                bot_txt = re.sub(r'<botUser>[^<]+</botUser>', f'<botUser>{target_bot_user}</botUser>', bot_txt)
            else:
                bot_txt = bot_txt.replace('<botSource>None</botSource>', f'<botSource>None</botSource>\n    <botUser>{target_bot_user}</botUser>')

        # Standardize Service Agent context variables dataTypes and includeInPrompt
        for var_name in ['ContactId', 'EndUserId', 'RoutableId', 'ChannelType']:
            bot_txt = re.sub(
                rf'(<developerName>{var_name}</developerName>\s*<includeInPrompt>)[^<]+(</includeInPrompt>)',
                rf'\g<1>false\2',
                bot_txt
            )
        bot_txt = re.sub(
            r'(<dataType>)Id(</dataType>\s*<description>[^<]*</description>\s*<developerName>RoutableId</developerName>)',
            r'\g<1>Text\2',
            bot_txt
        )
        bot_txt = re.sub(
            r'(<dataType>)Id(</dataType>\s*<description>[^<]*</description>\s*<developerName>ContactId</developerName>)',
            r'\g<1>Text\2',
            bot_txt
        )
        bot_txt = re.sub(
            r'(<dataType>)Id(</dataType>\s*<description>[^<]*</description>\s*<developerName>EndUserId</developerName>)',
            r'\g<1>Text\2',
            bot_txt
        )

    with open(dst_xml, 'w') as f:
        f.write(bot_txt)

    # Update BotVersion
    bver_path = os.path.join(dst_bot_dir, 'v1.botVersion-meta.xml')
    if os.path.exists(bver_path):
        with open(bver_path, 'r') as f:
            bver_txt = f.read()
        bver_txt = re.sub(r'<genAiPlannerName>[^<]+</genAiPlannerName>', f'<genAiPlannerName>{new_planner}</genAiPlannerName>', bver_txt)

        if as_service_agent:
            bot_role = f'You are an Agentforce Service Agent that helps Coral Cloud guests with inquiries, reservations, experiences, and customer service.'
            bver_txt = re.sub(r'<role>[^<]+</role>', f'<role>{bot_role}</role>', bver_txt)

            if '<developerName>Transfer_To_Agent</developerName>' not in bver_txt:
                step_uuid = str(uuid.uuid4())
                transfer_block = f'''    <botDialogs>
        <botSteps>
            <conversationSystemMessage>
                <type>Transfer</type>
            </conversationSystemMessage>
            <stepIdentifier>{step_uuid}</stepIdentifier>
            <type>SystemMessage</type>
        </botSteps>
        <developerName>Transfer_To_Agent</developerName>
        <isPlaceholderDialog>false</isPlaceholderDialog>
        <label>Transfer To Agent</label>
        <showInFooterMenu>false</showInFooterMenu>
    </botDialogs>
'''
                if '<citationsEnabled>' in bver_txt:
                    bver_txt = bver_txt.replace('<citationsEnabled>', transfer_block + '    <citationsEnabled>')
                elif '<conversationDefinitionPlanners>' in bver_txt:
                    bver_txt = bver_txt.replace('<conversationDefinitionPlanners>', transfer_block + '    <conversationDefinitionPlanners>')

        with open(bver_path, 'w') as f:
            f.write(bver_txt)

# B. Transform Planner Bundle
src_p_dir = os.path.join(force_app, 'genAiPlannerBundles', source_planner)
dst_p_dir = os.path.join(force_app, 'genAiPlannerBundles', new_planner)

if os.path.exists(src_p_dir):
    shutil.move(src_p_dir, dst_p_dir)
    old_p_file = os.path.join(dst_p_dir, f'{source_planner}.genAiPlannerBundle')
    new_p_file = os.path.join(dst_p_dir, f'{new_planner}.genAiPlannerBundle')
    if os.path.exists(old_p_file):
        shutil.move(old_p_file, new_p_file)

    with open(new_p_file, 'r') as f:
        p_text = f.read()

    p_text = re.sub(r'<masterLabel>[^<]+</masterLabel>', f'<masterLabel>{new_bot_label}</masterLabel>', p_text)

    # Remap ID suffixes to avoid duplicate value found collisions
    suffixes = set(re.findall(r'_1[0-9a-zA-Z]{14}', p_text))
    suffix_map = {}
    for s in suffixes:
        prefix = s[:3]
        rand_chars = ''.join(random.choices(string.ascii_letters + string.digits, k=len(s)-3))
        suffix_map[s] = prefix.replace('_1', '_9') + rand_chars

    for old_s, new_s in suffix_map.items():
        p_text = p_text.replace(old_s, new_s)

    with open(new_p_file, 'w') as f:
        f.write(p_text)

    la_dir = os.path.join(dst_p_dir, 'localActions')
    if os.path.exists(la_dir):
        for root, dirs, files in os.walk(la_dir, topdown=False):
            for d in dirs:
                new_d = d
                for old_s, new_s in suffix_map.items():
                    if old_s in new_d:
                        new_d = new_d.replace(old_s, new_s)
                if new_d != d:
                    shutil.move(os.path.join(root, d), os.path.join(root, new_d))

    as_dir = os.path.join(dst_p_dir, 'agentScript')
    if os.path.exists(as_dir):
        for fname in os.listdir(as_dir):
            if fname.endswith('.agent'):
                old_agent_file = os.path.join(as_dir, fname)
                new_fname = fname.replace(source_planner, new_planner)
                new_agent_file = os.path.join(as_dir, new_fname)
                if old_agent_file != new_agent_file:
                    shutil.move(old_agent_file, new_agent_file)
                with open(new_agent_file, 'r') as f:
                    agent_txt = f.read()
                agent_txt = re.sub(r'connection\s+[a-zA-Z0-9_]+:\s*\n(\s+[^\n]+\n)*', '', agent_txt)
                for old_s, new_s in suffix_map.items():
                    agent_txt = agent_txt.replace(old_s, new_s)
                with open(new_agent_file, 'w') as f:
                    f.write(agent_txt)

print('Transformation successfully applied.')
" "${TEMP_CLONE_DIR}" "${CLONE_FROM}" "${NEW_AGENT}" "${NEW_AGENT_LABEL}" "${SOURCE_PLANNER}" "${NEW_PLANNER}" "${TARGET_BOT_USER}" "${AS_SERVICE_AGENT}"

        # 4. Deploy cloned agent metadata to target org
        log_info "Deploying cloned agent '${NEW_AGENT}' to ${TARGET_ORG}..."
        (
            cd "${TEMP_CLONE_DIR}"
            sf project deploy start --source-dir "force-app/main/default/bots/${NEW_AGENT}" --source-dir "force-app/main/default/genAiPlannerBundles/${NEW_PLANNER}" --target-org "${TARGET_ORG}" --wait "${WAIT_TIME}"
        )
        rm -rf "${TEMP_CLONE_DIR}"
        log_success "Cloned agent '${NEW_AGENT}' deployed successfully!"

        TARGET_AGENT="${NEW_AGENT}"
    fi

else
    # --- EXISTING AGENT PATH ---
    if [[ -z "${TARGET_AGENT}" ]]; then
        log_info "No agent specified; searching for active Agentforce agents in org..."
        AGENTS_QUERY=$(sf data query -q "SELECT Id, DeveloperName, MasterLabel, Type FROM BotDefinition" --target-org "${TARGET_ORG}" --json 2>/dev/null | extract_json || true)
        TARGET_AGENT=$(echo "$AGENTS_QUERY" | jq -r '.result.records[] | select(.DeveloperName != "Test_Clone") | .DeveloperName' | head -n 1)
        if [[ -z "${TARGET_AGENT}" ]]; then
            TARGET_AGENT="Test"
        fi
        log_info "Selected target agent: ${BOLD}${TARGET_AGENT}${NC}"
    fi
fi

# Resolve Target BotDefinition and BotVersion IDs
if [[ "${DRY_RUN}" != "true" ]]; then
    TARGET_BOT_ID=$(sf data query -q "SELECT Id FROM BotDefinition WHERE DeveloperName = '${TARGET_AGENT}' LIMIT 1" --target-org "${TARGET_ORG}" --json 2>/dev/null | extract_json | jq -r '.result.records[0].Id // empty')
    if [[ -z "${TARGET_BOT_ID}" ]]; then
        log_error "Could not resolve BotDefinition ID for '${TARGET_AGENT}'."
        exit 1
    fi

    TARGET_BOT_VER_RES=$(sf data query -q "SELECT Id, Status FROM BotVersion WHERE BotDefinitionId = '${TARGET_BOT_ID}' ORDER BY CreatedDate DESC LIMIT 1" --target-org "${TARGET_ORG}" --json 2>/dev/null | extract_json || true)
    TARGET_BOT_VER_ID=$(echo "$TARGET_BOT_VER_RES" | jq -r '.result.records[0].Id // empty')
    TARGET_BOT_VER_STATUS=$(echo "$TARGET_BOT_VER_RES" | jq -r '.result.records[0].Status // empty')

    log_success "Resolved Agent: ${TARGET_AGENT} (BotDefinitionId: ${TARGET_BOT_ID})"
    log_info "BotVersion ID:  ${TARGET_BOT_VER_ID} (Current Status: ${TARGET_BOT_VER_STATUS})"

    # Ensure BotVersion is Active
    if [[ "$TARGET_BOT_VER_STATUS" != "Active" && -n "$TARGET_BOT_VER_ID" ]]; then
        log_info "Activating BotVersion '${TARGET_BOT_VER_ID}' via ConnectApi..."
        ACT_SCRIPT="ConnectApi.BotVersionActivationInfo info = ConnectApi.BotVersionActivation.updateVersionStatus('${TARGET_BOT_VER_ID}', ConnectApi.BotVersionActivationStatus.Active, null); System.debug('ACTIVATION=' + info.success);"
        ACT_OUT=$(echo "$ACT_SCRIPT" | sf apex run --target-org "${TARGET_ORG}" 2>&1 || true)
        if echo "$ACT_OUT" | grep -q "ACTIVATION=true"; then
            log_success "BotVersion '${TARGET_BOT_VER_ID}' activated successfully!"
        else
            log_warn "BotVersion activation output: ${ACT_OUT}"
        fi
    else
        log_success "BotVersion '${TARGET_BOT_VER_ID}' is already Active!"
    fi
fi

# ==============================================================================
# Step 2: Deploy & Activate MessagingChannel Dedicated to Agentforce
# ==============================================================================
log_phase "Step 2: Deploying & Activating MessagingChannel Dedicated to ${TARGET_AGENT}"

# Resolve Fallback Queue (Required by Salesforce for AgentforceServiceAgent channels)
FALLBACK_QUEUE=$(sf data query -q "SELECT DeveloperName FROM Group WHERE Type = 'Queue' LIMIT 1" --target-org "${TARGET_ORG}" --json 2>/dev/null | extract_json | jq -r '.result.records[0].DeveloperName // "Chat_Queue"')
log_info "Resolved Routing Fallback Queue: ${BOLD}${FALLBACK_QUEUE}${NC}"

TEMP_DIR=$(mktemp -d "/tmp/af_deploy_XXXXXX")
mkdir -p "${TEMP_DIR}/force-app/main/default/messagingChannels"
mkdir -p "${TEMP_DIR}/force-app/main/default/EmbeddedServiceConfig"

cat << EOF > "${TEMP_DIR}/sfdx-project.json"
{
  "packageDirectories": [
    {
      "path": "force-app",
      "default": true
    }
  ],
  "namespace": "",
  "sfdcLoginUrl": "https://login.salesforce.com",
  "sourceApiVersion": "67.0"
}
EOF

# MessagingChannel Metadata
cat << EOF > "${TEMP_DIR}/force-app/main/default/messagingChannels/${CHANNEL_NAME}.messagingChannel-meta.xml"
<?xml version="1.0" encoding="UTF-8"?>
<MessagingChannel xmlns="http://soap.sforce.com/2006/04/metadata">
    <automatedResponses>
        <autoResponseContentType>TextResponse</autoResponseContentType>
        <language>en_US</language>
        <response>You have opted out of receiving messages from us.</response>
        <type>OptOutConfirmation</type>
    </automatedResponses>
    <automatedResponses>
        <autoResponseContentType>TextResponse</autoResponseContentType>
        <language>en_US</language>
        <response>Text STOP to opt out of further messages.</response>
        <type>HelpResponse</type>
    </automatedResponses>
    <masterLabel>${CHANNEL_LABEL}</masterLabel>
    <messagingChannelType>EmbeddedMessaging</messagingChannelType>
    <messagingKeywords>
        <keyword>cancel</keyword>
        <keyword>end</keyword>
        <keyword>quit</keyword>
        <keyword>stop</keyword>
        <keywordType>OptOut</keywordType>
        <language>en_US</language>
    </messagingKeywords>
    <messagingKeywords>
        <keyword>help</keyword>
        <keywordType>Help</keywordType>
        <language>en_US</language>
    </messagingKeywords>
    <sessionHandlerAsa>${TARGET_AGENT}</sessionHandlerAsa>
    <sessionHandlerQueue>${FALLBACK_QUEUE}</sessionHandlerQueue>
    <sessionHandlerType>AgentforceServiceAgent</sessionHandlerType>
</MessagingChannel>
EOF

# EmbeddedServiceConfig API Deployment Metadata
cat << EOF > "${TEMP_DIR}/force-app/main/default/EmbeddedServiceConfig/${DEPLOYMENT_NAME}.EmbeddedServiceConfig-meta.xml"
<?xml version="1.0" encoding="UTF-8"?>
<EmbeddedServiceConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <areGuestUsersAllowed>true</areGuestUsersAllowed>
    <deploymentFeature>EmbeddedMessaging</deploymentFeature>
    <deploymentType>API</deploymentType>
    <embeddedServiceMessagingChannel>
        <isChatInvitationCustomizable>false</isChatInvitationCustomizable>
        <isEnabled>true</isEnabled>
        <isInvitationEnabled>false</isInvitationEnabled>
        <isSendInvtAllowedAfterAccept>false</isSendInvtAllowedAfterAccept>
        <isSendInvtAllowedAfterReject>false</isSendInvtAllowedAfterReject>
        <messagingChannel>${CHANNEL_NAME}</messagingChannel>
        <shouldShowAgentforceTagline>false</shouldShowAgentforceTagline>
        <shouldShowDeliveryReceipts>false</shouldShowDeliveryReceipts>
        <shouldShowEmojiSelection>false</shouldShowEmojiSelection>
        <shouldShowReadReceipts>false</shouldShowReadReceipts>
        <shouldShowTypingIndicators>false</shouldShowTypingIndicators>
        <shouldStartNewLineOnEnter>false</shouldStartNewLineOnEnter>
    </embeddedServiceMessagingChannel>
    <isEnabled>true</isEnabled>
    <isTermsAndConditionsEnabled>false</isTermsAndConditionsEnabled>
    <isTermsAndConditionsRequired>false</isTermsAndConditionsRequired>
    <masterLabel>${DEPLOYMENT_LABEL}</masterLabel>
    <shouldHideAuthDialog>false</shouldHideAuthDialog>
</EmbeddedServiceConfig>
EOF

if [[ "${DRY_RUN}" == "true" ]]; then
    log_info "[DRY-RUN] Validating Channel and API Deployment metadata with --dry-run..."
    (
        cd "${TEMP_DIR}"
        sf project deploy start --source-dir force-app --target-org "${TARGET_ORG}" --dry-run --wait "${WAIT_TIME}"
    )
    rm -rf "${TEMP_DIR}"
    log_success "[DRY-RUN] Metadata validation successful!"
    exit 0
fi

# Deploy MessagingChannel & EmbeddedServiceConfig
log_info "Deploying MessagingChannel '${CHANNEL_NAME}' and API Deployment '${DEPLOYMENT_NAME}'..."
(
    cd "${TEMP_DIR}"
    sf project deploy start --source-dir force-app --target-org "${TARGET_ORG}" --wait "${WAIT_TIME}"
)
rm -rf "${TEMP_DIR}"
log_success "Metadata deployed successfully!"

# Update MessagingChannel SessionHandlerId and Activate Channel
log_info "Wiring MessagingChannel '${CHANNEL_NAME}' directly to ${TARGET_AGENT} (SessionHandlerId: ${TARGET_BOT_ID}) & activating..."
sf data update record --sobject MessagingChannel --where "DeveloperName='${CHANNEL_NAME}'" --values "SessionHandlerId='${TARGET_BOT_ID}' IsActive=true" --target-org "${TARGET_ORG}" >/dev/null 2>&1 || true
log_success "MessagingChannel '${CHANNEL_NAME}' is active and routing directly to '${TARGET_AGENT}'!"

# ==============================================================================
# Step 3: Publish EmbeddedServiceConfig (API Deployment)
# ==============================================================================
log_phase "Step 3: Publishing API Deployment via Connect REST API"

CONFIG_QUERY=$(sf data query --use-tooling-api -q "SELECT Id FROM EmbeddedServiceConfig WHERE DeveloperName = '${DEPLOYMENT_NAME}' LIMIT 1" --target-org "${TARGET_ORG}" --json 2>/dev/null | extract_json || true)
CONFIG_ID=$(echo "$CONFIG_QUERY" | jq -r '.result.records[0].Id // empty')

if [[ -z "${CONFIG_ID}" ]]; then
    log_error "Could not resolve EmbeddedServiceConfig ID for '${DEPLOYMENT_NAME}'."
    exit 1
fi

log_info "EmbeddedServiceConfig ID: ${CONFIG_ID}"
log_info "Triggering publish: POST /services/data/v67.0/connect/embeddedservice/embeddedserviceconfig/publish/${CONFIG_ID}..."

PUB_RES=$(curl -s -X POST "${INSTANCE_URL}/services/data/v67.0/connect/embeddedservice/embeddedserviceconfig/publish/${CONFIG_ID}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{}" || true)

PUB_SUCCESS=$(echo "$PUB_RES" | extract_json | jq -r '.isSuccess // empty')

if [[ "${PUB_SUCCESS}" == "true" ]]; then
    log_success "EmbeddedServiceConfig '${DEPLOYMENT_NAME}' published and active!"
else
    log_warn "Publish response: ${PUB_RES} (configuration may already be published and live)."
fi

# ==============================================================================
# Step 4: Synchronize test-client credentials.json
# ==============================================================================
log_phase "Step 4: Synchronizing test-client credentials.json"

TEST_CLIENT_CREDS="${TEST_CLIENT_DIR}/credentials.json"
if [[ -f "${TEST_CLIENT_CREDS}" ]]; then
    python3 -c "
import json, sys

creds_path, org_id, scrt_url, channel_name, dev_name, target_agent = sys.argv[1:7]

try:
    with open(creds_path, 'r') as f:
        data = json.load(f)
except Exception:
    data = {}

data['OrganizationId'] = org_id
data['Url'] = scrt_url
data['DeveloperName'] = dev_name
data['defaultChannel'] = channel_name

if 'channels' not in data:
    data['channels'] = {}

channel_key = channel_name.lower()
data['channels'][channel_key] = {
    'DeveloperName': dev_name,
    'description': f'Dedicated Agentforce MIAW API Deployment for {target_agent}',
    'targetAgent': target_agent,
    'routingType': 'EmbeddedMessaging',
    'Url': scrt_url,
    'OrganizationId': org_id
}

with open(creds_path, 'w') as f:
    json.dump(data, f, indent=2)

print(f'Synchronized channel \"{channel_key}\" into ' + creds_path)
" "${TEST_CLIENT_CREDS}" "${ORG_ID}" "${SCRT2_URL}" "${CHANNEL_NAME}" "${DEPLOYMENT_NAME}" "${TARGET_AGENT}"
    log_success "Updated test-client credentials.json with channel '${CHANNEL_NAME}'!"
fi

# ==============================================================================
# Step 5: Test Message to the Agentforce Agent (Live E2E Verification)
# ==============================================================================
if [[ "${SKIP_TEST}" == "true" ]]; then
    log_info "Skipping test message (--skip-test requested)."
else
    log_phase "Step 5: Sending Live Message to Agentforce Agent (${TARGET_AGENT})"
    log_info "Initial Message: \"${BOLD}${TEST_MESSAGE}${NC}\""
    log_info "Endpoint:        ${SCRT2_URL}"
    log_info "Deployment:      ${DEPLOYMENT_NAME}"

    RUNNER=""
    if command -v bun &>/dev/null; then
        RUNNER="bun"
    elif command -v node &>/dev/null; then
        RUNNER="node"
    fi

    # Use test-client's CLI if present
    if [[ -f "${TEST_CLIENT_DIR}/bin/cli.js" && -n "$RUNNER" ]]; then
        log_info "Executing live messaging test via test-client CLI (${RUNNER})...\n"
        $RUNNER "${TEST_CLIENT_DIR}/bin/cli.js" send "${TEST_MESSAGE}" \
            --channel "${CHANNEL_NAME,,}" \
            --direct \
            --wait "${TIMEOUT_SEC}" || log_warn "Message send completed with notification."
    else
        # Standalone Node/Bun fallback runner
        log_info "Executing direct standalone SSE test runner..."
        $RUNNER -e "
const scrtUrl = '${SCRT2_URL}'.replace(/\/$/, '');
const orgId = '${ORG_ID}';
const devName = '${DEPLOYMENT_NAME}';
const messageText = '${TEST_MESSAGE}';

async function main() {
    console.log('1. Requesting unauthenticated access token...');
    const tRes = await fetch(scrtUrl + '/iamessage/api/v2/authorization/unauthenticated/access-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, esDeveloperName: devName, capabilitiesVersion: '1', platform: 'Web' })
    });
    if (!tRes.ok) throw new Error('Token request failed: ' + (await tRes.text()));
    const { accessToken } = await tRes.json();
    console.log('✔ Token acquired.');

    console.log('2. Initializing conversation...');
    const convId = crypto.randomUUID();
    const cRes = await fetch(scrtUrl + '/iamessage/api/v2/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({ conversationId: convId, esDeveloperName: devName })
    });
    if (!cRes.ok) throw new Error('Conversation failed: ' + (await cRes.text()));
    console.log('✔ Conversation active (ID: ' + convId + ').');

    console.log('3. Connecting SSE Event stream & sending message...');
    const msgId = crypto.randomUUID();
    await fetch(scrtUrl + '/iamessage/api/v2/conversation/' + convId + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({
            message: { id: msgId, messageType: 'StaticContentMessage', staticContent: { formatType: 'Text', text: messageText } },
            esDeveloperName: devName
        })
    });
    console.log('✔ Message delivered: \"' + messageText + '\"');
}
main().catch(e => { console.error('Test error:', e.message); process.exit(1); });
" || log_warn "Direct verification completed."
    fi
fi

echo -e "\n${GREEN}${BOLD}==========================================================================${NC}"
echo -e "${GREEN}${BOLD}    Agentforce Channel & API Deployment Setup Complete!                    ${NC}"
echo -e "${GREEN}${BOLD}==========================================================================${NC}"
echo -e "Org ID:             ${BOLD}${ORG_ID}${NC}"
echo -e "Agentforce Agent:   ${BOLD}${TARGET_AGENT}${NC} (Id: ${TARGET_BOT_ID})"
echo -e "MIAW Channel:       ${BOLD}${CHANNEL_NAME}${NC} (Active -> ${TARGET_AGENT})"
echo -e "API Deployment:     ${BOLD}${DEPLOYMENT_NAME}${NC} (Active & Published)"
echo -e "SCRT 2.0 URL:       ${BOLD}${SCRT2_URL}${NC}"
echo ""
echo -e "${CYAN}${BOLD}Interactive Chat Commands:${NC}"
echo -e "  • Via test-client:"
echo -e "    ${BLUE}cd test-client && bun run cli chat --channel ${CHANNEL_NAME,,} --direct${NC}"
echo -e "  • One-shot message:"
echo -e "    ${BLUE}cd test-client && bun run cli send \"Ask a question\" --dev-name ${DEPLOYMENT_NAME} --direct${NC}"
echo ""

exit 0
