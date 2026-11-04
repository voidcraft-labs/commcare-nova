// lib/doc/fieldWriteOperations.ts
//
// The operations a form's field writes become, when writes are stated as
// facts about fields (a question saves its answer to `caseType.property`)
// rather than as the form's operations. The cutover lifts each stored
// field's destination into such a fact, and the fuzz mapping draws them;
// both turn the facts into the one model here, so a dry run and its
// execution, or one draw mapped twice, name the same operations.
//
// The facts are bucketed as a field's destination always was: the module's
// case type is the form's own case, `commcare-user` the worker's record, and
// a declared direct child type of the module's one new case per `(type,
// nearest repeat)`, with the relationship the catalog gives the type. Each
// bucket becomes one operation:
//
// - the own case, first: its name the bare read of its `case_name` writer,
//   every other writer one of its writes in data-tree order (classes C1);
// - a create per child bucket: its name its `case_name` writer, the rest its
//   writes, one `parent` link to the own case and the repeat as its
//   `forEach` (C2);
// - one update of the worker's record holding every worker writer (C3).
//
// A capture's write saves the link to its file (`capture-link`). A fact the
// form cannot hold (a case type the module's case form neither is nor holds
// as a direct child, or a case write on a survey) makes nothing: it was never
// a write any platform ran.
//
// The operations stand in the order the wire runs them: the own case first;
// then, scope by scope in `caseOperationMultiplicityScopes` order, the form's
// stored operations of that scope followed by that scope's new creates in
// bucket order; and the worker's record after the root scope's operations.
//
// Identities are derived, never random. Each new operation's UUID is
// `caseWriteOperationUuid(appId, formUuid, unit, attempt)` with the first
// attempt no entity of the document holds, and its `id` the module's case
// type (the own case) or its own type, made unique among the form's operation
// ids. An operation the form already holds for a bucket (its own case, the
// create a field of the bucket would join, its worker-record update) is kept
// and given only the saves it lacks, so planning the result again plans
// nothing.

import {
	authoredBlueprintIdentities,
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	type CaseWriteOperationUnit,
	caseWriteKeyOf,
	caseWriteOperationUuid,
	type Expression,
	type OwnCaseOperation,
	ownCaseOperationId,
	sameCaseWriteKey,
	USERCASE_CASE_TYPE,
	type Uuid,
} from "@/lib/domain";
import { caseOperationMultiplicityScopes } from "./caseOperationOrder";
import {
	caseWriteFormContext,
	joinableChildCreate,
	nearestRepeatOf,
	ownCaseLinkTarget,
	workerRecordUpdate,
} from "./fieldCaseWriteMutations";
import type { Mutation } from "./types";

/** One question that saves its answer to a case property. */
export interface FieldWriteFact {
	readonly fieldUuid: Uuid;
	readonly caseType: string;
	readonly property: string;
	/** A capture kind: its value is `capture-link`. */
	readonly capture: boolean;
}

interface Bucket {
	name?: Expression;
	writes: CaseOperationWrite[];
}

interface ChildBucket extends Bucket {
	readonly caseType: string;
	readonly repeat: Uuid | undefined;
	readonly relationship: CaseOperationLink["relationship"];
}

function factValue(fact: FieldWriteFact): Expression {
	return fact.capture
		? { kind: "term", term: { kind: "capture-link", field: fact.fieldUuid } }
		: { kind: "term", term: { kind: "field", uuid: fact.fieldUuid } };
}

function addToBucket(bucket: Bucket, fact: FieldWriteFact): void {
	const value = factValue(fact);
	if (fact.property === "case_name" && bucket.name === undefined) {
		bucket.name = value;
		return;
	}
	bucket.writes.push({ property: fact.property, value });
}

type UpdateForm = Extract<Mutation, { kind: "updateForm" }>;

function formEdit(
	formUuid: Uuid,
	edit: Pick<UpdateForm, "caseOperationChange" | "caseOperationPatch">,
): Mutation {
	return { kind: "updateForm", uuid: formUuid, patch: {}, ...edit };
}

