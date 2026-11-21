/**
 * Glue between the online search UI, the Rust backend and the imported
 * lx-music-desktop sources.
 *
 * Resolution order for a song is exactly the one LX uses: try the user's
 * enabled custom sources first (they may offer better quality or access a
 * platform we cannot reach directly), then fall back to the built-in direct
 * resolver. Custom sources are therefore an upgrade, never a single point of
 * failure.
 */
import { invoke } from "@tauri-apps/api/core";
import { getDefaultStore } from "jotai";
import { preferredQualityAtom } from "../states/appAtoms.ts";
import { LxSourceRuntime, type LxUpdateAlert } from "./lx-source-runtime.ts";
import { loadSources, type StoredSource } from "./online-sources.ts";

export type OnlinePlatform = "kw" | "kg" | "wy" | "tx" | "mg";

export interface OnlineSong {
	source: string;
	id: string;
	songmid: string;
	hash: string;
	name: string;
	singer: string;
	albumName: string;
	albumId: string;
	/** Seconds. */
	interval: number;
	coverUrl: string;
	qualitys: string[];
	extra?: Record<string, unknown> | null;
}

/** Platforms the built-in resolver can talk to without any custom source. */
const BUILTIN_PLATFORMS: OnlinePlatform[] = ["kw"];

/**
 * Platforms we search, matching LX's built-in musicSdk list (kw, kg, tx, wy,
 * mg). Playback no longer hides a platform just because one free source cannot
 * resolve a VIP/paid track: `prepareOnlineSong` already falls through to other
 * qualities, sources and the same track on other platforms.
 */
const SEARCHABLE: OnlinePlatform[] = ["kw", "kg", "tx", "wy", "mg"];

/** A song everyone has, used to check whether a source really works. */
const PROBE_SONG: OnlineSong = {
	source: "kw",
	id: "19534406",
	songmid: "19534406",
	hash: "",
	name: "光辉岁月",
	singer: "BEYOND",
	albumName: "命运派对",
	albumId: "9854508",
	interval: 302,
	coverUrl: "",
	qualitys: ["128k"],
};

const runtimes = new Map<string, LxSourceRuntime>();
const health = new Map<string, { ok: boolean; message: string }>();

/** Probe results survive a restart so the first search stays instant. */
const HEALTH_KEY = "amll-player.sourceHealth.v2";
const HEALTH_TTL = 24 * 60 * 60 * 1000;

function devLog(message: string): void {
	// Diagnostics land in the app log so failures can be traced after the fact.
	void invoke("dev_log", { message }).catch(() => {});
}

