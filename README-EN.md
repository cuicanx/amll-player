<div align=center>

# AMLL Player

English / [简体中文](./README.md)

A standalone lyric player. Plays local songs or online search results, shows the lyrics in its own window, and can sit in the Windows taskbar.

</div>

## What it does

- Plays local audio files and picks up embedded or sidecar lyrics (LRC, QRC, TTML, and more)
- Searches and streams from several providers, with playlists and local downloads
- Swaps translation and main lyric lines, per-song offset, custom fonts and backgrounds
- Taskbar mode shows cover, title and the current line, with playback controls
- Stable / dev update channels in Settings, each with its own release notes
- Mainland China networks reach the update source directly, without a dead proxy left behind by a VPN client

## Downloads

See [Releases](https://github.com/cuicanx/amll-player/releases). Stable releases ship a Windows installer and an Android APK; the dev channel also has Linux and macOS builds.

If the updater cannot reach GitHub, download manually or switch to the dev channel and check again.

## Recent changes

### 1.0.4
- Fixed the Android startup crash: the TLS verifier was not initialized; it now uses the system certificate store.
- Fixed symlink-loop scans and database paths containing special characters.
- The lyric index no longer depends on mmap on Android, so FUSE storage works.
- Old release notes moved to `docs/history/` with an index.

### 1.0.3
- Added stable / dev update channel switch in the About page.
- Fixed taskbar lyrics not showing the cover and track info for music already playing at startup.
- Android builds are properly signed; mirror manifests are generated separately per channel.
- Pinned git dependencies to exact commits.

### 1.0.2
- Lyric translation swap can be set per song.
- Release notes are reformatted and collapsible.
- Fixed contributor avatars failing to load on mainland networks.

Full history: [CHANGELOG.md](./CHANGELOG.md).

## Background

This started as a plugin in the AMLL ecosystem, where lyrics were rendered inside the host browser and dropped frames often. It became a standalone app: the plugin only passes playback info, and rendering runs on its own.

Forked from [amll-dev/amll-player](https://github.com/amll-dev/amll-player), now maintained by [cuicanx](https://github.com/cuicanx).

## Build

Desktop (Windows / Linux / macOS):

```bash
cd packages/player
pnpm install
pnpm tauri build
```

Android:

```bash
pnpm tauri android build --apk --split-per-abi
```

Stable releases are built by [build-player.yaml](./.github/workflows/build-player.yaml) on a `v*` tag. The version lives in `version.json` at the repo root; a script syncs it everywhere else.

## Credits

- [amll-dev](https://github.com/amll-dev) — upstream project
- [woshizja/sound-processor](https://github.com/woshizja/sound-processor)
- [FFmpeg](https://ffmpeg.org/)
- JetBrains for the development tools license
