import { branch, commit } from "virtual:git-metadata-plugin";
import {
	MeshGradientRenderer,
	PixiRenderer,
} from "@applemusic-like-lyrics/core";
import {
	cssBackgroundPropertyAtom,
	enableLyricLineBlurEffectAtom,
	enableLyricLineScaleEffectAtom,
	enableLyricLineSpringAnimationAtom,
	enableLyricRomanLineAtom,
	enableLyricSwapTransRomanLineAtom,
	enableLyricTranslationLineAtom,
	fftDataRangeAtom,
	type LyricBackgroundRenderer,
	LyricSizePreset,
	lyricBackgroundFPSAtom,
	lyricBackgroundRendererAtom,
	lyricBackgroundRenderScaleAtom,
	lyricBackgroundStaticModeAtom,
	lyricFontFamilyAtom,
	lyricFontWeightAtom,
	lyricLetterSpacingAtom,
	lyricSizePresetAtom,
	lyricWordFadeWidthAtom,
	PlayerControlsType,
	playerControlsTypeAtom,
	showBottomControlAtom,
	showMusicAlbumAtom,
	showMusicArtistsAtom,
	showMusicNameAtom,
	showVolumeControlAtom,
	VerticalCoverLayout,
	verticalCoverLayoutAtom,
} from "@applemusic-like-lyrics/react-full";
import {
	Avatar,
	Badge,
	Box,
	Button,
	Card,
	Flex,
	Grid,
	Select,
	Separator,
	Slider,
	type SliderProps,
	Switch,
	type SwitchProps,
	Text,
	TextField,
	type TextProps,
} from "@radix-ui/themes";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";
import { atom, useAtom, useAtomValue, useSetAtom, type WritableAtom } from "jotai";
import { loadable } from "jotai/utils";
import { ReleaseNotes } from "../../components/ReleaseNotes/index.tsx";
import { formatSpeed } from "../../states/updater.ts";
import {
	detectUpdateRegion,
	mirrorUrl,
	peekUpdateRegion,
} from "../../utils/update-region.ts";
import React, {
	type FC,
	type PropsWithChildren,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { router } from "../../router.tsx";
import {
	advanceLyricDynamicLyricTimeAtom,
	availableLanguagesAtom,
	BottomLyricDisplayMode,
	bottomLyricDisplayModeAtom,
	DarkMode,
	contextMenuVisibilityAtom,
	DEFAULT_CONTEXT_MENU_VISIBILITY,
	type ContextMenuVisibility,
	darkModeAtom,
	enableAlwaysOnTopAtom,
	enableF11FullscreenAtom,
	enableMediaControlsAtom,
	enableTaskbarLyricAtom,
	installAttemptsAtom,
	isInstallingUpdateAtom,
	languageAtom,
	showStatJSFrameAtom,
	taskbarLyricAlignSettingAtom,
	taskbarLyricModeSettingAtom,
	taskbarLyricThemeSettingAtom,
	updateErrorAtom,
	updateInfoAtom,
	updateProgressAtom,
	updateSpeedAtom,
	upstreamUpdateAtom,
} from "../../states/appAtoms.ts";
import {
	checkUpdateAtom,
	checkUpstreamUpdateAtom,
	installUpdateAtom,
	UPDATE_RELEASE_PAGE,
} from "../../states/updater.ts";
import { restartApp } from "../../utils/player.ts";
import {
	cleanStorage,
	formatBytes,
	getStorageUsage,
	type LogLevel,
	setLogLevel,
	type StorageUsage,
} from "../../utils/storage-api.ts";
import {
	clearOnlineCache,
	ensureSourceHealth,
	fetchSourceFromUrl,
	getOnlineCacheUsage,
	type OnlineCacheUsage,
	resetOnlineRuntimeCache,
} from "../../utils/online-api.ts";
import {
	importFromLxMusic,
	importSource,
	loadSources,
	removeSource,
	restoreBuiltinSources,
	type StoredSource,
	updateSource,
} from "../../utils/online-sources.ts";
import { BOOT_PLAY_MODE, type PlayMode, savedPlayModeAtom } from "../../states/play-mode.ts";import about from "./about.module.css";
import styles from "./index.module.css";

const SettingEntry: FC<
	PropsWithChildren<{ label: string; description?: string }>
> = ({ label, description, children }) => {
	return (
		<Card mt="2">
			<Flex direction="row" align="center" gap="4" wrap="wrap">
				<Flex direction="column" flexGrow="1">
					<Text as="div">{label}</Text>
					<Text as="div" color="gray" size="2" className={styles.desc}>
						{description}
					</Text>
				</Flex>
				{children}
			</Flex>
		</Card>
	);
};

const NumberSettings: FC<
	{ configAtom: WritableAtom<number, [number], void> } & React.ComponentProps<
		typeof SettingEntry
	> &
		Omit<React.ComponentProps<typeof TextField.Root>, "value" | "onChange">
> = ({ label, description, configAtom, ...props }) => {
	const [value, setValue] = useAtom(configAtom);
	return (
		<SettingEntry label={label} description={description}>
			<TextField.Root
				{...props}
				style={{ minWidth: "10em" }}
				defaultValue={String(value)}
				onChange={(e) => setValue(e.currentTarget.valueAsNumber || 0)}
			/>
		</SettingEntry>
	);
};

const SwitchSettings: FC<
	{ configAtom: WritableAtom<boolean, [boolean], void> } & React.ComponentProps<
		typeof SettingEntry
	> &
		Omit<SwitchProps, "value" | "onChange">
> = ({ label, description, configAtom }) => {
	const [value, setValue] = useAtom(configAtom);
	return (
		<SettingEntry label={label} description={description}>
			<Switch checked={value} onCheckedChange={setValue} />
		</SettingEntry>
	);
};

const SubTitle: FC<PropsWithChildren<TextProps>> = ({ children, ...props }) => {
	return (
		<Text weight="bold" size="7" my="4" as="div" {...props}>
			{children}
		</Text>
	);
};

const LyricFontSetting: FC = () => {
	const [fontFamily, setFontFamily] = useAtom(lyricFontFamilyAtom);
	const [fontWeight, setFontWeight] = useAtom(lyricFontWeightAtom);
	const [letterSpacing, setLetterSpacing] = useAtom(lyricLetterSpacingAtom);
	const [preview, setPreview] = useState("字体预览 Font Preview");
	const { t } = useTranslation();

	useLayoutEffect(() => {
		setPreview(
			t(
				"page.settings.lyricFont.fontPreview.defaultText",
				"字体预览 Font Preview",
			),
		);
	}, [t]);

	return (
		<Card mt="2">
			<Flex direction="row" align="center" gap="4">
				<Flex direction="column" flexGrow="1">
					<Text as="div">
						<Trans i18nKey="page.settings.lyricFont.subtitle">
							歌词字体设置
						</Trans>
					</Text>
					<Text as="div" color="gray" size="2" className={styles.desc}>
						<Trans i18nKey="page.settings.lyricFont.tip">
							此设置仅设置歌词字体，不包含其他组件的字体
						</Trans>
					</Text>
				</Flex>
			</Flex>
			<Flex direction="row" align="center" gap="4" my="2" wrap="wrap">
				<Flex direction="column" flexGrow="1">
					<Text as="div">
						<Trans i18nKey="page.settings.lyricFont.fontFamily.label">
							字体家族
						</Trans>
					</Text>
					<Text as="div" color="gray" size="2" className={styles.desc}>
						<Trans i18nKey="page.settings.lyricFont.fontFamily.description">
							以逗号分隔的字体名称组合，等同于 CSS 的 font-family
							属性，留空为默认
						</Trans>
					</Text>
				</Flex>
				<TextField.Root
					value={fontFamily}
					onChange={(e) => setFontFamily(e.currentTarget.value)}
				/>
			</Flex>
			<Flex direction="row" align="center" gap="4" my="2" wrap="wrap">
				<Flex direction="column" flexGrow="1">
					<Text as="div">
						<Trans i18nKey="page.settings.lyricFont.fontWeight.label">
							字体字重
						</Trans>
					</Text>
					<Text as="div" color="gray" size="2" className={styles.desc}>
						<Trans i18nKey="page.settings.lyricFont.fontWeight.description">
							等同于 CSS 的 font-weight 属性，设置 0 为系统控制，推荐值 600
						</Trans>
					</Text>
				</Flex>
				<TextField.Root
					value={fontWeight}
					type="number"
					min={0}
					max={1000}
					onChange={(e) => setFontWeight(e.currentTarget.valueAsNumber)}
				/>
				<Slider
					value={[Number(fontWeight)]}
					min={0}
					max={1000}
					style={{ maxWidth: "10em" }}
					onValueChange={([value]) => setFontWeight(value)}
				/>
			</Flex>
			<Flex direction="row" align="center" gap="4" my="2" wrap="wrap">
				<Flex direction="column" flexGrow="1">
					<Text as="div">
						<Trans i18nKey="page.settings.lyricFont.letterSpacing.label">
							字符间距
						</Trans>
					</Text>
					<Text as="div" color="gray" size="2" className={styles.desc}>
						<Trans i18nKey="page.settings.lyricFont.letterSpacing.description">
							等同于 CSS 的 letter-spacing 属性，留空为默认
						</Trans>
					</Text>
				</Flex>
				<TextField.Root
					value={letterSpacing}
					onChange={(e) => setLetterSpacing(e.currentTarget.value)}
				/>
			</Flex>
			<Flex direction="row" align="center" gap="4" my="2" wrap="wrap">
				<Flex direction="column" flexGrow="1">
					<Text as="div">
						<Trans i18nKey="page.settings.lyricFont.fontPreview.label">
							字体预览
						</Trans>
					</Text>
				</Flex>
				<TextField.Root
					value={preview}
					onChange={(e) => setPreview(e.currentTarget.value)}
				/>
			</Flex>
			<Box
				style={{
					fontFamily: fontFamily || undefined,
					fontWeight: fontWeight || undefined,
					letterSpacing: letterSpacing || undefined,
					fontSize: "max(max(4.7vh, 3.2vw), 12px)",
					textAlign: "center",
				}}
			>
				{preview}
				<Box style={{ fontSize: "max(0.5em, 10px)", opacity: "0.3" }}>
					{preview}
				</Box>
			</Box>
		</Card>
	);
};

const appVersionAtom = loadable(atom(() => getVersion()));

function SliderSettings<T extends number | number[]>({
	label,
	description,
	configAtom,
	children,
	...rest
}: PropsWithChildren<{ configAtom: WritableAtom<T, [T], void> }> &
	React.ComponentProps<typeof SettingEntry> &
	Omit<SliderProps, "value" | "onValueChange">): ReactNode {
	const [value, setValue] = useAtom(configAtom);
	return (
		<SettingEntry label={label} description={description}>
			<Slider
				value={typeof value === "number" ? [value] : value}
				onValueChange={(v: number[]) =>
					typeof value === "number" ? setValue(v[0] as T) : setValue(v as T)
				}
				{...rest}
			/>
			{children}
		</SettingEntry>
	);
}

/**
 * Local / online switch.
 *
 * The effective mode is frozen at boot (`BOOT_PLAY_MODE`), so picking a new
 * value only stores it for the next launch - exactly what the label promises -
 * and offers a restart button for convenience.
 */
const PlayModeSetting: FC = () => {
	const { t } = useTranslation();
	const [saved, setSaved] = useAtom(savedPlayModeAtom);
	const pending = saved !== BOOT_PLAY_MODE;
	const options: { value: PlayMode; label: string }[] = [
		{ value: "local", label: t("page.settings.general.playMode.local", "本地模式") },
		{ value: "online", label: t("page.settings.general.playMode.online", "在线模式") },
	];

	return (
		<SettingEntry
			label={t("page.settings.general.playMode.label", "播放模式")}
			description={t(
				"page.settings.general.playMode.description",
				"本地模式只播放电脑里的歌曲；在线模式在搜索页联网搜索并直接播放。切换后于下次启动生效。",
			)}
		>
			<Flex direction="column" align="end" gap="2">
				<Flex gap="1">
					{options.map((option) => (
						<Button
							key={option.value}
							size="2"
							variant={saved === option.value ? "solid" : "soft"}
							onClick={() => setSaved(option.value)}
						>
							{option.label}
						</Button>
					))}
				</Flex>
				{pending ? (
					<Flex gap="2" align="center">
						<Text size="1" color="gray">
							<Trans i18nKey="page.settings.general.playMode.pending">
								已保存，重启后生效
							</Trans>
						</Text>
						<Button size="1" variant="soft" onClick={() => void restartApp()}>
							<Trans i18nKey="page.settings.general.playMode.restart">立即重启</Trans>
						</Button>
					</Flex>
				) : null}
			</Flex>
		</SettingEntry>
	);
};

const GeneralSettings = () => {
	const { t } = useTranslation();
	const [mode, setMode] = useAtom(darkModeAtom);
	const [language, setLanguage] = useAtom(languageAtom);
	const supportedLanguages = useAtomValue(availableLanguagesAtom);
	const [os, setOs] = useState<string | null>(null);

	useEffect(() => {
		setOs(platform());
	}, []);
	const themeMenu = useMemo(
		() => [
			{
				label: t("page.settings.general.theme.auto", "自动"),
				value: DarkMode.Auto,
			},
			{
				label: t("page.settings.general.theme.light", "浅色"),
				value: DarkMode.Light,
			},
			{
				label: t("page.settings.general.theme.dark", "深色"),
				value: DarkMode.Dark,
			},
		],
		[t],
	);

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.general.subtitle">常规</Trans>
			</SubTitle>
			<PlayModeSetting />
			<SettingEntry
				label={t("page.settings.general.displayLanguage.label", "显示语言")}
			>
				<Select.Root value={language} onValueChange={setLanguage}>
					<Select.Trigger />
					<Select.Content>
						{supportedLanguages.map((item) => (
							<Select.Item key={item.value} value={item.value}>
								{item.label}
							</Select.Item>
						))}
					</Select.Content>
				</Select.Root>
			</SettingEntry>
			<SettingEntry
				label={t("page.settings.general.theme.label", "界面主题")}
				description={t(
					"page.settings.general.theme.description",
					"选择应用的外观主题",
				)}
			>
				<Select.Root value={mode} onValueChange={(v) => setMode(v as DarkMode)}>
					<Select.Trigger />
					<Select.Content>
						{themeMenu.map((item) => (
							<Select.Item key={item.value} value={item.value}>
								{item.label}
							</Select.Item>
						))}
					</Select.Content>
				</Select.Root>
			</SettingEntry>
			{os === "windows" && (
				<SwitchSettings
					label={t(
						"page.settings.general.windowAlwaysOnTop.label",
						"启用窗口置顶",
					)}
					description={t(
						"page.settings.general.windowAlwaysOnTop.description",
						"将应用窗口设置为始终置顶",
					)}
					configAtom={enableAlwaysOnTopAtom}
				/>
			)}
			<SwitchSettings
				label={t(
					"page.settings.general.f11Fullscreen.label",
					"启用 F11 无边框全屏",
				)}
				description={t(
					"page.settings.general.f11Fullscreen.description",
					"开启后按 F11 可进入或退出无边框全屏；关闭时 F11 不生效",
				)}
				configAtom={enableF11FullscreenAtom}
			/>
		</>
	);
};

