/**
 * Construction fuzz — the standing proof of the always-valid invariant:
 * a doc grown purely through ACCEPTED tool calls — from the empty doc a
 * fresh app is born as, through the real SA/MCP tools with their real
 * assembly defaults and the real commit gate — carries ZERO validation
 * findings at all times once its first module lands. (Before that, the
 * birth findings — the nameless, moduleless state — are the only ones
 * alive, and they only ever shrink.)
 *
 * That single property subsumes the retired fix registry's per-code
 * pins: no registry code (nor any other finding) can exist on a doc the
 * construction surface grew, so there is nothing for a fix loop to fix
 * and nothing for a finishing step to catch.
 *
 * Every generated input goes through the tool's OWN Zod input schema
 * before execute — a refusal there (an image field carrying
 * `case_property_on`, a label on a `hidden` arm) is itself a valid
 * construction outcome, so the schemas' structural exclusions are part
 * of what the proof exercises. Inputs deliberately mix valid and
 * invalid raw values (bare-word XPath, reserved ids, XML-illegal ids,
 * wrong-cased functions, broken close conditions, media kinds) — the
 * surface is supposed to REFUSE the bad ones; the invariant is about
 * the doc state after whatever was accepted. A second run grows a
 * Connect learn app from birth, with creations optionally carrying
 * their per-form `connect` blocks.
 */

import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { addFieldsTool } from "../addFields";
import { createFormTool } from "../createForm";
import { createModuleTool } from "../createModule";
import { editFieldTool } from "../editField";
import { removeFieldTool } from "../removeField";
import { removeFormTool } from "../removeForm";
import { updateAppTool } from "../updateApp";
import { updateFormTool } from "../updateForm";
import { updateModuleTool } from "../updateModule";

function makeCtx(): ToolExecutionContext {
	return {
		appId: "app-fuzz",
		userId: "user-fuzz",
		runId: "run-fuzz",
		recordMutations: vi.fn().mockResolvedValue([]),
		recordMutationStages: vi.fn().mockResolvedValue([]),
		recordConversation: vi.fn(),
	};
}

