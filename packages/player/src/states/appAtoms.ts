import { invoke } from "@tauri-apps/api/core";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import i18n from "../i18n";
import type { PlayQueueManager } from "../utils/play-queue-manager.ts";

export enum DarkMode {
	Auto = "auto",
	Light = "light",
	Dark = "dark",
}

export enum MusicContextMode {
	Local = "local",
	WSProtocol = "ws-protocol",
}

export const darkModeAtom = atomWithStorage(
	"amll-player.darkMode",
	DarkMode.Auto,
);

export const musicContextModeAtom = atomWithStorage(
	"amll-player.musicContextMode",
	MusicContextMode.Local,
);

export const advanceLyricDynamicLyricTimeAtom = atomWithStorage(
	"amll-player.advanceLyricDynamicLyricTimeAtom",
	false,
);

const enableMediaControlsInternalAtom = atomWithStorage(
	"amll-player.enableMediaControls",
	true,
);

export const enableMediaControlsAtom = atom(
	(get) => get(enableMediaControlsInternalAtom),
	(_get, set, enabled: boolean) => {
		set(enableMediaControlsInternalAtom, enabled);
		invoke("set_media_controls_enabled", { enabled }).catch((err) => {
			console.error("设置媒体控件的启用状态失败", err);
		});
	},
);

const enableAlwaysOnTopInternalAtom = atomWithStorage(
	"amll-player.enableAlwaysOnTop",
	false,
);

export const enableAlwaysOnTopAtom = atom(
	(get) => get(enableAlwaysOnTopInternalAtom),
	(_get, set, enabled: boolean) => {
		set(enableAlwaysOnTopInternalAtom, enabled);
		invoke("set_window_always_on_top", { enabled }).catch((err) => {
			console.error("设置窗口置顶状态失败", err);
		});
	},
);

export const wsProtocolListenAddrAtom = atomWithStorage(
	"amll-player.wsProtocolListenAddr",
	"localhost:11444",
);

export const showStatJSFrameAtom = atomWithStorage(
	"amll-player.showStatJSFrame",
	false,
);

/**
 * F11 borderless fullscreen is opt-in: with this off (the default) F11 does
 * nothing at all, so it can never steal the key from another application or
 * change the window unexpectedly.
 */
export const enableF11FullscreenAtom = atomWithStorage(
	"amll-player.enableF11Fullscreen",
	false,
);

/**
 * Visibility of each entry in the playback page's right-click menu.
 *
 * Keys are the stable menu item ids (see `MENU_ITEMS` in AMLLContextMenu).
 * Defaults are all `true` so existing users see exactly the same menu until
 * they change something. Stored as one object so adding an item never leaves
 * an older install with an undefined value.
 */
export interface ContextMenuVisibility {
	prevSong: boolean;
	playPause: boolean;
	nextSong: boolean;
	fullscreen: boolean;
	alwaysOnTop: boolean;
	showLyrics: boolean;
	editSongInfo: boolean;
	recordPanel: boolean;
	screenshot: boolean;
	exitLyricPage: boolean;
}

export const DEFAULT_CONTEXT_MENU_VISIBILITY: ContextMenuVisibility = {
	prevSong: true,
	playPause: true,
	nextSong: true,
	fullscreen: true,
	alwaysOnTop: true,
	showLyrics: true,
	editSongInfo: true,
	recordPanel: true,
	screenshot: true,
	exitLyricPage: true,
};

export const contextMenuVisibilityAtom = atomWithStorage<ContextMenuVisibility>(
	"amll-player.contextMenuVisibility",
	DEFAULT_CONTEXT_MENU_VISIBILITY,
);

/**
 * Live borderless-fullscreen state, mirrored from the native window.
 *
 * This exists because the context menu component is mounted once with the app
 * (only its Radix portal is created per open), so reading `isFullscreen()`
 * inside that component's effect captured the state at startup and never
 * changed - the menu kept offering "进入全屏" while the window was already
 * fullscreen. Every code path that changes the state publishes it here, and
 * the menu also re-syncs when it opens (see AMLLWrapper).
 */
export const borderlessFullscreenAtom = atom(false);

export const autoDarkModeAtom = atom(true);


