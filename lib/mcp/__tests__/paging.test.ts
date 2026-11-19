/**
 * The one pager and the one serialiser of the tools that answer a reading.
 *
 * Contract: a piece is fitted to `PIECE_MAX_CHARS` whatever it holds, cutting
 * its texts and never its keys or its short words; a page of any pieces,
 * from any start, is at most `PAGE_LIMIT_CHARS` beside a shell of at most
 * `SHELL_MAX_CHARS` and holds at least one piece, so following the pages
 * reads every piece once; a piece that is a page of its own stands alone;
 * and the text a tool sends is never past the limit: `toolText` throws
 * rather than answer it.
 */

import { describe, expect, it } from "vitest";
import {
	arrayItemChars,
	cutPage,
	fitPiece,
	PAGE_LIMIT_CHARS,
	PIECE_MAX_CHARS,
	SHELL_MAX_CHARS,
	toolText,
} from "../paging";

/** Pieces of every size, the largest past the limit, each fitted, paged from the start to the end. */
function pages(texts: readonly string[], shellChars: number, alone?: number) {
	const pieces = texts.map((text) =>
		fitPiece({ code: "unrecognized", standing: "not-yet", sentence: text }),
	);
	const out: (typeof pieces)[] = [];
	for (let from = 0; from < pieces.length; ) {
		const page: typeof pieces = [];
		const end = cutPage({
			count: pieces.length,
			from,
			shellChars,
			pieceChars: (index, taken) => arrayItemChars(pieces[index], taken),
			take: (index) => page.push(pieces[index] as (typeof pieces)[number]),
			...(alone !== undefined && { alone: (index) => index === alone }),
		});
		expect(end).toBeGreaterThan(from);
		out.push(page);
		from = end;
	}
	return out;
}

describe("a page", () => {
	it("fits a piece of any length to the piece bound, keeping its keys and short words", () => {
		const fitted = fitPiece({
			code: "unrecognized",
			standing: "not-yet",
			sentence: "é".repeat(500_000),
			place: "\u0000".repeat(500_000),
		});
		expect(JSON.stringify(fitted).length).toBeLessThan(PIECE_MAX_CHARS);
		expect(fitted.code).toBe("unrecognized");
		expect(fitted.standing).toBe("not-yet");
		expect(fitted.sentence.endsWith("…")).toBe(true);
		expect(fitPiece("short")).toBe("short");
	});

	it("holds every piece once, each page under the limit, whatever the pieces' sizes", () => {
		const texts = [
			"a",
			"b".repeat(200_000),
			"c".repeat(40_000),
			"d",
			"e".repeat(29_000),
			...Array.from({ length: 500 }, (_, index) => `line ${index}`),
		];
		for (const shell of [0, 1_000, SHELL_MAX_CHARS]) {
			const read = pages(texts, shell);
			expect(read.flat()).toHaveLength(texts.length);
			for (const page of read) {
				expect(page.length).toBeGreaterThan(0);
				expect(shell + JSON.stringify(page).length).toBeLessThanOrEqual(
					PAGE_LIMIT_CHARS,
				);
			}
		}
	});

	it("gives a piece that stands alone a page of its own", () => {
		const read = pages(["a", "b", "c", "d"], 100, 2);
		expect(read.map((page) => page.map((piece) => piece.sentence))).toEqual([
			["a", "b"],
			["c"],
			["d"],
		]);
	});

	it("throws for a shell that leaves no room for a piece, and for a piece left unfitted", () => {
		expect(() =>
			cutPage({
				count: 1,
				from: 0,
				shellChars: SHELL_MAX_CHARS + 1,
				pieceChars: () => 1,
				take: () => {},
			}),
		).toThrow(/shell/);
		expect(() =>
			cutPage({
				count: 1,
				from: 0,
				shellChars: 0,
				pieceChars: () => PIECE_MAX_CHARS + 1,
				take: () => {},
			}),
		).toThrow(/fitPiece/);
	});
});

describe("the text a tool sends", () => {
	it("is the body's JSON where it fits, and an error where it does not", () => {
		expect(toolText({ a: 1 })).toBe('{"a":1}');
		expect(() => toolText({ a: "x".repeat(PAGE_LIMIT_CHARS) })).toThrow(
			/more than/,
		);
	});
});
