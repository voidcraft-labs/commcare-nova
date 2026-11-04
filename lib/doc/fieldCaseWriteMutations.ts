// lib/doc/fieldCaseWriteMutations.ts
//
// The one "Saves to" planner. A form writes case data only through its case
// operations, and a field's "Saves to" is a view of the writes that save its
// answer as it is (`lib/domain/caseWriteViews.ts`). So choosing where a
// question's answer goes is an edit of the form's operations, and this file
// is the only place that edit is planned: the builder's "Saves to" row,
// `addFields` and `editField`, `createForm`'s carried answers, a field move
// and a field removal all call it and commit the batch it returns like any
// other, through the gate.
//
// Each destination class lands on one operation:
//
// - the module's case type goes to the form's own case: `case_name` to its
//   name, `owner_id` to its owner, anything else to one of its writes, which
//   may walk `via` to a case above it on a form that loads its case;
// - a declared direct child type of the module's goes to the first create of
//   that type beneath the own case in the question's repeat, or to a new one,
//   which needs a name before it can exist;
// - the worker's own record (`commcare-user`) goes to the form's one update
//   of it, or a new one;
// - anything else is refused with the sentence that says why.
//
// Removing a write takes the operation with it when nothing is left of it: a
// new child case with no name and nothing else to save, or a worker-record
// update with no writes. A new case left with writes and no name is refused,
// since it could not be created.

import {
	asUuid,
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	type CaseWriteKey,
	type CaseWriteVia,
	caseWriteKeyOf,
	type Expression,
	type Field,
	type FieldCaseWriteView,
	type FieldCaseWriteViewKey,
	type Form,
	fieldCaseWriteViews,
	fieldPreload,
	formOfField,
	isCaptureField,
	moduleUuidOfForm,
	type OwnCaseOperation,
	ownCaseOperationId,
	sameCaseWriteKey,
	startingValueMisfit,
	USERCASE_CASE_TYPE,
	type Uuid,
	valueKindPhrase,
	writerOffersPreload,
} from "@/lib/domain";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { caseOperationMultiplicityScopes } from "./caseOperationOrder";
import { deepEqual } from "./deepEqual";
import { descendantFieldUuids } from "./fieldWalk";
import { catalogMutationsForOperations } from "./scaffolds";
import type { Mutation } from "./types";
import { userFacingError } from "./userFacingErrors";

/** Where a question's answer is saved: a property of a case of `caseType`,
 *  reached through `via` from the form's own case when present. */
export interface FieldCaseWriteDestination {
	/** The case type the answer lands on: `via`'s destination when present. */
	readonly caseType: string;
	readonly property: string;
	readonly via?: CaseWriteVia;
	readonly onlyIfChanged?: true;
}

/** A planned "Saves to" edit, or the sentence that says why it can't land. */
export type FieldCaseWritePlan =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			readonly notes: readonly string[];
	  }
	| { readonly ok: false; readonly message: string };

/** What a result says when the write is born with the case's current value
 *  as the question's starting value. */
export const OPENS_WITH_CASE_VALUE_NOTE =
	"Opens with the case's current value.";

/** What a result says when the starting value born for a save goes with it
 *  (`startsBlankNote`). */
export const STARTS_BLANK_NOTE =
	"Starts blank now, since it no longer saves to the case value it opened with.";

/**
 * `STARTS_BLANK_NOTE` with the next step, where the question still saves to
 * `property` of its form's case and can open on its value.
 */
export function startsBlankOpensOnNote(property: string): string {
	return `${STARTS_BLANK_NOTE} You can have it open with the case's current ${q(property)} instead: set its starting value to #case/${property}.`;
}

/**
 * What a result says when the starting value born for a save goes with it:
 * the question starts blank, and where it still saves to a property of its
 * form's case it can open on (`casePreload.ts::writerOffersPreload`,
 * `startingValueFit.ts`), the starting value that opens it there. `after`
 * is the document with the form's planned operations and the question
 * without its starting value. A Hidden Value gets the plain note; the tools
 * that edit one add what an empty one saves
 * (`casePreload.ts::hiddenWriterBlankNote`).
 */
function startsBlankNote(
	after: BlueprintDoc,
	field: Field,
	ctx: CaseWriteFormContext,
): string {
	const caseType = ctx.moduleCaseType;
	if (field.kind === "hidden" || caseType === undefined)
		return STARTS_BLANK_NOTE;
	const opensOn = fieldCaseWriteViews(after, field.uuid).find(
		(view) =>
			// A write through `via` is an `ancestor` view, never `own`.
			view.destination === "own" &&
			view.slot !== "owner" &&
			writerOffersPreload(after, field.uuid, view.property) &&
			startingValueMisfit(after, field, caseType, view.property) === undefined,
	)?.property;
	return opensOn === undefined
		? STARTS_BLANK_NOTE
		: startsBlankOpensOnNote(opensOn);
}

/** `field` without its starting value. */
function withoutDefault(field: Field): Field {
	if (!("default_value" in field)) return field;
	const { default_value: _default, ...rest } = field;
	return rest as Field;
}

