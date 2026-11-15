import {
	isLyricPageOpenedAtom,
	musicPlayingAtom,
	onPlayOrResumeAtom,
	PrebuiltLyricPlayer,
} from "@applemusic-like-lyrics/react-full";
import classnames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	borderlessFullscreenAtom,
	lyricPageSuspendedAtom,
} from "../../states/appAtoms.ts";
import { syncBorderlessFullscreenState } from "../../utils/borderless-fullscreen.ts";
import { resetLyricScroll } from "../../utils/lyric-player-instance.ts";
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

	// Return to the playing line once the pointer has left the lyric area.
	//
	// The player only re-aligns by itself when the current line *changes* and is
	// still inside its render range, so scrolling far away left the view
	// stranded. Its public `resetScroll()` is exactly the "put it back" call;
	// we wait a moment first so a pointer that merely grazes the edge does not
	// yank the lyrics, and we only do it while playing (with playback paused the
	// user is usually reading a specific spot on purpose).
	useEffect(() => {
		if (!isLyricPageOpened) return;
		const page = pageRef.current;
		if (!page) return;

		let timer = 0;
		const onPointerLeave = () => {
			if (!isPlaying) return;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				resetLyricScroll(document.getElementById("amll-lyric-player"));
			}, 700);
		};
		const cancel = () => window.clearTimeout(timer);

		page.addEventListener("pointerleave", onPointerLeave);
		page.addEventListener("pointerenter", cancel);
		return () => {
			window.clearTimeout(timer);
			page.removeEventListener("pointerleave", onPointerLeave);
			page.removeEventListener("pointerenter", cancel);
		};
	}, [isLyricPageOpened, isPlaying]);

	// Same "go back to the playing line" guarantee for the case where the
	// pointer never leaves the window: after the wheel has been idle for a
	// moment we hand control back to the auto-align. The player itself only
	// re-aligns when the current line changes *and* is still inside its render
	// range, so a long manual scroll could otherwise stay stranded.
	useEffect(() => {
		if (!isLyricPageOpened) return;
		const page = pageRef.current;
		if (!page) return;

		let idle = 0;
		const onWheel = () => {
			window.clearTimeout(idle);
			idle = window.setTimeout(() => {
				if (isPlaying) {
					resetLyricScroll(document.getElementById("amll-lyric-player"));
				}
			}, 1500);
		};

		page.addEventListener("wheel", onWheel, { passive: true });
		return () => {
			window.clearTimeout(idle);
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
