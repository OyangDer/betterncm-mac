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

它会下载 BetterNCM 和它要用的 Node.js（自带，不影响电脑上原有的东西），装到“应用程序”里，放进 Dock（换掉 Dock 里原来的网易云图标），再装一个后台小助手，然后带着插件打开网易云。整个过程一般不到一分钟。两样都优先从国内镜像下载，并核对校验值；镜像连不上时改从 npm 官方或 GitHub 下载。装好的 BetterNCM 用网易云的图标，在中文系统里叫“网易云音乐 BetterNCM”，在英文系统里叫“NetEaseMusic BetterNCM”，聚焦搜索里输入“网易云”或“BetterNCM”就能找到。

以后**点 Dock 里的网易云图标**就行：那是 BetterNCM（用的是网易云的图标），直接带着插件打开网易云。网易云启动时必须带调试端口插件才加载得进去，而网易云自己的图标不带。

从别处打开了原版网易云（开机时 macOS 自动重新打开、聚焦搜索、启动台），后台小助手（一个登录项，不在 Dock 里出现，平时不占 CPU）会在一两秒内把它关掉、带上插件重新打开，窗口会闪一下。网易云自己重启时也会自动接上。已经开着很久的原版网易云（比如装 BetterNCM 之前就开着的）它不会去动，免得打断正在播放的音乐；点一下 Dock 里的图标就会换成带插件的。

**更新**：再运行一次上面那行命令。网易云开着也没关系，会直接换成新版本，网易云的页面刷新一次。

装好时：

