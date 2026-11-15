import {
	hideLyricViewAtom,
	isLyricPageOpenedAtom,
	musicIdAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
} from "@applemusic-like-lyrics/react-full";
import { ContextMenu } from "@radix-ui/themes";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { FC } from "react";
import { Trans, useTranslation } from "react-i18next";
import { router } from "../../router.tsx";
import {
	borderlessFullscreenAtom,
	enableAlwaysOnTopAtom,
	enableF11FullscreenAtom,
	recordPanelOpenedAtom,
} from "../../states/appAtoms.ts";
import { toggleBorderlessFullscreen } from "../../utils/borderless-fullscreen.ts";

export const AMLLContextMenuContent: FC = () => {
	const { t } = useTranslation();
	const [hideLyricView, setHideLyricView] = useAtom(hideLyricViewAtom);
	const [alwaysOnTop, setAlwaysOnTop] = useAtom(enableAlwaysOnTopAtom);
	const enableF11Fullscreen = useAtomValue(enableF11FullscreenAtom);
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const setRecordPanelOpened = useSetAtom(recordPanelOpenedAtom);
	const onRequestPrevSong = useAtomValue(onRequestPrevSongAtom).onEmit;
	const onRequestNextSong = useAtomValue(onRequestNextSongAtom).onEmit;
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const musicId = useAtomValue(musicIdAtom);

	// Live state, not a snapshot. This component is mounted once with the app
	// (only the Radix portal is created per open), so an effect that queried
	// `isFullscreen()` on mount kept the startup value forever and the entry
	// still said "进入全屏" while the window already was fullscreen.
	const isFullscreen = useAtomValue(borderlessFullscreenAtom);

	return (
		<ContextMenu.Content>
			<ContextMenu.Item onClick={onRequestPrevSong} shortcut="Ctrl Alt ←">
				<Trans i18nKey="amll.contextMenu.rewindSong">上一首</Trans>
			</ContextMenu.Item>
			<ContextMenu.Item onClick={onPlayOrResume} shortcut="Ctrl Alt P">
				<Trans i18nKey="amll.contextMenu.pauseOrResume">暂停 / 继续</Trans>
			</ContextMenu.Item>
			<ContextMenu.Item onClick={onRequestNextSong} shortcut="Ctrl Alt →">
				<Trans i18nKey="amll.contextMenu.forwardSong">下一首</Trans>
			</ContextMenu.Item>
			<ContextMenu.Separator />
			{/* Only offered when the user opted into F11 borderless fullscreen in
			   Settings → General. With the feature disabled the entry did
			   nothing useful for them and only added noise. */}
			{enableF11Fullscreen && (
				<ContextMenu.Item
					onClick={() => void toggleBorderlessFullscreen()}
				>
					{isFullscreen
						? t("amll.contextMenu.exitFullscreen", "退出全屏")
						: t("amll.contextMenu.enterFullscreen", "进入全屏")}
				</ContextMenu.Item>
			)}
			<ContextMenu.CheckboxItem
				checked={alwaysOnTop}
				onCheckedChange={(e) => setAlwaysOnTop(!!e)}
			>
				<Trans i18nKey="amll.contextMenu.windowAlwaysOnTop">窗口置顶</Trans>
			</ContextMenu.CheckboxItem>
			<ContextMenu.Separator />
			<ContextMenu.CheckboxItem
				checked={!hideLyricView}
				onCheckedChange={(e) => setHideLyricView(!e)}
			>
				<Trans i18nKey="amll.contextMenu.toggleLyrics">显示歌词</Trans>
			</ContextMenu.CheckboxItem>
			<ContextMenu.Item
				onClick={() => {
					setLyricPageOpened(false);
					router.navigate(`/song/${musicId}`);
				}}
			>
				<Trans i18nKey="amll.contextMenu.editMusicOverrideMessage">
					编辑歌曲覆盖信息
				</Trans>
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Item
				onClick={() => {
					setRecordPanelOpened(true);
				}}
			>
				<Trans i18nKey="amll.contextMenu.openRecorder">打开捕获面板</Trans>
			</ContextMenu.Item>
			<ContextMenu.Item
				onClick={() => {
					invoke("open_screenshot_window");
				}}
			>
				<Trans i18nKey="amll.contextMenu.openScreenshotTool">
					打开截图工具
				</Trans>
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Item
				onClick={() => {
					setLyricPageOpened(false);
				}}
			>
				<Trans i18nKey="amll.contextMenu.exitLyricPage">退出歌词页面</Trans>
			</ContextMenu.Item>
		</ContextMenu.Content>
	);
};