/**
 * The refusal for a save to the form's own case on a one-case loading form
 * where the question can't open on the case's value
 * (`lib/domain/startingValueFit.ts`). Starting it blank is no way out: a
 * blank answer saves blank and clears the case's value. Undefined where the
 * question fits.
 *
 * Only the whole-number misfit is also the gate's
 * (`WHOLE_NUMBER_STARTS_ON_DECIMAL`). A choice misfit is read from the
 * property's type, and a writer of a text-typed property, a Hidden Value
 * most often, may give only values among the question's choices, so the
 * gate can't refuse a choice question's starting value on its type alone;
 * the value-level guarantee is issue #856's. Here it refuses only a choice
 * question's own new save, which would be born opening on the property, as
 * `main` refused a choice question's save to a text property
 * (`fieldKindMatchesPropertyType`'s declared-type check there).
 */
function startingValueRefusal(
	doc: BlueprintDoc,
	field: Field,
	formName: string,
	caseType: string,
	property: string,
): string | undefined {
	const misfit = startingValueMisfit(doc, field, caseType, property);
	if (misfit === undefined) return undefined;
	const subject = `"${field.id}" in "${formName}" can't save to "${property}", because it would open on the case's value`;
	const blank = "Leaving it blank would clear the case's value.";
	const offers =
		"CommCare's Web Apps can't open a form whose choice question starts on a value it doesn't offer";
	switch (misfit.kind) {
		case "whole-number-on-decimal":
			return `${subject}, which can be a decimal number, and CommCare stops a form when a whole-number question opens on one. ${blank} You can make "${field.id}" a decimal question, or save it to a property that holds whole numbers.`;
		case "several-choices":
			return `${subject}, which can be several choices at once, more than a single-choice question takes, and ${offers}. ${blank} You can make "${field.id}" a multiple-choice question, or save it to a property that holds a single choice.`;
		case "outside-choices": {
			const fitting =
				field.kind === "single_select"
					? "a property that holds a single choice"
					: "a property that holds choices";
			return `${subject}, which can be ${valueKindPhrase(misfit.type)} that isn't one of its choices, and ${offers}. ${blank} You can make "${field.id}" a text question, or save it to ${fitting}.`;
		}
	}
}

/** The refusal for removing the only name a registration gives its case. */
export const NEW_CASE_NEEDS_NAME_MESSAGE =
	"A new case needs a name. Choose another question to name it first.";

const FIELD_GONE_MESSAGE = "This question is no longer part of the app.";
const SAVE_GONE_MESSAGE =
	"This question no longer saves there. Look at where it saves now and choose the save to change.";

/** The refusal for a write to a child case type that has no case to land on
 *  yet: a new case is created only with a name. */
export function saveNewCaseNameFirstMessage(caseType: string): string {
	return `Save a name for the new ${caseType} first.`;
}

const q = (value: string): string => `"${value}"`;

function unknownTypeMessage(
	field: Field,
	form: Form,
	caseType: string,
): string {
	return `${q(field.id)} in ${q(form.name)} saves to the ${q(caseType)} case type, but no case type by that name exists. Add that case type, or point the field at one that does.`;
}

function notDirectChildMessage(
	field: Field,
	form: Form,
	caseType: string,
): string {
	return `${q(field.id)} in ${q(form.name)} saves to ${q(caseType)}, but this form can save only to its main case or one of that case's direct children. Choose one of those destinations, or clear the case destination.`;
}

function noCaseMessage(field: Field, form: Form, caseType: string): string {
	return `${q(field.id)} in ${q(form.name)} can't save to ${q(caseType)}, because this form doesn't create, open, or close a case. Make it a registration, follow-up or close form, or save the answer to the worker's record.`;
}

function viaMismatchMessage(
	field: Field,
	moduleCaseType: string,
	caseType: string,
): string {
	return `${q(field.id)} saves to a case above this form's ${moduleCaseType} case, but the cases above it don't reach a ${caseType} case that way. Choose a case above it that the catalog links to.`;
}

function alreadySavedMessage(property: string, caseLabel: string): string {
	return `${caseLabel} already saves another value to ${property}. Stop that save first, or choose another property.`;
}

function createNameMissingMessage(form: Form, caseType: string): string {
	return userFacingError({
		code: "CASE_CREATE_NAME_MISSING",
		scope: "form",
		message: "",
		location: { formUuid: form.uuid, formName: form.name },
		details: { caseType },
	});
}

// ── The form a plan edits ────────────────────────────────────────────────

/** What a plan reads of the form it edits. */
export interface CaseWriteFormContext {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly form: Form;
	/** The case type of the form's module, if it has one. */
	readonly moduleCaseType: string | undefined;
	/** The form's own case, on a case form of a module with a case type. */
	readonly own: OwnCaseOperation | undefined;
	/** Each multiplicity scope's position in the order the wire meets them
	 *  (`caseOperationMultiplicityScopes`), the form root first. */
	readonly scopeRank: ReadonlyMap<Uuid | undefined, number>;
}

