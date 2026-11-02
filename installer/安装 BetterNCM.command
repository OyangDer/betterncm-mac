#!/bin/bash
# 双击运行：安装或更新 BetterNCM for Mac（网易云音乐插件）。不用先装别的东西。
# 做的事和 README 里那行安装命令一样：从 npm 包里取出 install.sh 再运行，
# 先走国内的 npmmirror 镜像，连不上再试 npm 官方和 GitHub。
clear
echo "BetterNCM for Mac 安装程序"
echo "------------------------------------------"
echo "会下载 BetterNCM 和它自带的 Node.js，装到“应用程序”里，"
echo "放进 Dock，然后带着插件打开网易云音乐。一般不到一分钟。"
echo "已经装过的话，这就是更新。"
echo

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT

fetch() {
  local reg url
  for reg in https://registry.npmmirror.com https://registry.npmjs.org; do
    url=$(curl -fsSL --max-time 20 "$reg/betterncm-mac/latest" | sed -n 's/.*"tarball": *"\([^"]*\)".*/\1/p')
    [ -n "$url" ] && curl -fsSL --max-time 120 "$url" | tar -xzOf - package/install.sh > "$tmp/install.sh" 2>/dev/null \
      && [ -s "$tmp/install.sh" ] && return 0
  done
  curl -fsSL --max-time 60 https://raw.githubusercontent.com/OyangDer/betterncm-mac/main/install.sh > "$tmp/install.sh" \
    && [ -s "$tmp/install.sh" ]
}

if fetch; then
  bash "$tmp/install.sh"
  status=$?
else
  echo "下载失败：请检查网络后再双击一次。"
  status=1
fi

echo
if [ "$status" = 0 ]; then
  echo "✅ 完成。以后点 Dock 里的网易云图标打开就行。"
else
  echo "❌ 没有装好（错误码 $status）。可以把这个窗口截图发给作者。"
fi
echo "按任意键关闭这个窗口……"
read -r -n 1 -s
