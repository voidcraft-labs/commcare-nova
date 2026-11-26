import { entryOperationCaseType } from "./advancedEntryDatums";
// lib/domain/caseWriteViews.ts
//
// A field's "Saves to": the writes of the form's case operations that save
// the field's answer as it is. A form writes case data only through its case
// operations; a field holds no destination of its own, so what a field saves
// to is a view of those writes, read here and nowhere else.
//
// A write belongs to a field's view exactly when the value it saves (an
// operation's `name`, its `owner`, or a `writes[].value`) is the field's
// answer alone: `term field{uuid}` with no filters and no role, in any
// spelling, or `term capture-link{field}`, the link to a captured file. A
// value that reads the field inside a larger expression saves something
// computed from the answer, not the answer, and is not in the view.
//
// The candidate forms come from the reference index the document carries
// (the form carriers whose name, owner or write-value slot reads the
// field); a document without one is read from the field's own form. Views
// are derived once per document object: documents are replaced, never
// changed in place.

import type { BlueprintDoc, CaseType } from "./blueprint";
import { resolveRelationDestination } from "./expression/relationDestination";
import type { Expression, RelationStep } from "./expression/types";
import { formOfField } from "./fieldForm";
import {
	type CaseOperation,
	type CaseWriteKey,
	type CaseWriteVia,
	caseWriteKeyOf,
	type FormType,
	operationCaseType,
	RESERVED_CASE_OPERATION_TYPES,
	sameCaseWriteKey,
} from "./forms";
import { entityTargetKey, indexedReferencingSlots } from "./referenceIndex";
import type { Uuid } from "./uuid";

/** The basic linked write whose native case block remains even when no answer is present. */
export function isParentUserWritePath(
	via: readonly RelationStep[] | undefined,
): boolean {
	return (
		via?.length === 2 &&
		via[0].identifier === "parent" &&
		via[1].identifier === "user"
	);
}

/** HQ follows each literal index without type filtering. Both steps must
 * have one declared destination without relying on a qualifier. */
export function parentUserWriteCaseTypes(
	via: readonly RelationStep[] | undefined,
	origin: string,
	caseTypes: readonly CaseType[],
): readonly [intermediate: string, terminal: string] | undefined {
	if (!via || !isParentUserWritePath(via)) return undefined;
	const parent = resolveRelationDestination(
		{ kind: "ancestor", via: [{ identifier: "parent" }] },
		origin,
		caseTypes,
	);
	if (!parent.ok) return undefined;
	const user = resolveRelationDestination(
		{ kind: "ancestor", via: [{ identifier: "user" }] },
		parent.caseType,
		caseTypes,
	);
	if (!user.ok) return undefined;
	const types = [origin, parent.caseType, user.caseType];
	if (
		new Set(types).size !== types.length ||
		types.some((type) => RESERVED_CASE_OPERATION_TYPES.has(type)) ||
		(via[0].throughCaseType !== undefined &&
			via[0].throughCaseType !== parent.caseType) ||
		(via[1].throughCaseType !== undefined &&
			via[1].throughCaseType !== user.caseType)
	)
		return undefined;
	return [parent.caseType, user.caseType];
}

/** Which value of its operation a write saves. */
export type FieldCaseWriteSlot = "name" | "owner" | "write";

/**
 * Where a write lands relative to the form: the form's own case, a case
 * above it (`via`), a case the form creates beneath its own, the worker's
 * own record, or any other case an operation targets.
 */
export type FieldCaseWriteDestination =
	| "own"
	| "ancestor"
	| "child"
	| "worker-record"
	| "other";

export interface FieldCaseWriteView {
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly slot: FieldCaseWriteSlot;
	/** The case type the write lands on: `via`'s destination when present. */
	readonly caseType: string;
	/** `case_name` for the name slot, `owner_id` for the owner slot. */
	readonly property: string;
	readonly via?: CaseWriteVia;
	readonly onlyIfChanged: boolean;
	/** The value is `capture-link`, not a bare read. */
	readonly link: boolean;
	readonly destination: FieldCaseWriteDestination;
}

/**
 * The address of one view's write: its operation, its slot, and for a
 * `writes[]` entry the write's key. A planner names the write it replaces
 * or removes through it.
 */