export function caseWriteFormContext(
	doc: BlueprintDoc,
	formUuid: Uuid,
): CaseWriteFormContext | undefined {
	const form = Object.hasOwn(doc.forms, formUuid)
		? doc.forms[formUuid]
		: undefined;
	if (form === undefined) return undefined;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const moduleCaseType =
		moduleUuid === undefined ? undefined : doc.modules[moduleUuid]?.caseType;
	const own = form.caseOperations?.find(
		(operation): operation is OwnCaseOperation => operation.action === "own",
	);
	return {
		doc,
		formUuid,
		form,
		moduleCaseType,
		own,
		scopeRank: new Map(
			caseOperationMultiplicityScopes(doc, formUuid).map((scope, index) => [
				scope,
				index,
			]),
		),
	};
}

/** The repeat a field's answer repeats in: the field itself when it is a
 *  repeat, else its nearest repeat ancestor; `undefined` at the form root. */
export function nearestRepeatOf(
	doc: Pick<BlueprintDoc, "fields" | "fieldParent" | "forms">,
	fieldUuid: Uuid,
): Uuid | undefined {
	let cursor: Uuid | undefined = fieldUuid;
	const seen = new Set<Uuid>();
	while (cursor !== undefined && !seen.has(cursor)) {
		seen.add(cursor);
		if (Object.hasOwn(doc.forms, cursor)) return undefined;
		const field = Object.hasOwn(doc.fields, cursor)
			? doc.fields[cursor]
			: undefined;
		if (field?.kind === "repeat") return cursor;
		cursor = doc.fieldParent[cursor] ?? undefined;
	}
	return undefined;
}

/** The link target that names the form's own case: the operation that
 *  creates it on a registration, the loaded case anywhere else. */
export function ownCaseLinkTarget(
	ctx: Pick<CaseWriteFormContext, "form" | "own">,
): NonNullable<CaseOperationLink["target"]> {
	return ctx.form.type === "registration" && ctx.own !== undefined
		? { kind: "op", opUuid: ctx.own.uuid }
		: { kind: "session" };
}

/** Whether `operation` is a new case beneath the form's own case: a create
 *  whose only link is a `parent` link to the own case. */
export function isChildOfOwnCase(
	ctx: Pick<CaseWriteFormContext, "form" | "own">,
	operation: CaseOperation,
): boolean {
	if (operation.action !== "create") return false;
	const links = operation.links ?? [];
	const link = links[0];
	return (
		links.length === 1 &&
		link !== undefined &&
		link.identifier === "parent" &&
		link.target !== null &&
		deepEqual(link.target, ownCaseLinkTarget(ctx))
	);
}

/**
 * The create a field's answer of a child type in `repeat` joins: the first
 * create of `caseType` beneath the own case with `repeat` as its `forEach`,
 * no authored id and no condition of its own.
 */
export function joinableChildCreate(
	ctx: Pick<CaseWriteFormContext, "form" | "own">,
	operations: readonly CaseOperation[],
	caseType: string,
	repeat: Uuid | undefined,
): CaseOperation | undefined {
	return operations.find(
		(operation) =>
			operation.action === "create" &&
			operation.caseType === caseType &&
			operation.forEach?.repeat === repeat &&
			operation.target.kind === "new" &&
			operation.target.idFrom === undefined &&
			operation.condition === undefined &&
			isChildOfOwnCase(ctx, operation),
	);
}

/** The form's update of the worker's own record, if it has one. */
export function workerRecordUpdate(
	operations: readonly CaseOperation[],
): CaseOperation | undefined {
	return operations.find(
		(operation) =>
			operation.action === "update" &&
			operation.target.kind === "worker-record",
	);
}

/** The value that saves `field`'s answer as it is: the link to the file for a
 *  capture, the bare answer otherwise. */
export function fieldAnswerValue(field: Field): Expression {
	return isCaptureField(field)
		? { kind: "term", term: { kind: "capture-link", field: field.uuid } }
		: { kind: "term", term: { kind: "field", uuid: field.uuid } };
}

/** The position a new operation of `scope` takes among `operations`: after
 *  the last one whose scope the wire meets no later than its own. */
export function insertionIndexForScope(
	scopeRank: ReadonlyMap<Uuid | undefined, number>,
	operations: readonly CaseOperation[],
	scope: Uuid | undefined,
): number {
	const rank = scopeRank.get(scope) ?? Number.POSITIVE_INFINITY;
	let index = 0;
	operations.forEach((operation, position) => {
		if (operation.action === "own") {
			index = Math.max(index, position + 1);
			return;
		}
		const operationRank = scopeRank.get(operation.forEach?.repeat);
		if (operationRank !== undefined && operationRank <= rank)
			index = position + 1;
	});
	return index;
}

// ── The working copy a plan edits ────────────────────────────────────────

/** One value a plan saves: an operation's name or owner, or one write. */
type SavedValue =
	| { readonly slot: "name" | "owner"; readonly value: Expression }
	| { readonly slot: "write"; readonly write: CaseOperationWrite };

interface PlanDraft {
	readonly ctx: CaseWriteFormContext;
	/** The form's operations as the batch leaves them so far. */
	readonly operations: CaseOperation[];
	readonly mutations: Mutation[];
	/** Operations a removal left smaller, checked once the batch is planned. */
	readonly shrunk: Set<Uuid>;
	/** The writes each operation gained, for the catalog. */
	readonly added: Map<Uuid, CaseOperationWrite[]>;
	/** Operations the batch creates. */
	readonly created: Set<Uuid>;
}