function loadPersistedHealth(): Map<string, { ok: boolean; message: string }> | null {
	try {
		const raw = localStorage.getItem(HEALTH_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as {
			at: number;
			items: Record<string, { ok: boolean; message: string }>;
		};
		if (Date.now() - parsed.at > HEALTH_TTL) return null;
		// Never trust a cached *failure*: a source blocked or offline earlier may
		// work now, and a stale "不可用" badge is exactly what confused the user.
		const items = Object.entries(parsed.items).filter(([, value]) => value.ok);
		return items.length > 0 ? new Map(items) : null;
	} catch {
		return null;
	}
}

function persistHealth(map: Map<string, { ok: boolean; message: string }>): void {
	try {
		// Only successes are cached. A source blocked by its own server (e.g.
		// "block ip") recovers on its own, and caching that failure for a day
		// would keep it marked broken long after it works again.
		const items: Record<string, { ok: boolean; message: string }> = {};
		for (const [id, value] of map) {
			if (value.ok) items[id] = value;
		}
		localStorage.setItem(HEALTH_KEY, JSON.stringify({ at: Date.now(), items }));
	} catch {
		// Storage full or disabled - the in-memory result still works.
	}
}

function runtimeFor(source: StoredSource): LxSourceRuntime {
	const cached = runtimes.get(source.id);
	if (cached) return cached;
	const runtime = new LxSourceRuntime(source.rawScript);
	runtimes.set(source.id, runtime);
	return runtime;
}

/** Initialise a source at most once per session. No network beyond its own init. */
const ready = new Map<string, boolean>();

async function ensureRuntimeReady(source: StoredSource): Promise<boolean> {
	const cached = ready.get(source.id);
	if (cached !== undefined) return cached;
	try {
		await runtimeFor(source).init(6000);
		ready.set(source.id, true);
		return true;
	} catch {
		ready.set(source.id, false);
		return false;
	}
}

/** Forget cached runtimes so a re-imported source is evaluated again. */
export function resetOnlineRuntimeCache(): void {
	runtimes.clear();
	health.clear();
	ready.clear();
	resolveFailures.clear();
	try {
		localStorage.removeItem("amll-player.sourceHealth");
	} catch {
		// ignore
	}
}

/**
 * Check every enabled source once per session. A source that cannot resolve a
 * well-known song is reported as unavailable and its platforms are left out of
 * the search, so the result list never shows rows that cannot be played.
 */
export async function ensureSourceHealth(force = false): Promise<Map<string, { ok: boolean; message: string }>> {
	if (!force) {
		if (health.size > 0) return health;
		const persisted = loadPersistedHealth();
		if (persisted) {
			persisted.forEach((value, key) => health.set(key, value));
			return health;
		}
	}

	const enabled = loadSources().filter((s) => s.enabled);
	health.clear();
	const verified = new Map<string, { ok: boolean; message: string }>();
	await Promise.all(
		enabled.map(async (source) => {
			const runtime = runtimeFor(source);
			try {
				// A broken source must not stall the first search: fail fast.
				await runtime.init(6000);
				const platforms = Object.keys(runtime.sources);
				let probe = "";
				// The resolve test is informational only. A source that loads is
				// usable even when this one song cannot be resolved (VIP tracks,
				// region limits); marking the whole source broken was wrong.
				if (platforms.includes(PROBE_SONG.source)) {
					try {
						await runtime.musicUrl(PROBE_SONG.source, toMusicInfo(PROBE_SONG), "128k");
						probe = "解析测试通过";
					} catch (err) {
						probe = `解析测试失败：${(err as Error)?.message ?? err}`;
					}
				}
				const entry = {
					ok: true,
					message: `已加载 ${platforms.join(" / ")}${probe ? `；${probe}` : ""}`,
				};
				health.set(source.id, entry);
				// Only a source that proved it can resolve is worth caching;
				// caching "loaded but broken" is what made the badge lie.
				if (probe === "解析测试通过") verified.set(source.id, entry);
				devLog(`health ${source.name}: ok platforms=${platforms.join(",")} ${probe}`);
			} catch (err) {
				const message = (err as Error)?.message ?? String(err);
				health.set(source.id, { ok: false, message });
				devLog(`health ${source.name}: FAILED ${message}`);
			}
		}),
	);
	persistHealth(verified);
	return health;
}

export function getSourceHealth(id: string) {
	return health.get(id);
}

/** Platforms worth searching: built-in ones plus those an enabled source declares. */
export async function platformsForSearch(): Promise<OnlinePlatform[]> {
	const result = new Set<OnlinePlatform>(BUILTIN_PLATFORMS);
	for (const source of loadSources()) {
		if (!source.enabled) continue;
		// Only the source's own initialisation is needed here - no probe request.
		// Probing on every search is what got us rate-limited ("block ip").
		if (!(await ensureRuntimeReady(source))) continue;
		for (const key of Object.keys(runtimeFor(source).sources)) {
			if (SEARCHABLE.includes(key as OnlinePlatform)) result.add(key as OnlinePlatform);
		}
	}
	return [...result];
}

export async function onlineSearch(keyword: string): Promise<OnlineSong[]> {
	const platforms = await platformsForSearch();
	return invoke<OnlineSong[]>("online_search", {
		keyword,
		platforms,
		limit: 40,
	});
}

/** LX formats durations as `m:ss`, not raw seconds. Sources depend on this. */
function formatPlayTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

const ALL_QUALITIES = ["128k", "320k", "flac", "flac24bit"];

/**
 * Build the `musicInfo` object a source receives.
 *
 * The shape is not cosmetic: every source reads specific fields (kw uses
 * `songmid`, kg uses `hash`, ...) and most of them refuse to resolve anything
 * when `types` / `_types` are missing. This mirrors what LX itself builds in
 * `musicSdk/<platform>/musicSearch.js`.
 */
export function toMusicInfo(song: OnlineSong): Record<string, unknown> {
	const types = ALL_QUALITIES.map((type) => ({ type, size: "" }));
	const typeMap: Record<string, { size: string }> = {};
	for (const type of ALL_QUALITIES) typeMap[type] = { size: "" };

	return {
		// Upstream record first so it can never override the canonical fields.
		...(song.extra ?? {}),
		name: song.name,
		singer: song.singer,
		source: song.source,
		songmid: song.songmid || song.id,
		songId: song.songmid || song.id,
		id: song.id,
		hash: song.hash || song.songmid || song.id,
		albumId: song.albumId,
		albumName: song.albumName,
		interval: formatPlayTime(song.interval),
		lrc: null,
		img: song.coverUrl || null,
		otherSource: null,
		types,
		_types: typeMap,
		typeUrl: {},
	};
}

function qualitiesFor(runtime: LxSourceRuntime, platform: string): string[] {
	const declared = runtime.sources[platform]?.qualitys ?? [];
	// Lossless tiers fail on most free sources, so the historical default is
	// 320k first. If the user picked a preferred quality, try it first whenever
	// the source declares it, then fall back to the safe order.
	const base = ["320k", "128k", "flac", "flac24bit"];
	let order = base;
	const pref = getDefaultStore().get(preferredQualityAtom);
	if (pref !== "auto") {
		order = [pref, ...base.filter((q) => q !== pref)];
	}
	const usable = order.filter((q) => declared.includes(q));
	return usable.length > 0 ? usable : ["128k"];
}

/** Which source actually resolved the last song - shown in the UI. */
type ResolveObserver = (via: string) => void;
let resolveObserver: ResolveObserver | null = null;

export function setResolveObserver(observer: ResolveObserver | null): void {
	resolveObserver = observer;
}

/** Coarse progress label for the UI while a song is being prepared. */
type PrepareObserver = (phase: string) => void;
let prepareObserver: PrepareObserver | null = null;

export function setPrepareObserver(observer: PrepareObserver | null): void {
	prepareObserver = observer;
}

/** Consecutive resolve failures per source, used to stop hammering dead ones. */
const resolveFailures = new Map<string, number>();
const MAX_RESOLVE_FAILURES = 2;

interface ResolveCandidate {
	url: string;
	via: string;
}

/**
 * Yield every URL this song can produce, best first: custom sources (each
 * supported quality) and then the built-in resolver.
 *
 * The old `resolvePlayUrl` returned the first URL that *parsed* successfully,
 * but a source can hand back a perfectly valid URL pointing at a 10-second
 * "当前音乐暂不支持播放" clip. Only the download layer can tell, so the caller
 * needs the candidate stream and must fall through when one is a stub.
 *
 * Being a generator matters for latency: playback tries the first URL as soon
 * as it is resolved instead of waiting for every source/quality probe first.
 */
async function* iterateResolveCandidates(
	song: OnlineSong,
	errors: string[],
): AsyncGenerator<ResolveCandidate> {
	for (const source of loadSources()) {
		if (!source.enabled) continue;
		if ((resolveFailures.get(source.id) ?? 0) >= MAX_RESOLVE_FAILURES) continue;
		const runtime = runtimeFor(source);
		try {
			if (!(await ensureRuntimeReady(source))) {
				errors.push(`${source.name}: 初始化失败`);
				continue;
			}
			if (!runtime.sources[song.source]) continue;
			const info = toMusicInfo(song);
			for (const quality of qualitiesFor(runtime, song.source)) {
				try {
					const url = await runtime.musicUrl(song.source, info, quality);
					resolveFailures.delete(source.id);
					devLog(`resolve ${song.source}/${song.id} ok via ${source.name}/${quality}`);
					yield { url, via: `${source.name}/${quality}` };
				} catch (err) {
					const message = (err as Error)?.message ?? String(err);
					errors.push(`${source.name}/${quality}: ${message}`);
					resolveFailures.set(source.id, (resolveFailures.get(source.id) ?? 0) + 1);
					devLog(`resolve ${song.source}/${song.id} fail via ${source.name}/${quality}: ${message}`);
				}
			}
		} catch (err) {
			const message = (err as Error)?.message ?? String(err);
			errors.push(`${source.name}: ${message}`);
			resolveFailures.set(source.id, (resolveFailures.get(source.id) ?? 0) + 1);
			devLog(`resolve ${song.source}/${song.id} source ${source.name} threw: ${message}`);
		}
	}

	try {
		const url = await invoke<string>("online_resolve", {
			platform: song.source,
			info: toMusicInfo(song),
			quality: "320k",
		});
		yield { url, via: "内置音源" };
	} catch (err) {
		errors.push(`内置音源: ${(err as Error)?.message ?? err}`);
	}
}

async function collectResolveCandidates(song: OnlineSong): Promise<ResolveCandidate[]> {
	const errors: string[] = [];
	const candidates: ResolveCandidate[] = [];
	for await (const candidate of iterateResolveCandidates(song, errors)) {
		candidates.push(candidate);
	}
	if (candidates.length === 0) {
		const detail = errors.length > 0 ? `（音源尝试：${errors.slice(0, 3).join("；")}）` : "";
		throw new Error(`没有可用的播放地址${detail}`);
	}
	return candidates;
}

/** Resolve a playable URL, custom sources first, built-in resolver last. */
export async function resolvePlayUrl(song: OnlineSong): Promise<string> {
	const candidates = await collectResolveCandidates(song);
	const first = candidates[0];
	resolveObserver?.(first.via.split("/")[0]);
	return first.url;
}

/** Download a source script from an http(s) link (uses the Rust proxy). */
export async function fetchSourceFromUrl(url: string): Promise<string> {
	const resp = await invoke<{ status: number; body: string }>("online_http", {
		req: { url, method: "GET", timeoutMs: 20000 },
	});
	if (resp.status >= 400) {
		throw new Error(`下载失败（HTTP ${resp.status}）`);
	}
	if (!resp.body.includes("globalThis.lx")) {
		throw new Error("该地址返回的内容不是洛雪音源脚本");
	}
	return resp.body;
}

//#region songs saved into playlists keep a resolvable pseudo path
const ONLINE_PREFIX = "online://";

/**
 * Playlists must survive URL expiry, so a saved online song stores the song
 * description instead of a signed URL and is resolved again on playback.
 */
export function toOnlinePath(song: OnlineSong): string {
	const payload = btoa(encodeURIComponent(JSON.stringify(song)));
	return `${ONLINE_PREFIX}${song.source}/${song.id}?d=${payload}`;
}

export function isOnlinePath(filePath: string): boolean {
	return filePath.startsWith(ONLINE_PREFIX);
}

export function parseOnlinePath(filePath: string): OnlineSong | null {
	if (!isOnlinePath(filePath)) return null;
	const raw = filePath.slice(ONLINE_PREFIX.length);
	const query = raw.indexOf("?d=");
	if (query < 0) return null;
	try {
		return JSON.parse(decodeURIComponent(atob(raw.slice(query + 3)))) as OnlineSong;
	} catch {
		return null;
	}
}

export async function resolveOnlinePath(filePath: string): Promise<string> {
	const song = parseOnlinePath(filePath);
	if (!song) throw new Error("在线歌曲信息已损坏，请重新收藏");
	return resolvePlayUrl(song);
}

//#endregion

//#region offline cache + metadata

export interface OnlineCacheUsage {
	bytes: number;
	files: number;
}

export async function getOnlineCacheUsage(): Promise<OnlineCacheUsage> {
	return invoke<OnlineCacheUsage>("online_cache_usage");
}

export async function clearOnlineCache(): Promise<OnlineCacheUsage> {
	return invoke<OnlineCacheUsage>("online_cache_clear");
}

/** Stable identity of an online song, usable as a cache key. */
function cacheKeyOf(song: OnlineSong): string {
	return `online://${song.source}/${song.id}`;
}

/** Rust flags stub audio with this marker so we can fall through to the next source. */
const STUB_AUDIO_MARKER = "__STUB_AUDIO__";

function isStubAudioError(err: unknown): boolean {
	return String((err as Error)?.message ?? err).includes(STUB_AUDIO_MARKER);
}

/**
 * LX's `filterStr`: drop whitespace and punctuation/brackets, keep the inner
 * version text ("Live" stays significant), then lowercase. Singer order is
 * normalised too, so "A / B" and "B、A" are the same track.
 */
function normalizeTrackText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[\s'.,，&"、()（）`~|<>\/\[\]!！-]/g, "");
}

function normalizeSinger(value: string): string {
	return value
		.split(/[、&;；/,，|]/)
		.map((part) => normalizeTrackText(part))
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b, "zh-CN"))
		.join("、");
}

