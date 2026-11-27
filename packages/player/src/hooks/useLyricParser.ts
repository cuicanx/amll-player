import type { LyricLine as CoreLyricLine } from "@applemusic-like-lyrics/core";
import {
	type LyricLine,
	parseEslrc,
	parseLrc,
	parseLys,
	parseQrc,
	parseYrc,
} from "@applemusic-like-lyrics/lyric";
import chalk from "chalk";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { languageAtom, swapLyricGlobalAtom } from "../states/appAtoms";
import { handleTTMLParsing } from "../utils/ttml-parser";

const LYRIC_LOG_TAG = chalk.bgHex("#FF4444").hex("#FFFFFF")(" LYRIC ");

type TransLine = {
	[K in keyof CoreLyricLine]: CoreLyricLine[K] extends string ? K : never;
}[keyof CoreLyricLine];

function pairLyric(line: LyricLine, lines: CoreLyricLine[], key: TransLine) {
	if (
		line.words
			.map((v) => v.word)
			.join("")
			.trim().length === 0
	)
		return;
	interface PairedLine {
		startTime: number;
		lineText: string;
		origIndex: number;
		original: CoreLyricLine;
	}
	const processed: PairedLine[] = lines.map((v, i) => ({
		startTime: Math.min(v.startTime, ...v.words.map((v) => v.startTime)),
		origIndex: i,
		lineText: v.words
			.map((v) => v.word)
			.join("")
			.trim(),
		original: v,
	}));
	let nearestLine: PairedLine | undefined;
	for (const coreLine of processed) {
		if (coreLine.lineText.length > 0) {
			if (coreLine.startTime === line.words[0].startTime) {
				nearestLine = coreLine;
				break;
			}
			if (
				nearestLine &&
				Math.abs(nearestLine.startTime - line.words[0].startTime) >
					Math.abs(coreLine.startTime - line.words[0].startTime)
			) {
				nearestLine = coreLine;
			} else if (nearestLine === undefined) {
				nearestLine = coreLine;
			}
		}
	}
	if (nearestLine) {
		const joined = line.words.map((w) => w.word).join("");
		if (nearestLine.original[key].length > 0)
			nearestLine.original[key] += joined;
		else nearestLine.original[key] = joined;
	}
}

interface LyricParserResult {
	lyricLines: CoreLyricLine[];
	hasLyrics: boolean;
	metadata: [string, string[]][];
}

/**
 * Positive offset delays the lyrics; negative offset brings them forward.
 *
 * AMLL core validates EVERY line, word and ruby with `startTime <= endTime`
 * (`assertValidLyricTimestamps`). The offset must therefore be applied to
 * `startTime` AND `endTime` at all three levels. Shifting only `startTime`
 * (the old behaviour) produced `startTime 3216 > endTime 1600` as soon as a
 * user saved a +3000ms offset, which crashed the whole app on song switch
 * and on the next launch.
 */
function shiftLyricLines(lines: LyricLine[], offsetMs: number): LyricLine[] {
	if (!offsetMs) return lines;
	const shift = (value: number) => Math.max(0, value + offsetMs);
	return lines.map((line) => {
		const shifted: LyricLine = {
			...line,
			startTime: shift(line.startTime),
			words: line.words.map((word) => {
				const next = {
					...word,
					startTime: shift(word.startTime),
				} as typeof word;
				const originalEnd = (word as { endTime?: number }).endTime;
				if (typeof originalEnd === "number") {
					Object.assign(next, { endTime: shift(originalEnd) });
				}
				const ruby = (word as {
					ruby?: Array<{ startTime: number; endTime: number }>;
				}).ruby;
				if (Array.isArray(ruby)) {
					Object.assign(next, {
						ruby: ruby.map((item) => ({
							...item,
							startTime: shift(item.startTime),
							endTime: shift(item.endTime),
						})),
					});
				}
				return next;
			}),
		};
		const originalLineEnd = (line as unknown as { endTime?: number }).endTime;
		if (typeof originalLineEnd === "number") {
			Object.assign(shifted, { endTime: shift(originalLineEnd) });
		}
		return shifted;
	});
}

