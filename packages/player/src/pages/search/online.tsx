/**
 * Online search view.
 *
 * Layout mirrors LX's online search: a platform tab row and ONE flat result
 * table. The aggregate tab merges every platform into a single list (with a
 * source badge per row) instead of one section per platform - that is exactly
 * what LX's `all` tab does. Ranking uses LX's `similar()` edit-distance score
 * plus a stable insertion sort, so the same keyword on the same platform yields
 * the same content in the same order.
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
	fetchOnlineCover,
	fetchOnlineLyric,
	fetchOnlineMeta,
	onlineSearch,
	prepareOnlineSong,
	setPrepareObserver,
	setResolveObserver,
	toOnlinePath,
} from "../../utils/online-api.ts";

const COLUMNS = "36px minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 64px";

/** Never block playback on a slow cover CDN; a later DB update fills it in. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			},
		);
	});
}

const PLATFORM_LABEL: Record<string, string> = {
	kw: "酷我",
	kg: "酷狗",
	tx: "QQ",
	wy: "网易",
	mg: "咪咕",
};

/**
 * Default platform order: aggregate first (rendered separately below), then
 * QQ, Kugou, NetEase, Kuwo, Migu. Kept in one place so the tab row order and
 * the search request order can never drift apart.
 */
const PLATFORM_ORDER = ["tx", "kg", "wy", "kw", "mg"];

