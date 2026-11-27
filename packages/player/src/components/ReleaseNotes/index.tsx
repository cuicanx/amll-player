import { openUrl } from "@tauri-apps/plugin-opener";
import { type FC, type ReactNode, useEffect, useState } from "react";
import styles from "./index.module.css";

type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "list"; ordered: boolean; items: string[] }
	| { type: "paragraph"; text: string }
	| { type: "quote"; text: string }
	| { type: "code"; text: string; lang: string }
	| { type: "divider" };

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const DIVIDER_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

function parse(body: string): Block[] {
	const blocks: Block[] = [];
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	let paragraph: string[] = [];
	let list: { ordered: boolean; items: string[] } | null = null;
	let code: string[] | null = null;
	let codeLang = "";
	const FENCE_RE = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/;

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		const text = paragraph.join(" ").trim();
		if (text) blocks.push({ type: "paragraph", text });
		paragraph = [];
	};
	const flushList = () => {
		if (!list) return;
		if (list.items.length > 0) blocks.push({ type: "list", ...list });
		list = null;
	};
	const flushAll = () => {
		flushParagraph();
		flushList();
	};

	for (const raw of lines) {
		const line = raw.replace(/\s+$/, "");
		// Fenced code blocks take priority: their contents must not be parsed
		// as headings, lists or emphasis even if they contain those patterns.
		const fence = FENCE_RE.exec(line);
		if (fence) {
			if (code) {
				blocks.push({ type: "code", text: code.join("\n"), lang: codeLang });
				code = null;
				codeLang = "";
			} else {
				flushAll();
				code = [];
				codeLang = fence[1] || "";
			}
			continue;
		}
		if (code) {
			code.push(raw);
			continue;
		}
		if (!line.trim()) {
			flushAll();
			continue;
		}
		if (DIVIDER_RE.test(line)) {
			flushAll();
			blocks.push({ type: "divider" });
			continue;
		}
		const quote = QUOTE_RE.exec(line);
		if (quote) {
			flushAll();
			blocks.push({ type: "quote", text: quote[1].trim() });
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) {
			flushAll();
			blocks.push({
				type: "heading",
				level: heading[1].length,
				text: heading[2].trim(),
			});
			continue;
		}
		const bullet = BULLET_RE.exec(line);
		if (bullet) {
			flushParagraph();
			if (!list || list.ordered) {
				flushList();
				list = { ordered: false, items: [] };
			}
			list.items.push(bullet[1].trim());
			continue;
		}
		const numbered = NUMBERED_RE.exec(line);
		if (numbered) {
			flushParagraph();
			if (!list || !list.ordered) {
				flushList();
				list = { ordered: true, items: [] };
			}
			list.items.push(numbered[1].trim());
			continue;
		}
		flushList();
		// Only real Markdown headings become headings. Previously a short
		// sentence with no punctuation was guessed to be a title, which turned
		// ordinary changelog lines into false section headers.
		paragraph.push(line.trim());
	}
	flushAll();
	if (code) blocks.push({ type: "code", text: code.join("\n"), lang: codeLang });
	return blocks;
}

const INLINE_RE =
	/(\*\*[\s\S]+?\*\*|__[\s\S]+?__|~~[\s\S]+?~~|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

async function openExternal(url: string) {
	try {
		await openUrl(url);
	} catch {
		window.open(url, "_blank");
	}
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	let last = 0;
	let index = 0;
	for (const match of text.matchAll(INLINE_RE)) {
		const start = match.index ?? 0;
		if (start > last) nodes.push(text.slice(last, start));
		const token = match[0];
		const key = `${keyPrefix}-${index++}`;
		if (token.startsWith("**") || token.startsWith("__")) {
			nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("~~")) {
			nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
		} else if (token.startsWith("*") || token.startsWith("_")) {
			nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
		} else if (token.startsWith("`")) {
			nodes.push(
				<code className={styles.code} key={key}>
					{token.slice(1, -1)}
				</code>,
			);
		} else {
			const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
			if (link) {
				nodes.push(
					<a
						key={key}
						className={styles.link}
						href={link[2]}
						target="_blank"
						rel="noopener noreferrer"
						onClick={(event) => {
							event.preventDefault();
							void openExternal(link[2]);
						}}
					>
						{link[1]}
					</a>,
				);
			} else {
				nodes.push(token);
			}
		}
		last = start + token.length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

export interface ReleaseNotesProps {
	body?: string | null;
	version?: string;
	currentVersion?: string;
	label?: string;
	emptyHint: string;
}

/**
 * Renders a release body with a real typographic hierarchy instead of
 * `white-space: pre-wrap`. Headings are heavier and spaced apart, bullets get
 * their own list rhythm, inline code and bold are honoured, and the whole
 * block is wrapped in a quiet card with a version chip, so consecutive
 * releases are easy to scan.
 */
export const ReleaseNotes: FC<ReleaseNotesProps> = ({
	body,
	version,
	currentVersion,
	label,
	emptyHint,
}) => {
	const blocks = body ? parse(body) : [];
	const collapsible = blocks.length > 8;
	const [expanded, setExpanded] = useState(false);
	// Reset the expand state when the release notes change (a new update check).
	useEffect(() => setExpanded(false), [body]);

	return (
		<div className={styles.card}>
			<div className={styles.cardHeader}>
				<span className={styles.label}>{label}</span>
				{currentVersion ? (
					<span className={styles.versionChip}>{currentVersion}</span>
				) : null}
				{currentVersion && version ? (
					<span className={styles.arrow}>→</span>
				) : null}
				{version ? <span className={styles.versionChip}>{version}</span> : null}
			</div>
			<div
				className={`${styles.body}${collapsible && !expanded ? ` ${styles.collapsed}` : ""}`}
			>
				{blocks.length === 0 ? (
					<span className={styles.empty}>{emptyHint}</span>
				) : (
					blocks.map((block, blockIndex) => {
						const key = `block-${blockIndex}`;
						switch (block.type) {
							case "heading":
								return (
									<div
										key={key}
										className={styles.heading}
										data-level={block.level}
									>
										{renderInline(block.text, key)}
									</div>
								);
							case "quote":
								return (
									<p key={key} className={styles.quote}>
										{renderInline(block.text, key)}
									</p>
								);
							case "code":
								return (
									<pre key={key} className={styles.codeBlock}>
										{block.lang ? (
											<span className={styles.codeLang}>{block.lang}</span>
										) : null}
										<code>{block.text}</code>
									</pre>
								);
							case "divider":
								return <hr key={key} className={styles.divider} />;
							case "list": {
								const ListTag = block.ordered ? "ol" : "ul";
								return (
									<ListTag key={key} className={styles.list}>
										{block.items.map((item, itemIndex) => (
											<li
												key={`${key}-${itemIndex}`}
												className={styles.item}
											>
												{renderInline(item, `${key}-${itemIndex}`)}
											</li>
										))}
									</ListTag>
								);
							}
							default:
								return (
									<p key={key} className={styles.paragraph}>
										{renderInline(block.text, key)}
									</p>
								);
						}
					})
				)}
			</div>
			{collapsible ? (
				<button
					type="button"
					className={styles.toggle}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? "收起" : "展开全部"}
				</button>
			) : null}
		</div>
	);
};