const LyricContentSettings = () => {
	const { t } = useTranslation();

	const [bottomLyricDisplayMode, setBottomLyricDisplayMode] = useAtom(
		bottomLyricDisplayModeAtom,
	);

	const bottomLyricMenu = useMemo(
		() => [
			{
				label: t(
					"page.settings.lyricContent.bottomLyricMode.menu.none",
					"完全不显示",
				),
				value: BottomLyricDisplayMode.None,
			},
			{
				label: t(
					"page.settings.lyricContent.bottomLyricMode.menu.onlyLyricAuthors",
					"只显示歌词作者",
				),
				value: BottomLyricDisplayMode.OnlyLyricAuthors,
			},
			{
				label: t(
					"page.settings.lyricContent.bottomLyricMode.menu.onlySongWriters",
					"只显示创作者",
				),
				value: BottomLyricDisplayMode.OnlySongWriters,
			},
			{
				label: t(
					"page.settings.lyricContent.bottomLyricMode.menu.preferLyricAuthors",
					"优先显示歌词作者",
				),
				value: BottomLyricDisplayMode.PreferLyricAuthors,
			},
			{
				label: t(
					"page.settings.lyricContent.bottomLyricMode.menu.preferSongWriters",
					"优先显示创作者",
				),
				value: BottomLyricDisplayMode.PreferSongWriters,
			},
		],
		[t],
	);

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.lyricContent.subtitle">歌词内容</Trans>
			</SubTitle>
			<SwitchSettings
				label={t(
					"page.settings.lyricContent.enableLyricTranslationLine",
					"显示翻译歌词",
				)}
				configAtom={enableLyricTranslationLineAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.lyricContent.enableLyricRomanLine.label",
					"显示音译歌词",
				)}
				configAtom={enableLyricRomanLineAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.lyricContent.enableLyricSwapTransRomanLine.label",
					"启用音译歌词与翻译歌词互换",
				)}
				description={t(
					"page.settings.lyricContent.enableLyricSwapTransRomanLine.description",
					"仅上面两者启用后有效",
				)}
				configAtom={enableLyricSwapTransRomanLineAtom}
			/>

			<Box height="1em" />
			<SettingEntry
				label={t(
					"page.settings.lyricContent.bottomLyricMode.label",
					"底部信息",
				)}
				description={t(
					"page.settings.lyricContent.bottomLyricMode.description",
					"控制歌词底部显示的歌曲创作者及歌词作者信息",
				)}
			>
				<Select.Root
					value={bottomLyricDisplayMode}
					onValueChange={(v) =>
						setBottomLyricDisplayMode(v as BottomLyricDisplayMode)
					}
				>
					<Select.Trigger />
					<Select.Content>
						{bottomLyricMenu.map((item) => (
							<Select.Item key={item.value} value={item.value}>
								{item.label}
							</Select.Item>
						))}
					</Select.Content>
				</Select.Root>
			</SettingEntry>
		</>
	);
};

