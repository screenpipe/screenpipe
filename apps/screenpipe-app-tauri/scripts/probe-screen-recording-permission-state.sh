#!/bin/bash

# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

set -euo pipefail

if ! command -v clang >/dev/null 2>&1; then
  echo "error: clang is required; install Xcode Command Line Tools" >&2
  exit 2
fi

probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/screenpipe-tcc-probe.XXXXXX")"
trap 'rm -rf "$probe_dir"' EXIT

probe_source="$probe_dir/probe.c"
probe_binary="$probe_dir/probe"

cat >"$probe_source" <<'EOF'
// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

typedef uint32_t (*TCCAccessPreflightFn)(CFStringRef service);

static const char *state_name(bool cached_preflight, bool live_preflight) {
    if (!cached_preflight && !live_preflight) {
        return "denied";
    }
    if (cached_preflight && live_preflight) {
        return "granted";
    }
    if (!cached_preflight && live_preflight) {
        return "granted_needs_restart";
    }
    return "revoked_but_cached";
}

static int direct_tcc_preflight(uint32_t *result_out) {
    const char *tcc_path = "/System/Library/PrivateFrameworks/TCC.framework/TCC";
    void *tcc = dlopen(tcc_path, RTLD_LAZY | RTLD_LOCAL);
    if (tcc == NULL) {
        fprintf(stderr, "error: dlopen TCC.framework failed: %s\n", dlerror());
        return 10;
    }

    TCCAccessPreflightFn live_check =
        (TCCAccessPreflightFn)dlsym(tcc, "TCCAccessPreflight");
    const CFStringRef *screen_capture_service =
        (const CFStringRef *)dlsym(tcc, "kTCCServiceScreenCapture");

    if (live_check == NULL) {
        fprintf(stderr, "error: TCCAccessPreflight is unavailable\n");
        dlclose(tcc);
        return 11;
    }
    if (screen_capture_service == NULL || *screen_capture_service == NULL) {
        fprintf(stderr, "error: kTCCServiceScreenCapture is unavailable\n");
        dlclose(tcc);
        return 12;
    }

    *result_out = live_check(*screen_capture_service);
    dlclose(tcc);
    return 0;
}

int main(void) {
    uint32_t live_raw = 0;
    int direct_result = direct_tcc_preflight(&live_raw);
    if (direct_result != 0) {
        return direct_result;
    }

    bool cached_preflight = CGPreflightScreenCaptureAccess();
    bool live_preflight = live_raw == 0;

    printf("cached_preflight=%s\n", cached_preflight ? "true" : "false");
    printf("live_preflight=%s\n", live_preflight ? "true" : "false");
    printf("live_raw=%u\n", live_raw);
    printf("state=%s\n", state_name(cached_preflight, live_preflight));

    return 0;
}
EOF

clang \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -framework CoreGraphics \
  -framework CoreFoundation \
  "$probe_source" \
  -o "$probe_binary"

echo "macos_version=$(sw_vers -productVersion)"
echo "macos_build=$(sw_vers -buildVersion)"
echo "architecture=$(uname -m)"
"$probe_binary"
