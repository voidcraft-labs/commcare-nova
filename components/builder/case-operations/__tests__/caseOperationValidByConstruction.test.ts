// components/builder/case-operations/__tests__/caseOperationValidByConstruction.test.ts
//
// The case-operation surface's headline invariant, stated once so the
// whole class of "the editor offers what the commit gate refuses" is
// unreachable rather than fixed three times.
//
// The shared editor already proves admission ⟺ type checker
// (`shared/__tests__/validByConstruction.test.ts`) and that every
// admitted verb build type-checks (`verbMenuBuildFuzz.test.ts`). Neither
// can see this surface's extra law: `rules/caseOperations.ts` refuses
// reads and shapes the TYPE CHECKER is perfectly happy with:
//
//   - a case property / relationship count / presence test in ANY slot
//     unless that exact form opens with a session case, and
//   - an `id-of` anywhere inside a RUNTIME TARGET tree, in the operation's
//     own target and in a link's alike.
//
// So the oracle here is the validator rule itself, driven over registration,
// case-first follow-up, and mixed-module follow-up forms and EVERY slot the
// detail canvas mounts. The
// editor's own admission functions choose the candidates: the Add-condition
// menu's own items, the verb menu's builds, the expression kind menu's
// seeds, and the canvas's own committed seeds. Nothing is re-derived, a
// candidate the editor would not offer is skipped by the editor's own
// predicate, so the test can only fail on a genuine offer-then-reject.
//
// Candidates are what the menus OFFER, not what the schema registry can
// build. Driving every authorable schema's seed looked stricter and was
// merely wrong: `match` and `within-distance` have no Add-condition item:
// they are verb switches on an existing condition, and their registry
// seeds are deliberately incomplete, so asserting them tested a path no
// author can take.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import {
	STRUCTURE_ENTRIES,
	subjectOf,
	VERB_ENTRIES,
	verbEntryAdmitted,
} from "@/components/builder/shared/cards/PredicateVerbMenu";
import {
	caseDataScopeAdmission,
	type PredicateEditContext,
	predicateCardSchemas,
} from "@/components/builder/shared/editorSchemas";
import { buildEditorTypeContext } from "@/components/builder/shared/editorTypeContext";
import {
	type ExpressionEditContext,
	expressionCardSchemaList,
	isAuthorableExpressionKind,
} from "@/components/builder/shared/expressionEditorSchemas";
import {
	buildStructure,
	STRUCTURE_KINDS,
} from "@/components/builder/shared/PredicateWorkbench";
import { defaultExpressionForSlot } from "@/components/builder/shared/primitives/ExpressionPicker";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { validateCaseOperations } from "@/lib/commcare/validator/rules/caseOperations";
import { formFieldEntriesFor } from "@/lib/doc/formFieldEntries";
import { isReservedCaseOperationProperty } from "@/lib/doc/identifierVerdicts";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	effectiveCaseTypes,
	type Form,
	isCaseFirstModule,
	type UserProperty,
	type Uuid,
} from "@/lib/domain";
import {
	actingUser,
	admitsValueExpressionKind,
	type CheckError,
	checkExpression,
	checkPredicate,
	checkValueExpression,
	dateLiteral,
	eq,
	literal,
	type Predicate,
	type ResolvedType,
	type SlotConstraint,
	storageAssignmentConstraint,
	type TypeContext,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	caseOperationRuntimeTargetConstraint,
	caseOperationTextConstraint,
	operationCaseDataScope,
	RUNTIME_TARGET_OPERATION_SCOPE,
} from "../editorScope";
import { operationFormFieldDecls } from "../formFieldScope";
import {
	seedCaseOperationWrite,
	seedRenameValue,
	seedWriteValue,
} from "../seeds";

const CREATE = testUuid("11111111-1111-4111-8111-111111111111");
const SUBJECT = testUuid("22222222-2222-4222-8222-222222222222");
const TEXT = testUuid("33333333-3333-4333-8333-333333333333");
const NUMBER = testUuid("44444444-4444-4444-8444-444444444444");
const WHEN = testUuid("55555555-5555-4555-8555-555555555555");
const CHOICES = testUuid("66666666-6666-4666-8666-666666666666");
const WORKER_PROPERTY = testUuid("77777777-7777-4777-8777-777777777777");

const WORKER: UserProperty = {
	uuid: WORKER_PROPERTY,
	slug: "district",
	label: "District",
};

