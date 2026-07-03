/**
 * Fix-registry dissolution proofs — one test per entry of the RETIRED
 * `FIX_REGISTRY` (deleted with the validate-fix loop), each showing the
 * guarded construction path cannot PRODUCE the condition that fix
 * existed to repair. These per-entry pins are what the deletion stands
 * on (alongside the sequence fuzz in `constructionFuzz.test.ts`):
 *
 *   - codes whose conditions the commit gate now rejects at the
 *     introducing batch (`guardedMutate` / the builder hook — same
 *     verdict): NO_CASE_TYPE, RESERVED_CASE_PROPERTY,
 *     UNQUOTED_STRING_LITERAL, CLOSE_CONDITION_WRONG_TYPE,
 *     CLOSE_CONDITION_INCOMPLETE, CLOSE_CONDITION_FIELD_NOT_FOUND,
 *     UNKNOWN_FUNCTION, WRONG_ARITY, CASE_PROPERTY_BAD_FORMAT;
 *   - codes already unrepresentable through construction (shape):
 *     MEDIA_CASE_PROPERTY (no `case_property_on` slot on media kinds —
 *     pinned on the add arm, the edit arm, AND the strict domain
 *     schema), SELECT_NO_OPTIONS (domain schema `.min(2)`; the UI
 *     picker seeds two starter options; the SA add path fails
 *     assembly);
 *   - INVALID_FIELD_ID — rejected at source by the shared identifier
 *     verdicts (`lib/doc/identifierVerdicts.ts`), pinned here through
 *     the `addFields` path;
 *   - NO_CASE_NAME_FIELD — completeness, NOT dissolvable to a
 *     construction default (the case-name field is content the author
 *     adds): a creation lands it with the form, and removing it is
 *     rejected (pinned here) — the same single rule as everything else.
 */

import { describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc, fieldSchema } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { addFieldsItemSchema, editFieldUpdatesSchema } from "../../toolSchemas";
import { addFieldsTool } from "../addFields";
import { createFormTool } from "../createForm";
import { updateModuleTool } from "../updateModule";

/** Bare ctx stub — `recordMutations` is the persistence assertion surface. The
 *  guarded writer returns `{ events, committedDoc }`; echo the passed
 *  post-mutation doc as the committed doc so the tool's `newDoc` reflects it. */
function makeCtx() {
	const recordMutations = vi.fn(async (_m: unknown, doc: unknown) => ({
		events: [],
		committedDoc: doc,
	}));
	const recordMutationStages = vi.fn(
		async (stages: Array<{ doc: unknown }>) => ({
			events: [],
			committedDoc: stages[stages.length - 1]?.doc,
		}),
	);
	const ctx: ToolExecutionContext = {
		appId: "app-1",
		userId: "user-1",
		runId: "run-1",
		recordMutations,
		recordMutationStages,
		recordConversation: vi.fn(),
	} as unknown as ToolExecutionContext;
	return { ctx, recordMutations };
}

/** Valid registration baseline: one patient module writing two properties. */
function minDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
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
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

/** A doc whose module has NO case type and no case forms (a survey).
 *  Carries a `respondent` case-type record so the conversion repair has a
 *  resolvable property surface to seed columns from. */
function caseTypelessDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Surveys",
				forms: [
					{
						name: "Feedback",
						type: "survey",
						fields: [f({ kind: "text", id: "comments", label: "Comments" })],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "respondent",
				properties: [{ name: "case_name", label: "Name" }],
			},
		],
	});
}

/** Field lookup by semantic id. */
function fieldByBareId(doc: BlueprintDoc, id: string) {
	const field = Object.values(doc.fields).find((fl) => fl.id === id);
	if (!field) throw new Error(`fixture missing field "${id}"`);
	return field;
}

// ── NO_CASE_TYPE ────────────────────────────────────────────────────

