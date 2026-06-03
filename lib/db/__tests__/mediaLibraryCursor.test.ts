/**
 * Round-trip + rejection coverage for the library pagination cursor.
 *
 * The cursor pins `(created_at, documentId)` so tied timestamps
 * don't straddle a page boundary. The load-bearing property: the
 * timestamp survives encode→decode WITHOUT losing sub-millisecond
 * nanoseconds — an ISO round-trip would truncate to ms and silently
 * skip same-millisecond rows. A malformed token must surface as
 * `MalformedCursorError` (→ 400), never a raw `Timestamp` throw
 * (→ 500).
 */

import { Timestamp } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import {
	decodeLibraryCursor,
	encodeLibraryCursor,
	MalformedCursorError,
} from "../mediaAssets";

describe("library cursor codec", () => {
	it("round-trips a timestamp preserving sub-millisecond nanoseconds", () => {
		// 123456789 ns is NOT a clean millisecond multiple — an ISO
		// round-trip would truncate it to 123000000.
		const ts = new Timestamp(1_700_000_000, 123_456_789);
		const { boundary, id } = decodeLibraryCursor(
			encodeLibraryCursor(ts, "asset-1"),
		);
		expect(boundary.seconds).toBe(1_700_000_000);
		expect(boundary.nanoseconds).toBe(123_456_789);
		expect(id).toBe("asset-1");
	});

	it("rejects a non-base64 / non-JSON token", () => {
		expect(() => decodeLibraryCursor("not-a-cursor")).toThrow(
			MalformedCursorError,
		);
	});

	it("rejects a token missing the id", () => {
		const token = Buffer.from(
			JSON.stringify({ seconds: 1, nanoseconds: 0 }),
		).toString("base64url");
		expect(() => decodeLibraryCursor(token)).toThrow(MalformedCursorError);
	});

	it("rejects non-integer seconds", () => {
		const token = Buffer.from(
			JSON.stringify({ seconds: "banana", nanoseconds: 0, id: "x" }),
		).toString("base64url");
		expect(() => decodeLibraryCursor(token)).toThrow(MalformedCursorError);
	});

	it("rejects out-of-range seconds as MalformedCursorError, not a raw Timestamp throw", () => {
		// Far outside Firestore's valid 0001–9999 range — the Timestamp
		// constructor throws, and decode must convert that to the 400
		// error rather than letting it escape as a 500.
		const token = Buffer.from(
			JSON.stringify({ seconds: 999_999_999_999, nanoseconds: 0, id: "x" }),
		).toString("base64url");
		expect(() => decodeLibraryCursor(token)).toThrow(MalformedCursorError);
	});

	it("rejects out-of-range nanoseconds", () => {
		const token = Buffer.from(
			JSON.stringify({ seconds: 1, nanoseconds: 2_000_000_000, id: "x" }),
		).toString("base64url");
		expect(() => decodeLibraryCursor(token)).toThrow(MalformedCursorError);
	});
});
