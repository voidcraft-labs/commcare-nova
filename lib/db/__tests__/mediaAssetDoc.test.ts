/**
 * Row → `MediaAssetRecord` mapping coverage, exercised through `loadAssetById`
 * over the real per-test Postgres.
 *
 * The field invariants are column types + the
 * write-boundary validation the upload/confirm routes run BEFORE the insert
 * (`createPendingAsset` / `confirmAssetReady`), so a stored row is already
 * well-formed. What remains is `mediaAssets.ts::toRecord` — the read-time mapping
 * that `Number(...)`s the `bigint` columns (`size_bytes`, `duration_ms`), parses
 * the `extract` jsonb through `mediaAssetExtractSchema`, and omits an optional
 * whenever its column is null. This suite pins that mapping.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { asAssetId, MEDIA_EXTRACT_STATUSES } from "@/lib/domain/multimedia";
import type { MediaAssetExtract } from "../types";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("media_record_");

function extract(
	status: MediaAssetExtract["status"],
	version: number,
): MediaAssetExtract {
	return {
		status,
		version,
		model: "extract-model",
		truncated: false,
		charCount: 0,
		extractedAt: 123,
	};
}

interface RowOverrides {
	mime_type?: string;
	extension?: string;
	kind?: string;
	status?: string;
	size_bytes?: number;
	dimensions?: { width: number; height: number } | null;
	duration_ms?: number | null;
	display_name?: string | null;
	extract?: Record<string, unknown> | null;
}

/** Insert a `media_assets` row, defaulting a `ready` image, and return its id. */
async function seedRow(over: RowOverrides = {}): Promise<string> {
	const id = crypto.randomUUID();
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: "project-1",
			owner: "user-1",
			content_hash: "a".repeat(64),
			mime_type: over.mime_type ?? "image/png",
			extension: over.extension ?? ".png",
			size_bytes: over.size_bytes ?? 1024,
			dimensions:
				over.dimensions === undefined
					? JSON.stringify({ width: 1920, height: 1080 })
					: over.dimensions === null
						? null
						: JSON.stringify(over.dimensions),
			duration_ms: over.duration_ms ?? null,
			kind: over.kind ?? "image",
			gcs_object_key: `projects/project-1/${id}${over.extension ?? ".png"}`,
			original_filename: "logo.png",
			display_name:
				over.display_name === undefined ? "logo.png" : over.display_name,
			status: over.status ?? "ready",
			extract:
				over.extract === undefined || over.extract === null
					? null
					: JSON.stringify(over.extract),
		})
		.execute();
	return id;
}