function sameTrack(a: OnlineSong, b: OnlineSong): boolean {
	if (normalizeTrackText(a.name) !== normalizeTrackText(b.name)) return false;
	if (normalizeSinger(a.singer) !== normalizeSinger(b.singer)) return false;
	// LX tolerates a few seconds of difference between platform metadata.
	if (a.interval > 0 && b.interval > 0 && Math.abs(a.interval - b.interval) > 5) {
		return false;
	}
	return true;
}

/** Platforms to try when the original one only serves a trial clip. */
const FALLBACK_PLATFORM_ORDER: OnlinePlatform[] = ["kg", "kw", "mg", "wy", "tx"];

/**
 * When a platform serves only a 10-second trial clip, look for the same song
 * on another platform and try there. 晴天 on 酷我 (kw/228908) is exactly this
 * case: 酷狗 (kg) serves the full 4:29 file from the same exclusive source.
 */
async function findSameTrackElsewhere(song: OnlineSong): Promise<OnlineSong[]> {
	let results: OnlineSong[];
	try {
		results = await onlineSearch(`${song.name} ${song.singer}`.trim());
	} catch {
		return [];
	}
	return results
		.filter((candidate) => candidate.source !== song.source && sameTrack(candidate, song))
		.sort((a, b) => {
			const ai = FALLBACK_PLATFORM_ORDER.indexOf(a.source as OnlinePlatform);
			const bi = FALLBACK_PLATFORM_ORDER.indexOf(b.source as OnlinePlatform);
			return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
		})
		.slice(0, 6);
}

