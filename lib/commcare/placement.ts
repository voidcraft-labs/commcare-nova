/**
 * Where CommCare HQ keeps each case change of a form: a slot of the form's
 * Case Management settings (a basic slot) or a Save to Case block in the
 * form's source. The placement decides wire facts, so it lives here, and
 * every emitter reads it through `casePlacementPlan.ts::planFormCaseWire`.
 *
 * A form's subjects are its case operations and, where it cannot share the
 * own arm's place, its own close. Each subject keeps a held placement
 * (`CaseOperation.placement`, `Form.ownClosePlacement`) while that placement
 * still expresses it, and otherwise takes the first eligible of a basic slot
 * and a Save to Case block, in the form's operation order. A basic slot is
 * eligible only where HQ's Case Management page would keep what the
 * operation means: the page offers and saves the shapes `case_config_utils.js`
 * reads, and HQ's build writes them as `xform.py::XForm._create_casexml`
 * does. Save to Case is always eligible, so every operation has a place.
 *
 * Pure, and memoized per document object (documents are replaced, never
 * changed in place) and per options, as `planGeneratedNodes` is.
 */

import { caseOperationConditionalGuardUuids } from "@/lib/doc/caseOperationOrder";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	type CasePlacement,
	caseSelectionCardinality,
	caseWriteValueField,
	type Field,
	type Form,
	isCaptureField,
	isContainer,
	type Module,
	moduleUuidOfForm,
	orderedCaseOperations,
	type PlacementIneligibility,
	type PlacementIneligibilityReason,
	type SaveToCasePlacement,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { moduleCaseTypeForActions } from "./formLinkProjection";
import { collectFieldLocations, saveToCaseBlockShape } from "./xform/caseOps";
import { descendFormPathIntoField, FormPath } from "./xform/formPath";
import { planGeneratedNodes } from "./xform/generatedNodes";

/** One thing of a form that takes a place: an operation, or the own close. */
export type PlacementSubject =
	| { readonly kind: "operation"; readonly operationUuid: Uuid }
	| { readonly kind: "own-close" };

/** A subject's key in `FormPlacements.placements`. */
export type PlacementSubjectKey = Uuid | "own-close";

export function placementSubjectKey(
	subject: PlacementSubject,
): PlacementSubjectKey {
	return subject.kind === "own-close" ? "own-close" : subject.operationUuid;
}

export interface PlannedPlacement {
	readonly placement: CasePlacement;
	/** The subject's stored placement, kept because it still expresses it. */
	readonly held: boolean;
	/** A close sharing another operation's place: a basic subcase's
	 *  `close_condition`, or the own close written in the own arm's place. */
	readonly sharesWith?: Uuid;
}

export interface FormPlacements {
	/** Every form is a basic form until advanced modules are emitted. */
	readonly formKind: "basic";
	readonly placements: ReadonlyMap<PlacementSubjectKey, PlannedPlacement>;
}

export interface PlanPlacementsOptions {
	/** Fixes the form kind. Only `basic` exists until advanced modules are
	 *  emitted. */
	readonly moduleKind?: "basic";
	/**
	 * Unheld operations that skip the basic slots and take Save to Case, on
	 * top of the default exclusion: every unheld create of its module's own
	 * case type (`sameTypeExclusions`).
	 */
	readonly excludeBasic?: ReadonlySet<Uuid>;
}

/** One basic subcase of a form, in `subcases` index order. */
export interface PlannedBasicSubcase {
	readonly operationUuid: Uuid;
	readonly index: number;
	/** Written at its repeat row's own `case`: the repeat holds no other. */
	readonly row: boolean;
	/** The subcase's link is `extension`, which HQ's basic build ignores. */
	readonly extension: boolean;
	/** A field-written child kept as HQ's subcase, which writes nothing (an
	 *  extension's, condition `never`; any subcase of a several-case form,
	 *  which HQ's build skips), beside an active Save to Case block:
	 *  `nova_subcases/nova_subcase_<index>`, or in a several-case form
	 *  `nova_operations/nova_subcase_<index>` in the selected-case row. */
	readonly inSource: boolean;
}

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

