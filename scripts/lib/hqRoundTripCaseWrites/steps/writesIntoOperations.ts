/**
 * Step `writes-into-operations` (part 09 §7.4; part 01 §22's C9, C1 to C3
 * and C10, with part 02's extension creates), per form in menu order:
 *
 * 0. Stored capture reads. A case operation's write whose whole value is a
 *    capture question's bare answer saved the file's name at `main`; the
 *    head saves a capture only as the link to its file (`capture-link`), so
 *    the write's value becomes that link and the question gets
 *    `capture-saves-link-not-name`. Where the link can't be saved there (a
 *    case's name, its external id, or a property whose type holds no text)
 *    it is the blocker `capture-write-unlinkable`, the author's to move.
 * 1. C9. A follow-up or close form's `close` operations of the case it
 *    loads become the form's own close. One under `forEach` is the blocker
 *    `own-close-in-repeat`: its close would run once per row, which no close
 *    condition states. Otherwise the form becomes a close form whose
 *    `closeCondition` is the `or` of the close it already had (a close
 *    form's, absent meaning every submission) and each operation's
 *    condition, any absent term making the whole absent; an operation
 *    without writes is removed, and one with writes becomes an `update` of
 *    the same case with the same uuid, id, condition and writes, so its
 *    Save to Case block keeps its path. A follow-up made a close form gets
 *    `form-became-close-form`.
 * 2. C1 to C3. `operationsFromFieldWrites` gives the form the own arm, a
 *    create per child or extension bucket and the worker-record update its
 *    lifted field writes made, with the identities part 09 §10.1 derives.
 * 3. C10. A write of the own case by another operation whose key the own arm
 *    also writes is removed: the ordinary action ran last on every platform,
 *    so the field's value already replaced it. An `update` left doing
 *    nothing is removed.
 *
 * Any other `update` of the own case stays an operation (part 01's class
 * (e)): its writes are not folded into the own arm.
 *
 * Clause 0 applies `update-write` patches, the edit every editor makes to
 * a write's value. C9 rewrites the document directly rather than through a
 * mutation batch: turning a `close` into an `update` with the same uuid is
 * a removal and a new claim of that uuid, which mutation admission refuses
 * (`lib/doc/mutationIdentityAdmission.ts`: no claim reintroduces a removed
 * identity), and no operation patch changes an operation's action. The
 * result is a document the head schema reads, and `judge-target`'s gate
 * holds it like every other step's.
 */

import { deepEqual } from "@/lib/doc/deepEqual";
import { ownCaseLinkTarget } from "@/lib/doc/fieldCaseWriteMutations";
import { operationsFromFieldWrites } from "@/lib/doc/fieldWriteOperations";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseWriteKeyOf,
	type Expression,
	type Form,
	isCaptureFieldKind,
	type OwnCaseOperation,
	sameCaseWriteKey,
	type TargetedCaseOperation,
	type Uuid,
} from "@/lib/domain";
import { inferExpressionTypes } from "@/lib/domain/expression/inference";
import { reduceOr } from "@/lib/domain/expression/reduction";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { isWriteAssignable } from "@/lib/domain/expression/ruleSets";
import { valueKindPhrase } from "@/lib/domain/valueKindPhrases";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { captureSavesLinkNotName, formBecameCloseForm } from "../notice";
import type { BlockerPlace, LiftedFacts, PlannedChange } from "../types";
import {
	applyStepMutations,
	formsInMenuOrder,
	type StepResult,
	stepBlocker,
	stoppedStep,
} from "./apply";

/** The change kinds this step plans, as the report's `steps` line counts
 *  them. */
export const WRITES_INTO_OPERATIONS_CHANGES = [
	"capture-write-linked",
	"own-close-folded",
	"operations-from-field-writes",
	"duplicate-own-write-removed",
] as const;
export type WritesIntoOperationsChange =
	(typeof WRITES_INTO_OPERATIONS_CHANGES)[number];

