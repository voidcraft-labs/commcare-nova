/**
 * Tests for `mediaAssetOwnership` — every referenced asset's `owner`
 * matches the expected app owner.
 *
 * The production `loadAssetsByIds` filters out foreign-owned rows, so
 * the manifest here is hand-built to include one. The rule's contract
 * is what's under test, not the loader's behavior.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "../../../runner";
import {
	APP_OWNER,
	FOREIGN_OWNER,
	makeAssetRecord,
	makeManifest,
} from "./fixtures";

const CODE = "MEDIA_ASSET_FOREIGN_OWNER" as const;

function patientDocWithLabelMedia(assetId: string) {
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

describe("mediaAssetOwnership", () => {
	it("fires when a manifest row's owner doesn't match the expected app owner", () => {
		const doc = patientDocWithLabelMedia("foreign-asset");
		const manifest = makeManifest([
			makeAssetRecord("foreign-asset", { owner: FOREIGN_OWNER }),
		]);
		const hits = runValidation(doc, {
			mediaAssets: manifest,
			expectedOwner: APP_OWNER,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("different user");
		expect(hits[0].details?.assetId).toBe("foreign-asset");
	});

	it("is silent when every manifest row matches the expected owner", () => {
		const doc = patientDocWithLabelMedia("own-asset");
		const manifest = makeManifest([
			makeAssetRecord("own-asset", { owner: APP_OWNER }),
		]);
		const hits = runValidation(doc, {
			mediaAssets: manifest,
			expectedOwner: APP_OWNER,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("is silent when an asset is missing from the manifest (existence rule's domain)", () => {
		const doc = patientDocWithLabelMedia("missing-asset");
		// Manifest has zero entries — `mediaAssetExists` fires, ownership
		// has nothing to compare and stays out of the way.
		const hits = runValidation(doc, {
			mediaAssets: makeManifest([]),
			expectedOwner: APP_OWNER,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
