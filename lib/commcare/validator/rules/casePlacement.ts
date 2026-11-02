/**
 * The rules over held placements: where a published app already keeps a
 * form's case changes in CommCare HQ (`CaseOperation.placement`,
 * `Form.ownClosePlacement`). A hold is an identity no author chooses, so each
 * rule refuses a document that would move or duplicate one without saying
 * so. All three are soundness, located at the form.
 *
 * - `HELD_PLACEMENT_INEXPRESSIBLE`: a hold the document no longer lets its
 *   subject keep (`placement.ts::planPlacements(...).inexpressible`). The
 *   plan still places the subject, so every emitter stays total; the batch
 *   that strands a hold commits only with the hold's move beside it.
 * - `CASE_PLACEMENT_SHARED`: two subjects of one form holding one place,
 *   except a close holding the basic place of the create it closes, which
 *   is HQ's own `close_condition` on that subcase.
 * - `HELD_BLOCK_PATH_TAKEN`: an authored name equal to a segment of a held
 *   Save to Case path in the namespace that segment stands in. The
 *   allocator (`xform/generatedNodes.ts::planGeneratedNodes`) steps every
 *   generated name around a taken one but never moves a held segment, and
 *   an authored name is written as it is, so the two would be one element
 *   name twice under one parent. HQ's form builder names each question by
 *   its element name (Vellum `src/parser.js::parseDataElement`, `mug.p.nodeID
 *   = el.nodeName`) and renames a question whose name a sibling holds
 *   (`src/form.js::moveMug`, `generate_question_id`), so a save would rename
 *   one of them and move the published block or the answer.
 */

import {
	type InexpressibleHold,
	type PlacementSubject,
	planPlacements,
} from "@/lib/commcare/placement";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CasePlacement,
	formConnectIds,
	orderedCaseOperations,
	placementIneligibilitySentence,
	type Uuid,
} from "@/lib/domain";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import {
	editorSafeQuestionId,
	RESERVED_CONNECT_BLOCK_IDS,
} from "@/lib/domain/questionId";
import { type ValidationError, validationError } from "../errors";
import { caseOperationError } from "./caseOperations";

// ── Words ───────────────────────────────────────────────────────────────

/**
 * How a finding names a held subject: the own arm and the own close by what
 * they do, every other case change by its id, as every case-operation
 * finding names one.
 */
export function heldSubjectWords(
	subject: PlacementSubject,
	operation: CaseOperation | undefined,
): string {
	if (subject.kind === "own-close") return "“closing this form's case”";
	if (operation?.action === "own") return "“this form's case”";
	return `the case change “${operation?.id ?? subject.operationUuid}”`;
}

export function heldPlacementInexpressibleMessage(
	subjectWords: string,
	reasonSentence: string,
): string {
	return `CommCare HQ keeps ${subjectWords} where your last publish put it, and this change can't keep it there. ${reasonSentence} Make the change again to see where it moves and confirm it.`;
}

export function casePlacementSharedMessage(
	formName: string,
	first: string,
	second: string,
): string {
	return `Two case changes in “${formName}” are kept in the same place in CommCare HQ: ${first} and ${second}. Removing one of them and adding it again gives it a place of its own.`;
}

export function heldBlockPathTakenMessage(
	name: string,
	subjectWords: string,
	suggestion: string,
): string {
	return `The name “${name}” is where your published app keeps ${subjectWords} in CommCare HQ. You can name it “${suggestion}”.`;
}

// ── The rules ───────────────────────────────────────────────────────────

interface PlacementRuleContext {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly formName: string;
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly operations: readonly CaseOperation[];
}

interface Hold {
	readonly subject: PlacementSubject;
	readonly operation: CaseOperation | undefined;
	readonly placement: CasePlacement;
}

function holdsOf(
	ctx: PlacementRuleContext,
	ownClose: BlueprintDoc["forms"][Uuid]["ownClosePlacement"],
): Hold[] {
	const holds: Hold[] = [];
	for (const operation of ctx.operations)
		if (operation.placement !== undefined)
			holds.push({
				subject: { kind: "operation", operationUuid: operation.uuid },
				operation,
				placement: operation.placement,
			});
	if (ownClose !== undefined)
		holds.push({
			subject: { kind: "own-close" },
			operation: undefined,
			placement: { kind: "save-to-case", path: ownClose.path },
		});
	return holds;
}