export const isDarkThemeAtom = atom(
	(get) =>
		get(darkModeAtom) === DarkMode.Auto
			? get(autoDarkModeAtom)
			: get(darkModeAtom) === DarkMode.Dark,
	(_get, set, newIsDark: boolean) =>
		set(darkModeAtom, newIsDark ? DarkMode.Dark : DarkMode.Light),
);

export const hasBackgroundAtom = atom(false);

export const playlistCardOpenedAtom = atom(false);

export const recordPanelOpenedAtom = atom(false);

export const amllMenuOpenedAtom = atom(false);

export const hideNowPlayingBarAtom = atom(false);

export const wsProtocolConnectedAddrsAtom = atom(new Set<string>());

export const isCheckingUpdateAtom = atom(false);

/**
 * Result of the last successful update check. The updater now runs in Rust
 * (see `src-tauri/src/updater.rs`) so the endpoint list can be chosen from the
 * machine's egress region; the shape mirrors the fields the UI actually uses.
 */
export interface UpdateInfo {
	version: string;
	currentVersion: string;
	body?: string | null;
	date?: string | null;
	downloadHost?: string;
	channel?: UpdateChannel;
}

/** Which release channel the updater follows. */
export type UpdateChannel = "dev" | "stable";

export const updateChannelAtom = atomWithStorage<UpdateChannel>(
	"amll-player.updateChannel",
	"stable",
);

export const updateInfoAtom = atom<UpdateInfo | false>(false);

export const autoUpdateAtom = atomWithStorage("amll-player.autoUpdate", true);

/**
 * Update flow state. Previously `updating` was a component-local boolean that
 * was set to true and never reset when `downloadAndInstall` rejected, so the
 * button stayed in a permanent loading state and every retry reused the same
 * broken Update instance. These atoms are the single source of truth so a
 * failure is visible and recoverable from anywhere in the UI.
 */
export const isInstallingUpdateAtom = atom(false);
export const updateErrorAtom = atom<string | null>(null);
export const updateProgressAtom = atom<number | null>(null);
/** Bytes per second, smoothed; null while unknown. */
export const updateSpeedAtom = atom<number | null>(null);
export const installAttemptsAtom = atom(0);

export interface UpstreamRelease {
	version: string;
	url: string;
}

/**
 * Upstream (amll-dev) has a newer development build. This is a hint only: it
 * never changes the default update source and never triggers an install.
 */
export const upstreamUpdateAtom = atom<UpstreamRelease | null>(null);

/**
 * Set when the JS heap crosses a high-water mark. While it is true and the
 * full-screen lyric page is closed, that subtree (WebGL context + the whole
 * lyric DOM) is unmounted so the browser can reclaim it. It is only a pressure
 * valve: at normal heap sizes it stays false and the page stays warm, so
 * opening it never costs an initialisation stall.
 */
export const lyricPageSuspendedAtom = atom(false);

export const enableTaskbarLyricAtom = atomWithStorage(
	"amll-player.enableTaskbarLyric",
	false,
);

export const audioQualityDialogOpenedAtom = atom(false);

/**
 * Global "force swap main lyric / translation" switch (settings page).
 *
 * When ON it overrides every per-song choice. When OFF, each song uses its own
 * `swapTranslation` value from the database (null = no swap). Kept as a
 * separate key so existing users' per-song preferences are never overwritten.
 */
const SWAP_GLOBAL_KEY = "amll-player.swapLyricGlobal";
const SWAP_LEGACY_KEY = "amll-player.swapLyricMainTranslation";

function readInitialGlobalSwap(): boolean {
	try {
		// If the new key already exists, respect it even when false - otherwise
		// an old TRUE in localStorage would keep overriding the user's choice.
		const raw = localStorage.getItem(SWAP_GLOBAL_KEY);
		if (raw !== null) return JSON.parse(raw) === true;
		// First run after upgrade: carry the old GLOBAL preference over to the
		// new GLOBAL switch exactly once. Never writes per-song values.
		const legacy = localStorage.getItem(SWAP_LEGACY_KEY);
		if (legacy === null) return false;
		const value = JSON.parse(legacy) === true;
		localStorage.setItem(SWAP_GLOBAL_KEY, JSON.stringify(value));
		localStorage.removeItem(SWAP_LEGACY_KEY);
		return value;
	} catch {
		return false;
	}
}

