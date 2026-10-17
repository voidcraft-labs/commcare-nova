/**
 * The one allocator for every name Nova mints in a form's data tree.
 *
 * Nova's authored content is questions, case operations and Connect blocks;
 * every other node of a form's source is generated, and every generated name
 * is `nova_<purpose>...`, starting with a letter, from this plan. Nova
 * reserves no question names for its own nodes: an author may name a
 * question `nova_url_x`, and the allocator steps around it.
 *
 * The plan is a pure function of the document, so two exports of one
 * document agree, and the XForm builder, the case-operation emitter and
 * `formActions.ts` read one plan and cannot disagree about a node's name.
 * Lookups are by purpose and owner identity, never by path. A document is
 * never changed in place (the store replaces its snapshot on every commit),
 * so each form's plan is made once per document object and every reader of
 * that document gets the same plan.
 *
 * The collision rule:
 *
 * - **Base.** `nova_<purpose>_<owner id>[_<ordinal or kind>]`, or the fixed
 *   name of a container. A keyed create's count node is `nova_count_`
 *   followed by its repeat's own name, the rule every count node follows.
 * - **Scope.** One namespace per parent element. A question's generated
 *   siblings share the namespace of the question's container (a query
 *   repeat's `item` is its own). Every name inside the `nova_operations`
 *   groups of one authored scope shares one namespace, including names nested
 *   in condition groups and keyed repeats, so adding or removing a condition
 *   never renames a node; the selected-cases group of that scope shares it.
 * - **Taken before any allocation.** Every authored name in the scope: every
 *   sibling question id, earlier or later; at the form root, the form's
 *   Connect block ids; in an operations namespace, the id of every case
 *   operation of that scope.
 * - **Suffix.** A base that is taken becomes `<base>_<n>` for the smallest
 *   `n >= 1` not taken.
 * - **Order**, each allocation joining the taken set: questions in field
 *   order, and for one question its constraint counts by ordinal, its
 *   constraint message, its url, its datetime, then (a repeat) its count;
 *   then the scope's containers `nova_operations`, `nova_subcases`,
 *   `nova_selected_cases`. Inside an operations namespace: operations in
 *   their authored order, each `nova_count_nova_keyed_`, then `nova_keyed_`,
 *   then `nova_condition_`, then guards in the order `type`, `retype`,
 *   `text`; then `nova_condition_update_selected_cases`,
 *   `nova_update_selected_cases`, `nova_subcase_<n>` ascending and
 *   `nova_close_selected_cases`.
 *
 * A generated name moves only when its owner is renamed or an authored
 * sibling equal to it appears or disappears, both edits to the same form.
 */

import { readFieldString } from "@/lib/commcare/fieldProps";
import { commCareLocalization } from "@/lib/commcare/localization";
import { caseOperationConditionalGuardUuids } from "@/lib/doc/caseOperationOrder";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Field,
	fieldExpressionValue,
	fieldKindCarriesValidation,
	isCaptureField,
	isContainer,
	makeTranslationUnitId,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { fieldValueType } from "@/lib/domain/fieldValueType";
import { directRepeatCountReference } from "@/lib/domain/repeatCount";
import { planConstraintCollections } from "./constraintCollections";
import { constraintMessageNeedsProtection } from "./constraintMessage";
import { descendFormPathIntoField, FormPath } from "./formPath";

/** The guards an operation's block may carry, in the order they stand. */
export const GUARD_KINDS = ["type", "retype", "text"] as const;
export type GuardKind = (typeof GUARD_KINDS)[number];

/** What a generated node is for, as `nodes` lists it. */
export type GeneratedNodePurpose =
	| "constraint-count"
	| "constraint-message"
	| "url"
	| "datetime"
	| "count"
	| "keyed-count"
	| "keyed"
	| "condition"
	| "guard";

export interface GeneratedNode {
	readonly purpose: GeneratedNodePurpose;
	readonly name: string;
	/** The owning question's or operation's uuid. */
	readonly owner: Uuid;
}