/**
 * What C9 did to one form, for the placement step (part 09 §8.3 and §8.5):
 * where a published deployment holds the own close, and whether the own
 * close moved.
 */
export interface OwnCloseFold {
	readonly formUuid: Uuid;
	/** A follow-up form C9 made a close form. */
	readonly becameClose: boolean;
	/** The first removed operation (one without writes), whose path today the
	 *  own close takes; undefined where every folded operation held writes. */
	readonly takesPathOf: Uuid | undefined;
	/** Every folded operation held writes, so each one's path stays with the
	 *  `update` it became and the own close takes its simplest placement
	 *  unheld (the cause `own-close-moved`). */
	readonly allHeldWrites: boolean;
}

export interface WritesIntoOperationsResult extends StepResult {
	readonly ownCloses: readonly OwnCloseFold[];
}

const STEP = "writes-into-operations";

function change(
	kind: WritesIntoOperationsChange,
	entityUuid: Uuid,
	detail: Record<string, number>,
): PlannedChange {
	return { step: STEP, kind, entityUuid, detail };
}

/** Whether `operation` closes the case the form loaded. */
function closesLoadedCase(
	operation: CaseOperation,
): operation is TargetedCaseOperation & { action: "close" } {
	return operation.action === "close" && operation.target.kind === "session";
}

function hasWrites(operation: CaseOperation): boolean {
	return (operation.writes?.length ?? 0) > 0;
}

/** The document with one form replaced; never a stale reference index. */
function withForm(doc: BlueprintDoc, form: Form): BlueprintDoc {
	const { refIndex: _refIndex, ...rest } = doc;
	return {
		...rest,
		forms: { ...doc.forms, [form.uuid]: form },
	} as BlueprintDoc;
}

// ─── C9 ───────────────────────────────────────────────────────────────────

type FoldOutcome =
	| { readonly kind: "none" }
	/** An operation under `forEach`: one place per such operation. */
	| { readonly kind: "blocked"; readonly places: readonly BlockerPlace[] }
	| {
			readonly kind: "folded";
			readonly form: Form;
			readonly fold: OwnCloseFold;
			readonly removed: number;
			readonly updates: number;
	  };

function foldOwnCloses(form: Form): FoldOutcome {
	if (form.type !== "followup" && form.type !== "close")
		return { kind: "none" };
	const operations = form.caseOperations ?? [];
	const closes = operations.filter(closesLoadedCase);
	if (closes.length === 0) return { kind: "none" };

	const inRepeat = closes.filter(
		(operation) => operation.forEach !== undefined,
	);
	if (inRepeat.length > 0) {
		const place: BlockerPlace = {
			entity: { kind: "form", uuid: form.uuid, name: form.name },
		};
		return { kind: "blocked", places: inRepeat.map(() => place) };
	}

	/* A close form's own close is a term; an absent one, like an absent
	 * operation condition, means every submission, and makes the whole
	 * condition absent. */
	const terms: (Expression | undefined)[] = [
		...(form.type === "close" ? [form.closeCondition] : []),
		...closes.map((operation) => operation.condition),
	];
	const present = terms.filter(
		(term): term is Expression => term !== undefined,
	);
	const closeCondition =
		present.length === terms.length && present.length > 0
			? (reduceOr(present) ?? {
					kind: "or",
					clauses: present as [Expression, ...Expression[]],
				})
			: undefined;

	const kept: CaseOperation[] = [];
	let removed = 0;
	let updates = 0;
	let takesPathOf: Uuid | undefined;
	for (const operation of operations) {
		if (!closesLoadedCase(operation)) {
			kept.push(operation);
			continue;
		}
		if (!hasWrites(operation)) {
			removed++;
			takesPathOf ??= operation.uuid;
			continue;
		}
		const { action: _action, ...rest } = operation;
		kept.push({ ...rest, action: "update" } as CaseOperation);
		updates++;
	}

	const {
		closeCondition: _closeCondition,
		caseOperations: _caseOperations,
		...base
	} = form;
	const next = {
		...base,
		type: "close",
		...(closeCondition !== undefined && { closeCondition }),
		...(kept.length > 0 && { caseOperations: kept }),
	} as Form;
	return {
		kind: "folded",
		form: next,
		fold: {
			formUuid: form.uuid,
			becameClose: form.type === "followup",
			takesPathOf,
			allHeldWrites: removed === 0,
		},
		removed,
		updates,
	};
}

