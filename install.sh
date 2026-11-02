#!/bin/bash
# One-line installer for betterncm-mac. From npmmirror (fast in mainland China), out of the
# latest npm package (npmmirror's /files/ URLs only serve packages on cnpm/unpkg-white-list),
# or from GitHub:
#
#   curl -fsSL https://registry.npmmirror.com/betterncm-mac/latest | sed -n 's/.*"tarball": *"\([^"]*\)".*/\1/p' | xargs curl -fsSL | tar -xzOf - package/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/OyangDer/betterncm-mac/main/install.sh | bash
#
# Downloads Node.js (checked against the checksums below) and the latest release of this
# project (the npm package betterncm-mac, checked against the registry's integrity hash; GitHub's
# main branch when no registry answers), builds the
# self-contained BetterNCM.app (scripts/build-app.mjs) in /Applications (~/Applications when
# that is not writable, or wherever BetterNCM.app already is), pins it to the Dock and opens it.
# Nothing needs to be installed first. Run it again to update. Files fetched with curl are not
# quarantined, so macOS does not ask whether to trust the app.
#
#   ... | bash -s uninstall     remove BetterNCM.app (plugins and settings are kept); the app's
#                               own BetterNCM.app/Contents/MacOS/BetterNCM uninstall does the same
#
# Environment: BNCM_REF (a GitHub branch or tag instead of the npm release), BNCM_DEST (install
# folder), BNCM_DOCK=1 (also pin BetterNCM.app to the Dock), BNCM_NO_AGENT=1 (no login agent),
# BNCM_NO_OPEN=1, BNCM_SRC (a local checkout instead of the download),
# BNCM_NPM_REGISTRIES (registries to try, in order).

# Node 22 (LTS until April 2027) runs on macOS 11 and later, like NCM 3; Node 23 and later need
# macOS 13.5.
NODE_VERSION=v22.23.4
NODE_SHA256_arm64=037650d0839f457747396f052073fb48333d31bf5abd3c98b74da20d89ebb1ad
NODE_SHA256_x64=f42abca7aaac61efc57d49fb42ea84fc53bbeba9a749cb03a291ce6e4e7a69c1

REPO=OyangDer/betterncm-mac
PKG=betterncm-mac
NPM_REGISTRIES="${BNCM_NPM_REGISTRIES:-https://registry.npmmirror.com https://registry.npmjs.org}"
BUNDLE_ID=cc.microblock.betterncm-mac
# The npmmirror copy is fast in mainland China; the checksum decides either way.
NODE_MIRRORS="https://registry.npmmirror.com/-/binary/node https://nodejs.org/dist"

