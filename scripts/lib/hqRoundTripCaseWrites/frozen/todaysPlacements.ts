/**
 * Where `main`'s emission put each unit of each form, frozen (part 09 §8.2).
 *
 * A copy, over a `RawDocument`, of the rules `main` (`2f985ed6`) wrote case
 * blocks by:
 *
 * - **Basic slots.** `lib/commcare/formActions.ts::buildFormActions` with
 *   `lib/commcare/subcaseWire.ts::hqCaseActions`: the own case in the basic
 *   own slot on every non-survey form of a menu with a case type that loads
 *   one case or none; the worker's record in the usercase slot; each child
 *   bucket of `caseWriteInventory.ts` at `subcases[i]`, `i` its position
 *   counting the extension buckets, whose basic subcase `hqCaseActions` left
 *   inert (`condition: never`) beside the Save to Case block that carries
 *   it. CommCare HQ names a subcase's node and datum by that position, inert
 *   ones included (`models/form_actions.py::OpenSubCaseAction.
 *   form_element_name` is `subcase_<id>`, the `IndexedSchema` index;
 *   `models/forms.py::FormBase.session_var_for_action` takes
 *   `actions.subcases.index(action)`), and writes a subcase at its repeat's
 *   row rather than at `subcase_<i>` where that repeat holds only one
 *   subcase, inert ones counted (`xform.py::XForm._create_casexml`,
 *   `nest = repeat_context_count[...] > 1` over
 *   `FormActions.count_subcases_per_repeat_context`). A several-case form has
 *   no basic case block at all (`_create_casexml` turns
 *   `default_case_management` off in a multi-select menu), so `main` wrote
 *   its own update, its close and its child creates in the source.
 * - **Save to Case blocks.** `lib/commcare/xform/caseOps.ts::
 *   buildCaseOperations` placed each block, and
 *   `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes` named every
 *   element on its path: the scope's `nova_operations` / `nova_subcases` /
 *   `nova_selected_cases` containers, `nova_keyed_<id>` around a root create
 *   keyed by an answer, `nova_condition_<id>` around a conditional update or
 *   close, `nova_guard_<id>_<kind>` beside it, `nova_update_selected_cases`
 *   and `nova_close_selected_cases` in a several-case form, and
 *   `nova_condition_close/nova_close` for a close condition HQ's Case
 *   Management tab cannot state (`lib/domain/closeCondition.ts::
 *   closeConditionPlacement`), each suffixed as the allocator suffixed it.
 * - **Model iteration.** Every query repeat iterated its rows by model
 *   iteration.
 *
 * Step 5 changes every one of those rules, so this module imports none of
 * them; it imports only the head modules step 5 leaves as `main` had them
 * (`lib/commcare/xform/namespace.ts`, `lib/doc/deepEqual.ts`).
 */

import { Namespace } from "@/lib/commcare/xform/namespace";
import { deepEqual } from "@/lib/doc/deepEqual";
import type { SaveToCasePlacement } from "@/lib/domain/placements";
import type { Uuid } from "@/lib/domain/uuid";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import {
	type PlacementUnit,
	placementUnitKey,
	type TodaysPlacement,
} from "../types";
import {
	childBucketUnit,
	frozenCaseWriteInventory,
} from "./caseWriteInventory";
import {
	isQueryRepeat,
	isRecord,
	RAW_CASE_LOADING_FORM_TYPES,
	type RawFormInMenu,
	rawCaseSelectionCardinality,
	rawChildren,
	rawDataPaths,
	rawFieldParents,
	rawFieldsInDataOrder,
	rawFormsInOrder,
	rawModuleCaseType,
	recordAt,
	recordsAt,
	stringAt,
} from "./rawForms";

/** Today's placement of every unit of every form, keyed by
 *  `placementUnitKey`, forms in menu order. */
export function todaysPlacements(
	raw: RawDocument,
): ReadonlyMap<string, TodaysPlacement> {
	const out = new Map<string, TodaysPlacement>();
	for (const entry of rawFormsInOrder(raw))
		for (const placement of formPlacements(raw, entry))
			out.set(placementUnitKey(placement.formUuid, placement.unit), placement);
	return out;
}