// ─── Stored capture reads ─────────────────────────────────────────────────

/** The capture question whose bare answer `value` is, if it is one. */
function bareCaptureAnswer(
	doc: BlueprintDoc,
	value: Expression | undefined,
): Uuid | undefined {
	if (value?.kind !== "term" || value.term.kind !== "field") return undefined;
	const term = value.term;
	if (term.role !== undefined || term.filters !== undefined) return undefined;
	const field = doc.fields[term.uuid];
	return field !== undefined && isCaptureFieldKind(field.kind)
		? term.uuid
		: undefined;
}

/**
 * What clause 0 found: the `update-write` patches that save each capture's
 * link where an operation saved its answer, with their changes and lines,
 * or the places the link can't be saved.
 */
interface CaptureLinking {
	readonly mutations: readonly Mutation[];
	readonly changes: readonly PlannedChange[];
	readonly notice: readonly MigrationNoticeEntry[];
	readonly places: readonly BlockerPlace[];
}

/**
 * Clause 0: every stored operation write whose whole value is a capture's
 * bare answer saves the capture's link instead. A capture named as a case's
 * name, saved as its external id, or saved to a property whose type holds
 * no text is the blocker `capture-write-unlinkable`: the link can't be saved
 * there, and the file's name is no value the head saves.
 */
function linkCaptureWrites(
	doc: BlueprintDoc,
	order: readonly Uuid[],
): CaptureLinking {
	const places: BlockerPlace[] = [];
	const changes: PlannedChange[] = [];
	const notice: MigrationNoticeEntry[] = [];
	const mutations: Mutation[] = [];
	const catalog = doc.caseTypes ?? [];
	let propertyTypes:
		| ReturnType<typeof inferExpressionTypes>["propertyTypes"]
		| undefined;
	const question = (uuid: Uuid) => doc.fields[uuid]?.id ?? "a capture";
	for (const formUuid of order) {
		const form = doc.forms[formUuid];
		const place = (fieldUuid: Uuid, findingCode: string, message: string) =>
			places.push({
				entity: { kind: "field", uuid: fieldUuid, name: question(fieldUuid) },
				findingCode,
				message,
			});
		let linked = 0;
		for (const operation of form.caseOperations ?? []) {
			// Stored operations at `main` hold no own arm: C1 to C3 make it.
			if (operation.action === "own") continue;
			const named = bareCaptureAnswer(doc, operation.name);
			if (named !== undefined)
				place(
					named,
					"case-name",
					`“${operation.id}” in “${form.name}” names its case with the file “${question(named)}” captures. Nova now saves a capture as a link to its file, and CommCare keeps a case's name as its own text. You can name the case from another question, and save the file to a property of its own.`,
				);
			const caseType = operation.retype ?? operation.caseType;
			for (const write of operation.writes ?? []) {
				const capture = bareCaptureAnswer(doc, write.value);
				if (capture === undefined) continue;
				if (write.property === "external_id") {
					place(
						capture,
						"external-id",
						`“${operation.id}” in “${form.name}” saves the file “${question(capture)}” captures as the case's external id. Nova now saves a capture as a link to its file, and CommCare keeps a case's external id as its own text. You can save the file to a property of its own.`,
					);
					continue;
				}
				const destination = resolveRelationDestination(
					write.via === undefined
						? undefined
						: { kind: "ancestor", via: write.via },
					caseType,
					catalog,
				);
				propertyTypes ??= inferExpressionTypes(doc).propertyTypes;
				const type = destination.ok
					? propertyTypes.get(destination.caseType)?.get(write.property)?.type
					: undefined;
				if (type !== undefined && !isWriteAssignable("text", type, false)) {
					place(
						capture,
						"property-type",
						`“${operation.id}” in “${form.name}” saves the file “${question(capture)}” captures to “${write.property}”, which holds ${valueKindPhrase(type)}. Nova now saves a capture as a link to its file, which is text. You can save the file to a property of its own.`,
					);
					continue;
				}
				linked++;
				mutations.push(
					caseOperationEdit(formUuid, {
						caseOperationPatch: {
							operation: "update-write",
							uuid: operation.uuid,
							key: caseWriteKeyOf(write),
							patch: {
								value: {
									kind: "term",
									term: { kind: "capture-link", field: capture },
								},
							},
						},
					}),
				);
				notice.push(
					captureSavesLinkNotName(
						{ uuid: capture, name: question(capture) },
						{ form: form.name, property: write.property },
					),
				);
			}
		}
		if (linked > 0)
			changes.push(
				change("capture-write-linked", formUuid, { writes: linked }),
			);
	}
	return { mutations, changes, notice, places };
}