1. 网易云正开着的话，会关闭并带着插件重新打开一次。
2. macOS 会通知“BNCMAgent 可以在后台运行”，这就是后台小助手，在“系统设置 → 通用 → 登录项与扩展”里能看到。
3. 网易云右上角（设置按钮旁边）多了一个拼图形状的“插件”按钮，见[插件](#插件)。点播放栏左下角的封面，打开的是 BetterNCM 的[歌词窗口](#歌词窗口)。


### 从源码安装

需要 [Node.js](https://nodejs.org/) 22 或更高版本：

```bash
git clone https://github.com/OyangDer/betterncm-mac.git
cd betterncm-mac
node bin/bncm-mac.mjs install-app --dock
```

这样生成的 `~/Applications/BetterNCM.app` 直接运行这个文件夹里的代码，改了代码重启网易云就生效，适合开发。项目文件夹挪了位置，或者 Node 换了安装方式，在新位置重新运行一次 `install-app` 就行。

## 插件

网易云右上角的**插件**按钮（设置按钮旁边，拼图图标）打开一个小面板：

- 每个插件一个开关。关掉的插件不再加载（记在数据文件夹的 `disable_list.txt` 里）；面板关上时网易云的页面刷新一次，改动随之生效。
- 第一行“歌词窗口”是 BetterNCM 自带的歌词页，关掉就换回 RefinedNowPlayingNext，页面马上刷新。
- 最下面是“卸载 BetterNCM”，确认后会[卸载](#卸载)，网易云关闭并以原版重新打开。

点播放栏左下角的封面，打开的是 BetterNCM 自己的[歌词窗口](#歌词窗口)。它照着 RefinedNowPlayingNext 的歌词页做，但耗电少得多。

另外自带 **RefinedNowPlayingNext** 3.0.2，在[换回它](#歌词窗口)时才会加载，第一次打开时自动装好：它把正在播放页换成了更好看的歌词页。网易云自己打开的正在播放页（比如进入“漫游”时）也会换成它；漫游时它的控制栏里会出现“减少推荐”按钮，替代用不上的播放列表按钮。BetterNCM 的 Mac 适配就是对着这个版本做的。它的“专辑封面清晰度”默认调到最高（800），在 Retina 屏上封面不会糊；在它的设置里改过的话，按你改的来。如果你已经装过某个版本的 RefinedNowPlayingNext，就用你的那个，不会覆盖；删掉它之后也不会再自动装回来。

BetterNCM 的插件管理和插件市场默认**隐藏**：市场里的插件大多数在 Mac 上用不了（2026 年 11 月统计：87 个里 58 个不支持网易云 3.x；支持 3.x 的 29 个里，约 15 个依赖 Windows 的 DLL 或程序，或者只认旧版界面）。想自己折腾，在设置里加上 `"mac.pluginManager": "true"`，然后运行 [`reload` 命令](#命令)或重启网易云，右上角设置按钮旁边就会出现 BetterNCM 按钮，里面有插件管理和插件市场。以前从插件市场装过的插件，隐藏后照样加载，只是没有了管理它们的界面。插件市场默认从 GitHub 下载；连不上 GitHub 时，会自动改从 jsDelivr 镜像下载。

## 歌词窗口

点播放栏左下角的封面，打开的是 BetterNCM 自己的歌词窗口，不再是网易云页面里的 RefinedNowPlayingNext（RNPN）。

**和原来一样的部分**
- 封面、标题、进度条、控件和歌词的位置、字号、动效，都照着 RNPN 3.0.2 和之前的 Apple Music 风格调整还原。
- 右上角可以切换 歌词 / 百科 / 相似推荐 / 评论；在封面一侧往下滚动也能打开评论。
- "···" 菜单、复制模式都还在。
- 第一次打开时，会自动沿用你在 RNPN 里的设置。

**设置**：右上角的设置按钮打开一个半透明面板，按 歌词 / 外观 / 背景 / 封面与信息 / 字体 / 关于 分组，改动即时生效，保存在 `~/Library/Application Support/BetterNCM-mac/lyrics-settings.json`。“关于”里可以恢复默认设置。

**为什么换**：RNPN 的页面在网易云的 Chromium 里每帧都要重画：实时模糊背景、每行歌词一层滤镜。歌词窗口用 macOS 自带的 WebKit 来画：
- 背景每首歌只模糊一次；
- 动画都交给 GPU 合成；
- 只有换行时才运行脚本。

网易云的窗口被它盖住时会停止绘制。

**操作**
- 收起：右上角向下箭头、Esc、⌘W 或红色关闭按钮都可以。网易云的窗口会出现在歌词窗口刚才的位置。
- 黄色按钮：把歌词窗口和网易云一起最小化。
- 空格：播放或暂停。
- 按住 Shift 点封面：打开网易云自己的播放页。
- 收藏到歌单、下载、分享、减少推荐等需要网易云弹窗的操作，会先收起歌词窗口，再在网易云里打开。

**换回 RNPN**：在网易云右上角的[插件](#插件)面板里关掉“歌词窗口”。也可以在设置里加上 `"mac.lyricsWindow": "false"`。

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
| `mac.rnpAppleStyle` | （只在换回 RNPN 时有用）让 RefinedNowPlayingNext 更像 Apple Music：歌词栏更窄，封面更大，封面和控件稍微下移，音量变成“···”旁边的小按钮（鼠标放上去展开），暂停时封面缩小；右上角的 × 换成常驻的向下收起箭头，设置和歌词复制模式按钮移到它旁边，只在鼠标靠近时出现；“···”菜单换成 Apple Music 那样的半透明菜单；歌词右侧的“译 / 音 / 逐字”开关和其他按钮统一成圆形样式；中文翻译比原文小一号（歌词越大缩得越多），不再显得比原文还重；右上角设置按钮旁边多了一个小图标（和设置一样，鼠标靠近右上角才出现），鼠标放上去向左展开成歌词、百科、相似推荐、评论四个，点哪个就切到哪个；内容就是网易云自己的（点赞、回复、发评论、播放相似歌曲都照常能用），配色跟着封面走；在封面一侧往下滚动也能打开评论，评论已经在顶部时再往上滑一下就回到歌词（快速往上划到顶的惯性不算，不会误跳） |
| `mac.stopMiniVinyl` | 让播放栏左下角的小黑胶不再转圈，稍微省电（默认关闭，小黑胶照常转） |
| `mac.rnpAutoLyricSize` | （只在换回 RNPN 时有用）歌词字号跟着窗口大小变：RefinedNowPlayingNext 设置里的“字体大小”当作全屏时的字号，窗口变小就按比例缩小（最小一半，不小于 16px） |

### 其他

改完之后退出网易云再打开才会生效（`reload` 不行）。

| 配置 | 作用 |
|---|---|
| `mac.lyricsWindow` | 默认 `"true"`：用 BetterNCM 自己的[歌词窗口](#歌词窗口)；设成 `"false"` 换回网页里的 RefinedNowPlayingNext |
| `mac.pluginManager` | 设成 `"true"` 显示 BetterNCM 的插件管理和插件市场（默认隐藏，见[插件](#插件)） |
| `mac.ncmApp` | 网易云不在“应用程序”里时，填它的 `.app` 完整路径 |
| `mac.cdpPort` | 调试端口，默认 `9222`，被占用时自动换一个 |

## 耗电

网易云本身播放时就要占不少 CPU，所以在电池菜单里看到它是正常的。BetterNCM 的框架本身花费很小；最耗电的是歌词页。现在默认的[歌词窗口](#歌词窗口)就是为此做的。除此之外，BetterNCM 还做了几件事：

- 网易云自己的播放进度回调从每秒约 50 次降到每秒 4 次（歌词页盖住主界面或窗口不在画时每秒 1 次）；拖动进度条、切歌会立刻送达。
- 歌词页打开时，被它盖住的主界面不再绘制；歌词页关上时，它自己也不再绘制。
- 窗口不在画的时候，给插件的播放进度从每秒 10 次降到 1 次，窗口一出现就恢复。

不看歌词时关掉歌词页，或者让网易云窗口被挡住、最小化，就能省下大部分。下面是作者在 3.1.14、M5 内建屏上测的数（所有网易云进程合计，单核百分比，播放中），仅供参考：

| 状态 | 网易云进程 CPU |
|---|---|
| 关着歌词页 | 约 40% |
| 开着 RefinedNowPlayingNext 歌词页 | 约 40–50%（这一版之前约 80%） |
| 窗口被挡住、在其他桌面或最小化 | 约 6–8% |

## 出问题时

- 运行 [`doctor` 命令](#命令)，最后几行会用 OK / WARN / FAIL 列出 Node、网易云、BetterNCM.app 的状态。
- 日志在 `~/Library/Application Support/BetterNCM-mac/log/injector.log`。
- 从 BetterNCM.app 启动失败时会弹窗说明原因。
- 一直提示“没有控制网易云音乐的权限”：到“系统设置 → 隐私与安全性 → 自动化”，在“node”（或“BetterNCM”）下面打开“网易云音乐”。
- 网易云自动更新到没测过的版本时，会提示一次，然后照常加载。哪个插件不正常，就先在插件管理里关掉它。

## 安全提示

用 BetterNCM 打开网易云时，它会在 `127.0.0.1` 上开一个调试端口。**这台 Mac 上的任何程序都能通过这个端口控制网易云**，包括已登录的账号和 cookie。别的设备连不上。退出网易云，端口就关了。如果你会运行不信任的程序，请注意这一点。

## 卸载

最简单的：点网易云右上角的[插件](#插件)按钮，选“卸载 BetterNCM”，确认。

也可以用一行命令装的，在终端里运行（装在 `~/Applications` 的话，前面换成 `~/Applications`）：

```bash
/Applications/BetterNCM.app/Contents/MacOS/BetterNCM uninstall
```

两种方式都会移除后台小助手，停止 BetterNCM，把开着的网易云关掉再以原版重新打开，删掉 BetterNCM.app，Dock 里换回原来的网易云图标，保留插件和设置（在 `~/Library/Application Support/BetterNCM-mac`，不要了可以直接删掉这个文件夹）。从源码装的，在项目文件夹里运行 `node bin/bncm-mac.mjs uninstall`（加 `--purge` 会同时删掉插件、设置和日志），之后项目文件夹也可以删掉。

卸载后网易云就是原版，以后从它自己的图标打开也不会再带插件。

不卸载、只是想暂时用原版：运行 `BetterNCM uninstall-agent` 移除后台小助手，再退出网易云、重新打开；想恢复时运行 `BetterNCM install-agent`。

## 命令

用一行命令装的，命令这样运行（BetterNCM.app 在“应用程序”里时；装在 `~/Applications` 的话前面换成 `~/Applications`）：

```bash
/Applications/BetterNCM.app/Contents/MacOS/BetterNCM doctor
```

从源码装的，在项目文件夹里用 `node bin/bncm-mac.mjs doctor`。

```
launch [--daemon] [--port N]   启动（或找到）网易云并注入，BetterNCM.app 用的就是它
launch --agent                 后台小助手用的：网易云刚打开、没带调试端口时，悄悄换成带插件的
install-agent                  安装（或修复）后台小助手
uninstall-agent                移除后台小助手（之后从网易云自己的图标打开就是原版）
attach [--port N]              只连接已经带调试端口的网易云，不会启动或退出它
doctor                         检查环境
reload                         重新解压插件并刷新页面
stop                           停止注入程序（网易云继续开着；下次打开网易云时恢复）
uninstall [--purge]            卸载，并把网易云换回原版（--purge 同时删掉插件、设置和日志）
install-app [--dock]           （源码）生成 BetterNCM.app 并安装后台小助手，--dock 同时固定到 Dock
uninstall-app                  （源码）删除 BetterNCM.app 和它的 Dock 图标
```

## 开发

```bash
npm test             # 不需要 npm install
npm run build:fw     # 重新构建 dist/framework.js（需要 framework/ 的依赖）
BNCM_SRC="$PWD" BNCM_DEST=/tmp/bncm-test BETTERNCM_PROFILE=/tmp/bncm-test/profile \
  BNCM_NO_AGENT=1 BNCM_NO_DOCK=1 BNCM_NO_OPEN=1 bash install.sh   # 用这个文件夹试装，不影响已装的那份
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