/** A raw case operation's parts the placement rules read. */
interface RawOperation {
	readonly record: JsonRecord;
	readonly uuid: string;
	readonly id: string;
	readonly action: string;
	readonly caseType: string;
	readonly target: JsonRecord;
	readonly repeat: string | undefined;
}

function rawOperations(form: JsonRecord): RawOperation[] {
	return recordsAt(form, "caseOperations").map((record) => ({
		record,
		uuid: stringAt(record, "uuid") ?? "",
		id: stringAt(record, "id") ?? "",
		action: stringAt(record, "action") ?? "",
		caseType: stringAt(record, "caseType") ?? "",
		target: recordAt(record, "target") ?? {},
		repeat: stringAt(recordAt(record, "forEach"), "repeat"),
	}));
}

/** `generatedNodes.ts::isKeyedRootCreate`. */
function isKeyedRootCreate(operation: RawOperation): boolean {
	return (
		operation.action === "create" &&
		operation.repeat === undefined &&
		stringAt(operation.target, "kind") === "new" &&
		operation.target.idFrom !== undefined
	);
}

const GUARD_KINDS = ["type", "retype", "text"] as const;

/** `generatedNodes.ts::operationGuardKinds`. */
function operationGuardKinds(
	operation: RawOperation,
): (typeof GUARD_KINDS)[number][] {
	const record = operation.record;
	const kinds: (typeof GUARD_KINDS)[number][] = [];
	if (
		recordsAt(record, "links").some(
			(link) => stringAt(recordAt(link, "target"), "kind") === "expression",
		)
	)
		kinds.push("type");
	const retype = stringAt(record, "retype");
	if (
		operation.action === "update" &&
		retype !== undefined &&
		retype !== operation.caseType
	)
		kinds.push("retype");
	if (
		operation.action === "create" ||
		record.rename !== undefined ||
		(operation.action === "update" && record.owner !== undefined) ||
		recordsAt(record, "writes").some(
			(write) => stringAt(write, "property") === "external_id",
		)
	)
		kinds.push("text");
	return kinds;
}

// ─── Inherited conditions (`2f985ed6:lib/doc/caseOperationOrder.ts`) ─────

interface TargetState {
	readonly target: JsonRecord;
	caseType: string;
	guardUuids: Set<string>;
}

function isIdOf(expression: Json | undefined, opUuid: string): boolean {
	return (
		isRecord(expression) &&
		expression.kind === "id-of" &&
		expression.opUuid === opUuid
	);
}

/** `caseOperationOrder.ts::sameCaseOperationTargetIdentity`. */
function sameTargetIdentity(left: JsonRecord, right: JsonRecord): boolean {
	const leftKind = stringAt(left, "kind");
	const rightKind = stringAt(right, "kind");
	if (leftKind !== rightKind) {
		if (leftKind === "op" && rightKind === "expression")
			return isIdOf(right.expr, stringAt(left, "opUuid") ?? "");
		if (leftKind === "expression" && rightKind === "op")
			return isIdOf(left.expr, stringAt(right, "opUuid") ?? "");
		return false;
	}
	switch (leftKind) {
		case "session":
			return true;
		case "op":
			return left.opUuid === right.opUuid;
		case "expression":
			return deepEqual(left.expr, right.expr);
		default:
			return false;
	}
}

/** Every `id-of` an expression holds, at any depth. */
function collectIdOf(value: Json | undefined, refs: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectIdOf(item, refs);
		return;
	}
	if (!isRecord(value)) return;
	if (value.kind === "id-of" && typeof value.opUuid === "string")
		refs.add(value.opUuid);
	for (const child of Object.values(value)) collectIdOf(child, refs);
}

