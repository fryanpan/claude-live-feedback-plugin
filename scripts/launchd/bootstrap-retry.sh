#!/usr/bin/env bash
# Bootstrap helpers for scripts/launchd/install.sh.
#
# These live in their own sourceable file so the test suite can drive them
# against a stub launchctl. Running install.sh itself in a test is not an
# option: it hunts for a listener on :8787 and kills it, which on this machine
# is production.
#
# Why they exist at all. install.sh boots the running service OUT before it
# bootstraps the new one, so between those two calls nothing is supervising the
# port. On 2026-08-17 the bootout succeeded and the bootstrap came straight
# back with `Bootstrap failed: 5: Input/output error` — launchd had not
# finished tearing the old job down — and `set -e` ended the script right
# there, having already destroyed the running service. Prod was down ~90s until
# a human re-ran the installer, which succeeded on its first try.
#
# So both halves below address that one window: wait for the bootout to settle
# before bootstrapping, and treat a failed bootstrap as transient until it has
# failed several times rather than exiting on the first one.

# Overridable so the tests can point at a stub and not wait real seconds.
# Production runs set none of these.
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
BOOTOUT_SETTLE_ATTEMPTS="${BOOTOUT_SETTLE_ATTEMPTS:-10}"
BOOTOUT_SETTLE_DELAY="${BOOTOUT_SETTLE_DELAY:-1}"
BOOTSTRAP_ATTEMPTS="${BOOTSTRAP_ATTEMPTS:-5}"
BOOTSTRAP_RETRY_DELAY="${BOOTSTRAP_RETRY_DELAY:-2}"

# Poll until launchd stops reporting the service.
#
# Always returns 0. A service still listed after the wait is a reason to go on
# and let the bootstrap retry loop absorb it, NOT a reason to abort — aborting
# here would leave the machine in exactly the state this file exists to
# prevent, with the old instance gone and no new one.
wait_for_bootout() {
    local service="$1"
    local i
    for ((i = 0; i < BOOTOUT_SETTLE_ATTEMPTS; i++)); do
        if ! "${LAUNCHCTL}" print "${service}" >/dev/null 2>&1; then
            return 0
        fi
        sleep "${BOOTOUT_SETTLE_DELAY}"
    done
    echo "[install] warning: ${service} still listed ${BOOTOUT_SETTLE_ATTEMPTS}s after bootout"
    return 0
}

# Bootstrap the plist, retrying a transient failure.
#
# Returns 0 as soon as one attempt succeeds. On final failure it says what
# state the machine is actually in and names the exact command that restores
# it, then returns 1 — a bare launchctl error here reads like a bad plist when
# the real news is that the service is down.
bootstrap_with_retry() {
    local domain="$1" plist="$2"
    local attempt=1
    while [ "${attempt}" -le "${BOOTSTRAP_ATTEMPTS}" ]; do
        if "${LAUNCHCTL}" bootstrap "${domain}" "${plist}"; then
            if [ "${attempt}" -gt 1 ]; then
                echo "[install] bootstrap succeeded on attempt ${attempt}"
            fi
            return 0
        fi
        echo "[install] bootstrap attempt ${attempt}/${BOOTSTRAP_ATTEMPTS} failed"
        if [ "${attempt}" -lt "${BOOTSTRAP_ATTEMPTS}" ]; then
            sleep "${BOOTSTRAP_RETRY_DELAY}"
        fi
        attempt=$((attempt + 1))
    done

    echo >&2
    echo "[install] ERROR: bootstrap failed ${BOOTSTRAP_ATTEMPTS} times in a row." >&2
    echo "[install] THE SERVICE IS NOT RUNNING. The previous instance was booted" >&2
    echo "[install] out before this step, so nothing is supervising it now." >&2
    echo "[install]" >&2
    echo "[install] Restore it with:" >&2
    echo "[install]" >&2
    echo "    ${LAUNCHCTL} bootstrap ${domain} ${plist}" >&2
    echo "[install]" >&2
    echo "[install] or just re-run this installer. 'Bootstrap failed: 5:" >&2
    echo "[install] Input/output error' is usually launchd still tearing the old" >&2
    echo "[install] job down, and clears on a later attempt." >&2
    return 1
}