const LyricAppearanceSettings = () => {
	const { t } = useTranslation();
	const [lyricSize, setLyricSize] = useAtom(lyricSizePresetAtom);

	const lyricSizeMenu = useMemo(
		() => [
			{
				label: t(
					"page.settings.lyricAppearance.lyricFontSize.menu.tiny",
					"超小",
				),
				value: LyricSizePreset.Tiny,
			},
			{
				label: t(
					"page.settings.lyricAppearance.lyricFontSize.menu.extra_small",
					"极小",
				),
				value: LyricSizePreset.ExtraSmall,
			},
			{
				label: t(
					"page.settings.lyricAppearance.lyricFontSize.menu.small",
					"小",
				),
				value: LyricSizePreset.Small,
			},
			{
				label: t(
					"page.settings.lyricAppearance.lyricFontSize.menu.medium",
					"中",
				),
				value: LyricSizePreset.Medium,
			},
			{
				label: t(
					"page.settings.lyricAppearance.lyricFontSize.menu.large",
					"大",
				),
				value: LyricSizePreset.Large,
			},
			{
				label: t(
					"page.settings.lyricAppearance.lyricFontSize.menu.extra_large",
					"极大",
				),
				value: LyricSizePreset.ExtraLarge,
			},
			{
				label: t(
					"page.settings.lyricAppearance.lyricFontSize.menu.huge",
					"超大",
				),
				value: LyricSizePreset.Huge,
			},
		],
		[t],
	);

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.lyricAppearance.subtitle">歌词样式</Trans>
			</SubTitle>
			<LyricFontSetting />
			<SettingEntry
				label={t(
					"page.settings.lyricAppearance.lyricFontSize.label",
					"歌词字体大小",
				)}
				description={t(
					"page.settings.lyricAppearance.lyricFontSize.descriptionResponsive",
					"设置歌词的字体大小",
				)}
			>
				<Select.Root
					value={lyricSize}
					onValueChange={(value) => setLyricSize(value as LyricSizePreset)}
				>
					<Select.Trigger />
					<Select.Content>
						{lyricSizeMenu.map((item) => (
							<Select.Item key={item.value} value={item.value}>
								{item.label}
							</Select.Item>
						))}
					</Select.Content>
				</Select.Root>
			</SettingEntry>
			<SwitchSettings
				label={t(
					"page.settings.lyricAppearance.enableLyricLineBlurEffect.label",
					"启用歌词模糊效果",
				)}
				description={t(
					"page.settings.lyricAppearance.enableLyricLineBlurEffect.description",
					"对性能影响较高，如果遇到性能问题，可以尝试关闭此项。默认开启。",
				)}
				configAtom={enableLyricLineBlurEffectAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.lyricAppearance.enableLyricLineScaleEffect.label",
					"启用歌词缩放效果",
				)}
				description={t(
					"page.settings.lyricAppearance.enableLyricLineScaleEffect.description",
					"对性能无影响，非当前播放歌词行会略微缩小。默认开启",
				)}
				configAtom={enableLyricLineScaleEffectAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.lyricAppearance.enableLyricLineSpringAnimation.label",
					"启用歌词行弹簧动画效果",
				)}
				description={t(
					"page.settings.lyricAppearance.enableLyricLineSpringAnimation.description",
					"对性能影响较高，如果遇到性能问题，可以尝试关闭此项。默认开启。",
				)}
				configAtom={enableLyricLineSpringAnimationAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.lyricAppearance.advanceLyricDynamicLyricTime.label",
					"提前歌词行时序",
				)}
				description={t(
					"page.settings.lyricAppearance.advanceLyricDynamicLyricTime.description",
					"即将原歌词行的初始时间时序提前，以便在歌词滚动结束后刚好开始播放（逐词）歌词效果。这个行为更加接近 Apple Music 的效果，但是大部分情况下会导致歌词行末尾的歌词尚未播放完成便被切换到下一行。",
				)}
				configAtom={advanceLyricDynamicLyricTimeAtom}
			/>
			<NumberSettings
				placeholder="0.5"
				type="number"
				min="0"
				max="10.0"
				step="0.01"
				label={t(
					"page.settings.lyricAppearance.lyricWordFadeWidth.label",
					"逐词渐变宽度",
				)}
				description={t(
					"page.settings.lyricAppearance.lyricWordFadeWidth.description",
					"调节逐词歌词时单词的渐变过渡宽度，单位为一个全角字的宽度，默认为 0.5。\n如果要模拟 Apple Music for Android 的效果，可以设置为 1。\n如果要模拟 Apple Music for iPad 的效果，可以设置为 0.5。\n如需关闭逐词歌词时单词的渐变过渡效果，可以设置为 0。",
				)}
				configAtom={lyricWordFadeWidthAtom}
			/>
		</>
	);
};

const MusicInfoAppearanceSettings = () => {
	const { t } = useTranslation();
	const fftDataRange = useAtomValue(fftDataRangeAtom);
	const [playerControlsType, setPlayerControlsType] = useAtom(
		playerControlsTypeAtom,
	);
	const [verticalCoverLayout, setVerticalCoverLayout] = useAtom(
		verticalCoverLayoutAtom,
	);

	const playerControlsTypeMenu = useMemo(
		() => [
			{
				label: t(
					"page.settings.musicInfoAppearance.playerControlsType.menu.controls",
					"播放控制组件",
				),
				value: PlayerControlsType.Controls,
			},
			{
				label: t(
					"page.settings.musicInfoAppearance.playerControlsType.menu.fft",
					"线条音频可视化",
				),
				value: PlayerControlsType.FFT,
			},
			{
				label: t(
					"page.settings.musicInfoAppearance.playerControlsType.menu.none",
					"无",
				),
				value: PlayerControlsType.None,
			},
		],
		[t],
	);
	const verticalCoverLayoutMenu = useMemo(
		() => [
			{
				label: t(
					"page.settings.musicInfoAppearance.verticalCoverLayout.menu.auto",
					"自动",
				),
				value: VerticalCoverLayout.Auto,
			},
			{
				label: t(
					"page.settings.musicInfoAppearance.verticalCoverLayout.menu.forceNormal",
					"强制默认布局",
				),
				value: VerticalCoverLayout.ForceNormal,
			},
			{
				label: t(
					"page.settings.musicInfoAppearance.verticalCoverLayout.menu.forceImmersive",
					"强制沉浸布局",
				),
				value: VerticalCoverLayout.ForceImmersive,
			},
		],
		[t],
	);

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.musicInfoAppearance.subtitle">
					歌曲信息样式
				</Trans>
			</SubTitle>
			<SwitchSettings
				label={t(
					"page.settings.musicInfoAppearance.showMusicName.label",
					"显示歌曲名称",
				)}
				configAtom={showMusicNameAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.musicInfoAppearance.showMusicArtists.label",
					"显示歌曲作者",
				)}
				configAtom={showMusicArtistsAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.musicInfoAppearance.showMusicAlbum.label",
					"显示歌曲专辑名称",
				)}
				description={t(
					"page.settings.musicInfoAppearance.showMusicAlbum.description",
					"如果同时启用三个，布局上可能不太好看，请酌情调节。",
				)}
				configAtom={showMusicAlbumAtom}
			/>
			<Box height="1em" />
			<SwitchSettings
				label={t(
					"page.settings.musicInfoAppearance.showVolumeControl.label",
					"显示音量控制条",
				)}
				configAtom={showVolumeControlAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.musicInfoAppearance.showBottomControl.label",
					"显示底部按钮组",
				)}
				description={t(
					"page.settings.musicInfoAppearance.showBottomControl.description",
					"在横向布局里是右下角的几个按钮，在竖向布局里是播放按钮下方的几个按钮",
				)}
				configAtom={showBottomControlAtom}
			/>
			<Box height="1em" />
			<SettingEntry
				label={t(
					"page.settings.musicInfoAppearance.playerControlsType.label",
					"播放控制组件类型",
				)}
				description={t(
					"page.settings.musicInfoAppearance.playerControlsType.description",
					"即歌曲信息下方的组件",
				)}
			>
				<Select.Root
					value={playerControlsType}
					onValueChange={(v) => setPlayerControlsType(v as PlayerControlsType)}
				>
					<Select.Trigger />
					<Select.Content>
						{playerControlsTypeMenu.map((item) => (
							<Select.Item key={item.value} value={item.value}>
								{item.label}
							</Select.Item>
						))}
					</Select.Content>
				</Select.Root>
			</SettingEntry>
			<Box height="1em" />
			<SettingEntry
				label={t(
					"page.settings.musicInfoAppearance.verticalCoverLayout.label",
					"垂直布局专辑图布局模式",
				)}
				description={t(
					"page.settings.musicInfoAppearance.verticalCoverLayout.description",
					"在隐藏歌词的情况下专辑图的布局方式：\n- 自动：根据专辑图是否为视频以使用沉浸布局\n- 强制默认布局：强制使用默认的专辑图布局\n- 强制沉浸布局：强制使用沉浸式的专辑图布局",
				)}
			>
				<Select.Root
					value={verticalCoverLayout}
					onValueChange={(v) =>
						setVerticalCoverLayout(v as VerticalCoverLayout)
					}
				>
					<Select.Trigger />
					<Select.Content>
						{verticalCoverLayoutMenu.map((item) => (
							<Select.Item key={item.value} value={item.value}>
								{item.label}
							</Select.Item>
						))}
					</Select.Content>
				</Select.Root>
			</SettingEntry>
			<SliderSettings
				label={t(
					"page.settings.musicInfoAppearance.fftDataRange.label",
					"音频可视化频域范围",
				)}
				description={t(
					"page.settings.musicInfoAppearance.fftDataRange.description",
					"单位为赫兹（hz），此项会影响音频可视化和背景跳动效果的展示效果",
				)}
				configAtom={fftDataRangeAtom}
				min={1}
				max={22050}
			>
				<Text wrap="nowrap">
					{fftDataRange[0]} Hz - {fftDataRange[1]} Hz
				</Text>
			</SliderSettings>
		</>
	);
};

