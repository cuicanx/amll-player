import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import chalk from "chalk";
import { atom } from "jotai";
import { restartApp } from "../utils/player.ts";
import { detectUpdateRegion, mirrorUrl } from "../utils/update-region.ts";
import {
	installAttemptsAtom,
	isCheckingUpdateAtom,
	isInstallingUpdateAtom,
	type UpdateInfo,
	updateChannelAtom,
	updateErrorAtom,
	updateInfoAtom,
	updateProgressAtom,
	updateSpeedAtom,
	upstreamUpdateAtom,
} from "./appAtoms";

const LOG_TAG = chalk.bgHex("#FFAA00").hex("#FFFFFF")(" UPDATER ");

/**
 * Default (primary) update source.
 *
 * The repository for this maintained edition is `cuicanx/amll-player`; the
 * same address is recorded in README.md, Cargo.toml (`repository`) and the
 * build workflow. The endpoint *list* lives in `src-tauri/src/updater.rs`
 * because it has to be reordered per region at runtime - the Tauri updater
 * plugin reads `tauri.conf.json` endpoints once at startup, which made a
 * region-dependent choice impossible from the frontend.
 */
export const UPDATE_ENDPOINT =
	"https://github.com/cuicanx/amll-player/releases/download/main-player-dev/latest.json";

/** Human-facing release page for the selected channel (manual fallback). */
export function releasePageFor(channel: "dev" | "stable", version?: string): string {
	// Stable tag is derived from the running version so it never goes stale.
	const tag = channel === "stable" ? `v${version ?? "1.0.2"}` : "main-player-dev";
	return `https://github.com/cuicanx/amll-player/releases/tag/${tag}`;
}

/**
 * Upstream channel. Used ONLY by the informational hint, never for checking,
 * downloading or installing an update.
 */
const UPSTREAM_RELEASE_API =
	"https://api.github.com/repos/amll-dev/amll-player/releases/tags/main-player-dev";
export const UPSTREAM_RELEASE_URL =
	"https://github.com/amll-dev/amll-player/releases/tag/main-player-dev";

/** Prevents two concurrent installs (double click / stale button state). */
let installInFlight: Promise<boolean> | null = null;

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

/**
 * Turn the updater's raw English errors into something actionable. The two
 * failures users actually hit are a blocked manifest fetch (VPN / DNS) and an
 * unreachable asset host - "Could not fetch a valid release JSON from the
 * remote" on its own says nothing about what to do next.
 */
function friendlyUpdateError(err: unknown): string {
	const raw = describeError(err);
	if (/release json/i.test(raw)) {
		return `${raw}（更新清单获取失败：网络可能被拦截，可关闭 VPN 或改用「打开发布页」手动更新）`;
	}
	if (/signature|verify/i.test(raw)) {
		return `${raw}（安装包签名校验失败）`;
	}
	if (/timed? ?out|timeout/i.test(raw)) {
		return `${raw}（下载超时，可切换网络后重试）`;
	}
	if (/dns|connect|tcp|network|request/i.test(raw)) {
		return `${raw}（无法连接更新服务器，请检查网络或代理设置）`;
	}
	return raw;
}

/**
 * Extracts a monotonically comparable build number.
 *   our dev builds: 0.0.<commitCount>   -> patch
 *   upstream builds: 0.0.1+<commitCount> -> build metadata
 * Returns null when the shape is unknown (then no hint is shown at all).
 */
function buildNumberOf(version: string | null | undefined): number | null {
	if (!version) return null;
	const withBuild = /^\d+\.\d+\.\d+\+(\d+)$/.exec(version);
	if (withBuild) return Number(withBuild[1]);
	const plain = /^\d+\.\d+\.(\d+)$/.exec(version);
	if (plain) return Number(plain[1]);
	return null;
}

export const checkUpdateAtom = atom(null, async (get, set) => {
	// Never stack checks, and never run one while an install is in progress.
	if (get(isCheckingUpdateAtom) || get(isInstallingUpdateAtom)) return;
	set(isCheckingUpdateAtom, true);
	set(updateErrorAtom, null);
	set(updateInfoAtom, false);
	try {
		// Region comes from the egress IP (cached for six hours), so a VPN whose
		// exit node is outside mainland China is served by the official source
		// instead of the proxy.
		const region = await detectUpdateRegion();
		const channel = get(updateChannelAtom);
		const update = await invoke<UpdateInfo | null>("updater_check", {
			region,
			channel,
		});
		console.log(LOG_TAG, "检查更新返回结果", region, channel, update);
		set(updateInfoAtom, update ? { ...update, channel } : false);
	} catch (e) {
		console.warn(LOG_TAG, "检查更新失败", e);
		// Previously this only logged to the console, so the UI looked like
		// "nothing happened". Surface it so the user knows why.
		set(updateErrorAtom, friendlyUpdateError(e));
	} finally {
		set(isCheckingUpdateAtom, false);
	}
});

/**
 * Download + install from the region-appropriate source.
 *
 * The transfer runs in Rust (`updater_install`): the manifest - and therefore
 * the download host - must be the one picked for this machine's region.
 * Progress and speed arrive as `updater://progress` events.
 *
 * Failure handling is the same contract as before: the reason is surfaced, the
 * attempt counter increments so the UI can offer a manual fallback, and the
 * button never stays stuck in a loading state.
 */
