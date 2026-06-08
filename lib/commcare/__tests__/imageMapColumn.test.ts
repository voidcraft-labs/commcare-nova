/**
 * Image-map column — schema + wire emission (suite `enum-image` +
 * hqJson `enum-image`), plus the media-OFF degradation to a plain
 * column.
 *
 * Verified shape: CCHQ's `detail_screen.py::EnumImage` extends the
 * `Enum` format with `template_form = 'image'`, so the wire is the
 * id-mapping `if(selected(field,'v'), <value>, '')` chain under a
 * `<template form="image">`, with each value an image path. Nova
 * inlines `jr://file/commcare/<hash><ext>` literals.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import {
	asUuid,
	columnSchema,
	imageMapColumn,
	imageMapEntry,
} from "@/lib/domain";
import { asAssetId } from "@/lib/domain/multimedia";

const HASH_ACTIVE = "a".repeat(64);
const HASH_CLOSED = "c".repeat(64);

function manifest(): AssetManifest {
	const entry = (
		id: string,
		hash: string,
	): [ReturnType<typeof asAssetId>, ResolvedMediaAsset] => [
		asAssetId(id),
		{
			assetId: asAssetId(id),
			wirePath: `commcare/${hash}.png`,
			kind: "image",
			mimeType: "image/png",
			contentHash: hash,
			extension: ".png",
			bytes: Buffer.from(`${id}-png`),
		},
	];
	return new Map([
		entry("asset-active", HASH_ACTIVE),
		entry("asset-closed", HASH_CLOSED),
	]);
}

function imageMapDoc() {
	return buildDoc({
		appName: "Status icons",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						imageMapColumn(asUuid("col-status"), "status", "Status", [
							imageMapEntry("active", "asset-active"),
							imageMapEntry("closed", "asset-closed"),
						]),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							},
						],
					},
				],
			},
		],
	});
}

describe("image-map column schema", () => {
	it("round-trips through columnSchema", () => {
		const col = imageMapColumn(asUuid("c1"), "status", "Status", [
			imageMapEntry("active", "asset-1"),
		]);
		expect(columnSchema.parse(col)).toEqual(col);
	});

	it("rejects duplicate mapping values", () => {
		const dup = {
			uuid: asUuid("c1"),
			kind: "image-map",
			field: "status",
			header: "Status",
			mapping: [
				{ value: "active", assetId: "a1" },
				{ value: "active", assetId: "a2" },
			],
		};
		expect(columnSchema.safeParse(dup).success).toBe(false);
	});
});

describe("image-map column wire emission", () => {
	it("projects to format enum-image with jr:// image values in HQ JSON", () => {
		const hqJson = expandDoc(imageMapDoc(), { assets: manifest() });
		const shortCols = hqJson.modules[0].case_details.short.columns;
		const statusCol = shortCols.find((c) => c.field === "status");
		expect(statusCol?.format).toBe("enum-image");
		expect(statusCol?.enum).toEqual([
			{ key: "active", value: { en: `jr://file/commcare/${HASH_ACTIVE}.png` } },
			{ key: "closed", value: { en: `jr://file/commcare/${HASH_CLOSED}.png` } },
		]);
	});

	it("emits a <template form=image> with the selected() image chain in suite.xml", () => {
		const doc = imageMapDoc();
		const ccz = compileCcz(
			expandDoc(doc, { assets: manifest() }),
			"Status icons",
			doc,
			{
				assets: manifest(),
			},
		);
		const suite =
			new AdmZip(ccz).getEntry("suite.xml")?.getData().toString("utf-8") ?? "";
		expect(suite).toContain('<template form="image">');
		// enum-image uses a NESTED `if(...)` chain (not id-mapping's
		// `replace(join(...))` wrapper, which would leave a trailing space on
		// the matched image path). The serializer encodes the literal single
		// quotes as `&apos;`.
		expect(suite).not.toContain("replace(join");
		expect(suite).toContain(
			"if(selected(status, &apos;active&apos;), " +
				`&apos;jr://file/commcare/${HASH_ACTIVE}.png&apos;, ` +
				"if(selected(status, &apos;closed&apos;), " +
				`&apos;jr://file/commcare/${HASH_CLOSED}.png&apos;, &apos;&apos;))`,
		);
	});

	it("degrades to a plain column when media is off", () => {
		const hqJson = expandDoc(imageMapDoc());
		const statusCol = hqJson.modules[0].case_details.short.columns.find(
			(c) => c.field === "status",
		);
		// No manifest → no images to map → the raw value column.
		expect(statusCol?.format).toBe("plain");

		const doc = imageMapDoc();
		const ccz = compileCcz(expandDoc(doc), "Status icons", doc);
		const suite =
			new AdmZip(ccz).getEntry("suite.xml")?.getData().toString("utf-8") ?? "";
		expect(suite).not.toContain('<template form="image">');
	});
});