function draftFor(ctx: CaseWriteFormContext): PlanDraft {
	return {
		ctx,
		operations: structuredClone(ctx.form.caseOperations ?? []),
		mutations: [],
		shrunk: new Set(),
		added: new Map(),
		created: new Set(),
	};
}

function formEdit(
	formUuid: Uuid,
	edit: Pick<
		Extract<Mutation, { kind: "updateForm" }>,
		"caseOperationChange" | "caseOperationPatch"
	>,
): Mutation {
	return { kind: "updateForm", uuid: formUuid, patch: {}, ...edit };
}

function patchSlot(
	draft: PlanDraft,
	operation: CaseOperation,
	slot: "name" | "owner",
	value: Expression | null,
): void {
	draft.mutations.push(
		formEdit(draft.ctx.formUuid, {
			caseOperationPatch: {
				operation: "update",
				uuid: operation.uuid,
				targetAction: operation.action,
				patch: { [slot]: value },
			} as NonNullable<
				Extract<Mutation, { kind: "updateForm" }>["caseOperationPatch"]
			>,
		}),
	);
}

function removeOperation(draft: PlanDraft, uuid: Uuid): void {
	const index = draft.operations.findIndex(
		(operation) => operation.uuid === uuid,
	);
	if (index === -1) return;
	draft.operations.splice(index, 1);
	draft.created.delete(uuid);
	draft.added.delete(uuid);
	draft.mutations.push(
		formEdit(draft.ctx.formUuid, {
			caseOperationChange: { operation: "remove", uuid },
		}),
	);
}

/** Add `operation` where its scope puts it in the wire's order. */
function addOperation(draft: PlanDraft, operation: CaseOperation): void {
	const index = insertionIndexForScope(
		draft.ctx.scopeRank,
		draft.operations,
		operation.forEach?.repeat,
	);
	draft.mutations.push(
		formEdit(draft.ctx.formUuid, {
			caseOperationChange: {
				operation: "add",
				value: structuredClone(operation),
			} as NonNullable<
				Extract<Mutation, { kind: "updateForm" }>["caseOperationChange"]
			>,
		}),
	);
	if (index < draft.operations.length) {
		const after = draft.operations[index - 1]?.uuid ?? null;
		draft.mutations.push(
			formEdit(draft.ctx.formUuid, {
				caseOperationPatch: { operation: "move", uuid: operation.uuid, after },
			}),
		);
	}
	draft.operations.splice(index, 0, operation);
	draft.created.add(operation.uuid);
}

function takenOperationIds(draft: PlanDraft): Set<string> {
	return new Set(draft.operations.map((operation) => operation.id));
}

function operationIn(draft: PlanDraft, uuid: Uuid): CaseOperation | undefined {
	return draft.operations.find((operation) => operation.uuid === uuid);
}

/** Take the write `view` names out of its operation. */
function removeViewWrite(draft: PlanDraft, view: FieldCaseWriteView): void {
	const operation = operationIn(draft, view.operationUuid);
	if (operation === undefined) return;
	if (view.slot === "write") {
		const key: CaseWriteKey =
			view.via === undefined
				? { property: view.property }
				: { property: view.property, via: view.via };
		const writes = (operation.writes ?? []).filter(
			(write) => !sameCaseWriteKey(caseWriteKeyOf(write), key),
		);
		if (writes.length === 0) delete operation.writes;
		else operation.writes = writes;
		draft.shrunk.add(operation.uuid);
		draft.mutations.push(
			formEdit(draft.ctx.formUuid, {
				caseOperationPatch: {
					operation: "remove-write",
					uuid: operation.uuid,
					key,
				},
			}),
		);
		return;
	}
	if (view.slot === "name") delete operation.name;
	else delete operation.owner;
	draft.shrunk.add(operation.uuid);
	// A new case's name cannot be cleared: the create goes, or the plan is
	// refused, once the batch is planned.
	if (view.slot === "name" && operation.action === "create") return;
	patchSlot(draft, operation, view.slot, null);
}

/** The case a refusal about `operation` names. */
function caseLabel(
	ctx: CaseWriteFormContext,
	operation: CaseOperation,
): string {
	if (operation.action === "own")
		return `This form's ${ctx.moduleCaseType ?? "own"} case`;
	if (
		operation.action === "update" &&
		operation.target.kind === "worker-record"
	)
		return "The worker's record";
	return `The new ${operation.caseType} case`;
}

/** Save `saved` on `operation`; a refusal when that place already saves
 *  another value. */
