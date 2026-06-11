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
 *   NO_CASE_NAME_FIELD and EMPTY_FORM — completeness: legitimately
 *   PRESENT mid-build (the building window defers them; `completeBuild`
 *   is the boundary that refuses to finish while they stand), so the
 *   invariant for them is the complete-phase ratchet: a doc that starts
 *   without them never gains them — which is exactly the property
 *   atomic creation exists to hold, so a regression there fails the
 *   fuzz itself.
 *
 * Every generated input goes through the tool's OWN Zod input schema
 * before execute — a refusal there (an image field carrying
 * `case_property_on`, a label on a `hidden` arm) is itself a valid
 * construction outcome, so the schemas' structural exclusions are part
 * of what the proof exercises. Inputs deliberately mix valid and
 * invalid raw values (bare-word XPath, reserved ids, XML-illegal ids,
 * wrong-cased functions, broken close conditions, media kinds) — the
 * surface is supposed to REFUSE the bad ones; the invariant is about
 * the doc state after whatever was accepted. A third run starts from a
 * complete Connect app, with creations optionally carrying their
 * per-form `connect` blocks.
 */

import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
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

/** A COMPLETE Connect learn app — every form carries its connect block,
 *  so the complete-phase run can prove creations keep working when
 *  CONNECT_FORM_MISSING_BLOCK is in play. */
function completeConnectDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Fuzz Training",
		connectType: "learn",
		modules: [
			{
				name: "Lessons",
				caseType: "trainee",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Enroll trainee",
						type: "registration",
						connect: {
							learn_module: {
								id: "enroll_module",
								name: "Enrollment",
								description: "Sign-up basics",
								time_estimate: 10,
							},
						},
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "trainee",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "trainee",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "trainee",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

// ── Input pools — valid values interleaved with the exact garbage the
//    registry's fixes existed to repair ─────────────────────────────────

/* Weighted toward CLEAN values so sequences actually land commits — a
 * fuzz whose every op bounces would "prove" unreachability vacuously.
 * The garbage stays in at real frequency: each entry is one of the
 * exact conditions the retired registry repaired. */
const CLEAN_IDS = [
	"village",
	"status",
	"dob",
	"notes",
	"case_name",
	"follow_up_note",
	"visit_reason",
	"contact_number",
];
const GARBAGE_IDS = [
	"bad id!", // XML-illegal → INVALID_FIELD_ID territory
	"date", // reserved case property
	"__nova_temp", // reserved namespace
	"_temp", // XML-legal, case-property-illegal → CASE_PROPERTY_BAD_FORMAT
	"1leading", // XML-illegal
];
const idArb = fc.oneof(
	/* Suffixed clean ids dominate: with a bare 8-name pool, a growing
	 * sequence saturates its sibling namespace after a handful of commits
	 * and every later add collides — acceptance collapses and the run
	 * stops exercising real state. */
	{
		arbitrary: fc
			.tuple(fc.constantFrom(...CLEAN_IDS), fc.nat({ max: 99 }))
			.map(([id, n]) => `${id}_${n}`),
		weight: 7,
	},
	/* Bare clean ids keep sibling-collision coverage alive. */
	{ arbitrary: fc.constantFrom(...CLEAN_IDS), weight: 1 },
	{ arbitrary: fc.constantFrom(...GARBAGE_IDS), weight: 2 },
);

/* Module/form pick: weighted toward the indexes that exist (fixtures
 * start with one module / one form; sequences grow more) so most ops hit
 * a live target while out-of-range picks stay covered. */
const moduleIndexArb = fc.constantFrom(0, 0, 0, 0, 1, 2);
const formIndexArb = fc.constantFrom(0, 0, 0, 0, 1, 2);

const LABEL_POOL = ["Name", "Notes", "A label", "Status"];

/* Mostly reference-free: a `#form/<id>` reference is only valid when
 * that sibling exists, which random sequences rarely arrange — the one
 * referencing entry keeps INVALID_REF rejections in play without
 * starving the run of commits. */
const CLEAN_XPATH = [
	"today() > '2020-01-01'",
	"1 = 1",
	"2 > 1",
	"true()",
	"",
	"string-length(#form/village) > 2",
];
const GARBAGE_XPATH = [
	"Today() > '2020-01-01'", // case-mismatched function → UNKNOWN_FUNCTION
	"round(2.4, 2) = 2", // wrong arity → WRONG_ARITY
	"approved", // bare word → UNQUOTED_STRING_LITERAL
	"if(", // unparseable → XPATH_SYNTAX
];
const xpathArb = fc.oneof(
	{ arbitrary: fc.constantFrom(...CLEAN_XPATH), weight: 8 },
	{ arbitrary: fc.constantFrom(...GARBAGE_XPATH), weight: 2 },
);

const KIND_POOL = [
	"text",
	"date",
	"decimal",
	"single_select",
	"hidden",
	// Media kind — its add arm declares no `case_property_on` slot, so a
	// generated combination of the two is a schema refusal the proof
	// exercises (the structural exclusion behind MEDIA_CASE_PROPERTY).
	"image",
];

const CASE_TYPE_POOL = ["patient", "visit", "household", "Bad Type!", ""];

const FORM_TYPE_POOL = ["registration", "followup", "survey", "close"] as const;

// ── Arbitraries ─────────────────────────────────────────────────────────

const fieldItemArb = fc
	.record({
		kind: fc.constantFrom(...KIND_POOL),
		id: idArb,
		label: fc.constantFrom(...LABEL_POOL),
		withOptions: fc.boolean(),
		withRelevant: fc.option(xpathArb, { nil: undefined }),
		withCalculate: fc.option(xpathArb, {
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
			// The hidden arm declares no `label` — supplying one would turn
			// every hidden item into a schema refusal and starve the run of
			// hidden-field coverage.
			...(kind !== "hidden" && { label }),
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
			// Deliberately also generated for media kinds, whose arms exclude
			// the slot — those items become schema refusals, which is the
			// exclusion under test.
			...(kind !== "hidden" &&
				withCaseProp !== undefined &&
				withCaseProp !== "" && { case_property_on: withCaseProp }),
		}),
	);

/** Optional per-form connect block (learn shape) — the Connect-app run's
 *  creations carry these; ids from a small pool, so id collisions (a
 *  gate-rejected outcome) occur alongside clean creations. */
const connectArb = fc.option(
	fc.constantFrom("lesson_a", "lesson_b", "lesson_c").map((id) => ({
		learn_module: {
			id,
			name: "Lesson",
			description: "Generated lesson content",
			time_estimate: 15,
		},
	})),
	{ nil: undefined },
);

const opArb = fc.oneof(
	fc
		.record({
			name: fc.constantFrom("Households", "Surveys", "Referrals"),
			caseType: fc.option(fc.constantFrom(...CASE_TYPE_POOL), {
				nil: undefined,
			}),
			withForms: fc.boolean(),
			fields: fc.array(fieldItemArb, { minLength: 1, maxLength: 2 }),
			withColumns: fc.boolean(),
			formType: fc.constantFrom(...FORM_TYPE_POOL),
			connect: connectArb,
		})
		.map((r) => ({ type: "createModule" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			name: fc.constantFrom("Follow up", "Close out", "Survey"),
			formType: fc.constantFrom(...FORM_TYPE_POOL, "followup", "survey"),
			fields: fc.array(fieldItemArb, { minLength: 1, maxLength: 2 }),
			connect: connectArb,
		})
		.map((r) => ({ type: "createForm" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			formIndex: formIndexArb,
			fields: fc.array(fieldItemArb, { minLength: 1, maxLength: 2 }),
		})
		.map((r) => ({ type: "addFields" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			formIndex: formIndexArb,
			fieldPick: fc.nat({ max: 5 }),
			newId: fc.option(idArb, { nil: undefined }),
			relevant: fc.option(xpathArb, { nil: undefined }),
			label: fc.option(fc.constantFrom(...LABEL_POOL), { nil: undefined }),
		})
		.map((r) => ({ type: "editField" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			formIndex: formIndexArb,
			closeField: fc.constantFrom(...CLEAN_IDS, "ghost"),
			closeAnswer: fc.constantFrom("done", ""),
		})
		.map((r) => ({ type: "updateFormClose" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			caseType: fc.constantFrom(...CASE_TYPE_POOL),
		})
		.map((r) => ({ type: "updateModule" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			formIndex: formIndexArb,
			fieldPick: fc.nat({ max: 5 }),
		})
		.map((r) => ({ type: "removeField" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			formIndex: formIndexArb,
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

/**
 * Run one tool over a RAW generated input, through the tool's own Zod
 * input schema first. A schema refusal is itself a construction outcome
 * — the structural exclusions (media kinds without `case_property_on`,
 * label-less `hidden` arms, …) are part of what the proof exercises —
 * and nothing runs, so the doc is returned unchanged for the invariant
 * to judge. A parsed input executes with its exact inferred type: no
 * cast anywhere between generator and tool.
 */
async function runParsed<I>(
	tool: {
		inputSchema: { safeParse(raw: unknown): z.ZodSafeParseResult<I> };
		execute(
			input: I,
			ctx: ToolExecutionContext,
			doc: BlueprintDoc,
		): Promise<{ newDoc: BlueprintDoc }>;
	},
	rawInput: unknown,
	ctx: ToolExecutionContext,
	doc: BlueprintDoc,
): Promise<BlueprintDoc> {
	const parsed = tool.inputSchema.safeParse(rawInput);
	if (!parsed.success) return doc;
	const out = await tool.execute(parsed.data, ctx, doc);
	return out.newDoc;
}

/** Apply one fuzz op through the REAL tool (schema first — see
 *  {@link runParsed}). The tool either commits (and returns the new doc)
 *  or refuses at the schema/gate (and returns the old doc) — all are
 *  legitimate outcomes; the invariant below judges the doc, not the op. */
async function applyOp(
	doc: BlueprintDoc,
	ctx: ToolExecutionContext,
	op: FuzzOp,
): Promise<BlueprintDoc> {
	switch (op.type) {
		case "createModule": {
			/* Mirror how the SA composes a case-managing creation: when the
			 * module declares a (clean) case type and carries forms, the
			 * first form is a registration unit opening with the case_name
			 * writer — the rest of the generated fields (garbage included)
			 * ride along. The gate still adjudicates everything; this
			 * steering only keeps the generator from producing exclusively
			 * incoherent births. */
			const coherentType =
				op.caseType && /^[a-z][a-z0-9_-]*$/.test(op.caseType)
					? op.caseType
					: undefined;
			const formFields = coherentType
				? [
						{
							kind: "text",
							id: "case_name",
							label: "Name",
							case_property_on: coherentType,
						},
						...op.fields.filter((fl) => fl.id !== "case_name"),
					]
				: op.fields;
			return runParsed(
				createModuleTool,
				{
					name: op.name,
					...(op.caseType && { case_type: op.caseType }),
					...(op.withForms && {
						forms: [
							{
								name: "First form",
								type: coherentType ? "registration" : op.formType,
								fields: formFields,
								...(op.connect && { connect: op.connect }),
							},
						],
					}),
					...(op.withColumns && {
						case_list_columns: [
							{ kind: "plain", field: "case_name", header: "Name" },
						],
					}),
				},
				ctx,
				doc,
			);
		}
		case "createForm": {
			/* Same steering for a registration form: it must open its case
			 * with a case_name writer bound to the module's type — when the
			 * target module has one. */
			const moduleType = doc.modules[doc.moduleOrder[op.moduleIndex]]?.caseType;
			const fields =
				op.formType === "registration" && moduleType
					? [
							{
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: moduleType,
							},
							...op.fields.filter((fl) => fl.id !== "case_name"),
						]
					: op.fields;
			return runParsed(
				createFormTool,
				{
					moduleIndex: op.moduleIndex,
					name: op.name,
					type: op.formType,
					fields,
					...(op.connect && { connect: op.connect }),
				},
				ctx,
				doc,
			);
		}
		case "addFields":
			return runParsed(
				addFieldsTool,
				{
					moduleIndex: op.moduleIndex,
					formIndex: op.formIndex,
					fields: op.fields,
				},
				ctx,
				doc,
			);
		case "editField": {
			const fieldId = pickFieldId(
				doc,
				op.moduleIndex,
				op.formIndex,
				op.fieldPick,
			);
			if (!fieldId) return doc;
			const target = Object.values(doc.fields).find((fl) => fl.id === fieldId);
			return runParsed(
				editFieldTool,
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
				},
				ctx,
				doc,
			);
		}
		case "updateFormClose":
			return runParsed(
				updateFormTool,
				{
					moduleIndex: op.moduleIndex,
					formIndex: op.formIndex,
					close_condition: { field: op.closeField, answer: op.closeAnswer },
				},
				ctx,
				doc,
			);
		case "updateModule":
			return runParsed(
				updateModuleTool,
				{
					moduleIndex: op.moduleIndex,
					...(op.caseType && { case_type: op.caseType }),
				},
				ctx,
				doc,
			);
		case "removeField": {
			const fieldId = pickFieldId(
				doc,
				op.moduleIndex,
				op.formIndex,
				op.fieldPick,
			);
			if (!fieldId) return doc;
			return runParsed(
				removeFieldTool,
				{
					moduleIndex: op.moduleIndex,
					formIndex: op.formIndex,
					fieldId,
				},
				ctx,
				doc,
			);
		}
		case "removeForm":
			return runParsed(
				removeFormTool,
				{ moduleIndex: op.moduleIndex, formIndex: op.formIndex },
				ctx,
				doc,
			);
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
	// Atomic creation is what keeps a complete app from ever gaining an
	// empty form — a regression there (a creation tool landing a form
	// without its fields) fails the fuzz here, not just the narrower
	// per-tool pins.
	"EMPTY_FORM",
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

	it("complete phase: the ratchet additionally keeps NO_CASE_NAME_FIELD and EMPTY_FORM out of a doc that starts without them", async () => {
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

	it("complete Connect app: creations carrying (or missing) connect blocks hold the same invariants", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 10 }),
				async (ops) => {
					const ctx = makeCtx("complete");
					let doc = completeConnectDoc();
					for (const [i, op] of ops.entries()) {
						doc = await applyOp(doc, ctx, op);
						assertNoRegistryCodes(doc, RATCHETED, `connect op#${i} ${op.type}`);
					}
				},
			),
			{ numRuns: 30 },
		);
	});
});