/** The empty doc a fresh app is born as — `createApp`'s shape. */
function birthDoc(): BlueprintDoc {
	return {
		appId: "app-fuzz",
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

// ── Input pools — valid values interleaved with the exact garbage the
//    retired registry's fixes existed to repair ─────────────────────────

/* Weighted toward CLEAN values so sequences actually land commits — a
 * fuzz whose every op bounces would "prove" the invariant vacuously.
 * That balance is ENFORCED, not assumed: each property tallies commits
 * per op type and asserts the acceptance floor (see the floor section
 * above the describe). The garbage stays in at real frequency: each
 * entry is one of the exact conditions the retired registry repaired. */
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

/* Module/form pick: weighted toward the indexes that exist (the prelude
 * lands one module with two forms; sequences grow more) so most ops hit
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

/* Field case bindings add the `__own__` marker, resolved by `applyOp`
 * against the TARGET module's case type — the dominant authoring shape (a
 * field saving to its own module's case), and the only doc-agnostic way to
 * keep case-bound adds committing on every fixture (a generated literal
 * naming a FOREIGN type is a cross-type child-case shape the gate
 * usually rejects). The literals stay in so those rejection arms stay
 * alive. */
const FIELD_CASE_BINDING_POOL = [...CASE_TYPE_POOL, "__own__", "__own__"];

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
		withCaseProp: fc.option(fc.constantFrom(...FIELD_CASE_BINDING_POOL), {
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
 *  creations carry these. Three arms: an OMITTED id (the schema-recommended
 *  normal case — the creation tools must autofill a valid unique id, never
 *  land an id-less block), an explicit id from a small pool (so explicit
 *  collisions — a fail-the-call outcome — occur alongside clean creations),
 *  and no block at all. */
const connectArb = fc.option(
	fc
		.tuple(fc.constantFrom("lesson_a", "lesson_b", "lesson_c"), fc.boolean())
		.map(([id, omitId]) => ({
			learn_module: {
				...(omitId ? {} : { id }),
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
			fieldPick: fc.nat({ max: 5 }),
			closeField: fc.constantFrom(...CLEAN_IDS, "ghost"),
			closeAnswer: fc.constantFrom("done", "done", "done", ""),
		})
		.map((r) => ({ type: "updateFormClose" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			// `__own__` resolves to the target module's current type at apply
			// time — the re-assert/no-op patch shape, and the only arm that can
			// commit against an already-typed module.
			caseType: fc.constantFrom(...FIELD_CASE_BINDING_POOL),
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

/** The shape of one generated field item this file's steering reads. */
type FieldItem = { id: string; case_property_on?: string } & Record<
	string,
	unknown
>;

/** Resolve the generator's `__own__` case-binding marker against the target
 *  module's case type. With no own type the marker drops to an unbound
 *  field; foreign literals pass through untouched (rejection coverage). */
function resolveOwnCaseBindings(
	fields: readonly FieldItem[],
	ownType: string | undefined,
): FieldItem[] {
	return fields.map((fl) => {
		if (fl.case_property_on !== "__own__") return fl;
		const { case_property_on: _own, ...rest } = fl;
		return ownType ? { ...rest, case_property_on: ownType } : rest;
	});
}

/** The form type at a positional index, or undefined when out of range. */
function formTypeAt(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
): string | undefined {
	const moduleUuid = doc.moduleOrder[moduleIndex];
	const formUuid = moduleUuid
		? doc.formOrder[moduleUuid]?.[formIndex]
		: undefined;
	return formUuid ? doc.forms[formUuid]?.type : undefined;
}

/** First close-type form in document order, as positional indices. */
function findCloseForm(
	doc: BlueprintDoc,
): { moduleIndex: number; formIndex: number } | undefined {
	for (const [moduleIndex, moduleUuid] of doc.moduleOrder.entries()) {
		for (const [formIndex, formUuid] of (
			doc.formOrder[moduleUuid] ?? []
		).entries()) {
			if (doc.forms[formUuid]?.type === "close") {
				return { moduleIndex, formIndex };
			}
		}
	}
	return undefined;
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

/** The standard registration-unit field pair: the case_name writer plus a
 *  second property writer (a registration form must capture something
 *  about its new case beyond the name). */
function registrationUnitFields(caseType: string): FieldItem[] {
	return [
		{
			kind: "text",
			id: "case_name",
			label: "Name",
			case_property_on: caseType,
		},
		{
			kind: "text",
			id: "village",
			label: "Village",
			case_property_on: caseType,
		},
	];
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
			 * + village writers — the rest of the generated fields (garbage
			 * included) ride along, and a NEW case type carries its record
			 * in the same call (the only way a record reaches the doc). The
			 * gate still adjudicates everything; this steering only keeps
			 * the generator from producing exclusively incoherent births. */
			const coherentType =
				op.caseType && /^[a-z][a-z0-9_-]*$/.test(op.caseType)
					? op.caseType
					: undefined;
			const generated = resolveOwnCaseBindings(op.fields, coherentType);
			const formFields = coherentType
				? [
						...registrationUnitFields(coherentType),
						...generated.filter(
							(fl) => fl.id !== "case_name" && fl.id !== "village",
						),
					]
				: generated;
			const needsRecord =
				coherentType !== undefined &&
				!doc.caseTypes?.some((ct) => ct.name === coherentType);
			return runParsed(
				createModuleTool,
				{
					name: op.name,
					...(op.caseType && { case_type: op.caseType }),
					...(needsRecord && {
						case_type_record: {
							name: coherentType,
							properties: [
								{ name: "case_name", label: "Name" },
								{ name: "village", label: "Village" },
							],
						},
					}),
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
			 * with the registration unit bound to the module's type — when
			 * the target module has one. */
			const moduleType = doc.modules[doc.moduleOrder[op.moduleIndex]]?.caseType;
			const generated = resolveOwnCaseBindings(op.fields, moduleType);
			const fields =
				op.formType === "registration" && moduleType
					? [
							...registrationUnitFields(moduleType),
							...generated.filter(
								(fl) => fl.id !== "case_name" && fl.id !== "village",
							),
						]
					: generated;
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
					fields: resolveOwnCaseBindings(
						op.fields,
						doc.modules[doc.moduleOrder[op.moduleIndex]]?.caseType,
					),
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
		case "updateFormClose": {
			/* Steer toward the shape the SA actually issues: a close condition
			 * belongs to a close-type form and names one of ITS fields. When
			 * the generated indices don't point at a close form, retarget at
			 * the first one in the doc (none existing → keep the raw indices,
			 * so the wrong-form-type rejection stays exercised). The field id
			 * resolves off the target form via `fieldPick`; the "ghost" arm
			 * keeps the field-not-found rejection alive and the empty answer
			 * keeps the incomplete-condition rejection alive. */
			let moduleIndex: number = op.moduleIndex;
			let formIndex: number = op.formIndex;
			if (formTypeAt(doc, moduleIndex, formIndex) !== "close") {
				const close = findCloseForm(doc);
				if (close) ({ moduleIndex, formIndex } = close);
			}
			const field =
				op.closeField === "ghost"
					? "ghost"
					: (pickFieldId(doc, moduleIndex, formIndex, op.fieldPick) ??
						op.closeField);
			return runParsed(
				updateFormTool,
				{
					moduleIndex,
					formIndex,
					close_condition: { field, answer: op.closeAnswer },
				},
				ctx,
				doc,
			);
		}
		case "updateModule": {
			const caseType =
				op.caseType === "__own__"
					? doc.modules[doc.moduleOrder[op.moduleIndex]]?.caseType
					: op.caseType;
			return runParsed(
				updateModuleTool,
				{
					moduleIndex: op.moduleIndex,
					...(caseType && { case_type: caseType }),
				},
				ctx,
				doc,
			);
		}
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

/** The invariant: once the first module landed, the doc has NO findings. */
function assertZeroFindings(doc: BlueprintDoc, context: string): void {
	if (doc.moduleOrder.length === 0) return;
	const findings = runValidation(doc).map((e) => `${e.code}: ${e.message}`);
	expect.soft(findings, context).toEqual([]);
	if (findings.length > 0) {
		throw new Error(
			`a finding reached a construction-grown doc (${context}): ${findings.join(
				"; ",
			)}`,
		);
	}
}

// ── Preludes — the fixture state, GROWN through the real tools ──────────
//
// Each property starts from the birth doc and builds its baseline with
// real accepted calls, so the invariant covers the doc's whole life: the
// app name (the first mutation of any build), then one patient module
// carrying a registration unit AND a standing close-type form (a close
// condition can only commit on one — without it, the close op's commits
// would depend on the sequence first creating a close form, starving the
// acceptance floor below).

async function growStandardPrelude(
	ctx: ToolExecutionContext,
): Promise<BlueprintDoc> {
	let doc = birthDoc();
	doc = await runParsed(updateAppTool, { name: "Fuzz Clinic" }, ctx, doc);
	doc = await runParsed(
		createModuleTool,
		{
			name: "Patients",
			case_type: "patient",
			case_type_record: {
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
			case_list_columns: [
				{ kind: "plain", field: "case_name", header: "Name" },
			],
			forms: [
				{
					name: "Register patient",
					type: "registration",
					fields: registrationUnitFields("patient"),
				},
				{
					name: "Close case",
					type: "close",
					fields: [
						{
							kind: "text",
							id: "closure_reason",
							label: "Closure reason",
							case_property_on: "patient",
						},
					],
				},
			],
		},
		ctx,
		doc,
	);
	expect(doc.moduleOrder).toHaveLength(1);
	return doc;
}

async function growConnectPrelude(
	ctx: ToolExecutionContext,
): Promise<BlueprintDoc> {
	let doc = birthDoc();
	/* Connect-typed from the first mutation — on an empty app the flip
	 * introduces nothing, and every later creation must then carry its
	 * per-form connect block. */
	doc = await runParsed(
		updateAppTool,
		{ name: "Fuzz Training", connect_type: "learn" },
		ctx,
		doc,
	);
	doc = await runParsed(
		createModuleTool,
		{
			name: "Lessons",
			case_type: "trainee",
			case_type_record: {
				name: "trainee",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
			case_list_columns: [
				{ kind: "plain", field: "case_name", header: "Name" },
			],
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
					fields: registrationUnitFields("trainee"),
				},
				{
					name: "Close enrollment",
					type: "close",
					connect: {
						learn_module: {
							id: "closeout_module",
							name: "Closeout",
							description: "Wrapping up",
							time_estimate: 5,
						},
					},
					fields: [
						{
							kind: "text",
							id: "closure_reason",
							label: "Closure reason",
							case_property_on: "trainee",
						},
					],
				},
			],
		},
		ctx,
		doc,
	);
	expect(doc.moduleOrder).toHaveLength(1);
	return doc;
}

// ── Acceptance floor ────────────────────────────────────────────────────
//
// The zero-findings assertion above is vacuous over sequences whose every
// op bounces — a schema change that turns one op type into a permanent
// `safeParse` refusal would return the proof to near-zero execution while
// staying green. So each property tallies, per op type, how many ops landed
// a COMMITTED batch (the tools return a new doc reference only when
// `guardedMutate` accepted; every refusal path returns the input doc), and
// asserts every type committed at least once across the property's runs.
//
// The floor is only meaningful deterministically, so each property pins its
// fast-check `seed`: an unpinned run could legitimately sample a sequence
// set where a low-acceptance op type never lands, and the floor would flake.
// The pinned seeds keep the sampled sequences fixed; the generators stay the
// source of variety when they themselves change.

const OP_TYPES = [
	"createModule",
	"createForm",
	"addFields",
	"editField",
	"updateFormClose",
	"updateModule",
	"removeField",
	"removeForm",
] as const satisfies readonly FuzzOp["type"][];

function newCommitTally(): Map<FuzzOp["type"], number> {
	return new Map(OP_TYPES.map((t) => [t, 0]));
}

function assertCommitFloor(
	tally: ReadonlyMap<FuzzOp["type"], number>,
	label: string,
): void {
	for (const t of OP_TYPES) {
		expect(
			tally.get(t) ?? 0,
			`${label}: op type "${t}" never landed a committed batch — the property no longer exercises it, so its invariant coverage is vacuous`,
		).toBeGreaterThan(0);
	}
}

/** Whether this op's tool input actually carried a connect block (for
 *  createModule the block rides the first form, so it needs `withForms`). */
function opCarriesConnect(op: FuzzOp): boolean {
	if (op.type === "createForm") return op.connect !== undefined;
	if (op.type === "createModule")
		return op.withForms && op.connect !== undefined;
	return false;
}

describe("construction fuzz — a tool-grown doc carries zero findings", () => {
	it("standard app: every accepted sequence from birth keeps the doc finding-free", async () => {
		const tally = newCommitTally();
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 10 }),
				async (ops) => {
					const ctx = makeCtx();
					let doc = await growStandardPrelude(ctx);
					assertZeroFindings(doc, "standard prelude");
					for (const [i, op] of ops.entries()) {
						const next = await applyOp(doc, ctx, op);
						if (next !== doc) tally.set(op.type, (tally.get(op.type) ?? 0) + 1);
						doc = next;
						assertZeroFindings(doc, `standard op#${i} ${op.type}`);
					}
				},
			),
			{ numRuns: 40, seed: 20260610 },
		);
		assertCommitFloor(tally, "standard app");
	});

	it("Connect learn app: creations carrying (or missing) connect blocks hold the same invariant", async () => {
		const tally = newCommitTally();
		/* The Connect-specific floor: this run exists to prove creations work
		 * under the per-form block obligation + the id enforcement, which is
		 * only proven if connect-carrying creations actually COMMIT —
		 * including the omitted-id arm (the autofill path). */
		let connectCreationCommits = 0;
		let omittedIdCreationCommits = 0;
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 10 }),
				async (ops) => {
					const ctx = makeCtx();
					let doc = await growConnectPrelude(ctx);
					assertZeroFindings(doc, "connect prelude");
					for (const [i, op] of ops.entries()) {
						const next = await applyOp(doc, ctx, op);
						if (next !== doc) {
							tally.set(op.type, (tally.get(op.type) ?? 0) + 1);
							if (opCarriesConnect(op)) {
								connectCreationCommits++;
								if (
									(op.type === "createForm" || op.type === "createModule") &&
									op.connect?.learn_module.id === undefined
								) {
									omittedIdCreationCommits++;
								}
							}
						}
						doc = next;
						assertZeroFindings(doc, `connect op#${i} ${op.type}`);
					}
				},
			),
			{ numRuns: 30, seed: 20260610 },
		);
		assertCommitFloor(tally, "connect run");
		expect(connectCreationCommits).toBeGreaterThan(0);
		expect(omittedIdCreationCommits).toBeGreaterThan(0);
	});
});
