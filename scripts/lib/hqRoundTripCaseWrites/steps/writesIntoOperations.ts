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
 *    condition, any absent term making the whole absent. An operation's term
 *    is its condition and-ed with each condition it inherited from a
 *    conditional retype of the case before it
 *    (`lib/doc/caseOperationOrder.ts::caseOperationConditionalGuardUuids`),
 *    so the close still runs only where the retype ran. Each term is written
 *    in the form's own vocabulary: a read of a property of the loaded case
 *    or of a case above it through its parent links becomes the form's read
 *    of that case (`form-case`), which prints the same `index/parent` walk.
 *    A term that reads any other case is the blocker
 *    `own-close-condition-reads-case`. An operation without writes is
 *    removed, and one with writes becomes an `update` of the same case with
 *    the same uuid, id, condition and writes, so its Save to Case block keeps
 *    its path. A follow-up made a close form gets `form-became-close-form`.
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

import { semanticCheckErrors } from "@/lib/commcare/validator/lookupTypeContext";
import { caseOperationConditionalGuardUuids } from "@/lib/doc/caseOperationOrder";
import { deepEqual } from "@/lib/doc/deepEqual";
import { ownCaseLinkTarget } from "@/lib/doc/fieldCaseWriteMutations";
import { operationsFromFieldWrites } from "@/lib/doc/fieldWriteOperations";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CaseType,
	caseWriteKeyOf,
	type Expression,
	FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES,
	type Form,
	isCaptureFieldKind,
	isWritableStandardCaseProperty,
	type OwnCaseOperation,
	reachableCaseTypes,
	sameCaseWriteKey,
	type TargetedCaseOperation,
	type Uuid,
} from "@/lib/domain";
import {
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { inferExpressionTypes } from "@/lib/domain/expression/inference";
import { reduceAnd, reduceOr } from "@/lib/domain/expression/reduction";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { isWriteAssignable } from "@/lib/domain/expression/ruleSets";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import {
	isRelationPath,
	isTerm,
	type PropertyRef,
	type Term,
} from "@/lib/domain/expression/types";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
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

/** Why a read of the operation's row can't become the form's read. */
type CloseReadRefusal = "other-case" | "linked-case" | "retyped-case";

type FormRead<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: CloseReadRefusal };

/** The loaded case a close operation's condition reads as its row. */
interface LoadedCase {
	/** The module's case type, which the form reads the case as. */
	readonly caseType: string;
	/** The type the operation reads its row as: the module's, or the type a
	 *  retype before it gave the same case. */
	readonly rowType: string;
	readonly catalog: readonly CaseType[];
	/** Each case type the form reads, by its `index/parent` hops from the
	 *  loaded case (`reachableCaseTypes`). */
	readonly depths: ReadonlyMap<string, number>;
}

/** Where a part of the condition stands: in the operation's row, or in the
 *  `where` of a table lookup made there, whose table row captures the
 *  operation's row, so its case reads are still the row's. */
type RowPlace = "row" | "captured";

/** Nodes whose children read rows of their own (a query's, the locations',
 *  the selected cases'): no read inside one is of the operation's row, so
 *  the rewrite leaves them as they are and the checker judges them in the
 *  form's slot. */
const OTHER_ROWS: ReadonlySet<string> = new Set([
	"cases",
	"table-rows",
	"locations",
	"selected-cases",
]);

/** Terms besides a property read that read the row itself: its type and
 *  its index links. */
const ROW_TERMS: ReadonlySet<string> = new Set(["case-row-type", "case-index"]);

/**
 * One read of a property of the operation's row as the form's read of the
 * same case: the loaded case itself, or a case above it whose every step is
 * a parent link and whose distance matches the form's `index/parent` walk.
 * A row a retype before the operation gave another type is read under that
 * type, whose properties and parents the form's read under the module's
 * type need not name, so any read of it is refused.
 */
