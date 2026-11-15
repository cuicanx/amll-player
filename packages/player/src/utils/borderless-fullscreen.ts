import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Borderless fullscreen for the F11 shortcut.
 *
 * On Windows / Linux the main window already uses decorations(false) with a
 * self-drawn titlebar, so "borderless fullscreen" is a combination of:
 *   - the Tauri window fullscreen flag
 *   - hiding the custom titlebar (setSystemTitlebarFullscreen)
 * When leaving fullscreen the custom titlebar has to be restored together
 * with its layout CSS variables and maximise glyph, otherwise the content
 * keeps a 32px offset or shows the wrong button state.
 *
 * Three Windows-specific details are handled here:
 *
 * 1. Going fullscreen from a *maximised* window leaves a taskbar-sized black
 *    strip at the bottom: the maximised frame still reserves the work-area
 *    and the client area is not recomputed after the style switch. Dropping
 *    the maximised state fixes the rect.
 * 2. The maximised state must be dropped and the fullscreen flag raised *in
 *    the same tick*. The previous version awaited two animation frames in
 *    between, so Windows painted the restored (smaller) window before going
 *    fullscreen - the visible "shrinks, then grows" jump. Leaving fullscreen
 *    had the mirror-image problem: `setFullscreen(false)` then `maximize()`
 *    with an await between them showed the small frame first.
 * 3. The old implementation covered the switch with a black overlay. That was
 *    the "black flash": it faded the whole window to black for 140 ms before
 *    and after every toggle. The overlay is gone. What remains is a
 *    single-frame state change (the same thing that happens when the user
 *    clicks maximise), which reads as instant rather than as a flash.
 */

let toggling = false;
/** Remember whether the window was maximised so leaving fullscreen restores it. */
let wasMaximized = false;

type AppWindow = ReturnType<typeof getCurrentWindow>;

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

export async function toggleBorderlessFullscreen(): Promise<void> {
	// Rapid key repeats must not interleave two async fullscreen transitions.
	if (toggling) return;
	toggling = true;
	try {
		const win = getCurrentWindow();
		const next = !(await win.isFullscreen());

		if (next) {
			wasMaximized = await win.isMaximized().catch(() => false);
			// Hide the titlebar buttons first so they do not stretch across the
			// top edge while the window grows.
			setSystemTitlebarFullscreen(true);
			// Both calls are dispatched back to back and awaited together: the
			// window is un-maximised and made fullscreen within one IPC round
			// trip, so no intermediate frame reaches the compositor.
			const unmaximize = wasMaximized ? win.unmaximize() : Promise.resolve();
			await Promise.all([
				unmaximize.catch(() => undefined),
				win.setFullscreen(true),
			]);
		} else {
			const restoreMaximize = wasMaximized
				? win.maximize().catch(() => undefined)
				: Promise.resolve();
			await Promise.all([
				win.setFullscreen(false).catch(() => undefined),
				restoreMaximize,
			]);
			wasMaximized = false;
			// Wait until the window has actually reached its final size before
			// re-drawing the titlebar, otherwise the glyph and the 32px offset
			// animate in while the frame is still moving.
			await waitForResize();
			setSystemTitlebarFullscreen(false);
			await restoreTitlebarChrome(win);
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
	if (!(await isBorderlessFullscreen())) return;
	try {
		const win = getCurrentWindow();
		const restoreMaximize = wasMaximized
			? win.maximize().catch(() => undefined)
			: Promise.resolve();
		await Promise.all([
			win.setFullscreen(false).catch(() => undefined),
			restoreMaximize,
		]);
		wasMaximized = false;
		await waitForResize();
		setSystemTitlebarFullscreen(false);
		await restoreTitlebarChrome(win);
	} catch (err) {
		console.error("退出无边框全屏失败", err);
	}
}
