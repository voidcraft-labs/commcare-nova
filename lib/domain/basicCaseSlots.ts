// lib/domain/basicCaseSlots.ts
//
// Which case changes of a form take a slot of its Case Management settings
// (a basic slot): the own arm's slot, and the subcase slots of the creates.
// These are domain facts over the document, because what a form's entry
// supplies reads them: CommCare HQ gives a session value to the case a
// registration creates only where its own arm takes the basic slot, and to
// each basic subcase outside a repeat
// (`suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta`).
// `lib/commcare/placement.ts::planPlacements` builds every placement on this
// one answer, so the session values the checker admits and the datums the
// wire writes cannot disagree.
//
// A basic slot is eligible only where HQ's Case Management page would keep
// what the operation means: the page offers and saves the shapes
// `case_config_utils.js` reads, and HQ's build writes them as
// `xform.py::XForm._create_casexml` does.
//
// Pure, and memoized per document object (documents are replaced, never
// changed in place).

import type { BlueprintDoc } from "./blueprint";
import { caseWriteValueField } from "./caseWriteViews";
import { formConnectIds } from "./connectIds";
import type { Expression } from "./expression/types";
import { walkExpressionNodes } from "./expression/walk";
import { type Field, isCaptureField, isContainer } from "./fields";
import {
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	caseOperationRunsPerSelectedCase,
	type Form,
	orderedCaseOperations,
} from "./forms";
import {
	caseSelectionCardinality,
	type Module,
	moduleHasCaseListMenuItem,
} from "./modules";
import type {
	CasePlacement,
	PlacementIneligibility,
	PlacementIneligibilityReason,
	SaveToCasePlacement,
} from "./placements";
import type { Uuid } from "./uuid";

// ── The form's facts ────────────────────────────────────────────────────

/** HQ's Case Management condition offers these question kinds
 * (`case_config_utils.js::getQuestions('select select1')`, widened by
 * Hidden Values and labels). */
const STATEABLE_QUESTION_KINDS: ReadonlySet<string> = new Set([
	"single_select",
	"multi_select",
	"hidden",
	"label",
]);

export interface CaseSlotFacts {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly form: Form;
	readonly moduleUuid: Uuid | undefined;
	readonly module: Module | undefined;
	readonly registration: boolean;
	/** A follow-up or close form whose module selects several cases. */
	readonly severalCases: boolean;
	readonly operations: readonly CaseOperation[];
	readonly own: CaseOperation | undefined;
	/** A close form, or a registration with a close condition. */
	readonly closesOwn: boolean;
	/** The repeat each field of the form stands in, innermost first; absent
	 *  for a field in no repeat. A repeat's own entry is its parent's. */
	readonly repeatOf: ReadonlyMap<Uuid, Uuid | undefined>;
	readonly moduleCaseTypes: ReadonlySet<string>;
}

const facts = new WeakMap<BlueprintDoc, Map<Uuid, CaseSlotFacts>>();

function owningModule(doc: BlueprintDoc, formUuid: Uuid): Uuid | undefined {
	for (const moduleUuid of doc.moduleOrder)
		if (doc.formOrder[moduleUuid]?.includes(formUuid)) return moduleUuid;
	return undefined;
}

/** The facts of `formUuid` the slot eligibility reads. */
export function caseSlotFacts(
	doc: BlueprintDoc,
	formUuid: Uuid,
): CaseSlotFacts {
	let forms = facts.get(doc);
	if (forms === undefined) {
		forms = new Map();
		facts.set(doc, forms);
	}
	const known = forms.get(formUuid);
	if (known !== undefined) return known;
	const form = doc.forms[formUuid];
	if (form === undefined)
		throw new Error(
			`Nova was asked where form ${formUuid} keeps its case changes, and the app does not hold that form.`,
		);
	const moduleUuid = owningModule(doc, formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	const operations = orderedCaseOperations(form);
	const repeatOf = new Map<Uuid, Uuid | undefined>();
	const walk = (parent: Uuid, repeat: Uuid | undefined): void => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			repeatOf.set(uuid, repeat);
			walk(uuid, field.kind === "repeat" ? uuid : repeat);
		}
	};
	walk(formUuid, undefined);
	const built: CaseSlotFacts = {
		doc,
		formUuid,
		form,
		moduleUuid,
		module,
		registration: form.type === "registration",
		severalCases:
			CASE_LOADING_FORM_TYPES.has(form.type) &&
			module !== undefined &&
			caseSelectionCardinality(module) === "multiple",
		operations,
		own: operations.find((op) => op.action === "own"),
		closesOwn:
			form.type === "close" ||
			(form.type === "registration" && form.closeCondition !== undefined),
		repeatOf,
		moduleCaseTypes: new Set(
			Object.values(doc.modules).flatMap((mod) =>
				mod.caseType ? [mod.caseType] : [],
			),
		),
	};
	forms.set(formUuid, built);
	return built;
}

