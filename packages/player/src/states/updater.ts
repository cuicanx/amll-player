import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import chalk from "chalk";
import { atom } from "jotai";
import { restartApp } from "../utils/player.ts";
import {
	installAttemptsAtom,
	isCheckingUpdateAtom,
	isInstallingUpdateAtom,
	updateErrorAtom,
	updateInfoAtom,
	updateProgressAtom,
	upstreamUpdateAtom,
} from "./appAtoms";

const LOG_TAG = chalk.bgHex("#FFAA00").hex("#FFFFFF")(" UPDATER ");

/**
 * Default (primary) update source.
 *
 * The repository for this maintained edition is `cuicanx/amll-player`; the
 * same address is recorded in README.md, README-CN.md, Cargo.toml
 * (`repository`) and the build workflow, so no address had to be invented.
 * `tauri.conf.json -> plugins.updater.endpoints` must point at exactly this
 * URL: check, download and install are all derived from that config entry.
 */
export const UPDATE_ENDPOINT =
	"https://github.com/cuicanx/amll-player/releases/download/main-player-dev/latest.json";

/** Human-facing release page of the primary source (manual fallback). */
export const UPDATE_RELEASE_PAGE =
	"https://github.com/cuicanx/amll-player/releases/tag/main-player-dev";

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
	if (/dns|connect|tcp|network/i.test(raw)) {
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
	const previous = get(updateInfoAtom);
	if (previous) {
		try {
			await previous.close();
		} catch {}
	}
	set(updateInfoAtom, false);
	try {
		const update = await check();
		console.log(LOG_TAG, "检查更新返回结果", update);
		set(updateInfoAtom, update || false);
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
 * Download + install from the primary source.
 *
 * Fixes the old flow, which called `downloadAndInstall` without awaiting or
 * catching it: on failure the button stayed `loading` forever, the same broken
 * `Update` handle was reused on the next click, and no reason was ever shown.
 * Here a failure is caught, the handle is closed, `updateInfo` is cleared so
 * the next attempt performs a fresh check, and the attempt counter lets the UI
 * stop an endless retry loop.
 */
export const installUpdateAtom = atom(null, async (get, set) => {
	if (installInFlight) return installInFlight;
	const update = get(updateInfoAtom);
	if (!update) return false;

	const run = (async (): Promise<boolean> => {
		set(isInstallingUpdateAtom, true);
		set(updateErrorAtom, null);
		set(updateProgressAtom, null);
		let contentLength: number | undefined;
		let received = 0;
		try {
			await update.downloadAndInstall((event) => {
				switch (event.event) {
					case "Started":
						contentLength = event.data.contentLength;
						received = 0;
						set(updateProgressAtom, contentLength ? 0 : null);
						break;
					case "Progress":
						received += event.data.chunkLength;
						set(
							updateProgressAtom,
							contentLength ? Math.min(1, received / contentLength) : null,
						);
						break;
					case "Finished":
						set(updateProgressAtom, 1);
						break;
				}
			});
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
			// Drop the poisoned handle and force a fresh check next time.
			try {
				await update.close();
			} catch {}
			set(updateInfoAtom, false);
			return false;
		} finally {
			set(isInstallingUpdateAtom, false);
			set(updateProgressAtom, null);
			installInFlight = null;
		}
	})();

	installInFlight = run;
	return run;
});

/**
 * GitHub asset / API requests are attempted directly and through a mirror
 * **concurrently**, keeping whichever responds first. A sequential attempt
 * meant a slow first transport delayed the result by its full timeout.
 */
async function fetchJsonWithMirror<T>(
	url: string,
	init?: RequestInit,
): Promise<T | null> {
	const targets = [url, `https://gh-proxy.com/${url}`];
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
