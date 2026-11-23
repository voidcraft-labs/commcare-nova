/**
 * The one pager and the one serialiser of the tools that answer a reading of
 * an app in CommCare HQ: `read_hq_app`, `bring_in_hq_app`, `read_hq_changes`
 * and `bring_in_hq_changes`.
 *
 * What a page holds is bounded by construction, never by a careful loop: an
 * answer is a shell (everything but the list it pages) and pieces of the
 * list. The shell of every page is at most `SHELL_MAX_CHARS` of JSON, and every
 * piece at most `PIECE_MAX_CHARS` (`fitPiece` cuts the text in one that is
 * longer), so any one piece fits beside the shell, a page always holds at
 * least one, and the whole is at most `PAGE_LIMIT_CHARS`. `toolText` measures
 * the text that is sent, the outer envelope of a write's answer included, and
 * answers a tool error rather than text past the limit.
 */

import { cutShown } from "@/lib/publish/shownText";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/**
 * The most characters of JSON one answer holds, under the result size the
 * tools declare (`resultSize.ts::MAX_RESULT_SIZE_CHARS`), which a host may
 * cut at.
 */
export const PAGE_LIMIT_CHARS = 80_000;
/** Characters a JSON fragment occupies inside an MCP text result. */
export function encodedJsonChars(value: unknown): number {
	return JSON.stringify(JSON.stringify(value)).length - 2;
}
export function toolResultChars(body: unknown, isError = true): number {
	return JSON.stringify({
		...(isError && { isError: true }),
		content: [{ type: "text", text: JSON.stringify(body) }],
	}).length;
}

/** The full SDK response, including JSON escaping, must fit the review page. */
export function fitsReviewResult(body: unknown, isError = false): boolean {
	return toolResultChars(body, isError) <= PAGE_LIMIT_CHARS;
}

/** The most characters of JSON one piece of a page takes, its comma included. */
export const PIECE_MAX_CHARS = 30_000;

/** The most characters of JSON the rest of a page takes, so any one piece fits beside it. */
export const SHELL_MAX_CHARS = PAGE_LIMIT_CHARS - PIECE_MAX_CHARS;

/** The most characters of JSON one code unit takes: `\uXXXX`. */
const JSON_CHARS_PER_UNIT = 6;

/**
 * `value` where its JSON is at most `maxChars` characters (by default a
 * piece's bound less its comma); otherwise `value`
 * with each of its strings cut (`shownText.ts::cutShown`) to one length, the
 * longest at which the whole fits. Keys are never cut: they are Nova's own
 * words. A short string, a code or a standing among them, is never cut, since
 * it is under the length every string is cut to.
 */
export function fitPiece<T>(
	value: T,
	maxChars: number = PIECE_MAX_CHARS - 1,
): T {
	if (JSON.stringify(value).length <= maxChars) return value;
	let strings = 0;
	const structure = JSON.stringify(value, (_key, held: unknown) => {
		if (typeof held !== "string") return held;
		strings += 1;
		return "";
	}).length;
	const units = Math.floor(
		(maxChars - structure) / (JSON_CHARS_PER_UNIT * Math.max(1, strings)),
	);
	if (units < 1)
		throw new Error(
			`A piece of an answer holds more than ${maxChars} characters with every text in it empty. A piece is a finding, a table, a line or a name, whose words around its texts are Nova's own and short. Look at lib/mcp/paging.ts::fitPiece's caller.`,
		);
	return JSON.parse(
		JSON.stringify(value, (_key, held: unknown) =>
			typeof held === "string"
				? cutShown(held, { graphemes: units, units })
				: held,
		),
	) as T;
}

/**
 * Where a page that starts at `from` ends: pieces are taken while the shell
 * (`shellChars`, the JSON of the whole answer with no piece, its cursor at
 * its longest) and the pieces taken stay at most `PAGE_LIMIT_CHARS`.
 * `pieceChars(index, taken)` is what piece `index` adds to a page that holds
 * `taken` pieces already: its JSON and its comma, and anything the page grows
 * by for it; `take(index)` puts it on the page. The first piece of a page is
 * always taken, which the bounds make fit; a shell past `SHELL_MAX_CHARS` or a
 * piece past `PIECE_MAX_CHARS` throws, as a fault of the caller's.
 */
