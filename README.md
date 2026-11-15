<div align=center>

# AMLL Player

[English](./README-EN.md) / 简体中文

一个通过 本地音乐文件/WebSocket Server 获取音频播放信息的独立歌词页面播放器。

</div>

## 维护者与贡献者

本版本由 **[cuicanx](https://github.com/cuicanx)** 主要负责维护，代码修复、性能优化与版本构建也由其贡献。当前维护仓库为 [cuicanx/amll-player](https://github.com/cuicanx/amll-player)。

项目最初源自 [amll-dev](https://github.com/amll-dev) 的 AMLL（Apple Music-like Lyrics）生态，上游成果作为技术背景保留并致谢；本版本的后续开发与发布由当前维护者独立推进。

| 角色 | |
| --- | --- |
| 主要维护者 | [cuicanx](https://github.com/cuicanx) |
| 贡献者 | [cuicanx](https://github.com/cuicanx) |
| 上游项目 | [amll-dev/amll-player](https://github.com/amll-dev/amll-player) |


## 功能/特性列表：

- 与任何实现 AMLL WS Protocol 的客户端进行通信，同步播放信息进度，并获取对应的歌词以进行播放展示
- 支持读取本地音频文件播放，或加载本地歌词文件
- 支持加载各种歌词格式
- 高性能 —— 不会因为某些软件自身问题导致歌词展示效果受到影响
- 预计支持播放状态传输协议：[SMTC (Windows)](https://learn.microsoft.com/en-us/uwp/api/windows.media.systemmediatransportcontrols?view=winrt-26100) / [MPRIS (Linux/XDG)](https://www.freedesktop.org/wiki/Specifications/mpris-spec/) / [MPNowPlayingInfoCenter (macOS)](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter)

## 安装使用

由于播放器还在兼容状态，目前可在 [维护仓库的 Releases 页面](https://github.com/cuicanx/amll-player/releases/tag/main-player-dev) 下载开发构建，产物由该仓库的 [GitHub Action](https://github.com/cuicanx/amll-player/actions/workflows/build-player.yaml) 生成。

## 为什么会有这个？

歌词播放器相当于外挂字幕一样的软件，在独立于插件环境以外的环境播放歌词。

最初的设计把歌词页面从插件环境中分离出来：当时测试发现以插件形式嵌入播放页面，会因宿主浏览器框架问题导致掉帧与不定卡顿，因此改为独立桌面程序，原插件只负责传递播放信息。

因此如果你也有少许卡顿现象，可以尝试使用这个歌词播放器，性能应该可以有所改善。

### 构建 AMLL Player 桌面端应用

```bash
cd packages/player
pnpm tauri build   # 发行构建
pnpm tauri dev     # 开发模式
```

### 鸣谢

-   [cuicanx](https://github.com/cuicanx) — 当前维护者与贡献者
-   [woshizja/sound-processor](https://github.com/woshizja/sound-processor)
-   [FFmpeg](http://ffmpeg.org/)
-   还有很多被 AMLL 使用的框架和库，非常感谢！

### 特别鸣谢

<div align="center">
<image src="https://resources.jetbrains.com/storage/products/company/brand/logos/jb_beam.svg"></image>
<div>
感谢 <a href=https://jb.gg/OpenSourceSupport>JetBrains</a> 系列开发工具为 AMLL 项目提供的大力支持
</div>
</div>