function formCaseRead(ref: PropertyRef, loaded: LoadedCase): FormRead<Term> {
	const origin = ref.caseType ?? loaded.rowType;
	if (origin !== loaded.rowType) return { ok: false, reason: "other-case" };
	if (loaded.rowType !== loaded.caseType)
		return { ok: false, reason: "retyped-case" };
	const via = ref.via;
	if (via === undefined || via.kind === "self")
		return {
			ok: true,
			value: {
				kind: "form-case",
				caseType: loaded.caseType,
				property: ref.property,
			},
		};
	if (via.kind !== "ancestor") return { ok: false, reason: "linked-case" };
	if (via.via.some((step) => step.identifier !== "parent"))
		return { ok: false, reason: "linked-case" };
	const destination = resolveRelationDestination(
		via,
		loaded.caseType,
		loaded.catalog,
	);
	if (
		!destination.ok ||
		loaded.depths.get(destination.caseType) !== via.via.length
	)
		return { ok: false, reason: "linked-case" };
	return {
		ok: true,
		value: {
			kind: "form-case",
			caseType: destination.caseType,
			property: ref.property,
		},
	};
}

/**
 * `value`, a close operation's condition or a part of it, with every read
 * of its row written as the form's read (`formCaseRead`); a structural
 * copy. It follows the checker's row scopes (`expressionChildContext`): a
 * table lookup's `where` captures the row it is made in, a projection's
 * value and a relation walk's `where` read the rows they reach, and a form
 * node's filters keep the row. A row a retype gave another type is read
 * under that type, so any read of it, a walk to its related cases
 * included, is refused. Whether the form's close condition holds the
 * result is the checker's to say (`foldOwnCloses`).
 */
function asFormCondition(
	value: unknown,
	loaded: LoadedCase,
	place: RowPlace = "row",
): FormRead<unknown> {
	if (Array.isArray(value)) {
		const items: unknown[] = [];
		for (const item of value) {
			const read = asFormCondition(item, loaded, place);
			if (!read.ok) return read;
			items.push(read.value);
		}
		return { ok: true, value: items };
	}
	if (value === null || typeof value !== "object") return { ok: true, value };
	const node = value as { readonly kind?: unknown } & Record<string, unknown>;
	const retyped = loaded.rowType !== loaded.caseType;
	const kind = node.kind;
	if (kind === "prop") return formCaseRead(value as PropertyRef, loaded);
	if (typeof kind === "string" && ROW_TERMS.has(kind))
		return retyped
			? { ok: false, reason: "retyped-case" }
			: { ok: true, value };
	if (typeof kind === "string" && OTHER_ROWS.has(kind))
		return { ok: true, value };
	if (kind === "project") {
		const of = asFormCondition(node.of, loaded, place);
		return of.ok ? { ok: true, value: { ...node, of: of.value } } : of;
	}
	if (kind === "table-lookup") {
		// A lookup made inside another one's `where` captures no case.
		if (place === "captured") return { ok: true, value };
		const where = asFormCondition(node.where, loaded, "captured");
		return where.ok
			? { ok: true, value: { ...node, where: where.value } }
			: where;
	}
	if (
		(kind === "count" || kind === "exists" || kind === "missing") &&
		isRelationPath(node.via)
	)
		return retyped
			? { ok: false, reason: "retyped-case" }
			: { ok: true, value };
	const copy: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(node)) {
		const read = asFormCondition(item, loaded, place);
		if (!read.ok) return read;
		// A property a match names is a read itself, so it becomes a term.
		copy[key] =
			key === "property" && isTerm(item)
				? { kind: "term", term: read.value }
				: read.value;
	}
	return { ok: true, value: copy };
}

const CLOSE_READ_SENTENCES: Record<CloseReadRefusal, string> = {
	"other-case":
		"reads a property of a case of another type, which the form's close condition can't name",
	"linked-case":
		"reads a property of a case linked to it other than through its parent links, which the form's close condition can't follow",
	"retyped-case":
		"reads its case under the type a case change before it gives the case, which the form's close condition reads only as the menu's type",
};

