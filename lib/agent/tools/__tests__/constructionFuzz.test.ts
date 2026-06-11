/**
 * Construction fuzz — the proof that licenses deleting the validate-fix
 * loop: randomized sequences of CONSTRUCTION-SURFACE operations (the
 * real SA/MCP tools, with their real assembly defaults and the real
 * commit gate, in both phases) can never leave the doc in a state the
 * retired FIX_REGISTRY existed to repair. The registry's conditions are
 * unreachable from the construction surface, so there is nothing left
 * for a fix loop to fix.
 *
 * The pinned code set is the registry's coverage, written out literally
 * (the registry itself is deleted — the LIST is the contract this test
 * holds):
 *
 *   NO_CASE_TYPE, RESERVED_CASE_PROPERTY, MEDIA_CASE_PROPERTY,
 *   UNQUOTED_STRING_LITERAL, SELECT_NO_OPTIONS, CLOSE_CONDITION_WRONG_TYPE,
 *   CLOSE_CONDITION_INCOMPLETE, CLOSE_CONDITION_FIELD_NOT_FOUND,
 *   UNKNOWN_FUNCTION, WRONG_ARITY, INVALID_FIELD_ID,
 *   CASE_PROPERTY_BAD_FORMAT — soundness/shape: never present after any
 *   accepted sequence, in either phase.
 *
 *   NO_CASE_NAME_FIELD — completeness: legitimately PRESENT mid-build
 *   (the building window defers it; `completeBuild` is the boundary that
 *   refuses to finish while it stands), so the invariant for it is the
 *   complete-phase ratchet: a doc that starts without it never gains it.
 *
 * Op inputs deliberately mix valid and invalid raw values (bare-word
 * XPath, reserved ids, XML-illegal ids, wrong-cased functions, broken
 * close conditions) — the surface is supposed to REJECT those calls;
 * the invariant is about the doc state after whatever was accepted.
 */

import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { addFieldsTool } from "../addFields";
import { createFormTool } from "../createForm";
import { createModuleTool } from "../createModule";
import { editFieldTool } from "../editField";
import { removeFieldTool } from "../removeField";
import { removeFormTool } from "../removeForm";
import { updateFormTool } from "../updateForm";
import { updateModuleTool } from "../updateModule";

/** The retired FIX_REGISTRY's soundness/shape coverage — unreachable. */
const UNREACHABLE_CODES: ReadonlySet<ValidationErrorCode> = new Set([
	"NO_CASE_TYPE",
	"RESERVED_CASE_PROPERTY",
	"MEDIA_CASE_PROPERTY",
	"UNQUOTED_STRING_LITERAL",
	"SELECT_NO_OPTIONS",
	"CLOSE_CONDITION_WRONG_TYPE",
	"CLOSE_CONDITION_INCOMPLETE",
	"CLOSE_CONDITION_FIELD_NOT_FOUND",
	"UNKNOWN_FUNCTION",
	"WRONG_ARITY",
	"INVALID_FIELD_ID",
	"CASE_PROPERTY_BAD_FORMAT",
]);

function makeCtx(phase: "building" | "complete"): ToolExecutionContext {
	return {
		appId: "app-fuzz",
		userId: "user-fuzz",
		runId: "run-fuzz",
		commitPhase: phase,
		recordMutations: vi.fn().mockResolvedValue([]),
		recordMutationStages: vi.fn().mockResolvedValue([]),
		getCompletionBasis: vi.fn().mockResolvedValue(null),
		recordConversation: vi.fn(),
	};
}

/** A COMPLETE app (no completeness findings) the complete-phase runs grow. */
function completeDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Fuzz Clinic",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register patient",
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

/** A doc mid-build: one module exists, nothing else. */
function buildingDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Fuzz WIP",
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Record visit",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "visit",
							}),
						],
					},
				],
			},
		],
	});
}

// ── Input pools — valid values interleaved with the exact garbage the
//    registry's fixes existed to repair ─────────────────────────────────

const ID_POOL = [
	"village",
	"status",
	"dob",
	"notes",
	"case_name",
	"bad id!", // XML-illegal → INVALID_FIELD_ID territory
	"date", // reserved case property
	"__nova_temp", // reserved namespace
	"_temp", // XML-legal, case-property-illegal → CASE_PROPERTY_BAD_FORMAT
	"1leading", // XML-illegal
];

const LABEL_POOL = ["Name", "Notes", "A label", "Status"];

const XPATH_POOL = [
	"today() > '2020-01-01'",
	"Today() > '2020-01-01'", // case-mismatched function → UNKNOWN_FUNCTION
	"round(2.4, 2) = 2", // wrong arity → WRONG_ARITY
	"approved", // bare word → UNQUOTED_STRING_LITERAL
	"if(", // unparseable → XPATH_SYNTAX
	"string-length(#form/village) > 2",
	"",
];

const KIND_POOL = ["text", "date", "decimal", "single_select", "hidden"];

const CASE_TYPE_POOL = ["patient", "visit", "household", "Bad Type!", ""];