/** `caseOperationOrder.ts::caseOperationDependencyUuids`. */
function dependencyUuids(operation: RawOperation): Set<string> {
	const record = operation.record;
	const refs = new Set<string>();
	const opUuid = stringAt(operation.target, "opUuid");
	if (stringAt(operation.target, "kind") === "op" && opUuid !== undefined)
		refs.add(opUuid);
	for (const link of recordsAt(record, "links")) {
		const target = recordAt(link, "target");
		const linkOp = stringAt(target, "opUuid");
		if (stringAt(target, "kind") === "op" && linkOp !== undefined)
			refs.add(linkOp);
		if (stringAt(target, "kind") === "expression")
			collectIdOf(target?.expr, refs);
	}
	if (stringAt(operation.target, "kind") === "expression")
		collectIdOf(operation.target.expr, refs);
	for (const key of ["name", "owner", "rename"]) collectIdOf(record[key], refs);
	for (const write of recordsAt(record, "writes")) {
		collectIdOf(write.value, refs);
		collectIdOf(write.condition, refs);
	}
	collectIdOf(record.condition, refs);
	return refs;
}

/**
 * The operations `main` wrapped in a condition group: those with a condition
 * of their own, and those that inherit one from a conditional create or
 * retype they read (`caseOperationOrder.ts::
 * caseOperationConditionalGuardUuids`, whose every guard is a conditional
 * operation's uuid).
 */
function conditionalOperations(
	module: JsonRecord,
	operations: readonly RawOperation[],
): ReadonlySet<string> {
	const state: TargetState[] = [];
	const moduleCaseType = stringAt(module, "caseType");
	if (moduleCaseType !== undefined)
		state.push({
			target: { kind: "session" },
			caseType: moduleCaseType,
			guardUuids: new Set(),
		});
	const find = (target: JsonRecord) =>
		state.find((entry) => sameTargetIdentity(entry.target, target));
	const remember = (
		target: JsonRecord,
		caseType: string,
		guardUuids: ReadonlySet<string>,
	): void => {
		const existing = find(target);
		if (existing === undefined)
			state.push({ target, caseType, guardUuids: new Set(guardUuids) });
		else {
			existing.caseType = caseType;
			existing.guardUuids = new Set(guardUuids);
		}
	};
	const assertType = (
		target: JsonRecord,
		expectedType: string,
		required: Set<string>,
	): void => {
		let known = find(target);
		if (known === undefined && stringAt(target, "kind") === "expression") {
			known = { target, caseType: expectedType, guardUuids: new Set() };
			state.push(known);
		}
		if (known !== undefined && known.caseType === expectedType)
			for (const uuid of known.guardUuids) required.add(uuid);
	};

	const conditional = new Set<string>();
	for (const operation of operations) {
		const required = new Set<string>();
		for (const dependency of dependencyUuids(operation))
			for (const uuid of find({ kind: "op", opUuid: dependency })?.guardUuids ??
				[])
				required.add(uuid);
		const targetKind = stringAt(operation.target, "kind");
		if (operation.action !== "create" && targetKind !== "new")
			assertType(operation.target, operation.caseType, required);
		for (const link of recordsAt(operation.record, "links")) {
			const target = recordAt(link, "target");
			if (target === undefined || stringAt(target, "kind") === "new") continue;
			assertType(target, stringAt(link, "targetType") ?? "", required);
		}
		const hasCondition = operation.record.condition !== undefined;
		if (hasCondition || required.size > 0) conditional.add(operation.uuid);
		const output = new Set(required);
		if (hasCondition) output.add(operation.uuid);
		const retype = stringAt(operation.record, "retype");
		if (operation.action === "create")
			remember(
				{ kind: "op", opUuid: operation.uuid },
				operation.caseType,
				output,
			);
		else if (targetKind !== "new" && retype !== undefined)
			remember(operation.target, retype, output);
	}
	return conditional;
}

// ─── The close condition (`2f985ed6:lib/domain/closeCondition.ts`) ───────

const STATABLE_QUESTION_KINDS: ReadonlySet<string> = new Set([
	"single_select",
	"multi_select",
	"hidden",
	"label",
]);

/** `closeCondition.ts::closeConditionPlacement`: whether a close form's
 *  condition is one HQ's Case Management tab cannot state. */
