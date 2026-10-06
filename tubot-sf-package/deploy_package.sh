#!/usr/bin/env bash

# ==============================================================================
# Salesforce Package & Source Deployment Automation Script
# ==============================================================================
# Usage:
#   ./deploy_package.sh [options]
#
# Options:
#   -o, --target-org ALIAS    Target org username/alias (default: test1empty)
#   -d, --target-dev-hub ALIAS Dev Hub alias for package mode (required in package mode)
#   -m, --mode MODE           Deployment mode: 'source' (default) or 'package'
#   -l, --test-level LEVEL    Apex test level: RunLocalTests (default), NoTestRun, RunAllTestsInOrg, RunSpecifiedTests
#   -t, --tests TESTS         Comma-separated list of Apex test classes (required if test-level is RunSpecifiedTests)
#   -v, --verification-org ALIAS Org containing the candidate source; required in package mode
#   -c, --check-only          Perform dry-run deployment validation without saving changes
#   -s, --source-dir DIR      Specific source directory to deploy (default: force-app)
#   -w, --wait MINUTES        Wait time in minutes for deployment/package commands (default: 10)
#   -p, --promote             Auto-promote created package version (only applicable in 'package' mode)
#   -h, --help                Show this help message
# ==============================================================================

set -eo pipefail

if [ -d "$HOME/.bun/bin" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
fi
if [ -d "/teamspace/studios/this_studio/.bun/bin" ]; then
    export PATH="/teamspace/studios/this_studio/.bun/bin:$PATH"
fi
export SF_NO_COLOR=1

# Default Configurations
TARGET_ORG="test1empty"
DEV_HUB=""
MODE="source"
TEST_LEVEL="RunLocalTests"
TEST_CLASSES=""
VERIFICATION_ORG=""
CHECK_ONLY=false
SOURCE_DIR="force-app"
WAIT_TIME=10
PROMOTE=false
PERMISSION_BACKUP_DIR=""
declare -a ADAPTED_PERMISSION_FILES=()
declare -a PERMISSION_BACKUP_FILES=()

# Color Output Formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

show_help() {
    cat << EOF
Salesforce Package & Source Deployment Automation Script

Usage:
  ./deploy_package.sh [options]

Options:
  -o, --target-org ALIAS    Target org username/alias (default: test1empty)
  -d, --target-dev-hub ALIAS Dev Hub alias for package mode (required in package mode)
  -m, --mode MODE           Deployment mode: 'source' (default) or 'package'
  -l, --test-level LEVEL    Apex test level: RunLocalTests (default), NoTestRun, RunAllTestsInOrg, RunSpecifiedTests
  -t, --tests TESTS         Comma-separated Apex test class names
  -v, --verification-org ALIAS Org containing the candidate source; required in package mode
  -c, --check-only          Dry-run validation mode (no changes committed)
  -s, --source-dir DIR      Source directory (default: force-app)
  -w, --wait MINUTES        Wait timeout in minutes (default: 10)
  -p, --promote             Promote package version (package mode only)
  -h, --help                Show this help message
EOF
}

restore_permission_sets() {
    for index in "${!ADAPTED_PERMISSION_FILES[@]}"; do
        cp "${PERMISSION_BACKUP_FILES[$index]}" "${ADAPTED_PERMISSION_FILES[$index]}"
    done
    if [ -n "$PERMISSION_BACKUP_DIR" ]; then
        rm -rf "$PERMISSION_BACKUP_DIR"
    fi
}
trap restore_permission_sets EXIT

# Parse Command Line Arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--target-org)
            TARGET_ORG="$2"
            shift 2
            ;;
        -d|--target-dev-hub)
            DEV_HUB="$2"
            shift 2
            ;;
        -m|--mode)
            MODE="$2"
            shift 2
            ;;
        -l|--test-level)
            TEST_LEVEL="$2"
            shift 2
            ;;
        -t|--tests)
            TEST_CLASSES="$2"
            shift 2
            ;;
        -v|--verification-org)
            VERIFICATION_ORG="$2"
            shift 2
            ;;
        -c|--check-only)
            CHECK_ONLY=true
            shift
            ;;
        -s|--source-dir)
            SOURCE_DIR="$2"
            shift 2
            ;;
        -w|--wait)
            WAIT_TIME="$2"
            shift 2
            ;;
        -p|--promote)
            PROMOTE=true
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