interface FormFacts {
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
	/** Operations whose condition reaches them through an earlier
	 *  conditional create they consume. */
	readonly conditional: ReadonlySet<Uuid>;
}

const facts = new WeakMap<BlueprintDoc, Map<Uuid, FormFacts>>();

function formFacts(doc: BlueprintDoc, formUuid: Uuid): FormFacts {
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
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	const operations = orderedCaseOperations(form);
	const repeatOf = new Map<Uuid, Uuid | undefined>();
	for (const [uuid, location] of collectFieldLocations(doc, formUuid)) {
		// `collectFieldLocations` gives a repeat its own uuid; the repeat a
		// field stands in is the one around it.
		repeatOf.set(
			uuid,
			location.repeat === uuid
				? enclosingRepeat(doc, formUuid, uuid)
				: location.repeat,
		);
	}
	const guards = caseOperationConditionalGuardUuids(doc, formUuid, operations);
	const byUuid = new Map(operations.map((op) => [op.uuid, op]));
	const conditional = new Set<Uuid>();
	for (const operation of operations) {
		if (
			operation.condition !== undefined ||
			[...(guards.get(operation.uuid) ?? [])].some(
				(uuid) => byUuid.get(uuid)?.condition !== undefined,
			)
		)
			conditional.add(operation.uuid);
	}
	const built: FormFacts = {
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
		conditional,
	};
	forms.set(formUuid, built);
	return built;
}

function enclosingRepeat(
	doc: BlueprintDoc,
	formUuid: Uuid,
	fieldUuid: Uuid,
): Uuid | undefined {
	for (
		let parent = doc.fieldParent[fieldUuid];
		parent !== undefined && parent !== formUuid;
		parent = doc.fieldParent[parent]
	) {
		if (doc.fields[parent]?.kind === "repeat") return parent;
	}
	return undefined;
}

/** The row path of `repeatUuid` in its form: the scope a block placed in
 *  the repeat stands in. */
export function repeatRowPath(
	doc: BlueprintDoc,
	formUuid: Uuid,
	repeatUuid: Uuid,
): FormPath | undefined {
	const location = collectFieldLocations(doc, formUuid).get(repeatUuid);
	const field = doc.fields[repeatUuid];
	if (location === undefined || field?.kind !== "repeat") return undefined;
	return descendFormPathIntoField(field, location.path);
}

// ── Values and conditions ───────────────────────────────────────────────

