import { listen } from "@tauri-apps/api/event";
import { LRUCache } from "lru-cache";
import { db, type Song } from "./db-client.ts";

/**
 * Batched song loader for long playlists.
 *
 * Before this, every visible row called `db.songs.get(id)` on mount. A fast
 * flick through a long list therefore queued one Tauri IPC per row, with no
 * deduplication, no cancellation and no prefetch - the rows you scrolled to
 * were still waiting behind all the rows you had already passed.
 *
 * This module keeps one app-lifetime cache and coalesces every request made
 * in the same microtask into a single `get_songs_by_ids` call (batches of 80).
 * Rows that scroll out unsubscribe immediately, so invisible rows no longer
 * occupy the batch. `prefetchSongs` warms the cache ahead of the viewport
 * while scrolling settles, so on-screen rows render from memory with no IPC
 * round-trip at all.
 */

type Listener = () => void;
/** `null` means the id was looked up and does not exist. */
type Entry = Song | null;

const BATCH_SIZE = 80;
/**
 * Bounded cache. A Song carries its full lyric text, so an unbounded map grows
 * with every row the user ever scrolled past (a 1000-song list kept all of them
 * alive). 400 entries comfortably covers the largest realistic playlist plus
 * the prefetch window; anything evicted is simply re-fetched in one batch if
 * the user scrolls back, which the prefetch normally hides.
 */
const CACHE_LIMIT = 400;

const cache = new LRUCache<string, Entry>({ max: CACHE_LIMIT });
const subscribers = new Map<string, Set<Listener>>();
const queued = new Set<string>();
const inflight = new Set<string>();
/** Cached entries that need a background refresh (stale-while-revalidate). */
const stale = new Set<string>();
let flushScheduled = false;
let dbListenerStarted = false;

/** Stable snapshot for `useSyncExternalStore`: undefined = not loaded yet. */
export function readSong(id: string): Song | null | undefined {
	return cache.get(id);
}

function notify(ids: string[]): void {
	for (const id of ids) {
		const listeners = subscribers.get(id);
		if (!listeners) continue;
		for (const listener of listeners) listener();
	}
}

function scheduleFlush(): void {
	if (flushScheduled) return;
	flushScheduled = true;
	queueMicrotask(() => {
		flushScheduled = false;
		void flush();
	});
}

function enqueue(ids: Iterable<string>): void {
	let added = false;
	for (const id of ids) {
		if (cache.has(id) || inflight.has(id)) continue;
		queued.add(id);
		added = true;
	}
	if (added) scheduleFlush();
}

async function flush(): Promise<void> {
	const ids = [...queued].filter(
		(id) => (!cache.has(id) || stale.has(id)) && !inflight.has(id),
	);
	queued.clear();
	if (ids.length === 0) return;

	for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
		const chunk = ids.slice(offset, offset + BATCH_SIZE);
		for (const id of chunk) inflight.add(id);
		try {
			const songs = await db.songs.getByIds(chunk);
			const found = new Set<string>();
			for (const song of songs) {
				cache.set(song.id, song);
				found.add(song.id);
			}
			// Cache misses as `null` so deleted songs are not re-requested on
			// every scroll pass.
			for (const id of chunk) if (!found.has(id)) cache.set(id, null);
			for (const id of chunk) stale.delete(id);
		} catch (err) {
			console.error("批量读取歌曲失败", err);
			// Retry on the next scroll/prefetch rather than stamping a
			// permanent empty result for a transient IPC failure.
			for (const id of chunk) queued.add(id);
		} finally {
			for (const id of chunk) inflight.delete(id);
			notify(chunk);
		}
	}
}

function ensureDbListener(): void {
	if (dbListenerStarted) return;
	dbListenerStarted = true;
	listen<{ table: string }>("db-row-changed", (event) => {
		if (event.payload?.table === "songs") invalidateSongCache();
	}).catch((err) => {
		console.warn("歌曲变更监听注册失败", err);
		dbListenerStarted = false;
	});
}

/** Subscribe to one song id. Returns an unsubscribe function. */
export function subscribeSong(id: string, listener: Listener): () => void {
	ensureDbListener();
	let listeners = subscribers.get(id);
	if (!listeners) {
		listeners = new Set();
		subscribers.set(id, listeners);
	}
	listeners.add(listener);
	if (!cache.has(id)) {
		queued.add(id);
		scheduleFlush();
	}
	return () => {
		listeners?.delete(listener);
		if (listeners && listeners.size === 0) {
			subscribers.delete(id);
			// The row scrolled out of view: drop it from the pending batch so
			// fast flings never waste an IPC on rows nobody is waiting for.
			queued.delete(id);
		}
	};
}

/** Warm the cache for rows just outside the viewport. */
export function prefetchSongs(ids: string[]): void {
	if (ids.length === 0) return;
	enqueue(ids);
}

/** Refresh visible rows after a `songs` write, keeping the old value on
 * screen until the new one arrives so the list never blanks out. */
export function invalidateSongCache(): void {
	for (const id of subscribers.keys()) {
		stale.add(id);
		queued.add(id);
	}
	if (queued.size > 0) scheduleFlush();
}
