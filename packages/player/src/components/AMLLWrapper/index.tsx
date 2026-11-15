import {
	isLyricPageOpenedAtom,
	onPlayOrResumeAtom,
	PrebuiltLyricPlayer,
} from "@applemusic-like-lyrics/react-full";
import { ContextMenu } from "@radix-ui/themes";
import classnames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, useEffect, useLayoutEffect } from "react";
import { lyricPageSuspendedAtom } from "../../states/appAtoms.ts";
import { useCursorAutoHide } from "../../utils/useCursorAutoHide.ts";
import { useTitlebarAutoHide } from "../../utils/useTitlebarAutoHide.ts";
import { AMLLContextMenuContent } from "../AMLLContextMenu/index.tsx";
import { AudioQualityDialog } from "../AudioQualityDialog/index.tsx";
import { BottomLyricInfo } from "../BottomLyricInfo";
import { RecordPanel } from "../RecordPanel/index.tsx";
import styles from "./index.module.css";
import "@applemusic-like-lyrics/core/style.css";
import "@applemusic-like-lyrics/react-full/style.css";

export const AMLLWrapper: FC = () => {
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const suspended = useAtomValue(lyricPageSuspendedAtom);
	const setSuspended = useSetAtom(lyricPageSuspendedAtom);
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);

	useTitlebarAutoHide(isLyricPageOpened);
	const cursorHidden = useCursorAutoHide(isLyricPageOpened);

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
			<ContextMenu.Root>
				<ContextMenu.Trigger>
					<div
						className={classnames(
							styles.lyricPage,
							isLyricPageOpened && styles.opened,
						)}
						id="amll-lyric-player-wrapper"
					>
						<PrebuiltLyricPlayer
							id="amll-lyric-player"
							style={{ width: "100%", height: "100%" }}
							bottomLineSlot={<BottomLyricInfo />}
						/>
						{cursorHidden && (
							<div className={styles.cursorHiddenOverlay} />
						)}
					</div>
				</ContextMenu.Trigger>
				<AMLLContextMenuContent />
			</ContextMenu.Root>
			<AudioQualityDialog />
			<RecordPanel />
		</>
	);
};

export default AMLLWrapper;