const LyricBackgroundSettings = () => {
	const { t } = useTranslation();
	const [backgroundRendererValue, setBackgroundRendererValue] = useAtom(
		lyricBackgroundRendererAtom,
	);
	const [cssBackgroundProperty, setCssBackgroundProperty] = useAtom(
		cssBackgroundPropertyAtom,
	);
	const backgroundRendererMenu = useMemo(
		() => [
			{
				label: t(
					"page.settings.lyricBackground.menu.meshGradientRenderer",
					"网格渐变渲染器",
				),
				value: "mesh",
			},
			{
				label: t(
					"page.settings.lyricBackground.menu.pixiRenderer",
					"PixiJS 渲染器",
				),
				value: "pixi",
			},
			{
				label: t(
					"page.settings.lyricBackground.menu.cssBackground",
					"CSS 背景",
				),
				value: "css-bg",
			},
		],
		[t],
	);

	const getBackgroundRendererString = (
		value: LyricBackgroundRenderer,
	): string => {
		if (typeof value.renderer === "string" && value.renderer === "css-bg")
			return "css-bg";
		if (value.renderer === MeshGradientRenderer) return "mesh";
		if (value.renderer === PixiRenderer) return "pixi";
		return "mesh";
	};

	const handleBackgroundRendererChange = (selectedString: string) => {
		let rendererObject: LyricBackgroundRenderer;
		switch (selectedString) {
			case "mesh":
				rendererObject = {
					renderer: MeshGradientRenderer,
				};
				break;
			case "pixi":
				rendererObject = {
					renderer: PixiRenderer,
				};
				break;
			default:
				rendererObject = { renderer: "css-bg" };
				break;
		}
		setBackgroundRendererValue(rendererObject);
		localStorage.setItem(
			"amll-react-full.lyricBackgroundRenderer",
			selectedString,
		);
	};

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.lyricBackground.subtitle">歌词背景</Trans>
			</SubTitle>
			<SettingEntry
				label={t(
					"page.settings.lyricBackground.backgroundRenderer.label",
					"背景渲染器",
				)}
			>
				<Select.Root
					value={getBackgroundRendererString(backgroundRendererValue)}
					onValueChange={handleBackgroundRendererChange}
				>
					<Select.Trigger />
					<Select.Content>
						{backgroundRendererMenu.map((item) => (
							<Select.Item key={item.value} value={item.value}>
								{item.label}
							</Select.Item>
						))}
					</Select.Content>
				</Select.Root>
			</SettingEntry>

			{getBackgroundRendererString(backgroundRendererValue) === "css-bg" ? (
				<SettingEntry
					label={t(
						"page.settings.lyricBackground.lyricBackgroundColor.label",
						"CSS 背景属性值",
					)}
					description={t(
						"page.settings.lyricBackground.lyricBackgroundColor.description",
						"等同于放入 background 样式的字符串值，默认为 #111111",
					)}
				>
					<TextField.Root
						value={cssBackgroundProperty}
						onChange={(e) => setCssBackgroundProperty(e.currentTarget.value)}
					/>
				</SettingEntry>
			) : (
				<>
					<NumberSettings
						placeholder="60"
						type="number"
						min="1"
						max="1000"
						step="1"
						label={t(
							"page.settings.lyricBackground.lyricBackgroundFPS.label",
							"背景最高帧数",
						)}
						description={t(
							"page.settings.lyricBackground.lyricBackgroundFPS.description",
							"对性能影响较高，但是实际开销不大，如果遇到性能问题，可以尝试降低此值。默认值为 60。",
						)}
						configAtom={lyricBackgroundFPSAtom}
					/>
					<NumberSettings
						placeholder="1.0"
						type="number"
						min="0.01"
						max="10.0"
						step="0.01"
						label={t(
							"page.settings.lyricBackground.lyricBackgroundRenderScale.label",
							"背景渲染倍率",
						)}
						description={t(
							"page.settings.lyricBackground.lyricBackgroundRenderScale.description",
							"对性能影响较高，但是实际开销不大，如果遇到性能问题，可以尝试降低此值。默认值为 1 即每像素点渲染。",
						)}
						configAtom={lyricBackgroundRenderScaleAtom}
					/>
					<SwitchSettings
						label={t(
							"page.settings.lyricBackground.lyricBackgroundStaticMode.label",
							"背景静态模式",
						)}
						description={t(
							"page.settings.lyricBackground.lyricBackgroundStaticMode.description",
							"让背景会在除了切换歌曲变换封面的情况下保持静止，如果遇到了性能问题，可以考虑开启此项。\n注意：启用此项会导致背景跳动效果失效。",
						)}
						configAtom={lyricBackgroundStaticModeAtom}
					/>
				</>
			)}
		</>
	);
};


/** Button-group selector for the startup log level. Takes effect next launch. */
const LogLevelSetting: FC = () => {
	const { t } = useTranslation();
	const [level, setLevel] = useState<LogLevel>(() => {
		try {
			const raw = localStorage.getItem("amll-player.logLevel") as LogLevel | null;
			return raw === "debug" || raw === "off" ? raw : "normal";
		} catch {
			return "normal";
		}
	});
	const [busy, setBusy] = useState(false);

	const options: { value: LogLevel; label: string; hint: string }[] = [
		{
			value: "debug",
			label: t("page.settings.logLevel.debug", "调试"),
			hint: t("page.settings.logLevel.debugHint", "记录最详细的信息，用于排查问题；日志增长较快。"),
		},
		{
			value: "normal",
			label: t("page.settings.logLevel.normal", "正常"),
			hint: t("page.settings.logLevel.normalHint", "默认档位，只记录运行状况与重要警告。"),
		},
		{
			value: "off",
			label: t("page.settings.logLevel.off", "关闭"),
			hint: t("page.settings.logLevel.offHint", "不写日志；节省磁盘占用，出问题时无记录可查。"),
		},
	];

	const choose = async (next: LogLevel) => {
		if (busy || next === level) return;
		setBusy(true);
		try {
			await setLogLevel(next);
			localStorage.setItem("amll-player.logLevel", next);
			setLevel(next);
		} finally {
			setBusy(false);
		}
	};

	return (
		<SettingEntry
			label={t("page.settings.logLevel.label", "启动调试 LOG 等级")}
			description={t("page.settings.logLevel.description", "选择下次启动时记录的详细程度。更改后需重启程序生效。")}
		>
			<Flex gap="1" wrap="wrap">
				{options.map((option) => (
					<Button
						key={option.value}
						size="2"
						variant={level === option.value ? "solid" : "soft"}
						disabled={busy}
						title={option.hint}
						onClick={() => void choose(option.value)}
					>
						{option.label}
					</Button>
				))}
			</Flex>
		</SettingEntry>
	);
};

