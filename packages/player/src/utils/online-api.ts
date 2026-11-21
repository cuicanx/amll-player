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

/**
 * Platforms we search, in the app's default order: QQ, Kugou, NetEase, Kuwo,
 * Migu (the aggregate tab is built by the UI on top of these). Playback no
 * longer hides a platform just because one free source cannot resolve a
 * VIP/paid track: `prepareOnlineSong` already falls through to other qualities,
 * sources and the same track on other platforms.
 */
const SEARCHABLE: OnlinePlatform[] = ["tx", "kg", "wy", "kw", "mg"];

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

/**
 * Initialise a source at most once per session. No network beyond its own init.
 *
 * Heavy obfuscated sources (the user's 58 KB V7 script) can take well over 6 s
 * to evaluate and emit `inited`; the old 6 s budget marked them permanently
 * dead, which is why NetEase/Migu songs reported "all sources failed" even
 * though the source works in LX. 15 s matches LX's own tolerance. A failed
 * init is NOT cached - a slow device or a cold WebView can succeed on retry.
 */
const ready = new Map<string, boolean>();
const INIT_TIMEOUT_MS = 15_000;

async function ensureRuntimeReady(source: StoredSource): Promise<boolean> {
	if (ready.get(source.id) === true) return true;
	try {
		await runtimeFor(source).init(INIT_TIMEOUT_MS);
		ready.set(source.id, true);
		return true;
	} catch {
		// Do not cache failure: allow a later resolve attempt to re-initialise.
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
				// Heavy obfuscated sources need more than a few seconds to emit
				// `inited`; too short a budget made working sources look broken.
				await runtime.init(INIT_TIMEOUT_MS);
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

/**
 * Platforms worth searching.
 *
 * Search is served by Rust's built-in platform APIs, so it must never wait for
 * a custom source to initialise. The old implementation awaited each source in
 * turn (up to 6 s each) and then only searched the platforms that happened to
 * be declared by a loaded source - that was both slow and the reason the tab
 * row changed from run to run. LX always searches its full built-in platform
 * set, so we do the same here.
 */
export function platformsForSearch(): OnlinePlatform[] {
	return [...SEARCHABLE];
}

export async function onlineSearch(keyword: string): Promise<OnlineSong[]> {
	return invoke<OnlineSong[]>("online_search", {
		keyword,
		platforms: platformsForSearch(),
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
const RESOLVE_TIMEOUT_MS = 10_000;

interface ResolveTask {
	via: string;
	run: () => Promise<string>;
}

interface ResolveSettled {
	id: number;
	ok: boolean;
	via: string;
	value?: string;
	error?: unknown;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} 解析超时`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Start every candidate at once and hand them back in completion order.
 * Returning from `next()` does not cancel the other HTTP requests (the WebView
 * cannot abort a Rust request), but they are ignored, so a slow source never
 * delays playback after a fast one has already succeeded.
 */
function createResolveQueue(tasks: ResolveTask[]) {
	const pending = new Map<number, Promise<ResolveSettled>>();
	tasks.forEach((task, id) => {
		const settled = task.run().then<ResolveSettled>(
			(value) => ({ id, ok: true, via: task.via, value }),
			(error) => ({ id, ok: false, via: task.via, error }),
		);
		pending.set(id, settled);
	});
	return {
		async next(): Promise<ResolveSettled | null> {
			if (pending.size === 0) return null;
			const result = await Promise.race([...pending.values()]);
			pending.delete(result.id);
			return result;
		},
	};
}

/**
 * Fan out ALL usable sources (and every quality each source declares) plus the
 * built-in resolver. The old generator tried them one by one, so one hanging
 * API held up the whole song. Each source is counted as failed only once - and
 * only after every one of its qualities failed - otherwise the second failed
 * quality permanently blacklisted an otherwise working source.
 */
async function buildResolveTasks(song: OnlineSong, errors: string[]): Promise<ResolveTask[]> {
	const enabled = loadSources().filter(
		(source) =>
			source.enabled && (resolveFailures.get(source.id) ?? 0) < MAX_RESOLVE_FAILURES,
	);
	// Initialise in parallel as well: a dead source must not serialize the rest.
	await Promise.all(enabled.map((source) => ensureRuntimeReady(source)));

	const tasks: ResolveTask[] = [];
	for (const source of enabled) {
		if (!ready.get(source.id)) {
			errors.push(`${source.name}: 初始化失败`);
			continue;
		}
		const runtime = runtimeFor(source);
		if (!runtime.sources[song.source]) continue;
		const qualities = qualitiesFor(runtime, song.source);
		const group = { remaining: qualities.length, succeeded: false, id: source.id };
		for (const quality of qualities) {
			tasks.push({
				via: `${source.name}/${quality}`,
				run: async () => {
					try {
						const url = await withTimeout(
							runtime.musicUrl(song.source, toMusicInfo(song), quality),
							RESOLVE_TIMEOUT_MS,
							source.name,
						);
						if (!url) throw new Error("音源返回了空地址");
						group.succeeded = true;
						resolveFailures.delete(source.id);
						devLog(`resolve ${song.source}/${song.id} ok via ${source.name}/${quality}`);
						return url;
					} catch (err) {
						const message = (err as Error)?.message ?? String(err);
						errors.push(`${source.name}/${quality}: ${message}`);
						devLog(
							`resolve ${song.source}/${song.id} fail via ${source.name}/${quality}: ${message}`,
						);
						group.remaining -= 1;
						if (group.remaining === 0 && !group.succeeded) {
							resolveFailures.set(source.id, (resolveFailures.get(source.id) ?? 0) + 1);
						}
						throw err;
					}
				},
			});
		}
	}

	for (const quality of ["320k", "128k"]) {
		tasks.push({
			via: `内置音源/${quality}`,
			run: async () => {
				try {
					const url = await withTimeout(
						invoke<string>("online_resolve", {
							platform: song.source,
							info: toMusicInfo(song),
							quality,
						}),
						RESOLVE_TIMEOUT_MS,
						"内置音源",
					);
					devLog(`resolve ${song.source}/${song.id} ok via 内置音源/${quality}`);
					return url;
				} catch (err) {
					errors.push(
						`内置音源/${quality}: ${(err as Error)?.message ?? String(err)}`,
					);
					throw err;
				}
			},
		});
	}

	return tasks;
}

function resolveErrorText(errors: string[]): string {
	// The old text blamed "内置音源暂不支持平台" for every Migu/NetEase
	// failure, because the built-in resolver only supports Kuwo. That message
	// is misleading: custom sources are the normal path for those platforms.
	// Keep the raw attempts for diagnosis but lead with an actionable hint.
	const detail = errors.length > 0 ? `（音源尝试：${errors.slice(0, 3).join("；")}）` : "";
	return `咪咕/网易等平台需要自定义音源解析，请检查设置中的音源是否已启用或在落雪音乐中可正常使用${detail}`;
}

/** Resolve a playable URL: first successful source wins, no waiting for the rest. */
export async function resolvePlayUrl(song: OnlineSong): Promise<string> {
	const errors: string[] = [];
	const queue = createResolveQueue(await buildResolveTasks(song, errors));
	let settled = await queue.next();
	while (settled) {
		if (settled.ok && settled.value) {
			resolveObserver?.(settled.via.split("/")[0]);
			return settled.value;
		}
		settled = await queue.next();
	}
	throw new Error(resolveErrorText(errors));
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

/**
 * Delete online cache files that have not been touched for `days` days.
 *
 * `days === 0` disables the automatic cleanup entirely. The Rust side reports
 * exactly how many files and bytes were removed so the UI can show a truthful
 * result instead of guessing.
 */
export async function autoCleanOnlineCache(days: number): Promise<OnlineCacheUsage> {
	return invoke<OnlineCacheUsage>("online_cache_auto_clean", { days });
}

/** Stable identity of an online song, usable as a cache key. */
function cacheKeyOf(song: OnlineSong): string {
	return `online://${song.source}/${song.id}`;
}

/** Rust flags stub audio with this marker so we can log why a candidate was skipped. */
const STUB_AUDIO_MARKER = "__STUB_AUDIO__";

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

	/**
	 * Consume candidates in completion order. The URL may be ready in 200 ms
	 * for one source and never arrive for another; starting the download for
	 * the first verified candidate is what removes the old "wait for every
	 * source" stall. A trial clip simply falls through to the next completion.
	 */
	const tryCandidates = async (target: OnlineSong, viaNote: string): Promise<string | null> => {
		const queue = createResolveQueue(await buildResolveTasks(target, errors));
		let gotCandidate = false;
		let settled = await queue.next();
		while (settled) {
			if (settled.ok && settled.value && !tried.has(settled.value)) {
				tried.add(settled.value);
				gotCandidate = true;
				prepareObserver?.("正在下载音频…");
				try {
					const path = await invoke<string>("online_cache_store", {
						key: cacheKeyOf(target),
						url: settled.value,
					});
					const via = `${settled.via}${viaNote}`;
					resolveObserver?.(via.split("/")[0]);
					devLog(`prepare ${song.source}/${song.id} ok via ${via}`);
					return path;
				} catch (err) {
					const message = (err as Error)?.message ?? String(err);
					errors.push(`${settled.via}: ${message}`);
					devLog(
						`prepare ${song.source}/${song.id} candidate ${settled.via} failed: ${message}`,
					);
					if (message.includes(STUB_AUDIO_MARKER)) {
						// Trial clip: keep consuming the remaining completions.
						settled = await queue.next();
						continue;
					}
				}
			}
			settled = await queue.next();
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

	throw new Error(
		`无法播放：${resolveErrorText(errors.slice(0, 4))}`,
	);
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

/**
 * Download an http(s) cover into the local cache. Tauri's WebView blocks plain
 * http images as mixed content, so a raw platform URL is never written to the
 * DB as the display path. The Rust command also uses a host-specific Referer -
 * sending music.163.com's Referer to QQ/Kuwo image CDNs was a common 403.
 */
async function cacheCoverUrl(url: string): Promise<string> {
	try {
		return await invoke<string>("online_cover_cache", { url });
	} catch (err) {
		if (url.startsWith("http://")) {
			try {
				return await invoke<string>("online_cover_cache", {
					url: url.replace(/^http:\/\//, "https://"),
				});
			} catch {
				// Keep the original error below.
			}
		}
		throw err;
	}
}

async function downloadFirstCover(urls: string[]): Promise<string> {
	const seen = new Set<string>();
	for (const raw of urls) {
		const url = raw?.trim();
		if (!url || !/^https?:\/\//.test(url) || seen.has(url)) continue;
		seen.add(url);
		try {
			const path = await cacheCoverUrl(url);
			if (path) return path;
		} catch (err) {
			devLog(`cover ${url.slice(0, 120)} failed: ${(err as Error)?.message ?? err}`);
		}
	}
	return "";
}

/**
 * Always return a LOCAL cover path for an online song.
 *
 * Candidates, in order: the cover returned by search (the exact row the user
 * clicked, and the only one preserved in saved playlists), the platform's own
 * pic API, then the same track on other platforms. Re-running this on playback
 * also repairs saved rows whose cached cover file was removed by "clear
 * cache": the pseudo path still carries the original http URL.
 */
export async function fetchOnlineCover(song: OnlineSong): Promise<string> {
	const candidates: string[] = [];
	if (song.coverUrl) candidates.push(song.coverUrl);
	try {
		const rawUrl = await invoke<string>("online_pic", {
			platform: song.source,
			id: song.songmid || song.id,
		});
		if (rawUrl) candidates.push(rawUrl);
	} catch {
		// Most platforms have no direct pic API; the search cover is enough.
	}

	let cover = await downloadFirstCover(candidates);
	if (cover) return cover;

	const alternatives = await findSameTrackElsewhere(song);
	cover = await downloadFirstCover(alternatives.map((item) => item.coverUrl));
	return cover;
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
 * Lyrics with the same cross-platform fallback LX uses. Kept separate from
 * covers so a slow lyric search can never delay the artwork.
 */
export async function fetchOnlineLyric(
	song: OnlineSong,
): Promise<{ lyric: string; translated: string }> {
	try {
		return await requestLyric(song);
	} catch {
		// Try other platforms below.
	}

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
				devLog(`lyric ${song.source}/${song.id} matched ${alt.source}/${alt.id}`);
				return res;
			} catch {
				// Next candidate.
			}
		}
	} catch {
		// Search failed - keep playing without lyrics.
	}
	return { lyric: "", translated: "" };
}

/** Lyrics + cover, fetched in parallel. */
export async function fetchOnlineMeta(
	song: OnlineSong,
): Promise<{ lyric: string; translated: string; cover: string }> {
	const [lyric, cover] = await Promise.all([
		fetchOnlineLyric(song),
		fetchOnlineCover(song),
	]);
	return { lyric: lyric.lyric, translated: lyric.translated, cover };
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
