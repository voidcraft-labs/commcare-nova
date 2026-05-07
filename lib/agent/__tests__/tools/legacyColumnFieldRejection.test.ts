/**
 * Schema-rejection tests for the legacy `case_list_columns` /
 * `case_detail_columns` fields on the module-scoped SA tools.
 *
 * Until the case-list-config typed-AST tools landed, `updateModule`,
 * `createModule`, and the now-deleted `addModule` accepted a flat
 * `{field, header}[]` shape and translated each entry to a `kind:
 * "plain"` Column at the persistence boundary. That mapping flattened
 * any structured authoring (Date / Phone / Late Flag / IDMapping /
 * Time-Since-Until / Search-Only) the SA had previously made through
 * `setCaseListColumns` — the SA could call `setCaseListColumns` to
 * author a Date column, then a follow-up `updateModule` for an
 * unrelated rename would silently flatten it back to plain.
 *
 * The follow-up commit dropped both fields entirely; case list
 * authoring lives exclusively on the typed case-list-config tools
 * (`setCaseListColumns`, `setCaseListSort`, `setCaseListFilter`,
 * `setCalculatedColumns`, `setCaseListSearchInputs`). These tests
 * pin that the input schemas reject any call still carrying the
 * legacy field — Zod's default `.strict()` is OFF on `z.object`, so
 * unknown keys are silently stripped rather than rejected. We
 * therefore assert via the inferred TypeScript type at parse time:
 * `safeParse` on a payload with the legacy key returns success but
 * the parsed output omits the key entirely (i.e. the field is no
 * longer part of the schema).
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
		// the dedicated `setCaseListColumns` tool after the module is
		// created.
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