/** Storage manager: shows real folder sizes and cleans only disposable data. */
const StorageSettings: FC = () => {
	const { t } = useTranslation();
	const [usage, setUsage] = useState<StorageUsage | null>(null);
	const [cache, setCache] = useState<OnlineCacheUsage | null>(null);
	const [loading, setLoading] = useState(true);
	const [cleaning, setCleaning] = useState(false);
	const [message, setMessage] = useState("");

	const refresh = () => {
		setLoading(true);
		getStorageUsage()
			.then(setUsage)
			.catch((e) => setMessage(String(e)))
			.finally(() => setLoading(false));
		getOnlineCacheUsage()
			.then(setCache)
			.catch(() => setCache(null));
	};

	useEffect(() => {
		refresh();
	}, []);

	const clean = async (which: "covers" | "logs" | "music" | "all") => {
		setCleaning(true);
		setMessage("");
		try {
			const result = await cleanStorage({
				cleanCovers: which === "covers" || which === "all",
				cleanLogs: which === "logs" || which === "all",
				cleanMusicCache: which === "music" || which === "all",
			});
			setMessage(
				t("page.settings.storage.cleaned", "已清理 {count} 个文件，释放 {size}", {
					count: result.deletedFiles,
					size: formatBytes(result.freedBytes),
				}),
			);
			if (result.errors.length) {
				setMessage((prev) => `${prev}（${result.errors.join("; ")}）`);
			}
			refresh();
		} catch (e) {
			setMessage(String(e));
		} finally {
			setCleaning(false);
		}
	};

	const cleanOnlineCacheNow = async () => {
		setCleaning(true);
		setMessage("");
		try {
			const before = cache?.bytes ?? 0;
			await clearOnlineCache();
			setMessage(
				t("page.settings.storage.onlineCacheCleaned", "已清理在线缓存，释放 {size}", {
					size: formatBytes(before),
				}),
			);
			refresh();
		} catch (e) {
			setMessage(String(e));
		} finally {
			setCleaning(false);
		}
	};

	const rows: { key: keyof StorageUsage | "total"; label: string; value: string }[] = [
		{ key: "total", label: t("page.settings.storage.total", "软件当前占用"), value: formatBytes(usage?.totalBytes ?? 0) },
		{ key: "cacheBytes", label: t("page.settings.storage.cache", "缓存占用（封面）"), value: formatBytes(usage?.cacheBytes ?? 0) },
		{ key: "logBytes", label: t("page.settings.storage.logs", "日志占用"), value: formatBytes(usage?.logBytes ?? 0) },
		{ key: "musicCacheBytes", label: t("page.settings.storage.musicCache", "音频缓存占用"), value: formatBytes(usage?.musicCacheBytes ?? 0) },
	];

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.storage.subtitle">存储空间管理</Trans>
			</SubTitle>
			<Text as="div" color="gray" size="2" mb="3">
				<Trans i18nKey="page.settings.storage.tip">
					显示软件占用的磁盘空间。清理只会删除可再生的缓存与旧日志，不会删除曲库、歌单、歌词库或扩展。
				</Trans>
			</Text>
			<Card mt="2">
				<Flex direction="column" gap="2">
					{rows.map((row) => (
						<Flex key={row.key} justify="between" align="center">
							<Text size="2">{row.label}</Text>
							<Text size="2" weight="bold">{loading ? "…" : row.value}</Text>
						</Flex>
					))}
					<Flex justify="between" align="center">
						<Text size="2">
							<Trans i18nKey="page.settings.storage.onlineCache">
								在线歌曲缓存（下载的音频）
							</Trans>
						</Text>
						<Text size="2" weight="bold">
							{loading ? "…" : formatBytes(cache?.bytes ?? 0)}
							{cache && cache.files > 0 ? (
								<Text size="1" color="gray">
									{" "}
									· {cache.files}
								</Text>
							) : null}
						</Text>
					</Flex>
				</Flex>
			</Card>
			<Flex gap="2" wrap="wrap" mt="3">
				<Button variant="solid" disabled={cleaning} onClick={() => void clean("all")}>
					<Trans i18nKey="page.settings.storage.cleanAll">一键清理</Trans>
				</Button>
				<Button variant="soft" disabled={cleaning} onClick={() => void clean("covers")}>
					<Trans i18nKey="page.settings.storage.cleanCache">清理缓存</Trans>
				</Button>
				<Button variant="soft" disabled={cleaning} onClick={() => void clean("logs")}>
					<Trans i18nKey="page.settings.storage.cleanLogs">清理日志</Trans>
				</Button>
				<Button variant="soft" disabled={cleaning} onClick={() => void cleanOnlineCacheNow()}>
					<Trans i18nKey="page.settings.storage.cleanOnlineCache">清理在线缓存</Trans>
				</Button>
				<Button variant="soft" disabled={cleaning} onClick={refresh}>
					<Trans i18nKey="page.settings.storage.refresh">刷新</Trans>
				</Button>
			</Flex>
			{message ? <Text as="div" size="2" color="gray" mt="2">{message}</Text> : null}
		</>
	);
};

/**
 * Custom source manager, compatible with lx-music-desktop 自定义源 scripts.
 *
 * Sources are only a way to *resolve* a playable URL; searching is done by the
 * app itself. A source that cannot resolve anything is shown as unavailable and
 * is skipped at playback time, so a broken third-party source never blocks the
 * built-in direct resolver.
 */
const OnlineSourceSettings: FC = () => {
	const { t } = useTranslation();
	const [sources, setSources] = useState<StoredSource[]>([]);
	const [health, setHealth] = useState<Record<string, { ok: boolean; message: string }>>({});
	const [busy, setBusy] = useState("");
	const [message, setMessage] = useState("");
	const [url, setUrl] = useState("");

	const refresh = useCallback(() => setSources(loadSources()), []);

	useEffect(() => {
		refresh();
		// Show the real state as soon as the page opens instead of a stale badge
		// left over from an earlier session.
		void ensureSourceHealth()
			.then((map) => {
				const next: Record<string, { ok: boolean; message: string }> = {};
				map.forEach((value, key) => {
					next[key] = value;
				});
				setHealth(next);
			})
			.catch(() => {});
	}, [refresh]);

	const check = async () => {
		setBusy("check");
		setMessage("");
		try {
			const map = await ensureSourceHealth(true);
			const next: Record<string, { ok: boolean; message: string }> = {};
			map.forEach((value, key) => {
				next[key] = value;
			});
			setHealth(next);
			setMessage(t("page.settings.online.checked", "检测完成，可用状态已更新"));
		} catch (err) {
			setMessage((err as Error)?.message ?? String(err));
		} finally {
			setBusy("");
		}
	};

	const importFromFile = async () => {
		setBusy("file");
		setMessage("");
		try {
			const picked = await open({
				multiple: false,
				filters: [{ name: "洛雪音源", extensions: ["js"] }],
			});
			if (!picked || typeof picked !== "string") return;
			const raw = await readTextFile(picked);
			const source = importSource(raw);
			resetOnlineRuntimeCache();
			refresh();
			setMessage(
				t("page.settings.online.imported", "已导入「{name}」", { name: source.name }),
			);
		} catch (err) {
			setMessage(
				t("page.settings.online.importFailed", "导入失败：{error}", {
					error: (err as Error)?.message ?? String(err),
				}),
			);
		} finally {
			setBusy("");
		}
	};

	const importFromUrl = async () => {
		if (!url.trim()) return;
		setBusy("url");
		setMessage("");
		try {
			const raw = await fetchSourceFromUrl(url.trim());
			const source = importSource(raw);
			resetOnlineRuntimeCache();
			refresh();
			setUrl("");
			setMessage(
				t("page.settings.online.imported", "已导入「{name}」", { name: source.name }),
			);
		} catch (err) {
			setMessage(
				t("page.settings.online.importFailed", "导入失败：{error}", {
					error: (err as Error)?.message ?? String(err),
				}),
			);
		} finally {
			setBusy("");
		}
	};

	const toggle = (source: StoredSource) => {
		updateSource(source.id, { enabled: !source.enabled });
		resetOnlineRuntimeCache();
		refresh();
	};

	const remove = (source: StoredSource) => {
		removeSource(source.id);
		resetOnlineRuntimeCache();
		refresh();
	};

	const restore = () => {
		restoreBuiltinSources();
		resetOnlineRuntimeCache();
		refresh();
		setMessage(t("page.settings.online.restored", "已恢复内置音源"));
	};

	const importFromLx = async () => {
		setBusy("lx");
		setMessage("");
		try {
			const result = await importFromLxMusic();
			resetOnlineRuntimeCache();
			refresh();
			setMessage(
				t(
					"page.settings.online.lxImported",
					"已从洛雪音乐导入 {imported} 个音源（跳过 {skipped} 个）",
					{ imported: result.imported, skipped: result.skipped },
				),
			);
		} catch (err) {
			setMessage(
				t("page.settings.online.lxImportFailed", "导入失败：{error}", {
					error: (err as Error)?.message ?? String(err),
				}),
			);
		} finally {
			setBusy("");
		}
	};

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.online.subtitle">在线音源</Trans>
			</SubTitle>
			<Text as="div" color="gray" size="2" mb="3">
				<Trans i18nKey="page.settings.online.tip">
					这里管理兼容洛雪音乐的自定义音源。音源负责把歌曲解析成可播放地址，搜索由软件自身完成；音源不可用时会自动改用内置直连。
				</Trans>
			</Text>

			<Flex gap="2" wrap="wrap" align="center">
				<Button variant="solid" disabled={busy !== ""} onClick={() => void importFromLx()}>
					<Trans i18nKey="page.settings.online.importLx">从洛雪音乐导入</Trans>
				</Button>
				<Button variant="soft" disabled={busy !== ""} onClick={() => void importFromFile()}>
					<Trans i18nKey="page.settings.online.importFile">导入文件</Trans>
				</Button>
				<Button variant="soft" disabled={busy !== ""} onClick={() => void check()}>
					<Trans i18nKey="page.settings.online.check">检测可用性</Trans>
				</Button>
				<Button variant="soft" onClick={restore}>
					<Trans i18nKey="page.settings.online.restore">恢复内置音源</Trans>
				</Button>
			</Flex>

			<Flex gap="2" mt="2" align="center">
				<TextField.Root
					placeholder={t("page.settings.online.urlPlaceholder", "粘贴音源 js 链接")}
					value={url}
					onChange={(evt) => setUrl(evt.target.value)}
					style={{ flexGrow: 1 }}
				/>
				<Button variant="soft" disabled={busy !== "" || !url.trim()} onClick={() => void importFromUrl()}>
					<Trans i18nKey="page.settings.online.importUrl">从链接导入</Trans>
				</Button>
			</Flex>

			{message ? (
				<Text as="div" size="2" color="gray" mt="2">
					{message}
				</Text>
			) : null}

			<Flex direction="column" gap="2" mt="3">
				{sources.map((source) => {
					const status = health[source.id];
					return (
						<Card key={source.id}>
							<Flex align="center" gap="3" wrap="wrap">
								<Flex direction="column" flexGrow="1" style={{ minWidth: 0 }}>
									<Flex align="center" gap="2" wrap="wrap">
										<Text weight="bold">{source.name}</Text>
										{source.version ? (
											<Text size="1" color="gray">
												v{source.version}
											</Text>
										) : null}
										{source.builtin ? (
											<Badge size="1" variant="soft">
												<Trans i18nKey="page.settings.online.builtin">内置</Trans>
											</Badge>
										) : null}
										{!source.enabled ? (
											<Badge size="1" color="gray" variant="soft">
												<Trans i18nKey="page.settings.online.disabled">已停用</Trans>
											</Badge>
										) : status ? (
											<Badge size="1" color={status.ok ? "grass" : "red"} variant="soft">
												{status.ok
													? t("page.settings.online.available", "可用")
													: t("page.settings.online.unavailable", "不可用")}
											</Badge>
										) : null}
									</Flex>
									<Text
										size="1"
										color="gray"
										truncate
										title={status && !status.ok ? status.message : source.description}
									>
										{status && !status.ok ? status.message : source.description || source.author}
									</Text>
								</Flex>
								<Flex gap="2">
									<Button size="1" variant="soft" onClick={() => toggle(source)}>
										{source.enabled ? (
											<Trans i18nKey="page.settings.online.disable">停用</Trans>
										) : (
											<Trans i18nKey="page.settings.online.enable">启用</Trans>
										)}
									</Button>
									<Button size="1" variant="soft" color="red" onClick={() => remove(source)}>
										<Trans i18nKey="page.settings.online.remove">删除</Trans>
									</Button>
								</Flex>
							</Flex>
						</Card>
					);
				})}
			</Flex>
		</>
	);
};