const FORM_TYPE_POOL = ["registration", "followup", "survey", "close"] as const;

// ── Arbitraries ─────────────────────────────────────────────────────────

const fieldItemArb = fc
	.record({
		kind: fc.constantFrom(...KIND_POOL),
		id: fc.constantFrom(...ID_POOL),
		label: fc.constantFrom(...LABEL_POOL),
		withOptions: fc.boolean(),
		withRelevant: fc.option(fc.constantFrom(...XPATH_POOL), { nil: undefined }),
		withCalculate: fc.option(fc.constantFrom(...XPATH_POOL), {
			nil: undefined,
		}),
		withCaseProp: fc.option(fc.constantFrom(...CASE_TYPE_POOL), {
			nil: undefined,
		}),
	})
	.map(
		({
			kind,
			id,
			label,
			withOptions,
			withRelevant,
			withCalculate,
			withCaseProp,
		}) => ({
			kind,
			id,
			label,
			...(kind === "single_select" &&
				withOptions && {
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
				}),
			...(kind === "hidden"
				? { calculate: withCalculate ?? "1 + 1" }
				: withRelevant !== undefined && { relevant: withRelevant }),
			...(kind !== "hidden" &&
				withCaseProp !== undefined &&
				withCaseProp !== "" && { case_property_on: withCaseProp }),
		}),
	);

const opArb = fc.oneof(
	fc
		.record({
			name: fc.constantFrom("Households", "Surveys", "Referrals"),
			caseType: fc.option(fc.constantFrom(...CASE_TYPE_POOL), {
				nil: undefined,
			}),
			withForms: fc.boolean(),
			fields: fc.array(fieldItemArb, { minLength: 1, maxLength: 3 }),
			withColumns: fc.boolean(),
			formType: fc.constantFrom(...FORM_TYPE_POOL),
		})
		.map((r) => ({ type: "createModule" as const, ...r })),
	fc
		.record({
			moduleIndex: fc.nat({ max: 2 }),
			name: fc.constantFrom("Follow up", "Close out", "Survey"),
			formType: fc.constantFrom(...FORM_TYPE_POOL),
			fields: fc.array(fieldItemArb, { minLength: 1, maxLength: 3 }),
		})
		.map((r) => ({ type: "createForm" as const, ...r })),
	fc
		.record({
			moduleIndex: fc.nat({ max: 2 }),
			formIndex: fc.nat({ max: 2 }),
			fields: fc.array(fieldItemArb, { minLength: 1, maxLength: 3 }),
		})
		.map((r) => ({ type: "addFields" as const, ...r })),
	fc
		.record({
			moduleIndex: fc.nat({ max: 2 }),
			formIndex: fc.nat({ max: 2 }),
			fieldPick: fc.nat({ max: 5 }),
			newId: fc.option(fc.constantFrom(...ID_POOL), { nil: undefined }),
			relevant: fc.option(fc.constantFrom(...XPATH_POOL), { nil: undefined }),
			label: fc.option(fc.constantFrom(...LABEL_POOL), { nil: undefined }),
		})
		.map((r) => ({ type: "editField" as const, ...r })),
	fc
		.record({
			moduleIndex: fc.nat({ max: 2 }),
			formIndex: fc.nat({ max: 2 }),
			closeField: fc.constantFrom(...ID_POOL, "ghost"),
			closeAnswer: fc.constantFrom("done", ""),
		})
		.map((r) => ({ type: "updateFormClose" as const, ...r })),
	fc
		.record({
			moduleIndex: fc.nat({ max: 2 }),
			caseType: fc.constantFrom(...CASE_TYPE_POOL),
		})
		.map((r) => ({ type: "updateModule" as const, ...r })),
	fc
		.record({
			moduleIndex: fc.nat({ max: 2 }),
			formIndex: fc.nat({ max: 2 }),
			fieldPick: fc.nat({ max: 5 }),
		})
		.map((r) => ({ type: "removeField" as const, ...r })),
	fc
		.record({
			moduleIndex: fc.nat({ max: 2 }),
			formIndex: fc.nat({ max: 2 }),
		})
		.map((r) => ({ type: "removeForm" as const, ...r })),
);

type FuzzOp = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

/** Resolve a field id within a form by pick index (deterministic). */
function pickFieldId(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
	pick: number,
): string | undefined {
	const moduleUuid = doc.moduleOrder[moduleIndex];
	const formUuid = moduleUuid
		? doc.formOrder[moduleUuid]?.[formIndex]
		: undefined;
	const order = formUuid ? (doc.fieldOrder[formUuid] ?? []) : [];
	const uuid = order[pick % Math.max(order.length, 1)];
	return uuid ? doc.fields[uuid]?.id : undefined;
}

/** Apply one fuzz op through the REAL tool. The tool either commits (and
 *  returns the new doc) or rejects (and returns the old doc) — both are
 *  legitimate outcomes; the invariant below judges the doc, not the op. */
