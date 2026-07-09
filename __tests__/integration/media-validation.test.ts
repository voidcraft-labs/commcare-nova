/**
 * Integration: a real `BlueprintDoc` round-trips through
 * `runValidation(doc, { mediaAssets })` and the three media
 * asset-context rules emit the expected errors for each kind of
 * seeded bad reference.
 *
 * Sits at the integration layer (not the per-rule unit-test layer)
 * because it asserts the runner threads the manifest correctly into
 * every asset-context rule, not the rule's individual logic. The
 * per-rule unit tests under
 * `lib/commcare/validator/rules/media/__tests__/` own the
 * per-rule contract.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { asAssetId, asUuid, imageMapEntry } from "@/lib/domain";

const OWNER = "owner-integration-fixture";

/**
 * Build a `MediaAssetRecord` fixture. Hand-built so the manifest can
 * carry pending rows the production library list filters out — the SA
 * loop's loader includes them (so `mediaAssetReady` can fire with its
 * actionable message); these tests match that semantic.
 */
function record(
	id: string,
	overrides: Partial<MediaAssetRecord> = {},
): MediaAssetRecord {
	return {
		owner: OWNER,
		project_id: OWNER,
		contentHash: "a".repeat(64),
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 100,
		gcsObjectKey: `projects/${OWNER}/${"a".repeat(64)}.png`,
		originalFilename: `${id}.png`,
		displayName: id,
		status: "ready",
		created_at: new Date(0),
		...overrides,
		id: asAssetId(overrides.id ?? id),
	};
}

describe("media validation integration", () => {
	it("threads a real manifest through the runner and surfaces every asset-context violation on one doc", () => {
		// Doc seeds three kinds of bad ref, plus one good ref to
		// confirm clean references don't fire.
		const doc = buildDoc({
			appName: "Media app",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" as const },
						{ name: "region", label: "Region", data_type: "text" as const },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								kind: "image-map",
								uuid: asUuid("col-img"),
								field: "region",
								header: "Region",
								mapping: [
									// Good row — owned, ready, image.
									imageMapEntry("N", "good-image"),
									// Row whose asset is missing from the manifest
									// (production: the loader filtered it because the
									// row was deleted or belongs to a foreign owner).
									imageMapEntry("S", "missing-asset"),
								],
							},
						],
						searchInputs: [],
					},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Patient name",
									case_property_on: "patient",
									help: "Help text",
									// Pending asset — manifest carries the row but
									// `status: "pending"`.
									help_media: { audio: "pending-audio" },
								}),
								f({
									kind: "single_select",
									id: "color",
									label: "Color",
									options: [
										{
											value: "r",
											label: "Red",
											// Kind mismatch — audio asset in an image slot.
											media: { image: "audio-asset" },
										},
										{ value: "g", label: "Green" },
									],
								}),
							],
						},
					],
				},
			],
		});

		const manifest = new Map<string, MediaAssetRecord>([
			["good-image", record("good-image")],
			[
				"pending-audio",
				record("pending-audio", {
					kind: "audio",
					mimeType: "audio/mpeg",
					extension: ".mp3",
					status: "pending",
				}),
			],
			[
				"audio-asset",
				record("audio-asset", {
					kind: "audio",
					mimeType: "audio/mpeg",
					extension: ".mp3",
				}),
			],
			// `missing-asset` deliberately absent — exercises
			// MEDIA_ASSET_NOT_FOUND.
		]);

		const errors = runValidation(doc, { mediaAssets: manifest });

		// One error per distinct contract violation. The integration
		// concern is "does each rule fire from the runner under one
		// invocation"; the per-rule unit tests own message phrasing
		// and edge cases.
		const codes = errors.map((e) => e.code);
		expect(codes).toContain("MEDIA_ASSET_NOT_FOUND");
		expect(codes).toContain("MEDIA_ASSET_NOT_READY");
		expect(codes).toContain("MEDIA_KIND_MISMATCH");
	});

	it("skips the asset-context group when the manifest is omitted", () => {
		// Doc references a bad asset; without a manifest the runner is
		// expected to skip the three asset-context rules entirely.
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" as const },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Patient name",
									case_property_on: "patient",
									label_media: { image: "missing-asset" },
								}),
							],
						},
					],
				},
			],
		});

		const errors = runValidation(doc);
		const mediaCodes = errors
			.map((e) => e.code)
			.filter(
				(c) =>
					c === "MEDIA_ASSET_NOT_FOUND" ||
					c === "MEDIA_ASSET_NOT_READY" ||
					c === "MEDIA_KIND_MISMATCH",
			);
		expect(mediaCodes).toHaveLength(0);
	});
});