function saveOn(
	draft: PlanDraft,
	operation: CaseOperation,
	saved: SavedValue,
): string | undefined {
	if (saved.slot !== "write") {
		const current = operation[saved.slot];
		if (current !== undefined) {
			if (deepEqual(current, saved.value)) return undefined;
			return alreadySavedMessage(
				saved.slot === "name" ? "case_name" : "owner_id",
				caseLabel(draft.ctx, operation),
			);
		}
		operation[saved.slot] = saved.value;
		patchSlot(draft, operation, saved.slot, saved.value);
		return undefined;
	}
	const key = caseWriteKeyOf(saved.write);
	const existing = (operation.writes ?? []).find((write) =>
		sameCaseWriteKey(caseWriteKeyOf(write), key),
	);
	if (existing !== undefined) {
		if (deepEqual(existing, saved.write)) return undefined;
		return alreadySavedMessage(
			saved.write.property,
			caseLabel(draft.ctx, operation),
		);
	}
	operation.writes = [...(operation.writes ?? []), saved.write];
	const added = draft.added.get(operation.uuid) ?? [];
	added.push(saved.write);
	draft.added.set(operation.uuid, added);
	draft.mutations.push(
		formEdit(draft.ctx.formUuid, {
			caseOperationPatch: {
				operation: "add-write",
				uuid: operation.uuid,
				value: structuredClone(saved.write),
			},
		}),
	);
	return undefined;
}

/** Where a value of `property` goes on an operation that has a name and an
 *  owner of its own. */
function savedValueFor(
	operation: Pick<CaseOperation, "action">,
	property: string,
	value: Expression,
	facets: Pick<CaseOperationWrite, "condition" | "via" | "onlyIfChanged"> = {},
): SavedValue {
	const scalar =
		facets.via === undefined &&
		facets.condition === undefined &&
		facets.onlyIfChanged === undefined &&
		operation.action !== "update";
	if (scalar && property === "case_name") return { slot: "name", value };
	if (scalar && property === "owner_id") return { slot: "owner", value };
	return {
		slot: "write",
		write: {
			property,
			value,
			...(facets.condition !== undefined && { condition: facets.condition }),
			...(facets.via !== undefined && { via: facets.via }),
			...(facets.onlyIfChanged !== undefined && {
				onlyIfChanged: facets.onlyIfChanged,
			}),
		},
	};
}

/** Save a child type's value on the create of `(caseType, repeat)` beneath
 *  the own case, making that create when it is missing. */
function saveOnChild(
	draft: PlanDraft,
	caseType: string,
	repeat: Uuid | undefined,
	relationship: CaseOperationLink["relationship"],
	property: string,
	value: Expression,
	facets: Pick<CaseOperationWrite, "condition"> = {},
): string | undefined {
	const { ctx } = draft;
	const create = joinableChildCreate(ctx, draft.operations, caseType, repeat);
	if (create !== undefined)
		return saveOn(
			draft,
			create,
			savedValueFor(create, property, value, facets),
		);
	if (property !== "case_name" || facets.condition !== undefined)
		return saveNewCaseNameFirstMessage(caseType);
	addOperation(draft, {
		uuid: asUuid(crypto.randomUUID()),
		id: ownCaseOperationId(caseType, takenOperationIds(draft)),
		action: "create",
		caseType,
		target: { kind: "new" },
		name: value,
		links: [
			{
				identifier: "parent",
				targetType: ctx.moduleCaseType as string,
				target: ownCaseLinkTarget(ctx),
				relationship,
			},
		],
		...(repeat !== undefined && { forEach: { repeat } }),
	});
	return undefined;
}

/** Save a value on the form's update of the worker's record, making that
 *  update when the form has none. */
function saveOnWorkerRecord(
	draft: PlanDraft,
	property: string,
	value: Expression,
): string | undefined {
	const update = workerRecordUpdate(draft.operations);
	const saved = savedValueFor({ action: "update" }, property, value);
	if (update !== undefined) return saveOn(draft, update, saved);
	if (saved.slot !== "write") return undefined;
	addOperation(draft, {
		uuid: asUuid(crypto.randomUUID()),
		id: ownCaseOperationId(USERCASE_CASE_TYPE, takenOperationIds(draft)),
		action: "update",
		caseType: USERCASE_CASE_TYPE,
		target: { kind: "worker-record" },
		writes: [saved.write],
	});
	return undefined;
}

/**
 * Check what the removals left, and finish the batch: a new case left with
 * nothing goes with its last save, one left with saves and no name refuses,
 * a worker-record update left with no writes goes, and a registration whose
 * own case lost its name refuses. Then lead the batch with the catalog
 * entries the new saves need.
 */
function finish(draft: PlanDraft): string | undefined {
	const { ctx } = draft;
	for (const uuid of draft.shrunk) {
		const operation = operationIn(draft, uuid);
		if (operation === undefined) continue;
		if (operation.action === "own") {
			if (ctx.form.type === "registration" && operation.name === undefined)
				return NEW_CASE_NEEDS_NAME_MESSAGE;
			continue;
		}
		if (operation.action === "create" && operation.name === undefined) {
			if ((operation.writes ?? []).length > 0 || operation.owner !== undefined)
				return createNameMissingMessage(ctx.form, operation.caseType);
			removeOperation(draft, uuid);
			continue;
		}
		if (
			operation.action === "update" &&
			operation.target.kind === "worker-record" &&
			(operation.writes ?? []).length === 0
		)
			removeOperation(draft, uuid);
	}
	const catalog = catalogMutationsForOperations(
		ctx.doc,
		draft.operations.flatMap((operation) => {
			if (operation.caseType === USERCASE_CASE_TYPE) return [];
			if (draft.created.has(operation.uuid))
				return [{ operation, ownCaseType: ctx.moduleCaseType }];
			const added = draft.added.get(operation.uuid);
			return added === undefined
				? []
				: [
						{
							operation: { ...operation, writes: added, links: undefined },
							ownCaseType: ctx.moduleCaseType,
						},
					];
		}),
	);
	draft.mutations.unshift(...catalog);
	return undefined;
}