export const swapLyricGlobalAtom = atomWithStorage(
	SWAP_GLOBAL_KEY,
	readInitialGlobalSwap(),
);

/**
 * @deprecated Only kept as a storage-key constant for the one-time migration
 * above. Do not read this atom for rendering or per-song decisions.
 */
export const swapLyricLegacyAtom = atomWithStorage(SWAP_LEGACY_KEY, false);

/**
 * Automatic online-song cache cleanup interval, in DAYS.
 * 0 disables automatic cleanup. New installs default to 3 days.
 */
export type AutoClearCacheDays = 0 | 1 | 3 | 7 | 30;
export const AUTO_CLEAR_CACHE_OPTIONS: AutoClearCacheDays[] = [0, 1, 3, 7, 30];
export const autoClearCacheDaysAtom = atomWithStorage<AutoClearCacheDays>(
	"amll-player.autoClearCacheDays",
	3,
);

export const taskbarLyricThemeSettingAtom = atomWithStorage<
	"auto" | "light" | "dark"
>("amll-player.taskbarLyricTheme", "auto");
export const taskbarLyricAlignSettingAtom = atomWithStorage<
	"auto" | "left" | "right"
>("amll-player.taskbarLyricAlign", "auto");

export const taskbarLyricModeSettingAtom = atomWithStorage<
	"auto" | "single" | "double"
>("amll-player.taskbarLyricMode", "auto");

export enum BottomLyricDisplayMode {
	None = "none",
	OnlyLyricAuthors = "only-lyric-authors",
	OnlySongWriters = "only-song-writers",
	PreferLyricAuthors = "prefer-lyric-authors",
	PreferSongWriters = "prefer-song-writers",
}

export const bottomLyricDisplayModeAtom =
	atomWithStorage<BottomLyricDisplayMode>(
		"amll-player.bottomLyricDisplayMode",
		BottomLyricDisplayMode.PreferSongWriters,
	);

export const currentLyricAuthorsAtom = atom<string[]>([]);

export const currentSongWritersAtom = atom<string[]>([]);

/**
 * Incremented on every explicit song selection. Late async work (online
 * resolve/download) and late audio-thread events carry no song identity, so
 * consumers compare against this epoch to ignore results from the previous
 * selection instead of letting them overwrite the new song's state.
 */
export const playbackEpochAtom = atom(0);

/**
 * Preferred quality for online-music downloads. "auto" keeps the historical
 * 320k-first behaviour; a concrete tier is tried first whenever a source
 * declares support for it.
 */
export type PreferredQuality = "auto" | "flac24bit" | "flac" | "320k" | "128k";
export const preferredQualityAtom = atomWithStorage<PreferredQuality>(
	"amll-player.preferredQuality",
	"auto",
);

export const queueManagerAtom = atom<PlayQueueManager | null>(null);

const _languageBaseAtom = atom(i18n.language);
export const languageAtom = atom(
	(get) => get(_languageBaseAtom),
	(_get, set, newLang: string) => {
		i18n.changeLanguage(newLang).then(() => {
			set(_languageBaseAtom, newLang);
		});
	},
);

export const availableLanguagesAtom = atom((get) => {
	// Keep this list explicit. Deriving names from Intl.DisplayNames broke as
	// soon as a custom locale was active: an unknown tag made the whole call
	// fall back to raw ids like "zh-CN-cat", so the picker showed language
	// codes instead of names. These labels stay readable in every locale.
	const languageLabels: Record<string, string> = {
		"en-US": "English",
		"ja-JP": "日本語",
		"zh-CN": "简体中文",
		"zh-TW": "繁體中文",
		"zh-CN-cat": "猫娘语",
		"zh-Hans-LIT": "文言文",
		cimode: "本地化 ID",
	};

	const languages = Object.keys(languageLabels)
		.filter((langId) => langId === "cimode" || langId in (i18n.options.resources ?? {}))
		.map((langId) => ({ label: languageLabels[langId], value: langId }));

	languages.push({
		label: i18n.t("page.settings.general.displayLanguage.cimode", "本地化 ID"),
		value: "cimode",
	});

	return languages;
});
