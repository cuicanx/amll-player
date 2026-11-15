/**
 * Access to the running lyric player instance.
 *
 * `@applemusic-like-lyrics/core` exposes a public `resetScroll()` whose whole
 * purpose is "the user finished scrolling but the lyrics did not come back -
 * put them back now" (see LyricPlayerBase#resetScroll in 0.6.x). Its built-in
 * resume path is much narrower: it only re-aligns when the *current line
 * changes* and that line is still inside the render range, so scrolling far
 * enough away leaves the view stranded until the song reaches a line that is
 * still rendered - which may never happen.
 *
 * The player instance is reachable through the React tree, but the wrapper we
 * use (`PrebuiltLyricPlayer`) does not forward its ref, so there is no public
 * handle. We therefore look it up from the DOM node via React's fiber, with a
 * strict duck-type check (`resetScroll` + `getLyricLines`) so we can only ever
 * return the real player. Every step is guarded: if React changes its internals
 * the lookup simply returns null and the caller does nothing.
 */

interface ResettableLyricPlayer {
	resetScroll: () => void;
	getLyricLines: () => unknown;
}

const FIBER_KEY_PREFIX = "__reactFiber$";
const MAX_FIBER_HOPS = 60;
const MAX_HOOK_STEPS = 60;

function isLyricPlayer(value: unknown): value is ResettableLyricPlayer {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.resetScroll === "function" &&
		typeof candidate.getLyricLines === "function"
	);
}

type FiberLike = {
	stateNode?: unknown;
	memoizedState?: unknown;
	return?: FiberLike | null;
};

type HookLike = { memoizedState?: unknown; next?: HookLike | null };

function fromHooks(fiber: FiberLike): ResettableLyricPlayer | null {
	let hook = fiber.memoizedState as HookLike | null | undefined;
	let steps = 0;
	while (hook && steps++ < MAX_HOOK_STEPS) {
		const state = hook.memoizedState;
		if (isLyricPlayer(state)) return state;
		// useRef stores `{ current: value }`
		if (state && typeof state === "object" && isLyricPlayer((state as { current?: unknown }).current)) {
			return (state as { current: ResettableLyricPlayer }).current;
		}
		hook = hook.next;
	}
	return null;
}

/**
 * Finds the live lyric player that owns `root`, or null when it cannot be
 * resolved (never throws).
 */
export function findLyricPlayer(
	root: HTMLElement | null,
): ResettableLyricPlayer | null {
	if (!root || typeof root !== "object") return null;
	try {
		const fiberKey = Object.keys(root).find((key) =>
			key.startsWith(FIBER_KEY_PREFIX),
		);
		if (!fiberKey) return null;

		let fiber = (root as unknown as Record<string, unknown>)[fiberKey] as
			| FiberLike
			| undefined;
		let hops = 0;
		while (fiber && hops++ < MAX_FIBER_HOPS) {
			if (isLyricPlayer(fiber.stateNode)) return fiber.stateNode;
			const fromHook = fromHooks(fiber);
			if (fromHook) return fromHook;
			fiber = fiber.return ?? undefined;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Puts the lyric view back on the line that is currently playing.
 * Returns true when a player was found and asked to reset.
 */
export function resetLyricScroll(root: HTMLElement | null): boolean {
	const player = findLyricPlayer(root);
	if (!player) return false;
	try {
		player.resetScroll();
		return true;
	} catch {
		return false;
	}
}