function placementError(
	ctx: PlacementRuleContext,
	code: Parameters<typeof validationError>[0],
	message: string,
	operation: CaseOperation | undefined,
	details: Record<string, string>,
): ValidationError {
	return caseOperationError(
		code,
		message,
		{
			moduleUuid: ctx.moduleUuid,
			moduleName: ctx.moduleName,
			formUuid: ctx.formUuid,
			formName: ctx.formName,
		},
		operation,
		details,
	);
}

function inexpressibleFindings(
	ctx: PlacementRuleContext,
	inexpressible: readonly InexpressibleHold[],
): ValidationError[] {
	return inexpressible.map((hold) => {
		const { subject } = hold;
		const operation =
			subject.kind === "operation"
				? ctx.operations.find((op) => op.uuid === subject.operationUuid)
				: undefined;
		const subjectWords = heldSubjectWords(hold.subject, operation);
		const sentence = placementIneligibilitySentence(hold.reasons[0].reason);
		return placementError(
			ctx,
			"HELD_PLACEMENT_INEXPRESSIBLE",
			heldPlacementInexpressibleMessage(subjectWords, sentence),
			operation,
			{
				subject: JSON.stringify(hold.subject),
				held: JSON.stringify(hold.held),
				reasons: JSON.stringify(hold.reasons),
				reason: hold.reasons[0].reason,
				subjectWords,
				sentence,
			},
		);
	});
}

/** A close holding the basic place of the create it closes shares that
 *  place as the create's `close_condition`; whether it still may is the
 *  inexpressibility rule's to say. */
function closeSharesCreate(close: Hold, create: Hold): boolean {
	return (
		close.operation?.action === "close" &&
		close.operation.target.kind === "op" &&
		close.operation.target.opUuid === create.operation?.uuid &&
		create.operation?.action === "create" &&
		close.placement.kind === "basic"
	);
}

function samePlace(a: CasePlacement, b: CasePlacement): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "basic" && b.kind === "basic")
		return (
			a.slot === b.slot &&
			(a.slot !== "subcase" || (b.slot === "subcase" && a.index === b.index))
		);
	if (a.kind === "save-to-case" && b.kind === "save-to-case")
		return (
			a.repeat === b.repeat &&
			a.path.length === b.path.length &&
			a.path.every((segment, i) => b.path[i] === segment)
		);
	return false;
}

function sharedFindings(
	ctx: PlacementRuleContext,
	holds: readonly Hold[],
): ValidationError[] {
	const errors: ValidationError[] = [];
	const reported = new Set<number>();
	holds.forEach((first, i) => {
		if (reported.has(i)) return;
		holds.forEach((second, j) => {
			if (j <= i || reported.has(j)) return;
			if (!samePlace(first.placement, second.placement)) return;
			if (closeSharesCreate(first, second) || closeSharesCreate(second, first))
				return;
			reported.add(j);
			const a = heldSubjectWords(first.subject, first.operation);
			const b = heldSubjectWords(second.subject, second.operation);
			errors.push(
				placementError(
					ctx,
					"CASE_PLACEMENT_SHARED",
					casePlacementSharedMessage(ctx.formName, a, b),
					second.operation,
					{
						subjects: JSON.stringify([first.subject, second.subject]),
						first: a,
						second: b,
					},
				),
			);
		});
	});
	return errors;
}

