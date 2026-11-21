/**
 * Online search view.
 *
 * Layout mirrors LX's online search: a platform tab row, then one table per
 * platform with # / name / artist / album / duration columns and a quality
 * badge next to the title. The aggregate tab shows every platform section.
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
import {
	type FC,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { AppContainer } from "../../components/AppContainer/index.tsx";
import { queueManagerAtom } from "../../states/appAtoms.ts";
import { db, type Playlist, type Song } from "../../utils/db-client.ts";
import {
	type OnlineSong,
	fetchOnlineMeta,
	onlineSearch,
	prefetchOnlineSong,
	prepareOnlineSong,
	setPrepareObserver,
	setResolveObserver,
	toOnlinePath,
} from "../../utils/online-api.ts";

const COLUMNS = "36px minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 64px";

const PLATFORM_LABEL: Record<string, string> = {
	kg: "酷狗",
	kw: "酷我",
	wy: "网易",
	tx: "QQ",
	mg: "咪咕",
};

const PLATFORM_ORDER = ["kg", "kw", "wy", "mg", "tx"];

function formatDuration(seconds: number): string {
	if (!seconds || seconds < 0) return "--:--";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Same normalisation idea as LX's filterStr: ignore case, spaces and punctuation. */
function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[\s'.,，&"、()（）`~|<>\/\[\]!！-]/g, "");
}

/** Exact match first, then prefix, then containment - LX's rough ordering. */
function relevance(song: OnlineSong, keyword: string): number {
	const key = normalizeText(keyword);
	if (!key) return 0;
	const name = normalizeText(song.name);
	const singer = normalizeText(song.singer);
	let score = 0;
	if (name === key) score = 100;
	else if (name.startsWith(key)) score = 85;
	else if (name.includes(key)) score = 70;
	else if (singer === key) score = 60;
	else if (singer.includes(key)) score = 45;
	else if (normalizeText(`${song.name}${song.singer}`).includes(key)) score = 30;
	// LX searches with "name singer". Score the individual words too, so a
	// title-only hit does not outrank an exact title+artist hit.
	for (const token of keyword.trim().split(/\s+/).map(normalizeText)) {
		if (!token || token === key) continue;
		if (name.includes(token)) score += 20;
		if (singer.includes(token)) score += 20;
	}
	return score;
}

const QUALITY_RANK: Record<string, number> = {
	flac24bit: 4,
	flac: 3,
	"320k": 2,
	"128k": 1,
};

function qualityLabel(song: OnlineSong): string {
	const best = [...(song.qualitys ?? [])].sort(
		(a, b) => (QUALITY_RANK[b] ?? 0) - (QUALITY_RANK[a] ?? 0),
	)[0];
	switch (best) {
		case "flac24bit":
			return "24bit";
		case "flac":
			return "SQ";
		case "320k":
			return "HQ";
		default:
			return "";
	}
}

const songKeyOf = (song: OnlineSong) => `${song.source}::${song.id}`;

