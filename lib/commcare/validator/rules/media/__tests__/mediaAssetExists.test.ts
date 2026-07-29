import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
/**
 * Tests for `mediaAssetExists` — every referenced `MediaAssetId` resolves
 * to a row in the manifest.
 *
 * Per-carrier rendering asserts on the full sentence shape
 * (`toBe(<exact string>)`) so a regression in `describeLocation` or
 * the rule's message template trips the test rather than slipping
 * past a substring match.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "../../../runner";
import { makeAssetRecord, makeManifest, mediaId } from "./fixtures";

const CODE = "MEDIA_ASSET_NOT_FOUND" as const;

describe("mediaAssetExists", () => {
	it("fires when a field's label image references an asset that isn't in the manifest", () => {
		const missingAsset = mediaId("missing-asset");
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
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
									label: proseText("Name"),
									case_property_on: "patient",
									label_media: { image: missingAsset },
								}),
							],
						},
					],
				},
			],
		});
		// Manifest is empty — the reference can't resolve.
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
			mediaAssets: makeManifest([]),
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toBe(
			`At the label media on field "case_name" in form "Reg", the attached media asset couldn't be found. It may have been deleted from the media library, or the reference may be stale. Open the slot and pick a different asset, or clear it if no media should sit there.`,
		);
		expect(hits[0].details?.assetId).toBe(missingAsset);
	});

	it("fires for a module icon, a form audio label, and an image-map row", () => {
		const missingIcon = mediaId("missing-icon");
		const missingAudio = mediaId("missing-audio");
		const rowAsset = mediaId("row-asset");
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "region", label: proseText("Region") }],
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
								uuid: "col-img" as never,
								field: "region",
								header: "Region",
								mapping: [{ value: "N", assetId: rowAsset }],
							},
						],
						listColumnOrder: ["col-img" as never],
						detailColumnOrder: ["col-img" as never],
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
									label: proseText("Name"),
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		// Doc-store-shaped mutation: stamp the icon + form audio +
		// image-map row directly onto the built doc. Each reference
		// points at an absent asset.
		const moduleUuid = doc.moduleOrder[0];
		doc.modules[moduleUuid].icon = missingIcon;
		const formUuid = doc.formOrder[moduleUuid][0];
		doc.forms[formUuid].audioLabel = missingAudio;

		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
			mediaAssets: makeManifest([]),
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(3);
		const messages = hits.map((h) => h.message).sort();
		// Sorting both arrays makes the assertion order-independent
		// (the walker's emission order is canonical, but locking the
		// assertion to it would reward incidental ordering changes).
		expect(messages).toEqual(
			[
				`At the icon on module "Patients", the attached media asset couldn't be found. It may have been deleted from the media library, or the reference may be stale. Open the slot and pick a different asset, or clear it if no media should sit there.`,
				`At the audio label on form "Reg" in module "Patients", the attached media asset couldn't be found. It may have been deleted from the media library, or the reference may be stale. Open the slot and pick a different asset, or clear it if no media should sit there.`,
				`At row 1 of the image-map column "Region" on module "Patients", the attached media asset couldn't be found. It may have been deleted from the media library, or the reference may be stale. Open the slot and pick a different asset, or clear it if no media should sit there.`,
			].sort(),
		);
	});

	it("stays silent when every referenced id resolves", () => {
		const goodAsset = mediaId("good-asset");
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
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
									label: proseText("Name"),
									case_property_on: "patient",
									label_media: { image: goodAsset },
								}),
							],
						},
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
			mediaAssets: makeManifest([makeAssetRecord("good-asset")]),
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("carries columnUuid + rowIndex in details when the bad ref sits in an image-map row", () => {
		const present = mediaId("present");
		const missingRowAsset = mediaId("missing-row-asset");
		// Image-map mappings live one level below the validator's
		// ValidationLocation shape (which carries entity uuids, not
		// per-row coordinates). The asset-context rules surface the
		// row's columnUuid + 0-based rowIndex on details so the UI can
		// deep-link past the column to the exact row — same convention
		// as `idMappingValueRequired`.
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "region", label: proseText("Region") }],
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
								uuid: "col-regions" as never,
								field: "region",
								header: "Region",
								mapping: [
									{ value: "N", assetId: present },
									{ value: "S", assetId: missingRowAsset },
								],
							},
						],
						listColumnOrder: ["col-regions" as never],
						detailColumnOrder: ["col-regions" as never],
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
									label: proseText("Name"),
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
			mediaAssets: makeManifest([makeAssetRecord("present")]),
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		const hit = hits[0];
		expect(hit.details?.assetId).toBe(missingRowAsset);
		expect(hit.details?.columnUuid).toBe("col-regions");
		// 0-based row index — the second row (index 1) is the one
		// pointing at the missing asset.
		expect(hit.details?.rowIndex).toBe("1");
	});

	it("does not run at all when the runner is called without a manifest", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
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
									label: proseText("Name"),
									case_property_on: "patient",
									label_media: { image: "missing-asset" },
								}),
							],
						},
					],
				},
			],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});
});