function blockPathFindings(
	ctx: PlacementRuleContext,
	holds: readonly Hold[],
): ValidationError[] {
	const { doc, formUuid } = ctx;
	const errors: ValidationError[] = [];
	const saveToCase = holds.flatMap((hold) =>
		hold.placement.kind === "save-to-case"
			? [{ hold, repeat: hold.placement.repeat, path: hold.placement.path }]
			: [],
	);
	const scopes = new Set(saveToCase.map((held) => held.repeat));
	for (const repeat of scopes) {
		const here = saveToCase.filter((held) => held.repeat === repeat);
		// The scope's own namespace: its authored questions and, at the root,
		// the form's Connect blocks, beside each held path's first segment.
		const questionUuids = doc.fieldOrder[repeat ?? formUuid] ?? [];
		const questions = questionUuids.flatMap((uuid) => {
			const field = doc.fields[uuid];
			return field === undefined ? [] : [field];
		});
		const connectIds =
			repeat === undefined ? [...formConnectIds(doc, formUuid)] : [];
		const firstSegments = new Map<string, Hold>();
		for (const held of here)
			if (!firstSegments.has(held.path[0]))
				firstSegments.set(held.path[0], held.hold);
		const scopeTaken = new Set<string>([
			...questions.map((field) => field.id),
			...connectIds,
			...firstSegments.keys(),
		]);
		for (const field of questions) {
			const hold = firstSegments.get(field.id);
			if (hold === undefined) continue;
			const subjectWords = heldSubjectWords(hold.subject, hold.operation);
			const suggestion = suffixUntilFree(
				editorSafeQuestionId(field.id),
				scopeTaken,
			);
			errors.push(
				validationError(
					"HELD_BLOCK_PATH_TAKEN",
					"form",
					heldBlockPathTakenMessage(field.id, subjectWords, suggestion),
					{
						moduleUuid: ctx.moduleUuid,
						moduleName: ctx.moduleName,
						formUuid,
						formName: ctx.formName,
						fieldUuid: field.uuid,
						fieldId: field.id,
					},
					{
						held: JSON.stringify(hold.subject),
						name: field.id,
						suggestion,
						takenBy: "question",
						subjectWords,
					},
				),
			);
		}
		for (const id of connectIds) {
			const hold = firstSegments.get(id);
			if (hold === undefined) continue;
			const subjectWords = heldSubjectWords(hold.subject, hold.operation);
			const suggestion = suffixUntilFree(
				editorSafeQuestionId(id, RESERVED_CONNECT_BLOCK_IDS),
				scopeTaken,
			);
			errors.push(
				validationError(
					"HELD_BLOCK_PATH_TAKEN",
					"form",
					heldBlockPathTakenMessage(id, subjectWords, suggestion),
					{
						moduleUuid: ctx.moduleUuid,
						moduleName: ctx.moduleName,
						formUuid,
						formName: ctx.formName,
					},
					{
						held: JSON.stringify(hold.subject),
						name: id,
						suggestion,
						takenBy: "connect",
						subjectWords,
					},
				),
			);
		}

		// The scope's operations namespace: the ids of its operations, beside
		// every later segment of each held path. A segment of an operation's
		// own held path is its own.
		const restSegments = new Map<string, Hold[]>();
		for (const held of here)
			for (const segment of held.path.slice(1)) {
				const owners = restSegments.get(segment) ?? [];
				owners.push(held.hold);
				restSegments.set(segment, owners);
			}
		const scopeOperations = ctx.operations.filter(
			(operation) => operation.forEach?.repeat === repeat,
		);
		const operationsTaken = new Set<string>([
			...scopeOperations.map((operation) => operation.id),
			...restSegments.keys(),
		]);
		for (const operation of scopeOperations) {
			const owners = restSegments.get(operation.id) ?? [];
			const hold = owners.find(
				(owner) =>
					owner.subject.kind === "own-close" ||
					owner.subject.operationUuid !== operation.uuid,
			);
			if (
				hold === undefined ||
				owners.some(
					(owner) =>
						owner.subject.kind === "operation" &&
						owner.subject.operationUuid === operation.uuid,
				)
			)
				continue;
			const subjectWords = heldSubjectWords(hold.subject, hold.operation);
			const suggestion = suffixUntilFree(
				editorSafeQuestionId(operation.id),
				operationsTaken,
			);
			errors.push(
				placementError(
					ctx,
					"HELD_BLOCK_PATH_TAKEN",
					heldBlockPathTakenMessage(operation.id, subjectWords, suggestion),
					operation,
					{
						held: JSON.stringify(hold.subject),
						name: operation.id,
						suggestion,
						takenBy: "operation",
						subjectWords,
					},
				),
			);
		}
	}
	return errors;
}

/** Every held-placement finding of `formUuid`. A form that holds no
 *  placement has none. */
export function validateCasePlacements(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
): ValidationError[] {
	const form = doc.forms[formUuid];
	const module = doc.modules[moduleUuid];
	if (form === undefined || module === undefined) return [];
	const ctx: PlacementRuleContext = {
		doc,
		formUuid,
		formName: form.name,
		moduleUuid,
		moduleName: module.name,
		operations: orderedCaseOperations(form),
	};
	const holds = holdsOf(ctx, form.ownClosePlacement);
	if (holds.length === 0) return [];
	return [
		...inexpressibleFindings(ctx, planPlacements(doc, formUuid).inexpressible),
		...sharedFindings(ctx, holds),
		...blockPathFindings(ctx, holds),
	];
}
