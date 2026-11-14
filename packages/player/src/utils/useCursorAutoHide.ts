import { useEffect, useState } from "react";

export function useCursorAutoHide(enabled: boolean, delay = 1200) {
	const [hidden, setHidden] = useState(false);

	useEffect(() => {
		if (!enabled) {
			setHidden(false);
			return;
		}

		let timerId: ReturnType<typeof setTimeout>;
		let rafId = 0;
		let pending = false;

		// PERF: mousemove fires far more often than frames, and this hook is
		// mounted on the full-screen lyric page where every re-render
		// reconciles the heavy PrebuiltLyricPlayer subtree. Coalesce all
		// pointer activity within a frame into one state update.
		const bump = () => {
			if (pending) return;
			pending = true;
			rafId = requestAnimationFrame(() => {
				pending = false;
				clearTimeout(timerId);
				setHidden((wasHidden) => (wasHidden ? false : wasHidden));
				timerId = setTimeout(() => setHidden(true), delay);
			});
		};

		bump();

		window.addEventListener("mousemove", bump, { passive: true });
		window.addEventListener("mousedown", bump, { passive: true });
		return () => {
			clearTimeout(timerId);
			cancelAnimationFrame(rafId);
			window.removeEventListener("mousemove", bump);
			window.removeEventListener("mousedown", bump);
			setHidden(false);
		};
	}, [enabled, delay]);

	return hidden;
}