const CLOSE_REMEDY =
	"You can rewrite the condition so it reads only this form's answers, its case or a case above it through its parent links, or remove that case change and close the case from the form instead.";

type FoldOutcome =
	| { readonly kind: "none" }
	/** An operation under `forEach`: one place per such operation. */
	| { readonly kind: "blocked"; readonly places: readonly BlockerPlace[] }
	/** A close condition the form can't read: one place per operation. */
	| { readonly kind: "unreadable"; readonly places: readonly BlockerPlace[] }
	| {
			readonly kind: "folded";
			readonly form: Form;
			readonly fold: OwnCloseFold;
			readonly removed: number;
			readonly updates: number;
	  };

function foldOwnCloses(
	doc: BlueprintDoc,
	form: Form,
	lookups: LookupTypeIndex,
): FoldOutcome {
	if (form.type !== "followup" && form.type !== "close")
		return { kind: "none" };
	const operations = form.caseOperations ?? [];
	const closes = operations.filter(closesLoadedCase);
	if (closes.length === 0) return { kind: "none" };

	const place: BlockerPlace = {
		entity: { kind: "form", uuid: form.uuid, name: form.name },
	};
	const inRepeat = closes.filter(
		(operation) => operation.forEach !== undefined,
	);
	if (inRepeat.length > 0)
		return { kind: "blocked", places: inRepeat.map(() => place) };

	const moduleUuid = moduleUuidOfForm(doc, form.uuid);
	const caseType =
		moduleUuid === undefined ? undefined : doc.modules[moduleUuid]?.caseType;
	const catalog = doc.caseTypes ?? [];
	const depths = new Map(
		reachableCaseTypes(caseType, catalog).map((entry) => [
			entry.name,
			entry.depth,
		]),
	);

	/* The slot each term lands in: the form's close condition, the form
	 * made a close form. */
	const closeSlot = slotContext(
		withForm(doc, { ...form, type: "close" } as Form),
		{ entity: "form", uuid: form.uuid, slot: "form_close_condition" },
		lookups,
	);

	/* Each operation's term: its condition and each condition it inherits
	 * from a conditional retype before it, absent meaning every submission,
	 * each read in its own operation's row and written in the form's
	 * vocabulary. */
	const guards = caseOperationConditionalGuardUuids(doc, form.uuid);
	const byUuid = new Map(
		operations.map((operation) => [operation.uuid, operation]),
	);
	const unreadable: BlockerPlace[] = [];
	const operationTerms: (Expression | undefined)[] = closes.map((operation) => {
		const sources = [
			operation,
			...[...(guards.get(operation.uuid) ?? [])].flatMap((uuid) => {
				const guard = byUuid.get(uuid);
				return guard === undefined ? [] : [guard];
			}),
		];
		const clauses: Expression[] = [];
		let refused: CloseReadRefusal | undefined;
		for (const source of sources) {
			if (source.condition === undefined) continue;
			const read =
				caseType === undefined
					? ({ ok: false, reason: "other-case" } as const)
					: asFormCondition(source.condition, {
							caseType,
							rowType: source.caseType,
							catalog,
							depths,
						});
			if (!read.ok) {
				refused ??= read.reason;
				continue;
			}
			clauses.push(read.value as Expression);
		}
		const subject = `“${operation.id}” in “${form.name}” closes the case the form opened when its condition holds, and that condition`;
		if (refused !== undefined) {
			unreadable.push({
				...place,
				findingCode: refused,
				message: `${subject} ${CLOSE_READ_SENTENCES[refused]}. ${CLOSE_REMEDY}`,
			});
			return undefined;
		}
		if (clauses.length === 0) return undefined;
		const term: Expression = reduceAnd(clauses) ?? {
			kind: "and",
			clauses: clauses as [Expression, ...Expression[]],
		};
		/* The checker is the oracle: the term moves only where the form's
		 * close condition admits it, as the gate checks that slot
		 * (`rules/form.ts`), and otherwise the blocker says the checker's own
		 * reason. */
		if (closeSlot === undefined)
			throw new Error(
				"The case-writes cutover was moving the closes of a form's own case into its close condition and found no close condition to check them in. Every form in a module has one once it is a close form, so look at what `slotContext` read of the form.",
			);
		const errors = semanticCheckErrors(checkExpression(term, closeSlot));
		const first = errors[0];
		if (first !== undefined) {
			// Each of the checker's messages is its own sentence.
			unreadable.push({
				...place,
				findingCode: `check:${first.code}`,
				message: `${subject} can't be the form's close condition. ${errors.map((error) => error.message).join(" ")} ${CLOSE_REMEDY}`,
			});
			return undefined;
		}
		return term;
	});
	if (unreadable.length > 0) return { kind: "unreadable", places: unreadable };

	/* A close form's own close is a term; an absent one, like an absent
	 * operation term, means every submission, and makes the whole
	 * condition absent. */
	const terms: (Expression | undefined)[] = [
		...(form.type === "close" ? [form.closeCondition] : []),
		...operationTerms,
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
	/** The (form, question, property) lines already planned. */
	const lines = new Set<string>();
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
				// A reserved property no write may name is the gate's own finding
				// (`CASE_OPERATION_RESERVED_PROPERTY`), whatever the value.
				if (FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES.has(write.property))
					continue;
				// A standard property CommCare keeps as the case's own value, in
				// which the validator's `CAPTURE_CASE_WRITE_STANDARD_PROPERTY`
				// refuses a link. A name is filed as `case-name` wherever it is
				// met, though a write of `case_name` is reserved and stops above,
				// and a case's name is the operation's `name`, judged first.
				if (isWritableStandardCaseProperty(write.property)) {
					const name = write.property === "case_name";
					const what = name ? "name" : "external id";
					place(
						capture,
						name ? "case-name" : "external-id",
						`“${operation.id}” in “${form.name}” saves the file “${question(capture)}” captures as the case's ${what}. Nova now saves a capture as a link to its file, and CommCare keeps a case's ${what} as its own text. You can save the file to a property of its own.`,
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
				const line = JSON.stringify([formUuid, capture, write.property]);
				const named = lines.has(line);
				lines.add(line);
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
				// One line per form, question and property, as C5's
				// `capture-saves-link` is one per question.
				if (!named)
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

/** Step `writes-into-operations` over the parsed document, the field
 *  writes the structure phase lifted and the Project's data tables. */
export function writesIntoOperations(
	input: BlueprintDoc,
	facts: Pick<LiftedFacts, "fieldWrites">,
	/** The Project's data tables, which a moved close condition may read. */
	lookups: LookupTypeIndex = new Map(),
): WritesIntoOperationsResult {
	const order = formsInMenuOrder(input);

	/* Clause 0 and C9 first, over every form: a capture the head can't save
	 * as a link, a form whose close ran per row, or a close condition the
	 * form can't read stops the app before any form is rewritten. */
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
	const unreadable: BlockerPlace[] = [];
	const folds = new Map<Uuid, Extract<FoldOutcome, { kind: "folded" }>>();
	for (const formUuid of order) {
		const outcome = foldOwnCloses(linked, linked.forms[formUuid], lookups);
		if (outcome.kind === "blocked") inRepeat.push(...outcome.places);
		if (outcome.kind === "unreadable") unreadable.push(...outcome.places);
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
		...(unreadable.length > 0
			? [
					stepBlocker(
						"own-close-condition-reads-case",
						unreadable.length,
						unreadable.flatMap((place) =>
							place.findingCode === undefined ? [] : [place.findingCode],
						),
						unreadable,
					),
				]
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
