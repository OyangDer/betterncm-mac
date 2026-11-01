# betterncm-mac

让 macOS 版网易云音乐 3.x 也能用 [BetterNCM](https://github.com/std-microblock/chromatic) 插件（比如 RefinedNowPlayingNext 歌词页）。

它**不修改网易云音乐本身**：用调试端口启动网易云，再通过 Chrome DevTools Protocol 把 BetterNCM 的插件框架注入进去。不想用了，[卸载](#卸载)后正常打开网易云就是原版。

> 非官方项目，与网易云音乐、BetterNCM 官方均无关系。只在 macOS 网易云音乐 **3.1.14** 上测试过。

## 需要

- macOS 11 或更新，Apple 芯片或 Intel 都可以
- 网易云音乐 3.x，装在“应用程序”里（2.x 不支持）

不用另外装 Node.js 或别的东西。

## 安装

打开“终端”（在启动台或聚焦搜索里搜“终端”），粘贴下面这一行，按回车：

```bash
curl -fsSL https://registry.npmmirror.com/betterncm-mac/latest | sed -n 's/.*"tarball": *"\([^"]*\)".*/\1/p' | xargs curl -fsSL | tar -xzOf - package/install.sh | bash
```

这一行走国内的 npmmirror 镜像（从 npm 包里取出安装脚本再运行），在国内外都能用。国外也可以用 GitHub 的地址，短一些：

```bash
curl -fsSL https://raw.githubusercontent.com/OyangDer/betterncm-mac/main/install.sh | bash
```

它会下载 BetterNCM 和它要用的 Node.js（自带，不影响电脑上原有的东西），装到“应用程序”里，固定到 Dock，然后打开。整个过程一般不到一分钟。两样都优先从国内镜像下载，并核对校验值；镜像连不上时改从 npm 官方或 GitHub 下载。装好的 BetterNCM 用网易云的图标，在中文系统里叫“网易云音乐 BetterNCM”，在英文系统里叫“NetEaseMusic BetterNCM”，聚焦搜索里输入“网易云”或“BetterNCM”就能找到。

以后**都从它打开网易云**。从网易云自己的图标打开的话，网易云启动时不带调试端口，插件加载不进去。如果 BetterNCM 还在后台（网易云退出后 20 秒内），它会在一两秒内把网易云换成带插件的；否则就是原版网易云。

**更新**：再运行一次上面那行命令。网易云开着也没关系，会直接换成新版本，网易云的页面刷新一次。

第一次打开时：

1. 如果网易云已经开着，会问你要不要用 BetterNCM 重新打开它，点“重新打开”。
2. macOS 可能会问是否允许“BetterNCM”或“node”（BetterNCM 的后台程序）控制“网易云音乐”，点“允许”。BetterNCM 需要这个权限来退出、重启网易云。
3. 点播放栏左下角的封面，打开的就是 RefinedNowPlayingNext 的歌词页（已经自带，不用另外装）。

### 从源码安装

需要 [Node.js](https://nodejs.org/) 22 或更高版本：

```bash
git clone https://github.com/OyangDer/betterncm-mac.git
cd betterncm-mac
node bin/bncm-mac.mjs install-app --dock
```

这样生成的 `~/Applications/BetterNCM.app` 直接运行这个文件夹里的代码，改了代码重启网易云就生效，适合开发。项目文件夹挪了位置，或者 Node 换了安装方式，在新位置重新运行一次 `install-app` 就行。

## 插件

自带 **RefinedNowPlayingNext** 3.0.2，第一次打开时自动装好：它把正在播放页换成了更好看的歌词页。网易云自己打开的正在播放页（比如进入“漫游”时）也会换成它；漫游时它的控制栏里会出现“减少推荐”按钮，替代用不上的播放列表按钮。BetterNCM 的 Mac 适配就是对着这个版本做的。它的“专辑封面清晰度”默认调到最高（800），在 Retina 屏上封面不会糊；在它的设置里改过的话，按你改的来。如果你已经装过某个版本的 RefinedNowPlayingNext，就用你的那个，不会覆盖；删掉它之后也不会再自动装回来。

BetterNCM 的插件管理和插件市场默认**隐藏**：市场里的插件大多数在 Mac 上用不了（2026 年 11 月统计：87 个里 58 个不支持网易云 3.x；支持 3.x 的 29 个里，约 15 个依赖 Windows 的 DLL 或程序，或者只认旧版界面）。想自己折腾，在设置里加上 `"mac.pluginManager": "true"`，然后运行 [`reload` 命令](#命令)或重启网易云，右上角设置按钮旁边就会出现 BetterNCM 按钮，里面有插件管理和插件市场。以前从插件市场装过的插件，隐藏后照样加载，只是没有了管理它们的界面。插件市场默认从 GitHub 下载；连不上 GitHub 时，会自动改从 jsDelivr 镜像下载。

## 设置

设置都在 `~/Library/Application Support/BetterNCM-mac/config.json` 里，这是一个 JSON 对象。添加设置时，把键加进现有的 `{ }` 里，不要整个替换，里面还有插件自己的设置。

### 外观

`mac.rnpAppleStyle` 和 `mac.rnpAutoLyricSize` 默认打开，`mac.stopMiniVinyl` 默认关闭。要改，就把对应的键设成 `"true"` 或 `"false"`，然后运行 [`reload` 命令](#命令)或重启网易云，例如：

```json
"mac.rnpAppleStyle": "false",
"mac.stopMiniVinyl": "true"
```

| 配置 | 作用 |
|---|---|
| `mac.rnpAppleStyle` | 让 RefinedNowPlayingNext 更像 Apple Music：歌词栏更窄，封面更大，封面和控件稍微下移，音量变成“···”旁边的小按钮（鼠标放上去展开），暂停时封面缩小；右上角的 × 换成常驻的向下收起箭头，设置和歌词复制模式按钮移到它旁边，只在鼠标靠近时出现；“···”菜单换成 Apple Music 那样的半透明菜单；歌词右侧的“译 / 音 / 逐字”开关和其他按钮统一成圆形样式；中文翻译比原文小一号（歌词越大缩得越多），不再显得比原文还重；右上角设置按钮旁边多了一个小图标（和设置一样，鼠标靠近右上角才出现），鼠标放上去向左展开成歌词、百科、相似推荐、评论四个，点哪个就切到哪个；内容就是网易云自己的（点赞、回复、发评论、播放相似歌曲都照常能用），配色跟着封面走；在封面一侧往下滚动也能打开评论，评论已经在顶部时再往上滑一下就回到歌词（快速往上划到顶的惯性不算，不会误跳） |
| `mac.stopMiniVinyl` | 让播放栏左下角的小黑胶不再转圈，稍微省电（默认关闭，小黑胶照常转） |
| `mac.rnpAutoLyricSize` | 歌词字号跟着窗口大小变：RefinedNowPlayingNext 设置里的“字体大小”当作全屏时的字号，窗口变小就按比例缩小（最小一半，不小于 16px） |

### 其他

改完之后退出网易云，再从 BetterNCM.app 打开才会生效（`reload` 不行）。

| 配置 | 作用 |
|---|---|
| `mac.pluginManager` | 设成 `"true"` 显示 BetterNCM 的插件管理和插件市场（默认隐藏，见[插件](#插件)） |
| `mac.ncmApp` | 网易云不在“应用程序”里时，填它的 `.app` 完整路径 |
| `mac.cdpPort` | 调试端口，默认 `9222`，被占用时自动换一个 |

## 耗电

网易云本身播放时就要占约 20% CPU，所以在电池菜单里看到它是正常的。BetterNCM 的框架本身花费很小；最耗电的是 RefinedNowPlayingNext 打开时的逐字歌词动画。不看歌词时关掉歌词页，或者让网易云窗口被挡住、最小化，就能省下大部分：窗口不在画的时候，BetterNCM 会把给插件的播放进度从每秒 10 次降到 1 次，窗口一出现就恢复。下面是作者在 3.1.14 上测的数，仅供参考：

| 状态 | 网易云进程 CPU |
|---|---|
| 原版，播放中 | 约 20% |
| BetterNCM，关着歌词页 | 约 30% |
| BetterNCM，开着 RefinedNowPlayingNext 歌词页 | 约 50–60% |
| BetterNCM，歌词页开着但窗口被挡住、在其他桌面或最小化 | 约 3–6% |

## 出问题时

- 运行 [`doctor` 命令](#命令)，最后几行会用 OK / WARN / FAIL 列出 Node、网易云、BetterNCM.app 的状态。
- 日志在 `~/Library/Application Support/BetterNCM-mac/log/injector.log`。
- 从 BetterNCM.app 启动失败时会弹窗说明原因。
- 一直提示“没有控制网易云音乐的权限”：到“系统设置 → 隐私与安全性 → 自动化”，在“node”（或“BetterNCM”）下面打开“网易云音乐”。
- 网易云自动更新到没测过的版本时，会提示一次，然后照常加载。哪个插件不正常，就先在插件管理里关掉它。

## 安全提示

用 BetterNCM 打开网易云时，它会在 `127.0.0.1` 上开一个调试端口。**这台 Mac 上的任何程序都能通过这个端口控制网易云**，包括已登录的账号和 cookie。别的设备连不上。退出网易云，端口就关了。如果你会运行不信任的程序，请注意这一点。

## 卸载

用一行命令装的，在终端里运行（装在 `~/Applications` 的话，前面换成 `~/Applications`）：

```bash
/Applications/BetterNCM.app/Contents/MacOS/BetterNCM uninstall
```

它会停止 BetterNCM，删掉 BetterNCM.app 和它的 Dock 图标，保留插件和设置（在 `~/Library/Application Support/BetterNCM-mac`，不要了可以直接删掉这个文件夹）。从源码装的，在项目文件夹里运行 `node bin/bncm-mac.mjs uninstall`（加 `--purge` 会同时删掉插件、设置和日志），之后项目文件夹也可以删掉。

卸载后退出网易云，再从它自己的图标打开，就是原版。

不卸载、只是想临时用一次原版：退出网易云后**等 20 秒**再从它自己的图标打开。BetterNCM 会在网易云退出后等它 20 秒（为了网易云自己重启时能接上），这段时间内重新打开的网易云会被它换成带插件的。

## 命令

用一行命令装的，命令这样运行（BetterNCM.app 在“应用程序”里时；装在 `~/Applications` 的话前面换成 `~/Applications`）：

```bash
/Applications/BetterNCM.app/Contents/MacOS/BetterNCM doctor
```

从源码装的，在项目文件夹里用 `node bin/bncm-mac.mjs doctor`。

```
launch [--daemon] [--port N]   启动（或找到）网易云并注入，BetterNCM.app 用的就是它
attach [--port N]              只连接已经带调试端口的网易云，不会启动或退出它
doctor                         检查环境
reload                         重新解压插件并刷新页面
stop                           停止 BetterNCM 的后台程序（网易云继续开着，再从 BetterNCM.app 打开即可恢复）
uninstall [--purge]            卸载（--purge 同时删掉插件、设置和日志）
install-app [--dock]           （源码）生成 BetterNCM.app，--dock 同时固定到 Dock
uninstall-app                  （源码）删除 BetterNCM.app 和它的 Dock 图标
```

## 开发

```bash
npm test             # 不需要 npm install
npm run build:fw     # 重新构建 dist/framework.js（需要 framework/ 的依赖）
BNCM_SRC="$PWD" BNCM_DEST=/tmp/bncm-test BETTERNCM_PROFILE=/tmp/bncm-test/profile \
  BNCM_NO_DOCK=1 BNCM_NO_OPEN=1 bash install.sh   # 用这个文件夹试装，不影响已装的那份
```

一行命令安装用的是 [install.sh](install.sh)：它下载固定版本的 Node.js（22，按文件里的 SHA-256 校验）和 npm 包 `betterncm-mac` 的最新版本（按 npm 记录的 sha512 校验；先试 npmmirror，再试 npm 官方，都不行就用 GitHub 的 main 分支），再用 [scripts/build-app.mjs](scripts/build-app.mjs) 生成自带 Node.js 的 BetterNCM.app。升级 Node.js 时同时改版本号和两个校验值。

### 发布新版本

用户装到的是 npm 上的最新版本，所以改完要发布才会生效：

```bash
npm login                  # 第一次需要，登录 npm 账号
npm test
npm version patch          # 0.1.0 → 0.1.1，同时生成一个 git 提交和标签
npm publish
git push --follow-tags
```

npmmirror 一般几分钟内自动同步；想马上同步，打开 https://npmmirror.com/package/betterncm-mac 点“同步”。包里包含哪些文件由 `package.json` 的 `files` 决定，可以先用 `npm pack --dry-run` 看。

设计说明见 [DESIGN.md](DESIGN.md)，页面与原生接口约定见 [CONTRACT.md](CONTRACT.md)。

## 致谢

- [std-microblock](https://github.com/std-microblock)：BetterNCM 及其后继 [chromatic](https://github.com/std-microblock/chromatic) 的作者。本项目是在 macOS 上对 BetterNCM II 的重新实现。
- [BetterNCM/js-framework](https://github.com/BetterNCM/js-framework)：BetterNCM 的页面端框架。`framework/` 和 `dist/framework.js` 来自它，为 macOS 做了修改，改动见 [patches/js-framework-mac.patch](patches/js-framework-mac.patch)。
- [BetterNCM/Plugin-Market](https://github.com/BetterNCM/Plugin-Market)：插件市场。`resources/PluginMarket.plugin` 是它的打包版本。
- [BetterNCM/BetterNCM-Packed-Plugins](https://github.com/BetterNCM/BetterNCM-Packed-Plugins)：插件仓库。
- [solstice23](https://github.com/solstice23/refined-now-playing-netease)（RefinedNowPlaying）和 [SUlTlUS / MiHN](https://github.com/SUlTlUS/refined-now-playing-netease-next)（RefinedNowPlayingNext）：`resources/RefinedNowPlayingNext-3.0.2.plugin` 是它在插件市场里的打包版本，随附 MIT 协议（[resources/RefinedNowPlayingNext-LICENSE.txt](resources/RefinedNowPlayingNext-LICENSE.txt)）；`src/prelude/compat-rnp-*.js` 是针对它的兼容和外观调整。
- [Steve-xmh/mmbncm](https://github.com/Steve-xmh/mmbncm)：网易云 2.x 时代的 macOS BetterNCM 方案。
- [npm/node-semver](https://github.com/npm/node-semver)：随附在 `vendor/semver/`（ISC 协议）。

## 协议

[GPL-3.0](LICENSE)，与它所基于的 js-framework、Plugin-Market 一致。`vendor/semver/` 使用其自带的 ISC 协议，随附的 RefinedNowPlayingNext 使用 MIT 协议。