/**
 * Download a song once into the local cache, trying every candidate URL.
 * Falling through a stub clip to the next quality / source / platform is what
 * turns "晴天播放成 10 秒语音" into a real 4:29 playback.
 */
export async function prepareOnlineSong(song: OnlineSong): Promise<string> {
	const key = cacheKeyOf(song);
	const cached = await invoke<string | null>("online_cache_path", { key });
	if (cached) return cached;

	const tried = new Set<string>();
	const errors: string[] = [];

	const tryCandidates = async (target: OnlineSong, viaNote: string): Promise<string | null> => {
		let gotCandidate = false;
		for await (const candidate of iterateResolveCandidates(target, errors)) {
			if (!candidate.url || tried.has(candidate.url)) continue;
			tried.add(candidate.url);
			gotCandidate = true;
			prepareObserver?.("正在下载音频…");
			try {
				const path = await invoke<string>("online_cache_store", {
					key: cacheKeyOf(target),
					url: candidate.url,
				});
				const via = `${candidate.via}${viaNote}`;
				resolveObserver?.(via.split("/")[0]);
				devLog(`prepare ${song.source}/${song.id} ok via ${via}`);
				return path;
			} catch (err) {
				const message = (err as Error)?.message ?? String(err);
				errors.push(`${candidate.via}: ${message}`);
				devLog(`prepare ${song.source}/${song.id} candidate ${candidate.via} failed: ${message}`);
				if (isStubAudioError(err)) {
					// Trial clip - try the next candidate, do not abort.
					continue;
				}
			}
		}
		if (!gotCandidate && viaNote) errors.push(`${target.source}: 没有可用播放地址`);
		return null;
	};

	prepareObserver?.("正在解析音源…");
	const direct = await tryCandidates(song, "");
	if (direct) return direct;

	prepareObserver?.("正在查找其他平台…");
	const alternatives = await findSameTrackElsewhere(song);
	for (const alt of alternatives) {
		const altKey = cacheKeyOf(alt);
		const altCached = await invoke<string | null>("online_cache_path", { key: altKey });
		if (altCached) return altCached;
		const path = await tryCandidates(alt, `（${alt.source}同曲）`);
		if (path) return path;
	}

	throw new Error(`无法播放：所有音源均返回试听片段或解析失败（${errors.slice(0, 4).join("；")}）`);
}

