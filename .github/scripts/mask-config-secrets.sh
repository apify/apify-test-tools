#!/usr/bin/env bash
# Registers every value inside the CONFIG_SECRETS secret as a mask.
#
#     CONFIG_SECRETS=... bash .github/scripts/mask-config-secrets.sh
#
# The runner masks a secret by its exact value, so a value packed inside a JSON secret is only
# masked as part of that whole blob. Once a step takes it out, it would print in clear.
# Multi-line values are registered line by line, the way the runner registers secrets.
# CONFIG_SECRETS may be empty or unset.

set -uo pipefail

[ -n "${CONFIG_SECRETS:-}" ] || exit 0

# jq's errors can quote the input, so they are dropped for our own message
jq -r 'if type != "object" then error else . end | to_entries[] | .value | strings | split("\n")[] | select(. != "") | "::add-mask::" + .' <<< "$CONFIG_SECRETS" 2>/dev/null \
    || { echo "::error::The CONFIG_SECRETS secret must be a JSON object."; exit 1; }