type ResolvedDestination =
	| { readonly kind: "own" }
	| {
			readonly kind: "child";
			readonly relationship: CaseOperationLink["relationship"];
	  }
	| { readonly kind: "worker-record" }
	| { readonly kind: "refused"; readonly message: string };

function resolveDestination(
	ctx: CaseWriteFormContext,
	field: Field,
	destination: FieldCaseWriteDestination,
): ResolvedDestination {
	const { form, moduleCaseType, own } = ctx;
	if (
		destination.via === undefined &&
		destination.caseType === USERCASE_CASE_TYPE
	)
		return { kind: "worker-record" };
	const caseTypes = ctx.doc.caseTypes ?? [];
	if (own === undefined || moduleCaseType === undefined) {
		if (
			destination.via === undefined &&
			destination.caseType !== moduleCaseType &&
			!caseTypes.some((caseType) => caseType.name === destination.caseType)
		)
			return {
				kind: "refused",
				message: unknownTypeMessage(field, form, destination.caseType),
			};
		return {
			kind: "refused",
			message: noCaseMessage(field, form, destination.caseType),
		};
	}
	if (destination.via !== undefined) {
		const reached = resolveRelationDestination(
			{ kind: "ancestor", via: destination.via },
			moduleCaseType,
			caseTypes,
		);
		return reached.ok && reached.caseType === destination.caseType
			? { kind: "own" }
			: {
					kind: "refused",
					message: viaMismatchMessage(
						field,
						moduleCaseType,
						destination.caseType,
					),
				};
	}
	if (destination.caseType === moduleCaseType) return { kind: "own" };
	const declared = caseTypes.find(
		(caseType) => caseType.name === destination.caseType,
	);
	if (declared === undefined)
		return {
			kind: "refused",
			message: unknownTypeMessage(field, form, destination.caseType),
		};
	if (declared.parent_type !== moduleCaseType)
		return {
			kind: "refused",
			message: notDirectChildMessage(field, form, destination.caseType),
		};
	return { kind: "child", relationship: declared.relationship ?? "child" };
}

function viewMatchesKey(
	view: FieldCaseWriteView,
	key: FieldCaseWriteViewKey,
): boolean {
	if (view.operationUuid !== key.operationUuid || view.slot !== key.slot)
		return false;
	if (view.slot !== "write") return true;
	return (
		key.key !== undefined &&
		sameCaseWriteKey(
			view.via === undefined
				? { property: view.property }
				: { property: view.property, via: view.via },
			key.key,
		)
	);
}

function viewIsDestination(
	view: FieldCaseWriteView,
	destination: FieldCaseWriteDestination,
): boolean {
	return (
		view.caseType === destination.caseType &&
		view.property === destination.property &&
		view.onlyIfChanged === (destination.onlyIfChanged === true) &&
		sameCaseWriteKey(
			{ property: view.property, ...(view.via && { via: view.via }) },
			{
				property: destination.property,
				...(destination.via && { via: destination.via }),
			},
		)
	);
}

function fieldIn(doc: BlueprintDoc, fieldUuid: Uuid): Field | undefined {
	return Object.hasOwn(doc.fields, fieldUuid)
		? doc.fields[fieldUuid]
		: undefined;
}

/**
 * Replace the field's whole "Saves to" (`replace` absent) or the one save
 * `replace` names with `destination`; `null` removes. A replacement is the
 * removal then the addition, in one batch.
 *
 * A new save to the form's own case on a follow-up or close form that opens
 * one case is born with the case's current value as the question's starting
 * value, when the question holds none yet (`writerOffersPreload`); the
 * result's `notes` say so. Where the question can't open on the case's
 * value, a whole-number question on a property that holds decimal numbers
 * or a choice question on one that can hold values outside its choices
 * (`lib/domain/startingValueFit.ts`), a new save, or a save moved to another
 * property, is refused, since starting it blank would clear the case's
 * value.
 *
 * Only a new or moved save is born a starting value or refused for one. A
 * save the question keeps, whether a flip of "Save only if changed", a
 * whole replace naming it or a removal of another save keeps it, keeps its
 * standing: it is neither refused nor born one, and the gate judges
 * whatever starting value the question holds. A starting value born for a
 * save the plan removes or moves goes with it, and the `notes` say the
 * question starts blank, with the starting value that opens it on a save to
 * its form's case it can open on (`startsBlankNote`).
 */
