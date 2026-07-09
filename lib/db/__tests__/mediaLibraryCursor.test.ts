/**
 * Round-trip + rejection coverage for the library pagination cursor.
 *
 * The cursor pins `(created_at, id)` so tied timestamps don't straddle a page
 * boundary. The boundary is `{ createdAtMs, id }` — the `created_at` column is
 * millisecond-precision, so the cursor carries epoch ms plus the row id; both
 * must survive encode→decode or a same-millisecond pair could get skipped. A
 * malformed token must surface as `MalformedCursorError` (→ 400), never a raw
 * throw (→ 500). The decoder validates shape only (`createdAtMs` finite, `id` a
 * string) and constructs no boundary itself, so there is no out-of-range failure
 * mode to guard.
 */

import { describe, expect, it } from "vitest";
import {
	decodeLibraryCursor,
	encodeLibraryCursor,
	MalformedCursorError,
} from "../mediaAssets";

describe("library cursor codec", () => {
	it("round-trips the created_at ms + id (the tie-break composite key)", () => {
		const createdAt = new Date("2026-06-03T04:05:06.789Z");
		const { createdAtMs, id } = decodeLibraryCursor(
			encodeLibraryCursor(createdAt, "asset-1"),
		);
		expect(createdAtMs).toBe(createdAt.getTime());
		expect(id).toBe("asset-1");
	});

	it("rejects a non-base64 / non-JSON token", () => {
		expect(() => decodeLibraryCursor("not-a-cursor")).toThrow(
			MalformedCursorError,
		);
	});

	it("rejects a token missing the id", () => {
		const token = Buffer.from(
			JSON.stringify({ createdAtMs: 1_700_000_000_000 }),
		).toString("base64url");
		expect(() => decodeLibraryCursor(token)).toThrow(MalformedCursorError);
	});

	it("rejects a non-finite createdAtMs", () => {
		const token = Buffer.from(
			JSON.stringify({ createdAtMs: "banana", id: "x" }),
		).toString("base64url");
		expect(() => decodeLibraryCursor(token)).toThrow(MalformedCursorError);
	});
});
