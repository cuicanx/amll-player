// Single source of truth: ../version.json -> package.json, tauri.conf.json,
// src-tauri/Cargo.toml. Run from anywhere; paths are resolved relative to this
// script so CI can call it from the repository root.
//
// Usage:
//   node scripts/sync-version.mjs            # write the stable version from version.json
//   node scripts/sync-version.mjs --check    # verify the three files match version.json
//
// `gen-dev-version.mjs` reads the SAME version.json and derives the dev build
// number from it, so major/minor never diverge between dev and stable again.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../.."); // v2-custom/
const player = resolve(here, ".."); // packages/player/

const versionPath = resolve(root, "version.json");
const versionDoc = JSON.parse(readFileSync(versionPath, "utf8"));
const version = versionDoc?.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(`Invalid version in version.json: ${version}`);
	process.exit(1);
}

const targets = [
	{
		name: "package.json",
		path: resolve(player, "package.json"),
		read: (text) => JSON.parse(text),
		write: (doc) => {
			doc.version = version;
			return `${JSON.stringify(doc, null, "\t")}\n`;
		},
		get: (doc) => doc.version,
	},
	{
		name: "tauri.conf.json",
		path: resolve(player, "src-tauri/tauri.conf.json"),
		read: (text) => JSON.parse(text),
		write: (doc) => {
			doc.version = version;
			return `${JSON.stringify(doc, null, "\t")}\n`;
		},
		get: (doc) => doc.version,
	},
	{
		name: "Cargo.toml",
		path: resolve(player, "src-tauri/Cargo.toml"),
		read: (text) => text,
		write: (text) =>
			text.replace(/^version = "[^"]*"/m, `version = "${version}"`),
		get: (text) => /^version = "([^"]*)"/m.exec(text)?.[1],
	},
];

const checkOnly = process.argv.includes("--check");
let mismatch = false;
for (const t of targets) {
	const raw = readFileSync(t.path, "utf8");
	const doc = t.read(raw);
	const current = t.get(doc);
	if (checkOnly) {
		const ok = current === version;
		if (!ok) mismatch = true;
		console.log(`${ok ? "OK  " : "DIFF"} ${t.name}: ${current} (expected ${version})`);
	} else {
		writeFileSync(t.path, t.write(doc));
		console.log(`${t.name}: ${current} -> ${version}`);
	}
}

if (checkOnly && mismatch) process.exit(1);
console.log(checkOnly ? "Version sources are in sync." : `Synced version ${version} from version.json.`);
