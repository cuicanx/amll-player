// Generate latest-mirror.json from a release's official latest.json.
// The mirror rewrites every platform's download URL to a gh-proxy direct link,
// while keeping the ORIGINAL signature bytes (so verification still passes).
//
// Run from the repository root with:
//   TAG=<release-tag> node scripts/gen-mirror-manifest.mjs
// Requires GH_TOKEN in the environment (carries the workflow's GITHUB_TOKEN).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const repo = process.env.REPO;
const tag = process.env.TAG;
if (!repo || !tag) throw new Error("REPO and TAG env vars are required");

const src = JSON.parse(readFileSync("latest.json", "utf8"));
const rel = JSON.parse(
	execFileSync("gh", ["release", "view", tag, "--repo", repo, "--json", "assets"], {
		encoding: "utf8",
	}),
);
const base = `https://gh-proxy.com/https://github.com/${repo}/releases/download/${tag}/`;
const assets = rel.assets || [];

const fileKind = (name) => {
	if (!name) return "";
	if (/\.msi$/i.test(name)) return "msi";
	if (/\.exe$/i.test(name)) return "exe";
	if (/\.AppImage$/i.test(name)) return "appimage";
	if (/\.deb$/i.test(name)) return "deb";
	if (/\.rpm$/i.test(name)) return "rpm";
	if (/\.tar\.gz$/i.test(name)) return "tar.gz";
	if (/\.dmg$/i.test(name)) return "dmg";
	return name.split(".").pop().toLowerCase();
};
const norm = (name) => name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

let rewritten = 0;
for (const [key, platform] of Object.entries(src.platforms || {})) {
	// The signature is authoritative: it names the exact file that was signed.
	const sigText = Buffer.from(platform.signature || "", "base64").toString("utf8");
	const signedName = /file:([^\n]+)/.exec(sigText)?.[1]?.trim();
	if (!signedName) continue;
	const kind = fileKind(signedName);

	// Strategy 1: asset id embedded in the official URL (most precise).
	const idMatch = /(?:\/|%2F)assets\/(\d+)/.exec(platform.url || "");
	let asset = idMatch
		? assets.find((a) => String(a.id) === idMatch[1])
		: undefined;
	// Strategy 2: match by signed file name when the id cannot be resolved.
	if (!asset) {
		asset = assets.find(
			(a) => fileKind(a.name) === kind && norm(a.name).includes(norm(signedName)),
		);
	}
	// Strategy 3: a single asset of that file type (generic .app.tar.gz name).
	if (!asset) {
		const sameKind = assets.filter((a) => fileKind(a.name) === kind);
		if (sameKind.length === 1) asset = sameKind[0];
	}
	if (!asset) {
		console.log(`WARN ${key}: no asset matches signed file ${signedName}`);
		continue;
	}
	platform.url = base + encodeURIComponent(asset.name);
	rewritten++;
}

if (rewritten === 0) {
	throw new Error("无法解析任何平台资产，拒绝生成错误的镜像清单");
}
src.notes = (src.notes || "") + "\n\n（镜像下载地址：国内网络无需 VPN）";
writeFileSync("latest-mirror.json", JSON.stringify(src, null, 2));
console.log(`[${tag}] latest-mirror.json 已重写 ${rewritten} 个平台`);
