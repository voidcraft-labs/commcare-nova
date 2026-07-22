import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `idMappingValueRequired`. The schema admits empty
 * `value` slots as the editor's "row added, not yet filled"
 * transient state; the validator is the trust boundary that keeps
 * the transient state from reaching wire.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, idMappingEntry } from "@/lib/domain";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_ID_MAPPING_EMPTY_VALUE" as const;

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
		],
	},
];

describe("idMappingValueRequired", () => {
	it("fires when an id-mapping column has an empty-value entry", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								kind: "id-mapping",
								uuid: asUuid("col-1"),
								field: "region",
								header: "Region",
								mapping: [
									idMappingEntry("N", "North"),
									idMappingEntry("", "Unfilled"),
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("Region");
		// 1-based row index in the message.
		expect(hits[0].message).toContain("row 2");
	});

	it("is silent when every entry has a non-empty value", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								kind: "id-mapping",
								uuid: asUuid("col-1"),
								field: "region",
								header: "Region",
								mapping: [
									idMappingEntry("N", "North"),
									idMappingEntry("S", "South"),
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});
});
