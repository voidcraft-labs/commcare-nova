import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `mediaAssetReady` — every referenced asset is in
 * `status: "ready"`. The validator's manifest loader includes
 * pending rows; this rule surfaces them with an actionable message.
 *
 * Rendering asserts on the full sentence shape (`toBe(<exact
 * string>)`) so a regression in `describeLocation` or the rule's
 * message template trips here rather than slipping past a substring
 * match.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "../../../runner";
import { makeAssetRecord, makeManifest } from "./fixtures";

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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
			mediaAssets: manifest,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toBe(
			`At the media on option "r" of field "color" in form "Reg", the attached media asset hasn't finished uploading yet. Wait for the upload to complete (the asset chip shows a spinner during upload), or clear the slot if the upload was abandoned.`,
		);
		expect(hits[0].details?.assetId).toBe("pending-asset");
		expect(hits[0].details?.status).toBe("pending");
	});

	it("is silent when every referenced asset is ready", () => {
		const doc = docWithOptionMedia("ready-asset");
		const manifest = makeManifest([
			makeAssetRecord("ready-asset", { status: "ready" }),
		]);
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
			mediaAssets: manifest,
		}).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
