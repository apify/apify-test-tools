#!/usr/bin/env bash
# Registers every value inside the ALL_SECRETS and APIFY_ACTOR_TOKENS secrets as a mask.
#
#     ALL_SECRETS=... APIFY_ACTOR_TOKENS=... bash .github/scripts/mask-packed-secrets.sh
#
# The runner masks a secret by its exact value, so a token packed inside a JSON secret is only
# masked as part of that whole blob. Once a step takes the token out, it would print in clear.
# Multi-line values are registered line by line, the way the runner registers secrets.
# Either variable may be empty or unset.

set -uo pipefail

for name in ALL_SECRETS APIFY_ACTOR_TOKENS; do
    [ -n "${!name:-}" ] || continue
    # jq's errors can quote the input, so they are dropped for our own message
    jq -r 'if type != "object" then error else . end | to_entries[] | .value | strings | split("\n")[] | select(. != "") | "::add-mask::" + .' <<< "${!name}" 2>/dev/null \
        || { echo "::error::The $name secret must be a JSON object."; exit 1; }
done
