#!/usr/bin/env bash
# Install the latest TuBot package version into a target org.
#
# Beta versions cannot be upgraded in place, so any installed TuBot version
# is uninstalled first ("remove betas"), then the latest version is
# installed, subscriber ECA pre-authorization policies are applied, and the
# result is verified. MessagingChannels and all other org data are untouched.
#
# Usage:
#   ./scripts/install-latest.sh --target-org <alias> [--dev-hub test2]
#       [--package TuBot] [--version-id 04t...] [--skip-policies]
set -euo pipefail

TARGET_ORG=""
DEV_HUB="test2"
PACKAGE="TuBot"
VERSION_ID=""
SKIP_POLICIES="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --target-org) TARGET_ORG="$2"; shift 2 ;;
    --dev-hub) DEV_HUB="$2"; shift 2 ;;
    --package) PACKAGE="$2"; shift 2 ;;
    --version-id) VERSION_ID="$2"; shift 2 ;;
    --skip-policies) SKIP_POLICIES="true"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$TARGET_ORG" ]; then
  echo "ERROR: --target-org is required." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$VERSION_ID" ]; then
  echo "==> Resolving latest $PACKAGE version from Dev Hub $DEV_HUB..."
  VERSION_ID="$(sf package version list -p "$PACKAGE" -v "$DEV_HUB" --json \
    | jq -r '.result[]? | [.MajorVersion, .MinorVersion, .PatchVersion, .BuildNumber, .SubscriberPackageVersionId] | @tsv' \
    | sort -t"$(printf '\t')" -k1,1n -k2,2n -k3,3n -k4,4n \
    | tail -n 1 | cut -f5)"
fi
if [ -z "$VERSION_ID" ] || [ "$VERSION_ID" = "null" ]; then
  echo "ERROR: could not resolve a package version." >&2
  exit 1
fi
echo "    Latest version: $VERSION_ID"

echo "==> Removing installed TuBot versions from $TARGET_ORG (betas cannot upgrade)..."
INSTALLED="$(sf package installed list --target-org "$TARGET_ORG" --json \
  | jq -r '.result[]? | select(.SubscriberPackageName | ascii_downcase | contains("tubot")) | .SubscriberPackageVersionId')"
if [ -z "$INSTALLED" ]; then
  echo "    None installed."
else
  for INSTALLED_ID in $INSTALLED; do
    if [ "$INSTALLED_ID" = "$VERSION_ID" ]; then
      echo "    $INSTALLED_ID is already the target version; reinstalling anyway for a clean state."
    fi
    echo "    Deleting subscriber ECA policies (they block uninstall)..."
    python3 -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
import tubot_teardown as td
org = {'target_flag': '$TARGET_ORG', 'alias': '$TARGET_ORG'}
name = td.find_subscriber_policies_name(org)
if name:
    ok = td.delete_subscriber_policies(org, name)
    sys.exit(0 if ok else 1)
print('    No subscriber ECA policies present.')
"
    echo "    Stripping packaged TuBot permission assignments (they block uninstall)..."
    ASSIGN_IDS="$(sf data query --target-org "$TARGET_ORG" --json \
      --query "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.NamespacePrefix = 'tubot'" \
      | jq -r '.result.records[]?.Id')"
    for ASSIGN_ID in $ASSIGN_IDS; do
      sf data delete record --sobject PermissionSetAssignment --record-id "$ASSIGN_ID" \
        --target-org "$TARGET_ORG" --json > /dev/null
    done
    echo "    Uninstalling $INSTALLED_ID..."
    for ATTEMPT in 1 2 3; do
      if sf package uninstall --package "$INSTALLED_ID" --target-org "$TARGET_ORG" --wait 20; then
        break
      fi
      echo "    Uninstall attempt $ATTEMPT failed; retrying..." >&2
      sleep 15
    done
    if sf package installed list --target-org "$TARGET_ORG" --json \
      | jq -e '.result[]? | select(.SubscriberPackageVersionId == "'"$INSTALLED_ID"'")' > /dev/null; then
      echo "ERROR: $INSTALLED_ID is still installed after retries." >&2
      exit 1
    fi
  done
fi

echo "==> Installing $VERSION_ID into $TARGET_ORG..."
sf package install --package "$VERSION_ID" --target-org "$TARGET_ORG" --wait 20 --no-prompt

echo "==> Verifying installation..."
sf package installed list --target-org "$TARGET_ORG" --json \
  | jq -e -r '.result[]? | select(.SubscriberPackageVersionId == "'"$VERSION_ID"'") | "\(.SubscriberPackageName) \(.SubscriberPackageVersionNumber)"' \
  | head -n 1

if [ "$SKIP_POLICIES" != "true" ]; then
  echo "==> Applying subscriber ECA pre-authorization policies..."
  (cd "$SCRIPT_DIR" && bun setup-eca-policies.mjs --target-org "$TARGET_ORG")
fi

echo "OK: $VERSION_ID installed into $TARGET_ORG."
echo "Next: pick the integration user and assign Tubot_JWT_PreAuth + Tubot_Salesforce_API_Read"
echo "(Simple Setup wizard does this automatically), then register the channel."