describe("NO_CASE_TYPE — rejected at the introducing commit; updateModule is the repair", () => {
	it("createForm(registration) on a case-typeless module fails the call, nothing persisted", async () => {
		const { ctx, recordMutations } = makeCtx();
		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Register",
				type: "registration",
				fields: [{ kind: "text", id: "case_name", label: "Name" } as never],
			},
			ctx,
			caseTypelessDoc(),
		);
		expect("error" in out.result && out.result.error).toContain("case_type");
		expect(out.mutations).toEqual([]);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("updateModule with neither name nor case_type returns the corrective error, not a fake success", async () => {
		// The schema deliberately admits a bare { moduleIndex } (so the SA
		// reads a corrective message rather than an opaque parse failure);
		// the tool body owns the rejection. Without this branch, a no-op
		// call would report "Successfully updated" for an edit that never
		// happened.
		const { ctx, recordMutations } = makeCtx();
		const out = await updateModuleTool.execute(
			{ moduleIndex: 0 },
			ctx,
			caseTypelessDoc(),
		);
		expect("error" in out.result && out.result.error).toContain(
			"Nothing to update",
		);
		expect(out.mutations).toEqual([]);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("updateModule sets case_type (with the columns the flip obliges), after which the same createForm commits", async () => {
		const { ctx } = makeCtx();
		const doc = caseTypelessDoc();

		/* The flip alone would introduce MISSING_CASE_LIST_COLUMNS (the
		 * module has a form), so the columns ride the same call — the
		 * rejection's findings are satisfiable without a second tool. */
		const bare = await updateModuleTool.execute(
			{ moduleIndex: 0, case_type: "respondent" },
			ctx,
			doc,
		);
		expect("error" in bare.result).toBe(true);

		const fixed = await updateModuleTool.execute(
			{
				moduleIndex: 0,
				case_type: "respondent",
				case_list_columns: [
					{ kind: "plain", field: "case_name", header: "Name" } as never,
				],
			},
			ctx,
			doc,
		);
		expect("message" in fixed.result).toBe(true);

		const out = await createFormTool.execute(
			{
				moduleIndex: 0,
				name: "Register",
				type: "registration",
				fields: [
					{
						kind: "text",
						id: "case_name",
						label: "Name",
						case_property_on: "respondent",
					} as never,
					{
						kind: "text",
						id: "village",
						label: "Village",
						case_property_on: "respondent",
					} as never,
				],
			},
			ctx,
			fixed.newDoc,
		);
		expect("message" in out.result).toBe(true);
	});

	it("updateModule setting a BRAND-NEW case_type declares it so the seeded Name column resolves", async () => {
		// The catalog holds only "respondent"; "household" is brand new. With
		// `ensureCatalogProperty`'s auto-mint gone, this surface must emit a
		// `declareCaseType` — otherwise the seeded Name column's `case_name`
		// can't resolve (`CASE_LIST_COLUMN_UNKNOWN_FIELD`) and the gate rejects,
		// so the SA/MCP could not do what the builder gesture does.
		const { ctx, recordMutations } = makeCtx();
		const out = await updateModuleTool.execute(
			{
				moduleIndex: 0,
				case_type: "household",
				case_list_columns: [
					{ kind: "plain", field: "case_name", header: "Name" } as never,
				],
			},
			ctx,
			caseTypelessDoc(),
		);
		expect("message" in out.result).toBe(true);
		expect(recordMutations).toHaveBeenCalled();
		// The new type landed in the catalog…
		expect(
			(out.newDoc.caseTypes ?? []).some((ct) => ct.name === "household"),
		).toBe(true);
		// …and the module carries it.
		expect(Object.values(out.newDoc.modules)[0]?.caseType).toBe("household");
	});
});

// ── NO_CASE_NAME_FIELD (cannot dissolve — content) ──────────────────

describe("NO_CASE_NAME_FIELD — the gate owns it (no construction default exists)", () => {
	it("removing the case_name field is rejected — the writer never disappears", () => {
		const doc = minDoc();
		const target = fieldByBareId(doc, "case_name");
		const verdict = mutationCommitVerdict(doc, [
			{ kind: "removeField", uuid: target.uuid },
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
				"NO_CASE_NAME_FIELD",
			);
		}
	});
});

// ── RESERVED_CASE_PROPERTY ──────────────────────────────────────────

describe("RESERVED_CASE_PROPERTY — rejected at the introducing commit", () => {
	it("addFields with a case-bound reserved property name fails the call", async () => {
		const { ctx, recordMutations } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [
					// `date` is on CommCare's reserved case-property list.
					{
						kind: "date",
						id: "date",
						label: "Date",
						case_property_on: "patient",
					} as never,
				],
			},
			ctx,
			minDoc(),
		);
		expect("error" in out.result && out.result.error).toContain("reserved");
		expect(recordMutations).not.toHaveBeenCalled();
	});
});