export interface FieldCaseWriteViewKey {
	readonly operationUuid: Uuid;
	readonly slot: FieldCaseWriteSlot;
	readonly key?: CaseWriteKey;
}

/** The key of `view`. */
export function fieldCaseWriteViewKey(
	view: FieldCaseWriteView,
): FieldCaseWriteViewKey {
	return view.slot === "write"
		? {
				operationUuid: view.operationUuid,
				slot: "write",
				key:
					view.via === undefined
						? { property: view.property }
						: { property: view.property, via: view.via },
			}
		: { operationUuid: view.operationUuid, slot: view.slot };
}

/** Where one value of an operation saves: the operation, its slot, and for
 *  a `writes[]` entry the cases its `via` walks. */
export interface CaseWriteValueAt {
	readonly operationUuid: Uuid;
	readonly slot: FieldCaseWriteSlot;
	readonly via?: CaseWriteVia;
}

/** Whether `view` is the view of the value `at` saves to `property`: one
 *  operation can save one property name on its own case and on a case above
 *  it, each its own view with its own destination type. */
export function isViewAt(
	view: FieldCaseWriteView,
	at: CaseWriteValueAt,
	property: string,
): boolean {
	return (
		view.operationUuid === at.operationUuid &&
		view.slot === at.slot &&
		sameCaseWriteKey(
			{
				property: view.property,
				...(view.via !== undefined && { via: view.via }),
			},
			{ property, ...(at.via !== undefined && { via: at.via }) },
		)
	);
}

/** The slots an operation's view-bearing values sit in, by registry id. */
const VIEW_SLOT_IDS: ReadonlySet<string> = new Set([
	"case_operation_name",
	"case_operation_owner",
	"case_operation_write_value",
]);

type ViewDoc = Pick<
	BlueprintDoc,
	"forms" | "formOrder" | "modules" | "caseTypes" | "fieldParent" | "refIndex"
>;

const NO_VIEWS: readonly FieldCaseWriteView[] = [];
const derived = new WeakMap<
	ViewDoc,
	Map<Uuid, ReadonlyMap<Uuid, readonly FieldCaseWriteView[]>>
>();

/**
 * Every write of `fieldUuid`'s answer, in operation order, then slot order
 * (`name`, `owner`, then writes in array order).
 */
export function fieldCaseWriteViews(
	doc: ViewDoc,
	fieldUuid: Uuid,
): readonly FieldCaseWriteView[] {
	const indexed = indexedReferencingSlots(
		doc.refIndex,
		entityTargetKey(fieldUuid),
	);
	const formUuids =
		indexed === undefined
			? [formOfField(doc, fieldUuid)].filter(
					(uuid): uuid is Uuid => uuid !== undefined,
				)
			: [...indexed]
					.filter(
						([carrier, slots]) =>
							Object.hasOwn(doc.forms, carrier) &&
							slots.some((slot) => VIEW_SLOT_IDS.has(slot)),
					)
					.map(([carrier]) => carrier as Uuid);
	const views: FieldCaseWriteView[] = [];
	for (const formUuid of formUuids) {
		views.push(...(formCaseWriteViews(doc, formUuid).get(fieldUuid) ?? []));
	}
	return views.length === 0 ? NO_VIEWS : views;
}

/** Every field's view in one form, keyed by the field's uuid. */
export function formCaseWriteViews(
	doc: ViewDoc,
	formUuid: Uuid,
): ReadonlyMap<Uuid, readonly FieldCaseWriteView[]> {
	let forms = derived.get(doc);
	if (forms === undefined) {
		forms = new Map();
		derived.set(doc, forms);
	}
	let views = forms.get(formUuid);
	if (views === undefined) {
		views = deriveFormViews(doc, formUuid);
		forms.set(formUuid, views);
	}
	return views;
}

/** The field a value saves as it is, and whether it saves the file's link. */
export function caseWriteValueField(
	value: Expression | undefined,
): { readonly field: Uuid; readonly link: boolean } | undefined {
	if (value?.kind !== "term") return undefined;
	const term = value.term;
	if (term.kind === "capture-link") return { field: term.field, link: true };
	if (
		term.kind === "field" &&
		term.filters === undefined &&
		term.role === undefined
	)
		return { field: term.uuid, link: false };
	return undefined;
}

