import {
	isLyricPageOpenedAtom,
	musicPlayingAtom,
	onLyricLineContextMenuAtom,
	onPlayOrResumeAtom,
	PrebuiltLyricPlayer,
} from "@applemusic-like-lyrics/react-full";
import classnames from "classnames";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { type FC, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	borderlessFullscreenAtom,
	lyricPageSuspendedAtom,
} from "../../states/appAtoms.ts";
import { syncBorderlessFullscreenState } from "../../utils/borderless-fullscreen.ts";
import {
	captureLyricPlayer,
	resetLyricScroll,
} from "../../utils/lyric-player-instance.ts";
import { useCursorAutoHide } from "../../utils/useCursorAutoHide.ts";
import { useTitlebarAutoHide } from "../../utils/useTitlebarAutoHide.ts";
import {
	AMLLContextMenu,
	type ContextMenuPoint,
} from "../AMLLContextMenu/index.tsx";
import { AudioQualityDialog } from "../AudioQualityDialog/index.tsx";
import { BottomLyricInfo } from "../BottomLyricInfo";
import { RecordPanel } from "../RecordPanel/index.tsx";
import styles from "./index.module.css";
import "@applemusic-like-lyrics/core/style.css";
import "@applemusic-like-lyrics/react-full/style.css";

export const AMLLWrapper: FC = () => {
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const suspended = useAtomValue(lyricPageSuspendedAtom);
	const setBorderlessFullscreen = useSetAtom(borderlessFullscreenAtom);
	const setSuspended = useSetAtom(lyricPageSuspendedAtom);
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);

	useTitlebarAutoHide(isLyricPageOpened);
	const cursorHidden = useCursorAutoHide(isLyricPageOpened);
	const isPlaying = useAtomValue(musicPlayingAtom);
	const pageRef = useRef<HTMLDivElement>(null);
	// Menu anchor comes from the real contextmenu event, so a second right-click
	// elsewhere always lands at the new point.
	const [menuPoint, setMenuPoint] = useState<ContextMenuPoint | null>(null);

	// Memory pressure valve. The lyric page is normally kept mounted so opening
	// it is instant; only when the JS heap crosses a high-water mark do we let
	// it be unmounted (and only while it is closed, so it never disappears
	// under the user's eyes).
	useEffect(() => {
		const mem = (
			performance as Performance & {
				memory?: { usedJSHeapSize: number };
			}
		).memory;
		if (!mem) return;
		const HIGH_WATER_MARK = 400 * 1024 * 1024;
		const timer = window.setInterval(() => {
			if (mem.usedJSHeapSize > HIGH_WATER_MARK) setSuspended(true);
		}, 30_000);
		return () => window.clearInterval(timer);
	}, [setSuspended]);

	// Capture the real player handle the library hands out on lyric-line events.
	// This is more reliable than walking React fibers: when the user right-clicks
	// a lyric line we get the exact instance that owns the scroll state, and the
	// 10s auto-return can then use the library's own rebuild API.
	useEffect(() => {
		const store = getDefaultStore();
		const previous = store.get(onLyricLineContextMenuAtom);
		store.set(onLyricLineContextMenuAtom, (_event, playerRef) => {
			const candidate = playerRef as unknown as {
				lyricPlayer?: unknown;
			};
			captureLyricPlayer(candidate?.lyricPlayer ?? playerRef);
			previous?.(_event, playerRef);
		});
		return () => {
			store.set(onLyricLineContextMenuAtom, previous);
		};
	}, []);

	// Manual scrolling hands control to the user; after they stop and move the
	// pointer away we give it back. The player's own auto-align only re-centres
	// when the current line changes while still inside its render range, so a
	// long manual scroll can otherwise stay stranded forever. `resetScroll()` is
	// the public "put the view back on the playing line" operation and produces
	// the same result as seeking back to the current second.
	//
	// The timer is deliberately 10s: a shorter delay yanked the lyrics away
	// while the user was still reading the line they had scrolled to.
	useEffect(() => {
		if (!isLyricPageOpened) return;
		const page = pageRef.current;
		if (!page) return;

		const AUTO_RETURN_DELAY = 10_000;
		let hovering = false;
		let timer = 0;

		const cancel = () => {
			window.clearTimeout(timer);
			timer = 0;
		};
		const schedule = () => {
			cancel();
			// Only while playing and only after the pointer has left: with the
			// pointer still inside, the user is assumed to be reading.
			if (!isPlaying || hovering) return;
			timer = window.setTimeout(() => {
				resetLyricScroll(
					document.getElementById("amll-lyric-player") ?? pageRef.current,
				);
			}, AUTO_RETURN_DELAY);
		};

		const onPointerEnter = () => {
			hovering = true;
			cancel();
		};
		const onPointerLeave = () => {
			hovering = false;
			schedule();
		};
		// A wheel event means the user is still adjusting the view. Postpone the
		// auto-return so the lyric cannot jump while they scroll.
		const onWheel = () => {
			schedule();
		};

		page.addEventListener("pointerenter", onPointerEnter);
		page.addEventListener("pointerleave", onPointerLeave);
		page.addEventListener("wheel", onWheel, { passive: true });
		return () => {
			cancel();
			page.removeEventListener("pointerenter", onPointerEnter);
			page.removeEventListener("pointerleave", onPointerLeave);
			page.removeEventListener("wheel", onWheel);
		};
	}, [isLyricPageOpened, isPlaying]);

	// Publish the native fullscreen state once at startup so the menu label is
	// correct even before the first toggle (the atom defaults to false).
	useEffect(() => {
		void syncBorderlessFullscreenState().then(setBorderlessFullscreen);
	}, [setBorderlessFullscreen]);

	useLayoutEffect(() => {
		if (isLyricPageOpened) {
			document.body.dataset.amllLyricsOpen = "";
		} else {
			delete document.body.dataset.amllLyricsOpen;
		}
	}, [isLyricPageOpened]);

	useEffect(() => {
		if (!isLyricPageOpened) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === " ") {
				e.preventDefault();
				onPlayOrResume?.();
			} else if (e.key === "Escape") {
				setLyricPageOpened(false);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [isLyricPageOpened, onPlayOrResume, setLyricPageOpened]);

	// Free the WebGL context + lyric DOM only under memory pressure, and only
	// while the page is closed so nothing vanishes while it is on screen.
	if (suspended && !isLyricPageOpened) {
		return null;
	}

	return (
		<>
			<div
				ref={pageRef}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenuPoint({ x: event.clientX, y: event.clientY });
				}}
				className={classnames(
					styles.lyricPage,
					isLyricPageOpened && styles.opened,
					// Hiding the cursor is done with a class on the page itself. The
					// previous implementation floated a full-size overlay with
					// `cursor: none` on top of everything; being a real element it
					// swallowed every pointer and wheel event after 1.2 s of mouse
					// idleness - the lyric player stopped getting wheel input
					// (scrolling "suddenly stopped working") and never saw
					// pointerleave, so a manual scroll never handed control back to
					// the auto-align of the playing line.
					cursorHidden && styles.cursorHidden,
				)}
				id="amll-lyric-player-wrapper"
			>
				<PrebuiltLyricPlayer
					id="amll-lyric-player"
					style={{ width: "100%", height: "100%" }}
					bottomLineSlot={<BottomLyricInfo />}
				/>
			</div>
			<AMLLContextMenu
				point={menuPoint}
				onClose={() => setMenuPoint(null)}
			/>
			<AudioQualityDialog />
			<RecordPanel />
		</>
	);
};

export default AMLLWrapper;
