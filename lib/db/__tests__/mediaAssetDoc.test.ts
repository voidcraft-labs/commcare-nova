/**
 * Row → `MediaAssetRecord` mapping coverage, exercised through `loadAssetById`
 * over the real per-test Postgres.
 *
 * On Firestore the media-asset record was validated on every read by a Zod
 * converter (`mediaAssetDocSchema.parse`); those shape-guard arms are gone with
 * the converter. On Postgres the field invariants are column types + the
 * write-boundary validation the upload/confirm routes run BEFORE the insert
 * (`createPendingAsset` / `confirmAssetReady`), so a stored row is already
 * well-formed. What remains is `mediaAssets.ts::toRecord` — the read-time mapping
 * that `Number(...)`s the `bigint` columns (`size_bytes`, `duration_ms`), parses
 * the `extract` jsonb through `mediaAssetExtractSchema`, and omits an optional
 * whenever its column is null. This suite pins that mapping.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { asAssetId, MEDIA_EXTRACT_STATUSES } from "@/lib/domain/multimedia";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("media_record_");

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
});
