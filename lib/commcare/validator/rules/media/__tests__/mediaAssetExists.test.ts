/**
 * Tests for `mediaAssetExists` — every referenced `AssetId` resolves
 * to a row in the manifest.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "../../../runner";
import { APP_OWNER, makeAssetRecord, makeManifest } from "./fixtures";

const CODE = "MEDIA_ASSET_NOT_FOUND" as const;

describe("mediaAssetExists", () => {
	it("fires when a field's label image references an asset that isn't in the manifest", () => {
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
									label_media: { image: "missing-asset" },
								}),
							],
						},
					],
				},
			],
		});
		// Manifest is empty — the reference can't resolve.
		const hits = runValidation(doc, {
			mediaAssets: makeManifest([]),
			expectedOwner: APP_OWNER,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("label media slot");
		expect(hits[0].message).toContain('"case_name"');
		expect(hits[0].details?.assetId).toBe("missing-asset");
	});

	it("fires for a module icon, a form audio label, and an image-map row", () => {
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
								mapping: [{ value: "N", assetId: "row-asset" }],
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
									label: "Name",
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
		doc.modules[moduleUuid].icon = "missing-icon";
		const formUuid = doc.formOrder[moduleUuid][0];
		doc.forms[formUuid].audioLabel = "missing-audio";

		const hits = runValidation(doc, {
			mediaAssets: makeManifest([]),
			expectedOwner: APP_OWNER,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(3);
		const messages = hits.map((h) => h.message);
		expect(messages.some((m) => m.includes("icon slot on module"))).toBe(true);
		expect(messages.some((m) => m.includes("audio-label slot on form"))).toBe(
			true,
		);
		expect(messages.some((m) => m.includes("image-map column"))).toBe(true);
	});

	it("stays silent when every referenced id resolves", () => {
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
									label_media: { image: "good-asset" },
								}),
							],
						},
					],
				},
			],
		});
		const hits = runValidation(doc, {
			mediaAssets: makeManifest([makeAssetRecord("good-asset")]),
			expectedOwner: APP_OWNER,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("does not run at all when the runner is called without a manifest", () => {
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
									label_media: { image: "missing-asset" },
								}),
							],
						},
					],
				},
			],
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