/** The questions and physical property types a worker saves through this
 * entry. The editor keeps one set of definitions on the parent. */
export function entryCaseWriteViews(doc: BlueprintDoc, entryUuid: Uuid) {
	const parent = doc.forms[entryUuid]?.shadowOf?.form;
	return parent
		? deriveFormViews(doc, parent, (op) =>
				entryOperationCaseType(doc, entryUuid, op),
			)
		: formCaseWriteViews(doc, entryUuid);
}

function deriveFormViews(
	doc: ViewDoc,
	formUuid: Uuid,
	typeOfOperation?: (operation: CaseOperation) => string | undefined,
): ReadonlyMap<Uuid, readonly FieldCaseWriteView[]> {
	const views = new Map<Uuid, FieldCaseWriteView[]>();
	const form = Object.hasOwn(doc.forms, formUuid)
		? doc.forms[formUuid]
		: undefined;
	if (form === undefined) return views;
	const ownUuid = form.caseOperations?.find(
		(operation) => operation.action === "own",
	)?.uuid;
	const add = (view: FieldCaseWriteView, field: Uuid): void => {
		const existing = views.get(field);
		if (existing === undefined) views.set(field, [view]);
		else existing.push(view);
	};
	for (const operation of form.caseOperations ?? []) {
		const operationType =
			operation.retype ??
			(typeOfOperation
				? typeOfOperation(operation)
				: operationCaseType(doc, formUuid, operation));
		if (operationType === undefined) continue;
		const destination = operationDestination(operation, form.type, ownUuid);
		const slotView = (
			slot: "name" | "owner",
			value: Expression | undefined,
		): void => {
			const read = caseWriteValueField(value);
			if (read === undefined) return;
			add(
				{
					formUuid,
					operationUuid: operation.uuid,
					slot,
					caseType: operationType,
					property: slot === "name" ? "case_name" : "owner_id",
					onlyIfChanged:
						(slot === "name"
							? operation.nameOnlyIfChanged
							: operation.ownerOnlyIfChanged) === true,
					link: read.link,
					destination,
				},
				read.field,
			);
		};
		slotView("name", operation.name);
		slotView("owner", operation.owner);
		for (const write of operation.writes ?? []) {
			const read = caseWriteValueField(write.value);
			if (read === undefined) continue;
			const key = caseWriteKeyOf(write);
			let caseType = operationType;
			if (key.via !== undefined) {
				const reached = resolveRelationDestination(
					{ kind: "ancestor", via: key.via },
					operationType,
					doc.caseTypes ?? [],
				);
				// A `via` the catalog does not resolve saves nowhere the
				// validator admits (`CASE_WRITE_VIA_INVALID`, reason
				// `unresolved`), so no view names a case type for it.
				if (!reached.ok) continue;
				caseType = reached.caseType;
			}
			add(
				{
					formUuid,
					operationUuid: operation.uuid,
					slot: "write",
					caseType,
					property: write.property,
					...(key.via === undefined ? {} : { via: key.via }),
					onlyIfChanged: write.onlyIfChanged === true,
					link: read.link,
					destination: key.via === undefined ? destination : "ancestor",
				},
				read.field,
			);
		}
	}
	return views;
}

/** Where `operation`'s own case sits relative to the form. */
function operationDestination(
	operation: CaseOperation,
	formType: FormType,
	ownUuid: Uuid | undefined,
): FieldCaseWriteDestination {
	if (operation.action === "own") return "own";
	if (operation.target.kind === "worker-record") return "worker-record";
	if (operation.action !== "create") return "other";
	const links = operation.links ?? [];
	const link = links[0];
	if (links.length !== 1 || link === undefined || link.identifier !== "parent")
		return "other";
	const toOwnCase =
		link.target?.kind === "session"
			? formType === "followup" || formType === "close"
			: link.target?.kind === "op" &&
				ownUuid !== undefined &&
				link.target.opUuid === ownUuid;
	return toOwnCase ? "child" : "other";
}