function closeWrittenInSource(raw: RawDocument, entry: RawFormInMenu): boolean {
	const condition = recordAt(entry.form, "closeCondition");
	const answer = stringAt(condition, "answer");
	if (stringAt(entry.form, "type") !== "close" || condition === undefined)
		return false;
	if (answer === undefined || answer.length === 0) return false;
	const fieldUuid = stringAt(condition, "field") ?? "";
	const field = raw.fields[fieldUuid];
	if (field === undefined) return false;
	const parents = rawFieldParents(raw);
	let inRepeat = false;
	for (
		let parent = parents.get(fieldUuid);
		parent !== undefined && parent !== entry.formUuid;
		parent = parents.get(parent)
	)
		if (stringAt(raw.fields[parent], "kind") === "repeat") inRepeat = true;
	const kind = stringAt(field, "kind") ?? "";
	const source = recordAt(field, "optionsSource");
	const offered =
		(kind !== "single_select" && kind !== "multi_select") ||
		stringAt(source, "kind") !== "inline" ||
		recordsAt(source, "options").some(
			(option) => stringAt(option, "value") === answer,
		);
	const statable =
		STATABLE_QUESTION_KINDS.has(kind) &&
		!inRepeat &&
		!answer.includes("'") &&
		!answer.startsWith('"') &&
		!answer.endsWith('"') &&
		offered;
	return !statable;
}

// ─── Generated names (`2f985ed6:lib/commcare/xform/generatedNodes.ts`) ───

const OPERATIONS = "nova_operations";
const SUBCASES = "nova_subcases";
const SELECTED_CASES = "nova_selected_cases";
const UPDATE_SELECTED_CASES = "nova_update_selected_cases";
const CLOSE_SELECTED_CASES = "nova_close_selected_cases";
const CLOSE = "nova_close";
/** A selected-cases repeat's row element (`FormPath.queryBoundIteration`). */
const ITEM = "item";

/** The Connect block ids a form's data root holds (`2f985ed6:lib/domain/
 *  connectIds.ts::formConnectIds`): none while the app has no Connect mode. */
function formConnectIds(raw: RawDocument, form: JsonRecord): string[] {
	const connect = recordAt(form, "connect");
	if (connect === undefined || raw.connectType === null) return [];
	return ["learn_module", "assessment", "deliver_unit", "task"].flatMap(
		(kind) => {
			const id = stringAt(recordAt(connect, kind), "id");
			return id === undefined ? [] : [id];
		},
	);
}

interface FormNames {
	/** The scope's containers: the form root under `undefined`, a repeat by uuid. */
	container(repeat: string | undefined): {
		operations: string;
		subcases: string;
		selectedCases: string;
	};
	keyed(operationUuid: string): string;
	condition(operationUuid: string): string;
	guard(operationUuid: string, kind: string): string;
	/** `nova_subcase_<n>` in the operations namespace of `repeat`'s scope. */
	selectedSubcase(n: number, repeat: string | undefined): string;
	readonly conditionUpdateSelectedCases: string;
	readonly updateSelectedCases: string;
	readonly closeSelectedCases: string;
	readonly conditionClose: string;
	readonly close: string;
}

/**
 * The names `planGeneratedNodes` gave the form's case-block elements. A
 * scope's containers are allocated after its questions' generated siblings,
 * whose names all start `nova_constraint_`, `nova_url_`, `nova_datetime_`,
 * `nova_trimmed_` or `nova_count_` and so never take a container's name or
 * one of its suffixes: the authored names of the scope (its questions' ids,
 * and at the root the form's Connect block ids) are all that can suffix one.
 */
