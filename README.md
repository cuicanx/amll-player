<div align=center>

# AMLL Player

English / [简体中文](./README-CN.md)

An independent lyrics page player that obtains audio playback information through local music files/WebSocket Server.

</div>

## Maintainer & Contributors

This edition is **maintained by [cuicanx](https://github.com/cuicanx)**, who also contributes code, bug fixes, performance work and release builds. The maintained repository is [cuicanx/amll-player](https://github.com/cuicanx/amll-player).

The project originated from the [amll-dev](https://github.com/amll-dev) AMLL ecosystem (Apple Music-like Lyrics); that upstream work remains the technical background and is gratefully acknowledged. Development and releases of this edition are handled independently by the current maintainer.

| Role | |
| --- | --- |
| Main maintainer | [cuicanx](https://github.com/cuicanx) |
| Contributor | [cuicanx](https://github.com/cuicanx) |
| Upstream project | [amll-dev/amll-player](https://github.com/amll-dev/amll-player) |

## List of functions/features：

- Communicate with any client that implements the AMLL WS Protocol, synchronize the progress of the playback information, and get the corresponding lyrics for playback display
- Support reading local audio files for playback, or loading local lyrics files
- Support loading various lyric formats
- High performance – no software issues that affect the display of lyrics
- Expected support for playback state transfer protocols：[SMTC (Windows)](https://learn.microsoft.com/en-us/uwp/api/windows.media.systemmediatransportcontrols?view=winrt-26100) / [MPRIS (Linux/XDG)](https://www.freedesktop.org/wiki/Specifications/mpris-spec/) / [MPNowPlayingInfoCenter (macOS)](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter)

## Install and use

Since the player is still compatible, development builds are published on the [maintained repository's Releases page](https://github.com/cuicanx/amll-player/releases/tag/main-player-dev), produced by its [GitHub Action](https://github.com/cuicanx/amll-player/actions/workflows/build-player.yaml).

## Why is there this？

The lyrics player is equivalent to software like external subtitles, and the lyrics are played in an environment independent of the plug-in environment.

The original design separated the lyrics page from the plug-in environment: benchmarks showed that embedding it as a plug-in caused frame drops and intermittent stuttering in the host browser framework, so the playback page became an independent desktop program while the plug-in only transmits playback information.

So if you also have a little stuttering, you can try using this lyric player, and the performance should be improved.


### Building the AMLL Player desktop application

```bash
cd packages/player
pnpm tauri build          # Production build
pnpm tauri dev            # Development mode
```

### Acknowledgements

-   [cuicanx](https://github.com/cuicanx) — current maintainer and contributor
-   [woshizja/sound-processor](https://github.com/woshizja/sound-processor)
-   [FFmpeg](http://ffmpeg.org/)
-   And many other frameworks and libraries used by AMLL, thank you very much!

### Special Thanks

<div align="center">
<image src="https://resources.jetbrains.com/storage/products/company/brand/logos/jb_beam.svg"></image>
<div>
Thanks to <a href=https://jb.gg/OpenSourceSupport>JetBrains</a> for their development tools that provide great support to the AMLL project
</div>
</div>