const OthersSettings = () => {
	const { t } = useTranslation();
	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.others.subtitle">杂项</Trans>
			</SubTitle>
			<LogLevelSetting />
			<SwitchSettings
				label={t(
					"page.settings.others.showStatJSFrame.label",
					"显示性能统计信息",
				)}
				description={t(
					"page.settings.others.showStatJSFrame.description",
					"可以看到帧率、帧时间、内存占用（仅 Chromuim 系）等信息，对性能影响较小。",
				)}
				configAtom={showStatJSFrameAtom}
			/>
			<SwitchSettings
				label={t(
					"page.settings.smtc.enableMediaControls.label",
					"启用内置播放器的媒体控件",
				)}
				description={t(
					"page.settings.smtc.enableMediaControls.description",
					"目前只支持 Windows 的 SMTC",
				)}
				configAtom={enableMediaControlsAtom}
			/>
			<Button my="2" onClick={() => restartApp()}>
				<Trans i18nKey="page.settings.others.restartProgram">重启程序</Trans>
			</Button>
			<Button
				m="2"
				variant="soft"
				onClick={() => {
					router.navigate("/amll-dev");
				}}
			>
				<Trans i18nKey="page.settings.others.enterAmllDevPage">
					歌词页面开发用工具
				</Trans>
			</Button>
		</>
	);
};

/**
 * Per-entry visibility for the playback page's right-click menu. Each switch
 * writes one key of the stored object; defaults are all on so the menu looks
 * unchanged until the user opts out of an item.
 */
const ContextMenuSettings = () => {
	const { t } = useTranslation();
	const [visibility, setVisibility] = useAtom(contextMenuVisibilityAtom);

	const items: { key: keyof ContextMenuVisibility; label: string; description: string }[] = [
		{ key: "prevSong", label: t("page.settings.contextMenu.prevSong", "上一首"), description: t("page.settings.contextMenu.prevSongDesc", "在右键菜单中显示「上一首」") },
		{ key: "playPause", label: t("page.settings.contextMenu.playPause", "暂停 / 继续"), description: t("page.settings.contextMenu.playPauseDesc", "在右键菜单中显示「暂停 / 继续」") },
		{ key: "nextSong", label: t("page.settings.contextMenu.nextSong", "下一首"), description: t("page.settings.contextMenu.nextSongDesc", "在右键菜单中显示「下一首」") },
		{ key: "fullscreen", label: t("page.settings.contextMenu.fullscreen", "进入 / 退出全屏"), description: t("page.settings.contextMenu.fullscreenDesc", "在右键菜单中显示全屏项（需先在常规中启用 F11 全屏）") },
		{ key: "alwaysOnTop", label: t("page.settings.contextMenu.alwaysOnTop", "窗口置顶"), description: t("page.settings.contextMenu.alwaysOnTopDesc", "在右键菜单中显示「窗口置顶」") },
		{ key: "showLyrics", label: t("page.settings.contextMenu.showLyrics", "显示歌词"), description: t("page.settings.contextMenu.showLyricsDesc", "在右键菜单中显示「显示歌词」") },
		{ key: "editSongInfo", label: t("page.settings.contextMenu.editSongInfo", "编辑歌曲覆盖信息"), description: t("page.settings.contextMenu.editSongInfoDesc", "在右键菜单中显示「编辑歌曲覆盖信息」") },
		{ key: "recordPanel", label: t("page.settings.contextMenu.recordPanel", "打开捕获面板"), description: t("page.settings.contextMenu.recordPanelDesc", "在右键菜单中显示「打开捕获面板」") },
		{ key: "screenshot", label: t("page.settings.contextMenu.screenshot", "打开截图工具"), description: t("page.settings.contextMenu.screenshotDesc", "在右键菜单中显示「打开截图工具」") },
		{ key: "exitLyricPage", label: t("page.settings.contextMenu.exitLyricPage", "退出歌词页面"), description: t("page.settings.contextMenu.exitLyricPageDesc", "在右键菜单中显示「退出歌词页面」") },
	];

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.settings.contextMenu.subtitle">右键菜单设置</Trans>
			</SubTitle>
			<Text as="div" color="gray" size="2" mb="3">
				<Trans i18nKey="page.settings.contextMenu.tip">
					选择歌曲播放页右键菜单中要显示的选项。关闭的选项不会出现在菜单中。
				</Trans>
			</Text>
			{items.map((item) => (
				<SwitchSettings
					key={item.key}
					label={item.label}
					description={item.description}
					configAtom={atom(
						(get) => visibility[item.key],
						(_get, set, value: boolean) =>
							setVisibility({ ...visibility, [item.key]: value }),
					)}
				/>
			))}
			<Button
				my="3"
				variant="soft"
				onClick={() => setVisibility({ ...DEFAULT_CONTEXT_MENU_VISIBILITY })}
			>
				<Trans i18nKey="page.settings.contextMenu.reset">恢复默认</Trans>
			</Button>
		</>
	);
};