function formNames(
	raw: RawDocument,
	entry: RawFormInMenu,
	operations: readonly RawOperation[],
	scopeOf: (operation: RawOperation) => string | undefined,
	repeats: ReadonlySet<string>,
	conditional: ReadonlySet<string>,
): FormNames {
	const containers = new Map<
		string | undefined,
		{ operations: string; subcases: string; selectedCases: string }
	>();
	for (const scope of [undefined, ...repeats]) {
		const authored = rawChildren(raw, scope ?? entry.formUuid).map(
			(uuid) => stringAt(raw.fields[uuid], "id") ?? uuid,
		);
		const namespace = new Namespace([
			...authored,
			...(scope === undefined ? formConnectIds(raw, entry.form) : []),
		]);
		containers.set(scope, {
			operations: namespace.allocate(OPERATIONS),
			subcases: namespace.allocate(SUBCASES),
			selectedCases: namespace.allocate(SELECTED_CASES),
		});
	}

	const namespaces = new Map<string | undefined, Namespace>();
	const namespaceOf = (scope: string | undefined): Namespace => {
		let namespace = namespaces.get(scope);
		if (namespace === undefined) {
			namespace = new Namespace(
				operations
					.filter((operation) => scopeOf(operation) === scope)
					.map((operation) => operation.id),
			);
			namespaces.set(scope, namespace);
		}
		return namespace;
	};
	const byOwner = new Map<string, string>();
	for (const operation of operations) {
		const namespace = namespaceOf(scopeOf(operation));
		if (isKeyedRootCreate(operation)) {
			const keyedBase = `nova_keyed_${operation.id}`;
			namespace.allocate(`nova_count_${namespace.peek(keyedBase)}`);
			byOwner.set(`keyed|${operation.uuid}`, namespace.allocate(keyedBase));
		}
		if (conditional.has(operation.uuid))
			byOwner.set(
				`condition|${operation.uuid}`,
				namespace.allocate(`nova_condition_${operation.id}`),
			);
		for (const kind of operationGuardKinds(operation))
			byOwner.set(
				`guard|${operation.uuid}|${kind}`,
				namespace.allocate(`nova_guard_${operation.id}_${kind}`),
			);
	}
	const root = namespaceOf(undefined);
	const conditionUpdateSelectedCases = root.allocate(
		`nova_condition_${UPDATE_SELECTED_CASES.slice("nova_".length)}`,
	);
	const updateSelectedCases = root.allocate(UPDATE_SELECTED_CASES);
	const closeSelectedCases = root.peek(CLOSE_SELECTED_CASES);
	const conditionClose = root.allocate(
		`nova_condition_${CLOSE.slice("nova_".length)}`,
	);
	const close = root.allocate(CLOSE);

	const lookup = (key: string): string => {
		const name = byOwner.get(key);
		if (name === undefined)
			throw new Error(
				`The cutover's copy of main's element names holds no ${key.split("|")[0]} element for case operation ${key.split("|")[1]}. The placement rules and the names they read must agree on which elements a form has.`,
			);
		return name;
	};
	return {
		container: (scope) =>
			containers.get(scope) ?? {
				operations: OPERATIONS,
				subcases: SUBCASES,
				selectedCases: SELECTED_CASES,
			},
		keyed: (uuid) => lookup(`keyed|${uuid}`),
		condition: (uuid) => lookup(`condition|${uuid}`),
		guard: (uuid, kind) => lookup(`guard|${uuid}|${kind}`),
		selectedSubcase: (n, scope) => namespaceOf(scope).peek(`nova_subcase_${n}`),
		conditionUpdateSelectedCases,
		updateSelectedCases,
		closeSelectedCases,
		conditionClose,
		close,
	};
}

// ─── One form ─────────────────────────────────────────────────────────────

function saveToCase(
	repeat: string | undefined,
	path: readonly string[],
): SaveToCasePlacement {
	return {
		kind: "save-to-case",
		...(repeat !== undefined && { repeat: repeat as Uuid }),
		path: path as SaveToCasePlacement["path"],
	};
}

