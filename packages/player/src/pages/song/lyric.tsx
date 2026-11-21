import { Button, Callout, Flex, Select, Text, TextArea } from "@radix-ui/themes";
import { useAtom } from "jotai";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import { readTextFile } from "@tauri-apps/plugin-fs";
import {
	type FC,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { ExtensionInjectPoint } from "../../components/ExtensionInjectPoint/index.tsx";
import { TTMLImportDialog } from "../../components/TTMLImportDialog/index.tsx";
import { swapLyricMainTranslationAtom } from "../../states/appAtoms.ts";
import { db } from "../../utils/db-client.ts";
import { getLyricFormatFromExtension, Option } from "./common.tsx";
import { SongContext } from "./song-ctx.ts";

export const LyricTabContent: FC = () => {
	const song = useContext(SongContext);
	const [lyricFormat, setLyricFormat] = useState("none");
	const [lyricContent, setLyricContent] = useState("");
	const [translatedLyricContent, setTranslatedLyricContent] = useState("");
	const [romanLyricContent, setRomanLyricContent] = useState("");
	const [lyricOffsetMs, setLyricOffsetMs] = useState(0);
	const [swapMainTranslation, setSwapMainTranslation] = useAtom(
		swapLyricMainTranslationAtom,
	);
	const { t } = useTranslation();

	useLayoutEffect(() => {
		if (song) {
			setLyricFormat(song.lyricFormat);
			setLyricContent(song.lyric);
			setTranslatedLyricContent(song.translatedLrc ?? "");
			setRomanLyricContent(song.romanLrc ?? "");
			setLyricOffsetMs(song.lyricOffsetMs ?? 0);
		} else {
			setLyricFormat("none");
			setLyricContent("");
			setTranslatedLyricContent("");
			setRomanLyricContent("");
			setLyricOffsetMs(0);
		}
	}, [song]);

	useEffect(() => {
		const unlistenDrop = listen<{ paths: string[] }>(
			TauriEvent.DRAG_DROP,
			async (event) => {
				const path = event.payload.paths[0];
				if (!path) return;
				const format = getLyricFormatFromExtension(path);
				if (!format) return;
				try {
					const content = await readTextFile(path);
					setLyricFormat(format);
					setLyricContent(content);
					if (format === "ttml") {
						setTranslatedLyricContent("");
						setRomanLyricContent("");
					}
				} catch (e) {
					console.error("Failed to read lyric file:", e);
				}
			},
		);
		return () => {
			unlistenDrop.then((u) => u());
		};
	}, []);

	const importFromFile = useCallback((file: File) => {
		const format = getLyricFormatFromExtension(file.name);
		if (!format) return;
		const reader = new FileReader();
		reader.onload = () => {
			const content = reader.result as string;
			setLyricFormat(format);
			setLyricContent(content);
			if (format === "ttml") {
				setTranslatedLyricContent("");
				setRomanLyricContent("");
			}
		};
		reader.readAsText(file);
	}, []);

	const openLocalLyricFile = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".lrc,.eslrc,.yrc,.qrc,.lys,.ttml";
		input.onchange = () => {
			const file = input.files?.[0];
			if (file) importFromFile(file);
		};
		input.click();
	}, [importFromFile]);

	const saveData = useCallback(
		async (
			saveLyricFormat: string,
			saveLyricContent: string,
			saveTranslatedLyricContent: string,
			saveRomanLyricContent: string,
			saveLyricOffsetMs = lyricOffsetMs,
		) => {
			if (song === undefined) return;
			if (saveLyricFormat === "none") {
				await db.songs.update(song.id, {
					lyricFormat: "none",
					lyric: "",
					translatedLrc: "",
					romanLrc: "",
					lyricOffsetMs: 0,
				});
				setLyricFormat("none");
				setLyricContent("");
				setTranslatedLyricContent("");
				setRomanLyricContent("");
				setLyricOffsetMs(0);
				return;
			}
			if (saveLyricFormat === "ttml") {
				await db.songs.update(song.id, {
					lyricFormat: "ttml",
					lyric: saveLyricContent,
					translatedLrc: "",
					romanLrc: "",
					lyricOffsetMs: saveLyricOffsetMs,
				});
				setLyricFormat("ttml");
				setLyricContent(saveLyricContent);
				setTranslatedLyricContent("");
				setRomanLyricContent("");
				setLyricOffsetMs(saveLyricOffsetMs);
				return;
			}
			await db.songs.update(song.id, {
				lyricFormat: saveLyricFormat,
				lyric: saveLyricContent,
				translatedLrc: saveTranslatedLyricContent,
				romanLrc: saveRomanLyricContent,
				lyricOffsetMs: saveLyricOffsetMs,
			});
			setLyricFormat(saveLyricFormat);
			setLyricContent(saveLyricContent);
			setTranslatedLyricContent(saveTranslatedLyricContent);
			setRomanLyricContent(saveRomanLyricContent);
			setLyricOffsetMs(saveLyricOffsetMs);
		},
		[song, lyricOffsetMs],
	);

	return (
		<div>
			<ExtensionInjectPoint injectPointName="page.song.tab.lyric.before" />
			<Flex direction="column" gap="4">
				<Option label={t("page.song.lyric.lyricFormatLabel", "歌词格式")}>
					<Select.Root
						defaultValue="none"
						value={lyricFormat}
						onValueChange={(v) => setLyricFormat(v)}
					>
						<Select.Trigger />
						<Select.Content>
							<Select.Item value="none">
								<Trans i18nKey="page.song.lyric.lyricFormat.none">无歌词</Trans>
							</Select.Item>
							<Select.Item value="lrc">
								<Trans i18nKey="page.song.lyric.lyricFormat.lrc">
									LyRiC 歌词
								</Trans>
							</Select.Item>
							<Select.Item value="eslrc">
								<Trans i18nKey="page.song.lyric.lyricFormat.eslrc">
									ESLyRiC 歌词
								</Trans>
							</Select.Item>
							<Select.Item value="yrc">
								<Trans i18nKey="page.song.lyric.lyricFormat.yrc">
									YRC 歌词
								</Trans>
							</Select.Item>
							<Select.Item value="qrc">
								<Trans i18nKey="page.song.lyric.lyricFormat.qrc">
									QRC 歌词
								</Trans>
							</Select.Item>
							<Select.Item value="lys">
								<Trans i18nKey="page.song.lyric.lyricFormat.lys">
									Lyricify Syllable 歌词
								</Trans>
							</Select.Item>
							<Select.Item value="ttml">
								<Trans i18nKey="page.song.lyric.lyricFormat.ttml">
									TTML 歌词
								</Trans>
							</Select.Item>
						</Select.Content>
					</Select.Root>
				</Option>
				<Option label={t("page.song.lyric.offsetLabel", "歌词偏移（毫秒）")}>
					<Flex align="center" gap="2" wrap="wrap">
						<Text size="2" color="gray">
							{lyricOffsetMs > 0 ? `+${lyricOffsetMs}` : lyricOffsetMs} ms
						</Text>
						{[-500, -100, 100, 500].map((delta) => (
							<Button
								key={delta}
								size="1"
								variant="soft"
								onClick={() => setLyricOffsetMs((value) => value + delta)}
							>
								{delta > 0 ? "+" : ""}
								{delta / 1000}s
							</Button>
						))}
						<Button
							size="1"
							variant="ghost"
							onClick={() => setLyricOffsetMs(0)}
						>
							<Trans i18nKey="common.reset">重置</Trans>
						</Button>
						{/* Display-only toggle: never rewrites the lyric data. It only
						    swaps which text AMLL renders as the main line vs the
						    translation sub-line while playing. */}
						<Button
							size="1"
							variant={swapMainTranslation ? "solid" : "soft"}
							color={swapMainTranslation ? "iris" : "gray"}
							onClick={() => setSwapMainTranslation((value) => !value)}
						>
							<Trans i18nKey="page.song.lyric.swapMainTranslation">
								主译互换
							</Trans>
							{swapMainTranslation ? " · 开" : " · 关"}
						</Button>
					</Flex>
				</Option>
				{lyricFormat !== "none" && lyricFormat.length > 0 && (
					<>
						<Option label={t("page.song.lyric.lyricData", "歌词数据")}>
							<TextArea
								value={lyricContent}
								style={{
									minHeight: "10rem",
								}}
								onChange={(v) => setLyricContent(v.currentTarget.value)}
							/>
						</Option>

						{lyricFormat === "ttml" ? (
							<Callout.Root>
								<Callout.Text>
									<Trans i18nKey="page.song.lyric.ttmlLyricTip">
										TTML 歌词可同时包含翻译与音译数据。
									</Trans>
								</Callout.Text>
							</Callout.Root>
					) : (
						<>
							{/* The translation data editor is intentionally gone.
							    "主译互换" is a pure playback-display toggle next to
							    the offset controls above; it never edits or rewrites
							    the stored lyric/translation text. */}
							<Option label="音译歌词数据">
								<Callout.Root>
									<Callout.Text>
										<Trans i18nKey="page.song.lyric.romanLyricDataTip">
											请提供 LyRiC
											格式的歌词数据，将会根据时间戳与一致或靠近的原文歌词配对成为音译
										</Trans>
									</Callout.Text>
								</Callout.Root>
								<TextArea
									value={romanLyricContent}
									style={{
										minHeight: "10rem",
									}}
									onChange={(v) =>
										setRomanLyricContent(v.currentTarget.value)
									}
								/>
							</Option>
							</>
						)}
					</>
				)}
				<TTMLImportDialog
					defaultValue={song ? `${song.songName}` : ""}
					onSelectedLyric={(ttmlContent) => {
						saveData("ttml", ttmlContent, "", "");
					}}
				/>
				<Button variant="soft" onClick={openLocalLyricFile}>
					<Trans i18nKey="page.song.lyric.importFromFile">
						从本地文件导入歌词
					</Trans>
				</Button>
			</Flex>
			<Button
				mt="4"
				onClick={() =>
					saveData(
						lyricFormat,
						lyricContent,
						translatedLyricContent,
						romanLyricContent,
					)
				}
			>
				<Trans i18nKey="common.dialog.save">保存</Trans>
			</Button>
			<ExtensionInjectPoint injectPointName="page.song.tab.lyric.after" />
		</div>
	);
};
