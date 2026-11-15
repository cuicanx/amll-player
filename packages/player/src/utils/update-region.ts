/**
 * Egress-region detection for the update / contributor loaders.
 *
 * The app ships mirror-first endpoints because most users are in mainland
 * China, where `github.com` and especially `release-assets.githubusercontent.com`
 * are unreliable. That default is wrong for someone running a VPN whose exit
 * node is *outside* China: for them the official source is the fast one and the
 * proxy is an unnecessary hop.
 *
 * So the region is decided from the public egress IP, not from the machine's
 * locale: several geo endpoints are raced at once and whichever answers first
 * wins. Using the IP keeps it correct behind a tunnel (the exit node decides),
 * and the cache avoids probing on every check.
 *
 * When every probe fails the answer is `"cn"`: the mirror is the safer default
 * (it also works abroad, just less directly), and the endpoint lists keep the
 * official source as a fallback either way.
 */
export type UpdateRegion = "cn" | "global";

const CACHE_KEY = "amll-player.updateRegion";
const CACHE_TTL = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT = 2600;

interface CachedRegion {
	region: UpdateRegion;
	at: number;
}

interface Probe {
	url: string;
	pick: (payload: string) => string | null;
}

const PROBES: Probe[] = [
	{
		// Reachable almost everywhere and answers with `loc=CN`.
		url: "https://www.cloudflare.com/cdn-cgi/trace",
		pick: (text) => /(?:^|\n)loc=([A-Za-z]{2})/.exec(text)?.[1] ?? null,
	},
	{
		url: "https://ipapi.co/country/",
		pick: (text) => {
			const code = text.trim();
			return /^[A-Za-z]{2}$/.test(code) ? code : null;
		},
	},
	{
		url: "https://api.ip.sb/geoip",
		pick: (text) => {
			try {
				const data = JSON.parse(text) as { country_code?: string };
				return data.country_code ?? null;
			} catch {
				return null;
			}
		},
	},
	{
		// Domestic service: usually the fastest probe inside China.
		url: "https://myip.ipip.net/json",
		pick: (text) => {
			try {
				const data = JSON.parse(text) as {
					data?: { location?: string[] };
				};
				const country = data.data?.location?.[0];
				if (!country) return null;
				return country === "中国" ? "CN" : "XX";
			} catch {
				return null;
			}
		},
	},
];

let inflight: Promise<UpdateRegion> | null = null;

function readCache(): UpdateRegion | null {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as CachedRegion;
		if (parsed?.region !== "cn" && parsed?.region !== "global") return null;
		if (Date.now() - parsed.at > CACHE_TTL) return null;
		return parsed.region;
	} catch {
		return null;
	}
}

function writeCache(region: UpdateRegion): void {
	try {
		localStorage.setItem(
			CACHE_KEY,
			JSON.stringify({ region, at: Date.now() } satisfies CachedRegion),
		);
	} catch {
		/* storage full / disabled - the region is simply re-detected next time */
	}
}


/** Last known region without waiting for a probe (for synchronous callers). */
export function peekUpdateRegion(): UpdateRegion {
	return readCache() ?? "cn";
}

/**
 * Detect the current egress region. Cached for six hours; pass `force` after
 * the user clearly changed networks (e.g. retrying a failed download).
 */
export async function detectUpdateRegion(force = false): Promise<UpdateRegion> {
	if (!force) {
		const cached = readCache();
		if (cached) return cached;
	}
	if (inflight) return inflight;

	inflight = (async (): Promise<UpdateRegion> => {
		const controllers: AbortController[] = [];
		const attempt = async (probe: Probe, index: number): Promise<UpdateRegion> => {
			// A single AbortController per probe: it both enforces the timeout and
			// lets the winner cancel the probes that are still in flight.
			const controller = new AbortController();
			controllers[index] = controller;
			const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT);
			try {
				const response = await fetch(probe.url, {
					signal: controller.signal,
					cache: "no-store",
					headers: { Accept: "application/json, text/plain, */*" },
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const code = probe.pick(await response.text());
				if (!code) throw new Error("unrecognised geo response");
				return code.toUpperCase() === "CN" ? "cn" : "global";
			} finally {
				window.clearTimeout(timer);
			}
		};

		try {
			const region = await Promise.any(PROBES.map(attempt));
			// Stop the slower probes: their result is no longer needed.
			for (const controller of controllers) controller?.abort();
			writeCache(region);
			return region;
		} catch {
			return "cn";
		} finally {
			inflight = null;
		}
	})();

	return inflight;
}

/** Rewrites a GitHub asset URL (avatar, release file) through the mirror. */
export function mirrorUrl(url: string): string {
	if (!url) return url;
	if (url.startsWith("https://gh-proxy.com/")) return url;
	return `https://gh-proxy.com/${url}`;
}

/**
 * Ordered candidate URLs for a GitHub resource. The region decides which one
 * is tried first; the other stays as a fallback so a single dead transport
 * never breaks avatars or the contributor list.
 */
export function regionOrdered(urls: string[], region: UpdateRegion): string[] {
	const mirrored = urls.filter((url) => url.startsWith("https://gh-proxy.com/"));
	const direct = urls.filter((url) => !url.startsWith("https://gh-proxy.com/"));
	const directViaMirror = direct.map(mirrorUrl);
	return region === "global"
		? [...direct, ...mirrored, ...directViaMirror]
		: [...mirrored, ...directViaMirror, ...direct];
}