// ── The names HQ's build appends ────────────────────────────────────────

/** The element HQ's build appends to the data root for the worker's update
 *  (`xform.py::XForm._add_usercase`). */
export const USERCASE_BLOCK_NAME = "commcare_usercase";

/** The element HQ's build appends for the basic subcase at `index`, where
 *  its repeat holds another or it runs in none
 *  (`models/form_actions.py::OpenSubCaseAction.form_element_name`). */
export function subcaseBlockName(index: number): string {
	return `subcase_${index}`;
}

/**
 * Whether a name an author gave stands where HQ's build appends the element
 * `name`: a question, group or repeat directly in the rows of `repeat`, or
 * at the data root where `repeat` is absent, beside the root's Connect
 * blocks. HQ's build appends a slot's case block by its name without asking
 * whether the parent already holds one (`xform.py::XForm._create_casexml`,
 * its subcase loop, and `_add_usercase`), so the form would hold two
 * elements of that name: the question's bind would select the block's
 * element too, and every read of the question's path would meet two nodes,
 * which Core refuses to read as one value (part 02's G3, N1). A slot whose
 * name is taken is not eligible (`appended-name-taken`), and its change
 * takes Save to Case. A held slot keeps its name, and the gate refuses the
 * author's name instead (`HELD_BLOCK_PATH_TAKEN`), which only renaming
 * resolves.
 */
export function appendedNameTaken(
	f: CaseSlotFacts,
	name: string,
	repeat: Uuid | undefined,
): boolean {
	for (const uuid of f.doc.fieldOrder[repeat ?? f.formUuid] ?? [])
		if (f.doc.fields[uuid]?.id === name) return true;
	return repeat === undefined && formConnectIds(f.doc, f.formUuid).has(name);
}

// ── Values and conditions ───────────────────────────────────────────────

/** The question a value reads bare, with no filter and no role, if it does. */
export function bareRead(value: Expression): Uuid | undefined {
	if (value.kind !== "term" || value.term.kind !== "field") return undefined;
	if (value.term.filters !== undefined || value.term.role !== undefined)
		return undefined;
	return value.term.uuid;
}

/** The values a basic slot writes from: the name, the owner and each
 *  write's value, the name first. */
function slotValues(operation: CaseOperation): Expression[] {
	return [
		...(operation.name === undefined ? [] : [operation.name]),
		...(operation.rename === undefined ? [] : [operation.rename]),
		...(operation.owner === undefined ? [] : [operation.owner]),
		...(operation.writes ?? []).map((write) => write.value),
	];
}

type RepeatRule =
	| { readonly kind: "none" }
	| { readonly kind: "within"; readonly repeat: Uuid | undefined };

const VALUE_REASON_ORDER: readonly PlacementIneligibilityReason[] = [
	"value-computed",
	"value-label",
	"value-in-repeat",
	"value-wrong-repeat",
];

/**
 * The value reasons of one basic slot: each value is a bare read of a
 * question that is no label or container, or a capture's link, and each
 * question stands where the slot reads it (`none`: in no repeat; `within`:
 * in no repeat or in `repeat`).
 */
function valueReasons(
	f: CaseSlotFacts,
	values: readonly Expression[],
	rule: RepeatRule,
): PlacementIneligibilityReason[] {
	const reasons = new Set<PlacementIneligibilityReason>();
	for (const value of values) {
		const source = caseWriteValueField(value);
		const field = source === undefined ? undefined : f.doc.fields[source.field];
		if (
			source === undefined ||
			field === undefined ||
			!f.repeatOf.has(source.field) ||
			(source.link && !isCaptureField(field))
		) {
			reasons.add("value-computed");
			continue;
		}
		if (field.kind === "label" || isContainer(field)) {
			reasons.add("value-label");
			continue;
		}
		const repeat = f.repeatOf.get(source.field);
		if (rule.kind === "none" && repeat !== undefined)
			reasons.add("value-in-repeat");
		if (
			rule.kind === "within" &&
			repeat !== undefined &&
			repeat !== rule.repeat
		)
			reasons.add("value-wrong-repeat");
	}
	return VALUE_REASON_ORDER.filter((reason) => reasons.has(reason));
}

/** A condition Case Management states: the question, the answer it
 *  compares with (absent for "is true") and HQ's operator. */
export interface StatedCondition {
	readonly question: Uuid;
	readonly answer?: string;
	readonly operator: "=" | "selected" | "boolean_true";
}

