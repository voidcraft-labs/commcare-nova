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
 *   repeat's `item` is its own, and so is its wrapper, whose only authored
 *   name is `item`). Every name inside the `nova_operations`
 *   groups of one authored scope shares one namespace, including names nested
 *   in condition groups and keyed repeats, so adding or removing a condition
 *   never renames a node; the selected-cases group of that scope shares it.
 * - **Taken before any allocation.** Every authored name in the scope: every
 *   sibling question id, earlier or later; at the form root, the form's
 *   Connect block ids; in an operations namespace, the id of every case
 *   operation of that scope. And every segment of every held Save to Case
 *   path of the form (an operation's `placement`, the form's
 *   `ownClosePlacement`): the first in its scope, the rest in that scope's
 *   operations namespace. A held segment names its owner's own node and a
 *   container of that name names the scope's container, so neither moves;
 *   any other base it takes gets a suffix.
 * - **Suffix.** A base that is taken becomes `<base>_<n>` for the smallest
 *   `n >= 1` not taken.
 * - **Order**, each allocation joining the taken set: in a query repeat's
 *   wrapper, `nova_query_ids_`, `nova_query_count_`, `nova_query_position_`;
 *   in its row, `nova_query_id_` and `nova_query_index_`, before any node an
 *   authored child of the row owns; then questions in field order, and for
 *   one question its constraint counts by ordinal, its constraint message,
 *   its url, its datetime, its trimmed value, then (a count repeat) its
 *   count; then the scope's containers `nova_operations`, `nova_subcases`,
 *   `nova_selected_cases`. Inside an operations namespace: operations in
 *   their authored order, each `nova_count_nova_keyed_`, then `nova_keyed_`,
 *   then `nova_condition_`, then guards in the order `type`, `retype`,
 *   `text`; then `nova_condition_update_selected_cases`,
 *   `nova_update_selected_cases`, `nova_subcase_<n>` ascending,
 *   `nova_close_selected_cases`, `nova_condition_close` and `nova_close`.
 *
 * A selected-cases repeat inside an authored repeat takes the count
 * placement, its nodes `nova_query_ids_`, `nova_query_count_` (the wrapper)
 * and `nova_query_id_`, `nova_query_index_` (the row) followed by the
 * repeat's own name
 * (`caseOps.ts::selectedCountPlacementNames`): nothing authored shares
 * either namespace, so they need no allocation.
 *
 * A query repeat's five names and a count repeat's count are reserved from
 * the form's structure alone (`queryRepeatNames.ts`, `repeatCountNames.ts`),
 * whatever the repeat's placement and whether or not an expression reads the
 * node, so no generated name depends on what an expression reads.
 *
 * A generated name moves only when its owner is renamed or an authored
 * sibling equal to it appears or disappears, both edits to the same form.
 */

import { commCareLocalization } from "@/lib/commcare/localization";
import { caseOperationConditionalGuardUuids } from "@/lib/doc/caseOperationOrder";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseScalarTextGuards,
	expressionSlotValue,
	type Field,
	fieldKindCarriesValidation,
	formCaseWriteViews,
	formConnectIds,
	isCaptureField,
	isContainer,
	makeTranslationUnitId,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { fieldValueType } from "@/lib/domain/fieldValueType";
import { planConstraintCollections } from "./constraintCollections";
import { constraintMessageNeedsProtection } from "./constraintMessage";
import { descendFormPathIntoField, FormPath } from "./formPath";
import { Namespace } from "./namespace";
import { planQueryRepeatNames } from "./queryRepeatNames";
import { planRepeatCountNames } from "./repeatCountNames";

export { queryRepeatBaseNames } from "./queryRepeatNames";
export { repeatCountBaseName } from "./repeatCountNames";

/** The guards an operation's block may carry, in the order they stand. */
export const GUARD_KINDS = ["type", "retype", "text"] as const;
export type GuardKind = (typeof GUARD_KINDS)[number];