function formatDuration(seconds: number): string {
	if (!seconds || seconds < 0) return "--:--";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * LX's `similar()`: 1 - Levenshtein(a, b) / max(len(a), len(b)).
 * Copied verbatim from `src/common/utils/common.ts` so ranking matches LX.
 */
function similar(a: string, b: string): number {
	if (!a || !b) return 0;
	if (a.length > b.length) {
		const tmp = a;
		a = b;
		b = tmp;
	}
	const al = a.length;
	const bl = b.length;
	let mp = new Array<number>(bl + 1);
	for (let i = 0; i <= bl; i++) mp[i] = i;
	for (let i = 1; i <= al; i++) {
		const ai = a.charAt(i - 1);
		let lt = mp[0];
		mp[0] = mp[0] + 1;
		for (let j = 1; j <= bl; j++) {
			const tmp = Math.min(
				mp[j] + 1,
				mp[j - 1] + 1,
				lt + (ai === b.charAt(j - 1) ? 0 : 1),
			);
			lt = mp[j];
			mp[j] = tmp;
		}
	}
	return bl === 0 ? 0 : 1 - mp[bl] / bl;
}

/** LX's `sortInsert`: stable insertion into an ascending-by-num array. */
function sortInsert<T>(arr: { num: number; data: T }[], data: { num: number; data: T }): void {
	let left = 0;
	let right = arr.length;
	while (left < right) {
		const mid = (left + right) >> 1;
		if (arr[mid].num < data.num) left = mid + 1;
		else right = mid;
	}
	arr.splice(left, 0, data);
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

const SEARCH_HISTORY_KEY = "amll-player.onlineSearchHistory";
const SEARCH_HISTORY_MAX = 10;

function loadSearchHistory(): string[] {
	try {
		const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, SEARCH_HISTORY_MAX) : [];
	} catch {
		return [];
	}
}

function pushSearchHistory(term: string): string[] {
	const next = [term, ...loadSearchHistory().filter((item) => item !== term)].slice(0, SEARCH_HISTORY_MAX);
	try {
		localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
	} catch {
		// Storage unavailable - history still works for this session.
	}
	return next;
}

export const OnlineSearchPage: FC = () => {
	const { t } = useTranslation();
	const [keyword, setKeyword] = useState("");
	const [songs, setSongs] = useState<OnlineSong[]>([]);
	const [loading, setLoading] = useState(false);
	const [resolving, setResolving] = useState("");
	const [message, setMessage] = useState("");
	const [searched, setSearched] = useState("");
	const [platformFilter, setPlatformFilter] = useState("all");
	const [searchHistory, setSearchHistory] = useState<string[]>(() => loadSearchHistory());
	const [playlists, setPlaylists] = useState<Playlist[]>([]);
	const queueManager = useAtomValue(queueManagerAtom);
	const inputRef = useRef<HTMLInputElement>(null);
	// Synchronous guards: React state updates are async, so a fast double-click
	// can otherwise start two plays and leave the loading text stuck forever.
	const resolvingRef = useRef("");
	const playSeqRef = useRef(0);

	useEffect(() => {
		inputRef.current?.focus();
		db.playlists.getAll().then(setPlaylists).catch(() => {});
	}, []);

	// Show which source actually resolved the song, and what step it is on.
	useEffect(() => {
		setResolveObserver((via) => {
			// Never overwrite a settled UI with a late observer callback from a
			// previous play - that was one cause of the stuck "正在准备播放".
			if (resolvingRef.current) {
				setMessage(t("page.online.via", "已通过「{via}」解析", { via }));
			}
		});
		setPrepareObserver((phase) => {
			if (resolvingRef.current) setMessage(phase);
		});
		return () => {
			setResolveObserver(null);
			setPrepareObserver(null);
		};
	}, [t]);

	const runSearch = useCallback(async (text: string) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		setKeyword(trimmed);
		setSearchHistory(pushSearchHistory(trimmed));
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

	/**
	 * LX's aggregate: dedupe by song id, then rank the WHOLE list by
	 * similar(keyword, name + ' ' + singer) using a stable ascending insertion
	 * followed by a reverse - no per-platform grouping.
	 */
	const visibleSongs = useMemo(() => {
		const seen = new Set<string>();
		const unique = songs.filter((song) => {
			if (seen.has(song.id)) return false;
			seen.add(song.id);
			return true;
		});
		const ranked: { num: number; data: OnlineSong }[] = [];
		for (const song of unique) {
			const num = similar(searched, `${song.name} ${song.singer}`);
			sortInsert(ranked, { num, data: song });
		}
		return ranked.reverse().map((item) => item.data);
	}, [songs, searched]);

	const shownSongs = useMemo(
		() =>
			platformFilter === "all"
				? visibleSongs
				: visibleSongs.filter((song) => song.source === platformFilter),
		[visibleSongs, platformFilter],
	);

	/**
	 * LX keeps all five built-in platform tabs visible even when a platform
	 * returns zero rows for the current keyword. Deriving tabs from the result
	 * set made them appear/disappear at random; keep the fixed order and only
	 * append a tab if a third-party source reports an extra platform.
	 */
	const visibleSources = useMemo(() => {
		const extra = [...new Set(visibleSongs.map((song) => song.source))].filter(
			(source) => !PLATFORM_ORDER.includes(source),
		);
		return [...PLATFORM_ORDER, ...extra];
	}, [visibleSongs]);

	const play = useCallback(
		async (song: OnlineSong) => {
			if (!queueManager) {
				setMessage(t("page.online.playerNotReady", "播放器尚未就绪，请稍后再试"));
				return;
			}
			const key = songKeyOf(song);
			// Synchronous mutex: a second double-click on a song already being
			// prepared (or already playing from cache) must not spawn another
			// preparation, which previously left the loading text stuck.
			if (resolvingRef.current) return;
			resolvingRef.current = key;
			const seq = ++playSeqRef.current;
			setResolving(key);
			setMessage(t("page.online.loading", "正在准备播放…"));
			try {
				// Start the artwork download at the same time as the audio. The
				// search row already carries the exact cover URL, so there is no
				// reason to wait for lyrics/cross-platform lookups first.
				const coverPromise = fetchOnlineCover(song).catch(() => "");
				const path = await prepareOnlineSong(song);
				// A faster click on another song wins; ignore this stale result.
				if (seq !== playSeqRef.current) return;
				// A short grace period lets the cached cover be in the very first
				// metadata sync. A slow CDN must never delay playback; the
				// background write below still updates the player.
				const quickCover = await withTimeout(coverPromise, 1500, "");
				const playable: Song = {
					id: `online-${song.source}-${song.id}`,
					// Keep the resolvable pseudo path in the DB. Writing the real
					// cache path here broke favourites after the cache was cleared:
					// they were treated as local files and silently failed to load.
					filePath: toOnlinePath(song),
					songName: song.name,
					songArtists: song.singer,
					songAlbum: song.albumName,
					duration: song.interval,
					lyricFormat: "lrc",
					lyric: "",
					translatedLrc: null,
					romanLrc: null,
					coverPath: quickCover || null,
				};
				await db.songs.upsert([playable]).catch(() => {});
				queueManager.replaceQueueAndPlay({ ...playable, filePath: path });

				// Late cover completion still reaches the player via the
				// db-row-changed listener in LocalMusicContext.
				void coverPromise.then((cover) => {
					if (!cover || cover === quickCover || seq !== playSeqRef.current) return;
					void db.songs.update(playable.id, { coverPath: cover }).catch(() => {});
				});
				void fetchOnlineLyric(song)
					.then(({ lyric, translated }) => {
						if (seq !== playSeqRef.current) return;
						return db.songs.update(playable.id, {
							lyric,
							translatedLrc: translated || null,
						});
					})
					.catch(() => {});
				// Playback has started - clear the "正在准备播放" state immediately.
				if (seq === playSeqRef.current) setMessage("");
			} catch (err) {
				if (seq === playSeqRef.current) {
					setMessage(
						t("page.online.playFailed", "无法播放：{error}", {
							error: (err as Error)?.message ?? String(err),
						}),
					);
				}
			} finally {
				if (seq === playSeqRef.current) {
					resolvingRef.current = "";
					setResolving("");
				}
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

				{searchHistory.length > 0 ? (
					<Flex gap="2" align="center" wrap="wrap" mt="2">
						<Text size="1" color="gray">
							{t("page.online.searchHistory", "搜索历史")}
						</Text>
						{searchHistory.map((term) => (
							<Button
								key={term}
								size="1"
								variant="soft"
								color="gray"
								onClick={() => void runSearch(term)}
							>
								{term}
							</Button>
						))}
					</Flex>
				) : null}

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

				{visibleSources.length > 1 ? (
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

				{shownSongs.length > 0 ? (
					<Flex direction="column" mt="4" gap="1">
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

								{shownSongs.map((song, index) => {
									const key = songKeyOf(song);
									const quality = qualityLabel(song);
									return (
										<ContextMenu.Root key={key}>
											<ContextMenu.Trigger>
												<Flex
													px="3"
													py="2"
													onDoubleClick={() => void play(song)}
													// No hover prefetch: only an actual play
													// (or the last-15s next-song prefetch) downloads.
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
														{platformFilter === "all" ? (
															<Badge size="1" variant="soft" radius="full" color="gray">
																{PLATFORM_LABEL[song.source] ?? song.source}
															</Badge>
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
				) : null}
			</Container>
		</AppContainer>
	);
};
