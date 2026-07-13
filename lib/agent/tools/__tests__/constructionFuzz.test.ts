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
 * wrong-cased functions, broken close conditions, media kinds, unknown
 * case properties) — the surface is supposed to REFUSE the bad ones;
 * the invariant is about the doc state after whatever was accepted. A
 * second run grows a Connect learn app from birth, with creations
 * optionally carrying their per-form `connect` blocks.
 *
 * The op pool spans the structural tools (create/remove module + form,
 * field mutations — `removeModule` included) and the whole
 * case-list-config family (column add/update/remove/reorder, the
 * filter, search-input add/update/remove/reorder). The case-type
 * retirement machinery is exercised BY ASSERTION, not by sampling
 * luck: the standard run tallies its arms per op and requires, under
 * the pinned seed, ≥1 retire-cascade commit (a commit that shrank the
 * case-type catalog), ≥1 blocked-verdict bounce (a displacement the
 * planner refused over live references), and ≥1 NO_MODULES bounce (an
 * only-module removal the gate rejected). The media tools stay out:
 * their inputs are opaque asset ids with no gate interplay
 * (attach-time existence is deliberately unchecked — the export
 * boundary adjudicates against the resolved manifest), so a media op
 * would only ever write an arbitrary id the invariant can't judge.
 */

import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	planCaseTypeRetirementOnRemove,
	planCaseTypeRetirementOnRetype,
} from "@/lib/doc/caseTypeRetirement";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { addFieldsTool } from "../addFields";
import { addCaseListColumnsTool } from "../case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "../case-list-config/addSearchInputs";
import { removeCaseListColumnTool } from "../case-list-config/removeCaseListColumn";
import { removeSearchInputTool } from "../case-list-config/removeSearchInput";
import { reorderCaseListColumnsTool } from "../case-list-config/reorderCaseListColumns";
import { reorderSearchInputsTool } from "../case-list-config/reorderSearchInputs";
import { setCaseListFilterTool } from "../case-list-config/setCaseListFilter";
import { updateCaseListColumnTool } from "../case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "../case-list-config/updateSearchInput";
import { createFormTool } from "../createForm";
import { createModuleTool } from "../createModule";
import { editFieldTool } from "../editField";
import { generateSchemaTool } from "../generateSchema";
import { removeFieldTool } from "../removeField";
import { removeFormTool } from "../removeForm";
import { removeModuleTool } from "../removeModule";
import { updateAppTool } from "../updateApp";
import { updateFormTool } from "../updateForm";
import { updateModuleTool } from "../updateModule";