export const installUpdateAtom = atom(null, async (get, set) => {
	if (installInFlight) return installInFlight;
	const update = get(updateInfoAtom);
	if (!update) return false;

	const run = (async (): Promise<boolean> => {
		set(isInstallingUpdateAtom, true);
		set(updateErrorAtom, null);
		set(updateProgressAtom, null);
		set(updateSpeedAtom, null);

		let unlisten: (() => void) | null = null;
		let unlistenRetrying: (() => void) | null = null;
		let unlistenProgress: (() => void) | null = null;
		let lastBytes = 0;
		let lastAt = 0;
		try {
			// A retry restarts the transfer from zero, so the progress bar and the
			// speed average must be reset instead of jumping backwards.
			unlisten = await listen("updater://started", () => {
				lastBytes = 0;
				lastAt = 0;
				set(updateProgressAtom, 0);
				set(updateSpeedAtom, null);
			});
			unlistenRetrying = await listen("updater://retrying", () => {
				lastBytes = 0;
				lastAt = 0;
				set(updateProgressAtom, null);
				set(updateSpeedAtom, null);
			});
			unlistenProgress = await listen<{
				downloaded: number;
				total?: number | null;
			}>(
				"updater://progress",
				(event) => {
					const { downloaded, total } = event.payload;
					if (total && total > 0) {
						set(updateProgressAtom, Math.min(1, downloaded / total));
					}
					const now = performance.now();
					if (lastAt === 0) {
						lastBytes = downloaded;
						lastAt = now;
					} else if (now - lastAt >= 250) {
						const bytesPerSecond =
							((downloaded - lastBytes) * 1000) / (now - lastAt);
						// Exponential smoothing: raw per-chunk deltas flicker far too
						// much to be readable as "MB/s".
						set(updateSpeedAtom, (prev) =>
							prev === null
								? bytesPerSecond
								: prev * 0.7 + bytesPerSecond * 0.3,
						);
						lastBytes = downloaded;
						lastAt = now;
					}
				},
			);

			// Re-detect here as well: a failed attempt is very often a network
			// change (VPN toggled), so the retry must hit the right source.
			const region = await detectUpdateRegion(true);
			const channel = get(updateChannelAtom);
			await invoke("updater_install", { region, channel });
			set(updateProgressAtom, 1);
			// The NSIS installer normally takes over and exits the process. If
			// it does not (some environments), restart explicitly after a grace
			// period so the new version actually becomes active.
			window.setTimeout(() => {
				void restartApp().catch((e) => console.warn(LOG_TAG, "重启应用失败", e));
			}, 2000);
			return true;
		} catch (e) {
			console.error(LOG_TAG, "下载/安装更新失败", e);
			set(updateErrorAtom, friendlyUpdateError(e));
			set(installAttemptsAtom, get(installAttemptsAtom) + 1);
			set(updateInfoAtom, false);
			return false;
		} finally {
			unlisten?.();
			unlistenRetrying?.();
			unlistenProgress?.();
			set(isInstallingUpdateAtom, false);
			set(updateSpeedAtom, null);
			installInFlight = null;
		}
	})();

	installInFlight = run;
	return run;
});

/** Formats a byte rate as `12.4 MB/s` (or null when unknown). */
export function formatSpeed(bytesPerSecond: number | null): string | null {
	if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
		return null;
	}
	const mb = bytesPerSecond / (1024 * 1024);
	if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
	return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

/**
 * GitHub asset / API requests are attempted through the region-appropriate
 * transport first, then the other one. Trying them in sequence meant a slow
 * first transport delayed the result by its full timeout.
 */
async function fetchJsonWithMirror<T>(
	url: string,
	init?: RequestInit,
): Promise<T | null> {
	const region = await detectUpdateRegion();
	const targets =
		region === "global" ? [url, mirrorUrl(url)] : [mirrorUrl(url), url];
	const controllers = targets.map(() => new AbortController());
	const attempt = (target: string, index: number) =>
		fetch(target, { ...init, signal: controllers[index].signal }).then(
			async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as T;
				for (let i = 0; i < controllers.length; i++) {
					if (i !== index) controllers[i].abort();
				}
				return data;
			},
		);
	try {
		return await Promise.any(targets.map(attempt));
	} catch {
		return null;
	}
}

/**
 * Optional upstream check. Purely informational: it only sets a hint atom and
 * never touches `updateInfoAtom` / the configured endpoint. Any failure
 * (offline, rate limit, CORS) is swallowed so the main flow is unaffected.
 */
export const checkUpstreamUpdateAtom = atom(null, async (_get, set) => {
	set(upstreamUpdateAtom, null);
	try {
		const current = await getVersion();
		const data = await fetchJsonWithMirror<{ assets?: { name?: string }[] }>(
			UPSTREAM_RELEASE_API,
			{ headers: { Accept: "application/vnd.github+json" } },
		);
		if (!data) return;
		const version = (data.assets ?? [])
			.map((asset) =>
				/_([0-9]+\.[0-9]+\.[0-9]+(?:\+\d+)?)_/.exec(asset.name ?? ""),
			)
			.map((match) => match?.[1])
			.find((value): value is string => Boolean(value));
		const upstreamBuild = buildNumberOf(version);
		const localBuild = buildNumberOf(current);
		if (
			upstreamBuild !== null &&
			localBuild !== null &&
			upstreamBuild > localBuild
		) {
			set(upstreamUpdateAtom, {
				version: version ?? "",
				url: UPSTREAM_RELEASE_URL,
			});
		}
	} catch (e) {
		console.debug(LOG_TAG, "上游更新检测跳过", e);
	}
});