export interface GeneratedNodePlan {
	/** The `ordinal`th count lifted out of a question's validation. */
	constraintCount(fieldUuid: Uuid, ordinal: number): string;
	/** The sibling that carries a protected validation message's itext. */
	constraintMessage(fieldUuid: Uuid): string;
	/** The sibling holding a URL-mode capture's case-bound address. */
	url(fieldUuid: Uuid): string;
	/** The sibling holding a datetime answer's case value as text. */
	datetime(fieldUuid: Uuid): string;
	/**
	 * A count-bound repeat's calculated count. A repeat whose count reads a
	 * question directly has no count node; this is the name its count would
	 * take, which a reader may use as the count's evaluation context.
	 */
	count(repeatUuid: Uuid): string;
	/** The operations group of an authored scope, the form root or a repeat. */
	operations(scope: FormPath): string;
	/** The extension-subcase group of an authored scope. */
	subcases(scope: FormPath): string;
	/** The selected-cases repeat of an authored scope. */
	selectedCases(scope: FormPath): string;
	/** The one-row repeat around a root create keyed by an answer. */
	keyed(operationUuid: Uuid): string;
	/** That repeat's count node. */
	keyedCount(operationUuid: Uuid): string;
	/** The group whose relevance carries an operation's condition. */
	condition(operationUuid: Uuid): string;
	/** One of an operation's update-only guard blocks. */
	guard(operationUuid: Uuid, kind: GuardKind): string;
	/**
	 * The `n`th source-lowered subcase block: in the operations namespace of
	 * `operationsScope` when it stands in a selected-cases group, otherwise in
	 * its own `nova_subcases` group, which holds no authored name.
	 */
	subcase(n: number, operationsScope?: FormPath): string;
	/** The shared update of every selected case, at the form root. */
	updateSelectedCases(): string;
	/** The group whose relevance gates that shared update. */
	conditionUpdateSelectedCases(): string;
	/** The close of every selected case, at the form root. */
	closeSelectedCases(): string;
	/** Every question- and operation-owned node the plan allocated. */
	readonly nodes: readonly GeneratedNode[];
}

/** A write to `external_id`, the one fixed text column an operation's
 * writes reach: its value is normalized and held by the text guard. */
export function writesFixedTextColumn(write: { property: string }): boolean {
	return write.property === "external_id";
}

/**
 * The guards an operation's block carries, in the order they stand. A type
 * guard holds each link to a case an expression names to that link's type;
 * a retype guard keeps an authored-key id from being retyped; a text guard
 * refuses a fixed-column value Core and HQ would trim, cap or leave blank.
 */
export function operationGuardKinds(operation: CaseOperation): GuardKind[] {
	const kinds: GuardKind[] = [];
	if (
		(operation.links ?? []).some((link) => link.target?.kind === "expression")
	)
		kinds.push("type");
	if (
		operation.action === "update" &&
		operation.retype !== undefined &&
		operation.retype !== operation.caseType
	)
		kinds.push("retype");
	if (
		operation.action === "create" ||
		operation.rename !== undefined ||
		(operation.action === "update" && operation.owner !== undefined) ||
		(operation.writes ?? []).some(writesFixedTextColumn)
	)
		kinds.push("text");
	return kinds;
}

/**
 * A create at the form root whose id is built from an answer. Its block sits
 * in a one-row repeat, the one place HQ's form builder keeps a create's id as
 * a live bind.
 */
export function isKeyedRootCreate(operation: CaseOperation): boolean {
	return (
		operation.action === "create" &&
		operation.forEach === undefined &&
		operation.target.kind === "new" &&
		operation.target.idFrom !== undefined
	);
}

