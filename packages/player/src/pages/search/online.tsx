/**
 * Online search view.
 *
 * Shown instead of the library filter view when the app runs in online mode.
 * It reuses the page's look (back button + search field) and folds the results
 * into a plain table so the rows stay cheap to render.
 */
import { ArrowLeftIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import {
	Badge,
	Button,
	Card,
	ContextMenu,
	Container,
	Flex,
	Inset,
	Spinner,
	Text,
	TextField,
} from "@radix-ui/themes";
import { useAtomValue } from "jotai";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AppContainer } from "../../components/AppContainer/index.tsx";
import { queueManagerAtom } from "../../states/appAtoms.ts";
import { db, type Playlist, type Song } from "../../utils/db-client.ts";
import {
	type OnlineSong,
	fetchOnlineMeta,
	onlineSearch,
	prepareOnlineSong,
	setResolveObserver,
	toOnlinePath,
} from "../../utils/online-api.ts";

const COLUMNS = "36px minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 64px 72px";

function formatDuration(seconds: number): string {
	if (!seconds || seconds < 0) return "--:--";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const PLATFORM_LABEL: Record<string, string> = {
	kw: "酷我",
	kg: "酷狗",
	wy: "网易",
	tx: "QQ",
	mg: "咪咕",
};

export const OnlineSearchPage: FC = () => {
	const { t } = useTranslation();
	const [keyword, setKeyword] = useState("");
	const [songs, setSongs] = useState<OnlineSong[]>([]);
	const [loading, setLoading] = useState(false);
	const [resolving, setResolving] = useState("");
	const [message, setMessage] = useState("");
	const [searched, setSearched] = useState("");
	const [playlists, setPlaylists] = useState<Playlist[]>([]);
	const queueManager = useAtomValue(queueManagerAtom);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
		db.playlists.getAll().then(setPlaylists).catch(() => {});
	}, []);

	// Show which source actually resolved the song, so it is obvious whether a
	// custom source is being used or the built-in fallback kicked in.
	useEffect(() => {
		setResolveObserver((via) => {
			setMessage(t("page.online.via", "已通过「{via}」解析", { via }));
		});
		return () => setResolveObserver(null);
	}, [t]);

	const runSearch = useCallback(async (text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		setLoading(true);
		setMessage("");
		setSearched(trimmed);
		try {
			const result = await onlineSearch(trimmed);
			setSongs(result);
			if (result.length === 0) {
				setMessage(t("page.online.empty", "没有找到结果，换个关键词试试"));
			}
		} catch (err) {
			setSongs([]);
			setMessage(
				t("page.online.searchFailed", "搜索失败：{error}", {
					error: (err as Error)?.message ?? String(err),
				}),
			);
		} finally {
			setLoading(false);
		}
	}, [t]);

	const play = useCallback(
		async (song: OnlineSong) => {
			if (!queueManager) {
				setMessage(t("page.online.playerNotReady", "播放器尚未就绪，请稍后再试"));
				return;
			}
			setResolving(song.id);
			setMessage("");
			try {
				// Download once into the local cache, and grab lyrics/cover in
				// parallel so the player has something to show.
				const [path, meta] = await Promise.all([
					prepareOnlineSong(song),
					fetchOnlineMeta(song),
				]);
				const playable: Song = {
					id: `online-${song.source}-${song.id}`,
					filePath: path,
					songName: song.name,
					songArtists: song.singer,
					songAlbum: song.albumName,
					duration: song.interval,
					lyricFormat: "lrc",
					lyric: meta.lyric,
					translatedLrc: meta.translated || null,
					romanLrc: null,
					coverPath: meta.cover || null,
				};
				// The player reads lyrics back by song id, so keep a row for it.
				await db.songs.upsert([playable]).catch(() => {});
				queueManager.replaceQueueAndPlay(playable);
			} catch (err) {
				setMessage(
					t("page.online.playFailed", "无法播放：{error}", {
						error: (err as Error)?.message ?? String(err),
					}),
				);
			} finally {
				setResolving("");
			}
		},
		[queueManager, t],
	);

	const saveTo = useCallback(
		async (song: OnlineSong, playlistId: number) => {
			try {
				const meta = await fetchOnlineMeta(song);
				const stored: Song = {
					id: `online-${song.source}-${song.id}`,
					filePath: toOnlinePath(song),
					songName: song.name,
					songArtists: song.singer,
					songAlbum: song.albumName,
					duration: song.interval,
					lyricFormat: "lrc",
					lyric: meta.lyric,
					translatedLrc: meta.translated || null,
					romanLrc: null,
					coverPath: meta.cover || null,
				};
				await db.songs.upsert([stored]);
				await db.playlists.addSongs(playlistId, [stored.id]);
				setMessage(t("page.online.saved", "已收藏到歌单"));
			} catch (err) {
				setMessage(
					t("page.online.saveFailed", "收藏失败：{error}", {
						error: (err as Error)?.message ?? String(err),
					}),
				);
			}
		},
		[t],
	);

	return (
		<AppContainer>
			<Container mx="4">
				<Flex align="end" pt="6" justify="between">
					<Button variant="soft" onClick={() => history.back()}>
						<ArrowLeftIcon />
						<Trans i18nKey="common.page.back">返回</Trans>
					</Button>
					<Badge color="grass" radius="full">
						<Trans i18nKey="page.online.modeTag">在线模式</Trans>
					</Badge>
				</Flex>

				<TextField.Root
					placeholder={t("page.online.placeholder", "搜索在线歌曲，按回车开始……")}
					mt="2"
					value={keyword}
					onChange={(evt) => setKeyword(evt.target.value)}
					onKeyUp={(evt) => {
						if (evt.key === "Enter") void runSearch(keyword);
					}}
					ref={inputRef}
					size="3"
				>
					<TextField.Slot>
						<MagnifyingGlassIcon />
					</TextField.Slot>
				</TextField.Root>

				<Flex gap="2" align="center" mt="2">
					<Button variant="solid" disabled={loading} onClick={() => void runSearch(keyword)}>
						{loading ? <Spinner size="1" /> : <MagnifyingGlassIcon />}
						<Trans i18nKey="page.online.search">搜索</Trans>
					</Button>
					{searched && !loading ? (
						<Text size="2" color="gray">
							{t("page.online.resultCount", "找到 {count} 首", { count: songs.length })}
						</Text>
					) : null}
				</Flex>

				{message ? (
					<Text as="div" size="2" color="gray" mt="3">
						{message}
					</Text>
				) : null}

				{songs.length > 0 ? (
					<Card mt="3" style={{ overflow: "hidden" }}>
						<Inset>
							<Flex
								px="3"
								py="2"
								style={{
									display: "grid",
									gridTemplateColumns: COLUMNS,
									gap: 12,
									alignItems: "center",
									borderBottom: "1px solid var(--gray-a4)",
								}}
							>
								<Text size="1" color="gray">
									#
								</Text>
								<Text size="1" color="gray">
									<Trans i18nKey="page.online.column.name">歌曲名</Trans>
								</Text>
								<Text size="1" color="gray">
									<Trans i18nKey="page.online.column.singer">歌手</Trans>
								</Text>
								<Text size="1" color="gray">
									<Trans i18nKey="page.online.column.album">专辑</Trans>
								</Text>
								<Text size="1" color="gray">
									<Trans i18nKey="page.online.column.duration">时长</Trans>
								</Text>
								<Text size="1" color="gray">
									<Trans i18nKey="page.online.column.source">来源</Trans>
								</Text>
							</Flex>

							{songs.map((song, index) => (
								<ContextMenu.Root key={`${song.source}-${song.id}-${index}`}>
									<ContextMenu.Trigger>
										<Flex
											px="3"
											py="2"
											onDoubleClick={() => void play(song)}
											style={{
												display: "grid",
												gridTemplateColumns: COLUMNS,
												gap: 12,
												alignItems: "center",
												cursor: "pointer",
												borderBottom: "1px solid var(--gray-a3)",
											}}
										>
											<Text size="1" color="gray">
												{resolving === song.id ? <Spinner size="1" /> : index + 1}
											</Text>
											<Text size="2" truncate title={song.name}>
												{song.name}
											</Text>
											<Text size="2" color="gray" truncate title={song.singer}>
												{song.singer || "—"}
											</Text>
											<Text size="2" color="gray" truncate title={song.albumName}>
												{song.albumName || "—"}
											</Text>
											<Text size="2" color="gray">
												{formatDuration(song.interval)}
											</Text>
											<Badge size="1" variant="soft" radius="full">
												{PLATFORM_LABEL[song.source] ?? song.source}
											</Badge>
										</Flex>
									</ContextMenu.Trigger>
									<ContextMenu.Content>
										<ContextMenu.Item onSelect={() => void play(song)}>
											<Trans i18nKey="page.online.menu.play">播放</Trans>
										</ContextMenu.Item>
										<ContextMenu.Sub>
											<ContextMenu.SubTrigger>
												<Trans i18nKey="page.online.menu.save">收藏到歌单</Trans>
											</ContextMenu.SubTrigger>
											<ContextMenu.SubContent>
												{playlists.length === 0 ? (
													<ContextMenu.Item disabled>
														<Trans i18nKey="page.online.menu.noPlaylist">
															还没有歌单，请先创建一个
														</Trans>
													</ContextMenu.Item>
												) : (
													playlists.map((playlist) => (
														<ContextMenu.Item
															key={playlist.id}
															onSelect={() => void saveTo(song, playlist.id)}
														>
															{playlist.name}
														</ContextMenu.Item>
													))
												)}
											</ContextMenu.SubContent>
										</ContextMenu.Sub>
									</ContextMenu.Content>
								</ContextMenu.Root>
							))}
						</Inset>
					</Card>
				) : null}
			</Container>
		</AppContainer>
	);
};