# Everything runs from main, after bash has read the whole script: piped into bash, the script
# is its stdin, and a command that read stdin would eat the rest of it.
main() {
  set -euo pipefail
  [ "$(uname -s)" = Darwin ] || die "只支持 macOS。" "macOS only."
  local major
  major="$(/usr/bin/sw_vers -productVersion </dev/null | cut -d. -f1)"
  [ "$major" -ge 11 ] || die "需要 macOS 11 或更新的系统。" "Needs macOS 11 or later."

  if [ "${1:-}" = uninstall ]; then
    uninstall
    return
  fi

  local arch
  # Apple silicon, even when this shell runs under Rosetta.
  if [ "$(/usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; else arch=x64; fi
  local sha_var="NODE_SHA256_$arch"
  local sha="${!sha_var}"

  TMP="$(mktemp -d -t betterncm)"
  trap 'rm -rf "$TMP"' EXIT

  say "1/3 下载 Node.js $NODE_VERSION ($arch)"
  local name="node-$NODE_VERSION-darwin-$arch"
  local ok=
  for base in $NODE_MIRRORS; do
    if fetch "$base/$NODE_VERSION/$name.tar.xz" "$TMP/node.tar.xz" && [ "$(sha256 "$TMP/node.tar.xz")" = "$sha" ]; then
      ok=1
      break
    fi
    say "   换一个下载源再试 / trying another source"
  done
  [ -n "$ok" ] || die "下载 Node.js 失败，请检查网络后重试。" "Could not download Node.js; check the network and try again."
  tar -xJf "$TMP/node.tar.xz" -C "$TMP" "$name/bin/node" "$name/LICENSE" </dev/null
  local node="$TMP/$name/bin/node"

  say "2/3 下载 BetterNCM"
  local src
  if [ -n "${BNCM_SRC:-}" ]; then
    src="$BNCM_SRC"
  else
    ok=
    if [ -z "${BNCM_REF:-}" ]; then
      for base in $NPM_REGISTRIES; do
        if fetch_npm "$node" "$base" "$TMP/src.tar.gz"; then
          ok=1
          break
        fi
        say "   换一个下载源再试 / trying another source"
      done
    fi
    if [ -z "$ok" ]; then
      fetch "https://codeload.github.com/$REPO/tar.gz/${BNCM_REF:-main}" "$TMP/src.tar.gz" \
        || die "下载 BetterNCM 失败，请检查网络后重试。" "Could not download BetterNCM; check the network and try again."
    fi
    # npm packs into package/, GitHub into <repo>-<ref>/
    mkdir "$TMP/src"
    tar -xzf "$TMP/src.tar.gz" -C "$TMP/src" --strip-components 1 </dev/null
    src="$TMP/src"
  fi

  say "3/3 安装"
  local dest app
  dest="$(pick_dest)"
  app="$dest/BetterNCM.app"
  if [ -e "$app" ] && [ "$(bundle_id "$app")" != "$BUNDLE_ID" ]; then
    die "$app 已存在，但不是 BetterNCM，没有动它。" "$app exists and is not BetterNCM; left alone."
  fi
  # Built next to where it goes, so swapping it in is a rename on one volume, and the old app
  # stays in $dest (not in $TMP, which the exit trap deletes) until the new one is in place.
  local new="$dest/.BetterNCM-new.app" old="$dest/.BetterNCM-old.app"
  mkdir -p "$dest" 2>/dev/null || cant_write "$dest"
  rm -rf "$new" "$old" 2>/dev/null || cant_write "$dest"
  local built
  if ! built="$("$node" "$src/scripts/build-app.mjs" --node "$node" --node-license "$TMP/$name/LICENSE" --out "$new" </dev/null 2>&1)"; then
    rm -rf "$new"
    case "$built" in *EACCES*|*EPERM*|*EROFS*|*ENOSPC*) cant_write "$dest" ;; esac
    die "生成 BetterNCM.app 失败：$built" "Building BetterNCM.app failed."
  fi
  if [ ! -x "$new/Contents/MacOS/BetterNCM" ]; then
    rm -rf "$new"
    die "生成 BetterNCM.app 失败（没有生成任何文件）。" "Building BetterNCM.app produced nothing."
  fi

  # A running injector reads its app's files, so it is stopped before they change (NCM keeps
  # running). Opening the new app at the end attaches again and reloads NCM's page once.
  local stopped
  if ! stopped="$("$new/Contents/MacOS/BetterNCM" stop </dev/null 2>&1)"; then
    rm -rf "$new"
    die "BetterNCM 正在运行，停不下来。请退出网易云音乐后再试。" "BetterNCM is running and would not stop; quit NetEase Cloud Music and try again."
  fi
  if [ -e "$app" ] && ! mv "$app" "$old"; then
    rm -rf "$new"
    cant_write "$dest"
  fi
  if ! mv "$new" "$app"; then
    rm -rf "$new"
    if [ -e "$old" ]; then mv "$old" "$app" || true; fi
    cant_write "$dest"
  fi
  rm -rf "$old"

  # NCM's icon and the login agent, which from now on gives NCM BetterNCM however it is opened.
  local setup=(setup-app) setup_out
  if [ -n "${BNCM_DOCK:-}" ]; then setup+=(--dock); fi
  if [ -n "${BNCM_NO_AGENT:-}" ]; then setup+=(--no-agent); fi
  setup_out="$("$app/Contents/MacOS/BetterNCM" "${setup[@]}" </dev/null 2>&1 || true)"

  say ""
  say "安装好了：$app"
  case "$setup_out" in
    *"login agent is installed"*|*"installed the login agent"*) say "以后直接打开网易云音乐就带插件，开机、重启后也一样。" ;;
    *) say "后台助手没装上（$setup_out），暂时请从 BetterNCM 打开网易云。" ;;
  esac
  case "$stopped" in
    *"stopping the injector"*) say "网易云正开着：BetterNCM 已经换成新版本，网易云的页面会刷新一次。" ;;
    *) say "网易云正开着的话，会关闭并带着插件重新打开一次。" ;;
  esac
  say "插件开关和卸载：网易云右上角的插件按钮。"
  say ""
  say "Installed $app. Open NetEase Cloud Music as usual; BetterNCM loads into it."
  # Start (or reopen) NCM with BetterNCM now, without asking: this is what was just installed.
  if [ -z "${BNCM_NO_OPEN:-}" ]; then
    nohup "$app/Contents/MacOS/BetterNCM" launch --daemon --replace </dev/null >/dev/null 2>&1 &
  fi
}

