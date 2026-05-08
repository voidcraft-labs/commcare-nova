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
 * the case-list-config tools (`addCaseListColumn`,
 * `updateCaseListColumn`, `removeCaseListColumn`,
 * `reorderCaseListColumns`, `setCaseListFilter`, and the search-input
 * parallels). These tests pin that the module-scoped tools' input
 * schemas don't carry the legacy fields — Zod's default `.strict()`
 * is OFF on `z.object`, so unknown keys are silently stripped rather
 * than rejected. We therefore assert via the parsed output: a payload
 * with the legacy key parses successfully but the legacy field is
 * omitted from `result.data`.
 *
 * The behavioral guard against legacy callers reaching the
 * persistence layer is the absent field on the parsed output: the
 * tool body destructures only the schema's declared keys, so an
 * unknown `case_list_columns` key on an LLM-emitted payload never
 * reaches the mapping branch. That's the regression the test fixes.
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

	it("input schema strips legacy case_list_columns from the parsed payload", () => {
		// `z.object()` defaults to strip mode for unknown keys — the parse
		// succeeds, but the legacy field never reaches the parsed `data`.
		// The behavioral consequence: the tool body destructures only
		// declared keys, so a stale LLM-emitted payload carrying the legacy
		// shape no longer reaches the (now-deleted) mapping branch.
		const result = updateModuleInputSchema.safeParse({
			moduleIndex: 0,
			name: "Renamed",
			case_list_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).not.toHaveProperty("case_list_columns");
		}
	});

	it("input schema strips legacy case_detail_columns from the parsed payload", () => {
		const result = updateModuleInputSchema.safeParse({
			moduleIndex: 0,
			name: "Renamed",
			case_detail_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).not.toHaveProperty("case_detail_columns");
		}
	});

	it("input schema rejects a payload missing the now-required name", () => {
		// Sanity-check: dropping the columns made `name` the sole edit
		// surface, so the schema requires it. A payload with only
		// `moduleIndex` is meaningless and must fail to parse.
		const result = updateModuleInputSchema.safeParse({ moduleIndex: 0 });
		expect(result.success).toBe(false);
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

	it("input schema strips legacy case_list_columns from the parsed payload", () => {
		// Same strip-on-unknown semantics as `updateModule`: the legacy
		// field never reaches the parsed `data`, so the tool body's
		// destructure can't observe it. Case list authoring goes through
		// the dedicated case-list-config tools (`addCaseListColumn`
		// et al.) after the module is created.
		const result = createModuleInputSchema.safeParse({
			name: "Patients",
			case_type: "patient",
			case_list_columns: [{ field: "case_name", header: "Name" }],
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).not.toHaveProperty("case_list_columns");
		}
	});
});
