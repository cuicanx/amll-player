<div align=center>

# AMLL Player

[English](./README-EN.md) / 简体中文

一个独立的音乐播放器。精美的UI界面，支持本地歌曲和联网歌曲，超多自定义选项和增强功能，力求做到开源最强播放器！

</div>

## 现在能做什么

- 播放本地歌曲，自动读取内嵌歌词和同名字幕文件（LRC、QRC、TTML 等）
- 在线搜索并播放，支持多家音源，可收藏歌单、下载到本地
- 主译互换、逐句偏移、字体和背景自定义等自定义功能
- 任务栏歌词：显示封面、歌名和当前句，可切歌、暂停

## 下载

正式版和更新通道说明在 [Releases](https://github.com/cuicanx/amll-player/releases)。正式版附带 Windows 安装包和 Android 安装包，测试版还包含 Linux 与 macOS 构建。

拿不到更新时可以手动下载，或切到测试版通道再检查一次。

## 项目溯源

最早是 AMLL 生态里的一个插件，歌词嵌在宿主浏览器里，掉帧和卡顿比较明显。后来改成独立桌面程序，插件只负责传播放信息，渲染自己来，卡顿问题就少了。

项目从 [amll-dev/amll-player](https://github.com/amll-dev/amll-player) 分出，现在由 [cuicanx](https://github.com/cuicanx) 独立维护。

## 如何构建

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

## 致谢

- [amll-dev](https://github.com/amll-dev) — 上游项目
- [woshizja/sound-processor](https://github.com/woshizja/sound-processor)
- [FFmpeg](https://ffmpeg.org/)
- JetBrains 提供的开发工具授权
