/**
 * State-model coverage for the pure media-client helpers (per the
 * project's "test the state model, not the DOM" rule). The fetch
 * helpers + React hooks are I/O and are covered by typecheck + the
 * browser-level pass; the pure slot transforms + hashing are tested
 * here.
 *
 * Hashing is tested through `sha256HexOfBytes` (the pure buffer→hex
 * core), NOT `sha256Hex(Blob)`: `Blob.arrayBuffer()` registers a
 * BLOBREADER async resource that lingers past test-end under the leak
 * detector, and the blob read is I/O — the byte→hash transformation is
 * the part worth unit-testing.
 */

import { describe, expect, it } from "vitest";
import type { Media } from "@/lib/domain/multimedia";
import {
	clearMediaSlot,
	mediaSrc,
	setMediaSlot,
	sha256HexOfBytes,
} from "../mediaClient";

describe("setMediaSlot", () => {
	it("sets a kind on an empty bundle", () => {
		expect(setMediaSlot(undefined, "image", "asset-1")).toEqual({
			image: "asset-1",
		});
	});

	it("preserves the other slots", () => {
		const value: Media = { image: "img-1", audio: "aud-1" };
		expect(setMediaSlot(value, "video", "vid-1")).toEqual({
			image: "img-1",
			audio: "aud-1",
			video: "vid-1",
		});
	});

	it("replaces an existing slot of the same kind", () => {
		expect(setMediaSlot({ image: "old" }, "image", "new")).toEqual({
			image: "new",
		});
	});
});

describe("clearMediaSlot", () => {
	it("returns undefined when clearing the only slot (bundle drops, not {})", () => {
		expect(clearMediaSlot({ image: "img-1" }, "image")).toBeUndefined();
	});

	it("keeps the remaining slots when clearing one of several", () => {
		expect(clearMediaSlot({ image: "img-1", audio: "aud-1" }, "image")).toEqual(
			{
				audio: "aud-1",
			},
		);
	});

	it("is a no-op (undefined) on an absent bundle", () => {
		expect(clearMediaSlot(undefined, "image")).toBeUndefined();
	});

	it("clearing an absent kind leaves the other slots intact", () => {
		expect(clearMediaSlot({ audio: "aud-1" }, "image")).toEqual({
			audio: "aud-1",
		});
	});
});

describe("mediaSrc", () => {
	it("points at the session-authed proxy route", () => {
		expect(mediaSrc("asset-xyz")).toBe("/api/media/asset-xyz");
	});
});

describe("sha256HexOfBytes", () => {
	it("computes the lowercase-hex SHA-256 of the bytes", async () => {
		// Known vector: sha256("abc").
		const bytes = new TextEncoder().encode("abc");
		expect(await sha256HexOfBytes(bytes)).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is deterministic", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		expect(await sha256HexOfBytes(bytes)).toBe(await sha256HexOfBytes(bytes));
	});
});
