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
import { LxSourceRuntime } from "./lx-source-runtime.ts";
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

/** Platforms the Rust backend knows how to search. */
const SEARCHABLE: OnlinePlatform[] = ["kw", "kg", "wy"];

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
const HEALTH_KEY = "amll-player.sourceHealth";
const HEALTH_TTL = 24 * 60 * 60 * 1000;

function loadPersistedHealth(): Map<string, { ok: boolean; message: string }> | null {
	try {
		const raw = localStorage.getItem(HEALTH_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as {
			at: number;
			items: Record<string, { ok: boolean; message: string }>;
		};
		if (Date.now() - parsed.at > HEALTH_TTL) return null;
		return new Map(Object.entries(parsed.items));
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
	await Promise.all(
		enabled.map(async (source) => {
			const runtime = runtimeFor(source);
			try {
				// A broken source must not stall the first search: fail fast.
				await runtime.init(6000);
				if (!runtime.sources[PROBE_SONG.source]) {
					health.set(source.id, {
						ok: false,
						message: "该音源不支持内置探测平台，暂不参与搜索",
					});
					return;
				}
				await runtime.musicUrl(PROBE_SONG.source, toMusicInfo(PROBE_SONG), "128k");
				health.set(source.id, { ok: true, message: "可用" });
			} catch (err) {
				health.set(source.id, { ok: false, message: (err as Error)?.message ?? "不可用" });
			}
		}),
	);
	persistHealth(health);
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
	// Prefer 320k, then 128k. Lossless tiers fail on most free sources, so
	// trying them first would only add failed round-trips.
	const order = ["320k", "128k", "flac", "flac24bit"];
	const usable = order.filter((q) => declared.includes(q));
	return usable.length > 0 ? usable : ["128k"];
}

/** Resolve a playable URL, custom sources first, built-in resolver last. */
export async function resolvePlayUrl(song: OnlineSong): Promise<string> {
	const errors: string[] = [];

	for (const source of loadSources()) {
		if (!source.enabled) continue;
		// No health gating here: a source marked unavailable earlier may already
		// be fine again, and trying it costs one request at most.
		const runtime = runtimeFor(source);
		try {
			if (!runtime.sources[song.source]) continue;
			if (!(await ensureRuntimeReady(source))) {
				errors.push(`${source.name}: 初始化失败`);
				continue;
			}
			const info = toMusicInfo(song);
			for (const quality of qualitiesFor(runtime, song.source)) {
				try {
					return await runtime.musicUrl(song.source, info, quality);
				} catch (err) {
					errors.push(`${source.name}/${quality}: ${(err as Error)?.message ?? err}`);
				}
			}
		} catch (err) {
			errors.push(`${source.name}: ${(err as Error)?.message ?? err}`);
		}
	}

	try {
		return await invoke<string>("online_resolve", {
			platform: song.source,
			info: toMusicInfo(song),
			quality: "320k",
		});
	} catch (err) {
		const detail = errors.length > 0 ? `（音源尝试：${errors.slice(0, 3).join("；")}）` : "";
		throw new Error(`${(err as Error)?.message ?? err}${detail}`);
	}
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