/**
 * Merge "inline bilingual" LRC lines.
 *
 * A large number of Chinese-hosted LRC files carry the translation inside the
 * SAME file as a second line sharing the original line's timestamp, e.g.
 *
 *   [00:20.51]この橋の向こうに
 *   [00:20.51]在这座桥的另一端
 *
 * `parseLrc` turns both into independent main lines, so the translation never
 * reaches `translatedLyric` and the "主译互换" toggle appears to do nothing
 * (`swapMainTranslationLines` skips lines without a translation).
 *
 * Fold the duplicate-timestamp row into the preceding row's
 * `translatedLyric`. This also makes those files render the way AMLL intends:
 * one main line with a translation sub-line. Only LRC is folded; formats that
 * already carry structured translation data (yrc/qrc/eslrc/ttml) are left
 * untouched. Returns a new array; input is never mutated.
 */
function mergeInlineBilingualLrc(lines: LyricLine[]): LyricLine[] {
	if (lines.length < 2) return lines;
	const textOf = (line: LyricLine) =>
		line.words.map((w) => w.word).join("").trim();

	// Group rows by exact timestamp. Bilingual LRC files usually list ALL
	// original lines first and ALL translations afterwards, so matching
	// neighbours is not enough - a timestamp map is required.
	const groups = new Map<number, LyricLine[]>();
	for (const line of lines) {
		const key = Math.round(line.startTime);
		const existing = groups.get(key);
		if (existing) existing.push(line);
		else groups.set(key, [line]);
	}
	// A translation row is folded into the first row of its timestamp group.
	const consumed = new Set<LyricLine>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const primary = group[0];
		for (const extra of group.slice(1)) {
			const extraText = textOf(extra);
			if (!extraText) continue;
			if (!primary.translatedLyric.trim()) primary.translatedLyric = extraText;
			consumed.add(extra);
		}
	}
	return lines.filter((line) => !consumed.has(line));
}

/**
 * Final safety net before handing lines to AMLL. It mirrors the core's
 * `assertValidLyricTimestamps` exactly: every line, word and ruby must have a
 * finite, non-negative `startTime` and an `endTime >= startTime`.
 *
 * Some real LRC files contain backwards timestamps, and translations/roman
 * lines can be paired onto a line whose interval is shorter than the text.
 * Without this, any such row crashes the renderer with an unrecoverable
 * RangeError. Existing valid rows are returned byte-for-byte unchanged.
 */
function sanitizeTimestamps(lines: CoreLyricLine[]): CoreLyricLine[] {
	const clampRange = (obj: Record<string, unknown>): Record<string, unknown> => {
		const rawStart = obj.startTime;
		const start =
			typeof rawStart === "number" && Number.isFinite(rawStart) && rawStart >= 0
				? rawStart
				: 0;
		const rawEnd = obj.endTime;
		const end =
			typeof rawEnd === "number" && Number.isFinite(rawEnd) && rawEnd >= start
				? rawEnd
				: start;
		return { ...obj, startTime: start, endTime: end };
	};
	return lines.map((line) => {
		const fixed = clampRange(line as unknown as Record<string, unknown>);
		if (Array.isArray(fixed.words)) {
			fixed.words = fixed.words.map((word: Record<string, unknown>) => {
				const w = clampRange(word);
				if (Array.isArray(w.ruby)) {
					w.ruby = w.ruby.map((ruby: Record<string, unknown>) =>
						clampRange(ruby),
					);
				}
				return w;
			});
		}
		return fixed as unknown as CoreLyricLine;
	});
}

/**
 * Display-only swap: show the translation as the main (large) line and the
 * original lyric as the sub (small) line. The database is never written; the
 * swap is applied to the parsed lines at render time and can be toggled at
 * any moment while playing.
 */
function swapMainTranslationLines(lines: CoreLyricLine[]): CoreLyricLine[] {
	return lines.map((line) => {
		const translated = (line.translatedLyric ?? "").trim();
		if (!translated) return line;
		const mainText = line.words.map((word) => word.word).join("");
		const first = line.words[0];
		const last = line.words[line.words.length - 1];
		// Build the swapped word from scratch instead of spreading the first
		// original word: spreading would carry over its `ruby` annotation,
		// which belongs to the original text and must not be attached to the
		// translation.
		const translatedWord = {
			word: translated,
			startTime: first?.startTime ?? line.startTime,
			endTime:
				(last as unknown as { endTime?: number } | undefined)?.endTime ??
				line.endTime,
			obscene: false,
		};
		return {
			...line,
			words: [translatedWord] as CoreLyricLine["words"],
			translatedLyric: mainText,
		};
	});
}