type ComparedValue =
	| { readonly kind: "literal"; readonly value: unknown }
	| {
			readonly kind: "choice";
			readonly field: Uuid;
			readonly options: readonly Uuid[];
	  };

function comparedValue(value: unknown): ComparedValue | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const node = value as { kind?: unknown; term?: unknown };
	const leaf = node.kind === "term" ? (node.term as { kind?: unknown }) : node;
	if (leaf === undefined || leaf === null) return undefined;
	if (leaf.kind === "literal")
		return { kind: "literal", value: (leaf as { value: unknown }).value };
	if (leaf.kind === "choice") {
		const choice = leaf as { field: Uuid; options: readonly Uuid[] };
		return { kind: "choice", field: choice.field, options: choice.options };
	}
	return undefined;
}

interface ConditionShape {
	readonly question: Uuid;
	readonly value?: ComparedValue;
	readonly operator: StatedCondition["operator"];
}

/**
 * The three shapes Case Management states (`xform.py::XForm.action_relevance`):
 * a question alone (`boolean_true`), a question equal to one value (`=`),
 * and a multi-select holding one value (`selected`). Anything else, a
 * `match-none` included, is no such shape.
 */
function conditionShape(condition: Expression): ConditionShape | undefined {
	const alone = bareRead(condition);
	if (alone !== undefined) return { question: alone, operator: "boolean_true" };
	if (condition.kind === "eq") {
		const left = bareRead(condition.left);
		const right = bareRead(condition.right);
		if (left !== undefined && right === undefined) {
			const value = comparedValue(condition.right);
			return value === undefined
				? undefined
				: { question: left, value, operator: "=" };
		}
		if (right !== undefined && left === undefined) {
			const value = comparedValue(condition.left);
			return value === undefined
				? undefined
				: { question: right, value, operator: "=" };
		}
		return undefined;
	}
	if (
		condition.kind === "multi-select-contains" &&
		condition.quantifier === "any" &&
		condition.values.length === 1
	) {
		const property = condition.property as unknown;
		const question =
			typeof property === "object" &&
			property !== null &&
			(property as { kind?: unknown }).kind === "term"
				? bareRead(property as Expression)
				: undefined;
		const value = comparedValue(condition.values[0]);
		return question === undefined || value === undefined
			? undefined
			: { question, value, operator: "selected" };
	}
	return undefined;
}

function inlineOptions(
	field: Field,
): readonly { readonly uuid: Uuid; readonly value: string }[] | undefined {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return undefined;
	return field.optionsSource.kind === "inline"
		? field.optionsSource.options
		: undefined;
}

export interface ConditionScope {
	/** The subject is the form's own case. */
	readonly own: boolean;
	/** The repeat the subject runs in; absent at the form root. */
	readonly repeat: Uuid | undefined;
}

/**
 * Why Case Management cannot state `condition` for a subject, every failed
 * rule in table order, or what it states. Absent and `match-all` are stated
 * as no condition.
 */
export function stateCondition(
	f: CaseSlotFacts,
	condition: Expression | undefined,
	scope: ConditionScope,
):
	| {
			readonly stated: StatedCondition | undefined;
			readonly reasons: readonly [];
	  }
	| {
			readonly stated?: undefined;
			readonly reasons: readonly PlacementIneligibilityReason[];
	  } {
	if (condition === undefined || condition.kind === "match-all")
		return { stated: undefined, reasons: [] };
	const shape = conditionShape(condition);
	const field = shape === undefined ? undefined : f.doc.fields[shape.question];
	if (
		shape === undefined ||
		field === undefined ||
		!f.repeatOf.has(shape.question)
	)
		return { reasons: ["condition-shape"] };
	let answer: string | undefined;
	if (shape.value !== undefined) {
		if (shape.value.kind === "literal") {
			if (typeof shape.value.value !== "string")
				return { reasons: ["condition-shape"] };
			answer = shape.value.value;
		} else {
			const [only, ...more] = shape.value.options;
			const option = inlineOptions(field)?.find((o) => o.uuid === only);
			if (
				shape.value.field !== shape.question ||
				more.length > 0 ||
				option === undefined
			)
				return { reasons: ["condition-shape"] };
			answer = option.value;
		}
	}
	const reasons: PlacementIneligibilityReason[] = [];
	if (!STATEABLE_QUESTION_KINDS.has(field.kind))
		reasons.push("condition-question-kind");
	const repeat = f.repeatOf.get(shape.question);
	if (repeat !== undefined && repeat !== scope.repeat)
		reasons.push("condition-question-repeat");
	if (answer?.includes("'")) reasons.push("condition-apostrophe");
	if (
		scope.own &&
		answer !== undefined &&
		(answer.startsWith('"') || answer.endsWith('"'))
	)
		reasons.push("condition-quote-boundary");
	if (shape.value?.kind === "literal" && inlineOptions(field) !== undefined)
		reasons.push("condition-not-a-choice");
	if (reasons.length > 0) return { reasons };
	return {
		stated: {
			question: shape.question,
			...(answer !== undefined && { answer }),
			operator: shape.operator,
		},
		reasons: [],
	};
}

