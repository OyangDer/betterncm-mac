#!/bin/bash
# BetterNCM.app launcher for the self-contained build (scripts/build-app.mjs): Node.js and
# BetterNCM are both inside the app, so it works wherever the app is. Opened from Finder or the
# Dock it starts NetEase Cloud Music with BetterNCM injected; if the injector is already running
# it only brings NCM to the front. Given arguments it runs the command line in the foreground
# instead, e.g. /Applications/BetterNCM.app/Contents/MacOS/BetterNCM doctor.
CONTENTS="$(cd "$(dirname "$0")/.." && pwd -P)"
APP="$(dirname "$CONTENTS")"
NODE="$CONTENTS/Resources/node/bin/node"
CLI="$CONTENTS/Resources/app/bin/bncm-mac.mjs"
DATA="${BETTERNCM_PROFILE:-$HOME/Library/Application Support/BetterNCM-mac}"

alert() {
  /usr/bin/osascript -e 'on run argv' -e 'display alert "BetterNCM" message (item 1 of argv) as critical' -e 'end run' "$1" >/dev/null 2>&1
}

# Files copied out of a downloaded disk image keep the download's quarantine flag. Once the app
# itself has been allowed to open, the flag is cleared from the whole bundle, so the Node binary
# inside is not held up by it.
if /usr/bin/xattr -p com.apple.quarantine "$NODE" >/dev/null 2>&1; then
  /usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
fi

if [ $# -gt 0 ] && [ "${1#-psn_}" = "$1" ]; then
  exec "$NODE" "$CLI" "$@"
fi

# Opened straight from the disk image, or from where it was downloaded (macOS then runs it from a
# temporary read-only copy): the Dock would point at a place that goes away.
if [ "$(dirname "$(dirname "$APP")")" = /Volumes ] || [[ "$APP" == */AppTranslocation/* ]]; then
  alert "请先把 BetterNCM 拖进“应用程序”文件夹，再从“应用程序”里打开它。

Drag BetterNCM into the Applications folder first, then open it from there."
  exit 0
fi

mkdir -p "$DATA/log"
# First run of this copy of the app: NCM's icon, the Dock (setup-app).
if [ ! -f "$CONTENTS/Resources/AppIcon.icns" ] || [ "$(cat "$DATA/app-path" 2>/dev/null)" != "$APP" ]; then
  "$NODE" "$CLI" setup-app >> "$DATA/log/wrapper.log" 2>&1
fi

# The injector logs to $DATA/log/injector.log itself; this file only catches crashes. It runs
# detached so this app exits at once (see app-wrapper/BetterNCM.sh for why).
nohup "$NODE" "$CLI" launch --daemon >> "$DATA/log/wrapper.log" 2>&1 &
