import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { platform, version } from "@tauri-apps/plugin-os";
import { useStore } from "jotai";
import { useEffect, useRef } from "react";
import semverGt from "semver/functions/gt";
import { hasBackgroundAtom } from "../states/appAtoms";

/** Resolve after the browser has actually painted a frame (with a hard cap). */
function waitForFirstPaint(): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};
		// A hidden webview may throttle rAF, so never wait indefinitely.
		const fallback = setTimeout(finish, 300);
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				clearTimeout(fallback);
				finish();
			}),
		);
	});
}

export const useInitializeWindow = () => {
	const store = useStore();
	const isInitializedRef = useRef(false);

	useEffect(() => {
		const initializeWindow = async () => {
			if (isInitializedRef.current) return;
			isInitializedRef.current = true;

			try {
				const appWindow = getCurrentWindow();

				// The window starts hidden. Wait until React has committed and the
				// browser has painted before making it visible, so the user never
				// sees an empty frame. index.html already paints an opaque
				// first-frame background as a second layer of protection.
				await waitForFirstPaint();

				if (platform() === "windows" && !semverGt(version(), "10.0.22000")) {
					store.set(hasBackgroundAtom, true);
					await appWindow.clearEffects();
				}

				if (platform() === "windows") {
					const enabled =
						localStorage.getItem("amll-player.enableAlwaysOnTop") === "true";
					invoke("set_window_always_on_top", { enabled }).catch((err) => {
						console.error("同步窗口置顶状态失败", err);
					});
				}

				await appWindow.show();
			} catch (err) {
				console.error("初始化窗口失败:", err);
				// Never leave the window hidden if anything above failed.
				try {
					await getCurrentWindow().show();
				} catch {
					// ignore
				}
			} finally {
				document.documentElement.dataset.appReady = "1";
			}
		};

		initializeWindow();
	}, [store]);
};
