import { convertFileSrc } from "@tauri-apps/api/core";
import { LRUCache } from "lru-cache";
import { useLayoutEffect, useRef, useState } from "react";
import type { Song } from "./db-client.ts";
import { getVideoThumbnail } from "./video-thumbnail.ts";

const thumbnailCache = new LRUCache<string, string>({
	max: 50,
	dispose: (url) => {
		URL.revokeObjectURL(url);
	},
});

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
			setSongImgUrl("");
			return;
		}

		// 目前的设计中，后端 SeaORM 歌曲封面的路径有 4 个来源:
		// 1. read_local_music_metadata 始终使用 jpg 作为后缀
		// 2. 用户手动上传的封面则用 infer crate 自动判断封面或视频并使用 mp4 或 jpg 作为后缀，
		//    包括歌曲封面和歌单封面
		// 3. 从 dexie 迁移导入时，使用前端的 mime type
		// 所以可以确保封面路径总是 jpg 或 mp4 文件，方便判断封面是图片或者视频
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
	}, [coverPath]);

	return songImgUrl;
};