const TaskbarLyricSettings = () => {
	const { t } = useTranslation();
	const [enabled, setEnabled] = useAtom(enableTaskbarLyricAtom);
	const [themeSetting, setThemeSetting] = useAtom(taskbarLyricThemeSettingAtom);
	const [alignSetting, setAlignSetting] = useAtom(taskbarLyricAlignSettingAtom);
	const [modeSetting, setModeSetting] = useAtom(taskbarLyricModeSettingAtom);

	return (
		<>
			<SubTitle>
				{t("page.settings.taskbarLyric.subtitle", "任务栏歌词")}
			</SubTitle>
			<SettingEntry
				label={t("page.settings.taskbarLyric.enable.label", "启用任务栏歌词")}
				description={t(
					"page.settings.taskbarLyric.enable.description",
					"在 Windows 任务栏上显示当前播放的歌词",
				)}
			>
				<Switch checked={enabled} onCheckedChange={setEnabled} />
			</SettingEntry>

			<SettingEntry
				label={t("page.settings.taskbarLyric.theme.label", "主题设置")}
				description={t(
					"page.settings.taskbarLyric.theme.description",
					"覆盖任务栏歌词的颜色主题",
				)}
			>
				<Select.Root
					value={themeSetting}
					onValueChange={(v) => setThemeSetting(v as "auto" | "dark" | "light")}
				>
					<Select.Trigger />
					<Select.Content>
						<Select.Item value="auto">
							{t("page.settings.taskbarLyric.theme.auto", "跟随任务栏")}
						</Select.Item>
						<Select.Item value="light">
							{t("page.settings.taskbarLyric.theme.light", "浅色")}
						</Select.Item>
						<Select.Item value="dark">
							{t("page.settings.taskbarLyric.theme.dark", "深色")}
						</Select.Item>
					</Select.Content>
				</Select.Root>
			</SettingEntry>

			<SettingEntry
				label={t("page.settings.taskbarLyric.align.label", "对齐方向")}
				description={t(
					"page.settings.taskbarLyric.align.description",
					"任务栏歌词的对齐方向",
				)}
			>
				<Select.Root
					value={alignSetting}
					onValueChange={(v) => setAlignSetting(v as "auto" | "left" | "right")}
				>
					<Select.Trigger />
					<Select.Content>
						<Select.Item value="auto">
							{t("page.settings.taskbarLyric.align.auto", "自动")}
						</Select.Item>
						<Select.Item value="left">
							{t("page.settings.taskbarLyric.align.left", "左对齐")}
						</Select.Item>
						<Select.Item value="right">
							{t("page.settings.taskbarLyric.align.right", "右对齐")}
						</Select.Item>
					</Select.Content>
				</Select.Root>
			</SettingEntry>

			<SettingEntry
				label={t("page.settings.taskbarLyric.mode.label", "歌词行数")}
			>
				<Select.Root
					value={modeSetting}
					onValueChange={(v) =>
						setModeSetting(v as "auto" | "single" | "double")
					}
				>
					<Select.Trigger />
					<Select.Content>
						<Select.Item value="auto">
							{t("page.settings.taskbarLyric.mode.auto", "自动")}
						</Select.Item>
						<Select.Item value="single">
							{t("page.settings.taskbarLyric.mode.single", "单行模式")}
						</Select.Item>
						<Select.Item value="double">
							{t("page.settings.taskbarLyric.mode.double", "双行模式")}
						</Select.Item>
					</Select.Content>
				</Select.Root>
			</SettingEntry>

			{import.meta.env.DEV && (
				<Button
					my="2"
					variant="soft"
					onClick={() => invoke("open_taskbar_lyric_devtools")}
				>
					{t("page.settings.taskbarLyric.openDevtools", "打开 DevTools")}
				</Button>
			)}
		</>
	);
};

const openLink = async (url: string) => {
	if (!url) return;
	try {
		await openUrl(url);
	} catch {
		window.open(url, "_blank");
	}
};

interface Contributor {
	id: number;
	login: string;
	avatar: string;
	url: string;
}

// This edition is maintained by cuicanx. Pin the maintainer card so it is
// always visible even when the GitHub API is unreachable, and mark it as the
// primary maintainer in the About page.
const MAINTAINER: Contributor = {
	id: 0,
	login: "cuicanx",
	// Resolved per region at render time (see `maintainerAvatar()`): the
	// github.com avatar host is unreliable on mainland networks.
	avatar: "https://github.com/cuicanx.png",
	url: "https://github.com/cuicanx",
};

const MAINTAINER_AVATAR = "https://avatars.githubusercontent.com/cuicanx";

function maintainerAvatar(): string {
	return avatarFor(MAINTAINER_AVATAR);
}

/**
 * Avatars are served from `avatars.githubusercontent.com`, which is one of the
 * hosts mainland networks usually cannot reach. Route them through the same
 * region-aware transport as everything else instead of leaving broken images.
 */
function avatarFor(url: string): string {
	if (!url) return url;
	return peekUpdateRegion() === "global" ? url : mirrorUrl(url);
}

const REPOSITORY_URL = "https://github.com/cuicanx/amll-player";

const CONTRIBUTORS_API =
	"https://api.github.com/repos/cuicanx/amll-player/contributors?per_page=100&anon=true";

/** Cached contributor list: show instantly on the About page, refresh behind. */
const CONTRIBUTORS_CACHE_KEY = "amll-player.contributors";
const CONTRIBUTORS_CACHE_TTL = 6 * 60 * 60 * 1000;

