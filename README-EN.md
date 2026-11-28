<div align=center>

# AMLL Player

English / [简体中文](./README.md)

A standalone music player. Beautiful UI interface, supports local and online songs, with numerous customization options and enhanced features, striving to be the strongest open-source player!

</div>

## What It Can Do Now

- Play local songs, automatically read embedded lyrics and same-name subtitle files (LRC, QRC, TTML, etc.)
- Search and play online, supports multiple music sources, can favorite playlists and download to local
- Customization features such as main/translation lyrics swapping, line-by-line offset, font and background customization
- Taskbar lyrics: displays cover, song title and current line, supports track switching and pausing

## Download

Information about official releases and update channels is in [Releases](https://github.com/cuicanx/amll-player/releases).

Official releases include Windows installer and Android installer; beta releases also include Linux and macOS builds.

If you cannot get updates, you can download manually, or switch to the beta channel and check again.

## Project Origin

It originally started as a plugin in the AMLL ecosystem, with lyrics embedded in the host browser, causing noticeable frame drops and stuttering. Later it was changed to a standalone desktop program, with the plugin only responsible for transmitting playback information while rendering is handled by itself, reducing the stuttering issue.

The project was forked from [amll-dev/amll-player](https://github.com/amll-dev/amll-player) and is now independently maintained by [cuicanx](https://github.com/cuicanx).

## How to Build

Windows, Linux, macOS desktop:

    cd packages/player
    pnpm install
    pnpm tauri build

Android:

    pnpm tauri android build --apk --split-per-abi

## Acknowledgements

- [amll-dev](https://github.com/amll-dev) — Upstream project
- [woshizja/sound-processor](https://github.com/woshizja/sound-processor)
- [FFmpeg](https://ffmpeg.org/)
- JetBrains for providing development tool licenses