export function cutPage(input: {
	readonly count: number;
	readonly from: number;
	readonly shellChars: number;
	readonly pieceChars: (index: number, taken: number) => number;
	readonly take: (index: number) => void;
	/** True where the piece at `index` is a page of its own: no piece before or after it. */
	readonly alone?: (index: number) => boolean;
}): number {
	const { count, from, shellChars } = input;
	if (shellChars > SHELL_MAX_CHARS)
		throw new Error(
			`An answer's shell holds ${shellChars} characters, more than the ${SHELL_MAX_CHARS} a page leaves it beside one piece. Every text the shell holds is cut where it is made; look at what the shell names that is not.`,
		);
	let size = shellChars;
	let end = from;
	while (end < count) {
		const taken = end - from;
		const alone = input.alone?.(end) === true;
		if (taken > 0 && alone) break;
		const piece = input.pieceChars(end, taken);
		if (piece > PIECE_MAX_CHARS)
			throw new Error(
				`A piece of an answer adds ${piece} characters, more than the ${PIECE_MAX_CHARS} one piece may. Fit each piece with lib/mcp/paging.ts::fitPiece before it is paged.`,
			);
		if (taken > 0 && size + piece > PAGE_LIMIT_CHARS) break;
		input.take(end);
		size += piece;
		end += 1;
		if (alone) break;
	}
	return end;
}

/** The JSON a value adds to an array that holds `taken` values already: its own, and a comma after the first. */
export function arrayItemChars(value: unknown, taken: number): number {
	return JSON.stringify(value).length + (taken > 0 ? 1 : 0);
}

/**
 * The text a tool sends for `body`. A body past `PAGE_LIMIT_CHARS` is a fault
 * of the pager's, and the tool answers it as an error rather than sending
 * text a host may cut short.
 */
export function toolText(body: unknown): string {
	const text = JSON.stringify(body);
	if (text.length > PAGE_LIMIT_CHARS)
		throw new Error(
			`An answer came to ${text.length} characters, more than the ${PAGE_LIMIT_CHARS} one answer holds, so Nova sent none of it. Every list in an answer is paged by lib/mcp/paging.ts::cutPage; look at what this one held outside its pages.`,
		);
	return text;
}

/** A page continuation identifies one offset without disclosing the approval to write. */
export function reviewedPageDigest(
	operation: "birth" | "changes" | "search-connections",
	reviewDigest: string,
	from: number,
): string {
	return canonicalJsonDigest([operation, "page", from, reviewDigest]);
}

export const LINE_PART_MAX_CHARS = PIECE_MAX_CHARS - 1;
function jsonCharsOf(codePoint: number): number {
	if (codePoint === 0x22 || codePoint === 0x5c) return 2;
	if (codePoint < 0x20)
		return codePoint === 0x08 ||
			codePoint === 0x09 ||
			codePoint === 0x0a ||
			codePoint === 0x0c ||
			codePoint === 0x0d
			? 2
			: 6;
	/* A lone surrogate is written as an escape. */
	if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
	return codePoint > 0xffff ? 2 : 1;
}

/**
 * `line` cut into parts of at most `LINE_PART_MAX_CHARS` characters of JSON
 * each, never inside a code point; the line itself where it fits.
 */
export function lineParts(
	line: string,
	limit = LINE_PART_MAX_CHARS,
): readonly string[] {
	if (JSON.stringify(line).length <= limit) return [line];
	const budget = limit - 2;
	const parts: string[] = [];
	let start = 0;
	let size = 0;
	let at = 0;
	for (const char of line) {
		const cost = jsonCharsOf(char.codePointAt(0) ?? 0);
		if (size + cost > budget) {
			parts.push(line.slice(start, at));
			start = at;
			size = 0;
		}
		size += cost;
		at += char.length;
	}
	parts.push(line.slice(start));
	return parts;
}
