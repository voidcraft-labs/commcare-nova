/**
 * Tests for `readJsonBody` — the small-metadata JSON body guard that
 * rejects a declared-oversized request before parsing it.
 *
 * A minimal `Request`-shaped fake (just `headers.get` + `json`) keeps the
 * test focused on the Content-Length gate, and lets the "rejected before
 * parse" assertion be exact: the 413 case uses a `json` that throws, so a
 * passing test proves the body was never read.
 */

import { describe, expect, it, vi } from "vitest";
import { readJsonBody } from "../apiError";

function fakeReq(opts: {
	contentLength?: string;
	json: () => Promise<unknown>;
}): Request {
	return {
		headers: {
			get: (key: string) =>
				key.toLowerCase() === "content-length"
					? (opts.contentLength ?? null)
					: null,
		},
		json: opts.json,
	} as unknown as Request;
}

describe("readJsonBody", () => {
	it("parses a body within the cap", async () => {
		const parsed = await readJsonBody(
			fakeReq({ contentLength: "9", json: async () => ({ a: 1 }) }),
			4096,
		);
		expect(parsed).toEqual({ a: 1 });
	});

	it("rejects an over-cap declared body with 413, BEFORE reading it", async () => {
		const json = vi.fn(async () => ({}));
		await expect(
			readJsonBody(fakeReq({ contentLength: "5000", json }), 4096),
		).rejects.toMatchObject({ status: 413 });
		// The whole point: the oversized body is never materialized.
		expect(json).not.toHaveBeenCalled();
	});

	it("returns null for an unparseable body (caller's schema makes the message)", async () => {
		const parsed = await readJsonBody(
			fakeReq({
				contentLength: "8",
				json: async () => {
					throw new Error("not json");
				},
			}),
			4096,
		);
		expect(parsed).toBeNull();
	});

	it("allows a request that omits Content-Length (chunked) through to parse", async () => {
		const parsed = await readJsonBody(
			fakeReq({ json: async () => ({ b: 2 }) }),
			4096,
		);
		expect(parsed).toEqual({ b: 2 });
	});
});
