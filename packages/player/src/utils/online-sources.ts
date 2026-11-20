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

export const BUILTIN_SOURCES = [
	{ id: "builtin-dujia", label: "独家音源", raw: dujiaSource },
	{ id: "builtin-yehua", label: "野花音源", raw: yehuaSource },
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