function tagged(
	reasons: readonly PlacementIneligibilityReason[],
	condition?: PlacementIneligibility["condition"],
): PlacementIneligibility[] {
	return reasons.map((reason) =>
		condition !== undefined && reason.startsWith("condition-")
			? { reason, condition }
			: { reason },
	);
}

// ── Case identities ─────────────────────────────────────────────────────

/** Whether `operation` names the case `createUuid` makes: by its target,
 *  a link, or an `id-of` in any of its expressions. */
function namesCase(operation: CaseOperation, createUuid: Uuid): boolean {
	if (operation.target?.kind === "op" && operation.target.opUuid === createUuid)
		return true;
	if (
		(operation.links ?? []).some(
			(link) => link.target?.kind === "op" && link.target.opUuid === createUuid,
		)
	)
		return true;
	const expressions: Expression[] = [
		...slotValues(operation),
		...(operation.writes ?? []).flatMap((write) =>
			write.condition === undefined ? [] : [write.condition],
		),
		...(operation.condition === undefined ? [] : [operation.condition]),
		...(operation.target?.kind === "expression" ? [operation.target.expr] : []),
		...(operation.links ?? []).flatMap((link) =>
			link.target?.kind === "expression" ? [link.target.expr] : [],
		),
	];
	let found = false;
	for (const expression of expressions) {
		// A slot a document still being assembled holds as source text (a
		// fixture parses each slot in place) names no case yet.
		if (typeof expression !== "object") continue;
		walkExpressionNodes(expression, (node) => {
			if (node.kind === "id-of" && node.opUuid === createUuid) found = true;
		});
		if (found) return true;
	}
	return false;
}

/** Whether `operation` updates or closes the case `createUuid` makes. */
function changesCase(operation: CaseOperation, createUuid: Uuid): boolean {
	return (
		(operation.action === "update" || operation.action === "close") &&
		operation.target.kind === "op" &&
		operation.target.opUuid === createUuid
	);
}

/** The form's own case as an operation names it. */
function targetsOwnCase(
	f: CaseSlotFacts,
	target: CaseOperation["target"] | null,
): boolean {
	if (target === undefined || target === null) return false;
	if (f.registration)
		return target.kind === "op" && target.opUuid === f.own?.uuid;
	return target.kind === "session";
}

/**
 * The close that would share each create's basic subcase as its
 * `close_condition`: the first later operation naming the create's case,
 * when that is a close of it with the same `forEach`, a condition stated for
 * a child there, and no Save to Case placement of its own held.
 */
export function sharingCloses(
	f: CaseSlotFacts,
): ReadonlyMap<Uuid, CaseOperation> {
	const sharers = new Map<Uuid, CaseOperation>();
	f.operations.forEach((create, index) => {
		if (create.action !== "create") return;
		const next = f.operations
			.slice(index + 1)
			.find((op) => namesCase(op, create.uuid));
		if (
			next === undefined ||
			next.action !== "close" ||
			!changesCase(next, create.uuid) ||
			next.forEach?.repeat !== create.forEach?.repeat ||
			next.placement?.kind === "save-to-case" ||
			stateCondition(f, next.condition, {
				own: false,
				repeat: create.forEach?.repeat,
			}).reasons.length > 0
		)
			return;
		sharers.set(create.uuid, next);
	});
	return sharers;
}

// ── Eligibility, slot by slot ───────────────────────────────────────────

export const SUBJECT_CANNOT_HOLD: PlacementIneligibility = { reason: "scope" };

export function ownSlotReasons(
	f: CaseSlotFacts,
	operation: CaseOperation,
): PlacementIneligibility[] {
	if (operation.action !== "own") return [SUBJECT_CANNOT_HOLD];
	const reasons: PlacementIneligibility[] = [];
	if (f.severalCases) reasons.push({ reason: "several-cases" });
	reasons.push(
		...tagged(valueReasons(f, slotValues(operation), { kind: "none" })),
	);
	if ((operation.writes ?? []).some((write) => write.condition !== undefined))
		reasons.push({ reason: "write-condition" });
	if ((operation.links ?? []).length > 0) reasons.push({ reason: "links" });
	if (f.registration) {
		reasons.push(
			...tagged(
				stateCondition(f, f.form.openCondition, {
					own: true,
					repeat: undefined,
				}).reasons,
				"open",
			),
		);
		// HQ writes a registration's close as `close_case` on the block it
		// creates the case with, and a Save to Case close would stand before
		// that create, so the close must be stated too.
		reasons.push(
			...tagged(
				stateCondition(f, f.form.closeCondition, {
					own: true,
					repeat: undefined,
				}).reasons,
				"close",
			),
		);
		if (f.operations.some((op) => changesCase(op, operation.uuid)))
			reasons.push({ reason: "case-changed-before-create" });
	}
	return reasons;
}