function readContributorCache(): Contributor[] | null {
	try {
		const raw = localStorage.getItem(CONTRIBUTORS_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as { at: number; items: Contributor[] };
		if (!Array.isArray(parsed.items) || Date.now() - parsed.at > CONTRIBUTORS_CACHE_TTL) {
			return null;
		}
		return parsed.items;
	} catch {
		return null;
	}
}

function writeContributorCache(items: Contributor[]): void {
	try {
		localStorage.setItem(
			CONTRIBUTORS_CACHE_KEY,
			JSON.stringify({ at: Date.now(), items }),
		);
	} catch {
		/* storage unavailable - caching is best-effort */
	}
}

/**
 * Fetch the contributor list from the region-appropriate transport.
 *
 * Same rule as the updater: the egress IP decides which source leads, so a
 * mainland user goes through the proxy while a VPN user whose exit node is
 * abroad talks to GitHub directly. The other transport is started shortly
 * afterwards as a fallback instead of racing from the first millisecond - that
 * way the preferred source still wins when both are reachable, but a dead one
 * cannot stall the list.
 */
async function fetchContributorsFast(): Promise<unknown[] | null> {
	const region = await detectUpdateRegion();
	const primary = region === "global" ? CONTRIBUTORS_API : mirrorUrl(CONTRIBUTORS_API);
	const fallback = region === "global" ? mirrorUrl(CONTRIBUTORS_API) : CONTRIBUTORS_API;
	const controller = new AbortController();
	const request = async (url: string) => {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { Accept: "application/vnd.github+json" },
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		if (!Array.isArray(data)) throw new Error("unexpected payload");
		return data as unknown[];
	};

	const fallbackDelay = new Promise<never>((_, reject) => {
		window.setTimeout(() => reject(new Error("fallback")), 1200);
	});

	try {
		const data = await Promise.any([
			request(primary),
			Promise.race([fallbackDelay, request(fallback)]),
		]);
		controller.abort();
		return data;
	} catch {
		return null;
	}
}

/**
 * Circular contributor avatar.
 *
 * Radix's `Avatar` rendered as a rounded square in this app (its radius comes
 * from a theme token we override), so the image and its initials fallback are
 * drawn directly with a 50% radius. Drawn at module level on purpose: a
 * component declared inside the section would get a new identity on every
 * render and remount every avatar (losing the error fallback each time).
 */
const ContributorAvatar: FC<{ item: Contributor }> = ({ item }) => {
	const [failed, setFailed] = useState(false);
	const showImage = Boolean(item.avatar) && !failed;
	return (
		<span className={about.avatar}>
			{showImage ? (
				<img
					className={about.avatarImage}
					src={avatarFor(item.avatar)}
					alt=""
					onError={() => setFailed(true)}
				/>
			) : (
				<span className={about.avatarFallback}>
					{item.login.substring(0, 2).toUpperCase()}
				</span>
			)}
		</span>
	);
};

const ContributorsSection: FC = () => {
	const { t } = useTranslation();
	// Seeded from cache so the About page never shows an empty list on open.
	const [contributors, setContributors] = useState<Contributor[]>(
		() => readContributorCache() ?? [],
	);
	const [loading, setLoading] = useState(() => readContributorCache() === null);

	useEffect(() => {
		const fetchData = async () => {
			try {
				const data = await fetchContributorsFast();
				if (data) {
					const list: Contributor[] = data
						.filter(
							(item: any) =>
								item.login &&
								item.login.toLowerCase() !== MAINTAINER.login &&
								item.login !== "type-bot" &&
								item.type !== "Bot" &&
								!item.login.endsWith("[bot]"),
						)
						.map((item: any) => ({
							id: item.id,
							login: item.login,
							avatar: item.avatar_url || "",
							url: item.html_url || `https://github.com/${item.login}`,
						}));
					setContributors(list);
					writeContributorCache(list);
				}
			} catch (error) {
				console.error("Failed to fetch contributors:", error);
			} finally {
				setLoading(false);
			}
		};

		fetchData();
	}, []);

	// The maintainer keeps the highlighted card above. Everyone else uses the
	// same card layout (avatar + bold login) at a slightly smaller size.
	// Slightly smaller than the previous card: `size="1"` tightens the padding
	// and the grid column is narrower, while the avatar + bold name layout is
	// kept so the rows stay scannable.
	const renderContributorCard = (item: Contributor) => (
		<Card
			key={item.id}
			asChild
			size="1"
			style={{
				cursor: "pointer",
				textDecoration: "none",
				color: "inherit",
				maxWidth: "24rem",
			}}
		>
			<a
				href={item.url}
				target="_blank"
				rel="noopener noreferrer"
				onClick={(e) => {
					e.preventDefault();
					openLink(item.url);
				}}
			>
				<Flex align="center" gap="2">
					<ContributorAvatar item={item} />
					<Text weight="bold" size="1" truncate style={{ overflow: "hidden" }}>
						{item.login}
					</Text>
				</Flex>
			</a>
		</Card>
	);

	return (
		<>
			<div className={about.sectionHeader}>
				<span className={about.sectionTitle}>
					{t("page.about.otherContributors", "其他贡献者")}
				</span>
				{!loading && contributors.length > 0 && (
					<span className={about.sectionCount}>{contributors.length}</span>
				)}
			</div>
			{loading ? (
				<div className={about.loadingHint}>
					{t("page.about.loadingContributors", "正在加载贡献者列表…")}
				</div>
			) : contributors.length === 0 ? (
				<div className={about.loadingHint}>
					{t("page.about.noOtherContributors", "暂无其他贡献者")}
				</div>
			) : (
				<Grid
					style={{
						gridTemplateColumns: "repeat(auto-fill, minmax(17rem, 1fr))",
					}}
					gap="3"
					my="2"
				>
					{contributors.map(renderContributorCard)}
				</Grid>
			)}
		</>
	);
};

const AboutSettings = () => {
	const { t } = useTranslation();
	const updateInfo = useAtomValue(updateInfoAtom);
	const appVersion = useAtomValue(appVersionAtom);
	const updating = useAtomValue(isInstallingUpdateAtom);
	const updateProgress = useAtomValue(updateProgressAtom);
	const updateSpeed = useAtomValue(updateSpeedAtom);
	const updateError = useAtomValue(updateErrorAtom);
	const installAttempts = useAtomValue(installAttemptsAtom);
	const upstreamRelease = useAtomValue(upstreamUpdateAtom);
	const checkUpdate = useSetAtom(checkUpdateAtom);
	const installUpdate = useSetAtom(installUpdateAtom);
	const checkUpstreamUpdate = useSetAtom(checkUpstreamUpdateAtom);

	// Informational only: never blocks or changes the primary update flow.
	useEffect(() => {
		void checkUpstreamUpdate();
	}, [checkUpstreamUpdate]);

	return (
		<>
			<SubTitle>
				<Trans i18nKey="page.about.subtitle">关于</Trans>
			</SubTitle>

			<div className={about.hero}>
				<div className={about.heroName}>AMLL Player</div>
				<div className={about.heroMeta}>
					{appVersion.state === "hasData" ? `${appVersion.data} · ` : ""}
					{commit.substring(0, 7)} · {branch}
				</div>
				<p className={about.heroDesc}>
					{t("page.about.description", "Apple Music-like Lyrics Player")}
				</p>
			</div>

			{/* The maintainer of this edition is the one identity that should
			   stand out; everything else on the page is deliberately quieter. */}
			<div className={about.maintainer}>
				<Avatar
					className={about.maintainerAvatar}
					size="5"
					radius="full"
					src={maintainerAvatar()}
					fallback="CX"
				/>
				<div className={about.maintainerBody}>
					<div className={about.maintainerName}>
						<span>{MAINTAINER.login}</span>
						<span className={about.roleChip}>
							{t("page.about.maintainerRole", "主要维护者")}
						</span>
					</div>
					<div className={about.maintainerNote}>
						<Trans i18nKey="page.about.credits">
							当前版本由 cuicanx 主要维护并参与贡献
						</Trans>
					</div>
					<div className={about.maintainerLinks}>
						<a
							className={about.link}
							href={MAINTAINER.url}
							target="_blank"
							rel="noopener noreferrer"
							onClick={(e) => {
								e.preventDefault();
								openLink(MAINTAINER.url);
							}}
						>
							{t("page.about.maintainerLink", "GitHub · cuicanx")}
						</a>
						<a
							className={about.link}
							href={REPOSITORY_URL}
							target="_blank"
							rel="noopener noreferrer"
							onClick={(e) => {
								e.preventDefault();
								openLink(REPOSITORY_URL);
							}}
						>
							{t("page.about.releaseLink", "cuicanx/amll-player")}
						</a>
					</div>
				</div>
			</div>

			{/* Upstream credit: present, but clearly secondary. */}
			<p className={about.upstream}>
				<Trans i18nKey="page.about.upstream">
					本项目基于 AMLL（Apple Music-like Lyrics）上游项目开发，感谢原作者 SteveXMH
					与上游全体贡献者。
				</Trans>
			</p>

			<ContributorsSection />
			<Suspense>
				{updateInfo && (
					<>
						<Separator size="4" my="3" />
						<div id="updater">
							<Text weight="bold" size="3" as="div" mt="1">
								{t(
									"page.about.newVersion",
									"有可用更新从 {currentVersion} 升级至 {nextVersion}",
									{
										currentVersion: updateInfo.currentVersion,
										nextVersion: updateInfo.version,
									},
								)}
							</Text>
							<ReleaseNotes
								body={updateInfo.body}
								version={updateInfo.version}
								currentVersion={updateInfo.currentVersion}
								label={t("page.about.releaseNotes", "更新内容")}
								emptyHint={t(
									"page.about.releaseNotesEmpty",
									"此版本没有附带更新说明，可直接安装。",
								)}
							/>
						</div>
						<Flex gap="3" align="center" wrap="wrap">
							<Button
								disabled={updating}
								loading={updating}
								onClick={() => {
									void installUpdate();
								}}
							>
								<Trans i18nKey="page.about.installUpdate">更新并安装</Trans>
							</Button>
							{updating && (
								<Text size="2" color="gray">
									{updateProgress === null
										? t("page.about.updatePreparing", "正在连接更新源…")
										: t(
												"page.about.updateProgress",
												"正在下载更新… {percent}%",
												{ percent: Math.round(updateProgress * 100) },
											)}
									{formatSpeed(updateSpeed)
										? ` · ${formatSpeed(updateSpeed)}`
										: ""}
								</Text>
							)}
						</Flex>
						<Box mb="3" />
					</>
				)}
				{updateError && (
					<>
						<Separator size="4" my="3" />
						<Text as="div" color="red" size="2">
							{t("page.about.updateError", "更新失败：{error}", {
								error: updateError,
							})}
						</Text>
						{installAttempts >= 2 && (
							<Text as="div" color="gray" size="1" my="1">
								{t(
									"page.about.updateManualHint",
									"已多次失败，可前往发布页手动下载安装包",
								)}
							</Text>
						)}
						<Flex gap="3" mt="2" wrap="wrap">
							<Button
								variant="soft"
								onClick={() => {
									void checkUpdate();
								}}
							>
								{t("page.about.updateRetry", "重试")}
							</Button>
							<Button
								variant="ghost"
								onClick={() => {
									openLink(UPDATE_RELEASE_PAGE);
								}}
							>
								{t("page.about.updateManualDownload", "打开发布页")}
							</Button>
						</Flex>
					</>
				)}
				{upstreamRelease && (
					<Text as="div" size="1" color="gray" mt="2">
						<a
							href={upstreamRelease.url}
							onClick={(e) => {
								e.preventDefault();
								openLink(upstreamRelease.url);
							}}
							style={{ color: "inherit", textDecoration: "underline" }}
						>
							{t(
								"page.about.upstreamAvailable",
								"上游有新构建（{version}），查看上游发布页",
								{ version: upstreamRelease.version },
							)}
						</a>
					</Text>
				)}
			</Suspense>
		</>
	);
};

export const PlayerSettingsTab: FC<{ category: string }> = ({ category }) => {
	switch (category) {
		case "general":
			return <GeneralSettings />;
		case "lyricContent":
			return <LyricContentSettings />;
		case "lyricAppearance":
			return <LyricAppearanceSettings />;
		case "musicInfoAppearance":
			return <MusicInfoAppearanceSettings />;
		case "lyricBackground":
			return <LyricBackgroundSettings />;
		case "others":
			return <OthersSettings />;
		case "contextMenu":
			return <ContextMenuSettings />;
		case "storage":
			return <StorageSettings />;
		case "online":
			return <OnlineSourceSettings />;
		case "taskbarLyric":
			return <TaskbarLyricSettings />;
		case "about":
			return <AboutSettings />;
		default:
			return null;
	}
};
