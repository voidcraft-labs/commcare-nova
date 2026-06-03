/**
 * Tests for `collectMediaValidationErrors` — the shared media-validation
 * gate the four media-ON entry points delegate to.
 *
 * Only `loadAssetsByIds` is mocked (it reads Firestore); the REAL
 * `runValidation` runs so these tests prove the actual rule wiring +
 * the media-category filter, not a restatement of the helper's own
 * assumptions. Each case covers one stale-reference shape that would
 * otherwise make media-ON `expandDoc` throw `requireAssetRef`:
 *
 *   - deleted / foreign-owned asset (absent row) → MEDIA_ASSET_NOT_FOUND
 *   - still-uploading asset (pending row returned) → MEDIA_ASSET_NOT_READY
 *     (the reason the load goes through `loadAssetsByIds`, which returns
 *     pending rows, NOT the ready-only manifest)
 *   - kind mismatch (audio asset in an image slot) → MEDIA_KIND_MISMATCH
 *
 * Plus the load-bearing filter test: a doc carrying BOTH a media error
 * and a non-media error returns ONLY the media code — proof the gate
 * can't newly block previously-working non-media uploads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	makeAssetRecord,
	makeManifest,
} from "@/lib/commcare/validator/rules/media/__tests__/fixtures";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import { MAX_MEDIA_EXPORT_BYTES } from "@/lib/domain/multimedia";
import { collectMediaValidationErrors } from "../mediaValidation";

const OWNER = "owner-1";

/* Only the Firestore read is mocked — `runValidation` runs for real. */
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetsByIds: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(loadAssetsByIds).mockReset();
	vi.mocked(loadAssetsByIds).mockResolvedValue([]);
});

/** A doc whose field label image references `assetId`. */
function docWithLabelImage(assetId: string) {
	return buildDoc({
		appName: "T",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
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
								label: "Name",
								case_property_on: "patient",
								label_media: { image: assetId },
							}),
						],
					},
				],
			},
		],
	});
}

describe("collectMediaValidationErrors", () => {
	it("flags a deleted / foreign-owned asset as MEDIA_ASSET_NOT_FOUND", async () => {
		// The loader returns no row (deleted, or owner-filtered out) — the
		// reference can't resolve, so a media-ON expand would throw.
		vi.mocked(loadAssetsByIds).mockResolvedValue([]);

		const errors = await collectMediaValidationErrors(
			docWithLabelImage("ghost-asset"),
			OWNER,
		);

		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("MEDIA_ASSET_NOT_FOUND");
		expect(errors[0].details?.assetId).toBe("ghost-asset");
	});

	it("flags a still-uploading (pending) asset as MEDIA_ASSET_NOT_READY", async () => {
		// `loadAssetsByIds` returns pending rows (unlike the ready-only
		// emission manifest) precisely so this actionable message can fire
		// instead of a misleading "not found".
		vi.mocked(loadAssetsByIds).mockResolvedValue([
			makeAssetRecord("pending-asset", { status: "pending" }),
		]);

		const errors = await collectMediaValidationErrors(
			docWithLabelImage("pending-asset"),
			OWNER,
		);

		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("MEDIA_ASSET_NOT_READY");
	});

	it("flags a kind mismatch (audio asset in an image slot) as MEDIA_KIND_MISMATCH", async () => {
		// The asset exists and is ready, but it's an audio asset bound to
		// an image slot — emits wire garbage, caught by the kind rule.
		vi.mocked(loadAssetsByIds).mockResolvedValue([
			makeAssetRecord("wrong-kind", {
				kind: "audio",
				mimeType: "audio/mpeg",
				extension: ".mp3",
			}),
		]);

		const errors = await collectMediaValidationErrors(
			docWithLabelImage("wrong-kind"),
			OWNER,
		);

		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("MEDIA_KIND_MISMATCH");
	});

	it("returns ONLY media-category errors when the doc also has a non-media error", async () => {
		// A form with zero fields trips EMPTY_FORM (a non-media rule). The
		// gate must surface the media issue but NOT the EMPTY_FORM — these
		// entry points historically ran only schema parse, so surfacing a
		// non-media error would newly block a previously-working upload.
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "region", label: "Region" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					// Image-map column referencing a missing asset = media error.
					caseListConfig: {
						columns: [
							{
								kind: "image-map",
								uuid: "col-img" as never,
								field: "region",
								header: "Region",
								mapping: [{ value: "N", assetId: "missing" }],
							},
						],
						searchInputs: [],
					},
					forms: [
						// An empty form = the non-media EMPTY_FORM error.
						{ name: "Empty", type: "survey", fields: [] },
					],
				},
			],
		});

		// Sanity: the full runner DOES see the non-media error, so the
		// filter (not an empty doc) is what scopes the result.
		const { runValidation } = await import("@/lib/commcare/validator/runner");
		const allCodes = runValidation(doc, {
			mediaAssets: makeManifest([]),
		}).map((e) => e.code);
		expect(allCodes).toContain("EMPTY_FORM");

		const errors = await collectMediaValidationErrors(doc, OWNER);
		const codes = errors.map((e) => e.code);
		// The media error survives the filter…
		expect(codes).toContain("MEDIA_ASSET_NOT_FOUND");
		// …and the non-media EMPTY_FORM is dropped — the gate doesn't newly
		// block a previously-working non-media upload.
		expect(codes).not.toContain("EMPTY_FORM");
		// Every returned code is in the media category.
		expect(
			codes.every((c) =>
				[
					"MEDIA_ASSET_NOT_FOUND",
					"MEDIA_ASSET_NOT_READY",
					"MEDIA_KIND_MISMATCH",
					"CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE",
				].includes(c),
			),
		).toBe(true);
	});

	it("flags an over-budget export as MEDIA_EXPORT_TOO_LARGE before any download", async () => {
		// A single READY image whose size alone exceeds the aggregate export
		// budget. The reference itself resolves fine (ready + right kind), but
		// the media-ON paths load every referenced asset's bytes into memory at
		// once, so the gate rejects the app here — before `resolveMediaManifest`
		// downloads a single object. (The per-asset caps would stop a real
		// 200 MB upload; the mock sets the size directly to exercise the
		// aggregate gate, which bounds the SUM the per-asset caps don't.)
		vi.mocked(loadAssetsByIds).mockResolvedValue([
			makeAssetRecord("huge-asset", { sizeBytes: MAX_MEDIA_EXPORT_BYTES + 1 }),
		]);

		const errors = await collectMediaValidationErrors(
			docWithLabelImage("huge-asset"),
			OWNER,
		);

		// Only the budget error — the reference is otherwise valid, and the
		// error is app-scoped (an aggregate property, not a per-ref issue).
		expect(errors.map((e) => e.code)).toEqual(["MEDIA_EXPORT_TOO_LARGE"]);
		expect(errors[0].scope).toBe("app");
	});

	it("returns no errors and skips the Firestore read for a media-free doc", async () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
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
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});

		const errors = await collectMediaValidationErrors(doc, OWNER);
		expect(errors).toHaveLength(0);
		// No media refs → no asset load (the early-skip in the helper).
		expect(loadAssetsByIds).not.toHaveBeenCalled();
	});

	it("passes the owner through to the loader", async () => {
		vi.mocked(loadAssetsByIds).mockResolvedValue([]);
		await collectMediaValidationErrors(docWithLabelImage("some-asset"), OWNER);
		expect(loadAssetsByIds).toHaveBeenCalledWith(OWNER, ["some-asset"]);
	});
});
