/**
 * Local / online playback mode.
 *
 * The choice must take effect on the *next* launch, so the effective value is
 * frozen when the module is first imported and the stored value is only what
 * the next boot will read. That keeps a half-switched UI from mixing a local
 * library with an online search in the same session.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export type PlayMode = "local" | "online";

export const PLAY_MODE_STORAGE_KEY = "amll-player.playMode";

function readBootMode(): PlayMode {
	try {
		const raw = localStorage.getItem(PLAY_MODE_STORAGE_KEY);
		// Fresh installs have no stored preference: start in online mode.
		// Existing users keep whatever they chose (the stored value wins).
		if (!raw) return "online";
		// atomWithStorage writes JSON, so the stored text is `"online"` with the
		// quotes. Comparing the raw string against `online` never matched, which
		// is why the switch looked like it never applied after a restart.
		let value: unknown = raw;
		try {
			value = JSON.parse(raw);
		} catch {
			// Older builds stored a bare string - fall through with `raw`.
		}
		return value === "online" ? "online" : "local";
	} catch {
		return "local";
	}
}

/** The mode this session actually runs in. Never changes while running. */
export const BOOT_PLAY_MODE: PlayMode = readBootMode();

export const playModeAtom = atom<PlayMode>(BOOT_PLAY_MODE);

export const isOnlineModeAtom = atom((get) => get(playModeAtom) === "online");

/** The value stored for the next launch. */
export const savedPlayModeAtom = atomWithStorage<PlayMode>(PLAY_MODE_STORAGE_KEY, BOOT_PLAY_MODE);
