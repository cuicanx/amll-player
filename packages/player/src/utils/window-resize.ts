/**
 * Shared window-resize coordination.
 *
 * While the user drags a window edge, Tauri emits onResized very frequently.
 * Several parts of the UI animate layout properties (padding, gap, width) and
 * read layout in ResizeObservers. Keeping transitions alive during the drag
 * makes content lag behind the window edge and causes flicker; we mark the
 * document as "resizing" for the duration of the drag so CSS can suppress
 * transitions, then restore normal behaviour shortly after it settles.
 */
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let rafId = 0;
let active = false;
let initialized = false;

function scheduleStop() {
	if (rafId) return;
	rafId = requestAnimationFrame(() => {
		rafId = 0;
		clearTimeout(stopTimer);
		stopTimer = setTimeout(() => {
			active = false;
			delete document.documentElement.dataset.resizing;
		}, 120);
	});
}

/** Call from every onResized handler. Cheap enough to run at drag frequency. */
export function markWindowResizing() {
	active = true;
	document.documentElement.dataset.resizing = "1";
	scheduleStop();
}

/** Guard against a stale flag if a drag is interrupted. */
export function initWindowResizeHandling() {
	if (initialized) return;
	initialized = true;
	const clear = () => {
		clearTimeout(stopTimer);
		cancelAnimationFrame(rafId);
		rafId = 0;
		active = false;
		delete document.documentElement.dataset.resizing;
	};
	window.addEventListener("blur", clear, { passive: true });
	window.addEventListener("pointerup", clear, { passive: true });
}

export function isWindowResizing() {
	return active;
}
