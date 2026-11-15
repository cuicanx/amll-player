import {
	type Callback,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
} from "@applemusic-like-lyrics/react-full";
import {
	type ShortcutEvent,
	register,
	unregister,
} from "@tauri-apps/plugin-global-shortcut";
import type { Atom } from "jotai";
import { useAtomValue } from "jotai";
import { type FC, useEffect } from "react";
import { enableF11FullscreenAtom } from "../../states/appAtoms.ts";
import {
	exitBorderlessFullscreenIfActive,
	toggleBorderlessFullscreen,
} from "../../utils/borderless-fullscreen.ts";

const useShotcut = (shotcut: string, callback?: () => void) => {
	useEffect(() => {
		if (!callback) return;
		register(shotcut, (evt: ShortcutEvent) => {
			if (evt.state === "Pressed") {
				callback();
			}
		});
		return () => {
			unregister(shotcut);
		};
	}, [shotcut, callback]);
};

const useShotcutAtom = (
	shotcut: string,
	callbackAtom: Atom<Callback<[], void>>,
) => {
	const callback = useAtomValue(callbackAtom).onEmit;

	useShotcut(shotcut, callback);
};

/**
 * F11 is intentionally a window-local DOM listener rather than a Tauri global
 * shortcut: a global F11 would also fire while another app has focus, and the
 * feature is opt-in anyway. Only when the setting is enabled do we attach the
 * listener; turning it off also leaves fullscreen so the toggle has an
 * unambiguous state.
 */
const useF11FullscreenShotcut = () => {
	const enabled = useAtomValue(enableF11FullscreenAtom);

	useEffect(() => {
		if (!enabled) {
			void exitBorderlessFullscreenIfActive();
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "F11") return;
			event.preventDefault();
			void toggleBorderlessFullscreen();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [enabled]);
};

export const ShotcutContext: FC = () => {
	useShotcutAtom("CmdOrCtrl+Alt+P", onPlayOrResumeAtom);
	useShotcutAtom("CmdOrCtrl+Alt+ArrowRight", onRequestNextSongAtom);
	useShotcutAtom("CmdOrCtrl+Alt+ArrowLeft", onRequestPrevSongAtom);
	useF11FullscreenShotcut();

	return null;
};