/** The question a value reads bare, with no filter and no role, if it does. */
function bareRead(value: Expression): Uuid | undefined {
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

/**
 * The value reasons of one basic slot: each value is a bare read of a
 * question that is no label or container, or a capture's link, and each
 * question stands where the slot reads it (`none`: in no repeat; `within`:
 * in no repeat or in `repeat`).
 */
function valueReasons(
	f: FormFacts,
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
	return REASON_ORDER.filter((reason) => reasons.has(reason));
}

const REASON_ORDER: readonly PlacementIneligibilityReason[] = [
	"value-computed",
	"value-label",
	"value-in-repeat",
	"value-wrong-repeat",
];

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

interface ConditionScope {
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
function stateCondition(
	f: FormFacts,
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

/**
 * What Case Management states for `condition` at the subject `scope`, or
 * `undefined` for an unconditional one. Throws where the condition is not
 * stateable; the plan reads it only for a placement it chose by it.
 */
export function statedCondition(
	doc: BlueprintDoc,
	formUuid: Uuid,
	condition: Expression | undefined,
	scope: ConditionScope,
): StatedCondition | undefined {
	const result = stateCondition(formFacts(doc, formUuid), condition, scope);
	if (result.reasons.length > 0)
		throw new Error(
			`Nova placed a condition of form ${formUuid} in Case Management, which cannot state it (${result.reasons.join(", ")}). The placement and the plan of the form's case changes must agree.`,
		);
	return result.stated;
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
	f: FormFacts,
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
function sharingCloses(f: FormFacts): ReadonlyMap<Uuid, CaseOperation> {
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

const SUBJECT_CANNOT_HOLD: PlacementIneligibility = { reason: "scope" };

function ownSlotReasons(
	f: FormFacts,
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

function isWorkerRecordUpdate(operation: CaseOperation): boolean {
	return (
		operation.action === "update" && operation.target.kind === "worker-record"
	);
}

function usercaseSlotReasons(
	f: FormFacts,
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

interface SubcaseContext {
	readonly ownBasic: boolean;
	readonly sharers: ReadonlyMap<Uuid, CaseOperation>;
}

/**
 * Every condition of the basic subcase slot but the index and the nesting,
 * which read the form's other subcases. `relationship` is the link a basic
 * subcase writes: `child` for HQ's own subcase, `extension` for the
 * field-written extension child kept as today's inert subcase.
 */
function subcaseReasons(
	f: FormFacts,
	operation: CaseOperation,
	context: SubcaseContext,
	relationship: "child" | "extension",
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
		link.relationship !== relationship ||
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

function saveToCaseReasons(
	f: FormFacts,
	subject: PlacementSubject,
	placement: SaveToCasePlacement,
): PlacementIneligibility[] {
	const operation =
		subject.kind === "operation"
			? f.operations.find((op) => op.uuid === subject.operationUuid)
			: undefined;
	const reasons: PlacementIneligibility[] = [];
	const writes = operation?.writes ?? [];
	if (writes.some((write) => write.onlyIfChanged === true))
		reasons.push({ reason: "only-if-changed" });
	if (writes.some((write) => write.via !== undefined))
		reasons.push({ reason: "via" });
	if (placement.repeat !== operation?.forEach?.repeat)
		reasons.push({ reason: "scope" });
	if (
		placement.path.length !==
		saveToCaseBlockShape(f.doc, f.formUuid, subject).length
	)
		reasons.push({ reason: "block-shape" });
	return reasons;
}

// ── The procedure ───────────────────────────────────────────────────────

interface CorePlan {
	readonly placements: ReadonlyMap<PlacementSubjectKey, PlannedPlacement>;
	readonly subcases: readonly PlannedBasicSubcase[];
	readonly ownBasic: boolean;
	readonly sharers: ReadonlyMap<Uuid, CaseOperation>;
}

interface CoreOptions {
	readonly exclude: ReadonlySet<Uuid>;
	/** Plans this operation in a basic subcase slot where it is eligible,
	 *  whatever the exclusions say. */
	readonly forceBasic?: Uuid;
}

/**
 * Until a publish can check that a project space keeps a same-type child's
 * parent index, an unheld create of its module's own case type
 * (`formLinkProjection.ts::moduleCaseTypeForActions`, HQ's
 * `form.get_case_type()`) takes Save to Case. No eligibility condition: a
 * held one is kept, and `placementIneligibility` never names it.
 */
function sameTypeExclusions(f: FormFacts): ReadonlySet<Uuid> {
	const moduleType =
		f.moduleUuid === undefined
			? ""
			: moduleCaseTypeForActions(f.doc, f.moduleUuid);
	return new Set(
		f.operations
			.filter(
				(op) =>
					op.action === "create" &&
					op.placement === undefined &&
					moduleType !== "" &&
					op.caseType === moduleType,
			)
			.map((op) => op.uuid),
	);
}

function planCore(f: FormFacts, options: CoreOptions): CorePlan {
	const placements = new Map<PlacementSubjectKey, PlannedPlacement>();
	const nodes = planGeneratedNodes(f.doc, f.formUuid);
	const excluded = (uuid: Uuid) =>
		options.forceBasic !== uuid && options.exclude.has(uuid);
	const derivedPath = (subject: PlacementSubject): SaveToCasePlacement =>
		derivedSaveToCase(f, subject, nodes);
	const keepSaveToCase = (
		subject: PlacementSubject,
		held: CasePlacement | undefined,
	): PlannedPlacement | undefined =>
		held?.kind === "save-to-case" &&
		saveToCaseReasons(f, subject, held).length === 0
			? { placement: held, held: true }
			: undefined;
	const asSubject = (op: CaseOperation): PlacementSubject => ({
		kind: "operation",
		operationUuid: op.uuid,
	});

	// The own arm and the worker's record take their slots first: each slot
	// has one subject, and the subcases read whether the own arm is basic.
	let ownBasic = false;
	let usercaseTaken = false;
	for (const op of f.operations) {
		if (op.action === "own") {
			const kept =
				op.placement?.kind === "basic" && op.placement.slot === "own"
					? ownSlotReasons(f, op).length === 0
						? { placement: op.placement, held: true }
						: undefined
					: keepSaveToCase(asSubject(op), op.placement);
			const planned =
				kept ??
				(!excluded(op.uuid) && ownSlotReasons(f, op).length === 0
					? { placement: { kind: "basic", slot: "own" } as const, held: false }
					: { placement: derivedPath(asSubject(op)), held: false });
			placements.set(op.uuid, planned);
			ownBasic = planned.placement.kind === "basic";
		} else if (isWorkerRecordUpdate(op)) {
			const eligible =
				!usercaseTaken && usercaseSlotReasons(f, op).length === 0;
			const kept =
				op.placement?.kind === "basic" && op.placement.slot === "usercase"
					? eligible
						? { placement: op.placement, held: true }
						: undefined
					: keepSaveToCase(asSubject(op), op.placement);
			const planned =
				kept ??
				(!excluded(op.uuid) && eligible
					? {
							placement: { kind: "basic", slot: "usercase" } as const,
							held: false,
						}
					: { placement: derivedPath(asSubject(op)), held: false });
			placements.set(op.uuid, planned);
			if (planned.placement.kind === "basic") usercaseTaken = true;
		}
	}

	// Creates: which take a basic subcase slot. A held basic slot whose index
	// or nesting no longer holds is planned as if unheld, which can change
	// how many subcases there are, so the choice runs until it settles.
	const sharers = sharingCloses(f);
	const context: SubcaseContext = { ownBasic, sharers };
	const creates = f.operations.filter((op) => op.action === "create");
	const demoted = new Set<Uuid>();
	type CreateChoice =
		| {
				readonly kind: "basic";
				readonly held?: CasePlacement;
				readonly extension: boolean;
				readonly inSource: boolean;
		  }
		| { readonly kind: "save-to-case"; readonly planned?: PlannedPlacement };
	const choose = (op: CaseOperation): CreateChoice => {
		const held = demoted.has(op.uuid) ? undefined : op.placement;
		if (held?.kind === "basic") {
			if (
				(held.slot === "subcase" || held.slot === "subcase-row") &&
				subcaseReasons(f, op, context, "child").length === 0
			)
				return { kind: "basic", held, extension: false, inSource: false };
		} else {
			const kept = keepSaveToCase(asSubject(op), held);
			if (kept !== undefined) return { kind: "save-to-case", planned: kept };
		}
		if (excluded(op.uuid)) return { kind: "save-to-case" };
		if (subcaseReasons(f, op, context, "child").length === 0)
			return { kind: "basic", extension: false, inSource: false };
		// A field-written child HQ's build would not write keeps today's
		// wire (part 01 §12.3 step 4, departure 27): its subcase stays in
		// `subcases` and its create is a block in the source. The inert
		// subcase carries no close, so nothing shares its place.
		const relationship = fieldWrittenRelationship(op);
		if (relationship !== undefined) {
			const reasons = subcaseReasons(
				f,
				op,
				{ ownBasic, sharers: new Map() },
				relationship,
			).filter((r) => r.reason !== "several-cases");
			if (
				reasons.length === 0 &&
				(relationship === "extension" || f.severalCases)
			)
				return {
					kind: "basic",
					extension: relationship === "extension",
					inSource: true,
				};
		}
		return { kind: "save-to-case" };
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
		const claims = new Map<number, Uuid[]>();
		for (const op of basic) {
			const choice = choices.get(op.uuid);
			if (
				choice?.kind === "basic" &&
				choice.held?.kind === "basic" &&
				choice.held.slot === "subcase"
			)
				claims.set(choice.held.index, [
					...(claims.get(choice.held.index) ?? []),
					op.uuid,
				]);
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
							(claims.get(choice.held.index)?.length ?? 0) > 1);
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
			const choice = choices.get(op.uuid);
			if (
				choice?.kind === "basic" &&
				choice.held?.kind === "basic" &&
				choice.held.slot === "subcase"
			) {
				indexOf.set(op.uuid, choice.held.index);
				taken.add(choice.held.index);
			}
		}
		let next = 0;
		for (const op of basic) {
			if (indexOf.has(op.uuid)) continue;
			while (taken.has(next)) next++;
			indexOf.set(op.uuid, next);
			taken.add(next);
		}
		subcases = basic
			.map((op) => ({
				operationUuid: op.uuid,
				index: indexOf.get(op.uuid) ?? 0,
				row: isRow(op),
				extension:
					(choices.get(op.uuid) as { extension?: boolean }).extension === true,
				inSource:
					(choices.get(op.uuid) as { inSource?: boolean }).inSource === true,
			}))
			.sort((a, b) => a.index - b.index);
		break;
	}
	const subcaseByUuid = new Map(subcases.map((s) => [s.operationUuid, s]));
	for (const op of creates) {
		const choice = choices.get(op.uuid);
		const subcase = subcaseByUuid.get(op.uuid);
		if (choice?.kind === "basic" && subcase !== undefined) {
			if (subcase.inSource) {
				const scope =
					op.forEach === undefined
						? FormPath.root()
						: (repeatRowPath(f.doc, f.formUuid, op.forEach.repeat) ??
							FormPath.root());
				// In a several-case form the block runs once per selected case,
				// in the selected-case row's operations group, named in the
				// operations namespace of its authored scope.
				const path: SaveToCasePlacement["path"] = f.severalCases
					? [
							nodes.selectedCases(scope),
							"item",
							nodes.operations(
								scope.child(nodes.selectedCases(scope)).child("item"),
							),
							nodes.subcase(subcase.index, scope),
						]
					: [nodes.subcases(scope), nodes.subcase(subcase.index)];
				placements.set(op.uuid, {
					placement: {
						kind: "save-to-case",
						...(op.forEach !== undefined && { repeat: op.forEach.repeat }),
						path,
					},
					held: false,
				});
			} else {
				const placement: CasePlacement = subcase.row
					? { kind: "basic", slot: "subcase-row" }
					: { kind: "basic", slot: "subcase", index: subcase.index };
				placements.set(op.uuid, { placement, held: choice.held !== undefined });
			}
		} else {
			placements.set(
				op.uuid,
				choice?.kind === "save-to-case" && choice.planned !== undefined
					? choice.planned
					: { placement: derivedPath(asSubject(op)), held: false },
			);
		}
	}

	// Every other operation: a close sharing a basic subcase, else its own
	// Save to Case block.
	const sharedBy = new Map<Uuid, Uuid>();
	for (const [createUuid, close] of sharers)
		sharedBy.set(close.uuid, createUuid);
	for (const op of f.operations) {
		if (placements.has(op.uuid)) continue;
		const createUuid = sharedBy.get(op.uuid);
		const shared =
			createUuid === undefined ? undefined : placements.get(createUuid);
		const subcase =
			createUuid === undefined ? undefined : subcaseByUuid.get(createUuid);
		if (
			createUuid !== undefined &&
			shared !== undefined &&
			shared.placement.kind === "basic" &&
			subcase !== undefined &&
			!subcase.inSource
		) {
			placements.set(op.uuid, {
				placement: shared.placement,
				held:
					op.placement !== undefined &&
					samePlacement(op.placement, shared.placement),
				sharesWith: createUuid,
			});
			continue;
		}
		placements.set(
			op.uuid,
			keepSaveToCase(asSubject(op), op.placement) ?? {
				placement: derivedPath(asSubject(op)),
				held: false,
			},
		);
	}

	// The own close (§12.6): its own held block first; else the own arm's
	// place where that place can carry it; else a close-only block.
	if (f.closesOwn && f.own !== undefined) {
		const ownCloseSubject: PlacementSubject = { kind: "own-close" };
		const held = f.form.ownClosePlacement;
		const ownPlanned = placements.get(f.own.uuid);
		const keptHeld =
			held === undefined
				? undefined
				: ownCloseReasons(f, { kind: "save-to-case", path: held.path })
							.length === 0
					? {
							placement: { kind: "save-to-case", path: held.path } as const,
							held: true,
						}
					: undefined;
		const shares =
			ownPlanned !== undefined &&
			(ownPlanned.placement.kind === "basic"
				? stateCondition(f, f.form.closeCondition, {
						own: true,
						repeat: undefined,
					}).reasons.length === 0
				: !f.severalCases);
		placements.set(
			"own-close",
			keptHeld ??
				(shares && ownPlanned !== undefined && f.own !== undefined
					? {
							placement: ownPlanned.placement,
							held: false,
							sharesWith: f.own.uuid,
						}
					: { placement: derivedPath(ownCloseSubject), held: false }),
		);
	}
	return { placements, subcases, ownBasic, sharers };
}

function ownCloseReasons(
	f: FormFacts,
	placement: CasePlacement,
): PlacementIneligibility[] {
	if (!f.closesOwn) return [{ reason: "no-close" }];
	if (placement.kind !== "save-to-case") return [SUBJECT_CANNOT_HOLD];
	return saveToCaseReasons(f, { kind: "own-close" }, placement);
}

/**
 * The relationship of the child `planFieldCaseWrite` writes for a field:
 * one link to the own case and a name read bare. Until advanced modules are
 * emitted an extension child, and any such child of a several-case form,
 * keeps today's wire: HQ's subcase, which writes nothing, beside an active
 * Save to Case block (part 02 §14.4, part 01 departure 27).
 */
function fieldWrittenRelationship(
	operation: CaseOperation,
): "child" | "extension" | undefined {
	const links = operation.links ?? [];
	const relationship = links[0]?.relationship;
	return operation.action === "create" &&
		links.length === 1 &&
		(relationship === "child" || relationship === "extension") &&
		operation.name !== undefined &&
		bareRead(operation.name) !== undefined
		? relationship
		: undefined;
}

function samePlacement(a: CasePlacement, b: CasePlacement): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The Save to Case place today's allocator gives a subject: the wrappers of
 * `saveToCaseBlockShape`, each named by `planGeneratedNodes` (which has
 * reserved every held path's segment first), and the block named by the
 * operation's id.
 */
function derivedSaveToCase(
	f: FormFacts,
	subject: PlacementSubject,
	nodes: ReturnType<typeof planGeneratedNodes>,
): SaveToCasePlacement {
	const operation =
		subject.kind === "operation"
			? f.operations.find((op) => op.uuid === subject.operationUuid)
			: undefined;
	const repeat = operation?.forEach?.repeat;
	let scope =
		repeat === undefined
			? FormPath.root()
			: (repeatRowPath(f.doc, f.formUuid, repeat) ?? FormPath.root());
	const authoredScope = scope;
	const segments: string[] = [];
	for (const segment of saveToCaseBlockShape(f.doc, f.formUuid, subject)) {
		let name: string;
		switch (segment) {
			case "selected-cases":
				name = nodes.selectedCases(authoredScope);
				break;
			case "selected-case":
				name = "item";
				break;
			case "operations":
				name = nodes.operations(scope);
				break;
			case "keyed":
				if (subject.kind !== "operation")
					throw new Error(
						`Nova gave the own close of form ${f.formUuid} a keyed row. Only a create keyed by an answer stands in one.`,
					);
				name = nodes.keyed(subject.operationUuid);
				break;
			case "condition":
				name =
					subject.kind === "own-close"
						? nodes.conditionClose()
						: operation?.action === "own"
							? nodes.conditionUpdateSelectedCases()
							: nodes.condition(subject.operationUuid);
				break;
			case "block":
				name =
					subject.kind === "own-close"
						? f.severalCases
							? nodes.closeSelectedCases()
							: nodes.close()
						: operation?.action === "own" && f.severalCases
							? nodes.updateSelectedCases()
							: (operation?.id ?? "");
				break;
		}
		segments.push(name);
		scope = scope.child(name);
	}
	const [first, ...rest] = segments;
	if (first === undefined)
		throw new Error(
			`Nova found no Save to Case path for a case change of form ${f.formUuid}. Every block stands in an operations group, so its path has at least two segments.`,
		);
	return {
		kind: "save-to-case",
		...(repeat !== undefined && subject.kind === "operation" && { repeat }),
		path: [first, ...rest],
	};
}

// ── The readers ─────────────────────────────────────────────────────────

const plans = new WeakMap<BlueprintDoc, Map<string, CorePlan>>();

function corePlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
	options: PlanPlacementsOptions | undefined,
	forceBasic?: Uuid,
): CorePlan {
	const exclude = [...(options?.excludeBasic ?? [])].sort();
	const key = `${formUuid}\u0000${options?.moduleKind ?? "basic"}\u0000${exclude.join(",")}\u0000${forceBasic ?? ""}`;
	let forms = plans.get(doc);
	if (forms === undefined) {
		forms = new Map();
		plans.set(doc, forms);
	}
	const known = forms.get(key);
	if (known !== undefined) return known;
	const f = formFacts(doc, formUuid);
	const plan = planCore(f, {
		exclude: new Set([...sameTypeExclusions(f), ...exclude]),
		...(forceBasic !== undefined && { forceBasic }),
	});
	forms.set(key, plan);
	return plan;
}

/** Where each case change of `formUuid` is kept in CommCare HQ. */
export function planPlacements(
	doc: BlueprintDoc,
	formUuid: Uuid,
	options?: PlanPlacementsOptions,
): FormPlacements {
	return {
		formKind: "basic",
		placements: corePlan(doc, formUuid, options).placements,
	};
}

/**
 * Whether a basic action carries the operation `operationUuid` of `formUuid`,
 * or the own case's change, wherever it is placed: the questions such an
 * action reads a case name or an external id from take the trimmed sibling
 * (`lib/domain/caseScalarTextGuard.ts`), where any other Save to Case block
 * trims and checks its own values.
 */
export function placedBasic(
	doc: BlueprintDoc,
	formUuid: Uuid,
): (operationUuid: Uuid) => boolean {
	const { placements } = planPlacements(doc, formUuid);
	// An inert subcase (an extension child, or a child of a several-case
	// form) keeps its place in `subcases` while its create is a block in the
	// source, so its action still names the question's trimmed sibling, as
	// the own case's change does in a several-case form, whose wrapper per
	// selected case reads it.
	const subcases = new Set(
		planBasicSubcases(doc, formUuid).map((subcase) => subcase.operationUuid),
	);
	const own = doc.forms[formUuid]?.caseOperations?.find(
		(operation) => operation.action === "own",
	)?.uuid;
	return (operationUuid) =>
		operationUuid === own ||
		placements.get(operationUuid)?.placement.kind === "basic" ||
		subcases.has(operationUuid);
}

/** The basic subcases of `formUuid`, in `subcases` index order. */
export function planBasicSubcases(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly PlannedBasicSubcase[] {
	return corePlan(doc, formUuid, undefined).subcases;
}

const appPlans = new WeakMap<BlueprintDoc, ReadonlyMap<Uuid, FormPlacements>>();

/** Every form's placements, in module and form order. */
export function appPlacements(
	doc: BlueprintDoc,
): ReadonlyMap<Uuid, FormPlacements> {
	const known = appPlans.get(doc);
	if (known !== undefined) return known;
	const all = new Map<Uuid, FormPlacements>();
	for (const moduleUuid of doc.moduleOrder)
		for (const formUuid of doc.formOrder[moduleUuid] ?? [])
			if (doc.forms[formUuid] !== undefined)
				all.set(formUuid, planPlacements(doc, formUuid));
	appPlans.set(doc, all);
	return all;
}

/**
 * Why `placement` cannot express `subject` on the document as it stands,
 * every failed condition in table order; empty when it can.
 */
export function placementIneligibility(
	doc: BlueprintDoc,
	formUuid: Uuid,
	subject: PlacementSubject,
	placement: CasePlacement,
): readonly PlacementIneligibility[] {
	const f = formFacts(doc, formUuid);
	if (subject.kind === "own-close") return ownCloseReasons(f, placement);
	const operation = f.operations.find(
		(op) => op.uuid === subject.operationUuid,
	);
	if (operation === undefined)
		throw new Error(
			`Nova was asked where the case change ${subject.operationUuid} of form ${formUuid} can be kept, and the form holds no such change.`,
		);
	if (placement.kind === "save-to-case")
		return saveToCaseReasons(f, subject, placement);
	switch (placement.slot) {
		case "own":
			return ownSlotReasons(f, operation);
		case "usercase": {
			const reasons = usercaseSlotReasons(f, operation);
			const first = f.operations.find(isWorkerRecordUpdate);
			return first !== undefined && first.uuid !== operation.uuid
				? [...reasons, SUBJECT_CANNOT_HOLD]
				: reasons;
		}
		case "subcase":
		case "subcase-row": {
			const plan = corePlan(doc, formUuid, undefined);
			const reasons = subcaseReasons(
				f,
				operation,
				{ ownBasic: plan.ownBasic, sharers: plan.sharers },
				"child",
			);
			if (reasons.some((r) => r.reason === "scope")) return reasons;
			const others = plan.subcases.filter(
				(s) => s.operationUuid !== operation.uuid,
			);
			const k = others.length + 1;
			const repeat = operation.forEach?.repeat;
			const inRepeat =
				repeat === undefined
					? 0
					: others.filter(
							(s) =>
								f.operations.find((op) => op.uuid === s.operationUuid)?.forEach
									?.repeat === repeat,
						).length + 1;
			const row = inRepeat === 1;
			if (placement.slot === "subcase") {
				const claimed = others.some((s) => {
					const held = f.operations.find(
						(op) => op.uuid === s.operationUuid,
					)?.placement;
					return (
						held?.kind === "basic" &&
						held.slot === "subcase" &&
						held.index === placement.index &&
						s.index === placement.index
					);
				});
				if (placement.index >= k || claimed)
					reasons.push({ reason: "subcase-index" });
				if (row) reasons.push({ reason: "subcase-nesting" });
			} else if (!row) reasons.push({ reason: "subcase-nesting" });
			return reasons;
		}
	}
}

export function placementExpresses(
	doc: BlueprintDoc,
	formUuid: Uuid,
	subject: PlacementSubject,
	placement: CasePlacement,
): boolean {
	return placementIneligibility(doc, formUuid, subject, placement).length === 0;
}

/**
 * The placements eligible for `subject` on the document as it stands,
 * simplest first: a basic slot, then Save to Case, each with the index or
 * path the procedure would give it.
 */
export function placementCandidates(
	doc: BlueprintDoc,
	formUuid: Uuid,
	subject: PlacementSubject,
): readonly CasePlacement[] {
	const f = formFacts(doc, formUuid);
	const plan = corePlan(doc, formUuid, undefined);
	const nodes = planGeneratedNodes(doc, formUuid);
	if (subject.kind === "own-close") {
		if (!f.closesOwn || f.own === undefined) return [];
		const planned = plan.placements.get("own-close");
		return [
			planned !== undefined && planned.sharesWith === undefined
				? planned.placement
				: derivedSaveToCase(f, subject, nodes),
		];
	}
	const operation = f.operations.find(
		(op) => op.uuid === subject.operationUuid,
	);
	const planned = plan.placements.get(subject.operationUuid);
	if (operation === undefined || planned === undefined) return [];
	const saveToCase =
		planned.placement.kind === "save-to-case"
			? planned.placement
			: derivedSaveToCase(f, subject, nodes);
	const basic: CasePlacement[] = [];
	if (operation.action === "own" && ownSlotReasons(f, operation).length === 0)
		basic.push({ kind: "basic", slot: "own" });
	if (
		isWorkerRecordUpdate(operation) &&
		f.operations.find(isWorkerRecordUpdate)?.uuid === operation.uuid &&
		usercaseSlotReasons(f, operation).length === 0
	)
		basic.push({ kind: "basic", slot: "usercase" });
	if (operation.action === "create") {
		if (planned.placement.kind === "basic") basic.push(planned.placement);
		else if (
			subcaseReasons(
				f,
				operation,
				{ ownBasic: plan.ownBasic, sharers: plan.sharers },
				"child",
			).length === 0
		) {
			const forced = corePlan(
				doc,
				formUuid,
				undefined,
				operation.uuid,
			).placements.get(operation.uuid);
			if (forced?.placement.kind === "basic") basic.push(forced.placement);
		}
	}
	return [...basic, saveToCase];
}