/** What a generated node is for, as `nodes` lists it. */
export type GeneratedNodePurpose =
	| "constraint-count"
	| "constraint-message"
	| "url"
	| "datetime"
	| "trimmed"
	| "count"
	| "query-ids"
	| "query-count"
	| "query-position"
	| "query-id"
	| "query-index"
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
	/** The sibling holding the link a capture writes to its case. */
	url(fieldUuid: Uuid): string;
	/** The sibling holding a datetime answer's case value as text. */
	datetime(fieldUuid: Uuid): string;
	/**
	 * The sibling holding a case name's or external id's value trimmed, which
	 * every write of that value names.
	 */
	trimmed(fieldUuid: Uuid): string;
	/**
	 * A count-bound repeat's reserved calculated-count name. The domain
	 * carrier plan determines whether its physical node is needed.
	 */
	count(repeatUuid: Uuid): string;
	/** A query repeat's wrapper child holding its query's ids (the count
	 * placement's `@ids`). Reserved in both placements. */
	queryIds(repeatUuid: Uuid): string;
	/** A query repeat's wrapper child holding how many ids its query found. */
	queryCount(repeatUuid: Uuid): string;
	/** A query repeat's wrapper child holding how many rows it holds. */
	queryPosition(repeatUuid: Uuid): string;
	/** A query repeat's row child holding the row's record id. */
	queryId(repeatUuid: Uuid): string;
	/** A query repeat's row child holding the row's 0-based position. */
	queryIndex(repeatUuid: Uuid): string;
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
	/** The group whose relevance carries a Save to Case close's condition. */
	conditionClose(): string;
	/** The close-only block of the form's own case, inside that group. */
	close(): string;
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

/**
 * The trimmed sibling of the question at `path`, which every write of a case
 * name or an external id names in place of the question.
 */
export function trimmedValuePath(
	plan: GeneratedNodePlan,
	fieldUuid: Uuid,
	path: FormPath,
): FormPath {
	return path.parent().child(plan.trimmed(fieldUuid));
}

const OPERATIONS = "nova_operations";
const SUBCASES = "nova_subcases";
const SELECTED_CASES = "nova_selected_cases";
const UPDATE_SELECTED_CASES = "nova_update_selected_cases";
const CLOSE_SELECTED_CASES = "nova_close_selected_cases";
const CLOSE = "nova_close";

/** Who a held path's segments belong to: an operation, or the own close. */
type HeldOwner = Uuid | typeof OWN_CLOSE;
const OWN_CLOSE = "own-close";

interface HeldPath {
	readonly owner: HeldOwner;
	/** The held `repeat`; absent at the form root. */
	readonly repeat: Uuid | undefined;
	readonly segments: readonly [string, ...string[]];
}

/**
 * Every held Save to Case path of the form: each operation's held
 * placement and the form's held own close. A held path is where a
 * published app keeps a block, so its segments are taken before anything
 * else is named: the first in its scope (the form root, or the held
 * repeat's row), the rest in that scope's operations namespace. A hold
 * that no longer expresses its subject still reserves its path, so no
 * generated name depends on the placement the plan reads these names for.
 */