async function applyOp(
	doc: BlueprintDoc,
	ctx: ToolExecutionContext,
	op: FuzzOp,
): Promise<BlueprintDoc> {
	switch (op.type) {
		case "createModule": {
			const out = await createModuleTool.execute(
				{
					name: op.name,
					...(op.caseType && { case_type: op.caseType }),
					...(op.withForms && {
						forms: [
							{ name: "First form", type: op.formType, fields: op.fields },
						],
					}),
					...(op.withColumns && {
						case_list_columns: [
							{ kind: "plain", field: "case_name", header: "Name" },
						],
					}),
				} as never,
				ctx,
				doc,
			);
			return out.newDoc;
		}
		case "createForm": {
			const out = await createFormTool.execute(
				{
					moduleIndex: op.moduleIndex,
					name: op.name,
					type: op.formType,
					fields: op.fields,
				} as never,
				ctx,
				doc,
			);
			return out.newDoc;
		}
		case "addFields": {
			const out = await addFieldsTool.execute(
				{
					moduleIndex: op.moduleIndex,
					formIndex: op.formIndex,
					fields: op.fields,
				} as never,
				ctx,
				doc,
			);
			return out.newDoc;
		}
		case "editField": {
			const fieldId = pickFieldId(
				doc,
				op.moduleIndex,
				op.formIndex,
				op.fieldPick,
			);
			if (!fieldId) return doc;
			const target = Object.values(doc.fields).find((fl) => fl.id === fieldId);
			const out = await editFieldTool.execute(
				{
					moduleIndex: op.moduleIndex,
					formIndex: op.formIndex,
					fieldId,
					updates: {
						kind: target?.kind ?? "text",
						...(op.newId !== undefined && { id: op.newId }),
						...(op.relevant !== undefined &&
							target?.kind !== "hidden" && { relevant: op.relevant }),
						...(op.label !== undefined &&
							target?.kind !== "hidden" && { label: op.label }),
					},
				} as never,
				ctx,
				doc,
			);
			return out.newDoc;
		}
		case "updateFormClose": {
			const out = await updateFormTool.execute(
				{
					moduleIndex: op.moduleIndex,
					formIndex: op.formIndex,
					close_condition: { field: op.closeField, answer: op.closeAnswer },
				} as never,
				ctx,
				doc,
			);
			return out.newDoc;
		}
		case "updateModule": {
			const out = await updateModuleTool.execute(
				{
					moduleIndex: op.moduleIndex,
					...(op.caseType && { case_type: op.caseType }),
				} as never,
				ctx,
				doc,
			);
			return out.newDoc;
		}
		case "removeField": {
			const fieldId = pickFieldId(
				doc,
				op.moduleIndex,
				op.formIndex,
				op.fieldPick,
			);
			if (!fieldId) return doc;
			const out = await removeFieldTool.execute(
				{
					moduleIndex: op.moduleIndex,
					formIndex: op.formIndex,
					fieldId,
				} as never,
				ctx,
				doc,
			);
			return out.newDoc;
		}
		case "removeForm": {
			const out = await removeFormTool.execute(
				{ moduleIndex: op.moduleIndex, formIndex: op.formIndex } as never,
				ctx,
				doc,
			);
			return out.newDoc;
		}
	}
}

/** The invariant: no registry-coverage code in the doc's findings. */
function assertNoRegistryCodes(
	doc: BlueprintDoc,
	extraCodes: ReadonlySet<ValidationErrorCode>,
	context: string,
): void {
	const findings = runValidation(doc);
	const tripped = findings.filter(
		(err) => UNREACHABLE_CODES.has(err.code) || extraCodes.has(err.code),
	);
	expect
		.soft(
			tripped.map((t) => `${t.code}: ${t.message}`),
			context,
		)
		.toEqual([]);
	if (tripped.length > 0) {
		throw new Error(
			`registry-coverage code reached through the construction surface (${context}): ${tripped
				.map((t) => t.code)
				.join(", ")}`,
		);
	}
}

const NO_EXTRA: ReadonlySet<ValidationErrorCode> = new Set();
const RATCHETED: ReadonlySet<ValidationErrorCode> = new Set([
	"NO_CASE_NAME_FIELD",
]);

describe("construction fuzz — the FIX_REGISTRY's conditions are unreachable", () => {
	it("building phase: no accepted sequence ever trips a registry soundness/shape code", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 10 }),
				async (ops) => {
					const ctx = makeCtx("building");
					let doc = buildingDoc();
					for (const [i, op] of ops.entries()) {
						doc = await applyOp(doc, ctx, op);
						assertNoRegistryCodes(doc, NO_EXTRA, `building op#${i} ${op.type}`);
					}
				},
			),
			{ numRuns: 40 },
		);
	});

	it("complete phase: the ratchet additionally keeps NO_CASE_NAME_FIELD out of a doc that starts without it", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 10 }),
				async (ops) => {
					const ctx = makeCtx("complete");
					let doc = completeDoc();
					for (const [i, op] of ops.entries()) {
						doc = await applyOp(doc, ctx, op);
						assertNoRegistryCodes(
							doc,
							RATCHETED,
							`complete op#${i} ${op.type}`,
						);
					}
				},
			),
			{ numRuns: 40 },
		);
	});
});
