<div align=center>

# AMLL Player

[English](./README-EN.md) / 简体中文

独立的歌词播放器。读取本地歌曲或联网搜索，把歌词显示在一个单独的窗口里，也支持嵌入任务栏。

</div>

## 现在能做什么

- 播放电脑里的歌曲，自动读取内嵌歌词和同名字幕文件（LRC、QRC、TTML 等）
- 在线搜索并播放，支持多家音源，可收藏歌单、下载到本地
- 主译互换、逐句偏移、字体和背景自定义
- 任务栏歌词：显示封面、歌名和当前句，可切歌、暂停
- 设置页可切换正式版 / 测试版更新通道，两个通道各自的更新说明分开推送
- 国内网络直连更新源，不走被 VPN 客户端留下的坏代理

## 下载

正式版和更新通道说明在 [Releases](https://github.com/cuicanx/amll-player/releases)。正式版附带 Windows 安装包和 Android 安装包，测试版还包含 Linux 与 macOS 构建。

拿不到更新时可以手动下载，或切到测试版通道再检查一次。

## 最近更新

### 1.0.4
- Android 启动即闪退的问题修好了：TLS 验证器未初始化，现已改用系统证书库。
- 修了符号链接环导致的无限扫描、沙盒路径特殊字符导致数据库打不开。
- Android 上歌词索引不再依赖 mmap，FUSE 文件系统也能读。
- 历史说明文档归档到 `docs/history/`，新增索引。

### 1.0.3
- 关于页增加正式版 / 测试版更新通道切换。
- 任务栏歌词启动时已有歌曲不显示封面和信息的问题修好了。
- Android 安装包改用正式签名，更新镜像清单独立生成，不再互相覆盖。
- git 依赖锁到精确 commit，构建可复现。

### 1.0.2
- 主译互换支持按歌曲单独设置。
- 更新说明重新排版，长内容可展开。
- 贡献者头像在国内网络下的加载问题修好了。

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 项目来历

最早是 AMLL 生态里的一个插件，歌词嵌在宿主浏览器里，掉帧和卡顿比较明显。后来改成独立桌面程序，插件只负责传播放信息，渲染自己来，卡顿问题就少了。

项目从 [amll-dev/amll-player](https://github.com/amll-dev/amll-player) 分出，现在由 [cuicanx](https://github.com/cuicanx) 独立维护。

## 自己构建

Windows、Linux、macOS 桌面端：

```bash
cd packages/player
pnpm install
pnpm tauri build
```

安卓端：

```bash
pnpm tauri android build --apk --split-per-abi
```

正式版发布由 [build-player.yaml](./.github/workflows/build-player.yaml) 负责，推 `v*` tag 触发。版本号只改根目录的 `version.json`，脚本会同步到其他文件。

## 致谢

- [amll-dev](https://github.com/amll-dev) — 上游项目
- [woshizja/sound-processor](https://github.com/woshizja/sound-processor)
- [FFmpeg](https://ffmpeg.org/)
- JetBrains 提供的开发工具授权
