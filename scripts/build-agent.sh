#!/bin/bash
# Builds resources/agent/BNCMAgent, the login agent (native/agent/main.swift, src/agent.mjs), as a
# universal binary for macOS 11+. Committed for the same reason as the lyrics host
# (scripts/build-lyrics-host.sh): installs have no compiler. Needs Xcode or the Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=native/agent/main.swift
OUT=resources/agent/BNCMAgent
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$(dirname "$OUT")"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos11" -runtime-compatibility-version none -o "$TMP/$arch" "$SRC"
done
lipo -create -output "$OUT" "$TMP/arm64" "$TMP/x86_64"
codesign --force --sign - "$OUT"
lipo -info "$OUT"
