import { convertFileSrc } from "@tauri-apps/api/core";
import classNames from "classnames";
import { type FC, type HTMLProps, useEffect, useState } from "react";
import { db } from "../../utils/db-client.ts";
import { useDbQuery } from "../../utils/use-db-query.ts";
import styles from "./index.module.css";

/**
 * PERF/UX: cover URLs used to be cleared back to [] on every refetch, so a
 * virtualised row showed an empty dark tile for a moment before the images
 * came back, and `transition: background-image` (a non-interpolable property)
 * produced a visible black flash. Keep a module-level cache, never clear a
 * known cover, and fade each tile in with opacity instead.
 */
const coverCache = new Map<number, string[]>();

const toDisplayUrl = (path: string) =>
	path.startsWith("http://") || path.startsWith("https://")
		? path
		: convertFileSrc(path);

export const PlaylistCover: FC<
	{
		playlistId: number;
	} & HTMLProps<HTMLDivElement>
> = ({ playlistId, className, ...props }) => {
	const [playlistImgs, setPlaylistImgs] = useState<string[]>(
		() => coverCache.get(playlistId) ?? [],
	);

	const { data: playlist } = useDbQuery(
		() => db.playlists.get(playlistId),
		[playlistId],
		undefined,
		["playlists", "playlist_songs"],
	);

	const { data: songs } = useDbQuery(
		async () => {
			if (playlist && !playlist.songIds?.length) return [];
			if (!playlist) return [];
			const allSongs = await db.songs.getByIds(playlist.songIds);
			return allSongs.filter(
				(s) => s.coverPath && !s.coverPath.endsWith(".mp4"),
			);
		},
		[playlist],
		[],
		["songs"],
	);

	useEffect(() => {
		let imgs: string[] = [];
		if (playlist?.coverPath) {
			imgs = [toDisplayUrl(playlist.coverPath)];
		} else if (songs && songs.length > 0) {
			imgs = songs
				.slice(0, 4)
				// biome-ignore lint/style/noNonNullAssertion: filter() 检查了 coverPath 的存在
				.map((s) => toDisplayUrl(s.coverPath!));
		}

		// No result yet (or a transient refetch): keep what is already on
		// screen instead of blanking it out and repainting.
		if (imgs.length === 0) return;

		coverCache.set(playlistId, imgs);
		setPlaylistImgs((prev) =>
			prev.length === imgs.length && prev.every((v, i) => v === imgs[i])
				? prev
				: imgs,
		);
	}, [songs, playlist, playlistId]);

	return (
		<div
			className={classNames(styles.playlistCover, "img-border", className)}
			{...props}
		>
			{playlistImgs.length === 0 ? (
				<div className={styles.coverPlaceholder} />
			) : (
				playlistImgs.map((img) => (
					<div
						key={img}
						className={styles.coverCell}
						style={{ backgroundImage: `url(${img})` }}
					/>
				))
			)}
		</div>
	);
};
