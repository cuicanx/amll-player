import {
	musicAlbumNameAtom,
	musicArtistsAtom,
	musicCoverAtom,
	musicCoverIsVideoAtom,
	musicDurationAtom,
	musicLyricLinesAtom,
	musicNameAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
} from "@applemusic-like-lyrics/react-full";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useAtomValue, useStore } from "jotai";
import { type FC, useCallback, useEffect, useRef } from "react";
import {
	taskbarLyricAlignSettingAtom,
	taskbarLyricModeSettingAtom,
	taskbarLyricThemeSettingAtom,
} from "../../states/appAtoms";
import {
	ALIGN_EVENT,
	CTRL_NEXT_EVENT,
	CTRL_PLAY_OR_RESUME_EVENT,
	CTRL_PREV_EVENT,
	METADATA_EVENT,
	MODE_EVENT,
	PLAY_STATUS_EVENT,
	POSITION_EVENT,
	REQUEST_UPDATE_EVENT,
	type TaskbarLyricAlignmentPayload,
	type TaskbarLyricMetadataPayload,
	type TaskbarLyricModePayload,
	type TaskbarLyricPlayStatusPayload,
	type TaskbarLyricPositionPayload,
	type TaskbarLyricThemePayload,
	THEME_EVENT,
} from "./types";

export const TaskbarLyricBridge: FC = () => {
	const store = useStore();
	const musicName = useAtomValue(musicNameAtom);
	const musicArtists = useAtomValue(musicArtistsAtom);
	const musicAlbumName = useAtomValue(musicAlbumNameAtom);
	const musicDuration = useAtomValue(musicDurationAtom);
	const musicLyricLines = useAtomValue(musicLyricLinesAtom);
	const musicPlaying = useAtomValue(musicPlayingAtom);
	const musicCover = useAtomValue(musicCoverAtom);
	const musicCoverIsVideo = useAtomValue(musicCoverIsVideoAtom);
	const lastEmitTime = useRef(0);
	const onRequestPrevSong = useAtomValue(onRequestPrevSongAtom).onEmit;
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const onRequestNextSong = useAtomValue(onRequestNextSongAtom).onEmit;

	const taskbarLyricTheme = useAtomValue(taskbarLyricThemeSettingAtom);
	const taskbarLyricAlign = useAtomValue(taskbarLyricAlignSettingAtom);
	const taskbarLyricMode = useAtomValue(taskbarLyricModeSettingAtom);

	const stateCache = useRef({
		metadata: {} as TaskbarLyricMetadataPayload,
		playStatus: {} as TaskbarLyricPlayStatusPayload,
		position: {} as TaskbarLyricPositionPayload,
		theme: { theme: "auto" } as TaskbarLyricThemePayload,
		align: { align: "auto" } as TaskbarLyricAlignmentPayload,
		mode: { mode: "auto" } as TaskbarLyricModePayload,
	});

	// Push the complete cached state in one shot. Used both when the taskbar
	// window first opens and when it asks for a refresh after registering its
	// listeners. Sending every field (even an empty metadata object) is fine:
	// the taskbar page treats it as "no song yet" and updates on the next one.
	const pushAll = useCallback(() => {
		const cache = stateCache.current;
		emit(METADATA_EVENT, cache.metadata).catch(console.error);
		emit(PLAY_STATUS_EVENT, cache.playStatus).catch(console.error);
		emit(POSITION_EVENT, cache.position).catch(console.error);
		emit(THEME_EVENT, cache.theme).catch(console.error);
		emit(ALIGN_EVENT, cache.align).catch(console.error);
		emit(MODE_EVENT, cache.mode).catch(console.error);
	}, []);

	useEffect(() => {
		// open_taskbar_lyric creates the WebView asynchronously. The taskbar
		// page emits REQUEST_UPDATE_EVENT once its listeners are ready; if that
		// request fires before this bridge subscribed, no state would ever
		// arrive for a song that was already loaded at startup. Seed the window
		// proactively after a short delay as well.
		invoke("open_taskbar_lyric")
			.then(() => {
				setTimeout(pushAll, 400);
			})
			.catch(console.error);
		return () => {
			invoke("close_taskbar_lyric").catch(console.error);
		};
	}, [pushAll]);

	useEffect(() => {
		const payload: TaskbarLyricMetadataPayload = {
			musicName,
			musicArtists,
			musicAlbumName,
			musicDuration,
			lyricLines: musicLyricLines,
			musicCover,
			musicCoverIsVideo,
		};
		stateCache.current.metadata = payload;
		emit(METADATA_EVENT, payload).catch(console.error);
	}, [
		musicName,
		musicArtists,
		musicAlbumName,
		musicDuration,
		musicLyricLines,
		musicCover,
		musicCoverIsVideo,
	]);

	useEffect(() => {
		const payload: TaskbarLyricPlayStatusPayload = { musicPlaying };
		stateCache.current.playStatus = payload;
		emit(PLAY_STATUS_EVENT, payload).catch(console.error);
	}, [musicPlaying]);

	// PERF: musicPlayingPositionAtom is the lyric clock and is written on every
	// animation frame. Reading it with useAtomValue re-rendered this bridge ~60
	// times per second and scheduled an effect each time, even though the emit
	// is throttled to 200 ms. Subscribe directly to the store instead so the
	// React tree is not involved in the per-frame path at all.
	useEffect(() => {
		return store.sub(musicPlayingPositionAtom, () => {
			const now = performance.now();
			if (now - lastEmitTime.current < 200) return;
			lastEmitTime.current = now;

			const payload: TaskbarLyricPositionPayload = {
				position: store.get(musicPlayingPositionAtom),
			};
			stateCache.current.position = payload;
			emit(POSITION_EVENT, payload).catch(console.error);
		});
	}, [store]);

	useEffect(() => {
		stateCache.current.theme = { theme: taskbarLyricTheme };
		emit(THEME_EVENT, stateCache.current.theme).catch(console.error);
	}, [taskbarLyricTheme]);

	useEffect(() => {
		stateCache.current.align = { align: taskbarLyricAlign };
		emit(ALIGN_EVENT, stateCache.current.align).catch(console.error);
	}, [taskbarLyricAlign]);

	useEffect(() => {
		stateCache.current.mode = { mode: taskbarLyricMode };
		emit(MODE_EVENT, stateCache.current.mode).catch(console.error);
	}, [taskbarLyricMode]);

	useEffect(() => {
		const unlistenRequest = listen(REQUEST_UPDATE_EVENT, () => {
			pushAll();
		});

		return () => {
			unlistenRequest.then((fn) => fn());
		};
	}, [pushAll]);

	useEffect(() => {
		const unlistenPrev = listen(CTRL_PREV_EVENT, () => {
			onRequestPrevSong?.();
		});
		const unlistenPlayOrResume = listen(CTRL_PLAY_OR_RESUME_EVENT, () => {
			onPlayOrResume?.();
		});
		const unlistenNext = listen(CTRL_NEXT_EVENT, () => {
			onRequestNextSong?.();
		});
		return () => {
			unlistenPrev.then((fn) => fn());
			unlistenPlayOrResume.then((fn) => fn());
			unlistenNext.then((fn) => fn());
		};
	}, [onRequestPrevSong, onPlayOrResume, onRequestNextSong]);

	return null;
};
