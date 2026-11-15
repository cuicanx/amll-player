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
 *     window to the whole monitor (taskbar included) and drops the frame, and
 *   - the self-drawn titlebar is hidden, because the main window already runs
 *     with `decorations: false`.
 *
 * It is deliberately NOT "maximise the window": a maximised window keeps the
 * work-area reservation (a taskbar-high strip), which is a different thing and
 * would leave the taskbar visible.
 *
 * Two Windows-specific details are handled here:
 *
 * 1. Going fullscreen from a *maximised* window leaves a taskbar-sized black
 *    strip at the bottom: the maximised frame still reserves the work-area and
 *    the client area is not recomputed after the style switch. Dropping the
 *    maximised state first fixes the rect.
 * 2. The maximised state must be dropped and the fullscreen flag raised *in the
 *    same tick*. Awaiting an animation frame in between let Windows paint the
 *    restored (smaller) window first - the visible "shrinks, then grows" jump.
 *    Leaving fullscreen had the mirror-image problem.
 *
 * An earlier version also covered the switch with a black overlay; that overlay
 * was the "black flash" users saw, so it is gone. What remains is a single
 * frame state change, the same thing that happens when the user clicks
 * maximise.
 */

let toggling = false;
/** Remember whether the window was maximised so leaving fullscreen restores it. */
let wasMaximized = false;

type AppWindow = ReturnType<typeof getCurrentWindow>;

/** Shares the app's default jotai store (the app renders a bare <Provider>). */
const store = getDefaultStore();

function publish(isFullscreen: boolean): void {
	store.set(borderlessFullscreenAtom, isFullscreen);
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
	try {
		return await getCurrentWindow().isFullscreen();
	} catch {
		return false;
	}
}

/**
 * Re-read the native state and publish it. Called when the context menu opens
 * so the entry can never show a stale label (e.g. if the window was put into
 * fullscreen by something outside this module).
 */
export async function syncBorderlessFullscreenState(): Promise<boolean> {
	const state = await isBorderlessFullscreen();
	publish(state);
	return state;
}

/** Enter borderless fullscreen. No-op when already fullscreen. */
export async function enterBorderlessFullscreen(): Promise<void> {
	const win = getCurrentWindow();
	if (await win.isFullscreen()) {
		publish(true);
		return;
	}
	wasMaximized = await win.isMaximized().catch(() => false);
	// Hide the titlebar buttons first so they do not stretch across the top
	// edge while the window grows.
	setSystemTitlebarFullscreen(true);
	// Both calls are dispatched back to back and awaited together: the window is
	// un-maximised and made fullscreen within one IPC round trip, so no
	// intermediate frame reaches the compositor.
	const unmaximize = wasMaximized ? win.unmaximize() : Promise.resolve();
	await Promise.all([unmaximize.catch(() => undefined), win.setFullscreen(true)]);
	publish(true);
}

/** Leave borderless fullscreen and restore the previous maximised state. */
export async function exitBorderlessFullscreen(): Promise<void> {
	const win = getCurrentWindow();
	if (!(await win.isFullscreen())) {
		publish(false);
		return;
	}
	const restoreMaximize = wasMaximized
		? win.maximize().catch(() => undefined)
		: Promise.resolve();
	await Promise.all([
		win.setFullscreen(false).catch(() => undefined),
		restoreMaximize,
	]);
	wasMaximized = false;
	publish(false);
	// Wait until the window has actually reached its final size before
	// re-drawing the titlebar, otherwise the glyph and the 32px offset animate
	// in while the frame is still moving.
	await waitForResize();
	setSystemTitlebarFullscreen(false);
	await restoreTitlebarChrome(win);
}

export async function toggleBorderlessFullscreen(): Promise<void> {
	// Rapid key repeats must not interleave two async fullscreen transitions.
	if (toggling) return;
	toggling = true;
	try {
		const win = getCurrentWindow();
		if (await win.isFullscreen()) {
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
		toggling = false;
	}
}

export async function exitBorderlessFullscreenIfActive(): Promise<void> {
	if (!(await isBorderlessFullscreen())) {
		publish(false);
		return;
	}
	try {
		await exitBorderlessFullscreen();
	} catch (err) {
		console.error("退出无边框全屏失败", err);
	}
}
