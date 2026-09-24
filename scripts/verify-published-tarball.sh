#!/usr/bin/env bash
# Retry `npm view <spec> dist.tarball` until the registry serves it or the
# deadline passes. The step that calls this script sets timeout-minutes above
# this deadline so GitHub does not cancel the wait first.
set -euo pipefail

spec="${1:?package spec, for example @scope/name@version}"
timeout_seconds="${VERIFY_TIMEOUT_SECONDS:-420}"
interval_seconds="${VERIFY_INTERVAL_SECONDS:-30}"

if ! [[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::VERIFY_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi
if ! [[ "${interval_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::VERIFY_INTERVAL_SECONDS must be a positive integer" >&2
  exit 2
fi

unset NODE_AUTH_TOKEN NPM_TOKEN || true
if [[ -n "${NPM_CONFIG_USERCONFIG:-}" && -f "${NPM_CONFIG_USERCONFIG}" ]]; then
  sed -i '/_authToken/d' "${NPM_CONFIG_USERCONFIG}"
fi

deadline="$(($(date +%s) + timeout_seconds))"
attempt=0

while true; do
  now="$(date +%s)"
  if ((now >= deadline)); then
    break
  fi
  attempt="$((attempt + 1))"
  if tarball="$(npm view "${spec}" dist.tarball 2>/dev/null)" && [[ -n "${tarball}" ]]; then
    echo "Published tarball: ${tarball} (attempt ${attempt})"
    exit 0
  fi
  now="$(date +%s)"
  remaining="$((deadline - now))"
  if ((remaining <= 0)); then
    break
  fi
  sleep_for="${interval_seconds}"
  if ((sleep_for > remaining)); then
    sleep_for="${remaining}"
  fi
  echo "npm view missed ${spec} (attempt ${attempt}); waiting ${sleep_for}s (${remaining}s left)"
  sleep "${sleep_for}"
done

echo "::error::npm returned no dist.tarball for ${spec} within ${timeout_seconds}s"
exit 1
