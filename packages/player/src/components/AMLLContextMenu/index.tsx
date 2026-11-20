import {
	hideLyricViewAtom,
	isLyricPageOpenedAtom,
	musicIdAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
} from "@applemusic-like-lyrics/react-full";
import { CheckIcon } from "@radix-ui/react-icons";
import { DropdownMenu } from "@radix-ui/themes";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { type FC, useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { router } from "../../router.tsx";
import {
	borderlessFullscreenAtom,
	contextMenuVisibilityAtom,
	enableAlwaysOnTopAtom,
	enableF11FullscreenAtom,
	recordPanelOpenedAtom,
} from "../../states/appAtoms.ts";
import {
	syncBorderlessFullscreenState,
	toggleBorderlessFullscreen,
} from "../../utils/borderless-fullscreen.ts";
import styles from "./index.module.css";

export interface ContextMenuPoint {
	x: number;
	y: number;
}

/**
 * Song context menu, positioned at an explicit point.
 *
 * Why this is a DropdownMenu anchored to a zero-size element instead of
 * Radix's ContextMenu: with `ContextMenu`, a second right-click while the menu
 * is already open leaves the root's `open` state unchanged, so the content is
 * not re-rendered and keeps the *first* anchor - the menu visibly stayed at
 * the old spot. (Three earlier "fixes" that only touched CSS never helped for
 * exactly that reason: the position never came from CSS.)
 *
 * Here the caller hands us the pointer coordinates from a real `contextmenu`
 * event. The root is keyed by that point, so every right-click builds a fresh
 * anchored popup at the new coordinates - the position cannot go stale because
 * nothing is reused.
 */
export const AMLLContextMenu: FC<{
	point: ContextMenuPoint | null;
	onClose: () => void;
}> = ({ point, onClose }) => {
	const { t } = useTranslation();
	const [hideLyricView, setHideLyricView] = useAtom(hideLyricViewAtom);
	const [alwaysOnTop, setAlwaysOnTop] = useAtom(enableAlwaysOnTopAtom);
	const enableF11Fullscreen = useAtomValue(enableF11FullscreenAtom);
	const isFullscreen = useAtomValue(borderlessFullscreenAtom);
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const setRecordPanelOpened = useSetAtom(recordPanelOpenedAtom);
	const onRequestPrevSong = useAtomValue(onRequestPrevSongAtom).onEmit;
	const onRequestNextSong = useAtomValue(onRequestNextSongAtom).onEmit;
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const musicId = useAtomValue(musicIdAtom);
	const menuVisibility = useAtomValue(contextMenuVisibilityAtom);

	// Only mounted while open, so this runs once per opening: make sure the
	// fullscreen entry reflects the real window state.
	useEffect(() => {
		if (point) void syncBorderlessFullscreenState();
	}, [point]);

	if (!point) return null;

	return (
		<DropdownMenu.Root
			key={`${Math.round(point.x)}:${Math.round(point.y)}`}
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DropdownMenu.Trigger asChild>
				<span
					aria-hidden="true"
					style={{
						position: "fixed",
						left: point.x,
						top: point.y,
						width: 0,
						height: 0,
						pointerEvents: "none",
					}}
				/>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content side="right" align="start" sideOffset={2}>
				{menuVisibility.prevSong && (
					<DropdownMenu.Item onClick={onRequestPrevSong} shortcut="Ctrl Alt ←">
						<Trans i18nKey="amll.contextMenu.rewindSong">上一首</Trans>
					</DropdownMenu.Item>
				)}
				{menuVisibility.playPause && (
					<DropdownMenu.Item onClick={onPlayOrResume} shortcut="Ctrl Alt P">
						<Trans i18nKey="amll.contextMenu.pauseOrResume">暂停 / 继续</Trans>
					</DropdownMenu.Item>
				)}
				{menuVisibility.nextSong && (
					<DropdownMenu.Item onClick={onRequestNextSong} shortcut="Ctrl Alt →">
						<Trans i18nKey="amll.contextMenu.forwardSong">下一首</Trans>
					</DropdownMenu.Item>
				)}
				<DropdownMenu.Separator />
				{/* Only offered when the user opted into F11 borderless fullscreen. */}
				{enableF11Fullscreen && menuVisibility.fullscreen && (
					<DropdownMenu.Item onClick={() => void toggleBorderlessFullscreen()}>
						{isFullscreen
							? t("amll.contextMenu.exitFullscreen", "退出全屏")
							: t("amll.contextMenu.enterFullscreen", "进入全屏")}
					</DropdownMenu.Item>
				)}
				{/* Check mark on the right: an unchecked row then has no empty left
				   gutter, so every row starts on the same vertical line. */}
				{menuVisibility.alwaysOnTop && (
				<DropdownMenu.CheckboxItem
					className={styles.item}
					checked={alwaysOnTop}
					onCheckedChange={(e) => setAlwaysOnTop(!!e)}
				>
					<span className={styles.label}>
						<Trans i18nKey="amll.contextMenu.windowAlwaysOnTop">窗口置顶</Trans>
					</span>
					{alwaysOnTop && <CheckIcon className={styles.mark} />}
				</DropdownMenu.CheckboxItem>
				)}
				<DropdownMenu.Separator />
				{menuVisibility.showLyrics && (
				<DropdownMenu.CheckboxItem
					className={styles.item}
					checked={!hideLyricView}
					onCheckedChange={(e) => setHideLyricView(!e)}
				>
					<span className={styles.label}>
						<Trans i18nKey="amll.contextMenu.toggleLyrics">显示歌词</Trans>
					</span>
					{!hideLyricView && <CheckIcon className={styles.mark} />}
				</DropdownMenu.CheckboxItem>
				)}
				{menuVisibility.editSongInfo && (
				<DropdownMenu.Item
					onClick={() => {
						setLyricPageOpened(false);
						router.navigate(`/song/${musicId}`);
					}}
				>
					<Trans i18nKey="amll.contextMenu.editMusicOverrideMessage">
						编辑歌曲覆盖信息
					</Trans>
				</DropdownMenu.Item>
				)}
				<DropdownMenu.Separator />
				{menuVisibility.recordPanel && (
					<DropdownMenu.Item
						onClick={() => {
							setRecordPanelOpened(true);
						}}
					>
						<Trans i18nKey="amll.contextMenu.openRecorder">打开捕获面板</Trans>
					</DropdownMenu.Item>
				)}
				{menuVisibility.screenshot && (
					<DropdownMenu.Item
						onClick={() => {
							invoke("open_screenshot_window");
						}}
					>
						<Trans i18nKey="amll.contextMenu.openScreenshotTool">
							打开截图工具
						</Trans>
					</DropdownMenu.Item>
				)}
				<DropdownMenu.Separator />
				{menuVisibility.exitLyricPage && (
					<DropdownMenu.Item
						onClick={() => {
							setLyricPageOpened(false);
						}}
					>
						<Trans i18nKey="amll.contextMenu.exitLyricPage">退出歌词页面</Trans>
					</DropdownMenu.Item>
				)}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	);
};