export function isWorkerRecordUpdate(operation: CaseOperation): boolean {
	return (
		operation.action === "update" && operation.target.kind === "worker-record"
	);
}

export function usercaseSlotReasons(
	f: CaseSlotFacts,
	operation: CaseOperation,
): PlacementIneligibility[] {
	if (!isWorkerRecordUpdate(operation)) return [SUBJECT_CANNOT_HOLD];
	const reasons: PlacementIneligibility[] = tagged(
		valueReasons(f, slotValues(operation), { kind: "none" }),
	);
	if ((operation.writes ?? []).some((write) => write.condition !== undefined))
		reasons.push({ reason: "write-condition" });
	return reasons;
}

export interface SubcaseContext {
	readonly ownBasic: boolean;
	readonly sharers: ReadonlyMap<Uuid, CaseOperation>;
}

/**
 * Every condition of the basic subcase slot but the index and the nesting,
 * which read the form's other subcases. A basic subcase writes one `child`
 * index named `parent`: HQ's basic build ignores
 * `OpenSubCaseAction.relationship` (`xform.py::XForm._create_casexml`).
 */
export function subcaseReasons(
	f: CaseSlotFacts,
	operation: CaseOperation,
	context: SubcaseContext,
): PlacementIneligibility[] {
	if (operation.action !== "create") return [SUBJECT_CANNOT_HOLD];
	const repeat = operation.forEach?.repeat;
	const reasons: PlacementIneligibility[] = [];
	if (f.severalCases) reasons.push({ reason: "several-cases" });
	if (operation.target.kind === "new" && operation.target.idFrom !== undefined)
		reasons.push({ reason: "keyed-id" });
	const links = operation.links ?? [];
	const [link] = links;
	if (
		links.length !== 1 ||
		link === undefined ||
		link.identifier !== "parent" ||
		link.relationship !== "child" ||
		!targetsOwnCase(f, link.target)
	)
		reasons.push({ reason: "subcase-link" });
	if (f.registration && !context.ownBasic)
		reasons.push({ reason: "own-not-basic" });
	if (!f.moduleCaseTypes.has(operation.caseType))
		reasons.push({ reason: "subcase-type" });
	reasons.push(
		...tagged(
			valueReasons(f, slotValues(operation), { kind: "within", repeat }),
		),
	);
	// HQ's `repeat_context` is where the name's question stands.
	const name =
		operation.name === undefined
			? undefined
			: caseWriteValueField(operation.name);
	if (name !== undefined && f.repeatOf.get(name.field) !== repeat)
		reasons.push({ reason: "name-repeat" });
	if ((operation.writes ?? []).some((write) => write.condition !== undefined))
		reasons.push({ reason: "write-condition" });
	reasons.push(
		...tagged(
			stateCondition(f, operation.condition, { own: false, repeat }).reasons,
			"operation",
		),
	);
	const sharer = context.sharers.get(operation.uuid);
	if (
		f.operations.some((op) => op !== sharer && changesCase(op, operation.uuid))
	)
		reasons.push({ reason: "case-changed-before-create" });
	return reasons;
}

/**
 * Whether `operation` is the child `planFieldCaseWrite` writes for a field:
 * one `child` link to the own case and a name read bare. In a several-case
 * form such a child keeps its wire: HQ's subcase, which HQ's build skips
 * there, beside an active Save to Case block per selected case (part 01
 * departure 27).
 */
function isFieldWrittenChild(operation: CaseOperation): boolean {
	const links = operation.links ?? [];
	return (
		operation.action === "create" &&
		links.length === 1 &&
		links[0]?.relationship === "child" &&
		operation.name !== undefined &&
		bareRead(operation.name) !== undefined
	);
}

// ── Save to Case blocks of the own arm and the creates ──────────────────

/** One segment of a Save to Case block's path from its scope: a wrapper
 *  group by purpose, or the block itself. */
export type SaveToCaseBlockSegment =
	| "selected-cases"
	| "selected-case"
	| "operations"
	| "keyed"
	| "condition"
	| "block";

/** A create at the form root keyed by an answer, which stands in a one-row
 *  repeat of its own. */
export function isKeyedRootCreate(operation: CaseOperation): boolean {
	return (
		operation.action === "create" &&
		operation.forEach === undefined &&
		operation.target.kind === "new" &&
		operation.target.idFrom !== undefined
	);
}

