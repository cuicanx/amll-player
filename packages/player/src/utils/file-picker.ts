import { invoke } from "@tauri-apps/api/core";
/**
 * Native-browser file picking that does not go through Tauri's dialog plugin.
 *
 * Why: on Windows the dialog plugin runs a blocking native picker from an
 * async IPC command and sets the parent HWND of our borderless, dynamically
 * recreated main window. That HWND is not always valid, so the picker never
 * shows and the app looks frozen (plus a Windows error chime). A hidden
 * <input type="file"> has no parent-window dependency and works on desktop,
 * Android and iOS alike.
 *
 * NOTE: the browser only gives us File objects, not disk paths. Use this for
 * callers that need the file CONTENT. Folder picking needs a path and is
 * handled separately with a Rust command (pickFolder).
 */
export interface PickedFile {
	name: string;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

let pending: ((files: PickedFile[] | null) => void) | null = null;

function sharedInput(): HTMLInputElement {
	let input = document.getElementById("amll-file-picker") as HTMLInputElement | null;
	if (!input) {
		input = document.createElement("input");
		input.id = "amll-file-picker";
		input.type = "file";
		input.style.display = "none";
		document.body.appendChild(input);
		input.onchange = () => {
			const done = pending;
			pending = null;
			const files = Array.from(input?.files ?? []).map((f) => ({
				name: f.name,
				text: () => f.text(),
				arrayBuffer: () => f.arrayBuffer(),
			}));
			done?.(files.length ? files : null);
		};
		input.oncancel = () => {
			const done = pending;
			pending = null;
			done?.(null);
		};
	}
	return input;
}

/** Open a file picker. Resolves with null when the user cancels. */
export function pickFiles(opts?: {
	accept?: string;
	multiple?: boolean;
}): Promise<PickedFile[] | null> {
	// Cancel any abandoned picker first.
	pending?.(null);
	const input = sharedInput();
	input.accept = opts?.accept ?? "";
	input.multiple = opts?.multiple ?? false;
	input.value = "";
	return new Promise((resolve) => {
		pending = resolve;
		input.click();
	});
}

/** Convenience: pick a single file and read it as text. */
export async function pickTextFile(opts?: {
	accept?: string;
}): Promise<{ name: string; content: string } | null> {
	const files = await pickFiles({ ...opts, multiple: false });
	if (!files?.length) return null;
	return { name: files[0].name, content: await files[0].text() };
}

// --- Path-based picking via our own Rust commands -------------------------
// These do NOT call set_parent(window), which is what makes the plugin dialog
// hang with our borderless/recreated main window on Windows.

interface PickResult {
    paths: string[];
}

async function invokePick(
    command: "pick_folder" | "pick_files" | "save_file",
    args: Record<string, unknown>,
): Promise<string | string[] | null> {
    const result = await invoke<PickResult>(command, args);
    if (!result.paths.length) return null;
    return command === "pick_files" && args.multiple
        ? result.paths
        : result.paths[0];
}

/** Pick a folder path. Returns null when cancelled. */
export function pickFolderPath(title?: string): Promise<string | null> {
    return invokePick("pick_folder", { title: title ?? null }) as Promise<string | null>;
}

/** Pick file path(s). Returns null when cancelled. */
export function pickFilePaths(opts?: {
    title?: string;
    multiple?: boolean;
    extensions?: string[];
}): Promise<string | string[] | null> {
    return invokePick("pick_files", {
        title: opts?.title ?? null,
        multiple: opts?.multiple ?? false,
        extensions: opts?.extensions ?? [],
    });
}

/** Ask for a destination path to save a file. */
export function pickSavePath(opts?: {
    title?: string;
    fileName?: string;
    extensions?: string[];
}): Promise<string | null> {
    return invokePick("save_file", {
        title: opts?.title ?? null,
        fileName: opts?.fileName ?? null,
        extensions: opts?.extensions ?? [],
    }) as Promise<string | null>;
}
