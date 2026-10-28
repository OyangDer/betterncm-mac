# betterncm-mac

让 macOS 版网易云音乐 3.x 也能用 [BetterNCM](https://github.com/std-microblock/chromatic) 插件（比如 RefinedNowPlayingNext 歌词页）。

它**不修改网易云音乐本身**：用调试端口启动网易云，再通过 Chrome DevTools Protocol 把 BetterNCM 的插件框架注入进去。不想用了，[卸载](#卸载)后正常打开网易云就是原版。

> 非官方项目，与网易云音乐、BetterNCM 官方均无关系。只在 macOS 网易云音乐 **3.1.14** 上测试过。

## 需要

- macOS，Apple Silicon 或 Intel 都可以
- 网易云音乐 3.x，装在“应用程序”里（2.x 不支持）
- [Node.js](https://nodejs.org/) 22 或更高版本（`node -v` 查看）

## 安装

```bash
git clone https://github.com/OyangDer/betterncm-mac.git
cd betterncm-mac
node bin/bncm-mac.mjs install-app --dock
```

这会生成 `~/Applications/BetterNCM.app`，`--dock` 会把它固定到 Dock（不想固定就去掉这个参数）。它用网易云的图标，在中文系统里显示为“网易云音乐 BetterNCM”，在英文系统里显示为“NetEaseMusic BetterNCM”，所以在聚焦搜索或启动台里，中文系统输入“网易云”、英文系统输入“netease”就能找到（输入“BetterNCM”两种系统都行）。

以后**都从它打开网易云**。从网易云自己的图标打开的话，网易云启动时不带调试端口，插件加载不进去。如果 BetterNCM 还在后台（网易云退出后 20 秒内），它会在一两秒内把网易云换成带插件的；否则就是原版网易云。

第一次打开时：

1. 如果网易云已经开着，会问你要不要用 BetterNCM 重新打开它，点“重新打开”。
2. macOS 可能会问是否允许“node”（BetterNCM 的后台程序）控制“网易云音乐”，点“允许”。BetterNCM 需要这个权限来退出、重启网易云。
3. 网易云打开后，右上角设置按钮旁边会多出一个 BetterNCM 按钮，里面有插件管理和插件市场。

项目文件夹挪了位置，或者 Node 换了安装方式，在新位置重新运行一次 `install-app` 就行。

## 插件

在插件市场里安装。推荐 **RefinedNowPlayingNext**，它把正在播放页换成了更好看的歌词页。网易云自己打开的正在播放页（比如进入“漫游”时）也会换成它；漫游时它的控制栏里会出现“减少推荐”按钮，替代用不上的播放列表按钮。

带原生（Windows DLL）部分的插件在 Mac 上用不了，例如 InfLink-rs（Windows 系统媒体控制）。插件市场默认从 GitHub 下载；连不上 GitHub 时，会自动改从 jsDelivr 镜像下载。

## 设置

设置都在 `~/Library/Application Support/BetterNCM-mac/config.json` 里，这是一个 JSON 对象。添加设置时，把键加进现有的 `{ }` 里，不要整个替换，里面还有插件自己的设置。

### 可选外观

下面三项默认关闭。要打开，就加上对应的键，然后运行 `node bin/bncm-mac.mjs reload` 或重启网易云：

```json
"mac.rnpAppleStyle": "true",
"mac.stopMiniVinyl": "true",
"mac.rnpAutoLyricSize": "true"
```

| 配置 | 作用 |
|---|---|
| `mac.rnpAppleStyle` | 让 RefinedNowPlayingNext 更像 Apple Music：歌词栏更窄，封面更大，封面和控件稍微下移，音量变成“···”旁边的小按钮（鼠标放上去展开），暂停时封面缩小 |
| `mac.stopMiniVinyl` | 让播放栏左下角的小黑胶不再转圈，更省电 |
| `mac.rnpAutoLyricSize` | 歌词字号跟着窗口大小变：RefinedNowPlayingNext 设置里的“字体大小”当作全屏时的字号，窗口变小就按比例缩小（最小一半，不小于 16px） |

### 其他

改完之后退出网易云，再从 BetterNCM.app 打开才会生效（`reload` 不行）。

| 配置 | 作用 |
|---|---|
| `mac.ncmApp` | 网易云不在“应用程序”里时，填它的 `.app` 完整路径 |
| `mac.cdpPort` | 调试端口，默认 `9222`，被占用时自动换一个 |

## 耗电

网易云本身播放时就要占约 20% CPU，所以在电池菜单里看到它是正常的。BetterNCM 的框架本身花费很小；最耗电的是 RefinedNowPlayingNext 打开时的逐字歌词动画。不看歌词时关掉歌词页，或者把网易云最小化，就能省下大部分。下面是作者在 3.1.14 上测的数，仅供参考：

| 状态 | 网易云进程 CPU |
|---|---|
| 原版，播放中 | 约 20% |
| BetterNCM，关着歌词页 | 约 30% |
| BetterNCM，开着 RefinedNowPlayingNext 歌词页 | 约 60% |

## 出问题时

- 运行 `node bin/bncm-mac.mjs doctor`，最后几行会用 OK / WARN / FAIL 列出 Node、网易云、BetterNCM.app 的状态。
- 日志在 `~/Library/Application Support/BetterNCM-mac/log/injector.log`。
- 从 BetterNCM.app 启动失败时会弹窗说明原因。
- 一直提示“没有控制网易云音乐的权限”：到“系统设置 → 隐私与安全性 → 自动化”，在“node”（或“BetterNCM”）下面打开“网易云音乐”。
- 网易云自动更新到没测过的版本时，会提示一次，然后照常加载。哪个插件不正常，就先在插件管理里关掉它。

## 安全提示

用 BetterNCM 打开网易云时，它会在 `127.0.0.1` 上开一个调试端口。**这台 Mac 上的任何程序都能通过这个端口控制网易云**，包括已登录的账号和 cookie。别的设备连不上。退出网易云，端口就关了。如果你会运行不信任的程序，请注意这一点。

## 卸载

```bash
node bin/bncm-mac.mjs uninstall          # 停止 BetterNCM，删掉 BetterNCM.app 和它的 Dock 图标，保留插件和设置
node bin/bncm-mac.mjs uninstall --purge  # 同时删掉插件、设置和日志
```

卸载后退出网易云，再从它自己的图标打开，就是原版。项目文件夹可以直接删掉。

不卸载、只是想临时用一次原版：退出网易云后**等 20 秒**再从它自己的图标打开。BetterNCM 会在网易云退出后等它 20 秒（为了网易云自己重启时能接上），这段时间内重新打开的网易云会被它换成带插件的。

## 命令

```
node bin/bncm-mac.mjs launch [--daemon] [--port N]   启动（或找到）网易云并注入，BetterNCM.app 用的就是它
node bin/bncm-mac.mjs attach [--port N]              只连接已经带调试端口的网易云，不会启动或退出它
node bin/bncm-mac.mjs doctor                         检查环境
node bin/bncm-mac.mjs reload                         重新解压插件并刷新页面
node bin/bncm-mac.mjs install-app [--dock]          生成 BetterNCM.app（--dock 同时固定到 Dock）
node bin/bncm-mac.mjs uninstall-app                  删除 BetterNCM.app 和它的 Dock 图标
node bin/bncm-mac.mjs uninstall [--purge]            卸载
```

## 开发

```bash
npm test             # 不需要 npm install
npm run build:fw     # 重新构建 dist/framework.js（需要 framework/ 的依赖）
```

设计说明见 [DESIGN.md](DESIGN.md)，页面与原生接口约定见 [CONTRACT.md](CONTRACT.md)。

## 致谢

- [std-microblock](https://github.com/std-microblock)：BetterNCM 及其后继 [chromatic](https://github.com/std-microblock/chromatic) 的作者。本项目是在 macOS 上对 BetterNCM II 的重新实现。
- [BetterNCM/js-framework](https://github.com/BetterNCM/js-framework)：BetterNCM 的页面端框架。`framework/` 和 `dist/framework.js` 来自它，为 macOS 做了修改，改动见 [patches/js-framework-mac.patch](patches/js-framework-mac.patch)。
- [BetterNCM/Plugin-Market](https://github.com/BetterNCM/Plugin-Market)：插件市场。`resources/PluginMarket.plugin` 是它的打包版本。
- [BetterNCM/BetterNCM-Packed-Plugins](https://github.com/BetterNCM/BetterNCM-Packed-Plugins)：插件仓库。
- [solstice23](https://github.com/solstice23/refined-now-playing-netease)（RefinedNowPlaying）和 [SUlTlUS / MiHN](https://github.com/SUlTlUS/refined-now-playing-netease-next)（RefinedNowPlayingNext）：`src/prelude/compat-rnp-*.js` 是针对它的兼容和外观调整。
- [Steve-xmh/mmbncm](https://github.com/Steve-xmh/mmbncm)：网易云 2.x 时代的 macOS BetterNCM 方案。
- [npm/node-semver](https://github.com/npm/node-semver)：随附在 `vendor/semver/`（ISC 协议）。

## 协议

[GPL-3.0](LICENSE)，与它所基于的 js-framework、Plugin-Market 一致。`vendor/semver/` 使用其自带的 ISC 协议。