describe("toRecord mapping (via loadAssetById)", () => {
	let loadAssetById: typeof import("../mediaAssets")["loadAssetById"];
	beforeEach(async () => {
		({ loadAssetById } = await import("../mediaAssets"));
	});

	it("maps a ready image row — bigint size_bytes → number, dimensions present", async () => {
		const id = await seedRow();
		const record = await loadAssetById(asAssetId(id));
		expect(record).toMatchObject({
			id,
			kind: "image",
			status: "ready",
			mimeType: "image/png",
			extension: ".png",
			displayName: "logo.png",
		});
		// The `bigint` column comes back a number, not a string.
		expect(record?.sizeBytes).toBe(1024);
		expect(typeof record?.sizeBytes).toBe("number");
		expect(record?.dimensions).toEqual({ width: 1920, height: 1080 });
		expect(record?.durationMs).toBeUndefined();
		expect(record?.created_at).toBeInstanceOf(Date);
	});

	it("maps durationMs on audio (bigint → number), with no dimensions", async () => {
		const id = await seedRow({
			mime_type: "audio/mpeg",
			extension: ".mp3",
			kind: "audio",
			dimensions: null,
			duration_ms: 30_000,
		});
		const record = await loadAssetById(asAssetId(id));
		expect(record?.durationMs).toBe(30_000);
		expect(typeof record?.durationMs).toBe("number");
		expect(record?.dimensions).toBeUndefined();
	});

	it("parses the extract jsonb through mediaAssetExtractSchema", async () => {
		const extract = {
			status: MEDIA_EXTRACT_STATUSES[0],
			version: 1,
			model: "claude-extract",
			truncated: false,
			charCount: 512,
			extractedAt: 1_700_000_000_000,
			title: "A document",
			summary: "It says things.",
		};
		const id = await seedRow({ kind: "document", extract });
		const record = await loadAssetById(asAssetId(id));
		expect(record?.extract).toEqual(extract);
	});

	it("omits optional fields whose columns are null", async () => {
		const id = await seedRow({
			dimensions: null,
			duration_ms: null,
			display_name: null,
			extract: null,
		});
		const record = await loadAssetById(asAssetId(id));
		expect(record).not.toHaveProperty("dimensions");
		expect(record).not.toHaveProperty("durationMs");
		expect(record).not.toHaveProperty("displayName");
		expect(record).not.toHaveProperty("extract");
	});

	it("returns null for a missing id", async () => {
		const record = await loadAssetById(asAssetId(crypto.randomUUID()));
		expect(record).toBeNull();
	});

	it("does not let an older extractor claim over higher-version state", async () => {
		const newer = extract("ready", 4);
		const id = await seedRow({ kind: "document", extract: newer });
		const { claimExtractionIfIdle } = await import("../mediaAssets");

		await expect(
			claimExtractionIfIdle(asAssetId(id), {
				now: 1_700_000_100_000,
				staleMs: 300_000,
				currentVersion: 3,
				model: "older-model",
			}),
		).resolves.toEqual({ kind: "superseded", extract: newer });
		expect((await loadAssetById(asAssetId(id)))?.extract).toEqual(newer);
	});

	it("canonicalizes copied extract metadata across duplicates while preserving higher state", async () => {
		const canonical: MediaAssetExtract = {
			...extract("ready", 2),
			model: "source-pair",
			charCount: 42,
			extractedAt: 500,
		};
		const selectedId = await seedRow({
			kind: "pdf",
			mime_type: "application/pdf",
			extension: ".pdf",
			dimensions: null,
		});
		const equalId = await seedRow({
			kind: "pdf",
			mime_type: "application/pdf",
			extension: ".pdf",
			dimensions: null,
			extract: {
				...extract("ready", 2),
				model: "stale-equal-metadata",
			},
		});
		const higher = extract("extracting", 3);
		const higherId = await seedRow({
			kind: "pdf",
			mime_type: "application/pdf",
			extension: ".pdf",
			dimensions: null,
			extract: higher,
		});
		const { installCopiedReadyExtract, loadAssetById } = await import(
			"../mediaAssets"
		);

		await installCopiedReadyExtract(
			{ assetId: asAssetId(selectedId), extract: canonical },
			h.db(),
		);

		expect((await loadAssetById(asAssetId(selectedId)))?.extract).toEqual(
			canonical,
		);
		expect((await loadAssetById(asAssetId(equalId)))?.extract).toEqual(
			canonical,
		);
		expect((await loadAssetById(asAssetId(higherId)))?.extract).toEqual(higher);
	});

	it("does not publish after an equal-version ready copy supersedes the claim", async () => {
		const copiedReady: MediaAssetExtract = {
			...extract("ready", 3),
			model: "copied-model",
			charCount: 42,
			extractedAt: 456,
		};
		const id = await seedRow({
			kind: "pdf",
			mime_type: "application/pdf",
			extension: ".pdf",
			dimensions: null,
			extract: copiedReady,
		});
		const { loadAssetById, publishClaimedAssetExtract } = await import(
			"../mediaAssets"
		);
		let publishCallbackRan = false;

		const result = await publishClaimedAssetExtract(
			{
				assetId: asAssetId(id),
				claim: {
					version: 3,
					model: "stale-model",
					extractedAt: 123,
				},
				extract: {
					status: "ready",
					version: 3,
					model: "stale-model",
					truncated: false,
					charCount: 99,
				},
				publishReadyObject: async () => {
					publishCallbackRan = true;
				},
			},
			h.db(),
		);

		expect(result).toEqual({
			kind: "superseded",
			extract: copiedReady,
		});
		expect(publishCallbackRan).toBe(false);
		expect((await loadAssetById(asAssetId(id)))?.extract).toEqual(copiedReady);
	});

	it("does not publish after a newer exact claim supersedes the stale job", async () => {
		const newerClaim: MediaAssetExtract = {
			...extract("extracting", 3),
			model: "same-model",
			extractedAt: 456,
		};
		const id = await seedRow({
			kind: "pdf",
			mime_type: "application/pdf",
			extension: ".pdf",
			dimensions: null,
			extract: newerClaim,
		});
		const { loadAssetById, publishClaimedAssetExtract } = await import(
			"../mediaAssets"
		);
		let publishCallbackRan = false;

		const result = await publishClaimedAssetExtract(
			{
				assetId: asAssetId(id),
				claim: {
					version: 3,
					model: "same-model",
					extractedAt: 123,
				},
				extract: {
					status: "ready",
					version: 3,
					model: "same-model",
					truncated: false,
					charCount: 99,
				},
				publishReadyObject: async () => {
					publishCallbackRan = true;
				},
			},
			h.db(),
		);

		expect(result).toEqual({
			kind: "superseded",
			extract: newerClaim,
		});
		expect(publishCallbackRan).toBe(false);
		expect((await loadAssetById(asAssetId(id)))?.extract).toEqual(newerClaim);
	});

	it("makes the first duplicate-row publisher canonical for the shared extract", async () => {
		const firstClaim = {
			version: 3,
			model: "first-model",
			extractedAt: 123,
		};
		const secondClaim = {
			version: 3,
			model: "second-model",
			extractedAt: 456,
		};
		const firstId = await seedRow({
			kind: "pdf",
			mime_type: "application/pdf",
			extension: ".pdf",
			dimensions: null,
			extract: {
				status: "extracting",
				...firstClaim,
				truncated: false,
				charCount: 0,
			},
		});
		const secondId = await seedRow({
			kind: "pdf",
			mime_type: "application/pdf",
			extension: ".pdf",
			dimensions: null,
			extract: {
				status: "extracting",
				...secondClaim,
				truncated: false,
				charCount: 0,
			},
		});
		const { loadAssetById, publishClaimedAssetExtract } = await import(
			"../mediaAssets"
		);
		let firstObjectWrites = 0;
		let secondObjectWrites = 0;

		const first = await publishClaimedAssetExtract(
			{
				assetId: asAssetId(firstId),
				claim: firstClaim,
				extract: {
					status: "ready",
					version: 3,
					model: "first-model",
					truncated: true,
					charCount: 42,
					title: "First committed result",
				},
				publishReadyObject: async () => {
					firstObjectWrites++;
				},
			},
			h.db(),
		);
		expect(first.kind).toBe("published");
		if (first.kind !== "published") throw new Error("expected publication");

		const second = await publishClaimedAssetExtract(
			{
				assetId: asAssetId(secondId),
				claim: secondClaim,
				extract: {
					status: "ready",
					version: 3,
					model: "second-model",
					truncated: false,
					charCount: 99,
					title: "Second result must not overwrite",
				},
				publishReadyObject: async () => {
					secondObjectWrites++;
				},
			},
			h.db(),
		);

		expect(second).toEqual({
			kind: "superseded",
			extract: first.extract,
		});
		expect(firstObjectWrites).toBe(1);
		expect(secondObjectWrites).toBe(0);
		expect((await loadAssetById(asAssetId(firstId)))?.extract).toEqual(
			first.extract,
		);
		expect((await loadAssetById(asAssetId(secondId)))?.extract).toEqual(
			first.extract,
		);
	});
});