// ── MEDIA_CASE_PROPERTY (shape — unrepresentable) ───────────────────

describe("MEDIA_CASE_PROPERTY — no construction surface can express it", () => {
	it("the per-kind add arm carries no case_property_on slot on media kinds", () => {
		const parsed = addFieldsItemSchema.safeParse({
			kind: "image",
			id: "photo",
			label: "Photo",
			case_property_on: "patient",
		});
		// `.strict()` arms reject the unknown key outright.
		expect(parsed.success).toBe(false);
	});

	it("the per-kind edit arm carries no case_property_on slot on media kinds", () => {
		const parsed = editFieldUpdatesSchema.safeParse({
			kind: "image",
			case_property_on: "patient",
		});
		expect(parsed.success).toBe(false);
	});

	it("the strict domain schema rejects a media field carrying case_property_on", () => {
		// The reducers' `safeParse` and the auto-save's `blueprintDocSchema`
		// both run this schema — the chokepoint behind every surface.
		const parsed = fieldSchema.safeParse({
			uuid: "00000000-0000-4000-8000-000000000001",
			kind: "image",
			id: "photo",
			label: "Photo",
			case_property_on: "patient",
		});
		expect(parsed.success).toBe(false);
	});
});

// ── UNQUOTED_STRING_LITERAL / UNKNOWN_FUNCTION / WRONG_ARITY ────────

describe("XPath soundness fixes — rejected at the introducing commit", () => {
	function verdictForRelevantPatch(expr: string) {
		const doc = minDoc();
		const target = fieldByBareId(doc, "village");
		return mutationCommitVerdict(doc, [
			{
				kind: "updateField",
				uuid: target.uuid,
				targetKind: "text",
				patch: { relevant: xp(expr) },
			} as Mutation,
		]);
	}

	it("UNQUOTED_STRING_LITERAL: a bare-word value in an XPath slot is rejected", () => {
		// `default_value: approved` — a lone bare identifier where an XPath
		// expression belongs (the author meant the string 'approved').
		const doc = minDoc();
		const target = fieldByBareId(doc, "village");
		const verdict = mutationCommitVerdict(doc, [
			{
				kind: "updateField",
				uuid: target.uuid,
				targetKind: "text",
				patch: { default_value: xp("approved") },
			} as Mutation,
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
				"UNQUOTED_STRING_LITERAL",
			);
		}
	});

	it("UNKNOWN_FUNCTION: a case-mismatched function name is rejected with the did-you-mean", () => {
		const verdict = verdictForRelevantPatch("Today() > '2026-01-01'");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			const finding = verdict.introduced.find(
				(e) => e.code === "UNKNOWN_FUNCTION",
			);
			expect(finding?.message).toContain('did you mean "today()"');
		}
	});

	it("WRONG_ARITY: round(x, 2) is rejected", () => {
		const verdict = verdictForRelevantPatch("round(2.4, 2) = 2");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain("WRONG_ARITY");
		}
	});
});

// ── SELECT_NO_OPTIONS (shape — unrepresentable) ─────────────────────

