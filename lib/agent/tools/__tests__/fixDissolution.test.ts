import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
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
 *     an attachment case destination with no `mode` (pinned on the add
 *     arm, the edit arm, AND the strict domain schema, together with
 *     the inverse fence that a non-attachment kind carries no mode),
 *     SELECT_NO_OPTIONS (domain schema `.min(2)`; the UI
 *     picker seeds two starter options; the SA add path fails
 *     assembly);
 *   - INVALID_FIELD_ID — rejected at source by the shared identifier
 *     verdicts (`lib/doc/identifierVerdicts.ts`), pinned here through
 *     the `addFields` path;
 *   - case-create name completeness — NOT dissolvable to a
 *     construction default (the case-name field is content the author
 *     adds): a creation lands it with the form, and removing it is
 *     rejected (pinned here) — the same single rule as everything else.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import {
	makeToolWorkspaceHarness,
	type ToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, fieldSchema } from "@/lib/domain";
import { addFieldsItemSchema, editFieldUpdatesSchema } from "../../toolSchemas";
import { addFieldsTool } from "../addFields";
import { createFormTool } from "../createForm";
import { updateModuleTool } from "../updateModule";

/** Canonical workspace over a stub host — `recordMutations` is the persistence
 *  assertion surface, and the workspace adopts each commit so consecutive tool
 *  calls compose against the committed document. */
