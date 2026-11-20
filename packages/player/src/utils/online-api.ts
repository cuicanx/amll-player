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

function runtimeFor(source: StoredSource): LxSourceRuntime {
	const cached = runtimes.get(source.id);
	if (cached) return cached;
	const runtime = new LxSourceRuntime(source.rawScript);
	runtimes.set(source.id, runtime);
	return runtime;
}

/** Forget cached runtimes so a re-imported source is evaluated again. */
export function resetOnlineRuntimeCache(): void {
	runtimes.clear();
	health.clear();
}

/**
 * Check every enabled source once per session. A source that cannot resolve a
 * well-known song is reported as unavailable and its platforms are left out of
 * the search, so the result list never shows rows that cannot be played.
 */
export async function ensureSourceHealth(force = false): Promise<Map<string, { ok: boolean; message: string }>> {
	if (!force && health.size > 0) return health;

	const enabled = loadSources().filter((s) => s.enabled);
	health.clear();
	await Promise.all(
		enabled.map(async (source) => {
			const runtime = runtimeFor(source);
			try {
				await runtime.init();
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
	return health;
}

export function getSourceHealth(id: string) {
	return health.get(id);
}

/** Platforms worth searching: built-in ones plus those of healthy sources. */
export function platformsForSearch(): OnlinePlatform[] {
	const result = new Set<OnlinePlatform>(BUILTIN_PLATFORMS);
	for (const source of loadSources()) {
		if (!source.enabled) continue;
		if (!health.get(source.id)?.ok) continue;
		for (const key of Object.keys(runtimeFor(source).sources)) {
			if (SEARCHABLE.includes(key as OnlinePlatform)) result.add(key as OnlinePlatform);
		}
	}
	return [...result];
}

export async function onlineSearch(keyword: string): Promise<OnlineSong[]> {
	await ensureSourceHealth();
	const platforms = platformsForSearch();
	return invoke<OnlineSong[]>("online_search", {
		keyword,
		platforms,
		limit: 40,
	});
}

/** A superset of every id field a source might look at. */
export function toMusicInfo(song: OnlineSong): Record<string, unknown> {
	return {
		source: song.source,
		id: song.id,
		songmid: song.songmid,
		songId: song.id,
		rid: song.songmid,
		hash: song.hash,
		name: song.name,
		songName: song.name,
		singer: song.singer,
		artists: song.singer,
		albumName: song.albumName,
		albumId: song.albumId,
		interval: String(song.interval),
		duration: song.interval,
		img: song.coverUrl,
		...(song.extra ?? {}),
	};
}

function qualitiesFor(runtime: LxSourceRuntime, platform: string): string[] {
	const declared = runtime.sources[platform]?.qualitys ?? [];
	const order = ["flac24bit", "flac", "320k", "128k"];
	const usable = order.filter((q) => declared.includes(q));
	return usable.length > 0 ? usable : ["128k"];
}

/** Resolve a playable URL, custom sources first, built-in resolver last. */
export async function resolvePlayUrl(song: OnlineSong): Promise<string> {
	const errors: string[] = [];
	await ensureSourceHealth();

	for (const source of loadSources()) {
		if (!source.enabled) continue;
		// Skip sources the health check already proved broken: they would only
		// add a failed round-trip to every single playback.
		if (health.get(source.id)?.ok === false) continue;
		const runtime = runtimeFor(source);
		try {
			if (!runtime.sources[song.source]) continue;
			await runtime.init();
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
