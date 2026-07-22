import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `imageMapValueUnique` — within one image-map column, every
 * mapping entry's `value` is unique.
 *
 * The schema's `.refine()` rejects duplicates at parse time, so this
 * rule's primary job is to catch states constructed below the schema:
 * tests, `.partial()` patches from the SA tool surface, hand-built
 * fixtures.
 *
 * Asserts on the full sentence shape so a regression in the rule's
 * message template fails the test rather than slipping past a
 * substring match. Matches the locked-down assertion pattern in the
 * sibling rule test files.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, imageMapEntry } from "@/lib/domain";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE" as const;

const standardForm = {
	name: "Reg",
	type: "registration" as const,
	fields: [
		f({
			kind: "text" as const,
			id: "case_name",
			label: "Name",
			case_property_on: "patient",
		}),
	],
};

const standardCaseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "region", label: "Region", data_type: "text" as const },
			{ name: "color", label: "Color", data_type: "text" as const },
		],
	},
];

describe("imageMapValueUnique", () => {
	it("fires when an image-map column has two rows sharing one value", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								kind: "image-map",
								uuid: asUuid("col-1"),
								field: "region",
								header: "Region",
								mapping: [
									imageMapEntry("N", "asset-n"),
									imageMapEntry("N", "asset-n-dup"),
								],
							},
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toBe(
			`Image-map column "Region" (column #1) on module "Mod" has two rows that share the value "N" (rows 1 and 2). Each case-property value can map to at most one image, so only the first row's image displays. Change one row's value, or delete the duplicate.`,
		);
		expect(hits[0].details?.value).toBe("N");
		expect(hits[0].details?.firstRowIndex).toBe("0");
		expect(hits[0].details?.duplicateRowIndex).toBe("1");
	});

	it("is silent when every row's value is distinct", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								kind: "image-map",
								uuid: asUuid("col-1"),
								field: "region",
								header: "Region",
								mapping: [
									imageMapEntry("N", "asset-n"),
									imageMapEntry("S", "asset-s"),
								],
							},
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("does not collide across two columns sharing the same value", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								kind: "image-map",
								uuid: asUuid("col-region"),
								field: "region",
								header: "Region",
								mapping: [imageMapEntry("N", "asset-r-n")],
							},
							{
								kind: "image-map",
								uuid: asUuid("col-color"),
								field: "color",
								header: "Color",
								mapping: [imageMapEntry("N", "asset-c-n")],
							},
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
