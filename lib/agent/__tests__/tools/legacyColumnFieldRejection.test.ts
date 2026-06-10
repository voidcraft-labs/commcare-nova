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
 * Both fields are gone now; case list authoring lives exclusively on
 * the case-list-config tools (`addCaseListColumns`,
 * `updateCaseListColumn`, `removeCaseListColumn`,
 * `reorderCaseListColumns`, `setCaseListFilter`, and the search-input
 * parallels). These tests pin that the module-scoped tools' input
 * schemas don't carry the legacy fields — every input schema is
 * `.strict()`, so a stale LLM-emitted payload carrying the legacy
 * shape fails to parse rather than reaching the (now-deleted) mapping
 * branch.
 */

import { describe, expect, it } from "vitest";
import { createModuleInputSchema } from "../../tools/createModule";
import { updateModuleInputSchema } from "../../tools/updateModule";

describe("updateModule legacy column field rejection", () => {
	it("input schema parses a name-only payload cleanly", () => {
		const result = updateModuleInputSchema.safeParse({
			moduleIndex: 0,
			name: "Renamed",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ moduleIndex: 0, name: "Renamed" });
		}
	});

	it("input schema rejects legacy case_list_columns at parse time", () => {
		// The schema is `.strict()`, so a stale LLM-emitted payload
		// carrying the legacy field fails to parse rather than stripping
		// silently. The behavioral guard is now at the parse boundary —
		// the tool body never sees the legacy shape.
		const result = updateModuleInputSchema.safeParse({
			moduleIndex: 0,
			name: "Renamed",
			case_list_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(false);
	});

	it("input schema rejects legacy case_detail_columns at parse time", () => {
		const result = updateModuleInputSchema.safeParse({
			moduleIndex: 0,
			name: "Renamed",
			case_detail_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(false);
	});

	it("input schema parses a payload with neither name nor case_type (the tool body rejects it)", () => {
		// `name` and `case_type` are each optional — the schema accepts a
		// bare moduleIndex and the tool body returns the "nothing to
		// update" error, so the SA gets a corrective message rather than a
		// parse failure it can't read.
		const result = updateModuleInputSchema.safeParse({ moduleIndex: 0 });
		expect(result.success).toBe(true);
	});

	it("input schema parses a case_type-only payload (the NO_CASE_TYPE repair path)", () => {
		const result = updateModuleInputSchema.safeParse({
			moduleIndex: 0,
			case_type: "patient",
		});
		expect(result.success).toBe(true);
	});
});

describe("createModule legacy column field rejection", () => {
	it("input schema parses a minimal name+case_type payload cleanly", () => {
		const result = createModuleInputSchema.safeParse({
			name: "Patients",
			case_type: "patient",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({ name: "Patients", case_type: "patient" });
		}
	});

	it("input schema rejects legacy case_list_columns at parse time", () => {
		// Same strict-mode rejection as `updateModule`: the legacy field
		// fails the schema and the tool body never sees it. Case list
		// authoring goes through the dedicated case-list-config tools
		// (`addCaseListColumns` et al.) after the module is created.
		const result = createModuleInputSchema.safeParse({
			name: "Patients",
			case_type: "patient",
			case_list_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(false);
	});
});
