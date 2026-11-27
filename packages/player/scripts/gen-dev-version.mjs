// 按照原版本号 + -dev. + 开发分支名 + . + git提交次数 生成开发版本号
// 最后写入到 ./src-tauri/tauri.conf.json 中
// git rev-list --count HEAD

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { exit } from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauriConfPath = resolve(here, "../src-tauri/tauri.conf.json");
// Single source of truth. Dev and stable must share major.minor so the
// updater can compare versions across both channels; only the patch/build
// number differs (commit count for dev, explicit patch for stable).
const versionDocPath = resolve(here, "../../../version.json");

console.log("Reading tauri.conf.json from", tauriConfPath);

const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf-8"));
const versionDoc = JSON.parse(readFileSync(versionDocPath, "utf-8"));

const baseVersion = versionDoc?.version;

if (typeof baseVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(baseVersion)) {
	console.error(`Invalid version in version.json: ${baseVersion}`);
	exit(1);
}

// const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
const commitCount = execSync("git rev-list --count HEAD").toString().trim();

const isIos = process.env.AMLL_IOS_BUILD === "true";

if (isIos) {
	// iOS：版本号严格保持 3 位，构建号单独写入 bundle.iOS.bundleVersion
	tauriConf.version = baseVersion;
	if (!tauriConf.bundle) tauriConf.bundle = {};
	if (!tauriConf.bundle.iOS) tauriConf.bundle.iOS = {};
	tauriConf.bundle.iOS.bundleVersion = commitCount;
	console.log(`Generated iOS dev version: ${baseVersion} (${commitCount})`);
} else {
	// 其它平台：用 commit 次数作为 patch 号。
	//
	// 这里曾经写成 baseVersion 后面接 "+" 再接 commit 次数（例如 0.0.1+1143）。
	// semver 规定 `+` 之后是 build metadata，**不参与版本比较**，所以
	// `0.0.1+1143` 和 `0.0.1+1137` 被判为同一版本：updater 永远认为没有
	// 新版本，用户手动装完新包后仍被提示/或完全收不到提示，表现为
	// “下载了也装不上、反复卡在同一步”。改成把 commit 次数放进 patch
	// 位（0.0.1143 -> 0.0.1144）后，版本才单调递增且可比较。
	const [major, minor] = baseVersion.split(".");
	const devVersion = `${major}.${minor}.${commitCount}`;
	tauriConf.version = devVersion;
	console.log(`Generated dev version: ${baseVersion} -> ${devVersion}`);
}

writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, "\t"));
