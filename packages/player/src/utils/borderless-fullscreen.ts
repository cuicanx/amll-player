import { getCurrentWindow } from "@tauri-apps/api/window";
import { getDefaultStore } from "jotai";
import { borderlessFullscreenAtom } from "../states/appAtoms.ts";

/**
 * Borderless fullscreen - the ONLY definition of "进入全屏" in this app.
 *
 * F11, the right-click menu and the settings page all call into this module, so
 * there is exactly one implementation. "Fullscreen" here always means a
 * *borderless* full-screen window:
 *
 *   - the Tauri window fullscreen flag is raised, which makes the OS size the
 *     window to the whole monitor (taskbar included) and drop the frame, and
 *   - the self-drawn titlebar is hidden, because the main window already runs
 *     with `decorations: false`.
 *
 * It is deliberately NOT "maximise the window": a maximised window keeps the
 * work-area reservation (a taskbar-high strip), which is a different thing.
 *
 * ── Why this file keeps its own state (the "hard" bug) ──────────────────────
 *
 * On Windows, `isFullscreen()` lags behind the real window right after a
 * switch. Trusting it as the toggle input produced two very confusing bugs:
 *
 *   1. Second F11 did nothing. It still answered `false` while the window was
 *      already fullscreen, so we ran the *enter* path again. The path began by
 *      hiding the titlebar and then raced `unmaximize()` against
 *      `setFullscreen(true)`; when the un-maximise landed last it cleared the
 *      fullscreen style, leaving a restored window with no titlebar - i.e. a
 *      window that can no longer be dragged.
 *   2. The menu always said "进入全屏". Every open re-synced from the same
 *      lagging flag and overwrote the correct state with `false`.
 *
 * So: the module owns an authoritative `state`, native queries are only used to
 * *initialise* / re-sync it when nothing is settling, and "is it really
 * fullscreen" is answered by geometry (does the window cover the whole
 * monitor?) instead of the cached flag. Window calls are always strictly
 * ordered - the two-frame await that used to make the switch look like
 * "shrink, then grow" is gone, but so is the race.
 */

const STATE_TIMEOUT_MS = 700;

let toggling = false;
/** Remember whether the window was maximised so leaving fullscreen restores it. */
let wasMaximized = false;
/** Authoritative state. `null` until it has been read once. */
let state: boolean | null = null;
/**
 * Set once a transition (or the startup probe) has been confirmed. Before
 * that the native flag is the only source; after that our own state wins.
 *
 * This is the fix for "entered fullscreen but the menu still says 进入全屏":
 * every menu opening used to re-read `isFullscreen()`, which lags on Windows,
 * and overwrote the correct, freshly-confirmed state with `false`.
 */
let confirmed = false;
/** Timestamp of the last toggle, used to ignore lagging native reads. */
let lastToggleAt = 0;

type AppWindow = ReturnType<typeof getCurrentWindow>;

/** Shares the app's default jotai store (the app renders a bare <Provider>). */
const store = getDefaultStore();

function publish(isFullscreen: boolean): void {
	store.set(borderlessFullscreenAtom, isFullscreen);
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * Truth about the window geometry, independent of the (lagging) fullscreen
 * flag: a borderless fullscreen window covers the whole monitor, while a
 * maximised one leaves the taskbar out.
 */
async function coversMonitor(win: AppWindow): Promise<boolean> {
	try {
		const [monitor, size] = await Promise.all([
			win.currentMonitor(),
			win.outerSize(),
		]);
		if (!monitor) return false;
		const physical = size.toPhysical(monitor.scaleFactor);
		// 8px of slack: logical -> physical rounding, and a window border on some
		// DPI settings. A maximised window is off by the taskbar height (~48px),
		// so this still tells the two apart.
		return (
			Math.abs(physical.width - monitor.size.width) <= 8 &&
			Math.abs(physical.height - monitor.size.height) <= 8
		);
	} catch {
		return false;
	}
}

async function isActuallyFullscreen(): Promise<boolean> {
	const win = getCurrentWindow();
	try {
		if (await win.isFullscreen()) return true;
	} catch {
		/* fall through to the geometric check */
	}
	return coversMonitor(win);
}

/** Poll until the window really is (or really is not) fullscreen. */
async function waitForState(want: boolean, timeout = STATE_TIMEOUT_MS) {
	const deadline = Date.now() + timeout;
	for (;;) {
		if ((await isActuallyFullscreen()) === want) return true;
		if (Date.now() >= deadline) return false;
		await sleep(50);
	}
}

/** Resolve on the next resize event, or after `timeout` ms. */
function waitForResize(timeout = 220): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			window.removeEventListener("resize", finish);
			resolve();
		};
		const timer = window.setTimeout(finish, timeout);
		window.addEventListener("resize", finish);
	});
}