function heldSaveToCasePaths(form: BlueprintDoc["forms"][Uuid]): {
	readonly paths: readonly HeldPath[];
	firstSegments(repeat: Uuid | undefined): readonly string[];
} {
	const paths: HeldPath[] = [];
	for (const operation of orderedCaseOperations(form)) {
		const placement = operation.placement;
		if (placement?.kind === "save-to-case")
			paths.push({
				owner: operation.uuid,
				repeat: placement.repeat,
				segments: placement.path,
			});
	}
	if (form.ownClosePlacement !== undefined)
		paths.push({
			owner: OWN_CLOSE,
			repeat: undefined,
			segments: form.ownClosePlacement.path,
		});
	return {
		paths,
		firstSegments: (repeat) =>
			paths
				.filter((path) => path.repeat === repeat)
				.map((path) => path.segments[0]),
	};
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
	const structure = formStructure(doc, formUuid);
	if (structure === undefined)
		throw new Error(
			`Nova could not resolve the structure of form ${formUuid} while naming its generated nodes.`,
		);
	const countNames = planRepeatCountNames(structure);
	const queryNames = planQueryRepeatNames(structure);
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
	const reservedQueryNames = (repeatUuid: Uuid) => {
		const reserved = queryNames.get(repeatUuid);
		if (reserved === undefined)
			throw new Error(
				`Nova reserved no generated names for the query repeat ${repeatUuid} in form ${formUuid}. The reservation and the plan of generated nodes walk the same fields, so they must agree.`,
			);
		return reserved;
	};
	/** Take a reserved name in its scope; the scope must still hold it free. */
	const takeReserved = (
		scope: Namespace,
		purpose: GeneratedNodePurpose,
		owner: Uuid,
		name: string,
	): void => {
		if (scope.allocate(name) !== name)
			throw new Error(
				`The reserved ${purpose} name ${name} is already in use in form ${formUuid}. The reservation must take every name before anything else of its scope.`,
			);
		record(purpose, owner, name);
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

	const trimmedFields = caseScalarTextGuards(doc, formUuid);
	// Each question an operation writes from gets its sibling (`nova_url_`
	// for a capture's link, `nova_datetime_` for a date and time) whichever
	// place the write takes, so no generated name depends on the placement
	// that reads this plan.
	const writeViews = formCaseWriteViews(doc, formUuid);
	const held = heldSaveToCasePaths(form);

	// Field namespaces: one per container's child element, in field order.
	const fieldScopes = new Map<string, Namespace>();
	const heldContainerScopes = new Map<string, Uuid | undefined>();
	const repeatScopes = new Map<Uuid, FormPath>();
	const walk = (parentUuid: Uuid, parentPath: FormPath, root: boolean) => {
		const children = orderedFieldUuids(doc, parentUuid).flatMap((uuid) => {
			const field = doc.fields[uuid];
			return field === undefined ? [] : [field];
		});
		const scopeKey: Uuid | undefined = root ? undefined : parentUuid;
		const scope = new Namespace([
			...children.map((field) => field.id),
			...(root ? formConnectIds(doc, formUuid) : []),
			...held.firstSegments(scopeKey),
		]);
		heldContainerScopes.set(parentPath.toXPath(), scopeKey);
		fieldScopes.set(parentPath.toXPath(), scope);
		const parent = doc.fields[parentUuid];
		if (parent?.kind === "repeat" && parent.repeat_mode === "query_bound") {
			const reserved = reservedQueryNames(parentUuid);
			takeReserved(scope, "query-id", parentUuid, reserved.id);
			takeReserved(scope, "query-index", parentUuid, reserved.index);
		}
		for (const field of children) {
			const path = parentPath.child(field.id);
			const expression = expressionSlotValue(doc, {
				entity: "field",
				uuid: field.uuid,
				slot: "validate",
			});
			if (fieldKindCarriesValidation(field.kind) && expression !== undefined) {
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
			const views = writeViews.get(field.uuid) ?? [];
			if (isCaptureField(field) && views.some((view) => view.link))
				record("url", field.uuid, scope.allocate(`nova_url_${field.id}`));
			if (
				views.some((view) => !view.link) &&
				fieldValueType(field, effectiveCaseTypes(doc), views) === "datetime"
			)
				record(
					"datetime",
					field.uuid,
					scope.allocate(`nova_datetime_${field.id}`),
				);
			if (trimmedFields.has(field.uuid))
				record(
					"trimmed",
					field.uuid,
					scope.allocate(`nova_trimmed_${field.id}`),
				);
			if (field.kind === "repeat" && field.repeat_mode === "count_bound") {
				const name = countNames.get(field.uuid);
				if (name === undefined)
					throw new Error(
						`Missing reserved repeat count name for ${field.uuid}.`,
					);
				if (scope.allocate(name) !== name)
					throw new Error(
						`The reserved repeat count name ${name} is already in use.`,
					);
				record("count", field.uuid, name);
			}
			if (field.kind === "repeat" && field.repeat_mode === "query_bound") {
				const reserved = reservedQueryNames(field.uuid);
				const wrapper = new Namespace(["item"]);
				takeReserved(wrapper, "query-ids", field.uuid, reserved.ids);
				takeReserved(wrapper, "query-count", field.uuid, reserved.count);
				takeReserved(wrapper, "query-position", field.uuid, reserved.position);
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
		// A held path that passes through a container names that container:
		// the scope's one group of its kind, which unheld blocks share.
		const heldHere = new Set(
			held.firstSegments(heldContainerScopes.get(scopePath.toXPath())),
		);
		const container = (base: string) =>
			heldHere.has(base) ? base : scope.allocate(base);
		containers.set(scopePath.toXPath(), {
			operations: container(OPERATIONS),
			subcases: container(SUBCASES),
			selectedCases: container(SELECTED_CASES),
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
	// Every held segment after the first is taken in its scope's operations
	// namespace before anything is allocated there.
	const heldRest = new Map<string, Map<string, Set<HeldOwner>>>();
	for (const path of held.paths) {
		const scopePath =
			path.repeat === undefined
				? FormPath.root()
				: repeatScopes.get(path.repeat);
		if (scopePath === undefined) continue;
		const key = scopePath.toXPath();
		let names = heldRest.get(key);
		if (names === undefined) {
			names = new Map();
			heldRest.set(key, names);
		}
		for (const segment of path.segments.slice(1)) {
			const owners = names.get(segment) ?? new Set<HeldOwner>();
			owners.add(path.owner);
			names.set(segment, owners);
		}
	}
	const operationScopes = new Map<string, Namespace>();
	const operationNamespace = (scopePath: string): Namespace => {
		let scope = operationScopes.get(scopePath);
		if (scope === undefined) {
			scope = new Namespace([
				...operations
					.filter((candidate) => scopeOf(candidate) === scopePath)
					.map((candidate) => candidate.id),
				...(heldRest.get(scopePath)?.keys() ?? []),
			]);
			operationScopes.set(scopePath, scope);
		}
		return scope;
	};
	for (const operation of operations) operationNamespace(scopeOf(operation));
	/**
	 * Allocate `base` for `owner`: a name the owner's own held path holds is
	 * the owner's, kept as held; any other taken name takes a suffix.
	 */
	const allocateFor = (
		scopePath: string,
		owner: HeldOwner,
		base: string,
	): string =>
		heldRest.get(scopePath)?.get(base)?.has(owner) === true
			? base
			: operationNamespace(scopePath).allocate(base);
	const operationByUuid = new Map(
		operations.map((operation) => [operation.uuid, operation]),
	);
	const inheritedGuards = caseOperationConditionalGuardUuids(
		doc,
		formUuid,
		operations,
	);
	for (const operation of operations) {
		const scopePath = scopeOf(operation);
		const scope = operationNamespace(scopePath);
		const allocate = (base: string) =>
			allocateFor(scopePath, operation.uuid, base);
		if (isKeyedRootCreate(operation)) {
			const keyedBase = `nova_keyed_${operation.id}`;
			// The count node is named for the repeat, whose own name is taken
			// next; both join the namespace before anything else of the operation.
			const keyed =
				heldRest.get(scopePath)?.get(keyedBase)?.has(operation.uuid) === true
					? keyedBase
					: scope.peek(keyedBase);
			record("keyed-count", operation.uuid, allocate(`nova_count_${keyed}`));
			record("keyed", operation.uuid, allocate(keyedBase));
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
				allocate(`nova_condition_${operation.id}`),
			);
		for (const kind of operationGuardKinds(operation))
			record(
				"guard",
				operation.uuid,
				allocate(`nova_guard_${operation.id}_${kind}`),
				kind,
			);
	}
	const root = FormPath.root().toXPath();
	const rootOperations = operationNamespace(root);
	const conditionUpdateSelectedCases = rootOperations.allocate(
		`nova_condition_${UPDATE_SELECTED_CASES.slice("nova_".length)}`,
	);
	const updateSelectedCases = rootOperations.allocate(UPDATE_SELECTED_CASES);
	const closeSelectedCases =
		heldRest.get(root)?.get(CLOSE_SELECTED_CASES)?.has(OWN_CLOSE) === true
			? CLOSE_SELECTED_CASES
			: rootOperations.peek(CLOSE_SELECTED_CASES);
	const conditionClose = allocateFor(
		root,
		OWN_CLOSE,
		`nova_condition_${CLOSE.slice("nova_".length)}`,
	);
	const close = allocateFor(root, OWN_CLOSE, CLOSE);

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
		trimmed: (fieldUuid) => lookup("trimmed", fieldUuid),
		count: (repeatUuid) => lookup("count", repeatUuid),
		queryIds: (repeatUuid) => lookup("query-ids", repeatUuid),
		queryCount: (repeatUuid) => lookup("query-count", repeatUuid),
		queryPosition: (repeatUuid) => lookup("query-position", repeatUuid),
		queryId: (repeatUuid) => lookup("query-id", repeatUuid),
		queryIndex: (repeatUuid) => lookup("query-index", repeatUuid),
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
		conditionClose: () => conditionClose,
		close: () => close,
		nodes,
	};
}
