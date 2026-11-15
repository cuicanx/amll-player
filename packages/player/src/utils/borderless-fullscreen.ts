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
 * Two Windows-specific details are handled here:
 *
 * 1. Going fullscreen from a *maximised* window leaves a taskbar-sized black
 *    strip at the bottom: the maximised frame still reserves the work-area
 *    and the client area is not recomputed after the style switch. Dropping
 *    the maximised state first and letting the window settle for two frames
 *    makes Windows compute a correct fullscreen rect.
 * 2. The native state switch has no animation, which reads as an abrupt jump.
 *    A short black fade covers the switch; it is a plain composited layer
 *    (opacity only), so it costs nothing in frame time.
 */

const FADE_MS = 140;
const MASK_ID = "amll-window-transition-mask";

let toggling = false;
/** Remember whether the window was maximised so leaving fullscreen restores it. */
let wasMaximized = false;

type AppWindow = ReturnType<typeof getCurrentWindow>;

function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	});
}

function ensureMask(): HTMLDivElement {
	let mask = document.getElementById(MASK_ID) as HTMLDivElement | null;
	if (!mask) {
		mask = document.createElement("div");
		mask.id = MASK_ID;
		mask.style.cssText = [
			"position:fixed",
			"inset:0",
			"z-index:2147483647",
			"pointer-events:none",
			"background:#000",
			"opacity:0",
			`transition:opacity ${FADE_MS}ms ease`,
			"will-change:opacity",
		].join(";");
		document.body.appendChild(mask);
	}
	return mask;
}

async function fadeMask(to: number): Promise<void> {
	const mask = ensureMask();
	// Force a style flush so the transition runs even on the very first toggle.
	void mask.offsetHeight;
	mask.style.opacity = String(to);
	await new Promise((resolve) => window.setTimeout(resolve, FADE_MS));
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

		// Fade to black first so the native state switch is never visible.
		await fadeMask(1);

		if (next) {
			wasMaximized = await win.isMaximized().catch(() => false);
			if (wasMaximized) {
				// Drop the maximised frame first, otherwise the fullscreen
				// client area keeps the work-area height (black taskbar strip).
				await win.unmaximize();
				await nextFrame();
			}
			await win.setFullscreen(true);
			setSystemTitlebarFullscreen(true);
		} else {
			await win.setFullscreen(false);
			setSystemTitlebarFullscreen(false);
			if (wasMaximized) {
				await win.maximize().catch(() => undefined);
				wasMaximized = false;
				await nextFrame();
			}
			await restoreTitlebarChrome(win);
		}

		await nextFrame();
		await fadeMask(0);
	} catch (err) {
		console.error("切换无边框全屏失败", err);
		// Never leave the mask covering the window if the switch failed.
		await fadeMask(0);
	} finally {
		toggling = false;
	}
}

export async function exitBorderlessFullscreenIfActive(): Promise<void> {
	if (!(await isBorderlessFullscreen())) return;
	try {
		const win = getCurrentWindow();
		await win.setFullscreen(false);
		setSystemTitlebarFullscreen(false);
		if (wasMaximized) {
			await win.maximize().catch(() => undefined);
			wasMaximized = false;
		}
		await restoreTitlebarChrome(win);
	} catch (err) {
		console.error("退出无边框全屏失败", err);
	}
}