function formPlacements(
	raw: RawDocument,
	entry: RawFormInMenu,
): TodaysPlacement[] {
	const { formUuid, form, module } = entry;
	const formType = stringAt(form, "type") ?? "";
	const moduleCaseType = rawModuleCaseType(module);
	const severalCases =
		RAW_CASE_LOADING_FORM_TYPES.has(formType) &&
		moduleCaseType !== undefined &&
		rawCaseSelectionCardinality(module) === "multiple";
	const { repeatBase } = rawDataPaths(raw, formUuid);
	const repeats = new Set(repeatBase.keys());
	const operations = rawOperations(form);
	const scopeOf = (operation: RawOperation): string | undefined =>
		operation.repeat !== undefined && repeats.has(operation.repeat)
			? operation.repeat
			: undefined;
	const conditional = conditionalOperations(module, operations);
	const names = formNames(
		raw,
		entry,
		operations,
		scopeOf,
		repeats,
		conditional,
	);
	const inventory = frozenCaseWriteInventory(raw, formUuid);

	const out: TodaysPlacement[] = [];
	const place = (
		unit: PlacementUnit,
		placement: TodaysPlacement["placement"],
		guards: readonly SaveToCasePlacement[] = [],
	) => out.push({ formUuid: formUuid as Uuid, unit, placement, guards });
	/** A scope's path to its operations group: in a several-case form, the
	 *  own case's blocks stand in each selected case's row. */
	const operationsGroup = (
		scope: string | undefined,
		selected: boolean,
	): string[] =>
		selected
			? [names.container(scope).selectedCases, ITEM, OPERATIONS]
			: [names.container(scope).operations];

	// The own case.
	const primary = inventory.buckets.find((bucket) => bucket.kind === "primary");
	if (moduleCaseType !== undefined && formType !== "survey") {
		if (!severalCases) place("own", { kind: "basic", slot: "own" });
		else if ((primary?.writers.length ?? 0) > 0)
			place(
				"own",
				saveToCase(undefined, [
					...operationsGroup(undefined, true),
					names.conditionUpdateSelectedCases,
					names.updateSelectedCases,
				]),
			);
	}

	// The worker's record.
	if (inventory.buckets.some((bucket) => bucket.kind === "usercase"))
		place("usercase", { kind: "basic", slot: "usercase" });

	// Each child bucket, by its position among `subcases`.
	const children = inventory.buckets.filter(
		(bucket) => bucket.kind === "child",
	);
	for (const [index, bucket] of children.entries()) {
		const unit = childBucketUnit(bucket);
		if (severalCases)
			place(
				unit,
				saveToCase(bucket.repeatUuid, [
					...operationsGroup(bucket.repeatUuid, true),
					names.selectedSubcase(index, bucket.repeatUuid),
				]),
			);
		else if (bucket.relationship === "extension")
			place(
				unit,
				saveToCase(bucket.repeatUuid, [
					names.container(bucket.repeatUuid).subcases,
					`nova_subcase_${index}`,
				]),
			);
		else {
			const sharing = children.filter(
				(other) => other.repeatUuid === bucket.repeatUuid,
			).length;
			place(
				unit,
				bucket.repeatUuid !== undefined && sharing === 1
					? { kind: "basic", slot: "subcase-row" }
					: { kind: "basic", slot: "subcase", index },
			);
		}
	}

	// Each stored case operation.
	for (const operation of operations) {
		const scope = scopeOf(operation);
		const selected =
			severalCases && stringAt(operation.target, "kind") === "session";
		const group = operationsGroup(scope, selected);
		const isConditional = conditional.has(operation.uuid);
		const blockParent = [
			...group,
			...(isKeyedRootCreate(operation) ? [names.keyed(operation.uuid)] : []),
			...(isConditional && operation.action !== "create"
				? [names.condition(operation.uuid)]
				: []),
		];
		const guardParent = [
			...group,
			...(isConditional ? [names.condition(operation.uuid)] : []),
		];
		place(
			`operation:${operation.uuid}`,
			saveToCase(scope, [...blockParent, operation.id]),
			operationGuardKinds(operation).map((kind) =>
				saveToCase(scope, [...guardParent, names.guard(operation.uuid, kind)]),
			),
		);
	}

	// The own close, where HQ's close action could not carry it.
	if (formType === "close") {
		if (severalCases)
			place(
				"own-close",
				saveToCase(undefined, [
					...operationsGroup(undefined, true),
					names.closeSelectedCases,
				]),
			);
		else if (closeWrittenInSource(raw, entry))
			place(
				"own-close",
				saveToCase(undefined, [
					names.container(undefined).operations,
					names.conditionClose,
					names.close,
				]),
			);
	}

	// Each query repeat, iterated by model iteration.
	for (const fieldUuid of rawFieldsInDataOrder(raw, formUuid))
		if (isQueryRepeat(raw.fields[fieldUuid]))
			place(`query-repeat:${fieldUuid}`, "model-iteration");

	return out;
}