/** Normalise whatever the queue holds into a path the decoder can open. */
export async function preparePlaybackPath(filePath: string): Promise<string> {
	if (isOnlinePath(filePath)) {
		const song = parseOnlinePath(filePath);
		if (!song) throw new Error("在线歌曲信息已损坏，请重新收藏");
		return prepareOnlineSong(song);
	}
	if (/^https?:\/\//.test(filePath)) {
		const key = `url://${filePath}`;
		const cached = await invoke<string | null>("online_cache_path", { key });
		if (cached) return cached;
		return invoke<string>("online_cache_store", { key, url: filePath });
	}
	return filePath;
}

/**
 * Best-effort background download. Used on search-row hover, when saving a
 * favourite and for the next song in the queue: a cache hit then makes the
 * actual double-click effectively instant. Never throws to the caller.
 */
const prefetching = new Set<string>();

export function prefetchOnlineSong(song: OnlineSong): void {
	const key = cacheKeyOf(song);
	if (prefetching.has(key)) return;
	prefetching.add(key);
	void invoke<string | null>("online_cache_path", { key })
		.then((cached) => (cached ? undefined : prepareOnlineSong(song)))
		.catch(() => {})
		.finally(() => prefetching.delete(key));
}

export function prefetchPlaybackPath(filePath: string): void {
	if (isOnlinePath(filePath)) {
		const song = parseOnlinePath(filePath);
		if (song) prefetchOnlineSong(song);
		return;
	}
	if (/^https?:\/\//.test(filePath)) {
		const key = `url://${filePath}`;
		void invoke<string | null>("online_cache_path", { key })
			.then((cached) =>
				cached
					? undefined
					: invoke<string>("online_cache_store", { key, url: filePath }),
			)
			.catch(() => {});
	}
}