export function planFieldCaseWrite(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	destination: FieldCaseWriteDestination | null,
	options: { readonly replace?: FieldCaseWriteViewKey } = {},
): FieldCaseWritePlan {
	const field = fieldIn(doc, fieldUuid);
	const formUuid =
		field === undefined ? undefined : formOfField(doc, fieldUuid);
	const ctx =
		formUuid === undefined ? undefined : caseWriteFormContext(doc, formUuid);
	if (field === undefined || ctx === undefined)
		return { ok: false, message: FIELD_GONE_MESSAGE };

	const views = fieldCaseWriteViews(doc, fieldUuid).filter(
		(view) => view.formUuid === ctx.formUuid,
	);
	const { replace } = options;
	const removed =
		replace === undefined
			? views
			: views.filter((view) => viewMatchesKey(view, replace));
	if (replace !== undefined && removed.length === 0)
		return { ok: false, message: SAVE_GONE_MESSAGE };
	if (
		destination !== null &&
		removed.length === 1 &&
		(replace !== undefined || views.length === 1) &&
		viewIsDestination(removed[0], destination)
	)
		return { ok: true, mutations: [], notes: [] };

	const draft = draftFor(ctx);
	for (const view of removed) removeViewWrite(draft, view);

	let preload: { readonly property: string } | undefined;
	/** A removed save that read its own case's `property` directly, the save
	 *  a born starting value belongs to. */
	const removesOwnSave = (property: string) =>
		removed.some(
			(view) =>
				view.destination === "own" &&
				view.slot !== "owner" &&
				view.via === undefined &&
				view.property === property,
		);
	/* A replace that keeps a property the question saves to, as a flip of
	 * "Save only if changed" or a whole replace naming one of its saves
	 * does, leaves that save standing: the planner neither refuses it for
	 * its starting value, which would block edits that don't touch one, nor
	 * bears it one, and the gate still judges whatever starting value the
	 * question holds. */
	const keepsProperty =
		destination !== null &&
		destination.via === undefined &&
		destination.caseType === ctx.moduleCaseType &&
		removesOwnSave(destination.property);
	/* A starting value the planner bore for a save it now removes or moves
	 * reads that save's property, so it is the question's no longer. The
	 * starting value of a save the replace keeps stays. */
	const born = fieldPreload(field);
	const bornOfRemoved =
		born !== undefined &&
		born.caseType === ctx.moduleCaseType &&
		removesOwnSave(born.property) &&
		!(keepsProperty && born.property === destination?.property);
	const offerDoc: BlueprintDoc = bornOfRemoved
		? {
				...doc,
				fields: {
					...doc.fields,
					[fieldUuid]: withoutDefault(field),
				},
			}
		: doc;
	if (destination !== null) {
		const resolved = resolveDestination(ctx, field, destination);
		const value = fieldAnswerValue(field);
		let refusal: string | undefined;
		switch (resolved.kind) {
			case "refused":
				return { ok: false, message: resolved.message };
			case "worker-record":
				refusal = saveOnWorkerRecord(draft, destination.property, value);
				break;
			case "child":
				refusal = saveOnChild(
					draft,
					destination.caseType,
					nearestRepeatOf(doc, fieldUuid),
					resolved.relationship,
					destination.property,
					value,
				);
				break;
			case "own": {
				const own = operationIn(draft, (ctx.own as OwnCaseOperation).uuid);
				if (own === undefined)
					return { ok: false, message: FIELD_GONE_MESSAGE };
				const saved = savedValueFor(own, destination.property, value, {
					...(destination.via !== undefined && { via: destination.via }),
					...(destination.onlyIfChanged !== undefined && {
						onlyIfChanged: destination.onlyIfChanged,
					}),
				});
				refusal = saveOn(draft, own, saved);
				// A save the case can't take says so before its starting value.
				if (refusal !== undefined) break;
				// Only a new or moved save is born a starting value, or refused.
				if (
					!keepsProperty &&
					saved.slot !== "owner" &&
					destination.via === undefined &&
					ctx.moduleCaseType !== undefined &&
					writerOffersPreload(offerDoc, fieldUuid, destination.property)
				) {
					const unfit = startingValueRefusal(
						doc,
						field,
						ctx.form.name,
						ctx.moduleCaseType,
						destination.property,
					);
					if (unfit !== undefined) return { ok: false, message: unfit };
					preload = { property: destination.property };
				}
				break;
			}
		}
		if (refusal !== undefined) return { ok: false, message: refusal };
	}
	const refusal = finish(draft);
	if (refusal !== undefined) return { ok: false, message: refusal };

	const notes: string[] = [];
	if (preload !== undefined && ctx.moduleCaseType !== undefined) {
		draft.mutations.push({
			kind: "updateField",
			uuid: fieldUuid,
			targetKind: field.kind,
			patch: {
				default_value: {
					kind: "term",
					term: {
						kind: "form-case",
						caseType: ctx.moduleCaseType,
						property: preload.property,
					},
				},
			},
		} as Mutation);
		notes.push(OPENS_WITH_CASE_VALUE_NOTE);
	} else if (bornOfRemoved) {
		draft.mutations.push({
			kind: "updateField",
			uuid: fieldUuid,
			targetKind: field.kind,
			patch: { default_value: null },
		} as Mutation);
		notes.push(
			startsBlankNote(
				{
					...offerDoc,
					forms: {
						...offerDoc.forms,
						[ctx.formUuid]: {
							...offerDoc.forms[ctx.formUuid],
							caseOperations: draft.operations,
						},
					},
				},
				field,
				ctx,
			),
		);
	}
	return { ok: true, mutations: draft.mutations, notes };
}

