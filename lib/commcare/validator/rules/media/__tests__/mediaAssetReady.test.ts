/**
 * Tests for `mediaAssetReady` — every referenced asset is in
 * `status: "ready"`.
 *
 * Production `loadAssetsByIds` filters out `pending` rows; the
 * fixture hand-builds one to exercise the contract.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "../../../runner";
import { APP_OWNER, makeAssetRecord, makeManifest } from "./fixtures";

const CODE = "MEDIA_ASSET_NOT_READY" as const;

function docWithOptionMedia(assetId: string) {
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
							}),
							f({
								kind: "single_select",
								id: "color",
								label: "Color",
								options: [
									{
										value: "r",
										label: "Red",
										media: { image: assetId },
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
}

describe("mediaAssetReady", () => {
	it("fires when a pending asset is referenced", () => {
		const doc = docWithOptionMedia("pending-asset");
		const manifest = makeManifest([
			makeAssetRecord("pending-asset", { status: "pending" }),
		]);
		const hits = runValidation(doc, {
			mediaAssets: manifest,
			expectedOwner: APP_OWNER,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("hasn't finished uploading");
		expect(hits[0].details?.assetId).toBe("pending-asset");
		expect(hits[0].details?.status).toBe("pending");
	});

	it("is silent when every referenced asset is ready", () => {
		const doc = docWithOptionMedia("ready-asset");
		const manifest = makeManifest([
			makeAssetRecord("ready-asset", { status: "ready" }),
		]);
		const hits = runValidation(doc, {
			mediaAssets: manifest,
			expectedOwner: APP_OWNER,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