/** The Connect block ids a form's data root holds. */
export function formConnectIds(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlySet<string> {
	const connect = doc.forms[formUuid]?.connect;
	if (connect === undefined || doc.connectType === null) return new Set();
	return new Set(
		[
			"learn_module" in connect ? connect.learn_module?.id : undefined,
			"assessment" in connect ? connect.assessment?.id : undefined,
			"deliver_unit" in connect ? connect.deliver_unit?.id : undefined,
			"task" in connect ? connect.task?.id : undefined,
		].filter((id): id is string => id !== undefined),
	);
}

/** The name a count-bound repeat's count node takes beside no collision. */
export function repeatCountBaseName(repeatId: string): string {
	return `nova_count_${repeatId}`;
}

const OPERATIONS = "nova_operations";
const SUBCASES = "nova_subcases";
const SELECTED_CASES = "nova_selected_cases";
const UPDATE_SELECTED_CASES = "nova_update_selected_cases";
const CLOSE_SELECTED_CASES = "nova_close_selected_cases";

/** One parent element's names: authored ones first, then each allocation. */
class Namespace {
	private readonly taken: Set<string>;
	constructor(authored: Iterable<string>) {
		this.taken = new Set(authored);
	}
	/** The first free spelling of `base`, without taking it. */
	peek(base: string): string {
		let name = base;
		for (let n = 1; this.taken.has(name); n++) name = `${base}_${n}`;
		return name;
	}
	allocate(base: string): string {
		const name = this.peek(base);
		this.taken.add(name);
		return name;
	}
}

const plans = new WeakMap<BlueprintDoc, Map<Uuid, GeneratedNodePlan>>();

/** The form's plan of generated nodes, made once per document object. */
export function planGeneratedNodes(
	doc: BlueprintDoc,
	formUuid: Uuid,
): GeneratedNodePlan {
	let forms = plans.get(doc);
	if (forms === undefined) {
		forms = new Map();
		plans.set(doc, forms);
	}
	let plan = forms.get(formUuid);
	if (plan === undefined) {
		plan = allocateGeneratedNodes(doc, formUuid);
		forms.set(formUuid, plan);
	}
	return plan;
}

function allocateGeneratedNodes(
	doc: BlueprintDoc,
	formUuid: Uuid,
): GeneratedNodePlan {
	const form = doc.forms[formUuid];
	if (form === undefined)
		throw new Error(
			`Nova was asked to name the generated nodes of form ${formUuid}, which the app does not hold.`,
		);
	const nodes: GeneratedNode[] = [];
	const byOwner = new Map<string, string>();
	const ownerKey = (purpose: GeneratedNodePurpose, owner: Uuid, part = "") =>
		`${purpose}\u0000${owner}\u0000${part}`;
	const record = (
		purpose: GeneratedNodePurpose,
		owner: Uuid,
		name: string,
		part = "",
	): void => {
		byOwner.set(ownerKey(purpose, owner, part), name);
		nodes.push({ purpose, name, owner });
	};

	let localization: ReturnType<typeof commCareLocalization> | undefined;
	const protectsMessage = (field: Field): boolean => {
		if (!fieldKindCarriesValidation(field.kind)) return false;
		if ((field as { validate_msg?: unknown }).validate_msg === undefined)
			return false;
		localization ??= commCareLocalization(doc);
		const unitId = makeTranslationUnitId("field", field.uuid, "validate_msg");
		const active = localization;
		return constraintMessageNeedsProtection(
			active.languages.map((language) => active.prose(language, unitId)),
		);
	};

	// Field namespaces: one per container's child element, in field order.
	const fieldScopes = new Map<string, Namespace>();
	const countBases = new Map<Uuid, { scope: Namespace; base: string }>();
	const repeatScopes = new Map<Uuid, FormPath>();
	const walk = (parentUuid: Uuid, parentPath: FormPath, root: boolean) => {
		const children = orderedFieldUuids(doc, parentUuid).flatMap((uuid) => {
			const field = doc.fields[uuid];
			return field === undefined ? [] : [field];
		});
		const scope = new Namespace([
			...children.map((field) => field.id),
			...(root ? formConnectIds(doc, formUuid) : []),
		]);
		fieldScopes.set(parentPath.toXPath(), scope);
		for (const field of children) {
			const path = parentPath.child(field.id);
			const validate = readFieldString(field, "validate", doc);
			const expression = fieldExpressionValue(field, "validate");
			if (fieldKindCarriesValidation(field.kind) && validate && expression) {
				planConstraintCollections(expression, field.uuid, doc, path, (n) => {
					const name = scope.allocate(`nova_constraint_${field.id}_${n}`);
					record("constraint-count", field.uuid, name, String(n));
					return name;
				});
			}
			if (protectsMessage(field))
				record(
					"constraint-message",
					field.uuid,
					scope.allocate(`nova_constraint_message_${field.id}`),
				);
			if (isCaptureField(field) && field.caseWrite?.mode === "url")
				record("url", field.uuid, scope.allocate(`nova_url_${field.id}`));
			if (
				"caseWrite" in field &&
				field.caseWrite !== undefined &&
				fieldValueType(field, effectiveCaseTypes(doc)) === "datetime"
			)
				record(
					"datetime",
					field.uuid,
					scope.allocate(`nova_datetime_${field.id}`),
				);
			if (field.kind === "repeat" && field.repeat_mode === "count_bound") {
				const base = repeatCountBaseName(field.id);
				if (directRepeatCountReference(field.repeat_count, doc.fields))
					countBases.set(field.uuid, { scope, base });
				else record("count", field.uuid, scope.allocate(base));
			}
		}
		for (const field of children) {
			if (!isContainer(field)) continue;
			const childPath = descendFormPathIntoField(
				field,
				parentPath.child(field.id),
			);
			walk(field.uuid, childPath, false);
			if (field.kind === "repeat") repeatScopes.set(field.uuid, childPath);
		}
	};
	walk(formUuid, FormPath.root(), true);

	// Each scope's containers, after its questions' generated siblings.
	const containers = new Map<
		string,
		{ operations: string; subcases: string; selectedCases: string }
	>();
	for (const scopePath of [FormPath.root(), ...repeatScopes.values()]) {
		const scope = fieldScopes.get(scopePath.toXPath()) ?? new Namespace([]);
		containers.set(scopePath.toXPath(), {
			operations: scope.allocate(OPERATIONS),
			subcases: scope.allocate(SUBCASES),
			selectedCases: scope.allocate(SELECTED_CASES),
		});
	}

	// Operations namespaces: one per authored scope.
	const operations = orderedCaseOperations(form);
	const scopeOf = (operation: CaseOperation): string => {
		const repeat = operation.forEach?.repeat;
		return (
			repeat === undefined
				? FormPath.root()
				: (repeatScopes.get(repeat) ?? FormPath.root())
		).toXPath();
	};
	const operationScopes = new Map<string, Namespace>();
	for (const operation of operations) {
		const key = scopeOf(operation);
		if (!operationScopes.has(key)) {
			operationScopes.set(
				key,
				new Namespace(
					operations
						.filter((candidate) => scopeOf(candidate) === key)
						.map((candidate) => candidate.id),
				),
			);
		}
	}
	const operationNamespace = (scopePath: string): Namespace => {
		let scope = operationScopes.get(scopePath);
		if (scope === undefined) {
			scope = new Namespace([]);
			operationScopes.set(scopePath, scope);
		}
		return scope;
	};
	const operationByUuid = new Map(
		operations.map((operation) => [operation.uuid, operation]),
	);
	const inheritedGuards = caseOperationConditionalGuardUuids(
		doc,
		formUuid,
		operations,
	);
	for (const operation of operations) {
		const scope = operationNamespace(scopeOf(operation));
		if (isKeyedRootCreate(operation)) {
			const keyedBase = `nova_keyed_${operation.id}`;
			// The count node is named for the repeat, whose own name is taken
			// next; both join the namespace before anything else of the operation.
			const keyed = scope.peek(keyedBase);
			record(
				"keyed-count",
				operation.uuid,
				scope.allocate(`nova_count_${keyed}`),
			);
			record("keyed", operation.uuid, scope.allocate(keyedBase));
		}
		const conditional =
			operation.condition !== undefined ||
			[...(inheritedGuards.get(operation.uuid) ?? [])].some(
				(uuid) => operationByUuid.get(uuid)?.condition !== undefined,
			);
		if (conditional)
			record(
				"condition",
				operation.uuid,
				scope.allocate(`nova_condition_${operation.id}`),
			);
		for (const kind of operationGuardKinds(operation))
			record(
				"guard",
				operation.uuid,
				scope.allocate(`nova_guard_${operation.id}_${kind}`),
				kind,
			);
	}
	const root = FormPath.root().toXPath();
	const rootOperations = operationNamespace(root);
	const conditionUpdateSelectedCases = rootOperations.allocate(
		`nova_condition_${UPDATE_SELECTED_CASES.slice("nova_".length)}`,
	);
	const updateSelectedCases = rootOperations.allocate(UPDATE_SELECTED_CASES);
	const closeSelectedCases = rootOperations.peek(CLOSE_SELECTED_CASES);

	const lookup = (
		purpose: GeneratedNodePurpose,
		owner: Uuid,
		part = "",
	): string => {
		const name = byOwner.get(ownerKey(purpose, owner, part));
		if (name === undefined)
			throw new Error(
				`Nova looked for the ${purpose} node of ${owner}${part ? ` (${part})` : ""} in form ${formUuid}, and the form's plan of generated nodes holds none. The emitter and the plan must agree on which nodes a form has.`,
			);
		return name;
	};
	const container = (scope: FormPath) =>
		containers.get(scope.toXPath()) ?? {
			operations: OPERATIONS,
			subcases: SUBCASES,
			selectedCases: SELECTED_CASES,
		};

	return {
		constraintCount: (fieldUuid, ordinal) =>
			lookup("constraint-count", fieldUuid, String(ordinal)),
		constraintMessage: (fieldUuid) => lookup("constraint-message", fieldUuid),
		url: (fieldUuid) => lookup("url", fieldUuid),
		datetime: (fieldUuid) => lookup("datetime", fieldUuid),
		count: (repeatUuid) => {
			const planned = byOwner.get(ownerKey("count", repeatUuid));
			if (planned !== undefined) return planned;
			const direct = countBases.get(repeatUuid);
			if (direct !== undefined) return direct.scope.peek(direct.base);
			return lookup("count", repeatUuid);
		},
		operations: (scope) => container(scope).operations,
		subcases: (scope) => container(scope).subcases,
		selectedCases: (scope) => container(scope).selectedCases,
		keyed: (operationUuid) => lookup("keyed", operationUuid),
		keyedCount: (operationUuid) => lookup("keyed-count", operationUuid),
		condition: (operationUuid) => lookup("condition", operationUuid),
		guard: (operationUuid, kind) => lookup("guard", operationUuid, kind),
		subcase: (n, operationsScope) =>
			operationsScope === undefined
				? `nova_subcase_${n}`
				: operationNamespace(operationsScope.toXPath()).peek(
						`nova_subcase_${n}`,
					),
		updateSelectedCases: () => updateSelectedCases,
		conditionUpdateSelectedCases: () => conditionUpdateSelectedCases,
		closeSelectedCases: () => closeSelectedCases,
		nodes,
	};
}