# Ensure Salesforce CLI is available. Some managed environments provide an `sf`
# shim that exists on PATH but cannot start; fall back to Bun's Salesforce CLI.
SF_CLI=(sf)
if ! command -v sf &> /dev/null || ! sf --version > /dev/null 2>&1; then
    if command -v bunx &> /dev/null; then
        SF_CLI=(bunx --yes @salesforce/cli)
    else
        log_error "Salesforce CLI ('sf') is not available, and bunx is not installed."
        exit 1
    fi
fi

log_info "Starting Salesforce Deployment Process..."
log_info "Target Org: ${TARGET_ORG}"
log_info "Mode: ${MODE}"
log_info "Source Directory: ${SOURCE_DIR}"

if [[ "$MODE" == "source" ]]; then
    # Construct Source Deploy Command
    DEPLOY_ARGS=(project deploy start --source-dir "$SOURCE_DIR" --target-org "$TARGET_ORG" --wait "$WAIT_TIME")

    if [ "$CHECK_ONLY" = true ]; then
        log_info "Running in CHECK-ONLY (Dry Run) validation mode..."
        DEPLOY_ARGS+=(--dry-run)
    fi

    if [ "$TEST_LEVEL" != "NoTestRun" ]; then
        DEPLOY_ARGS+=(--test-level "$TEST_LEVEL")
        if [[ "$TEST_LEVEL" == "RunSpecifiedTests" ]]; then
            if [ -z "$TEST_CLASSES" ]; then
                log_error "Test level is set to RunSpecifiedTests but no test classes were specified (-t / --tests)."
                exit 1
            fi
            IFS=',' read -ra DEPLOY_TESTS <<< "$TEST_CLASSES"
            for test_class in "${DEPLOY_TESTS[@]}"; do
                if [ -n "$test_class" ]; then DEPLOY_ARGS+=(--tests "$test_class"); fi
            done
        fi
    fi

    # Resolve the namespace from Salesforce metadata; never infer it from an alias.
    ORG_QUERY=$("${SF_CLI[@]}" data query --query "SELECT NamespacePrefix FROM Organization" --target-org "${TARGET_ORG}" --json)
    ORG_NS=$(printf '%s' "$ORG_QUERY" | bun -e '
        const raw = await Bun.stdin.text();
        const clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
        const start = clean.search(/\{\s*"status"\s*:/);
        const end = clean.lastIndexOf("}");
        if (start === -1 || end === -1) process.exit(1);
        const payload = JSON.parse(clean.slice(start, end + 1));
        const records = payload.result?.records;
        if (payload.status !== 0 || !Array.isArray(records) || records.length !== 1) process.exit(1);
        const namespace = records[0].NamespacePrefix;
        if (namespace !== null && (typeof namespace !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(namespace))) process.exit(1);
        if (namespace) console.log(namespace);
    ')
    PSET_DIR="${SOURCE_DIR}/main/default/permissionsets"
    PACKAGE_NAMESPACE=$(bun -e '
        const config = JSON.parse(await Bun.file("sfdx-project.json").text());
        if (typeof config.namespace === "string") console.log(config.namespace);
    ')
    if [ -d "$PSET_DIR" ]; then
        log_info "Adapting External Credential principals for the target namespace..."
        for PSET_FILE in "$PSET_DIR"/*.permissionset-meta.xml; do
            [ -f "$PSET_FILE" ] || continue
            if ! grep -q '<externalCredentialPrincipal>' "$PSET_FILE"; then continue; fi
            if [ -z "$PERMISSION_BACKUP_DIR" ]; then
                PERMISSION_BACKUP_DIR=$(mktemp -d)
            fi
            BACKUP_FILE="${PERMISSION_BACKUP_DIR}/${#ADAPTED_PERMISSION_FILES[@]}.xml"
            cp "$PSET_FILE" "$BACKUP_FILE"
            ADAPTED_PERMISSION_FILES+=("$PSET_FILE")
            PERMISSION_BACKUP_FILES+=("$BACKUP_FILE")
            PSET_FILE="$PSET_FILE" TARGET_NAMESPACE="$ORG_NS" PACKAGE_NAMESPACE="$PACKAGE_NAMESPACE" bun -e '
                const path = process.env.PSET_FILE;
                const targetNamespace = process.env.TARGET_NAMESPACE;
                const packageNamespace = process.env.PACKAGE_NAMESPACE;
                let xml = await Bun.file(path).text();
                xml = xml.replace(/(<externalCredentialPrincipal>)([^<]+)(<\/externalCredentialPrincipal>)/g, (_, open, name, close) => {
                    const namespacePrefix = name.match(/^([A-Za-z][A-Za-z0-9_]*?)__/);
                    const actualPrefix = namespacePrefix?.[0];
                    const currentNamespace = namespacePrefix?.[1] ?? null;
                    if (currentNamespace && currentNamespace !== packageNamespace && currentNamespace !== targetNamespace) {
                        throw new Error("External Credential principal has an unexpected namespace.");
                    }
                    const unqualifiedName = currentNamespace ? name.slice(actualPrefix.length) : name;
                    const qualifiedName = targetNamespace ? `${targetNamespace}__${unqualifiedName}` : unqualifiedName;
                    return `${open}${qualifiedName}${close}`;
                });
                await Bun.write(path, xml);
            '
        done
    fi

    log_info "Deploying Salesforce metadata to ${TARGET_ORG}..."
    "${SF_CLI[@]}" "${DEPLOY_ARGS[@]}"

    log_success "Source deployment to ${TARGET_ORG} completed successfully!"

    if [ "$CHECK_ONLY" = false ]; then
        log_info "Use Panel Settings to connect Panel and complete channel API setup."
    fi

    # Run Apex Tests if requested post-deployment
    if [[ "$TEST_LEVEL" != "NoTestRun" && "$CHECK_ONLY" = false ]]; then
        log_info "Executing Apex tests on ${TARGET_ORG}..."
        TEST_ARGS=(apex run test --target-org "${TARGET_ORG}" --test-level "${TEST_LEVEL}" --wait "${WAIT_TIME}")
        if [ -n "$TEST_CLASSES" ]; then
            # Split comma separated classes into flag arguments
            IFS=',' read -ra ADDR <<< "$TEST_CLASSES"
            for t in "${ADDR[@]}"; do
                TEST_ARGS+=(--class-names "$t")
            done
        fi
        log_info "Running Apex tests on ${TARGET_ORG} at ${TEST_LEVEL}..."
        "${SF_CLI[@]}" "${TEST_ARGS[@]}"
        log_success "Apex test execution completed!"
    fi

elif [[ "$MODE" == "package" ]]; then
    if [ -z "$DEV_HUB" ]; then
        log_error "Package mode requires --target-dev-hub with the Dev Hub used to create the managed package version."
        exit 1
    fi
    if [ -z "$VERIFICATION_ORG" ]; then
        log_error "Package mode requires --verification-org with the exact candidate source deployed."
        exit 1
    fi
    log_info "Checking 75% Apex and 100% trigger coverage in the verification org..."
    bun scripts/check-release-coverage.mjs --target-org "$VERIFICATION_ORG"

    if [ "$CHECK_ONLY" = true ]; then
        log_success "Coverage gates passed. Check-only mode skipped package creation, installation, and promotion."
        exit 0
    fi

    if [ "$PROMOTE" = true ]; then
        log_info "Promotion requested; the package-version coverage report will be checked before promotion."
    fi

    log_info "Creating 2nd Generation Package Version..."
    
    CREATE_ARGS=(package version create --package TuBot --target-dev-hub "${DEV_HUB}" --wait "${WAIT_TIME}" --installation-key-bypass --code-coverage --json)
    log_info "Creating a validated package version with code coverage enabled..."
    BUILD_OUTPUT=$("${SF_CLI[@]}" "${CREATE_ARGS[@]}")
    
    # Extract Package Version ID (04t...)
    PACKAGE_VERSION_ID=$(printf '%s' "$BUILD_OUTPUT" | bun -e '
        const raw = await Bun.stdin.text();
        const clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
        const start = clean.search(/\{\s*"status"\s*:/);
        const end = clean.lastIndexOf("}");
        if (start === -1 || end === -1) process.exit(1);
        const payload = JSON.parse(clean.slice(start, end + 1));
        const id = payload.result?.SubscriberPackageVersionId;
        if (typeof id === "string") console.log(id);
    ')

    if [ -z "$PACKAGE_VERSION_ID" ]; then
        log_error "Package version creation returned no SubscriberPackageVersionId; inspect the Salesforce CLI result."
        exit 1
    fi

    VERSION_REPORT=$("${SF_CLI[@]}" package version report --package "${PACKAGE_VERSION_ID}" --target-dev-hub "${DEV_HUB}" --json)
    VERSION_COVERAGE_CHECK=$(printf '%s' "$VERSION_REPORT" | bun -e '
        const raw = await Bun.stdin.text();
        const clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
        const start = clean.search(/\{\s*"status"\s*:/);
        const end = clean.lastIndexOf("}");
        if (start === -1 || end === -1) process.exit(1);
        const payload = JSON.parse(clean.slice(start, end + 1));
        const version = payload.result;
        const coverage = Number(version?.CodeCoverage?.apexCodeCoveragePercentage);
        if (payload.status === 0 && version?.HasPassedCodeCoverageCheck === true && Number.isFinite(coverage) && coverage >= 75) {
            console.log(`PASS ${coverage}%`);
        } else {
            console.log(`FAIL ${Number.isFinite(coverage) ? `${coverage}%` : "coverage unavailable"}`);
        }
    ')
    if [[ "$VERSION_COVERAGE_CHECK" != PASS* ]]; then
        log_error "Created beta package version failed the package coverage gate (${VERSION_COVERAGE_CHECK}). It will not be installed or promoted."
        exit 1
    fi

    log_success "Created Package Version ID: ${PACKAGE_VERSION_ID}"
    log_success "Package-version Apex coverage passed: ${VERSION_COVERAGE_CHECK#PASS }"

    if [ "$PROMOTE" = true ]; then
        log_info "Promoting Package Version ${PACKAGE_VERSION_ID}..."
        "${SF_CLI[@]}" package version promote --package "${PACKAGE_VERSION_ID}" --target-dev-hub "${DEV_HUB}" --no-prompt
        log_success "Package version ${PACKAGE_VERSION_ID} promoted to released status!"
    fi

    log_info "Installing Package Version ${PACKAGE_VERSION_ID} into target org ${TARGET_ORG}..."
    "${SF_CLI[@]}" package install --package "${PACKAGE_VERSION_ID}" --target-org "${TARGET_ORG}" --wait "${WAIT_TIME}" --no-prompt
    log_success "Package version ${PACKAGE_VERSION_ID} installed successfully in ${TARGET_ORG}!"

else
    log_error "Invalid mode: ${MODE}. Must be 'source' or 'package'."
    exit 1
fi

log_success "All Salesforce deployment tasks completed cleanly! 🎉"