function makeHarness(initialDoc: BlueprintDoc): ToolWorkspaceHarness {
	return makeToolWorkspaceHarness(initialDoc, {
		appId: "app-1",
		userId: "user-1",
		runId: "run-1",
	});
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
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
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
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
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
						fields: [
							f({ kind: "text", id: "comments", label: proseText("Comments") }),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "respondent",
				properties: [{ name: "case_name", label: proseText("Name") }],
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

function moduleAddress(doc: BlueprintDoc) {
	return { moduleUuid: doc.moduleOrder[0] };
}

function formAddress(doc: BlueprintDoc, formIndex = 0) {
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
	if (!formUuid) throw new Error("fixture missing addressed form");
	return { moduleUuid, formUuid };
}

// ── NO_CASE_TYPE ────────────────────────────────────────────────────

describe("NO_CASE_TYPE — rejected at the introducing commit; updateModule is the repair", () => {
	it("createForm(registration) on a case-typeless module fails the call, nothing persisted", async () => {
		const doc = caseTypelessDoc();
		const h = makeHarness(doc);
		const out = await h.runTool(createFormTool, {
			...moduleAddress(doc),
			name: "Register",
			type: "registration",
			fields: [
				{ kind: "text", id: "case_name", label: proseText("Name") } as never,
			],
		});
		expect("error" in out.result && out.result.error).toContain("case_type");
		expect(out.mutations).toEqual([]);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("updateModule with neither name nor case_type returns the corrective error, not a fake success", async () => {
		// The schema deliberately admits a UUID-only address (so the SA
		// reads a corrective message rather than an opaque parse failure);
		// the tool body owns the rejection. Without this branch, a no-op
		// call would report "Successfully updated" for an edit that never
		// happened.
		const doc = caseTypelessDoc();
		const h = makeHarness(doc);
		const out = await h.runTool(updateModuleTool, moduleAddress(doc));
		expect("error" in out.result && out.result.error).toContain(
			"Nothing to update",
		);
		expect(out.mutations).toEqual([]);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("updateModule sets case_type (with the columns the flip obliges), after which the same createForm commits", async () => {
		const doc = caseTypelessDoc();
		const h = makeHarness(doc);

		/* The flip alone would introduce MISSING_CASE_LIST_COLUMNS (the
		 * module has a form), so the columns ride the same call — the
		 * rejection's findings are satisfiable without a second tool. */
		const bare = await h.runTool(updateModuleTool, {
			...moduleAddress(doc),
			case_type: "respondent",
		});
		expect("error" in bare.result).toBe(true);
		// A rejected call leaves the workspace on its exact prior document.
		expect(h.currentDoc()).toBe(doc);

		const columnUuid = testUuid("update-module-seeded-column");
		const fixed = await h.runTool(updateModuleTool, {
			...moduleAddress(doc),
			case_type: "respondent",
			case_list_columns: [
				{
					columnUuid,
					kind: "plain",
					field: "case_name",
					header: "Name",
				} as never,
			],
		});
		expect("message" in fixed.result).toBe(true);
		if (!("columns" in fixed.result)) throw new Error("expected success");
		expect(fixed.result.columns).toEqual([{ uuid: columnUuid }]);

		const out = await h.runTool(createFormTool, {
			...moduleAddress(h.currentDoc()),
			name: "Register",
			type: "registration",
			fields: [
				{
					kind: "text",
					id: "case_name",
					label: proseText("Name"),
					caseWrite: { caseType: "respondent", property: "case_name" },
				} as never,
				{
					kind: "text",
					id: "village",
					label: proseText("Village"),
					caseWrite: { caseType: "respondent", property: "village" },
				} as never,
			],
		});
		expect("message" in out.result).toBe(true);
	});

	it("updateModule setting a BRAND-NEW case_type declares it so the seeded Name column resolves", async () => {
		// The catalog holds only "respondent"; "household" is brand new. With
		// `ensureCatalogProperty`'s auto-mint gone, this surface must emit a
		// `declareCaseType` — otherwise the seeded Name column's `case_name`
		// can't resolve (`CASE_LIST_COLUMN_UNKNOWN_FIELD`) and the gate rejects,
		// so the SA/MCP could not do what the builder gesture does.
		const doc = caseTypelessDoc();
		const h = makeHarness(doc);
		const out = await h.runTool(updateModuleTool, {
			...moduleAddress(doc),
			case_type: "household",
			case_list_columns: [
				{ kind: "plain", field: "case_name", header: "Name" } as never,
			],
		});
		expect("message" in out.result).toBe(true);
		expect(h.recordMutations).toHaveBeenCalled();
		const committed = h.currentDoc();
		// The new type landed in the catalog…
		expect(
			(committed.caseTypes ?? []).some((ct) => ct.name === "household"),
		).toBe(true);
		// …and the module carries it.
		expect(Object.values(committed.modules)[0]?.caseType).toBe("household");
	});
});

// ── Case-create name completeness (cannot dissolve — content) ──────

describe("case-create name completeness — the gate owns it", () => {
	it("removing the case_name field is rejected — the writer never disappears", () => {
		const doc = minDoc();
		const target = fieldByBareId(doc, "case_name");
		const verdict = mutationCommitVerdict(
			doc,
			[{ kind: "removeField", uuid: target.uuid }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain(
				"CASE_CREATE_NAME_MISSING",
			);
		}
	});
});

// ── RESERVED_CASE_PROPERTY ──────────────────────────────────────────

describe("RESERVED_CASE_PROPERTY — rejected at the introducing commit", () => {
	it("addFields with a case-bound reserved property name fails the call", async () => {
		const doc = minDoc();
		const h = makeHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			...formAddress(doc),
			fields: [
				// `date` is on CommCare's reserved case-property list.
				{
					kind: "date",
					id: "date",
					label: proseText("Date"),
					caseWrite: { caseType: "patient", property: "date" },
				} as never,
			],
		});
		expect("error" in out.result && out.result.error).toContain("reserved");
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});

// ── A mode-less attachment destination (shape — unrepresentable) ────

describe("an attachment destination without a mode — no construction surface can express it", () => {
	it("the add arm refuses a capture destination with no mode", () => {
		const parsed = addFieldsItemSchema.safeParse({
			kind: "image",
			id: "photo",
			label: proseText("Photo"),
			caseWrite: { caseType: "patient", property: "photo" },
		});
		expect(parsed.success).toBe(false);
	});

	it("the edit arm refuses a capture destination with no mode", () => {
		const parsed = editFieldUpdatesSchema.safeParse({
			kind: "image",
			caseWrite: { caseType: "patient", property: "photo" },
		});
		expect(parsed.success).toBe(false);
	});

	it("the strict domain schema refuses a capture destination with no mode", () => {
		// The reducers' `safeParse` and the auto-save's `blueprintDocSchema`
		// both run this schema — the chokepoint behind every surface.
		const parsed = fieldSchema.safeParse({
			uuid: "00000000-0000-4000-8000-000000000001",
			kind: "image",
			id: "photo",
			label: proseText("Photo"),
			caseWrite: { caseType: "patient", property: "photo" },
		});
		expect(parsed.success).toBe(false);
	});

	it("every surface admits the same destination once it names a mode", () => {
		expect(
			addFieldsItemSchema.safeParse({
				kind: "image",
				id: "photo",
				label: proseText("Photo"),
				caseWrite: { caseType: "patient", property: "photo", mode: "url" },
			}).success,
		).toBe(true);
		expect(
			editFieldUpdatesSchema.safeParse({
				kind: "image",
				caseWrite: { caseType: "patient", property: "photo", mode: "url" },
			}).success,
		).toBe(true);
		expect(
			fieldSchema.safeParse({
				uuid: "00000000-0000-4000-8000-000000000001",
				kind: "image",
				id: "photo",
				label: proseText("Photo"),
				caseWrite: { caseType: "patient", property: "photo", mode: "url" },
			}).success,
		).toBe(true);
	});

	it("a mode is refused on a kind whose answer IS the case value", () => {
		// The inverse fence: `mode` is a decision only a file forces, so a
		// text field carrying one is a caller that misread the contract, not
		// a slot to ignore.
		expect(
			addFieldsItemSchema.safeParse({
				kind: "text",
				id: "nickname",
				label: proseText("Nickname"),
				caseWrite: { caseType: "patient", property: "nickname", mode: "url" },
			}).success,
		).toBe(false);
		expect(
			fieldSchema.safeParse({
				uuid: "00000000-0000-4000-8000-000000000002",
				kind: "text",
				id: "nickname",
				label: proseText("Nickname"),
				caseWrite: { caseType: "patient", property: "nickname", mode: "url" },
			}).success,
		).toBe(false);
	});
});

// ── UNQUOTED_STRING_LITERAL / UNKNOWN_FUNCTION / WRONG_ARITY ────────

describe("XPath soundness fixes — rejected at the introducing commit", () => {
	function verdictForRelevantPatch(expr: string) {
		const doc = minDoc();
		const target = fieldByBareId(doc, "village");
		return mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: target.uuid,
					targetKind: "text",
					patch: { relevant: xp(expr) },
				} as Mutation,
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
	}

	it("UNQUOTED_STRING_LITERAL: a bare-word value in an XPath slot is rejected", () => {
		// `default_value: approved` — a lone bare identifier where an XPath
		// expression belongs (the author meant the string 'approved').
		const doc = minDoc();
		const target = fieldByBareId(doc, "village");
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: target.uuid,
					targetKind: "text",
					patch: { default_value: xp("approved") },
				} as Mutation,
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain(
				"UNQUOTED_STRING_LITERAL",
			);
		}
	});

	it("UNKNOWN_FUNCTION: a case-mismatched function name is rejected with the did-you-mean", () => {
		const verdict = verdictForRelevantPatch("Today() > '2026-01-01'");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			const finding = verdict.findings.find(
				(e) => e.code === "UNKNOWN_FUNCTION",
			);
			expect(finding?.message).toContain('Did you mean "today()"');
		}
	});

	it("WRONG_ARITY: round(x, 2) is rejected", () => {
		const verdict = verdictForRelevantPatch("round(2.4, 2) = 2");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain("WRONG_ARITY");
		}
	});
});

// ── SELECT_NO_OPTIONS (shape — unrepresentable) ─────────────────────

describe("SELECT_NO_OPTIONS — selects can't land without options", () => {
	it("the SA add path skips a single_select whose options are missing (assembly fails the domain schema)", async () => {
		const doc = minDoc();
		const h = makeHarness(doc);
		await h.runTool(addFieldsTool, {
			...formAddress(doc),
			fields: [
				{
					kind: "single_select",
					id: "choice",
					label: proseText("Choice"),
				} as never,
			],
		});
		// The field never assembles — no select entity lands on the doc.
		const landed = Object.values(h.currentDoc().fields).find(
			(fl) => fl.id === "choice",
		);
		expect(landed).toBeUndefined();
	});

	it("the UI field picker seeds two starter options on select kinds", async () => {
		const { NEW_FIELD_BUILDERS } = await import(
			"@/components/preview/form/newFieldDefaults"
		);
		const fresh = NEW_FIELD_BUILDERS.single_select("choice", "Choice");
		expect(fresh.kind).toBe("single_select");
		if (fresh.kind !== "single_select") throw new Error("wrong field kind");
		expect(fresh.optionsSource.kind).toBe("inline");
		if (fresh.optionsSource.kind !== "inline") {
			throw new Error("wrong options source");
		}
		expect(fresh.optionsSource.options).toHaveLength(2);
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
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
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
								label: proseText("Outcome"),
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
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
		],
	});
}

describe("CLOSE_CONDITION_* — rejected at the introducing commit", () => {
	it("a close condition naming a nonexistent field is rejected", () => {
		const doc = closeFormDoc();
		const closeFormUuid = doc.formOrder[doc.moduleOrder[0]][1];

		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateForm",
					uuid: closeFormUuid,
					patch: {
						closeCondition: { field: testUuid("ghost"), answer: "done" },
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain(
				"CLOSE_CONDITION_FIELD_NOT_FOUND",
			);
		}
	});

	it("a close condition on a non-close form is rejected (WRONG_TYPE)", () => {
		const doc = minDoc();
		// minDoc's only form is a registration form — a close condition on
		// it is exactly the contradictory config the rule names.
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateForm",
					uuid: doc.formOrder[doc.moduleOrder[0]][0],
					patch: {
						closeCondition: { field: testUuid("village"), answer: "done" },
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain(
				"CLOSE_CONDITION_WRONG_TYPE",
			);
		}
	});

	it("a close condition missing its field or answer is rejected (INCOMPLETE)", () => {
		const doc = closeFormDoc();
		const closeFormUuid = doc.formOrder[doc.moduleOrder[0]][1];
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateForm",
					uuid: closeFormUuid,
					// The schema admits empty strings, so this is a live input
					// shape — both halves are required for a conditional close.
					patch: { closeCondition: { field: testUuid("outcome"), answer: "" } },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain(
				"CLOSE_CONDITION_INCOMPLETE",
			);
		}
	});
});

// ── INVALID_FIELD_ID + CASE_PROPERTY_BAD_FORMAT ─────────────────────

describe("field-id format fixes — rejected at source", () => {
	it("INVALID_FIELD_ID: an XML-illegal id never enters through addFields (identifier verdict)", async () => {
		const doc = minDoc();
		const h = makeHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			...formAddress(doc),
			fields: [
				{ kind: "text", id: "bad id!", label: proseText("Bad") } as never,
			],
		});
		expect("error" in out.result && out.result.error).toContain("bad id!");
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("rejects an XML-legal but property-illegal caseWrite destination at the input boundary", () => {
		// "_temp" passes the XML element-name rules (underscore start is
		// legal) but case property names must start with a letter — the
		// identifier verdicts pass it, the commit gate catches it.
		const parsed = addFieldsItemSchema.safeParse({
			kind: "text",
			id: "temporary_value",
			label: proseText("Temp"),
			caseWrite: { caseType: "patient", property: "_temp" },
		});
		expect(parsed.success).toBe(false);
	});
});