// ─── C10 ──────────────────────────────────────────────────────────────────

function caseOperationEdit(
	formUuid: Uuid,
	edit: Pick<
		Extract<Mutation, { kind: "updateForm" }>,
		"caseOperationChange" | "caseOperationPatch"
	>,
): Mutation {
	return { kind: "updateForm", uuid: formUuid, patch: {}, ...edit };
}

/** Whether an `update` holds nothing it does besides its writes. */
function updateDoesNothingElse(operation: TargetedCaseOperation): boolean {
	return (
		operation.owner === undefined &&
		operation.rename === undefined &&
		operation.retype === undefined &&
		(operation.links?.length ?? 0) === 0
	);
}

/**
 * The mutations that remove, from every other operation of the own case,
 * the writes the own arm also makes, and each `update` that leaves doing
 * nothing; with the counts of each.
 */
function duplicateOwnWrites(form: Form): {
	mutations: Mutation[];
	writes: number;
	operations: number;
} {
	const operations = form.caseOperations ?? [];
	const own = operations.find(
		(operation): operation is OwnCaseOperation => operation.action === "own",
	);
	const ownKeys = (own?.writes ?? []).map(caseWriteKeyOf);
	const mutations: Mutation[] = [];
	let writes = 0;
	let removedOperations = 0;
	if (own === undefined || ownKeys.length === 0)
		return { mutations, writes, operations: removedOperations };
	const ownTarget = ownCaseLinkTarget({ form, own });
	for (const operation of operations) {
		if (operation.action !== "update" && operation.action !== "close") continue;
		if (!deepEqual(operation.target, ownTarget)) continue;
		const duplicate = (operation.writes ?? []).filter((write) =>
			ownKeys.some((key) => sameCaseWriteKey(key, caseWriteKeyOf(write))),
		);
		if (duplicate.length === 0) continue;
		writes += duplicate.length;
		const left = (operation.writes?.length ?? 0) - duplicate.length;
		/* A close still closes with no write; an update with nothing left
		 * does nothing, and goes. */
		if (
			left === 0 &&
			operation.action === "update" &&
			updateDoesNothingElse(operation)
		) {
			removedOperations++;
			mutations.push(
				caseOperationEdit(form.uuid, {
					caseOperationChange: { operation: "remove", uuid: operation.uuid },
				}),
			);
			continue;
		}
		for (const write of duplicate)
			mutations.push(
				caseOperationEdit(form.uuid, {
					caseOperationPatch: {
						operation: "remove-write",
						uuid: operation.uuid,
						key: caseWriteKeyOf(write),
					},
				}),
			);
	}
	return { mutations, writes, operations: removedOperations };
}

// ─── The step ─────────────────────────────────────────────────────────────

/** Step `writes-into-operations` over the parsed document and the field
 *  writes the structure phase lifted. */