/**
 * One module, one case type, and every answer shape an operation might
 * read. The module's form TYPE is the whole variable: a module holding
 * only case-loading forms is case-first, and one holding a registration
 * form is not, which is exactly the axis `validateCaseSnapshotUse`
 * branches on.
 */
type FixtureKind = "case-first-followup" | "mixed-followup" | "registration";

function fixture(kind: FixtureKind): {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly caseFirst: boolean;
	readonly sessionCaseAvailable: boolean;
	readonly kind: FixtureKind;
} {
	const formType: Form["type"] =
		kind === "registration" ? "registration" : "followup";
	const forms: Array<{
		name: string;
		type: Form["type"];
		fields: Array<ReturnType<typeof f>>;
	}> = [
		...(kind === "mixed-followup"
			? [
					{
						name: "Register",
						type: "registration" as const,
						fields: [],
					},
				]
			: []),
		{
			name: "Visit",
			type: formType,
			fields: [
				f({
					uuid: SUBJECT,
					kind: "text",
					id: "subject",
					label: proseText("Subject"),
				}),
				f({
					uuid: TEXT,
					kind: "text",
					id: "note",
					label: proseText("Note"),
				}),
				f({
					uuid: NUMBER,
					kind: "int",
					id: "rating",
					label: proseText("Rating"),
				}),
				f({
					uuid: WHEN,
					kind: "date",
					id: "held_on",
					label: proseText("Held on"),
				}),
				f({
					uuid: CHOICES,
					kind: "multi_select",
					id: "choices",
					label: proseText("Choices"),
					options: [
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					],
				}),
			],
		},
	];
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "nickname", label: proseText("Nickname"), data_type: "text" },
					{ name: "score", label: proseText("Score"), data_type: "int" },
					{ name: "seen_on", label: proseText("Seen on"), data_type: "date" },
					{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
					{ name: "place", label: proseText("Place"), data_type: "geopoint" },
				],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [
					{ name: "note", label: proseText("Note"), data_type: "text" },
					{ name: "rating", label: proseText("Rating"), data_type: "int" },
					{ name: "held_on", label: proseText("Held on"), data_type: "date" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms,
			},
		],
	});
	const mutableDoc = doc as { userProperties?: Record<string, UserProperty> };
	mutableDoc.userProperties = { [WORKER_PROPERTY]: WORKER };
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][forms.length - 1];
	return {
		doc,
		moduleUuid,
		formUuid,
		caseFirst: isCaseFirstModule(
			forms.map((form) => form.type),
			true,
		),
		sessionCaseAvailable: CASE_LOADING_FORM_TYPES.has(formType),
		kind,
	};
}

/**
 * The vocabulary the detail canvas mounts every slot with: assembled
 * from the SAME functions the canvas calls, so a change to either the
 * canvas or the scope rule moves this test with it.
 */
function editorVocabulary(shape: ReturnType<typeof fixture>) {
	const entries = formFieldEntriesFor(shape.doc, shape.formUuid);
	return {
		caseTypes: effectiveCaseTypes(shape.doc),
		currentCaseType: shape.doc.modules[shape.moduleUuid]?.caseType ?? "",
		knownInputs: [],
		userProperties: [WORKER],
		formFields: operationFormFieldDecls(entries, undefined),
		operationScope: { creates: [{ uuid: CREATE, label: "create_visit" }] },
		caseDataScope: operationCaseDataScope(shape.sessionCaseAvailable),
	} as const;
}

/** The prior create every fixture carries, so `id-of` is genuinely on
 *  offer in the slots that admit it and genuinely withheld where it is
 *  not. */
function priorCreate(): CaseOperation {
	return {
		uuid: CREATE,
		id: "create_visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term(literal("Visit")),
	};
}

/**
 * The operation under test. It targets the earlier create rather than
 * the session so the BASELINE is valid in both module shapes, a session
 * target is itself unavailable without a case-first module, and that
 * refusal would mask every finding this test is looking for.
 */
function subjectOperation(patch: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: SUBJECT,
		id: "update_visit",
		action: "update",
		caseType: "visit",
		target: { kind: "op", opUuid: CREATE },
		...patch,
	};
}

/** Every finding the commit gate would report for this operation. */
function gateFindings(
	shape: ReturnType<typeof fixture>,
	operation: CaseOperation,
): readonly string[] {
	const built = fixture(shape.kind);
	(built.doc.forms[built.formUuid] as Form).caseOperations = [
		priorCreate(),
		operation,
	];
	return validateCaseOperations(
		built.doc,
		built.formUuid,
		built.moduleUuid,
	).map((error) => `${error.code}: ${error.message}`);
}

