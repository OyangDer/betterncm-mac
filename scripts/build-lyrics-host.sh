#!/bin/bash
# Builds resources/lyrics/BNCMLyrics, the lyrics window host (LYRICS-WINDOW.md), as a universal
# binary for macOS 11+. The binary is committed, because installs build BetterNCM.app without a
# compiler; rebuild it after changing native/lyrics-host/. Needs Xcode or the Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=native/lyrics-host/main.swift
OUT=resources/lyrics/BNCMLyrics
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for arch in arm64 x86_64; do
  # The Command Line Tools on recent macOS ship the back-deployment shims for arm64 only; nothing
  # here uses what they back-deploy (concurrency, parameter packs), so link without them.
  swiftc -O -target "$arch-apple-macos11" -runtime-compatibility-version none -o "$TMP/$arch" "$SRC"
done
lipo -create -output "$OUT" "$TMP/arm64" "$TMP/x86_64"
codesign --force --sign - "$OUT"
lipo -info "$OUT"
