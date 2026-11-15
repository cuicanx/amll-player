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
 * Keep this logic in one place so the F11 shortcut and the right-click menu
 * cannot drift apart.
 */

let toggling = false;

type AppWindow = ReturnType<typeof getCurrentWindow>;

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
		await win.setFullscreen(next);
		setSystemTitlebarFullscreen(next);
		if (!next) await restoreTitlebarChrome(win);
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
		await win.setFullscreen(false);
		setSystemTitlebarFullscreen(false);
		await restoreTitlebarChrome(win);
	} catch (err) {
		console.error("退出无边框全屏失败", err);
	}
}