export const useLyricParser = (
	lyricStr?: string,
	format?: string,
	translatedLrc?: string,
	romanLrc?: string,
	offsetMs = 0,
	perSongSwap?: boolean | null,
): LyricParserResult => {
	const displayLanguage = useAtomValue(languageAtom);
	const globalSwap = useAtomValue(swapLyricGlobalAtom);
	// Global switch wins; otherwise the song's own choice decides. null means
	// the song was never configured, which leaves the original line order.
	const swapMainTranslation = globalSwap || perSongSwap === true;

	return useMemo(() => {
		if (!lyricStr || !format) {
			return { lyricLines: [], hasLyrics: false, metadata: [] };
		}

		try {
			let parsedLyricLines: LyricLine[] = [];
			let parsedMetadata: [string, string[]][] = [];

			switch (format) {
				case "lrc": {
					parsedLyricLines = parseLrc(lyricStr);
					break;
				}
				case "eslrc": {
					parsedLyricLines = parseEslrc(lyricStr);
					break;
				}
				case "yrc": {
					parsedLyricLines = parseYrc(lyricStr);
					break;
				}
				case "qrc": {
					parsedLyricLines = parseQrc(lyricStr);
					break;
				}
				case "lys": {
					parsedLyricLines = parseLys(lyricStr);
					console.log(
						LYRIC_LOG_TAG,
						"解析出 Lyricify Syllable 歌词",
						parsedLyricLines,
					);
					break;
				}
				case "ttml": {
					const ttmlResult = handleTTMLParsing(lyricStr, displayLanguage);
					parsedLyricLines = ttmlResult.lines;
					parsedMetadata = ttmlResult.metadata;
					break;
				}
				default: {
					return { lyricLines: [], hasLyrics: false, metadata: [] };
				}
			}

			// LRC files with inline translations (two rows sharing a timestamp)
			// must be folded before any offset is applied, so the translation
			// lands on the correct main line.
			const bilingualLines =
				format === "lrc"
					? mergeInlineBilingualLrc(parsedLyricLines)
					: parsedLyricLines;
			const shiftedLines = shiftLyricLines(bilingualLines, offsetMs);
			const compatibleLyricLines: CoreLyricLine[] = shiftedLines.map(
				(line) => ({
					...line,
					words: line.words.map((word) => ({
						...word,
						obscene: false,
					})),
				}),
			);

			if (translatedLrc) {
				try {
					const translatedLyricLines = shiftLyricLines(parseLrc(translatedLrc), offsetMs);
					for (const line of translatedLyricLines) {
						pairLyric(
							{
								...line,
								words: line.words.map((word) => ({
									...word,
									obscene: false,
								})),
							},
							compatibleLyricLines,
							"translatedLyric",
						);
					}
					console.log(LYRIC_LOG_TAG, "已匹配翻译歌词");
				} catch (err) {
					console.warn(LYRIC_LOG_TAG, "解析翻译歌词时出现错误", err);
				}
			}

			if (romanLrc) {
				try {
					const romanLyricLines = shiftLyricLines(parseLrc(romanLrc), offsetMs);
					for (const line of romanLyricLines) {
						pairLyric(
							{
								...line,
								words: line.words.map((word) => ({
									...word,
									obscene: false,
								})),
							},
							compatibleLyricLines,
							"romanLyric",
						);
					}
					console.log(LYRIC_LOG_TAG, "已匹配音译歌词");
				} catch (err) {
					console.warn(LYRIC_LOG_TAG, "解析音译歌词时出现错误", err);
				}
			}

			// Never let a malformed interval reach AMLL's assertion. This is the
			// code-level fix for "save an offset -> switch song -> crash".
			//
			// The swap runs BEFORE the sanitizer on purpose: swapping rebuilds
			// each line's word list from the translation, and that new word
			// inherits timestamps from the original words. Sanitizing only
			// afterwards guarantees the final, rendered structure is valid no
			// matter what the swap produced.
			const displayLines = sanitizeTimestamps(
				swapMainTranslation
					? swapMainTranslationLines(compatibleLyricLines)
					: compatibleLyricLines,
			);
			return {
				lyricLines: displayLines,
				hasLyrics: displayLines.length > 0,
				metadata: parsedMetadata,
			};
		} catch (e) {
			console.warn("解析歌词时出现错误", e);
			return { lyricLines: [], hasLyrics: false, metadata: [] };
		}
	}, [
		lyricStr,
		format,
		translatedLrc,
		romanLrc,
		offsetMs,
		perSongSwap,
		displayLanguage,
		swapMainTranslation,
	]);
};