/**
 * The saves a move of `fieldUuid` under `toParentUuid` carries: each save of
 * the moved question (or of one beneath it) to a new child case of its old
 * repeat moves to the new case of the same type in its new repeat, joining
 * the one there or making it, as `planFieldCaseWrite` does; a new case left
 * with nothing goes. Saves to the own case and the worker's record stay
 * where they are, and the gate judges them in their new place.
 *
 * Planned on the document before the move; the caller appends the batch
 * after its `moveField`. A move to another form carries nothing here.
 */
export function planFieldMoveCaseWrites(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	toParentUuid: Uuid,
): FieldCaseWritePlan {
	const formUuid = formOfField(doc, fieldUuid);
	const ctx =
		formUuid === undefined ? undefined : caseWriteFormContext(doc, formUuid);
	if (ctx === undefined) return { ok: false, message: FIELD_GONE_MESSAGE };
	const toFormUuid = Object.hasOwn(doc.forms, toParentUuid)
		? toParentUuid
		: formOfField(doc, toParentUuid);
	if (toFormUuid !== formUuid) return { ok: true, mutations: [], notes: [] };
	const parentRepeat = Object.hasOwn(doc.forms, toParentUuid)
		? undefined
		: nearestRepeatOf(doc, toParentUuid);

	type Rehome = {
		readonly view: FieldCaseWriteView;
		readonly create: CaseOperation;
		readonly repeat: Uuid | undefined;
	};
	const rehomes: Rehome[] = [];
	for (const moved of [fieldUuid, ...descendantFieldUuids(doc, fieldUuid)]) {
		const oldRepeat = nearestRepeatOf(doc, moved);
		const newRepeat = repeatWithinMoved(doc, moved, fieldUuid) ?? parentRepeat;
		if (oldRepeat === newRepeat) continue;
		for (const view of fieldCaseWriteViews(doc, moved)) {
			if (view.formUuid !== ctx.formUuid || view.destination !== "child")
				continue;
			const create = ctx.form.caseOperations?.find(
				(operation) => operation.uuid === view.operationUuid,
			);
			if (create?.action !== "create" || create.forEach?.repeat !== oldRepeat)
				continue;
			rehomes.push({ view, create, repeat: newRepeat });
		}
	}
	if (rehomes.length === 0) return { ok: true, mutations: [], notes: [] };

	const draft = draftFor(ctx);
	for (const { view } of rehomes) removeViewWrite(draft, view);
	for (const { view, create, repeat } of nameFirstWithinBuckets(rehomes)) {
		const value =
			view.slot === "write"
				? create.writes?.find((write) =>
						sameCaseWriteKey(caseWriteKeyOf(write), {
							property: view.property,
						}),
					)
				: undefined;
		const refusal = saveOnChild(
			draft,
			view.caseType,
			repeat,
			create.links?.[0]?.relationship ?? "child",
			view.property,
			view.slot === "name"
				? (create.name as Expression)
				: view.slot === "owner"
					? (create.owner as Expression)
					: (value as CaseOperationWrite).value,
			value?.condition === undefined ? {} : { condition: value.condition },
		);
		if (refusal !== undefined) return { ok: false, message: refusal };
	}
	const refusal = finish(draft);
	if (refusal !== undefined) return { ok: false, message: refusal };
	return { ok: true, mutations: draft.mutations, notes: [] };
}

/** The nearest repeat of `uuid` that the move carries with it: one at or
 *  beneath the moved root. */
function repeatWithinMoved(
	doc: BlueprintDoc,
	uuid: Uuid,
	root: Uuid,
): Uuid | undefined {
	let cursor: Uuid | undefined = uuid;
	while (cursor !== undefined) {
		if (doc.fields[cursor]?.kind === "repeat") return cursor;
		if (cursor === root) return undefined;
		cursor = doc.fieldParent[cursor] ?? undefined;
	}
	return undefined;
}

/**
 * `items` in their order, except that the first item of each `(case type,
 * repeat)` bucket is preceded by that bucket's name, so a new case is made
 * with its name before anything else saves to it.
 */
export function nameFirstWithinBuckets<
	T extends {
		readonly view: Pick<FieldCaseWriteView, "caseType" | "slot">;
		readonly repeat: Uuid | undefined;
	},
>(items: readonly T[]): T[] {
	const bucketOf = (item: T) =>
		JSON.stringify([item.view.caseType, item.repeat ?? null]);
	const names = new Map<string, T>();
	for (const item of items)
		if (item.view.slot === "name" && !names.has(bucketOf(item)))
			names.set(bucketOf(item), item);
	const seen = new Set<string>();
	const ordered: T[] = [];
	for (const item of items) {
		const bucket = bucketOf(item);
		if (!seen.has(bucket)) {
			seen.add(bucket);
			const name = names.get(bucket);
			if (name !== undefined) ordered.push(name);
		}
		if (item !== names.get(bucket)) ordered.push(item);
	}
	return ordered;
}