export function writesIntoOperations(
	input: BlueprintDoc,
	facts: Pick<LiftedFacts, "fieldWrites">,
): WritesIntoOperationsResult {
	const order = formsInMenuOrder(input);

	/* Clause 0 and C9 first, over every form: a capture the head can't save
	 * as a link or a form whose close ran per row stops the app before any
	 * form is rewritten. */
	const captures = linkCaptureWrites(input, order);
	/* Clause 0's patches change only write values, which C9 never reads,
	 * so C9 folds the forms they leave. */
	const applied =
		captures.places.length === 0
			? applyStepMutations(input, captures.mutations)
			: ({ ok: true, doc: input } as const);
	if (!applied.ok)
		return { ...stoppedStep(input, [applied.blocker]), ownCloses: [] };
	const linked = applied.doc;
	const inRepeat: BlockerPlace[] = [];
	const folds = new Map<Uuid, Extract<FoldOutcome, { kind: "folded" }>>();
	for (const formUuid of order) {
		const outcome = foldOwnCloses(linked.forms[formUuid]);
		if (outcome.kind === "blocked") inRepeat.push(...outcome.places);
		if (outcome.kind === "folded") folds.set(formUuid, outcome);
	}
	const blockers = [
		...(captures.places.length > 0
			? [
					stepBlocker(
						"capture-write-unlinkable",
						captures.places.length,
						captures.places.flatMap((place) =>
							place.findingCode === undefined ? [] : [place.findingCode],
						),
						captures.places,
					),
				]
			: []),
		...(inRepeat.length > 0
			? [stepBlocker("own-close-in-repeat", inRepeat.length, [], inRepeat)]
			: []),
	];
	if (blockers.length > 0)
		return { ...stoppedStep(input, blockers), ownCloses: [] };

	let doc = linked;
	const changes: PlannedChange[] = [...captures.changes];
	const notice: MigrationNoticeEntry[] = [...captures.notice];
	const ownCloses: OwnCloseFold[] = [];
	for (const formUuid of order) {
		const folded = folds.get(formUuid);
		if (folded === undefined) continue;
		doc = withForm(doc, folded.form);
		ownCloses.push(folded.fold);
		changes.push(
			change("own-close-folded", formUuid, {
				removed: folded.removed,
				updates: folded.updates,
				becameClose: folded.fold.becameClose ? 1 : 0,
			}),
		);
		if (folded.fold.becameClose)
			notice.push(
				formBecameCloseForm({ uuid: formUuid, name: folded.form.name }),
			);
	}

	for (const formUuid of order) {
		const form = doc.forms[formUuid];
		const entity = {
			kind: "form" as const,
			uuid: formUuid,
			name: form.name,
		};

		const made = operationsFromFieldWrites(
			doc,
			formUuid,
			facts.fieldWrites.get(formUuid) ?? [],
		);
		const afterMade = applyStepMutations(doc, made, entity);
		if (!afterMade.ok)
			return { ...stoppedStep(input, [afterMade.blocker]), ownCloses: [] };
		doc = afterMade.doc;
		if (made.length > 0) {
			const added = made.filter(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationChange?.operation === "add",
			).length;
			changes.push(
				change("operations-from-field-writes", formUuid, {
					added,
					completed: made.length - added,
				}),
			);
		}

		const duplicates = duplicateOwnWrites(doc.forms[formUuid]);
		const afterDuplicates = applyStepMutations(
			doc,
			duplicates.mutations,
			entity,
		);
		if (!afterDuplicates.ok)
			return {
				...stoppedStep(input, [afterDuplicates.blocker]),
				ownCloses: [],
			};
		doc = afterDuplicates.doc;
		if (duplicates.writes > 0)
			changes.push(
				change("duplicate-own-write-removed", formUuid, {
					writes: duplicates.writes,
					operations: duplicates.operations,
				}),
			);
	}

	return { doc, changes, notice, blockers: [], ownCloses };
}
