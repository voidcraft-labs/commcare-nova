/**
 * Tests for `collectBoundaryViolations` — the zero-tolerance boundary
 * gate the four export entry points delegate to.
 *
 * Only `loadAssetsByIds` is mocked (it reads Firestore); the REAL
 * validator runs so these tests prove the actual rule wiring, not a
 * restatement of the helper's own assumptions. The media cases cover the
 * stale-reference shapes that would otherwise make media-ON `expandDoc`
 * throw `requireAssetRef`:
 *
 *   - deleted / foreign-owned asset (absent row) → MEDIA_ASSET_NOT_FOUND
 *   - still-uploading asset (pending row returned) → MEDIA_ASSET_NOT_READY
 *     (the reason the load goes through `loadAssetsByIds`, which returns
 *     pending rows, NOT the ready-only manifest)
 *   - kind mismatch (audio asset in an image slot) → MEDIA_KIND_MISMATCH
 *
 * Plus the load-bearing zero-tolerance test: a doc carrying BOTH a media
 * error and a non-media error returns BOTH — the boundary rejects on any
 * validator finding, never just the media subset.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { makeAssetRecord } from "@/lib/commcare/validator/rules/media/__tests__/fixtures";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import { MAX_MEDIA_EXPORT_BYTES } from "@/lib/domain/multimedia";
import { collectBoundaryViolations } from "../boundaryValidation";

const OWNER = "owner-1";

/* Only the Firestore read is mocked — the validator runs for real. */
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetsByIds: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(loadAssetsByIds).mockReset();
	vi.mocked(loadAssetsByIds).mockResolvedValue([]);
});

/**
 * A doc that passes the boundary clean when its media resolves: one
 * registration module/form writing two case properties, a case list with
 * a column. The optional `assetId` attaches a label image so each media
 * case introduces exactly one failure mode against this baseline.
 */
function validDoc(assetId?: string) {
	return buildDoc({
		appName: "T",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
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
								...(assetId && { label_media: { image: assetId } }),
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
	});
}

describe("collectBoundaryViolations", () => {
	it("returns no violations for a fully valid doc with resolved media", async () => {
		vi.mocked(loadAssetsByIds).mockResolvedValue([
			makeAssetRecord("good-asset"),
		]);
		const errors = await collectBoundaryViolations(
			validDoc("good-asset"),
			OWNER,
		);
		expect(errors).toHaveLength(0);
	});

	it("flags a deleted / foreign-owned asset as MEDIA_ASSET_NOT_FOUND", async () => {
		// The loader returns no row (deleted, or owner-filtered out) — the
		// reference can't resolve, so a media-ON expand would throw.
		vi.mocked(loadAssetsByIds).mockResolvedValue([]);

		const errors = await collectBoundaryViolations(
			validDoc("ghost-asset"),
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

		const errors = await collectBoundaryViolations(
			validDoc("pending-asset"),
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

		const errors = await collectBoundaryViolations(
			validDoc("wrong-kind"),
			OWNER,
		);

		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("MEDIA_KIND_MISMATCH");
	});

	it("returns EVERY finding — media and non-media alike (zero tolerance)", async () => {
		// A doc with an image-map column referencing a missing asset (media
		// error) AND an empty form (the non-media completeness error
		// EMPTY_FORM). The boundary must reject on both: a broken artifact
		// is broken regardless of which rule caught it.
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "patient", properties: [{ name: "region", label: "Region" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
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
					forms: [{ name: "Empty", type: "survey", fields: [] }],
				},
			],
		});

		const errors = await collectBoundaryViolations(doc, OWNER);
		const codes = errors.map((e) => e.code);
		expect(codes).toContain("MEDIA_ASSET_NOT_FOUND");
		expect(codes).toContain("EMPTY_FORM");
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

		const errors = await collectBoundaryViolations(
			validDoc("huge-asset"),
			OWNER,
		);

		// Only the budget error — the reference is otherwise valid, and the
		// error is app-scoped (an aggregate property, not a per-ref issue).
		expect(errors.map((e) => e.code)).toEqual(["MEDIA_EXPORT_TOO_LARGE"]);
		expect(errors[0].scope).toBe("app");
	});

	it("returns no errors and skips the Firestore read for a valid media-free doc", async () => {
		const errors = await collectBoundaryViolations(validDoc(), OWNER);
		expect(errors).toHaveLength(0);
		// No media refs → no asset load (the early-skip in the helper).
		expect(loadAssetsByIds).not.toHaveBeenCalled();
	});

	it("passes the owner through to the loader", async () => {
		vi.mocked(loadAssetsByIds).mockResolvedValue([]);
		await collectBoundaryViolations(validDoc("some-asset"), OWNER);
		expect(loadAssetsByIds).toHaveBeenCalledWith(OWNER, ["some-asset"]);
	});
});
