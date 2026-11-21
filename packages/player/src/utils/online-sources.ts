/**
 * Storage for imported lx-music-desktop custom sources.
 *
 * Sources live in localStorage rather than on disk: they are small text files,
 * they belong to the frontend sandbox that executes them, and keeping them here
 * means importing/deleting never touches the music database.
 *
 * Two community sources ship with the app so online mode is usable out of the
 * box. They are seeded once and never re-added after the user deletes them.
 */
import { invoke } from "@tauri-apps/api/core";
import dujiaSource from "../assets/online-sources/dujia.js?raw";
import yehuaSource from "../assets/online-sources/yehua.js?raw";
import { type LxSourceInfo, parseScriptInfo } from "./lx-source-runtime.ts";

const STORAGE_KEY = "amll-player.onlineSources";
const SEEDED_KEY = "amll-player.onlineSourcesSeeded";

export interface StoredSource extends LxSourceInfo {
	id: string;
	enabled: boolean;
	builtin: boolean;
	addedAt: number;
}

/**
 * Sources sign requests with a hash of their own text, so line endings are part
 * of the identity. A Windows git checkout rewrites LF to CRLF, which silently
 * changed the hash and made the server answer "block ip" to every request.
 */
function normalizeScript(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

export const BUILTIN_SOURCES = [
	{ id: "builtin-dujia", label: "独家音源", raw: normalizeScript(dujiaSource) },
	{ id: "builtin-yehua", label: "野花音源", raw: normalizeScript(yehuaSource) },
];

function makeId() {
	return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function fromRaw(id: string, raw: string, builtin: boolean): StoredSource {
	const info = parseScriptInfo(raw);
	return {
		...info,
		id,
		enabled: true,
		builtin,
		addedAt: Date.now(),
	};
}

export function loadSources(): StoredSource[] {
	let list: StoredSource[] = [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) list = JSON.parse(raw) as StoredSource[];
	} catch {
		list = [];
	}

	if (!localStorage.getItem(SEEDED_KEY)) {
		for (const item of BUILTIN_SOURCES) {
			if (!list.some((s) => s.id === item.id)) {
				list.push(fromRaw(item.id, item.raw, true));
			}
		}
		localStorage.setItem(SEEDED_KEY, "1");
		saveSources(list);
	}

	// Built-in sources must always run the script that shipped with this build.
	// A stored copy can come from an older build, and a source signs its
	// requests with a hash of its own text: a stale copy silently makes every
	// request look forged to the server.
	for (const item of BUILTIN_SOURCES) {
		const stored = list.find((s) => s.id === item.id);
		if (stored && stored.rawScript !== item.raw) {
			stored.rawScript = item.raw;
			const info = parseScriptInfo(item.raw);
			stored.name = info.name;
			stored.description = info.description;
			stored.version = info.version;
			stored.author = info.author;
			stored.homepage = info.homepage;
			saveSources(list);
		}
	}

	return list;
}

export function saveSources(list: StoredSource[]): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Import from raw script text. Throws when the header block is unusable. */
export function importSource(raw: string): StoredSource {
	const info = parseScriptInfo(raw);
	if (!info.name || info.name === "未命名音源") {
		throw new Error("无法识别该文件：缺少 @name 说明块，可能不是洛雪音源脚本");
	}
	if (!raw.includes("globalThis.lx") && !raw.includes("lx.EVENT_NAMES")) {
		throw new Error("脚本没有使用 globalThis.lx 接口，无法作为洛雪音源运行");
	}
	const list = loadSources();
	const existing = list.find((s) => s.rawScript === raw);
	if (existing) {
		existing.enabled = true;
		saveSources(list);
		return existing;
	}
	const source = fromRaw(makeId(), raw, false);
	list.push(source);
	saveSources(list);
	return source;
}

export function updateSource(id: string, patch: Partial<StoredSource>): StoredSource[] {
	const list = loadSources().map((s) => (s.id === id ? { ...s, ...patch } : s));
	saveSources(list);
	return list;
}

export function removeSource(id: string): StoredSource[] {
	const list = loadSources().filter((s) => s.id !== id);
	saveSources(list);
	return list;
}

/** Re-add the two bundled sources if the user removed them. */
export function restoreBuiltinSources(): StoredSource[] {
	const list = loadSources();
	for (const item of BUILTIN_SOURCES) {
		const existing = list.find((s) => s.id === item.id);
		if (existing) {
			existing.enabled = true;
		} else {
			list.push(fromRaw(item.id, item.raw, true));
		}
	}
	saveSources(list);
	return list;
}

/**
 * LX stores each imported source as `gz_` + base64(zlib). Inflate it back to
 * text so the exact script the user already trusts can be imported.
 */
async function inflateStoredScript(stored: string): Promise<string | null> {
	if (!stored) return null;
	if (!stored.startsWith("gz_")) return stored;
	try {
		const binary = atob(stored.slice(3));
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		const stream = new Blob([bytes as unknown as BlobPart])
			.stream()
			.pipeThrough(new DecompressionStream("deflate"));
		const out = new Uint8Array(await new Response(stream).arrayBuffer());
		return new TextDecoder("utf-8").decode(out);
	} catch {
		return null;
	}
}

/**
 * Import every custom source already installed in the local lx-music-desktop.
 *
 * This is the most reliable way to get a *working* source: the user's LX has
 * already proven those scripts load, and we skip the guesswork of finding a
 * download link whose server still answers.
 */
export async function importFromLxMusic(): Promise<{ imported: number; skipped: number }> {
	const raw = await invoke<string>("lx_sources_raw");
	const data = JSON.parse(raw) as { userApis?: { script?: string }[] };
	const list = data.userApis ?? [];
	let imported = 0;
	let skipped = 0;

	for (const api of list) {
		const text = await inflateStoredScript(api.script ?? "");
		if (!text) {
			skipped++;
			continue;
		}
		try {
			importSource(text);
			imported++;
		} catch {
			skipped++;
		}
	}
	return { imported, skipped };
}