/**
 * The wrappers of the own arm's block or a create's, from its scope: a
 * create's condition is its block's own `relevant`, so it takes no
 * condition group.
 */
export function ownOrCreateBlockShape(
	f: CaseSlotFacts,
	operation: CaseOperation,
): readonly SaveToCaseBlockSegment[] {
	if (operation.action === "own")
		return f.severalCases
			? ["selected-cases", "selected-case", "operations", "condition", "block"]
			: ["operations", "block"];
	return [
		...(f.severalCases && caseOperationRunsPerSelectedCase(operation)
			? (["selected-cases", "selected-case"] as const)
			: []),
		"operations",
		...(isKeyedRootCreate(operation) ? (["keyed"] as const) : []),
		"block",
	];
}

/** Why a held Save to Case placement no longer expresses the own arm or a
 *  create (`placement.ts::saveToCaseReasons` for these two subjects). */
function ownOrCreateSaveToCaseReasons(
	f: CaseSlotFacts,
	operation: CaseOperation,
	placement: SaveToCasePlacement,
): PlacementIneligibility[] {
	const reasons: PlacementIneligibility[] = [];
	const writes = operation.writes ?? [];
	if (writes.some((write) => write.onlyIfChanged === true))
		reasons.push({ reason: "only-if-changed" });
	if (writes.some((write) => write.via !== undefined))
		reasons.push({ reason: "via" });
	if (placement.repeat !== operation.forEach?.repeat)
		reasons.push({ reason: "scope" });
	if (placement.path.length !== ownOrCreateBlockShape(f, operation).length)
		reasons.push({ reason: "block-shape" });
	return reasons;
}

function keepsHeldSaveToCase(
	f: CaseSlotFacts,
	operation: CaseOperation,
	held: CasePlacement | undefined,
): boolean {
	return (
		held?.kind === "save-to-case" &&
		ownOrCreateSaveToCaseReasons(f, operation, held).length === 0
	);
}

// ── The choice ──────────────────────────────────────────────────────────

/** One basic subcase of a form, in `subcases` index order. */
export interface PlannedBasicSubcase {
	readonly operationUuid: Uuid;
	readonly index: number;
	/** Written at its repeat row's own `case`: the repeat holds no other. */
	readonly row: boolean;
	/** A field-written child of a several-case form kept as HQ's subcase,
	 *  which HQ's build skips there, beside an active Save to Case block. */
	readonly inSource: boolean;
}

/** Where the own arm or a create is kept: a basic slot (`held` where its
 *  stored placement is that slot), or Save to Case (`held` where its stored
 *  block still expresses it). */
export type SlotChoice =
	| { readonly kind: "basic"; readonly held: boolean }
	| { readonly kind: "save-to-case"; readonly held: boolean };

export interface BasicCaseSlots {
	readonly own: SlotChoice | undefined;
	readonly ownBasic: boolean;
	/** Each create's choice, by operation uuid. */
	readonly creates: ReadonlyMap<Uuid, SlotChoice>;
	readonly subcases: readonly PlannedBasicSubcase[];
	readonly sharers: ReadonlyMap<Uuid, CaseOperation>;
}

export interface BasicCaseSlotOptions {
	/** Operations kept out of every basic slot. */
	readonly exclude?: ReadonlySet<Uuid>;
	/** Plans this operation in a basic slot where it is eligible, whatever
	 *  the exclusions say. */
	readonly forceBasic?: Uuid;
	/**
	 * The creates an after-submit link carries into another form
	 * (`lib/commcare/formLinkProjection.ts::linkCarriedCreates`, which the
	 * domain cannot read). A Save to Case block gives a case no session
	 * value, so a held block no longer expresses one of these.
	 */
	readonly carried?: ReadonlySet<Uuid>;
}

/**
 * The case type HQ's basic actions write for a module
 * (`form.get_case_type()`): the module's, where it has cases at all.
 */
export function moduleCaseTypeForActions(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): string {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || !mod.caseType) return "";
	const formUuids = doc.formOrder[moduleUuid] ?? [];
	const hasCases =
		moduleHasCaseListMenuItem(mod) ||
		formUuids.some((formUuid) => doc.forms[formUuid]?.type !== "survey");
	return hasCases ? mod.caseType : "";
}

const slotPlans = new WeakMap<BlueprintDoc, Map<string, BasicCaseSlots>>();

/**
 * Which of `formUuid`'s own arm and creates take a basic slot. A held basic
 * slot whose index or nesting no longer holds is chosen as if unheld, and an
 * unheld subcase whose `subcase_<i>` an author's name takes falls to Save to
 * Case (`appendedNameTaken`); either can change how many subcases there are,
 * so the choice runs until it settles.
 */
