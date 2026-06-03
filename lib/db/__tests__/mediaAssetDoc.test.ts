/**
 * Shape coverage for `mediaAssetDocSchema` — the Firestore-stored
 * media-asset record. The Firestore converter (`lib/db/firestore.ts`)
 * runs `schema.parse` on every read, so these constraints are what
 * catch data corruption / schema drift at the persistence boundary.
 *
 * Uses a real `Timestamp` for `created_at` (the schema is
 * `z.instanceof(Timestamp)`), so these run without an emulator.
 */

import { Timestamp } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import { mediaAssetDocSchema } from "../types";

const baseDoc = {
	owner: "user-1",
	contentHash: "a".repeat(64),
	mimeType: "image/png",
	kind: "image" as const,
	extension: ".png",
	sizeBytes: 1024,
	gcsObjectKey: "users/user-1/aaa.png",
	originalFilename: "logo.png",
	displayName: "logo.png",
	status: "ready" as const,
	created_at: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
};

describe("mediaAssetDocSchema", () => {
	it("round-trips a minimal ready image record", () => {
		const parsed = mediaAssetDocSchema.parse(baseDoc);
		expect(parsed.kind).toBe("image");
		expect(parsed.status).toBe("ready");
	});

	it("accepts dimensions on images", () => {
		const parsed = mediaAssetDocSchema.parse({
			...baseDoc,
			dimensions: { width: 1920, height: 1080 },
		});
		expect(parsed.dimensions).toEqual({ width: 1920, height: 1080 });
	});

	it("accepts durationMs on audio", () => {
		const parsed = mediaAssetDocSchema.parse({
			...baseDoc,
			mimeType: "audio/mpeg",
			kind: "audio",
			extension: ".mp3",
			durationMs: 30_000,
		});
		expect(parsed.durationMs).toBe(30_000);
	});

	it("rejects an obviously-wrong content-hash format", () => {
		expect(() =>
			mediaAssetDocSchema.parse({ ...baseDoc, contentHash: "not-hex" }),
		).toThrow();
	});

	it("rejects a non-leading-dot extension", () => {
		expect(() =>
			mediaAssetDocSchema.parse({ ...baseDoc, extension: "png" }),
		).toThrow();
	});

	it("rejects an unknown kind", () => {
		expect(() =>
			mediaAssetDocSchema.parse({ ...baseDoc, kind: "document" }),
		).toThrow();
	});

	it("rejects an unknown status (no `failed` state exists)", () => {
		expect(() =>
			mediaAssetDocSchema.parse({ ...baseDoc, status: "failed" }),
		).toThrow();
	});

	it("requires the denormalized kind field", () => {
		const { kind: _dropped, ...withoutKind } = baseDoc;
		expect(() => mediaAssetDocSchema.parse(withoutKind)).toThrow();
	});
});