describe("SELECT_NO_OPTIONS — selects can't land without options", () => {
	it("the SA add path skips a single_select whose options are missing (assembly fails the domain schema)", async () => {
		const { ctx } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [
					{ kind: "single_select", id: "choice", label: "Choice" } as never,
				],
			},
			ctx,
			minDoc(),
		);
		// The field never assembles — no select entity lands on the doc.
		const landed = Object.values(out.newDoc.fields).find(
			(fl) => fl.id === "choice",
		);
		expect(landed).toBeUndefined();
	});

	it("the UI field picker seeds two starter options on select kinds", async () => {
		const { NEW_FIELD_BUILDERS } = await import(
			"@/components/preview/form/newFieldDefaults"
		);
		const fresh = NEW_FIELD_BUILDERS.single_select("choice", "Choice");
		expect(fresh.options).toHaveLength(2);
	});
});

// ── CLOSE_CONDITION_* ───────────────────────────────────────────────

/** minDoc plus a close form holding a two-option select ("outcome"). */
function closeFormDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
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
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
						],
					},
					{
						name: "Close out",
						type: "close",
						fields: [
							f({
								kind: "single_select",
								id: "outcome",
								label: "Outcome",
								options: [
									{ value: "done", label: "Done" },
									{ value: "moved", label: "Moved" },
								],
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

describe("CLOSE_CONDITION_* — rejected at the introducing commit", () => {
	it("a close condition naming a nonexistent field is rejected", () => {
		const doc = closeFormDoc();
		const closeFormUuid = doc.formOrder[doc.moduleOrder[0]][1];

		const verdict = mutationCommitVerdict(doc, [
			{
				kind: "updateForm",
				uuid: closeFormUuid,
				patch: { closeCondition: { field: asUuid("ghost"), answer: "done" } },
			},
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
				"CLOSE_CONDITION_FIELD_NOT_FOUND",
			);
		}
	});

	it("a close condition on a non-close form is rejected (WRONG_TYPE)", () => {
		const doc = minDoc();
		// minDoc's only form is a registration form — a close condition on
		// it is exactly the contradictory config the rule names.
		const verdict = mutationCommitVerdict(doc, [
			{
				kind: "updateForm",
				uuid: doc.formOrder[doc.moduleOrder[0]][0],
				patch: { closeCondition: { field: asUuid("village"), answer: "done" } },
			},
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
				"CLOSE_CONDITION_WRONG_TYPE",
			);
		}
	});

	it("a close condition missing its field or answer is rejected (INCOMPLETE)", () => {
		const doc = closeFormDoc();
		const closeFormUuid = doc.formOrder[doc.moduleOrder[0]][1];
		const verdict = mutationCommitVerdict(doc, [
			{
				kind: "updateForm",
				uuid: closeFormUuid,
				// The schema admits empty strings, so this is a live input
				// shape — both halves are required for a conditional close.
				patch: { closeCondition: { field: asUuid("outcome"), answer: "" } },
			},
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
				"CLOSE_CONDITION_INCOMPLETE",
			);
		}
	});
});

// ── INVALID_FIELD_ID + CASE_PROPERTY_BAD_FORMAT ─────────────────────

describe("field-id format fixes — rejected at source", () => {
	it("INVALID_FIELD_ID: an XML-illegal id never enters through addFields (identifier verdict)", async () => {
		const { ctx, recordMutations } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [{ kind: "text", id: "bad id!", label: "Bad" } as never],
			},
			ctx,
			minDoc(),
		);
		expect("error" in out.result && out.result.error).toContain("bad id!");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("CASE_PROPERTY_BAD_FORMAT: an XML-legal but property-illegal id on a case-bound field is rejected by the gate", async () => {
		// "_temp" passes the XML element-name rules (underscore start is
		// legal) but case property names must start with a letter — the
		// identifier verdicts pass it, the commit gate catches it.
		const { ctx, recordMutations } = makeCtx();
		const out = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [
					{
						kind: "text",
						id: "_temp",
						label: "Temp",
						case_property_on: "patient",
					} as never,
				],
			},
			ctx,
			minDoc(),
		);
		expect("error" in out.result && out.result.error).toContain("_temp");
		expect(recordMutations).not.toHaveBeenCalled();
	});
});