/**
 * The one COMPLETENESS state the shared editor deliberately leaves for
 * the author to fill: an unpicked property. It is decided against the
 * EDITOR's own type context, so a candidate is skipped only when the
 * editor itself knows it is unfinished, never because the gate happened
 * to disagree.
 *
 * `match-value-empty` used to be tolerated here too, and that tolerance
 * is exactly why the test built to catch offer-then-refuse missed an
 * empty match value on its own surface. Nothing unfinished may be
 * committed: the gate has no tolerant class, `gate.ts` gates
 * completeness like soundness, so the editor must not OFFER a gesture
 * that lands one. The verb menu now disables a switch to `match` until
 * something carryable exists, which is what makes dropping this safe.
 */
function isCompletenessOnly(errors: readonly CheckError[]): boolean {
	return errors.every((error) => error.code === "unknown-property");
}

function unfinished(
	candidate: Predicate | ValueExpression,
	typeCtx: TypeContext,
	isPredicate: boolean,
): boolean {
	const result = isPredicate
		? checkPredicate(candidate as Predicate, typeCtx)
		: checkValueExpression(candidate as ValueExpression, typeCtx);
	return !result.ok && isCompletenessOnly(result.errors);
}

// ── The slots ──────────────────────────────────────────────────────────

interface PredicateSlot {
	readonly name: string;
	readonly place: (candidate: Predicate) => CaseOperation;
}

interface ExpressionSlot {
	readonly name: string;
	readonly constraint: SlotConstraint;
	/** A runtime target mounts a DIFFERENT operation scope from every
	 *  other slot: see `editorScope.ts`. */
	readonly runtimeTarget: boolean;
	/**
	 * Whether the editor mounts the owner-value axis on this slot. It governs
	 * `acting-user` and `unowned`, and nothing else does, so it has to be
	 * part of the slot table or the one slot those sentinels live on is driven
	 * with the opposite of what the canvas mounts
	 * (`CaseOperationDetailCanvas.tsx:441`) and never exercised at all.
	 */
	readonly ownerValues: boolean;
	/**
	 * A name / rename / owner slot, where `validateTextExpression` refuses a
	 * BLANK literal on top of the type rule: a constraint `SlotConstraint`
	 * has no axis for, so the picker's typed literal seed is an empty string
	 * there. That is a COMPLETENESS state ("type the name") of exactly the
	 * kind the editor leaves elsewhere, and the gate spells it that way; it
	 * is tolerated below by the same structural test the validator applies
	 * (a literal directly in the slot), so nothing about scope or `id-of`
	 * can hide behind it.
	 */
	readonly place: (candidate: ValueExpression) => CaseOperation;
}

const PREDICATE_SLOTS: readonly PredicateSlot[] = [
	{
		name: "when this runs",
		place: (condition) => subjectOperation({ condition }),
	},
	{
		name: "when a write is saved",
		place: (condition) =>
			subjectOperation({
				writes: [{ property: "note", value: term(literal("x")), condition }],
			}),
	},
];

const TEXT_STORAGE = storageAssignmentConstraint(["text"]);
/** What the three text facets actually mount with: the blank-refusing
 *  constraint, so this drives the real offered set. */
const TEXT_FACET = caseOperationTextConstraint();

const EXPRESSION_SLOTS: readonly ExpressionSlot[] = [
	{
		name: "which case to change",
		constraint: caseOperationRuntimeTargetConstraint(),
		runtimeTarget: true,
		ownerValues: false,
		place: (expr) => subjectOperation({ target: { kind: "expression", expr } }),
	},
	{
		name: "a link's runtime target",
		constraint: caseOperationRuntimeTargetConstraint(),
		runtimeTarget: true,
		ownerValues: false,
		place: (expr) =>
			subjectOperation({
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: { kind: "expression", expr },
						relationship: "child",
					},
				],
			}),
	},
	{
		name: "the case's name",
		constraint: TEXT_FACET,
		runtimeTarget: false,
		ownerValues: false,
		place: (name) =>
			subjectOperation({
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name,
			}),
	},
	{
		name: "give the case a new name",
		constraint: TEXT_FACET,
		runtimeTarget: false,
		ownerValues: false,
		place: (rename) => subjectOperation({ rename }),
	},
	{
		name: "who owns the case",
		constraint: TEXT_FACET,
		runtimeTarget: false,
		ownerValues: true,
		place: (owner) => subjectOperation({ owner }),
	},
	{
		name: "what it saves",
		constraint: TEXT_STORAGE,
		runtimeTarget: false,
		ownerValues: false,
		place: (value) =>
			subjectOperation({ writes: [{ property: "note", value }] }),
	},
];