async function restoreTitlebarChrome(win: AppWindow): Promise<void> {
	try {
		const appearance = localStorage.getItem("system-titlebar-appearance");
		if (appearance) {
			setSystemTitlebarAppearance(appearance as SystemTitlebarAppearance);
		}
	} catch (err) {
		console.warn("恢复自定义标题栏外观失败", err);
	}
	try {
		const maximized = await win.isMaximized();
		setSystemTitlebarResizeAppearance(
			maximized
				? SystemTitlebarResizeAppearance.Restore
				: SystemTitlebarResizeAppearance.Maximize,
		);
	} catch (err) {
		console.warn("恢复标题栏最大化状态失败", err);
	}
}

export async function isBorderlessFullscreen(): Promise<boolean> {
	return isActuallyFullscreen();
}

/**
 * Re-read the real state and publish it. Called when the context menu opens.
 *
 * While a switch is still settling the native/geometry answer can be one frame
 * behind, so the authoritative value wins for a short window instead of
 * overwriting it - that overwrite was why the menu kept offering "进入全屏".
 */
export async function syncBorderlessFullscreenState(): Promise<boolean> {
	// Once a transition has been confirmed, our state IS the truth. Native
	// queries on Windows lag by a frame or more, so re-reading them here is
	// exactly what made an already-fullscreen window report "进入全屏" again.
	if (confirmed && state !== null) {
		publish(state);
		return state;
	}

	// Startup / not yet confirmed: take two agreeing samples so a single lagging
	// read cannot establish a wrong initial state.
	const first = await isActuallyFullscreen();
	const second = await isActuallyFullscreen();
	state = first === second ? first : await isActuallyFullscreen();
	confirmed = true;
	publish(state === true);
	return state === true;
}

/** Enter borderless fullscreen. No-op when already there. */
export async function enterBorderlessFullscreen(): Promise<void> {
	if (state === true) {
		publish(true);
		return;
	}
	const win = getCurrentWindow();
	wasMaximized = await win.isMaximized().catch(() => false);
	lastToggleAt = Date.now();

	// Hide the titlebar buttons first so they do not stretch across the top edge
	// while the window grows. Rolled back below if the switch does not take.
	setSystemTitlebarFullscreen(true);

	// Strict order: un-maximise, then go fullscreen. Racing these let the
	// un-maximise clear the fullscreen style afterwards, which produced a
	// restored window with no titlebar (not draggable).
	if (wasMaximized) {
		await win.unmaximize().catch(() => undefined);
	}
	await win.setFullscreen(true).catch((err) => {
		console.error("进入全屏失败", err);
	});

	if (!(await waitForState(true))) {
		// Never leave a non-fullscreen window without its titlebar.
		console.warn("进入全屏未生效，已回滚标题栏");
		setSystemTitlebarFullscreen(false);
		await restoreTitlebarChrome(win);
		state = false;
		confirmed = true;
		publish(false);
		return;
	}

	state = true;
	confirmed = true;
	publish(true);
}

/** Leave borderless fullscreen and restore the previous maximised state. */
export async function exitBorderlessFullscreen(): Promise<void> {
	if (state === false) {
		publish(false);
		return;
	}
	const win = getCurrentWindow();
	lastToggleAt = Date.now();

	// Ordered, but without waiting for a frame in between: `setFullscreen(false)`
	// followed immediately by `maximize()` is the correct sequence and takes one
	// IPC round trip, so the restored (small) frame is not painted.
	await win.setFullscreen(false).catch((err) => {
		console.error("退出全屏失败", err);
	});
	if (wasMaximized) {
		await win.maximize().catch(() => undefined);
	}
	wasMaximized = false;

	// Wait until the window has actually reached its final size before
	// re-drawing the titlebar, otherwise the glyph and the 32px offset animate
	// in while the frame is still moving.
	await waitForState(false);
	await waitForResize();
	setSystemTitlebarFullscreen(false);
	await restoreTitlebarChrome(win);

	state = false;
	confirmed = true;
	publish(false);
}

export async function toggleBorderlessFullscreen(): Promise<void> {
	// Rapid key repeats must not interleave two async fullscreen transitions.
	if (toggling) return;
	toggling = true;
	try {
		if (state === null) state = await isActuallyFullscreen();
		if (state) {
			await exitBorderlessFullscreen();
		} else {
			await enterBorderlessFullscreen();
		}

		// Fullscreen is triggered from the keyboard, so the last focused button
		// keeps focus across the window state change and its tooltip re-opens by
		// itself. Drop that focus once the switch has settled.
		const active = document.activeElement;
		if (active instanceof HTMLElement && active.tagName === "BUTTON") {
			active.blur();
		}
	} catch (err) {
		console.error("切换无边框全屏失败", err);
	} finally {
		lastToggleAt = Date.now();
		toggling = false;
	}
}

export async function exitBorderlessFullscreenIfActive(): Promise<void> {
	if (state === null) state = await isActuallyFullscreen();
	if (!state) {
		publish(false);
		return;
	}
	try {
		await exitBorderlessFullscreen();
	} catch (err) {
		console.error("退出无边框全屏失败", err);
	}
}