function makeCtx(): ToolExecutionContext {
	// The guarded writer returns `{ events, committedDoc }`; echo the passed
	// post-mutation doc as the committed doc so the fuzz driver threads each
	// tool's `newDoc` (= committedDoc) into the next op.
	return {
		appId: "app-fuzz",
		userId: "user-fuzz",
		runId: "run-fuzz",
		recordMutations: vi.fn(async (_m: unknown, doc: unknown) => ({
			events: [],
			committedDoc: doc,
		})),
		recordMutationStages: vi.fn(async (stages: Array<{ doc: unknown }>) => ({
			events: [],
			committedDoc: stages[stages.length - 1]?.doc,
		})),
		recordConversation: vi.fn(),
	} as unknown as ToolExecutionContext;
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

/* Case-list pools. "ghost_prop" names no declared case property, so the
 * ops carrying it exercise the unknown-property rejection arms while the
 * clean entries land commits. */
const COLUMN_FIELD_POOL = ["case_name", "village", "village", "ghost_prop"];
const COLUMN_HEADER_POOL = ["Name", "Village", "Status"];
const SEARCH_INPUT_NAME_POOL = ["by_name", "by_village", "find_case"];

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

/** Optional per-form connect block (learn shapes) — the Connect-app run's
 *  creations carry these. The id axis has two arms: an OMITTED id (the
 *  schema-recommended normal case — the creation tools must autofill a
 *  valid unique id, never land an id-less block) and an explicit id from a
 *  small pool (so explicit collisions — a fail-the-call outcome — occur
 *  alongside clean creations). The sub-config axis covers all three learn
 *  shapes — learn_module only, assessment only, and both — because
 *  `assessment.user_score` is the one creation-tool input that crosses the
 *  text → AST parse boundary: its pool mixes a literal, the
 *  `__same_call_field__` marker (resolved by `resolveConnectScoreRef` to a
 *  reference to a field landing in the same call — the batch-overlay
 *  resolution shape), and a dangling reference (a gate bounce).
 *  `fc.option` keeps the no-block arm — on a Connect app that arm creates
 *  an AUXILIARY form (no participation, a legal commit), so the property
 *  exercises mixed apps alongside fully participating ones; `freq: 3`
 *  draws it often enough that auxiliary creations land real commits under
 *  the pinned seed (the default left it starved to garbage-only draws). */
const connectArb = fc.option(
	fc
		.record({
			id: fc.constantFrom("lesson_a", "lesson_b", "lesson_c"),
			omitId: fc.boolean(),
			shape: fc.constantFrom(
				"learn_module",
				"assessment",
				"both",
			) as fc.Arbitrary<"learn_module" | "assessment" | "both">,
			/* Marker-weighted: the same-call reference is the arm the parse
			 * boundary exists for, so it dominates; the literal and the
			 * dangling reference keep the trivial-commit and bounce arms
			 * alive. */
			userScore: fc.constantFrom<string>(
				"__same_call_field__",
				"__same_call_field__",
				"1",
				"#form/missing_score",
			),
		})
		.map(({ id, omitId, shape, userScore }) => ({
			...(shape !== "assessment" && {
				learn_module: {
					...(omitId ? {} : { id }),
					name: "Lesson",
					description: "Generated lesson content",
					time_estimate: 15,
				},
			}),
			...(shape !== "learn_module" && {
				assessment: {
					// Disjoint from the learn_module pool so a "both" block
					// can't collide with itself.
					...(omitId ? {} : { id: `${id}_quiz` }),
					user_score: userScore,
				},
			}),
		})),
	{ freq: 3, nil: undefined },
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
	fc
		.record({ moduleIndex: moduleIndexArb })
		.map((r) => ({ type: "removeModule" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			field: fc.constantFrom(...COLUMN_FIELD_POOL),
			header: fc.constantFrom(...COLUMN_HEADER_POOL),
		})
		.map((r) => ({ type: "addCaseListColumns" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			columnPick: fc.nat({ max: 5 }),
			field: fc.constantFrom(...COLUMN_FIELD_POOL),
			header: fc.constantFrom(...COLUMN_HEADER_POOL),
		})
		.map((r) => ({ type: "updateCaseListColumn" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			columnPick: fc.nat({ max: 5 }),
		})
		.map((r) => ({ type: "removeCaseListColumn" as const, ...r })),
	fc
		.record({ moduleIndex: moduleIndexArb })
		.map((r) => ({ type: "reorderCaseListColumns" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			clear: fc.boolean(),
			property: fc.constantFrom(...COLUMN_FIELD_POOL),
		})
		.map((r) => ({ type: "setCaseListFilter" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			name: fc.constantFrom(...SEARCH_INPUT_NAME_POOL),
			property: fc.constantFrom(...COLUMN_FIELD_POOL),
		})
		.map((r) => ({ type: "addSearchInputs" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			inputPick: fc.nat({ max: 5 }),
			name: fc.constantFrom(...SEARCH_INPUT_NAME_POOL),
			property: fc.constantFrom(...COLUMN_FIELD_POOL),
		})
		.map((r) => ({ type: "updateSearchInput" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			inputPick: fc.nat({ max: 5 }),
		})
		.map((r) => ({ type: "removeSearchInput" as const, ...r })),
	fc
		.record({ moduleIndex: moduleIndexArb })
		.map((r) => ({ type: "reorderSearchInputs" as const, ...r })),
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

/** One generated per-form connect block (the creation ops' optional slot). */
type GeneratedConnectBlock = Exclude<
	Extract<FuzzOp, { type: "createForm" }>["connect"],
	undefined
>;

/**
 * Resolve the generator's `__same_call_field__` user_score marker against
 * the fields THIS creation actually lands — the only doc-agnostic way to
 * exercise the assessment parse boundary's batch overlay (a `user_score`
 * referencing a field from the same call) at real frequency, mirroring
 * the `__own__` case-binding marker. With no landable field the marker
 * falls back to a literal score so the block stays committable.
 */
function resolveConnectScoreRef(
	connect: GeneratedConnectBlock,
	fields: readonly FieldItem[],
): GeneratedConnectBlock {
	if (connect.assessment?.user_score !== "__same_call_field__") return connect;
	const first = fields[0];
	return {
		...connect,
		assessment: {
			...connect.assessment,
			user_score: first ? `#form/${first.id}` : "1",
		},
	};
}

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

/** The module's case-list config at a positional index, if any. */
function caseListConfigAt(
	doc: BlueprintDoc,
	moduleIndex: number,
): { columns: { uuid: Uuid }[]; searchInputs: { uuid: Uuid }[] } | undefined {
	return doc.modules[doc.moduleOrder[moduleIndex]]?.caseListConfig;
}

/** Resolve a case-list column uuid by pick index (deterministic). */
function pickColumnUuid(
	doc: BlueprintDoc,
	moduleIndex: number,
	pick: number,
): Uuid | undefined {
	const columns = caseListConfigAt(doc, moduleIndex)?.columns ?? [];
	return columns.length > 0 ? columns[pick % columns.length]?.uuid : undefined;
}

/** Resolve a search-input uuid by pick index (deterministic). */
function pickSearchInputUuid(
	doc: BlueprintDoc,
	moduleIndex: number,
	pick: number,
): Uuid | undefined {
	const inputs = caseListConfigAt(doc, moduleIndex)?.searchInputs ?? [];
	return inputs.length > 0 ? inputs[pick % inputs.length]?.uuid : undefined;
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
			 * included) ride along, and a NEW case type's record lands
			 * FIRST via generateSchema (the data-model tool — the only way
			 * a record reaches the doc), exactly the SA's real sequence.
			 * The gate still adjudicates everything; this steering only
			 * keeps the generator from producing exclusively incoherent
			 * births. */
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
			if (needsRecord) {
				doc = await runParsed(
					generateSchemaTool,
					{
						appName: doc.appName || "Fuzz App",
						caseTypes: [
							{
								name: coherentType,
								properties: [
									{ name: "case_name", label: "Name" },
									{ name: "village", label: "Village" },
								],
							},
						],
					},
					ctx,
					doc,
				);
			}
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
								...(op.connect && {
									connect: resolveConnectScoreRef(op.connect, formFields),
								}),
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
					...(op.connect && {
						connect: resolveConnectScoreRef(op.connect, fields),
					}),
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
		case "removeModule":
			/* Exercises the case-type retirement cascade (the prelude module is
			 * its type's only owner) AND the NO_MODULES re-introduction
			 * rejection (removing the only module bounces at the gate) — both
			 * occurrences asserted by the retirement-arm tallies. */
			return runParsed(
				removeModuleTool,
				{ moduleIndex: op.moduleIndex },
				ctx,
				doc,
			);
		case "addCaseListColumns":
			return runParsed(
				addCaseListColumnsTool,
				{
					moduleIndex: op.moduleIndex,
					columns: [{ kind: "plain", field: op.field, header: op.header }],
				},
				ctx,
				doc,
			);
		case "updateCaseListColumn": {
			const columnUuid = pickColumnUuid(doc, op.moduleIndex, op.columnPick);
			if (!columnUuid) return doc;
			return runParsed(
				updateCaseListColumnTool,
				{
					moduleIndex: op.moduleIndex,
					columnUuid,
					column: { kind: "plain", field: op.field, header: op.header },
				},
				ctx,
				doc,
			);
		}
		case "removeCaseListColumn": {
			const columnUuid = pickColumnUuid(doc, op.moduleIndex, op.columnPick);
			if (!columnUuid) return doc;
			return runParsed(
				removeCaseListColumnTool,
				{ moduleIndex: op.moduleIndex, columnUuid },
				ctx,
				doc,
			);
		}
		case "reorderCaseListColumns": {
			/* Reversal of the live uuid set — always a complete permutation,
			 * so the op exercises the reorder commit rather than the
			 * unknown/missing-uuid input rejections. */
			const columns = caseListConfigAt(doc, op.moduleIndex)?.columns ?? [];
			if (columns.length === 0) return doc;
			return runParsed(
				reorderCaseListColumnsTool,
				{
					moduleIndex: op.moduleIndex,
					columnUuids: columns.map((c) => c.uuid).reverse(),
				},
				ctx,
				doc,
			);
		}
		case "setCaseListFilter": {
			/* The predicate names the target module's OWN type (the dominant
			 * authoring shape); a typeless module falls back to a foreign
			 * literal so the rejection arm stays alive. `clear` keeps the
			 * null-clears convention exercised. */
			const ownType =
				doc.modules[doc.moduleOrder[op.moduleIndex]]?.caseType ?? "patient";
			return runParsed(
				setCaseListFilterTool,
				{
					moduleIndex: op.moduleIndex,
					filter: op.clear
						? null
						: eq(prop(ownType, op.property), literal("x")),
				},
				ctx,
				doc,
			);
		}
		case "addSearchInputs":
			return runParsed(
				addSearchInputsTool,
				{
					moduleIndex: op.moduleIndex,
					searchInputs: [
						{
							kind: "simple",
							name: op.name,
							label: "Search",
							type: "text",
							property: op.property,
						},
					],
				},
				ctx,
				doc,
			);
		case "updateSearchInput": {
			const searchInputUuid = pickSearchInputUuid(
				doc,
				op.moduleIndex,
				op.inputPick,
			);
			if (!searchInputUuid) return doc;
			return runParsed(
				updateSearchInputTool,
				{
					moduleIndex: op.moduleIndex,
					searchInputUuid,
					searchInput: {
						kind: "simple",
						name: op.name,
						label: "Search",
						type: "text",
						property: op.property,
					},
				},
				ctx,
				doc,
			);
		}
		case "removeSearchInput": {
			const searchInputUuid = pickSearchInputUuid(
				doc,
				op.moduleIndex,
				op.inputPick,
			);
			if (!searchInputUuid) return doc;
			return runParsed(
				removeSearchInputTool,
				{ moduleIndex: op.moduleIndex, searchInputUuid },
				ctx,
				doc,
			);
		}
		case "reorderSearchInputs": {
			const inputs = caseListConfigAt(doc, op.moduleIndex)?.searchInputs ?? [];
			if (inputs.length === 0) return doc;
			return runParsed(
				reorderSearchInputsTool,
				{
					moduleIndex: op.moduleIndex,
					searchInputUuids: inputs.map((i) => i.uuid).reverse(),
				},
				ctx,
				doc,
			);
		}
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

/**
 * The persisted-shape invariant, asserted beside the zero-findings one:
 * every doc the tools grow must round-trip the SAME Zod gate the next
 * load runs (`appDocSchema` parses the stored blueprint through
 * `blueprintDocSchema`). The validator can't see this class — a raw
 * string parked in an AST-typed slot validates clean (the total reader
 * projects it as text) but bricks the app on its next load, which is
 * how the creation tools' unparsed `assessment.user_score` shipped.
 */
function assertPersistedShapeParses(doc: BlueprintDoc, context: string): void {
	const parsed = blueprintDocSchema.safeParse(toPersistableDoc(doc));
	if (!parsed.success) {
		throw new Error(
			`a tool committed a doc the next load's Zod gate rejects (${context}): ${parsed.error.message}`,
		);
	}
}

/**
 * The reference-index parity invariant, asserted over the same
 * tool-grown sequences: every committed doc carries an incrementally
 * maintained index (the gate's candidate apply seeded it), and it must
 * deep-equal a from-scratch rebuild. The dedicated raw-mutation fuzz
 * (`lib/doc/__tests__/referenceIndex.fuzz.test.ts`) covers the kinds
 * the tools don't drive; this run covers the real tool batches —
 * atomic creations, the retirement cascade's `setCaseTypes` append,
 * multi-stage edits — so the two alphabets meet in the middle.
 */
function assertIndexParity(doc: BlueprintDoc, context: string): void {
	// Presence is asserted, not assumed: every doc this fuzz sees after
	// the preludes was produced by the gated tool path, whose candidate
	// apply seeds the index — if a refactor ever stops that seeding, the
	// parity check below must fail loudly rather than become a green
	// no-op over `undefined`.
	expect(
		doc.refIndex,
		`the tool path stopped carrying a reference index at ${context} — every parity assertion in this suite is vacuous without it`,
	).toBeDefined();
	expect(
		doc.refIndex,
		`reference index diverged from rebuild at ${context}`,
	).toEqual(buildReferenceIndex(doc));
}

/**
 * The order-key invariant — the construction-side analog of the read-side
 * `orderSequenceSweep` tripwire. A doc grown from birth purely through the
 * tools has NO legacy members, so every ordered member (module, form, field,
 * case-list column, search input, select option) must carry an `order` key and
 * every option a `uuid` — a key-less member sorts ahead of its keyed siblings
 * under `bySortKey` until a reload's backfill, and a uuid-less option is
 * invisible to the per-uuid option diff. This fails LOUDLY the next time any
 * construction path forgets to mint one.
 */
function assertEveryMemberKeyed(doc: BlueprintDoc, context: string): void {
	const missing: string[] = [];
	for (const mod of Object.values(doc.modules)) {
		if (mod.order === undefined)
			missing.push(`module "${mod.name}" (no order)`);
		const config = mod.caseListConfig;
		if (!config) continue;
		for (const col of config.columns) {
			if (col.order === undefined) {
				missing.push(`column ${col.uuid} on "${mod.name}" (no order)`);
			}
		}
		for (const input of config.searchInputs) {
			if (input.order === undefined) {
				missing.push(`search input ${input.uuid} on "${mod.name}" (no order)`);
			}
		}
	}
	for (const form of Object.values(doc.forms)) {
		if (form.order === undefined)
			missing.push(`form "${form.name}" (no order)`);
	}
	for (const field of Object.values(doc.fields)) {
		if (field.order === undefined) {
			missing.push(`field "${field.id}" (no order)`);
		}
		if ("options" in field && Array.isArray(field.options)) {
			field.options.forEach((opt, i) => {
				if (opt.order === undefined) {
					missing.push(`option #${i} on field "${field.id}" (no order)`);
				}
				if (opt.uuid === undefined) {
					missing.push(`option #${i} on field "${field.id}" (no uuid)`);
				}
			});
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`a tool-grown doc has an unkeyed member (${context}): ${missing.join("; ")}`,
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
// acceptance floor below). The same standing-target rationale gives the
// prelude module a SECOND case-list column and one search input (grown
// through the real config tools): the update/remove/reorder config ops
// always have an addressable entry from op #0, instead of depending on
// the sequence first landing an add.

async function growStandardPrelude(
	ctx: ToolExecutionContext,
): Promise<BlueprintDoc> {
	let doc = birthDoc();
	/* The SA's real opening sequence: the data-model tool writes the app
	 * name + the case-type record, then the module references the type by
	 * name. */
	doc = await runParsed(
		generateSchemaTool,
		{
			appName: "Fuzz Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "village", label: "Village" },
					],
				},
			],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		createModuleTool,
		{
			name: "Patients",
			case_type: "patient",
			case_list_columns: [
				{ kind: "plain", field: "case_name", header: "Name" },
			],
			forms: [
				{
					name: "Register patient",
					type: "registration",
					/* A spare writer as the standing removeField target — a removable
					 * field whose removal leaves the registration form valid, so
					 * prelude-form removals don't bounce. */
					fields: [
						...registrationUnitFields("patient"),
						{
							kind: "text",
							id: "notes",
							label: "Notes",
							case_property_on: "patient",
						},
					],
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
	/* A second, caseless module is the standing removeModule target:
	 * removing the ONLY module bounces on NO_MODULES, so without one the
	 * op's commits would depend on a sequence creating a module first. */
	doc = await runParsed(
		createModuleTool,
		{
			name: "Feedback",
			forms: [
				{
					name: "Feedback survey",
					type: "survey",
					fields: [{ kind: "text", id: "comments", label: "Comments" }],
				},
			],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		addCaseListColumnsTool,
		{
			moduleIndex: 0,
			columns: [{ kind: "plain", field: "village", header: "Village" }],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		addSearchInputsTool,
		{
			moduleIndex: 0,
			searchInputs: [
				{
					kind: "simple",
					name: "by_name",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		},
		ctx,
		doc,
	);
	expect(doc.modules[doc.moduleOrder[0]]?.caseListConfig?.columns).toHaveLength(
		2,
	);
	expect(doc.moduleOrder).toHaveLength(2);
	return doc;
}

async function growConnectPrelude(
	ctx: ToolExecutionContext,
): Promise<BlueprintDoc> {
	let doc = birthDoc();
	/* The data-model tool writes the name + record; the Connect flip rides
	 * updateApp BEFORE any module exists — on an empty app the flip
	 * introduces nothing. Later creations choose per form whether to carry
	 * a connect block (participate in Connect) or not (stay auxiliary);
	 * the gate only insists the app keeps ≥1 participating form. */
	doc = await runParsed(
		generateSchemaTool,
		{
			appName: "Fuzz Training",
			caseTypes: [
				{
					name: "trainee",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "village", label: "Village" },
					],
				},
			],
		},
		ctx,
		doc,
	);
	doc = await runParsed(updateAppTool, { connect_type: "learn" }, ctx, doc);
	doc = await runParsed(
		createModuleTool,
		{
			name: "Lessons",
			case_type: "trainee",
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
					/* Third writer = standing removeField target — see the
					 * standard prelude. */
					fields: [
						...registrationUnitFields("trainee"),
						{
							kind: "text",
							id: "notes",
							label: "Notes",
							case_property_on: "trainee",
						},
					],
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
	/* Deliberately NO connect block, through the real createForm tool: an
	 * AUXILIARY form is a legal commit on a Connect app, the prelude itself
	 * becomes a MIXED app (participating + auxiliary forms), and the
	 * zero-findings assert right after the prelude pins that the mix is a
	 * legal committed state. Deterministic here because under the pinned
	 * seed fast-check's per-run bias clusters the property's no-block draws
	 * with garbage field draws — a sampled commit floor for this arm would
	 * starve. */
	doc = await runParsed(
		createFormTool,
		{
			moduleIndex: 0,
			name: "Reference sheet",
			type: "survey",
			fields: [{ kind: "text", id: "tips", label: "Tips" }],
		},
		ctx,
		doc,
	);
	expect(
		doc.formOrder[doc.moduleOrder[0]],
		"the auxiliary (blockless) createForm must commit on the Connect app",
	).toHaveLength(3);
	/* Standing removeModule target — see the standard prelude. Its form
	 * participates (carries a learn block) so removing the module is a
	 * legal commit whenever the Lessons module still participates. */
	doc = await runParsed(
		createModuleTool,
		{
			name: "Feedback",
			forms: [
				{
					name: "Feedback survey",
					type: "survey",
					connect: {
						learn_module: {
							id: "feedback_module",
							name: "Feedback",
							description: "Course feedback",
							time_estimate: 5,
						},
					},
					fields: [{ kind: "text", id: "comments", label: "Comments" }],
				},
			],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		addCaseListColumnsTool,
		{
			moduleIndex: 0,
			columns: [{ kind: "plain", field: "village", header: "Village" }],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		addSearchInputsTool,
		{
			moduleIndex: 0,
			searchInputs: [
				{
					kind: "simple",
					name: "by_name",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
		},
		ctx,
		doc,
	);
	expect(doc.modules[doc.moduleOrder[0]]?.caseListConfig?.columns).toHaveLength(
		2,
	);
	expect(doc.moduleOrder).toHaveLength(2);
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
	"removeModule",
	"addCaseListColumns",
	"updateCaseListColumn",
	"removeCaseListColumn",
	"reorderCaseListColumns",
	"setCaseListFilter",
	"addSearchInputs",
	"updateSearchInput",
	"removeSearchInput",
	"reorderSearchInputs",
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

// ── Retirement-arm occurrence tallies ───────────────────────────────────
//
// The acceptance floor above proves each op TYPE commits, but a
// `removeModule` commit can be the caseless prelude module — never
// touching the retirement machinery. These tallies classify each
// module-displacing op's outcome so the run can assert the three
// retirement arms each actually OCCURRED (≥1 each, occurrence assertions
// under the pinned seed — not per-run floors): the cascade committed (the
// catalog shrank — `setCaseTypes` is reachable only through the cascade
// on this op pool), the planner blocked a displacement over live
// references, and the gate bounced an only-module removal (NO_MODULES).

interface RetirementArmTally {
	retireCascadeCommits: number;
	blockedBounces: number;
	noModulesBounces: number;
}

/** Mirrors `applyOp`'s createModule steering — only a coherent type
 *  reaches the planner through the real tools, so only those classify. */
const COHERENT_TYPE = /^[a-z][a-z0-9_-]*$/;

/** Classify one op's retirement-arm outcome into `tally`. `committed`
 *  is the `next !== doc` signal the acceptance floor already uses. */
function tallyRetirementArms(
	tally: RetirementArmTally,
	doc: BlueprintDoc,
	next: BlueprintDoc,
	op: FuzzOp,
	committed: boolean,
): void {
	if (committed) {
		if ((doc.caseTypes?.length ?? 0) > (next.caseTypes?.length ?? 0)) {
			tally.retireCascadeCommits++;
		}
		return;
	}
	if (op.type === "removeModule") {
		const moduleUuid = doc.moduleOrder[op.moduleIndex];
		if (moduleUuid === undefined) return;
		if (doc.moduleOrder.length === 1) {
			// Removing the only module re-introduces NO_MODULES whatever the
			// retirement plan says — the gate's bounce, not the planner's.
			tally.noModulesBounces++;
		} else if (
			planCaseTypeRetirementOnRemove(doc, moduleUuid).kind === "blocked"
		) {
			tally.blockedBounces++;
		}
		return;
	}
	if (op.type === "updateModule") {
		const moduleUuid = doc.moduleOrder[op.moduleIndex];
		const caseType =
			op.caseType === "__own__"
				? doc.modules[moduleUuid]?.caseType
				: op.caseType;
		// Only a schema-clean type reaches the gate (a malformed one is a
		// Zod refusal before any planner runs) — classify only those.
		if (
			moduleUuid !== undefined &&
			caseType !== undefined &&
			COHERENT_TYPE.test(caseType) &&
			planCaseTypeRetirementOnRetype(doc, moduleUuid, caseType).kind ===
				"blocked"
		) {
			tally.blockedBounces++;
		}
	}
}

describe("construction fuzz — a tool-grown doc carries zero findings", () => {
	it("standard app: every accepted sequence from birth keeps the doc finding-free", async () => {
		const tally = newCommitTally();
		const retirementArms: RetirementArmTally = {
			retireCascadeCommits: 0,
			blockedBounces: 0,
			noModulesBounces: 0,
		};
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 14 }),
				async (ops) => {
					const ctx = makeCtx();
					let doc = await growStandardPrelude(ctx);
					assertZeroFindings(doc, "standard prelude");
					assertIndexParity(doc, "standard prelude");
					assertPersistedShapeParses(doc, "standard prelude");
					assertEveryMemberKeyed(doc, "standard prelude");
					for (const [i, op] of ops.entries()) {
						const next = await applyOp(doc, ctx, op);
						const committed = next !== doc;
						if (committed) tally.set(op.type, (tally.get(op.type) ?? 0) + 1);
						tallyRetirementArms(retirementArms, doc, next, op, committed);
						doc = next;
						assertZeroFindings(doc, `standard op#${i} ${op.type}`);
						assertIndexParity(doc, `standard op#${i} ${op.type}`);
						assertPersistedShapeParses(doc, `standard op#${i} ${op.type}`);
						assertEveryMemberKeyed(doc, `standard op#${i} ${op.type}`);
					}
				},
			),
			{ numRuns: 60, seed: 20260610 },
		);
		assertCommitFloor(tally, "standard app");
		// The retirement arms each occurred — see the tally section above
		// for why the per-op-type floor alone can't claim this.
		expect(
			retirementArms.retireCascadeCommits,
			"no committed op ever retired a case-type record — the cascade's retire arm went unexercised",
		).toBeGreaterThan(0);
		expect(
			retirementArms.blockedBounces,
			"no module displacement was ever blocked over live references — the planner's blocked arm went unexercised",
		).toBeGreaterThan(0);
		expect(
			retirementArms.noModulesBounces,
			"no only-module removal ever bounced — the NO_MODULES re-introduction rejection went unexercised",
		).toBeGreaterThan(0);
	});

	it("Connect learn app: creations carrying (or missing) connect blocks hold the same invariant", async () => {
		const tally = newCommitTally();
		/* The Connect-specific floors: this run exists to prove creations work
		 * under participation semantics (a block is opt-in per form) + the id
		 * enforcement + the user_score parse boundary, which is only proven
		 * if the matching creations actually COMMIT — the omitted-id arm
		 * (the autofill path), the assessment arm (the text → AST boundary),
		 * and the same-call reference arm (the batch-overlay resolution that
		 * must land an identity leaf, the exact shape the unparsed-cast
		 * regression hid). The auxiliary (blockless) creation commit is
		 * pinned DETERMINISTICALLY in `growConnectPrelude` — under the
		 * pinned seed, fast-check's per-run bias clusters the no-block draw
		 * with garbage field draws, so a sampled floor for it would starve —
		 * and every property op then runs against that mixed app. */
		let connectCreationCommits = 0;
		let omittedIdCreationCommits = 0;
		let assessmentCreationCommits = 0;
		let sameCallScoreRefCommits = 0;
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 14 }),
				async (ops) => {
					const ctx = makeCtx();
					let doc = await growConnectPrelude(ctx);
					assertZeroFindings(doc, "connect prelude");
					assertIndexParity(doc, "connect prelude");
					assertPersistedShapeParses(doc, "connect prelude");
					assertEveryMemberKeyed(doc, "connect prelude");
					for (const [i, op] of ops.entries()) {
						const next = await applyOp(doc, ctx, op);
						if (next !== doc) {
							tally.set(op.type, (tally.get(op.type) ?? 0) + 1);
							if (
								(op.type === "createForm" || op.type === "createModule") &&
								opCarriesConnect(op) &&
								op.connect
							) {
								connectCreationCommits++;
								if (
									(op.connect.learn_module ?? op.connect.assessment)?.id ===
									undefined
								) {
									omittedIdCreationCommits++;
								}
								if (op.connect.assessment) {
									assessmentCreationCommits++;
									if (
										op.connect.assessment.user_score === "__same_call_field__"
									) {
										sameCallScoreRefCommits++;
									}
								}
							}
						}
						doc = next;
						assertZeroFindings(doc, `connect op#${i} ${op.type}`);
						assertIndexParity(doc, `connect op#${i} ${op.type}`);
						assertPersistedShapeParses(doc, `connect op#${i} ${op.type}`);
						assertEveryMemberKeyed(doc, `connect op#${i} ${op.type}`);
					}
				},
			),
			{ numRuns: 45, seed: 20260610 },
		);
		assertCommitFloor(tally, "connect run");
		expect(connectCreationCommits).toBeGreaterThan(0);
		expect(omittedIdCreationCommits).toBeGreaterThan(0);
		expect(
			assessmentCreationCommits,
			"no assessment-carrying creation ever committed — the user_score parse boundary went unexercised",
		).toBeGreaterThan(0);
		expect(
			sameCallScoreRefCommits,
			"no committed assessment ever referenced a field from its own call — the batch-overlay resolution arm went unexercised",
		).toBeGreaterThan(0);
	});
});