const SHAPES = [
	{ label: "a case-first module", kind: "case-first-followup" as const },
	{
		label: "a follow-up form in a mixed forms-first module",
		kind: "mixed-followup" as const,
	},
	{
		label: "a registration form",
		kind: "registration" as const,
	},
];

// ── 0. The fixtures are what they claim, and the baseline is clean ─────

describe("case-operation fixtures", () => {
	it.each(SHAPES)(
		"$label has the navigation and form-session shape it claims",
		({ kind }) => {
			const shape = fixture(kind);
			expect(shape.caseFirst).toBe(kind === "case-first-followup");
			expect(shape.sessionCaseAvailable).toBe(kind !== "registration");
			// Any finding below is caused by the injected candidate, never by
			// the surrounding operations.
			expect(gateFindings(shape, subjectOperation())).toEqual([]);
		},
	);
});

// ── 1. Predicate slots ─────────────────────────────────────────────────

describe("every condition the editor offers is admitted by the commit gate", () => {
	it.each(SHAPES)("$label", ({ kind }) => {
		const shape = fixture(kind);
		const vocabulary = editorVocabulary(shape);
		const editCtx: PredicateEditContext = vocabulary;
		const typeCtx = buildEditorTypeContext(vocabulary);

		// Representative CURRENTs an author can already be looking at, so the
		// verb menu is driven from real starting points rather than one.
		const currents: Predicate[] = [
			firstComparisonDefault(editCtx),
			eq(term(literal("a")), term(literal("a"))),
			...(shape.sessionCaseAvailable
				? [
						eq(
							{
								kind: "term",
								term: { kind: "prop", caseType: "patient", property: "score" },
							},
							term(literal(5)),
						) as Predicate,
					]
				: []),
			eq(term({ kind: "field", uuid: NUMBER }), term(literal(5))),
			eq(term({ kind: "field", uuid: WHEN }), term(dateLiteral("2024-01-01"))),
		];

		// Exactly what "Add condition" offers: one comparison leaf plus the
		// structural shapes. Driving the whole schema registry instead
		// asserted a path the menu has no item for: `match` and
		// `within-distance` are reachable only as VERB switches on an
		// existing condition, and their registry seeds are deliberately
		// incomplete (a match against an empty value matches nothing).
		const candidates: { readonly why: string; readonly value: Predicate }[] = [
			{
				why: "Add condition → Compare case information",
				value: firstComparisonDefault(editCtx),
			},
		];
		for (const kind of STRUCTURE_KINDS) {
			if (!predicateCardSchemas[kind].applicable(editCtx)) continue;
			candidates.push({
				why: `Add condition → ${kind}`,
				value: buildStructure(kind, editCtx),
			});
		}
		for (const current of currents) {
			const subject = subjectOf(current);
			const subjectType: ResolvedType | undefined =
				subject === undefined
					? undefined
					: checkExpression(subject, typeCtx, [], []);
			for (const entry of [...VERB_ENTRIES, ...STRUCTURE_ENTRIES]) {
				if (!verbEntryAdmitted(entry, current, subjectType, editCtx)) continue;
				candidates.push({
					why: `verb "${entry.id}" from ${current.kind}`,
					value: entry.build(current, editCtx),
				});
			}
		}

		for (const slot of PREDICATE_SLOTS) {
			for (const candidate of candidates) {
				if (unfinished(candidate.value, typeCtx, true)) continue;
				expect(
					gateFindings(shape, slot.place(candidate.value)),
					`${slot.name}: ${candidate.why}`,
				).toEqual([]);
			}
		}
	});
});

// ── 2. Expression slots ────────────────────────────────────────────────

