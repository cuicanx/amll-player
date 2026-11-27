import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { LRUCache } from "lru-cache";
import { useLayoutEffect, useRef, useState } from "react";
import { db, type Song } from "./db-client.ts";
import {
	fetchOnlineCover,
	isOnlinePath,
	parseOnlinePath,
} from "./online-api.ts";
import { getVideoThumbnail } from "./video-thumbnail.ts";

const thumbnailCache = new LRUCache<string, string>({
	max: 50,
	dispose: (url) => {
		URL.revokeObjectURL(url);
	},
});

/** One repair per song at a time, even when several virtual rows render it. */
const repairingCovers = new Set<string>();

function isLocalCachedCover(path: string): boolean {
	if (/^https?:\/\//.test(path) || path.startsWith("/data/")) return false;
	// Windows drive / UNC or a POSIX absolute cache path.
	return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);
}

/**
 * Re-download an online song's cover and persist the new local path.
 *
 * The pseudo path in `song.filePath` keeps the original platform/id, so this
 * works even after "clear cache" deleted the cached jpg while the DB row still
 * points at the dead file.
 */
function repairOnlineCover(song: Song): void {
	if (repairingCovers.has(song.id) || !isOnlinePath(song.filePath)) return;
	const online = parseOnlinePath(song.filePath);
	if (!online) return;
	repairingCovers.add(song.id);
	void fetchOnlineCover(online)
		.then((path) => (path ? db.songs.update(song.id, { coverPath: path }) : undefined))
		.catch(() => {})
		.finally(() => repairingCovers.delete(song.id));
}

/**
 * Verify that a persisted local cover still exists before rendering it.
 *
 * "Clear online cache" removes the cover directory but leaves every song's
 * `coverPath` intact, so the path still looks like a valid absolute file and
 * the old code rendered a permanent black cover. For online songs we ask Rust
 * whether the file is really there; a missing/empty file triggers a re-fetch.
 *
 * Non-online songs (local files / uploaded covers) are left untouched - their
 * files are managed by the user, not by the online cache and must not be
 * re-downloaded.
 */
function ensureOnlineCoverFile(song: Song | undefined, coverPath: string): void {
	if (!song || !isOnlinePath(song.filePath) || !isLocalCachedCover(coverPath)) return;
	void invoke<boolean>("online_cover_exists", { path: coverPath })
		.then((exists) => {
			if (!exists) repairOnlineCover(song);
		})
		.catch(() => {
			// If the check itself fails, do nothing rather than deleting a cover
			// that may be valid - a transient IPC error must not cause churn.
		});
}

export const useSongCover = (song?: Song) => {
	const [songImgUrl, setSongImgUrl] = useState<string>("");
	// PERF: depending on the whole Song object re-ran this layout effect for
	// every visible row on any refetch, even when the cover was unchanged.
	// The cover path is the only input that actually matters.
	const coverPath = song?.coverPath;
	const requestIdRef = useRef(0);

	useLayoutEffect(() => {
		const requestId = ++requestIdRef.current;
		if (!coverPath) {
			if (song && isOnlinePath(song.filePath)) repairOnlineCover(song);
			setSongImgUrl("");
			return;
		}

		// Historical online rows store a raw http URL or a relative Migu path.
		// Both are unusable in the WebView; self-heal them from the pseudo path.
		if (song && isOnlinePath(song.filePath) && !isLocalCachedCover(coverPath)) {
			repairOnlineCover(song);
			setSongImgUrl("");
			return;
		}

		// 目前的设计中，后端 SeaORM 歌曲封面的路径有 4 个来源:
		// 1. read_local_music_metadata 始终使用 jpg 作为后缀
		// 2. 用户手动上传的封面则用 infer crate 自动判断封面或视频并使用 mp4 或 jpg 作为后缀，
		//    包括歌曲封面和歌单封面
		// 3. 从 dexie 迁移导入时，使用前端的 mime type
		// 所以可以确保封面路径总是 jpg 或 mp4 文件，方便判断封面是图片或者视频
		// Verify the cached file is still on disk for online songs. A missing
		// file (cleared cache) starts a silent re-download in the background;
		// the current render is left alone so there is no visible flicker.
		ensureOnlineCoverFile(song, coverPath);

		if (!coverPath.endsWith(".mp4")) {
			if (coverPath.startsWith("http://") || coverPath.startsWith("https://")) {
				setSongImgUrl(coverPath);
			} else {
				setSongImgUrl(convertFileSrc(coverPath));
			}
			return;
		}

		const cached = thumbnailCache.get(coverPath);
		if (cached) {
			setSongImgUrl(cached);
			return;
		}

		setSongImgUrl("");
		const videoSrc = coverPath.startsWith("http://") || coverPath.startsWith("https://")
			? coverPath
			: convertFileSrc(coverPath);
		getVideoThumbnail(videoSrc)
			.then((blob) => {
				const url = URL.createObjectURL(blob);
				// PERF/correctness: a virtualised row can be recycled before the
				// async decode finishes. Drop stale results instead of painting
				// another song's cover (and leaking a blob URL).
				if (requestIdRef.current !== requestId) {
					URL.revokeObjectURL(url);
					return;
				}
				thumbnailCache.set(coverPath, url);
				setSongImgUrl(url);
			})
			.catch((err) => {
				if (requestIdRef.current !== requestId) return;
				console.warn("提取视频略缩图失败:", err);
				setSongImgUrl("");
			});
	}, [coverPath, song?.id, song?.filePath]);

	return songImgUrl;
};