/** LX treats a response without a timestamped line as "no lyric". */
function hasLyricLines(text: string): boolean {
	return /\[\d{1,2}:\d{1,2}(?:[.:]\d+)?\]/.test(text ?? "");
}

async function requestLyric(
	song: OnlineSong,
): Promise<{ lyric: string; translated: string }> {
	const res = await invoke<{ lyric: string; translated: string }>("online_lyric", {
		platform: song.source,
		id: song.songmid || song.id,
		name: song.name,
		singer: song.singer,
		duration: song.interval,
	});
	if (!hasLyricLines(res.lyric)) throw new Error("歌词内容无效");
	return res;
}

/**
 * Lyrics + cover for an online song.
 *
 * LX's default sources do not ship lyrics themselves: it asks the platform's
 * own lyric API, validates that the result really is a timed LRC, and when
 * that fails searches the same track on other platforms and retries there.
 * Mirror that fallback - a song with lyrics on any searched platform should
 * show them, while a genuinely lyric-less song simply stays empty.
 */
export async function fetchOnlineMeta(
	song: OnlineSong,
): Promise<{ lyric: string; translated: string; cover: string }> {
	let lyric = "";
	let translated = "";
	let cover = "";

	try {
		const res = await requestLyric(song);
		lyric = res.lyric;
		translated = res.translated;
	} catch {
		// Try other platforms below.
	}

	if (!lyric) {
		try {
			const alternatives = await onlineSearch(`${song.name} ${song.singer}`.trim());
			const others = alternatives
				.filter((candidate) => candidate.source !== song.source && sameTrack(candidate, song))
				.sort((a, b) => {
					const order: Record<string, number> = { kg: 0, kw: 1, mg: 2, wy: 3, tx: 4 };
					return (order[a.source] ?? 99) - (order[b.source] ?? 99);
				})
				.slice(0, 4);
			for (const alt of others) {
				try {
					const res = await requestLyric(alt);
					lyric = res.lyric;
					translated = res.translated;
					devLog(`lyric ${song.source}/${song.id} matched ${alt.source}/${alt.id}`);
					break;
				} catch {
					// Next candidate.
				}
			}
		} catch {
			// Search failed - keep playing without lyrics.
		}
	}

	try {
		const rawUrl = await invoke<string>("online_pic", {
			platform: song.source,
			id: song.songmid || song.id,
		});
		// Download the http cover into a local cache file - WebView blocks plain
		// http images as mixed content, which made every online cover black.
		if (rawUrl.startsWith("http")) {
			try {
				cover = await invoke<string>("online_cover_cache", { url: rawUrl });
			} catch {
				cover = rawUrl.replace(/^http:\/\//, "https://");
			}
		} else {
			cover = rawUrl;
		}
	} catch {
		// Fall back to the cover returned by search (already downloaded below).
		cover = song.coverUrl || "";
	}
	if (cover.startsWith("http")) {
		try {
			cover = await invoke<string>("online_cover_cache", { url: cover });
		} catch {
			// Keep the URL; the image component has an onError fallback.
		}
	}

	return { lyric, translated, cover };
}

//#endregion

//#region source update announcements

export interface SourceAnnouncement {
	sourceId: string;
	log: string;
	updateUrl: string;
}

const ANNOUNCEMENT_KEY = "amll-player.sourceAnnouncements.v1";
const ANNOUNCEMENT_DAY_KEY = "amll-player.sourceAnnouncementsDay.v1";

function todayStamp(): string {
	return new Date().toDateString();
}

/** Announcements cached from the last daily check (survives restarts). */
export function loadSourceAnnouncements(): Record<string, SourceAnnouncement> {
	try {
		const raw = localStorage.getItem(ANNOUNCEMENT_KEY);
		return raw ? (JSON.parse(raw) as Record<string, SourceAnnouncement>) : {};
	} catch {
		return {};
	}
}

function saveSourceAnnouncements(map: Record<string, SourceAnnouncement>): void {
	try {
		localStorage.setItem(ANNOUNCEMENT_KEY, JSON.stringify(map));
	} catch {
		// ignore
	}
}

/**
 * Check every enabled source for an `updateAlert` announcement, at most once
 * per calendar day (unless `force`). The script pushes the announcement during
 * initialisation, so this reuses the cached runtime. Never throws to callers.
 */
export async function checkSourceAnnouncements(
	force = false,
): Promise<Record<string, SourceAnnouncement>> {
	const today = todayStamp();
	if (!force) {
		try {
			if (localStorage.getItem(ANNOUNCEMENT_DAY_KEY) === today) {
				return loadSourceAnnouncements();
			}
		} catch {
			// ignore
		}
	}

	const result: Record<string, SourceAnnouncement> = {};
	for (const source of loadSources()) {
		if (!source.enabled) continue;
		try {
			if (!(await ensureRuntimeReady(source))) continue;
			const alert: LxUpdateAlert | null = runtimeFor(source).updateAlertInfo;
			const log = (alert?.log ?? "").toString().trim();
			const updateUrl = (alert?.updateUrl ?? "").toString().trim();
			if (log || updateUrl) {
				result[source.id] = { sourceId: source.id, log, updateUrl };
			}
		} catch {
			// A broken source simply has no announcement.
		}
	}
	saveSourceAnnouncements(result);
	try {
		localStorage.setItem(ANNOUNCEMENT_DAY_KEY, today);
	} catch {
		// ignore
	}
	return result;
}