describe("every value the editor offers is admitted by the commit gate", () => {
	it.each(SHAPES)("$label", ({ kind }) => {
		const shape = fixture(kind);
		const vocabulary = editorVocabulary(shape);
		const _typeCtx = buildEditorTypeContext(vocabulary);

		for (const slot of EXPRESSION_SLOTS) {
			const scope = slot.runtimeTarget
				? RUNTIME_TARGET_OPERATION_SCOPE
				: vocabulary.operationScope;
			const editCtx: ExpressionEditContext = {
				...vocabulary,
				operationScope: scope,
				ownerValues: slot.ownerValues,
			};
			const slotTypeCtx = buildEditorTypeContext({
				...vocabulary,
				operationScope: scope,
				ownerValues: slot.ownerValues,
			});
			for (const schema of expressionCardSchemaList) {
				if (!isAuthorableExpressionKind(schema.kind, editCtx)) continue;
				// The picker's own type gate: a kind whose result class cannot
				// satisfy the slot is disabled, never selectable.
				if (!admitsValueExpressionKind(schema.kind, slot.constraint).admitted) {
					continue;
				}
				const candidate = defaultExpressionForSlot(
					schema,
					editCtx,
					slot.constraint,
					"value",
				);
				// The provider composes this oracle in front of every kind menu,
				// so a candidate it refuses is never selectable.
				if (
					!caseDataScopeAdmission(vocabulary.caseDataScope, candidate).admitted
				) {
					continue;
				}
				if (unfinished(candidate, slotTypeCtx, false)) continue;
				expect(
					gateFindings(shape, slot.place(candidate)),
					`${slot.name}: value kind "${schema.kind}"`,
				).toEqual([]);
			}
			// The type context a runtime-target slot resolves against must also
			// refuse `id-of` outright, so nothing can reach the gate by any
			// other route through that slot.
			if (slot.runtimeTarget) {
				expect(
					checkValueExpression({ kind: "id-of", opUuid: CREATE }, slotTypeCtx)
						.ok,
					`${slot.name} must not resolve an id-of`,
				).toBe(false);
			}
			// Everything else in the operation still offers it, or the scope
			// would have been dropped rather than shaped.
			if (!slot.runtimeTarget) {
				expect(
					checkValueExpression({ kind: "id-of", opUuid: CREATE }, slotTypeCtx)
						.ok,
				).toBe(true);
			}
			// The owner sentinels live on the owner slot and nowhere else: the
			// editor mounts `ownerValues` on exactly one section and the gate
			// passes it for exactly one facet, so the offered set and the
			// accepted set move together on that single axis.
			expect(checkValueExpression(actingUser(), slotTypeCtx).ok).toBe(
				slot.ownerValues,
			);
			expect(isAuthorableExpressionKind("acting-user", editCtx)).toBe(
				slot.ownerValues,
			);
			expect(isAuthorableExpressionKind("unowned", editCtx)).toBe(
				slot.ownerValues,
			);
			expect(isAuthorableExpressionKind("id-of", editCtx)).toBe(
				!slot.runtimeTarget,
			);
		}
	});
});

// ── 3. The canvas's own committed seeds ────────────────────────────────
//
// These commit the instant the author presses the button: there is no
// intermediate state for them to be merely unfinished in, so they are
// held to the whole gate with no tolerance at all.

describe("every seed the canvas commits is accepted outright", () => {
	it.each(SHAPES)("$label", ({ kind }) => {
		const shape = fixture(kind);
		const vocabulary = editorVocabulary(shape);
		const editCtx: PredicateEditContext = vocabulary;
		const entries = formFieldEntriesFor(shape.doc, shape.formUuid);
		const writeFields = operationFormFieldDecls(entries, undefined);

		// "Add a condition" on the operation, and on one of its writes.
		const condition = firstComparisonDefault(editCtx);
		expect(
			gateFindings(shape, subjectOperation({ condition })),
			"Add a condition",
		).toEqual([]);
		expect(
			gateFindings(
				shape,
				subjectOperation({
					writes: [{ property: "note", value: term(literal("x")), condition }],
				}),
			),
			"Only save this sometimes",
		).toEqual([]);

		// "Set a new name" and "Choose an owner".
		expect(
			gateFindings(
				shape,
				subjectOperation({ rename: seedRenameValue("visit", writeFields) }),
			),
			"Set a new name",
		).toEqual([]);
		expect(
			gateFindings(shape, subjectOperation({ owner: actingUser() })),
			"Choose an owner",
		).toEqual([]);

		// Every write the property picker can start, for every declared type
		// on the destination case type.
		const destination = effectiveCaseTypes(shape.doc).find(
			(caseType) => caseType.name === "visit",
		);
		for (const property of destination?.properties ?? []) {
			// The picker withholds the reserved properties: an operation's own
			// facets own them, so they are never a seed the canvas commits.
			if (isReservedCaseOperationProperty(property.name)) continue;
			const value = seedWriteValue(property.data_type, writeFields);
			if (value === undefined) continue;
			expect(
				gateFindings(
					shape,
					subjectOperation({
						writes: [seedCaseOperationWrite(property.name, value)],
					}),
				),
				`write seed for ${property.name}`,
			).toEqual([]);
		}
	});
});
