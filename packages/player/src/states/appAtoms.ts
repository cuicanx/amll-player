import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
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

export const updateInfoAtom = atom<Update | false>(false);

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

export const enableTaskbarLyricAtom = atomWithStorage(
	"amll-player.enableTaskbarLyric",
	false,
);

export const audioQualityDialogOpenedAtom = atom(false);

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
	const currentLang = get(languageAtom);
	const resources = i18n.options.resources ?? {};

	const languages = Object.keys(resources)
		.map((langId) => {
			try {
				const name =
					new Intl.DisplayNames(currentLang, { type: "language" }).of(langId) ||
					langId;
				const origName =
					new Intl.DisplayNames(langId, { type: "language" }).of(langId) ||
					langId;
				return {
					label: origName === name ? origName : `${origName} (${name})`,
					value: langId,
				};
			} catch {
				return { label: langId, value: langId };
			}
		})
		.filter((item) => item.label);

	languages.push({
		label: i18n.t("page.settings.general.displayLanguage.cimode", "本地化 ID"),
		value: "cimode",
	});

	return languages;
});