/**
 * The mutations that give `formUuid` the operations its field writes made
 * (`facts` in data-tree order): classes C1 to C3 of the case-writes cutover.
 * Pure and deterministic; a second application to its own result plans
 * nothing.
 */
export function operationsFromFieldWrites(
	doc: BlueprintDoc,
	formUuid: Uuid,
	facts: readonly FieldWriteFact[],
): readonly Mutation[] {
	const ctx = caseWriteFormContext(doc, formUuid);
	if (ctx === undefined) return [];
	const { form, moduleCaseType } = ctx;
	const caseForm = form.type !== "survey" && moduleCaseType !== undefined;
	const caseTypes = doc.caseTypes ?? [];

	const own: Bucket = { writes: [] };
	const children = new Map<string, ChildBucket>();
	const worker: CaseOperationWrite[] = [];
	for (const fact of facts) {
		if (!Object.hasOwn(doc.fields, fact.fieldUuid)) continue;
		if (fact.caseType === USERCASE_CASE_TYPE) {
			worker.push({ property: fact.property, value: factValue(fact) });
			continue;
		}
		if (!caseForm) continue;
		if (fact.caseType === moduleCaseType) {
			addToBucket(own, fact);
			continue;
		}
		const declared = caseTypes.find(
			(caseType) => caseType.name === fact.caseType,
		);
		if (declared?.parent_type !== moduleCaseType) continue;
		const repeat = nearestRepeatOf(doc, fact.fieldUuid);
		const key = JSON.stringify([fact.caseType, repeat ?? null]);
		let bucket = children.get(key);
		if (bucket === undefined) {
			bucket = {
				caseType: fact.caseType,
				repeat,
				relationship: declared.relationship ?? "child",
				writes: [],
			};
			children.set(key, bucket);
		}
		addToBucket(bucket, fact);
	}

	const taken = new Set<Uuid>(
		authoredBlueprintIdentities(doc).map((identity) => identity.uuid),
	);
	const mint = (unit: CaseWriteOperationUnit): Uuid => {
		for (let attempt = 0; ; attempt++) {
			const uuid = caseWriteOperationUuid(doc.appId, formUuid, unit, attempt);
			if (!taken.has(uuid)) {
				taken.add(uuid);
				return uuid;
			}
		}
	};
	const operations: CaseOperation[] = structuredClone(
		form.caseOperations ?? [],
	);
	const ids = new Set(operations.map((operation) => operation.id));
	const mintId = (caseType: string): string => {
		const id = ownCaseOperationId(caseType, ids);
		ids.add(id);
		return id;
	};
	const mutations: Mutation[] = [];
	const created = new Set<Uuid>();
	const add = (operation: CaseOperation): void => {
		mutations.push(
			formEdit(formUuid, {
				caseOperationChange: {
					operation: "add",
					value: structuredClone(operation),
				} as NonNullable<UpdateForm["caseOperationChange"]>,
			}),
		);
		if (operation.action === "own") operations.unshift(operation);
		else operations.push(operation);
		created.add(operation.uuid);
	};
	/** Give an operation the form already holds the saves it lacks. */
	const complete = (operation: CaseOperation, bucket: Bucket): void => {
		if (
			bucket.name !== undefined &&
			operation.name === undefined &&
			operation.action !== "update" &&
			operation.action !== "close"
		) {
			operation.name = bucket.name;
			mutations.push(
				formEdit(formUuid, {
					caseOperationPatch: {
						operation: "update",
						uuid: operation.uuid,
						targetAction: operation.action,
						patch: { name: bucket.name },
					} as NonNullable<UpdateForm["caseOperationPatch"]>,
				}),
			);
		}
		for (const write of bucket.writes) {
			const key = caseWriteKeyOf(write);
			if (
				(operation.writes ?? []).some((held) =>
					sameCaseWriteKey(caseWriteKeyOf(held), key),
				)
			)
				continue;
			operation.writes = [...(operation.writes ?? []), write];
			mutations.push(
				formEdit(formUuid, {
					caseOperationPatch: {
						operation: "add-write",
						uuid: operation.uuid,
						value: structuredClone(write),
					},
				}),
			);
		}
	};
	const withSaves = (bucket: Bucket) => ({
		...(bucket.name !== undefined && { name: bucket.name }),
		...(bucket.writes.length > 0 && { writes: bucket.writes }),
	});

	// C1: the own case.
	let ownOperation: OwnCaseOperation | undefined = ctx.own;
	if (caseForm) {
		const held = operations.find(
			(operation): operation is OwnCaseOperation => operation.action === "own",
		);
		if (held !== undefined) {
			complete(held, own);
			ownOperation = held;
		} else {
			ownOperation = {
				uuid: mint("own"),
				id: mintId(moduleCaseType as string),
				action: "own",
				...withSaves(own),
			};
			add(ownOperation);
		}
	}

	// C2: a create per child bucket.
	const ownCtx = { form, own: ownOperation };
	const newCreatesByScope = new Map<Uuid | undefined, Uuid[]>();
	for (const bucket of children.values()) {
		const held = joinableChildCreate(
			ownCtx,
			operations,
			bucket.caseType,
			bucket.repeat,
		);
		if (held !== undefined) {
			complete(held, bucket);
			continue;
		}
		const unit: CaseWriteOperationUnit = `${bucket.relationship === "extension" ? "extension" : "child"}:${bucket.caseType}:${bucket.repeat ?? "root"}`;
		const create = {
			uuid: mint(unit),
			id: mintId(bucket.caseType),
			action: "create",
			caseType: bucket.caseType,
			target: { kind: "new" },
			...withSaves(bucket),
			links: [
				{
					identifier: "parent",
					targetType: moduleCaseType as string,
					target: ownCaseLinkTarget(ownCtx),
					relationship: bucket.relationship,
				},
			],
			...(bucket.repeat !== undefined && {
				forEach: { repeat: bucket.repeat },
			}),
		} as CaseOperation;
		add(create);
		const scoped = newCreatesByScope.get(bucket.repeat) ?? [];
		scoped.push(create.uuid);
		newCreatesByScope.set(bucket.repeat, scoped);
	}

	// C3: the worker's record.
	let newWorker: Uuid | undefined;
	if (worker.length > 0) {
		const held = workerRecordUpdate(operations);
		if (held !== undefined) complete(held, { writes: worker });
		else {
			newWorker = mint("usercase");
			add({
				uuid: newWorker,
				id: mintId(USERCASE_CASE_TYPE),
				action: "update",
				caseType: USERCASE_CASE_TYPE,
				target: { kind: "worker-record" },
				writes: worker,
			});
		}
	}

	// The order the wire runs them in.
	const scopes = caseOperationMultiplicityScopes(doc, formUuid);
	const known = new Set(scopes);
	const stored = operations.filter(
		(operation) => operation.action !== "own" && !created.has(operation.uuid),
	);
	const target: Uuid[] = operations
		.filter((operation) => operation.action === "own")
		.map((operation) => operation.uuid);
	for (const scope of scopes) {
		for (const operation of stored)
			if (operation.forEach?.repeat === scope) target.push(operation.uuid);
		target.push(...(newCreatesByScope.get(scope) ?? []));
		if (scope === undefined && newWorker !== undefined) target.push(newWorker);
	}
	for (const operation of stored)
		if (!known.has(operation.forEach?.repeat)) target.push(operation.uuid);
	mutations.push(...movesInto(formUuid, operations, target));
	return mutations;
}

/** The moves that put `current` into the order `target` names, each one
 *  placing an operation after its predecessor in `target`. */
function movesInto(
	formUuid: Uuid,
	current: readonly CaseOperation[],
	target: readonly Uuid[],
): Mutation[] {
	const sequence = current.map((operation) => operation.uuid);
	const moves: Mutation[] = [];
	target.forEach((uuid, index) => {
		const after = index === 0 ? null : target[index - 1];
		const at = sequence.indexOf(uuid);
		const before = at === 0 ? null : sequence[at - 1];
		if (before === after) return;
		sequence.splice(at, 1);
		sequence.splice(after === null ? 0 : sequence.indexOf(after) + 1, 0, uuid);
		moves.push(
			formEdit(formUuid, {
				caseOperationPatch: { operation: "move", uuid, after },
			}),
		);
	});
	return moves;
}
