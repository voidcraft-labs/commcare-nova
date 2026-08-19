import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
/**
 * Construction fuzz — the standing proof of the always-valid invariant:
 * a doc grown purely through ACCEPTED tool calls — from the shared canonical
 * survey starter every persisted app is born with, through the real SA/MCP
 * tools with their real assembly defaults and the real commit gate — carries
 * ZERO validation findings at all times.
 *
 * That single property subsumes the retired fix registry's per-code
 * pins: no registry code (nor any other finding) can exist on a doc the
 * construction surface grew, so there is nothing for a fix loop to fix
 * and nothing for a finishing step to catch.
 *
 * Every generated input goes through the tool's OWN Zod input schema
 * before execute — a refusal there (an image field carrying
 * `caseWrite`, a label on a `hidden` arm) is itself a valid
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
import {
	mutationCommitVerdict,
	type PreparedMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type AdmittedMutationStages,
	isAdmittedMutationBatch,
} from "@/lib/doc/mutationAdmission";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import { canonicalAppGenesis } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, CaseListConfig, Uuid } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import type { CanonicalMutationHost } from "../../workspace/canonicalHost";
import { CanonicalMutationWorkspace } from "../../workspace/canonicalWorkspace";
import type { ToolInvocationContext } from "../../workspace/types";
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
import { configureConnectTool } from "../configureConnect";
import { createFormTool } from "../createForm";
import { createModuleTool } from "../createModule";
import { editFieldTool } from "../editField";
import { generateSchemaTool } from "../generateSchema";
import { moveFieldTool } from "../moveField";
import { removeFieldTool } from "../removeField";
import { removeFormTool } from "../removeForm";
import { removeModuleTool } from "../removeModule";
import { updateFormTool } from "../updateForm";
import { updateModuleTool } from "../updateModule";

function makeCtx(): CanonicalMutationHost {
	// The host echoes each prepared candidate's doc as the committed doc, so
	// the fuzz driver's per-op workspace hands back exactly the post-mutation
	// state and the driver threads it into the next op.
	return {
		appId: "app-fuzz",
		projectId: "project-fuzz",
		userId: "user-fuzz",
		runId: "run-fuzz",
		recordMutations: vi.fn(async (prepared: PreparedMutationCandidate) => ({
			events: [],
			committedDoc: prepared.nextDoc,
		})),
		recordMutationStages: vi.fn(
			async (
				prepared: PreparedMutationCandidate,
				_stages: AdmittedMutationStages,
			) => ({
				events: [],
				committedDoc: prepared.nextDoc,
			}),
		),
		conversionImpact: vi.fn(async () => ({
			totalWithValue: 0,
			uncastable: 0,
			alreadyHeld: 0,
			samples: [],
		})),
	};
}

/** The exact shared canonical starter every persisted app is born with. */
function birthDoc(name = "Fuzz Clinic"): BlueprintDoc {
	const empty: BlueprintDoc = {
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
	const genesis = canonicalAppGenesis(empty, name);
	const verdict = mutationCommitVerdict(
		empty,
		genesis.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) {
		throw new Error(
			`canonical app genesis failed its own commit gate: ${verdict.findings
				.map((finding) => `${finding.code}: ${finding.message}`)
				.join("; ")}`,
		);
	}
	return verdict.nextDoc;
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
	// Attachment kind — its case destination needs a `mode` the generated
	// `caseWrite` never supplies, so every combination of the two is a
	// schema refusal the proof exercises.
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
			...(kind !== "hidden" && { label: proseText(label) }),
			...(kind === "single_select" &&
				withOptions && {
					optionsSource: {
						kind: "inline",
						options: [
							{
								value: "yes",
								label: proseText("Yes"),
							},
							{
								value: "no",
								label: proseText("No"),
							},
						],
					},
				}),
			...(kind === "hidden"
				? {
						calculate: {
							parts: [{ kind: "text", text: withCalculate ?? "1 + 1" }],
						},
					}
				: withRelevant !== undefined && {
						relevant: { parts: [{ kind: "text", text: withRelevant }] },
					}),
			// Deliberately also generated for media kinds, whose arms exclude
			// the slot — those items become schema refusals, which is the
			// exclusion under test.
			...(kind !== "hidden" &&
				withCaseProp !== undefined &&
				withCaseProp !== "" && {
					caseWrite: { caseType: withCaseProp, property: id },
				}),
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
			fields: fc.array(fieldItemArb, { minLength: 1, maxLength: 2 }),
			withColumns: fc.boolean(),
			formType: fc.constantFrom(...FORM_TYPE_POOL),
		})
		.map((r) => ({ type: "createModule" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			name: fc.constantFrom("Follow up", "Close out", "Survey"),
			formType: fc.constantFrom(...FORM_TYPE_POOL, "followup", "survey"),
			fields: fc.array(fieldItemArb, { minLength: 1, maxLength: 2 }),
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
			// Kind conversion attempt — targets drawn across the
			// string-compatible tier. Most picks against a random source
			// kind are refused (not in `convertTargets`), which is itself
			// the path under test; the ones that land exercise the seeded
			// select options and the hidden calculate obligation.
			convertTo: fc.option(
				fc.constantFrom(
					"secret" as const,
					"barcode" as const,
					"single_select" as const,
					"hidden" as const,
					"text" as const,
				),
				{ nil: undefined },
			),
		})
		.map((r) => ({ type: "editField" as const, ...r })),
	fc
		.record({
			moduleIndex: moduleIndexArb,
			formIndex: formIndexArb,
			fieldPick: fc.nat({ max: 5 }),
			anchorPick: fc.nat({ max: 5 }),
			side: fc.constantFrom(
				"before" as const,
				"after" as const,
				"into" as const,
				"top" as const,
			),
		})
		.map((r) => ({ type: "moveField" as const, ...r })),
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
		.record({
			moduleIndex: moduleIndexArb,
			surface: fc.constantFrom("results" as const, "details" as const),
		})
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

/** Resolve a top-level field UUID within a form by pick index. */
function pickFieldUuid(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
	pick: number,
): Uuid | undefined {
	const moduleUuid = doc.moduleOrder[moduleIndex];
	const formUuid = moduleUuid
		? doc.formOrder[moduleUuid]?.[formIndex]
		: undefined;
	const order = formUuid ? (doc.fieldOrder[formUuid] ?? []) : [];
	return order[pick % Math.max(order.length, 1)];
}

/** The shape of one generated field item this file's steering reads. */
type FieldItem = {
	id: string;
	fieldUuid?: Uuid;
	caseWrite?: { caseType: string; property: string };
} & Record<string, unknown>;

function moduleUuidAt(doc: BlueprintDoc, moduleIndex: number): Uuid {
	return (
		doc.moduleOrder[moduleIndex] ??
		testUuid(`construction-fuzz-missing-module-${moduleIndex}`)
	);
}

function formAddressAt(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
): { moduleUuid: Uuid; formUuid: Uuid } {
	const moduleUuid = moduleUuidAt(doc, moduleIndex);
	return {
		moduleUuid,
		formUuid:
			doc.formOrder[moduleUuid]?.[formIndex] ??
			testUuid(`construction-fuzz-missing-form-${moduleIndex}-${formIndex}`),
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
		if (fl.caseWrite?.caseType !== "__own__") return fl;
		const { caseWrite, ...rest } = fl;
		return ownType
			? {
					...rest,
					caseWrite: { ...caseWrite, caseType: ownType },
				}
			: rest;
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
): CaseListConfig | undefined {
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
 * — the structural exclusions (media kinds without `caseWrite`,
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
			ctx: ToolInvocationContext,
		): Promise<{ mutations: readonly Mutation[] }>;
	},
	rawInput: unknown,
	host: CanonicalMutationHost,
	doc: BlueprintDoc,
): Promise<BlueprintDoc> {
	const parsed = tool.inputSchema.safeParse(rawInput);
	if (!parsed.success) return doc;
	/* One single-shot canonical workspace per op over the threaded doc — the
	 * tool commits (the workspace adopts the committed doc) or refuses (the
	 * workspace stays on the input doc); either way the workspace's current
	 * snapshot IS the post-op state the driver threads forward. */
	const workspace = new CanonicalMutationWorkspace({ host, initialDoc: doc });
	const out = await workspace.invoke({
		toolName: "fuzz-op",
		execute: (ctx) => tool.execute(parsed.data, ctx),
	});
	if (out.mutations.length > 0) {
		expect(isAdmittedMutationBatch(out.mutations)).toBe(true);
	}
	return workspace.currentSnapshot().doc;
}

/** The standard registration-unit field pair: the case_name writer plus a
 *  second property writer (a registration form must capture something
 *  about its new case beyond the name). */
function registrationUnitFields(caseType: string): FieldItem[] {
	return [
		{
			kind: "text",
			id: "case_name",
			label: proseText("Name"),
			caseWrite: { caseType, property: "case_name" },
		},
		{
			kind: "text",
			id: "village",
			label: proseText("Village"),
			caseWrite: { caseType, property: "village" },
		},
	];
}

/** Apply one fuzz op through the REAL tool (schema first — see
 *  {@link runParsed}). The tool either commits (and returns the new doc)
 *  or refuses at the schema/gate (and returns the old doc) — all are
 *  legitimate outcomes; the invariant below judges the doc, not the op. */
async function applyOp(
	doc: BlueprintDoc,
	ctx: CanonicalMutationHost,
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
						caseTypes: [
							{
								name: coherentType,
								properties: [
									{ name: "case_name", label: proseText("Name") },
									{ name: "village", label: proseText("Village") },
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
			const moduleUuid = moduleUuidAt(doc, op.moduleIndex);
			const moduleType = doc.modules[moduleUuid]?.caseType;
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
					moduleUuid,
					name: op.name,
					type: op.formType,
					fields,
				},
				ctx,
				doc,
			);
		}
		case "addFields": {
			const address = formAddressAt(doc, op.moduleIndex, op.formIndex);
			return runParsed(
				addFieldsTool,
				{
					...address,
					fields: resolveOwnCaseBindings(
						op.fields,
						doc.modules[address.moduleUuid]?.caseType,
					),
				},
				ctx,
				doc,
			);
		}
		case "editField": {
			const fieldUuid = pickFieldUuid(
				doc,
				op.moduleIndex,
				op.formIndex,
				op.fieldPick,
			);
			if (!fieldUuid) return doc;
			const target = doc.fields[fieldUuid];
			const address = formAddressAt(doc, op.moduleIndex, op.formIndex);
			// The kind the patch is validated against — the conversion
			// target when the op carries one (the tool refuses targets
			// outside the source's `convertTargets`; a refusal is a
			// legitimate outcome), else the current kind (edit in place).
			const effectiveKind = op.convertTo ?? target?.kind ?? "text";
			return runParsed(
				editFieldTool,
				{
					...address,
					fieldUuid,
					updates: {
						kind: effectiveKind,
						// A select conversion must bring its options; a hidden
						// conversion must bring a value source. Both harmless
						// on refused conversions (nothing persists).
						...(op.convertTo === "single_select" && {
							optionsSource: {
								kind: "inline",
								options: [
									{
										value: "opt_a",
										label: proseText("Option A"),
									},
									{
										value: "opt_b",
										label: proseText("Option B"),
									},
								],
							},
						}),
						...(op.convertTo === "hidden" && {
							calculate: { parts: [{ kind: "text", text: "1 + 1" }] },
						}),
						...(op.newId !== undefined && { id: op.newId }),
						...(op.relevant !== undefined &&
							effectiveKind !== "hidden" && {
								relevant: {
									parts: [{ kind: "text", text: op.relevant }],
								},
							}),
						...(op.label !== undefined &&
							effectiveKind !== "hidden" && {
								label: proseText(op.label),
							}),
					},
				},
				ctx,
				doc,
			);
		}
		case "moveField": {
			/* Both picks resolve against the form's top level (the same pool
			 * `editField` / `removeField` draw from) — colliding picks
			 * exercise the self-anchor refusal, an "into" side naming a leaf
			 * exercises the non-container refusal, and a group picked into
			 * its own anchor exercises the own-subtree guard. All legitimate
			 * outcomes; the invariant judges the doc. */
			const fieldUuid = pickFieldUuid(
				doc,
				op.moduleIndex,
				op.formIndex,
				op.fieldPick,
			);
			if (!fieldUuid) return doc;
			const anchorUuid = pickFieldUuid(
				doc,
				op.moduleIndex,
				op.formIndex,
				op.anchorPick,
			);
			const address = formAddressAt(doc, op.moduleIndex, op.formIndex);
			const placement =
				op.side === "top" || anchorUuid === undefined
					? { parentUuid: null }
					: op.side === "into"
						? { parentUuid: anchorUuid }
						: op.side === "before"
							? { beforeFieldUuid: anchorUuid }
							: { afterFieldUuid: anchorUuid };
			return runParsed(
				moveFieldTool,
				{
					...address,
					fieldUuid,
					...placement,
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
			const fieldUuid =
				op.closeField === "ghost"
					? testUuid("construction-fuzz-ghost-close-field")
					: (pickFieldUuid(doc, moduleIndex, formIndex, op.fieldPick) ??
						testUuid(`construction-fuzz-close-${op.closeField}`));
			const address = formAddressAt(doc, moduleIndex, formIndex);
			return runParsed(
				updateFormTool,
				{
					...address,
					close_condition: { fieldUuid, answer: op.closeAnswer },
				},
				ctx,
				doc,
			);
		}
		case "updateModule": {
			const moduleUuid = moduleUuidAt(doc, op.moduleIndex);
			const caseType =
				op.caseType === "__own__"
					? doc.modules[moduleUuid]?.caseType
					: op.caseType;
			return runParsed(
				updateModuleTool,
				{
					moduleUuid,
					...(caseType && { case_type: caseType }),
				},
				ctx,
				doc,
			);
		}
		case "removeField": {
			const fieldUuid = pickFieldUuid(
				doc,
				op.moduleIndex,
				op.formIndex,
				op.fieldPick,
			);
			if (!fieldUuid) return doc;
			return runParsed(
				removeFieldTool,
				{
					...formAddressAt(doc, op.moduleIndex, op.formIndex),
					fieldUuid,
				},
				ctx,
				doc,
			);
		}
		case "removeForm":
			return runParsed(
				removeFormTool,
				formAddressAt(doc, op.moduleIndex, op.formIndex),
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
				{ moduleUuid: moduleUuidAt(doc, op.moduleIndex) },
				ctx,
				doc,
			);
		case "addCaseListColumns":
			return runParsed(
				addCaseListColumnsTool,
				{
					moduleUuid: moduleUuidAt(doc, op.moduleIndex),
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
					moduleUuid: moduleUuidAt(doc, op.moduleIndex),
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
				{ moduleUuid: moduleUuidAt(doc, op.moduleIndex), columnUuid },
				ctx,
				doc,
			);
		}
		case "reorderCaseListColumns": {
			/* Reversal of the live uuid set — always a complete permutation,
			 * so the op exercises the reorder commit rather than the
			 * unknown/missing-uuid input rejections. */
			const columns = (
				caseListConfigAt(doc, op.moduleIndex)?.columns ?? []
			).filter((column) =>
				op.surface === "results"
					? column.visibleInList !== false
					: column.visibleInDetail !== false,
			);
			if (columns.length === 0) return doc;
			return runParsed(
				reorderCaseListColumnsTool,
				{
					moduleUuid: moduleUuidAt(doc, op.moduleIndex),
					surface: op.surface,
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
				doc.modules[moduleUuidAt(doc, op.moduleIndex)]?.caseType ?? "patient";
			return runParsed(
				setCaseListFilterTool,
				{
					moduleUuid: moduleUuidAt(doc, op.moduleIndex),
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
					moduleUuid: moduleUuidAt(doc, op.moduleIndex),
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
					moduleUuid: moduleUuidAt(doc, op.moduleIndex),
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
				{
					moduleUuid: moduleUuidAt(doc, op.moduleIndex),
					searchInputUuid,
				},
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
					moduleUuid: moduleUuidAt(doc, op.moduleIndex),
					searchInputUuids: inputs.map((i) => i.uuid).reverse(),
				},
				ctx,
				doc,
			);
		}
	}
}

/** The invariant: every born or tool-grown doc has NO findings. */
function assertZeroFindings(doc: BlueprintDoc, context: string): void {
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
		(e) => `${e.code}: ${e.message}`,
	);
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
 * atomic creations, the retirement cascade's granular catalog batch,
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
 * The option-identity invariant. A doc grown from birth purely through the
 * tools has every select option UUID required by the final domain schema. This
 * extra assertion fails LOUDLY at the construction site if a tool ever tries
 * to bypass that schema.
 *
 * Sequence needs no equivalent check: it is the array the member sits in, so
 * a member that exists is a member that is placed.
 */
function assertEveryOptionIdentified(doc: BlueprintDoc, context: string): void {
	const missing: string[] = [];
	for (const field of Object.values(doc.fields)) {
		if (!("optionsSource" in field) || field.optionsSource.kind !== "inline") {
			continue;
		}
		field.optionsSource.options.forEach((option, index) => {
			if (typeof option.uuid !== "string") {
				missing.push(`option #${index} on field "${field.id}"`);
			}
		});
	}
	if (missing.length > 0) {
		throw new Error(
			`a tool-grown doc has an option with no uuid (${context}): ${missing.join("; ")}`,
		);
	}
}

// ── Preludes — the fixture state, GROWN through the real tools ──────────
//
// Each property starts from canonical genesis and builds its baseline with
// real accepted calls, so the invariant covers the doc's whole persisted life:
// the starter is refined into one patient module
// carrying a registration unit AND a standing close-type form (a close
// condition can only commit on one — without it, the close op's commits
// would depend on the sequence first creating a close form, starving the
// acceptance floor below). The same standing-target rationale gives the
// prelude module a SECOND case-list column and one search input (grown
// through the real config tools): the update/remove/reorder config ops
// always have an addressable entry from op #0, instead of depending on
// the sequence first landing an add.

async function growStandardPrelude(
	ctx: CanonicalMutationHost,
): Promise<BlueprintDoc> {
	let doc = birthDoc();
	const starterModuleUuid = doc.moduleOrder[0];
	/* Canonical genesis already authored the real app name and starter. The
	 * data-model tool writes the case-type record, then a module references it
	 * by name. Once that replacement exists, removing the starter is itself an
	 * ordinary gated refinement — no empty intermediate state is possible. */
	doc = await runParsed(
		generateSchemaTool,
		{
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
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
							label: proseText("Notes"),
							caseWrite: { caseType: "patient", property: "notes" },
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
							label: proseText("Closure reason"),
							caseWrite: {
								caseType: "patient",
								property: "closure_reason",
							},
						},
					],
				},
			],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		removeModuleTool,
		{ moduleUuid: starterModuleUuid },
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
					fields: [
						{ kind: "text", id: "comments", label: proseText("Comments") },
					],
				},
			],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		addCaseListColumnsTool,
		{
			moduleUuid: doc.moduleOrder[0],
			columns: [{ kind: "plain", field: "village", header: "Village" }],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		addSearchInputsTool,
		{
			moduleUuid: doc.moduleOrder[0],
			searchInputs: [
				{
					kind: "simple",
					name: "by_name",
					label: "Name",
					type: "text",
					property: "case_name",
				},
				{
					kind: "simple",
					name: "by_village",
					label: "Village",
					type: "text",
					property: "village",
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
	ctx: CanonicalMutationHost,
): Promise<BlueprintDoc> {
	let doc = birthDoc("Fuzz Training");
	const starterModuleUuid = doc.moduleOrder[0];
	/* Connect is not a mode flag with independently authored form blocks.
	 * Grow the ordinary target topology first; once every participating form
	 * has a stable UUID, configureConnect installs the complete app-wide
	 * target in one gated batch and clears anything unlisted. */
	doc = await runParsed(
		generateSchemaTool,
		{
			caseTypes: [
				{
					name: "trainee",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
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
			name: "Lessons",
			case_type: "trainee",
			case_list_columns: [
				{ kind: "plain", field: "case_name", header: "Name" },
			],
			forms: [
				{
					name: "Enroll trainee",
					type: "registration",
					/* Third writer = standing removeField target — see the
					 * standard prelude. */
					fields: [
						...registrationUnitFields("trainee"),
						{
							kind: "text",
							id: "notes",
							label: proseText("Notes"),
							caseWrite: { caseType: "trainee", property: "notes" },
						},
					],
				},
				{
					name: "Close enrollment",
					type: "close",
					fields: [
						{
							kind: "text",
							id: "closure_reason",
							label: proseText("Closure reason"),
							caseWrite: {
								caseType: "trainee",
								property: "closure_reason",
							},
						},
					],
				},
			],
		},
		ctx,
		doc,
	);
	const lessonsModuleUuid = doc.moduleOrder.find(
		(uuid) => doc.modules[uuid]?.name === "Lessons",
	);
	if (!lessonsModuleUuid) throw new Error("Connect prelude lost Lessons");
	doc = await runParsed(
		removeModuleTool,
		{ moduleUuid: starterModuleUuid },
		ctx,
		doc,
	);
	/* This form is deliberately absent from configureConnect's target and is
	 * therefore auxiliary. The exact-target call below proves that a mixed
	 * participating + auxiliary app is a legal committed state. */
	doc = await runParsed(
		createFormTool,
		{
			moduleUuid: lessonsModuleUuid,
			name: "Reference sheet",
			type: "survey",
			fields: [{ kind: "text", id: "tips", label: proseText("Tips") }],
		},
		ctx,
		doc,
	);
	expect(
		doc.formOrder[lessonsModuleUuid],
		"the blockless auxiliary form must exist before the exact Connect target lands",
	).toHaveLength(3);
	/* Standing removeModule target — see the standard prelude. Its form
	 * participates after the exact-target call, so removing the module is a
	 * legal commit whenever the Lessons module still participates. */
	doc = await runParsed(
		createModuleTool,
		{
			name: "Feedback",
			forms: [
				{
					name: "Feedback survey",
					type: "survey",
					fields: [
						{ kind: "text", id: "comments", label: proseText("Comments") },
					],
				},
			],
		},
		ctx,
		doc,
	);
	const feedbackModuleUuid = doc.moduleOrder.find(
		(uuid) => doc.modules[uuid]?.name === "Feedback",
	);
	if (!feedbackModuleUuid) throw new Error("Connect prelude lost Feedback");
	const enrollFormUuid = doc.formOrder[lessonsModuleUuid]?.find(
		(uuid) => doc.forms[uuid]?.name === "Enroll trainee",
	);
	const closeFormUuid = doc.formOrder[lessonsModuleUuid]?.find(
		(uuid) => doc.forms[uuid]?.name === "Close enrollment",
	);
	const feedbackFormUuid = doc.formOrder[feedbackModuleUuid]?.find(
		(uuid) => doc.forms[uuid]?.name === "Feedback survey",
	);
	if (!enrollFormUuid || !closeFormUuid || !feedbackFormUuid) {
		throw new Error("Connect prelude lost a participating form");
	}
	doc = await runParsed(
		configureConnectTool,
		{
			mode: "learn",
			participants: [
				{
					formUuid: enrollFormUuid,
					connect: {
						learn_module: {
							id: "enroll_module",
							name: "Enrollment",
							description: "Sign-up basics",
							time_estimate: 10,
						},
					},
				},
				{
					formUuid: closeFormUuid,
					connect: {
						learn_module: {
							id: "closeout_module",
							name: "Closeout",
							description: "Wrapping up",
							time_estimate: 5,
						},
					},
				},
				{
					formUuid: feedbackFormUuid,
					connect: {
						learn_module: {
							id: "feedback_module",
							name: "Feedback",
							description: "Course feedback",
							time_estimate: 5,
						},
					},
				},
			],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		addCaseListColumnsTool,
		{
			moduleUuid: doc.moduleOrder[0],
			columns: [{ kind: "plain", field: "village", header: "Village" }],
		},
		ctx,
		doc,
	);
	doc = await runParsed(
		addSearchInputsTool,
		{
			moduleUuid: doc.moduleOrder[0],
			searchInputs: [
				{
					kind: "simple",
					name: "by_name",
					label: "Name",
					type: "text",
					property: "case_name",
				},
				{
					kind: "simple",
					name: "by_village",
					label: "Village",
					type: "text",
					property: "village",
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
	"moveField",
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

// ── Retirement-arm occurrence tallies ───────────────────────────────────
//
// The acceptance floor above proves each op TYPE commits, but a
// `removeModule` commit can be the caseless prelude module — never
// touching the retirement machinery. These tallies classify each
// module-displacing op's outcome so the run can assert the three
// retirement arms each actually OCCURRED (≥1 each, occurrence assertions
// under the pinned seed — not per-run floors): the cascade committed (the
// catalog shrank through the cascade on this op pool), the planner blocked a
// displacement over live
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

/* NOT `describe.concurrent`. The two properties share module-level state —
 * run concurrently, the standard-app property fails at run 53 on a
 * `removeCaseListColumn` counterexample that passes sequentially. Splitting
 * them into separate files would isolate that, but both would then import this
 * file's ~1,690 lines of scaffolding, and import already dominates this
 * suite's wall clock. Sequential with a real timeout is the cheaper answer. */
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
					const beforeStandingAdd = doc;
					doc = await runParsed(
						addFieldsTool,
						{
							...formAddressAt(doc, 0, 0),
							fields: [
								{
									fieldUuid: testUuid(
										"construction-fuzz-standard-standing-add",
									),
									kind: "text",
									id: "standing_extra",
									label: proseText("Standing extra"),
								},
							],
						},
						ctx,
						doc,
					);
					if (doc !== beforeStandingAdd) {
						tally.set("addFields", (tally.get("addFields") ?? 0) + 1);
					}
					assertZeroFindings(doc, "standard prelude");
					assertIndexParity(doc, "standard prelude");
					assertPersistedShapeParses(doc, "standard prelude");
					assertEveryOptionIdentified(doc, "standard prelude");
					for (const [i, op] of ops.entries()) {
						const next = await applyOp(doc, ctx, op);
						const committed = next !== doc;
						if (committed) tally.set(op.type, (tally.get(op.type) ?? 0) + 1);
						tallyRetirementArms(retirementArms, doc, next, op, committed);
						doc = next;
						assertZeroFindings(doc, `standard op#${i} ${op.type}`);
						assertIndexParity(doc, `standard op#${i} ${op.type}`);
						assertPersistedShapeParses(doc, `standard op#${i} ${op.type}`);
						assertEveryOptionIdentified(doc, `standard op#${i} ${op.type}`);
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
	}, 30_000);

	it("Connect learn app: auxiliary structural creations hold the same invariant", async () => {
		const tally = newCommitTally();
		/* `growConnectPrelude` proves the exact participant-set tool can enable
		 * a mixed participating + auxiliary app. Every generated structural
		 * creation after that is necessarily auxiliary; the commit floor proves
		 * those createForm/createModule paths remain live on a Connect app. */
		await fc.assert(
			fc.asyncProperty(
				fc.array(opArb, { minLength: 1, maxLength: 14 }),
				async (ops) => {
					const ctx = makeCtx();
					let doc = await growConnectPrelude(ctx);
					const beforeStandingAdd = doc;
					doc = await runParsed(
						addFieldsTool,
						{
							...formAddressAt(doc, 0, 0),
							fields: [
								{
									fieldUuid: testUuid("construction-fuzz-connect-standing-add"),
									kind: "text",
									id: "standing_extra",
									label: proseText("Standing extra"),
								},
							],
						},
						ctx,
						doc,
					);
					if (doc !== beforeStandingAdd) {
						tally.set("addFields", (tally.get("addFields") ?? 0) + 1);
					}
					assertZeroFindings(doc, "connect prelude");
					assertIndexParity(doc, "connect prelude");
					assertPersistedShapeParses(doc, "connect prelude");
					assertEveryOptionIdentified(doc, "connect prelude");
					for (const [i, op] of ops.entries()) {
						const next = await applyOp(doc, ctx, op);
						if (next !== doc) {
							tally.set(op.type, (tally.get(op.type) ?? 0) + 1);
						}
						doc = next;
						assertZeroFindings(doc, `connect op#${i} ${op.type}`);
						assertIndexParity(doc, `connect op#${i} ${op.type}`);
						assertPersistedShapeParses(doc, `connect op#${i} ${op.type}`);
						assertEveryOptionIdentified(doc, `connect op#${i} ${op.type}`);
					}
				},
			),
			{ numRuns: 45, seed: 20260610 },
		);
		assertCommitFloor(tally, "connect run");
	}, 30_000);
});