export function basicCaseSlots(
	doc: BlueprintDoc,
	formUuid: Uuid,
	options: BasicCaseSlotOptions = {},
): BasicCaseSlots {
	const extra = [...(options.exclude ?? [])].sort();
	const carried = options.carried ?? new Set<Uuid>();
	const key = `${formUuid}\u0000${extra.join(",")}\u0000${options.forceBasic ?? ""}\u0000${[...carried].sort().join(",")}`;
	let byKey = slotPlans.get(doc);
	if (byKey === undefined) {
		byKey = new Map();
		slotPlans.set(doc, byKey);
	}
	const known = byKey.get(key);
	if (known !== undefined) return known;
	const f = caseSlotFacts(doc, formUuid);
	const exclude = new Set(extra);
	const excluded = (uuid: Uuid) =>
		options.forceBasic !== uuid && exclude.has(uuid);

	let own: SlotChoice | undefined;
	if (f.own !== undefined) {
		const op = f.own;
		const eligible = ownSlotReasons(f, op).length === 0;
		if (op.placement?.kind === "basic" && op.placement.slot === "own")
			own = eligible
				? { kind: "basic", held: true }
				: { kind: "save-to-case", held: false };
		else if (!carried.has(op.uuid) && keepsHeldSaveToCase(f, op, op.placement))
			own = { kind: "save-to-case", held: true };
		else
			own =
				!excluded(op.uuid) && eligible
					? { kind: "basic", held: false }
					: { kind: "save-to-case", held: false };
	}
	const ownBasic = own?.kind === "basic";

	const sharers = sharingCloses(f);
	const context: SubcaseContext = { ownBasic, sharers };
	const creates = f.operations.filter((op) => op.action === "create");
	const demoted = new Set<Uuid>();
	// The unheld creates whose `subcase_<i>` an author's name takes.
	const nameTaken = new Set<Uuid>();
	type CreateChoice =
		| {
				readonly kind: "basic";
				readonly held?: CasePlacement;
				readonly inSource: boolean;
		  }
		| { readonly kind: "save-to-case"; readonly held: boolean };
	const choose = (op: CaseOperation): CreateChoice => {
		const held = demoted.has(op.uuid) ? undefined : op.placement;
		if (held?.kind === "basic") {
			if (
				(held.slot === "subcase" || held.slot === "subcase-row") &&
				subcaseReasons(f, op, context).length === 0
			)
				return { kind: "basic", held, inSource: false };
		} else if (!carried.has(op.uuid) && keepsHeldSaveToCase(f, op, held))
			return { kind: "save-to-case", held: true };
		if (excluded(op.uuid) || nameTaken.has(op.uuid))
			return { kind: "save-to-case", held: false };
		if (subcaseReasons(f, op, context).length === 0)
			return { kind: "basic", inSource: false };
		// A field-written child of a several-case form keeps its wire (part
		// 01 departure 27): its subcase stays in `subcases` and its create is
		// a block in the source. The inert subcase carries no close, so
		// nothing shares its place.
		if (
			f.severalCases &&
			isFieldWrittenChild(op) &&
			subcaseReasons(f, op, { ownBasic, sharers: new Map() }).every(
				(r) => r.reason === "several-cases",
			)
		)
			return { kind: "basic", inSource: true };
		return { kind: "save-to-case", held: false };
	};
	let choices = new Map<Uuid, CreateChoice>();
	let subcases: PlannedBasicSubcase[] = [];
	for (;;) {
		choices = new Map(creates.map((op) => [op.uuid, choose(op)]));
		const basic = creates.filter(
			(op) => choices.get(op.uuid)?.kind === "basic",
		);
		const k = basic.length;
		const perRepeat = new Map<Uuid, number>();
		for (const op of basic) {
			const repeat = op.forEach?.repeat;
			if (repeat !== undefined)
				perRepeat.set(repeat, (perRepeat.get(repeat) ?? 0) + 1);
		}
		const isRow = (op: CaseOperation) =>
			op.forEach !== undefined && perRepeat.get(op.forEach.repeat) === 1;
		const heldIndex = (op: CaseOperation): number | undefined => {
			const choice = choices.get(op.uuid);
			return choice?.kind === "basic" &&
				choice.held?.kind === "basic" &&
				choice.held.slot === "subcase"
				? choice.held.index
				: undefined;
		};
		const claims = new Map<number, number>();
		for (const op of basic) {
			const index = heldIndex(op);
			if (index !== undefined) claims.set(index, (claims.get(index) ?? 0) + 1);
		}
		let changed = false;
		for (const op of basic) {
			const choice = choices.get(op.uuid);
			if (choice?.kind !== "basic" || choice.held?.kind !== "basic") continue;
			const failed =
				choice.held.slot === "subcase-row"
					? !isRow(op)
					: choice.held.slot === "subcase" &&
						(isRow(op) ||
							choice.held.index >= k ||
							(claims.get(choice.held.index) ?? 0) > 1);
			if (failed) {
				demoted.add(op.uuid);
				changed = true;
			}
		}
		if (changed) continue;
		// Held indices keep theirs; the rest take the free indices lowest
		// first, in array order, row subcases included.
		const taken = new Set<number>();
		const indexOf = new Map<Uuid, number>();
		for (const op of basic) {
			const index = heldIndex(op);
			if (index !== undefined) {
				indexOf.set(op.uuid, index);
				taken.add(index);
			}
		}
		let next = 0;
		for (const op of basic) {
			if (indexOf.has(op.uuid)) continue;
			while (taken.has(next)) next++;
			indexOf.set(op.uuid, next);
			taken.add(next);
		}
		// An unheld subcase HQ's build appends as `subcase_<i>` where an
		// author's name stands takes Save to Case (`appendedNameTaken`), and
		// the indices are chosen again without it. A held one keeps its index.
		for (const op of basic) {
			const choice = choices.get(op.uuid);
			if (
				choice?.kind !== "basic" ||
				choice.held !== undefined ||
				choice.inSource ||
				isRow(op)
			)
				continue;
			const index = indexOf.get(op.uuid) ?? 0;
			if (appendedNameTaken(f, subcaseBlockName(index), op.forEach?.repeat)) {
				nameTaken.add(op.uuid);
				changed = true;
			}
		}
		if (changed) continue;
		subcases = basic
			.map((op) => {
				const choice = choices.get(op.uuid) as Extract<
					CreateChoice,
					{ kind: "basic" }
				>;
				return {
					operationUuid: op.uuid,
					index: indexOf.get(op.uuid) ?? 0,
					row: isRow(op),
					inSource: choice.inSource,
				};
			})
			.sort((a, b) => a.index - b.index);
		break;
	}
	const createChoices = new Map<Uuid, SlotChoice>(
		[...choices].map(([uuid, choice]) => [
			uuid,
			choice.kind === "basic"
				? { kind: "basic", held: choice.held !== undefined }
				: { kind: "save-to-case", held: choice.held },
		]),
	);
	const result: BasicCaseSlots = {
		own,
		ownBasic,
		creates: createChoices,
		subcases,
		sharers,
	};
	byKey.set(key, result);
	return result;
}