export const OnlineSearchPage: FC = () => {
	const { t } = useTranslation();
	const [keyword, setKeyword] = useState("");
	const [songs, setSongs] = useState<OnlineSong[]>([]);
	const [loading, setLoading] = useState(false);
	const [resolving, setResolving] = useState("");
	const [message, setMessage] = useState("");
	const [searched, setSearched] = useState("");
	const [platformFilter, setPlatformFilter] = useState("all");
	const [playlists, setPlaylists] = useState<Playlist[]>([]);
	const queueManager = useAtomValue(queueManagerAtom);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
		db.playlists.getAll().then(setPlaylists).catch(() => {});
	}, []);

	// Show which source actually resolved the song, and what step it is on.
	useEffect(() => {
		setResolveObserver((via) => {
			setMessage(t("page.online.via", "已通过「{via}」解析", { via }));
		});
		setPrepareObserver((phase) => setMessage(phase));
		return () => {
			setResolveObserver(null);
			setPrepareObserver(null);
		};
	}, [t]);

	const runSearch = useCallback(async (text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		setLoading(true);
		setMessage("");
		setSearched(trimmed);
		setPlatformFilter("all");
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

	const grouped = useMemo(() => {
		const map = new Map<string, OnlineSong[]>();
		for (const song of songs) {
			const list = map.get(song.source) ?? [];
			list.push(song);
			map.set(song.source, list);
		}
		for (const [source, list] of map) {
			const seen = new Set<string>();
			map.set(
				source,
				[...list]
					.sort(
						(a, b) =>
							relevance(b, searched) - relevance(a, searched) ||
							a.name.localeCompare(b.name),
					)
					.filter((song) => {
						const key = `${normalizeText(song.name)}|${normalizeText(song.singer)}`;
						if (seen.has(key)) return false;
						seen.add(key);
						return true;
					}),
			);
		}
		return map;
	}, [songs, searched]);

	const visibleSources = useMemo(
		() =>
			PLATFORM_ORDER.filter((source) => grouped.has(source)).concat(
				[...grouped.keys()].filter((source) => !PLATFORM_ORDER.includes(source)),
			),
		[grouped],
	);
	const shownSources =
		platformFilter === "all"
			? visibleSources
			: visibleSources.filter((source) => source === platformFilter);

	const play = useCallback(
		async (song: OnlineSong) => {
			if (!queueManager) {
				setMessage(t("page.online.playerNotReady", "播放器尚未就绪，请稍后再试"));
				return;
			}
			const key = songKeyOf(song);
			if (resolving) return;
			setResolving(key);
			setMessage(t("page.online.loading", "正在准备播放…"));
			try {
				// Audio first: lyrics and cover are fetched after playback starts
				// and written back through the db-row-changed event, so a slow
				// lyric server can no longer delay the first note.
				const path = await prepareOnlineSong(song);
				const playable: Song = {
					id: `online-${song.source}-${song.id}`,
					filePath: path,
					songName: song.name,
					songArtists: song.singer,
					songAlbum: song.albumName,
					duration: song.interval,
					lyricFormat: "lrc",
					lyric: "",
					translatedLrc: null,
					romanLrc: null,
					coverPath: song.coverUrl || null,
				};
				await db.songs.upsert([playable]).catch(() => {});
				queueManager.replaceQueueAndPlay(playable);

				void fetchOnlineMeta(song)
					.then((meta) =>
						db.songs.upsert([
							{
								...playable,
								lyric: meta.lyric,
								translatedLrc: meta.translated || null,
								coverPath: meta.cover || playable.coverPath,
							},
						]),
					)
					.catch(() => {});
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
		[queueManager, resolving, t],
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
				prefetchOnlineSong(song);
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
					<Button
						variant="solid"
						disabled={loading}
						onClick={() => void runSearch(keyword)}
					>
						{loading ? <Spinner size="1" /> : <MagnifyingGlassIcon />}
						<Trans i18nKey="page.online.search">搜索</Trans>
					</Button>
					{searched && !loading ? (
						<Text size="2" color="gray">
							{t("page.online.resultCount", "找到 {count} 首", {
								count: songs.length,
							})}
						</Text>
					) : null}
				</Flex>

				{songs.length > 0 ? (
					<Flex gap="2" align="center" wrap="wrap" mt="3">
						<Button
							size="1"
							variant={platformFilter === "all" ? "solid" : "soft"}
							onClick={() => setPlatformFilter("all")}
						>
							聚合大全
						</Button>
						{visibleSources.map((source) => (
							<Button
								key={source}
								size="1"
								variant={platformFilter === source ? "solid" : "soft"}
								onClick={() => setPlatformFilter(source)}
							>
								{PLATFORM_LABEL[source] ?? source}
							</Button>
						))}
					</Flex>
				) : null}

				{message ? (
					<Text as="div" size="2" color="gray" mt="3">
						{message}
					</Text>
				) : null}

				{shownSources.map((source) => {
					const list = grouped.get(source) ?? [];
					return (
						<Flex key={source} direction="column" mt="4" gap="1">
							<Flex align="center" gap="2">
								<Text size="2" weight="bold">
									{PLATFORM_LABEL[source] ?? source}
								</Text>
								<Badge size="1" variant="soft" radius="full">
									{list.length}
								</Badge>
							</Flex>
							<Card style={{ overflow: "hidden" }}>
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
										<Text size="1" color="gray">#</Text>
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
									</Flex>

									{list.map((song, index) => {
										const key = songKeyOf(song);
										const quality = qualityLabel(song);
										return (
											<ContextMenu.Root key={key}>
												<ContextMenu.Trigger>
													<Flex
														px="3"
														py="2"
														onDoubleClick={() => void play(song)}
														onMouseEnter={() => prefetchOnlineSong(song)}
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
															{resolving === key ? (
																<Spinner size="1" />
															) : (
																index + 1
															)}
														</Text>
														<Flex align="center" gap="2" minWidth="0">
															<Text size="2" truncate title={song.name}>
																{song.name}
															</Text>
															{quality ? (
																<Text size="1" color="grass">
																	{quality}
																</Text>
															) : null}
														</Flex>
														<Text
															size="2"
															color="gray"
															truncate
															title={song.singer}
														>
															{song.singer || "—"}
														</Text>
														<Text
															size="2"
															color="gray"
															truncate
															title={song.albumName}
														>
															{song.albumName || "—"}
														</Text>
														<Text size="2" color="gray">
															{formatDuration(song.interval)}
														</Text>
													</Flex>
												</ContextMenu.Trigger>
												<ContextMenu.Content>
													<ContextMenu.Item
														onSelect={() => void play(song)}
													>
														<Trans i18nKey="page.online.menu.play">播放</Trans>
													</ContextMenu.Item>
													<ContextMenu.Sub>
														<ContextMenu.SubTrigger>
															<Trans i18nKey="page.online.menu.save">
																收藏到歌单
															</Trans>
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
																		onSelect={() =>
																			void saveTo(song, playlist.id)
																		}
																	>
																		{playlist.name}
																	</ContextMenu.Item>
																))
															)}
														</ContextMenu.SubContent>
													</ContextMenu.Sub>
												</ContextMenu.Content>
											</ContextMenu.Root>
										);
									})}
								</Inset>
							</Card>
						</Flex>
					);
				})}
			</Container>
		</AppContainer>
	);
};