uninstall() {
  local app d recorded=
  # Where setup-app last saw it (it may have been moved).
  recorded="$(cat "${BETTERNCM_PROFILE:-$HOME/Library/Application Support/BetterNCM-mac}/app-path" 2>/dev/null </dev/null || true)"
  for d in "${BNCM_DEST:-}" "${recorded:+$(dirname "$recorded")}" /Applications "$HOME/Applications"; do
    [ -n "$d" ] && [ -d "$d/BetterNCM.app" ] && [ "$(bundle_id "$d/BetterNCM.app")" = "$BUNDLE_ID" ] && { app="$d/BetterNCM.app"; break; }
  done
  [ -n "${app:-}" ] || die "没有找到 BetterNCM.app。" "BetterNCM.app was not found."
  if [ -x "$app/Contents/Resources/node/bin/node" ]; then
    "$app/Contents/MacOS/BetterNCM" uninstall </dev/null
    say ""
    say "已卸载 BetterNCM。网易云音乐本身没有被改动过；如果它正开着，退出后从它自己的图标打开就是原版。"
    say "插件和设置还留在 ~/Library/Application Support/BetterNCM-mac，不需要的话可以删掉这个文件夹。"
  else
    # A wrapper made by install-app from a checkout: its CLI is in that checkout.
    die "这是从源码安装的 BetterNCM，请在源码文件夹里运行 node bin/bncm-mac.mjs uninstall。" \
      "This BetterNCM.app was installed from a checkout; run node bin/bncm-mac.mjs uninstall there."
  fi
}

pick_dest() {
  if [ -n "${BNCM_DEST:-}" ]; then echo "$BNCM_DEST"; return; fi
  local d
  for d in /Applications "$HOME/Applications"; do
    if [ -d "$d/BetterNCM.app" ] && [ -w "$d" ]; then echo "$d"; return; fi
  done
  if [ -w /Applications ]; then echo /Applications; else echo "$HOME/Applications"; fi
}

bundle_id() {
  /usr/bin/plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist" 2>/dev/null </dev/null || true
}

# The package's latest release from an npm registry, checked against the sha512 the registry
# lists for it. Node (already downloaded and checked) reads the registry's JSON.
fetch_npm() {
  local node="$1" base="$2" out="$3" meta="$TMP/npm.json" url
  curl -fsSL --retry 2 --connect-timeout 15 --max-time 60 -o "$meta" "$base/$PKG/latest" </dev/null || return 1
  url="$("$node" -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!m.dist || !m.dist.tarball || !/^sha512-/.test(m.dist.integrity || "")) process.exit(1);
    console.log(m.dist.tarball);' "$meta" </dev/null)" || return 1
  fetch "$url" "$out" || return 1
  "$node" -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const got = "sha512-" + require("crypto").createHash("sha512").update(fs.readFileSync(process.argv[2])).digest("base64");
    process.exit(got === m.dist.integrity ? 0 : 1);' "$meta" "$out" </dev/null
}

fetch() {
  # A stalled transfer counts as failed (under 1 KB/s for 30 s), so the next source is tried.
  curl -fL --retry 2 --connect-timeout 15 --speed-limit 1024 --speed-time 30 --progress-bar -o "$2" "$1" </dev/null
}

sha256() {
  /usr/bin/shasum -a 256 "$1" </dev/null | cut -d' ' -f1
}

cant_write() {
  die "无法写入 $1。" "Cannot write to $1."
}

say() {
  printf '%s\n' "$*"
}

die() {
  printf '\n出错了：%s\n%s\n' "$1" "${2:-}" >&2
  exit 1
}

main "$@"