/**
 * Whether the entry of `formUuid`, a registration, gives the case it
 * creates a session value: HQ's entry carries `case_id_new_<type>_0` only
 * where `open_case` is active, which is where the own arm takes the basic
 * slot. Elsewhere the own case's id is minted inside its Save to Case block
 * and no session value holds it.
 */
export function registrationMintsOwnCaseId(
	doc: BlueprintDoc,
	formUuid: Uuid,
): boolean {
	const form = doc.forms[formUuid];
	if (form === undefined || form.type !== "registration") return false;
	const moduleUuid = owningModule(doc, formUuid);
	if (moduleUuid === undefined || !doc.modules[moduleUuid]?.caseType)
		return false;
	const slots = basicCaseSlots(doc, formUuid);
	return slots.own !== undefined && slots.ownBasic;
}

/**
 * The case types of the children a form creates outside a repeat that its
 * entry gives a session value, in `subcases` index order: CommCare HQ's
 * basic subcases at the form root (`subcase_<i>`, each given its id datum),
 * the inert subcase of a several-case form's field-written child included.
 */
export function rootBasicSubcaseCreates(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly { readonly operationUuid: Uuid; readonly caseType: string }[] {
	const f = caseSlotFacts(doc, formUuid);
	const byUuid = new Map(f.operations.map((op) => [op.uuid, op]));
	return basicCaseSlots(doc, formUuid).subcases.flatMap((subcase) => {
		const op = byUuid.get(subcase.operationUuid);
		return op === undefined ||
			op.action !== "create" ||
			op.forEach !== undefined
			? []
			: [{ operationUuid: op.uuid, caseType: op.caseType }];
	});
}

/**
 * Whether the held Save to Case block of the own arm or a create still
 * expresses it (`lib/commcare/placement.ts::saveToCaseReasons` for these two
 * subjects). The advanced procedure keeps such a block before it tries an
 * open action (`advancedEntryDatums.ts::advancedEntryActions`).
 */
export function heldOwnOrCreateBlockExpresses(
	f: CaseSlotFacts,
	operation: CaseOperation,
): boolean {
	return keepsHeldSaveToCase(f, operation, operation.placement);
}
