/**
 * Pure decision helpers for the "auto recover embedded lyrics on play" path.
 *
 * Kept dependency-free so the exact production logic can be executed by a
 * plain Node test without Tauri / React / a browser.
 */

export interface LyricRecoverySong {
	id?: string;
	filePath?: string;
	lyric?: string;
	lyricFormat?: string;
}

export interface LocalMusicMetadata {
	lyric?: string;
	lyricFormat?: string;
}

/**
 * Whether the player should read the audio file's embedded metadata now.
 *
 * Conditions (all must hold):
 *  - a song is actually loaded and has a local file path
 *  - the database row has no usable lyric
 *  - we have not already attempted recovery for this song in this session
 *
 * Only attempting once per song avoids repeated FFmpeg reads and avoids
 * fighting a user who deliberately cleared a lyric.
 */
export function shouldRecoverEmbeddedLyric(
	song: LyricRecoverySong | undefined,
	attempted: ReadonlySet<string>,
): boolean {
	if (!song?.id || !song.filePath) return false;
	if (song.lyric?.trim()) return false;
	return !attempted.has(song.id);
}

/** Build the DB update payload from freshly read metadata, or `null` if empty. */
export function lyricUpdateFromMetadata(
	info: LocalMusicMetadata | undefined,
): { lyric: string; lyricFormat: string } | null {
	const lyric = info?.lyric?.trim();
	if (!lyric) return null;
	return {
		lyric: info?.lyric ?? lyric,
		lyricFormat: info?.lyricFormat?.trim() || "lrc",
	};
}

/**
 * Whether a stored lyric row can be handed to the lyric parser.
 * Mirrors `useLyricParser`'s `if (!lyricStr || !format) return no lyrics`.
 */
export function canRenderLyric(format?: string, lyric?: string): boolean {
	if (!format?.trim() || !lyric?.trim()) return false;
	return ["lrc", "eslrc", "yrc", "qrc", "lys", "ttml"].includes(format.trim());
}
