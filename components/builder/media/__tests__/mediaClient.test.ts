/**
 * State-model coverage for the pure media-client helpers (per the
 * project's "test the state model, not the DOM" rule). The fetch
 * helpers + React hooks are I/O and are covered by typecheck + the
 * browser-level pass; the pure slot transforms + hashing are tested
 * here.
 */

import { describe, expect, it } from "vitest";
import type { Media } from "@/lib/domain/multimedia";
import {
	clearMediaSlot,
	mediaSrc,
	setMediaSlot,
	sha256Hex,
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

	it("returns undefined when clearing a kind that wasn't set, on a single-other-slot bundle... keeps the other", () => {
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

describe("sha256Hex", () => {
	it("computes the lowercase-hex SHA-256 of the bytes", async () => {
		// Known vector: sha256("abc").
		const blob = new Blob([new TextEncoder().encode("abc")]);
		expect(await sha256Hex(blob)).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is deterministic", async () => {
		const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
		expect(await sha256Hex(blob)).toBe(await sha256Hex(blob));
	});
});
