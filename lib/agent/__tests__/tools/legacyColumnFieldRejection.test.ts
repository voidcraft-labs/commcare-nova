/**
 * Schema-rejection tests for the legacy `case_list_columns` /
 * `case_detail_columns` fields on the module-scoped SA tools.
 *
 * `updateModule` and `createModule` historically accepted a flat
 * `{field, header}[]` shape on those keys and translated each entry
 * to a `kind: "plain"` Column at the persistence boundary. That
 * mapping flattened any structured authoring (Date / Phone /
 * IDMapping / Interval / Calculated) the SA had previously made
 * through the case-list-config tools — a follow-up `updateModule`
 * for an unrelated rename would silently flatten it back to plain.
 *
 * Both module tools now accept the canonical kind-discriminated Column
 * projection only where validity requires a same-call seed. Ongoing case-list
 * authoring remains on the case-list-config tools. These tests pin that a stale
 * flat payload fails instead of reaching a compatibility mapping.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { createModuleInputSchema } from "../../tools/createModule";
import { updateModuleInputSchema } from "../../tools/updateModule";

const MODULE_UUID = testUuid("legacy-column-rejection-module");

describe("updateModule legacy column field rejection", () => {
	it("input schema parses a name-only payload cleanly", () => {
		const result = updateModuleInputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			name: "Renamed",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({
				moduleUuid: MODULE_UUID,
				name: "Renamed",
			});
		}
	});

	it("input schema rejects legacy case_list_columns at parse time", () => {
		// The schema is `.strict()`, so a stale LLM-emitted payload
		// carrying the legacy field fails to parse rather than stripping
		// silently. The behavioral guard is now at the parse boundary —
		// the tool body never sees the legacy shape.
		const result = updateModuleInputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			name: "Renamed",
			case_list_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(false);
	});

	it("input schema rejects legacy case_detail_columns at parse time", () => {
		const result = updateModuleInputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			name: "Renamed",
			case_detail_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(false);
	});

	it("input schema parses a payload with neither name nor case_type (the tool body rejects it)", () => {
		// `name` and `case_type` are each optional — the schema accepts a
		// bare module UUID and the tool body returns the "nothing to
		// update" error, so the SA gets a corrective message rather than a
		// parse failure it can't read.
		const result = updateModuleInputSchema.safeParse({
			moduleUuid: MODULE_UUID,
		});
		expect(result.success).toBe(true);
	});

	it("input schema parses a case_type-only payload (the NO_CASE_TYPE repair path)", () => {
		const result = updateModuleInputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			case_type: "patient",
		});
		expect(result.success).toBe(true);
	});
});

describe("createModule legacy column field rejection", () => {
	it("rejects a case type without its valid-by-construction Results seed", () => {
		const result = createModuleInputSchema.safeParse({
			name: "Patients",
			case_type: "patient",
		});
		expect(result.success).toBe(false);
	});

	it("input schema rejects legacy case_list_columns at parse time", () => {
		// The key is current, but the old flat entry is not. Creation accepts
		// only a canonical discriminated Column and never maps this shape.
		const result = createModuleInputSchema.safeParse({
			name: "Patients",
			case_type: "patient",
			case_list_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(false);
	});

	it("accepts the canonical visible Results seed", () => {
		const result = createModuleInputSchema.safeParse({
			name: "Patients",
			case_type: "patient",
			case_list_columns: [
				{
					kind: "plain",
					field: "case_name",
					header: "Patient",
					visibleInList: true,
				},
			],
		});
		expect(result.success).toBe(true);
	});
});
