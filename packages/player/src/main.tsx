import "./styles.css";
import "react-toastify/dist/ReactToastify.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { Provider } from "jotai";
import { createRoot } from "react-dom/client";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import "./i18n";
import { toError } from "./utils/error.ts";
import "./utils/player";
import {
	initWindowResizeHandling,
	markWindowResizing,
} from "./utils/window-resize.ts";
import App from "./App.tsx";

const ErrorRender = (props: FallbackProps) => {
	console.error(props.error);
	const normalizedError = toError(props.error);

	return (
		<div>
			<h2>An unrecoverable error has occured</h2>
			<code>
				<pre>
					{normalizedError.message}
					{"\n"}
					{normalizedError.stack}
				</pre>
			</code>
		</div>
	);
};

// Desktop-only window chrome. Mobile WebViews have no resizable window and
// calling getCurrentWindow()/maximize() there throws at module load time.
if (!["android", "ios"].includes(platform())) {
	addEventListener("on-system-titlebar-click-close", async () => {
		const win = getCurrentWindow();
		await win.close();
	});

	addEventListener("on-system-titlebar-click-resize", async () => {
		const win = getCurrentWindow();
		if (await win.isMaximizable()) {
			if (await win.isMaximized()) {
				await win.unmaximize();
				setSystemTitlebarResizeAppearance(
					SystemTitlebarResizeAppearance.Maximize,
				);
			} else {
				await win.maximize();
				setSystemTitlebarResizeAppearance(
					SystemTitlebarResizeAppearance.Restore,
				);
			}
		}
	});

	const win = getCurrentWindow();
	async function checkWindow() {
		if (await win.isMaximized()) {
			setSystemTitlebarResizeAppearance(SystemTitlebarResizeAppearance.Restore);
		} else {
			setSystemTitlebarResizeAppearance(SystemTitlebarResizeAppearance.Maximize);
		}
	}
	void checkWindow();
	initWindowResizeHandling();
	// PERF: onResized fires at drag frequency. Mark the document so CSS can drop
	// layout transitions while dragging, and coalesce the async isMaximized()
	// check to one run after the drag settles.
	let resizeSettleTimer: ReturnType<typeof setTimeout>;
	win.onResized(() => {
		markWindowResizing();
		clearTimeout(resizeSettleTimer);
		resizeSettleTimer = setTimeout(() => void checkWindow(), 120);
	});

	addEventListener("on-system-titlebar-click-minimize", async () => {
		const win = getCurrentWindow();
		await win.minimize();
	});
}

/**
 * Run the scheduled online-cache cleanup once per application start.
 *
 * The interval itself lives in a persisted atom, so it survives restarts and
 * applies to new installs too (3 days by default). Doing the work here - once
 * at boot - avoids a background timer that would keep running for the whole
 * session. Failures are ignored: a cleanup problem must never block startup.
 */
void (async () => {
	try {
		const raw = localStorage.getItem("amll-player.autoClearCacheDays");
		const days = raw ? Number(JSON.parse(raw)) : 3;
		if (!Number.isFinite(days) || days <= 0) return;
		const { autoCleanOnlineCache } = await import("./utils/online-api.ts");
		await autoCleanOnlineCache(days);
	} catch {
		// Best-effort only.
	}
})();

createRoot(document.getElementById("root") as HTMLElement).render(
	<ErrorBoundary fallbackRender={ErrorRender}>
		<Provider>
			<App />
		</Provider>
	</ErrorBoundary>,
);
