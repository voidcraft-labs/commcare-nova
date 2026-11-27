import {
	CASE_TYPE_REGEX,
	MAX_CASE_INDEX_IDENTIFIER_LENGTH,
	MAX_CASE_PROPERTY_LENGTH,
	MAX_CASE_TYPE_LENGTH,
} from "@/lib/commcare/constants";
import { inertLookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	caseCreateNameMissingMessage,
	ownCaseOperationFindings,
} from "@/lib/commcare/ownCaseOperationFindings";
import {
	placementIneligibility,
	planPlacements,
} from "@/lib/commcare/placement";
import {
	findOnDeviceDateAddIssue,
	type OnDeviceDateAddIssue,
} from "@/lib/commcare/validator/onDeviceCompatibility";
import { saveToCaseActions } from "@/lib/commcare/xform/saveToCaseActions";
import { formNodeProjection } from "@/lib/commcare/xpath/formNodeProjection";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	caseOperationConditionalGuardUuids,
	caseOperationDependencyUuids,
	caseOperationsInSubmissionOrder,
	caseOperationTargetTypeOrderViolations,
	caseOperationWireOrderViolationDetails,
	sameCaseOperationTargetIdentity,
} from "@/lib/doc/caseOperationOrder";
import {
	type BlueprintDoc,
	CASE_FACET_OF_ONLY_IF_CHANGED,
	CASE_LOADING_FORM_TYPES,
	CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
	CASE_OPERATION_LINK_IDENTIFIER_FORMAT_MESSAGE,
	CASE_OPERATION_PROPERTY_FORMAT_MESSAGE,
	type CaseChangeField,
	type CaseFacetOnlyIfChanged,
	type CaseOperation,
	type CaseOperationWrite,
	type CaseTarget,
	type CaseWriteVia,
	canSetOwnerAfterCreate,
	caseDataTypeForFieldKind,
	caseOperationRunsPerSelectedCase,
	caseSelectionCardinality,
	caseWriteKeyOf,
	concreteCasePropertyWriterTypes,
	effectiveCaseTypes,
	type Form,
	fixedCaseTypeOf,
	formFieldCanKeyCreate,
	formFieldCorrelatesWithCreate,
	hasUpdateOnlyCaseFacets,
	isAdvancedCaseIndexIdentifier,
	isCaseOperationIdentifier,
	isCaseOperationLinkIdentifier,
	isCaseOperationProperty,
	isFacetWriteThroughIndex,
	isParentUserWritePath,
	isReservedCaseOperationWrite,
	isWritableStandardCaseProperty,
	MAX_CASE_SCALAR_TEXT_LENGTH,
	type Module,
	operationCanReadFormField,
	operationCaseType,
	operationSavesOnlyChanged,
	operationTarget,
	orderedCaseOperations,
	ownCaseOperationHasEffects,
	parentUserWriteCaseTypes,
	placementIneligibilitySentence,
	planCaseRetype,
	prepareCaseScalarTextValue,
	RESERVED_CASE_OPERATION_TYPES,
	requiredDateRetypeOverwrite,
	sameCaseWriteKey,
	type TargetedCaseOperation,
	USERCASE_BUILT_IN_KEYS,
	USERCASE_CASE_TYPE,
	type Uuid,
	userPropertiesOf,
} from "@/lib/domain";
import {
	chainLoadOfTarget,
	entryOperationCaseType,
	formCaseSelections,
	menuEmittedAdvanced,
} from "@/lib/domain/advancedEntryDatums";
import {
	basicOwnExternalIdDayValue,
	caseSlotFacts,
	externalIdCalendarDayField,
	isKeyedRootCreate,
	isWorkerRecordUpdate,
	retainedExternalIdDayRead,
} from "@/lib/domain/basicCaseSlots";
import { caseWriteValueField } from "@/lib/domain/caseWriteViews";
import {
	activeRowScope,
	type ExpressionContext,
	slotContext,
} from "@/lib/domain/expression/context";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import {
	checkExpression,
	expressionContextAtPath,
} from "@/lib/domain/expression/typeChecker";
import type {
	Expression,
	FormExpressionSlotRef,
	Term,
} from "@/lib/domain/expression/types";
import {
	walkExpression,
	walkExpressionNodes,
	walkExpressionTerms,
} from "@/lib/domain/expression/walk";
import { keepsHiddenClock } from "@/lib/domain/fieldValueType";
import {
	caseOperationIdNameProblem,
	caseOperationLinkNameProblem,
	caseOperationNameSentence,
	freeCaseOperationName,
} from "@/lib/domain/questionId";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import { WRITABLE_STANDARD_CASE_PROPERTY_WORDS } from "@/lib/domain/standardCaseProperties";
import { submissionLayout } from "@/lib/domain/submissionLayout";
import { addressesWorkerRecord } from "@/lib/domain/workerRecordRequirements";
import {
	entryDatumIdResolver,
	entryDatumIds,
	formLinkProjectionContext,
} from "../../formLinkProjection";
import { type ValidationError, validationError } from "../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";

interface OperationFieldContext {
	readonly dataType: ReturnType<typeof caseDataTypeForFieldKind>;
	readonly repeat: Uuid | undefined;
	/** Repeat ancestry, outermost first. Root fields carry `[]`. */
	readonly repeatPath: readonly Uuid[];
	readonly kind: string;
}

interface OperationRuleContext {
	readonly doc: BlueprintDoc;
	readonly form: Form;
	readonly module: Module;
	readonly formUuid: Uuid;
	readonly moduleUuid: Uuid;
	readonly fields: ReadonlyMap<Uuid, OperationFieldContext>;
	readonly caseTypes: ReturnType<typeof effectiveCaseTypes>;
	readonly caseTypesByName: ReadonlyMap<
		string,
		ReturnType<typeof effectiveCaseTypes>[number]
	>;
	/** A follow-up or close form always receives a selected case before the
	 * XForm opens. Whether CommCare hoists that selection ahead of the module's
	 * form menu is only a navigation-order concern. */
	readonly sessionCaseAvailable: boolean;
	readonly writerTypes: ReturnType<typeof concreteCasePropertyWriterTypes>;
	readonly lookupTables?: LookupTypeIndex;
}

/** The reasons the worker's record rule (`workerRecordFindings`) gives, in
 *  `CASE_OPERATION_TARGET_INVALID`'s `details.reason`. */
export type WorkerRecordReason =
	| "worker-record-type"
	| "worker-record-twice"
	| "worker-record-facet";

/** The reasons `CASE_OPERATION_TARGET_INVALID` gives in `details.reason`:
 *  the worker's record rule's, a create keyed by an answer that is no key
 *  (`create-key`), a case id that is a blank literal (`blank-target`), and a
 *  case id expression that reads a create's id (`id-of-target`). */
export type TargetInvalidReason =
	| WorkerRecordReason
	| "create-key"
	| "blank-target"
	| "id-of-target";

/** The reasons `CASE_WRITE_DUPLICATE_PROPERTY` gives in `details.reason`: a
 *  property one operation writes twice (`validateWrites`), or one the own
 *  arm writes that another operation writes on the own case too
 *  (`ownCaseIndependenceFindings`). */
export type CaseWriteDuplicateReason = "operation" | "own-case";

/** The reasons `CASE_OPERATION_TARGET_TYPE_MISMATCH` gives in `details.reason`:
 *  `type-change` where the type the case holds there is one a change of the
 *  form gave it, or may have (a retype, a create of a case that may exist);
 *  `declared-type` where an operation or a link names a case by a type other
 *  than the one it came into the form with (its menu's, its create's, or the
 *  type another change names it by), with no type change behind it
 *  (`CaseOperationTargetTypeOrderViolation.retyped`). */
export type TargetTypeMismatchReason = "type-change" | "declared-type";

/** The reasons `CASE_OPERATION_LINK_INVALID` gives in `details.reason`. */
export type LinkInvalidReason =
	| "format"
	| "too-long"
	| "duplicate"
	| "name"
	| "target-kind"
	| "self-link";

/** The reasons `CASE_OPERATION_SESSION_UNAVAILABLE` gives in
 *  `details.reason`: the operation's own target is the case a menu chooses,
 *  a link's target is, or an expression of the operation reads that case. */
export type SessionUnavailableReason = "target" | "link-target" | "case-read";

function operationRuleContext(
	doc: BlueprintDoc,
	form: Form,
	module: Module,
	formUuid: Uuid,
	moduleUuid: Uuid,
	lookupTables?: LookupTypeIndex,
): OperationRuleContext {
	const caseTypes = effectiveCaseTypes(doc);
	const fields = collectFormFields(doc, formUuid);
	return {
		doc,
		form,
		module,
		formUuid,
		moduleUuid,
		fields,
		caseTypes,
		caseTypesByName: new Map(
			caseTypes.map((caseType) => [caseType.name, caseType]),
		),
		sessionCaseAvailable:
			module.caseType !== undefined && CASE_LOADING_FORM_TYPES.has(form.type),
		writerTypes: concreteCasePropertyWriterTypes(doc),
		lookupTables,
	};
}

/** The one XForm keeps its expression slots. An entry that puts another case
 * type into a slot must also admit those writes on the record that receives them. */
export function sharedEntryWriteFindings(
	doc: BlueprintDoc,
	entry: Form,
	menuUuid: Uuid,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const shared = entry.shadowOf;
	const parent = shared && doc.forms[shared.form];
	if (!parent || parent.shadowOf) return [];
	const changed = orderedCaseOperations(parent).flatMap((op) => {
		const actual = entryOperationCaseType(doc, entry.uuid, op);
		return actual !== undefined &&
			actual !== operationCaseType(doc, parent.uuid, op)
			? [{ op, actual }]
			: [];
	});
	if (!changed.length) return [];
	const ctx = operationRuleContext(
		doc,
		entry,
		doc.modules[menuUuid],
		parent.uuid,
		menuUuid,
		lookupTables,
	);
	const errors: ValidationError[] = [];
	const repeatedWorker = orderedCaseOperations(parent).find(
		isRepeatedWorkerUpdate,
	);
	for (const { op, actual } of changed) {
		const worker = actual === USERCASE_CASE_TYPE;
		if (
			worker &&
			repeatedWorker !== undefined &&
			op !== repeatedWorker &&
			hasWorkerRecordEffect(ctx, op)
		)
			errors.push(workerRecordTwiceFinding(ctx, op, repeatedWorker));
		if (worker && op.action === "own") {
			validateOwnWorkerFacets(ctx, op, errors);
			if (entry.type === "close")
				errors.push(
					opError(
						ctx,
						op,
						"CASE_OPERATION_TARGET_INVALID",
						`“${entry.name}” opens the worker’s own record. You can save worker details or choose a record this form can close.`,
					),
				);
		} else if (worker && op.action !== "own") {
			errors.push(
				...workerRecordFindings(ctx, [
					{ ...op, caseType: actual, target: { kind: "worker-record" } },
				]),
			);
		}
		validateWrites(ctx, op, op.retype ?? actual, worker, errors);
	}
	return errors.map((finding) => ({
		...finding,
		location: {
			...finding.location,
			formUuid: entry.uuid,
			formName: entry.name,
		},
	}));
}

function positionedChangeHasConditionalContainer(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): boolean {
	for (let parent = doc.fieldParent[fieldUuid]; parent !== undefined; ) {
		const field = doc.fields[parent];
		if (field === undefined) return false;
		if ("relevant" in field && field.relevant !== undefined) return true;
		parent = doc.fieldParent[parent];
	}
	return false;
}

/** HQ's build adds its managed case blocks after authored root data, but
 * inserts some single repeat actions first. Until the two plans share the
 * physical order of those mixed blocks, only independent effects are safe. */
function mixedPositionOrderDependency(
	doc: BlueprintDoc,
	formUuid: Uuid,
	module: Module,
	operations: readonly CaseOperation[],
	positioned: ReadonlySet<Uuid>,
	operation: TargetedCaseOperation,
): CaseOperation | undefined {
	const { placements } = planPlacements(doc, formUuid);
	const formType = doc.forms[formUuid]?.type;
	const directTargetOf = (target: CaseTarget | null | undefined, uuid: Uuid) =>
		(target?.kind === "op" && target.opUuid === uuid) ||
		(target?.kind === "expression" &&
			target.expr.kind === "id-of" &&
			target.expr.opUuid === uuid);
	const writesOf = (op: CaseOperation): Set<string> =>
		new Set([
			...(op.writes ?? []).map((write) => write.property),
			...(op.rename !== undefined ||
			(op.action === "own" && op.name !== undefined)
				? ["case_name"]
				: []),
			...(op.owner === undefined ? [] : ["owner_id"]),
		]);
	const properties = writesOf(operation);
	return operations.find((other) => {
		if (positioned.has(other.uuid)) return false;
		const placement = placements.get(other.uuid)?.placement.kind;
		if (placement !== "basic" && placement !== "advanced") return false;
		if (
			other.action === "create" ||
			(other.action === "own" && formType === "registration")
		)
			return (
				directTargetOf(operation.target, other.uuid) ||
				(operation.links ?? []).some((link) =>
					directTargetOf(link.target, other.uuid),
				)
			);

		if (
			(other.writes ?? []).some(
				(write) => write.via && properties.has(write.property),
			)
		)
			return true;
		const type = other.action === "own" ? module.caseType : other.caseType;
		if (type !== operation.caseType) return false;
		const otherProperties = writesOf(other);
		const otherCloses =
			other.action === "close" ||
			other.closeAfter ||
			(other.action === "own" && formType === "close");
		const indices = new Set((other.links ?? []).map((link) => link.identifier));
		const otherChangesRow =
			otherProperties.size > 0 ||
			indices.size > 0 ||
			otherCloses ||
			other.retype !== undefined;
		if (!otherChangesRow) return false;
		return (
			operation.retype !== undefined ||
			other.retype !== undefined ||
			operation.action === "close" ||
			operation.closeAfter === true ||
			otherCloses === true ||
			[...properties].some((property) => otherProperties.has(property)) ||
			(operation.links ?? []).some((link) => indices.has(link.identifier))
		);
	});
}

export function validateCaseOperations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const form = doc.forms[formUuid];
	const module = doc.modules[moduleUuid];
	const operations = orderedCaseOperations(form);
	const ownFindings = ownCaseOperationFindings({
		form,
		formUuid,
		moduleUuid,
		moduleName: module.name,
		caseType: module.caseType,
	});
	const positions = new Set<Uuid>();
	// Position checks need submitted order and the enclosing repeat, even
	// when an ID in that tree cannot yet be used as an XForm element name.
	const { children } = submissionLayout(formUuid, doc.fields, doc.fieldOrder);
	const caseChangeLocations = new Map<
		Uuid,
		{ field: CaseChangeField; repeat: Uuid | undefined }
	>();
	const walkPositions = (parent: Uuid, repeat: Uuid | undefined) => {
		for (const uuid of children.get(parent) ?? []) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			if (field.kind === "case_change")
				caseChangeLocations.set(uuid, { field, repeat });
			walkPositions(uuid, field.kind === "repeat" ? uuid : repeat);
		}
	};
	walkPositions(formUuid, undefined);
	const positioned = new Set(
		[...caseChangeLocations.values()].map(({ field }) => field.operationUuid),
	);
	const byUuid = new Map(
		operations.map((operation) => [operation.uuid, operation]),
	);
	for (const [uuid, { field, repeat }] of caseChangeLocations) {
		const operation = byUuid.get(field.operationUuid);
		const invalid =
			operation === undefined
				? {
						reason: "missing-operation",
						message: "Choose a case change from this form.",
					}
				: positions.has(field.operationUuid)
					? {
							reason: "duplicate-position",
							message: "Keep just one position for this case change.",
						}
					: operation.forEach?.repeat !== repeat
						? {
								reason: "repeat-scope",
								message:
									"Place this case change in the section it repeats over.",
							}
						: operation.action === "own" ||
								isKeyedRootCreate(operation) ||
								operation.condition !== undefined ||
								isWorkerRecordUpdate(operation) ||
								operationSavesOnlyChanged(operation) ||
								operation.writes?.some((write) => write.via !== undefined)
							? {
									reason: "direct-change",
									message:
										"Choose a direct create, update or close for this position.",
								}
							: caseOperationRunsPerSelectedCase(operation) &&
									caseSelectionCardinality(module) === "multiple"
								? {
										reason: "selected-cases",
										message:
											"Keep the case change that runs for each selected case in the form's case settings.",
									}
								: operation.retype !== undefined &&
										positionedChangeHasConditionalContainer(doc, uuid)
									? {
											reason: "conditional-type-change",
											message:
												"Place a change of case type outside sections that can be skipped.",
										}
									: undefined;
		const orderDependency =
			invalid === undefined &&
			operation !== undefined &&
			operation.action !== "own"
				? mixedPositionOrderDependency(
						doc,
						formUuid,
						module,
						operations,
						positioned,
						operation,
					)
				: undefined;
		positions.add(field.operationUuid);
		if (invalid !== undefined || orderDependency !== undefined)
			ownFindings.push(
				validationError(
					"CASE_CHANGE_POSITION_INVALID",
					"field",
					invalid?.message ??
						"Keep these case changes together in the form's case settings so they run in order.",
					{
						moduleUuid,
						moduleName: module.name,
						formUuid,
						formName: form.name,
						fieldUuid: uuid,
						fieldId: field.id,
					},
					{
						operationUuid: field.operationUuid,
						reason: invalid?.reason ?? "managed-order",
						...(orderDependency && {
							otherOperationUuid: orderDependency.uuid,
						}),
					},
				),
			);
	}
	if (operations.length === 0) return ownFindings;

	const ctx = operationRuleContext(
		doc,
		form,
		module,
		formUuid,
		moduleUuid,
		lookupTables,
	);

	const errors: ValidationError[] = [...ownFindings];
	const seenUuids = new Set<Uuid>();
	const seenIds = new Set<string>();
	const priorCreates = new Map<Uuid, CaseOperation>();
	errors.push(...ownCaseIndependenceFindings(ctx, operations));
	errors.push(...workerRecordFindings(ctx, operations));
	for (const violation of caseOperationTargetTypeOrderViolations(
		doc,
		formUuid,
		operations,
	)) {
		const operation = operations.find(
			(candidate) => candidate.uuid === violation.operationUuid,
		);
		const subject =
			violation.slot === "target"
				? "The operation target"
				: violation.slot === "ordinary"
					? "This form's own case"
					: `The link "${violation.slot.slice(5)}" target`;
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_TARGET_TYPE_MISMATCH",
				violation.kind === "known-identity"
					? `${subject} is ${violation.actualType} at this point in the operation sequence, not ${violation.expectedType}.`
					: violation.kind === "repeat-alias"
						? `Repeated retype operation "${operation?.id ?? violation.operationUuid}" may address the same case in more than one iteration. After the first ${violation.actualType} transition, a later iteration could no longer consume it as ${violation.expectedType}; use a correlated generated create whose id is fresh per iteration.`
						: `${subject} may resolve to the same concrete case as an earlier transition that leaves it as ${violation.actualType}, not ${violation.expectedType}. Use the same typed target reference, or a target Nova can prove is distinct.`,
				{
					reason: (violation.retyped
						? "type-change"
						: "declared-type") satisfies TargetTypeMismatchReason,
					...(violation.slot === "ordinary" && { subject: "own-case" }),
				},
			),
		);
	}
	const wireOrderViolations = new Map(
		caseOperationWireOrderViolationDetails(doc, formUuid, operations).map(
			(violation) => [violation.operationUuid, violation],
		),
	);
	for (const operation of caseOperationsInSubmissionOrder(
		doc,
		formUuid,
		operations,
	)) {
		const wireOrderViolation = wireOrderViolations.get(operation.uuid);
		if (wireOrderViolation !== undefined) {
			let message: string;
			switch (wireOrderViolation.kind) {
				case "multiplicity-scope":
					message = `Case operation "${operation.id}" crosses back to an earlier multiplicity scope, so CommCare's document-order executor cannot preserve the declared operation order.`;
					break;
				case "authored-create-after-noncreate":
					message = `Authored-key create operation "${operation.id}" follows an effect that may change the same case. HQ applies the create first, while the device follows the submitted form order.`;
					break;
				case "repeated-authored-key-alias": {
					const producer = operations.find(
						(candidate) => candidate.uuid === wireOrderViolation.producerUuid,
					);
					message = `Case operation "${operation.id}" may target the same case as repeated authored-key create "${producer?.id ?? wireOrderViolation.producerUuid}" across iterations. Core executes repeat instances in iteration order, while HQ groups one case's blocks and create-sorts them; use a generated identity, a provably distinct target, or non-interleaving scopes.`;
					break;
				}
			}
			errors.push(
				opError(ctx, operation, "CASE_OPERATION_EXECUTION_ORDER", message),
			);
		}
		if (seenUuids.has(operation.uuid)) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_DUPLICATE_UUID",
					`Case operation UUID "${operation.uuid}" is used more than once.`,
				),
			);
		}
		seenUuids.add(operation.uuid);
		if (!isCaseOperationIdentifier(operation.id)) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_INVALID_ID",
					`Case operation id "${operation.id}" is invalid. ${CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE}`,
				),
			);
		}
		const idNameProblem = caseOperationIdNameProblem(operation.id);
		if (idNameProblem !== undefined) {
			// The free name avoids every operation id of the form.
			const suggestedId = freeCaseOperationName(
				operation.id,
				new Set(operations.map((other) => other.id)),
			);
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_INVALID_ID",
					`Case operation "${operation.id}" in "${ctx.form.name}": ${caseOperationNameSentence(operation.id, idNameProblem, suggestedId)}`,
					{ problem: idNameProblem, suggestedId },
				),
			);
		}
		if (seenIds.has(operation.id)) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_DUPLICATE_ID",
					`Case operation id "${operation.id}" is used more than once in this form.`,
				),
			);
		}
		seenIds.add(operation.id);
		validateOperation(ctx, operation, priorCreates, errors);
		if (
			operation.action === "create" ||
			(operation.action === "own" && form.type === "registration")
		) {
			priorCreates.set(operation.uuid, operation);
		}
	}
	return errors;
}

function validateOperation(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	priorCreates: ReadonlyMap<Uuid, CaseOperation>,
	errors: ValidationError[],
): void {
	const editorCaseType =
		operation.placement?.kind === "save-to-case"
			? operation.placement.editorCaseType
			: undefined;
	if (
		editorCaseType !== undefined &&
		(operation.action !== "update" ||
			ctx.form.type !== "followup" ||
			caseSelectionCardinality(ctx.module) !== "single" ||
			menuEmittedAdvanced(ctx.doc, ctx.moduleUuid) ||
			operation.target.kind !== "session" ||
			operation.caseType !== ctx.module.caseType ||
			operation.forEach !== undefined ||
			operation.condition !== undefined ||
			operation.retype !== undefined ||
			operation.owner !== undefined ||
			operation.rename !== undefined ||
			operation.closeAfter === true ||
			(operation.links?.length ?? 0) > 0 ||
			!operation.writes?.length ||
			operation.writes.some((write) => write.via !== undefined) ||
			RESERVED_CASE_OPERATION_TYPES.has(editorCaseType) ||
			RESERVED_CASE_OPERATION_TYPES.has(operation.caseType))
	)
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_TARGET_TYPE_MISMATCH",
				"This saved case type label belongs to a direct update of the case this form opens. Keep that target when editing the change.",
				{ reason: "declared-type" satisfies TargetTypeMismatchReason },
			),
		);
	if (operation.action === "own") {
		validateOwnOperation(ctx, operation, errors);
		return;
	}
	const workerRecord = addressesWorkerRecord(ctx.form, operation);
	if (!workerRecord || operation.caseType !== USERCASE_CASE_TYPE)
		validateCaseType(ctx, operation, operation.caseType, errors);
	if (
		operation.action === "create" &&
		operation.typeCalculation !== undefined &&
		fixedCaseTypeOf(operation.typeCalculation) !== operation.caseType
	)
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_TYPE_CALCULATION_MISMATCH",
				"The case type calculation must give the case type named by this create.",
			),
		);

	if (operation.action === "create" && operation.typeChoice !== undefined)
		validateCreateTypeChoice(ctx, operation, errors);
	if (operation.action === "create" && operation.keepNameText) {
		const calculation = operation.name;
		const suffix =
			calculation?.kind === "concat" ? calculation.parts[1] : undefined;
		const answer =
			calculation?.kind === "concat" &&
			calculation.parts.length === 2 &&
			suffix?.kind === "term" &&
			suffix.term.kind === "literal" &&
			typeof suffix.term.value === "string"
				? calculation.parts[0]
				: calculation;
		const name = answer?.kind === "term" ? answer.term : undefined;
		if (
			ctx.form.type !== "survey" ||
			ctx.module.caseType ||
			menuEmittedAdvanced(ctx.doc, ctx.moduleUuid) ||
			operation.target.kind !== "new" ||
			operation.target.idFrom !== undefined ||
			operation.target.expr !== undefined ||
			operation.forEach !== undefined ||
			operation.typeCalculation !== undefined ||
			operation.typeChoice !== undefined ||
			operation.links?.length ||
			name?.kind !== "field" ||
			name.filters !== undefined ||
			name.role !== undefined ||
			!ctx.doc.fieldOrder[ctx.formUuid]?.includes(name.uuid) ||
			ctx.fields.get(name.uuid)?.kind !== "text"
		)
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_TARGET_INVALID",
					"An unchanged case name needs a root Text question in a standalone Survey. It can append literal text.",
				),
			);
	}

	// A retype of the worker's record is refused as a facet it can't carry
	// (`workerRecordFindings`), so no retype plan is asked of it.
	if (operation.retype !== undefined && !workerRecord) {
		validateCaseType(ctx, operation, operation.retype, errors);
		const producer =
			operation.target.kind === "op"
				? priorCreates.get(operation.target.opUuid)
				: undefined;
		if (
			producer?.action === "create" &&
			producer.target.kind === "new" &&
			producer.target.idFrom !== undefined &&
			operation.retype !== operation.caseType
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_RETYPE_UNSAFE",
					`Case operation "${operation.id}" cannot retype the deterministic-key case created by "${producer.id}". Authored-key identities are type-stable so retrying their create can never become an implicit create-over-existing retype.`,
				),
			);
		}
		const plan = planCaseRetype(ctx.doc, operation.caseType, operation.retype);
		if (!plan.safe) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_RETYPE_UNSAFE",
					`Retyping ${operation.caseType} to ${operation.retype} cannot complete because its source or destination schema is missing.`,
				),
			);
		} else if (
			!plan.wirePortable &&
			requiredDateRetypeOverwrite(
				ctx.doc,
				ctx.formUuid,
				operation,
				producer,
				plan,
			) === undefined
		) {
			const consequences = [
				...(plan.parked.length > 0
					? [
							`source-only values (${plan.parked.join(", ")}) would need parking`,
						]
					: []),
				...(plan.conversions.length > 0
					? [
							`shared values (${plan.conversions.map((conversion) => `${conversion.property}: ${conversion.fromType} to ${conversion.toType}`).join(", ")}) would need conversion`,
						]
					: []),
			];
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_RETYPE_UNSAFE",
					`Retyping ${operation.caseType} to ${operation.retype} is not portable: ${consequences.join(" and ")}. CommCare's case wire changes only case_type, so Nova admits authored retypes only when each existing JSON value can be kept unchanged.`,
				),
			);
		}
	}

	const repeat = operation.forEach?.repeat;
	if (repeat !== undefined && ctx.fields.get(repeat)?.kind !== "repeat") {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_REPEAT_INVALID",
				`Case operation repeat "${repeat}" is not a repeat in this form.`,
			),
		);
	}

	validateTarget(
		ctx,
		operation,
		operation.target,
		priorCreates,
		operationSlot(ctx, operation, "case_operation_target_expression"),
		errors,
	);
	if (
		operation.target.kind === "new" &&
		operation.target.idFrom !== undefined
	) {
		const field = ctx.fields.get(operation.target.idFrom);
		if (field === undefined || !formFieldCanKeyCreate(field)) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_TARGET_INVALID",
					"An authored create id must come from a scalar string-valued field in this form; a multi-select answer is an array in Nova and cannot be an identity key.",
					{ reason: "create-key" satisfies TargetInvalidReason },
				),
			);
		} else if (
			operation.target.shareKeyAcrossRows
				? repeat === undefined ||
					field.repeat !== undefined ||
					field.kind !== "text"
				: !formFieldCorrelatesWithCreate(field.repeat, repeat)
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_REPEAT_CORRELATION",
					"Choose a key from this case change’s repeat, or explicitly share its case across rows using a Text answer outside the repeat.",
				),
			);
		}
	}

	validatePredicateSlot(
		ctx,
		operation,
		operation.condition,
		operationSlot(ctx, operation, "case_operation_condition"),
		errors,
	);
	if (
		operation.action === "update" &&
		operation.closeAfter === true &&
		!hasUpdateOnlyCaseFacets(operation)
	)
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_CLOSE_ACTION_REQUIRED",
				"Choose the close action for a case that closes after saving its properties.",
			),
		);
	if (operation.closeCondition !== undefined) {
		if (operation.action !== "close" && operation.closeAfter !== true)
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_CLOSE_CONDITION_INVALID",
					"Choose to close the case before setting when it closes.",
				),
			);
		validatePredicateSlot(
			ctx,
			operation,
			operation.closeCondition,
			operationSlot(ctx, operation, "case_operation_close_condition"),
			errors,
		);
	}
	if (operation.ownerCondition !== undefined) {
		const reason =
			operation.action === "create" &&
			operation.ownerCondition.kind !== "match-all" &&
			(operation.target.kind !== "new" ||
				operation.target.idFrom !== undefined ||
				operation.target.expr !== undefined)
				? "fresh-id"
				: operation.action === "update" && operation.owner === undefined
					? "missing-owner"
					: operation.action === "update" &&
							operation.target.kind === "worker-record"
						? "worker-record"
						: undefined;
		if (reason !== undefined)
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_OWNER_CONDITION_INVALID",
					"The owner condition requires an eligible owner write.",
					{ reason },
				),
			);
		validatePredicateSlot(
			ctx,
			operation,
			operation.ownerCondition,
			operationSlot(ctx, operation, "case_operation_owner_condition"),
			errors,
		);
	}
	if (operation.ownerAfterCreate !== undefined) {
		const laterOwner = operation.ownerAfterCreate;
		const name =
			operation.name?.kind === "term" ? operation.name.term : undefined;
		const answer =
			laterOwner.value.kind === "term" ? laterOwner.value.term : undefined;
		const sharedRootText =
			operation.action === "create" &&
			operation.keepNameText !== true &&
			(operation.writes?.length ?? 0) > 0 &&
			name?.kind === "field" &&
			name.filters === undefined &&
			name.role === undefined &&
			answer?.kind === "field" &&
			answer.filters === undefined &&
			answer.role === undefined &&
			name.uuid === answer.uuid &&
			ctx.doc.fieldOrder[ctx.formUuid]?.includes(name.uuid) === true &&
			ctx.fields.get(name.uuid)?.kind === "text";
		if (laterOwner.keepOwnerTextAfterWrites && !sharedRootText)
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_OWNER_CONDITION_INVALID",
					"An unchanged later owner needs the same root Text answer as the case name and a saved property before it.",
					{ reason: "standalone-fresh-create" },
				),
			);
		if (
			!canSetOwnerAfterCreate(
				operation,
				ctx.form.type,
				ctx.form.caseOperations?.length === 1,
			)
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_OWNER_CONDITION_INVALID",
					"Changing the owner after creation requires one fresh case created outside a repeat.",
					{ reason: "standalone-fresh-create" },
				),
			);
		}
		validateTextExpression(
			ctx,
			operation,
			operation.ownerAfterCreate.value,
			"owner",
			operationSlot(ctx, operation, "case_operation_later_owner"),
			errors,
		);
		validatePredicateSlot(
			ctx,
			operation,
			operation.ownerAfterCreate.condition,
			operationSlot(ctx, operation, "case_operation_later_owner_condition"),
			errors,
		);
	}
	validateNameExpression(ctx, operation, operation.name, "create name", errors);
	validateTextExpression(
		ctx,
		operation,
		operation.owner,
		"owner",
		operationSlot(ctx, operation, "case_operation_owner"),
		errors,
	);
	validateTextExpression(
		ctx,
		operation,
		operation.rename,
		"rename",
		operationSlot(ctx, operation, "case_operation_rename"),
		errors,
	);

	validateWrites(
		ctx,
		operation,
		operation.retype ?? operation.caseType,
		workerRecord,
		errors,
	);
	validateFacetOnlyIfChanged(ctx, operation, errors);
	validateLinks(ctx, operation, priorCreates, errors);
}

function validateLinks(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	priorCreates: ReadonlyMap<Uuid, CaseOperation>,
	errors: ValidationError[],
): void {
	const links = operation.links ?? [];
	if (links.length === 0) return;
	const linkIds = new Set<string>();
	const allLinkIds = new Set(links.map((link) => link.identifier));
	let plan: ReturnType<typeof planPlacements> | undefined;
	const placementsOfForm = () =>
		(plan ??= planPlacements(ctx.doc, ctx.formUuid));
	let advancedOpen: boolean | undefined;
	for (const link of links) {
		const standardName = isCaseOperationLinkIdentifier(link.identifier);
		const advancedName =
			!standardName && isAdvancedCaseIndexIdentifier(link.identifier);
		if (advancedName)
			advancedOpen ??=
				placementsOfForm().advanced?.opens.some(
					(open) => open.operationUuid === operation.uuid,
				) === true;
		const validFormat = standardName || (advancedName && advancedOpen === true);
		const formatMessage = advancedName
			? "This connection name requires an Advanced open action. Keep the change in that action or choose a name using unaccented letters, digits, underscores, and hyphens."
			: CASE_OPERATION_LINK_IDENTIFIER_FORMAT_MESSAGE;
		const invalidLinkFormat = !validFormat;
		const linkTooLong =
			link.identifier.length > MAX_CASE_INDEX_IDENTIFIER_LENGTH;
		const duplicateLink = linkIds.has(link.identifier);
		if (invalidLinkFormat || linkTooLong || duplicateLink) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_LINK_INVALID",
					invalidLinkFormat
						? `Link identifier "${link.identifier}" is invalid. ${formatMessage}`
						: linkTooLong
							? `Link identifier "${link.identifier}" is longer than ${MAX_CASE_INDEX_IDENTIFIER_LENGTH} characters.`
							: `Link identifier "${link.identifier}" is used more than once by this operation.`,
					{
						linkIdentifier: link.identifier,
						reason: (invalidLinkFormat
							? "format"
							: linkTooLong
								? "too-long"
								: "duplicate") satisfies LinkInvalidReason,
					},
				),
			);
		}
		const linkNameProblem = invalidLinkFormat
			? undefined
			: caseOperationLinkNameProblem(link.identifier, (action) => {
					const { placements } = placementsOfForm();
					if (placements.get(operation.uuid)?.placement.kind !== "save-to-case")
						return false;
					return saveToCaseActions(
						operation,
						ctx.form.type,
						placements.get("own-close")?.sharesWith === operation.uuid,
					)[action];
				});
		if (linkNameProblem !== undefined) {
			// The free name avoids every link identifier of the operation.
			const suggestedId = freeCaseOperationName(link.identifier, allLinkIds);
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_LINK_INVALID",
					`Link identifier "${link.identifier}" of case operation "${operation.id}": ${caseOperationNameSentence(link.identifier, linkNameProblem, suggestedId)}`,
					{
						reason: "name" satisfies LinkInvalidReason,
						linkIdentifier: link.identifier,
						problem: linkNameProblem,
						suggestedId,
					},
				),
			);
		}
		linkIds.add(link.identifier);
		validateCaseType(ctx, operation, link.targetType, errors);
		if (link.target !== null) {
			if (link.target.kind === "new" || link.target.kind === "worker-record") {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_LINK_INVALID",
						"A link target must be an existing/session/runtime case or an earlier create.",
						{ reason: "target-kind" satisfies LinkInvalidReason },
					),
				);
			} else {
				validateTarget(
					ctx,
					operation,
					link.target,
					priorCreates,
					{
						entity: "form",
						uuid: ctx.formUuid,
						slot: "case_operation_link_target_expression",
						member: {
							operationUuid: operation.uuid,
							identifier: link.identifier,
						},
					},
					errors,
				);
			}
			if (targetsOperationCase(ctx.form.type, operation, link.target)) {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_LINK_INVALID",
						"A case operation cannot link its case to itself.",
						{ reason: "self-link" satisfies LinkInvalidReason },
					),
				);
			}
		}
	}
}

/**
 * The form's own case: its case type is the module's and its target is the
 * form's, so neither is checked here. A registration's own arm names the
 * case it creates (`CASE_CREATE_NAME_MISSING` without one); on a follow-up or
 * close form a name renames the loaded case.
 */
function validateOwnOperation(
	ctx: OperationRuleContext,
	operation: Extract<CaseOperation, { action: "own" }>,
	errors: ValidationError[],
): void {
	const registration = ctx.form.type === "registration";
	if (registration && operation.name === undefined) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_CREATE_NAME_MISSING",
				caseCreateNameMissingMessage(ctx.form.name),
			),
		);
	}
	validateNameExpression(
		ctx,
		operation,
		operation.name,
		registration ? "create name" : "rename",
		errors,
	);
	validateTextExpression(
		ctx,
		operation,
		operation.owner,
		"owner",
		operationSlot(ctx, operation, "case_operation_owner"),
		errors,
	);
	const caseType = operationCaseType(ctx.doc, ctx.formUuid, operation);
	// An own arm in a module without a case type is refused at the form
	// (`CASE_OWN_OPERATION`, reason `form-type`); its writes save nowhere.
	if (caseType !== undefined) {
		const worker = caseType === USERCASE_CASE_TYPE;
		validateWrites(ctx, operation, caseType, worker, errors);
		if (worker && ctx.form.type === "followup")
			validateOwnWorkerFacets(ctx, operation, errors);
	}
	validateFacetOnlyIfChanged(ctx, operation, errors);
	validateLinks(ctx, operation, new Map(), errors);
}

function validateOwnWorkerFacets(
	ctx: OperationRuleContext,
	operation: Extract<CaseOperation, { action: "own" }>,
	errors: ValidationError[],
): void {
	for (const [facet, words] of [
		["name", "rename it"],
		["owner", "change its owner"],
		["links", "link it to another case"],
	] as const) {
		const value = operation[facet];
		if (value === undefined || (Array.isArray(value) && value.length === 0))
			continue;
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_TARGET_INVALID",
				`The worker's record belongs to their profile. This form can save a worker detail, but it can't ${words}.`,
				{
					reason: "worker-record-facet" satisfies WorkerRecordReason,
					facet,
				},
			),
		);
	}
}

/**
 * A name or create name. A link to a captured file is never a case's name:
 * CommCare keeps the name as the case's own scalar, and the link is the
 * file's address (`CAPTURE_CASE_WRITE_STANDARD_PROPERTY`).
 */
function validateNameExpression(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	expression: Expression | undefined,
	facet: "create name" | "rename",
	errors: ValidationError[],
): void {
	const read = caseWriteValueField(expression);
	if (read?.link === true) {
		errors.push(
			captureStandardPropertyError(ctx, operation, read.field, "case_name"),
		);
		return;
	}
	validateTextExpression(
		ctx,
		operation,
		expression,
		facet,
		operationSlot(ctx, operation, "case_operation_name"),
		errors,
		{ fieldOwnsAssignment: fieldJudgesItsOwnType(ctx, expression) },
	);
}

function captureStandardPropertyError(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	fieldUuid: Uuid,
	property: string,
): ValidationError {
	const fieldId = ctx.doc.fields[fieldUuid]?.id ?? "a capture question";
	const what = isWritableStandardCaseProperty(property)
		? WRITABLE_STANDARD_CASE_PROPERTY_WORDS[property]
		: "owner";
	return opError(
		ctx,
		operation,
		"CAPTURE_CASE_WRITE_STANDARD_PROPERTY",
		`“${operation.id}” in “${ctx.form.name}” saves the link to the file “${fieldId}” captures as the case's ${what}, which CommCare keeps as the case's own value rather than a link. You can save the link to a property of its own instead.`,
		{ property, questionId: fieldId },
	);
}

/**
 * Every write of one operation: its property on the case its `via` reaches,
 * its value and its condition, and the `via` and `onlyIfChanged` facets.
 * `destination` is the operation's own case type after any retype.
 */
function validateWrites(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	destination: string,
	workerRecord: boolean,
	errors: ValidationError[],
): void {
	const seenWrites: CaseOperationWrite[] = [];
	for (const write of operation.writes ?? []) {
		const reached =
			write.via === undefined
				? destination
				: validateVia(ctx, operation, write, write.via, destination, errors);
		validateOnlyIfChanged(ctx, operation, write, errors);
		if (
			retainedExternalIdDayRead(
				externalIdCalendarDayField(operation),
				write,
			) !== undefined
		) {
			const placement = planPlacements(ctx.doc, ctx.formUuid).placements.get(
				operation.uuid,
			)?.placement;
			const stable =
				operation.action === "own" &&
				placement?.kind === "basic" &&
				placement.slot === "own" &&
				basicOwnExternalIdDayValue(
					caseSlotFacts(ctx.doc, ctx.formUuid),
					write,
				) !== undefined &&
				!Object.values(ctx.doc.forms).some(
					(entry) => entry.shadowOf?.form === ctx.formUuid,
				);
			if (!stable)
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_EXPRESSION_TYPE",
						"This question saves its calendar day as the external ID of the case this form opens. You can remove that save before changing how the form opens or saves to the case.",
						{
							property: write.property,
							reason: "external-id-calendar-day-placement",
						},
					),
				);
		}
		if (
			seenWrites.some(
				(seen) =>
					sameCaseWriteKey(caseWriteKeyOf(seen), caseWriteKeyOf(write)) ||
					(seen.property === write.property &&
						isParentUserWritePath(seen.via) &&
						isParentUserWritePath(write.via)),
			)
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_WRITE_DUPLICATE_PROPERTY",
					`“${operation.id}” saves ${write.property} twice. You can keep one of them.`,
					{
						reason: "operation" satisfies CaseWriteDuplicateReason,
						property: write.property,
					},
				),
			);
		}
		seenWrites.push(write);
		if (workerRecord)
			validateWorkerRecordProperty(ctx, operation, write, errors);
		else if (reached !== undefined && !isFacetWriteThroughIndex(write))
			validateWriteProperty(
				ctx,
				operation,
				write.property,
				reached,
				// A field's answer saved as it is declares the property it saves
				// to, as a field's "Saves to" always has (`effectiveCaseTypes`
				// derives its entry from the writer); a computed value saves only
				// to a property the catalog declares.
				caseWriteValueField(write.value) !== undefined,
				errors,
			);
		// The name and owner of a case above are writes through `via`
		// (`standardCaseProperties.ts::CASE_FACETS_THROUGH_INDEX`); the own
		// case's are the operation's facets.
		if (!workerRecord && isReservedCaseOperationWrite(write)) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_RESERVED_PROPERTY",
					`Case property "${write.property}" is reserved; use the operation's dedicated facet instead.`,
				),
			);
		}
		const read = caseWriteValueField(write.value);
		if (
			read !== undefined &&
			keepsHiddenClock(ctx.doc.fields[read.field]) &&
			ctx.doc.caseTypes
				?.find(({ name }) => name === reached)
				?.properties.some(
					({ name, data_type }) =>
						name === write.property && data_type === "date",
				) &&
			planPlacements(ctx.doc, ctx.formUuid).placements.get(operation.uuid)
				?.placement.kind !== "basic"
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_EXPRESSION_TYPE",
					"A hidden timestamp can save its day through basic Case Management. You can save the day as a separate calculated answer here.",
					{ property: write.property, reason: "hidden-day-placement" },
				),
			);
		}
		if (
			read?.link === true &&
			(isWritableStandardCaseProperty(write.property) ||
				isFacetWriteThroughIndex(write))
		)
			errors.push(
				captureStandardPropertyError(
					ctx,
					operation,
					read.field,
					write.property,
				),
			);
		const fieldOwnsAssignment = fieldJudgesItsOwnType(ctx, write.value);
		const writerTypes =
			reached === undefined || fieldOwnsAssignment
				? undefined
				: ctx.writerTypes.get(reached)?.get(write.property);
		if ((writerTypes?.size ?? 0) > 1) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_EXPRESSION_TYPE",
					`Case property "${write.property}" on ${reached} has conflicting writer types: ${[...(writerTypes ?? [])].sort().join(", ")}.`,
				),
			);
		}
		validateExpressionSlot(
			ctx,
			operation,
			write.value,
			{
				entity: "form",
				uuid: ctx.formUuid,
				slot: "case_operation_write_value",
				member: {
					operationUuid: operation.uuid,
					property: write.property,
					...(write.via !== undefined && { via: write.via }),
				},
			},
			errors,
			{ fieldOwnsAssignment },
		);
		validatePredicateSlot(
			ctx,
			operation,
			write.condition,
			{
				entity: "form",
				uuid: ctx.formUuid,
				slot: "case_operation_write_condition",
				member: {
					operationUuid: operation.uuid,
					property: write.property,
					...(write.via !== undefined && { via: write.via }),
				},
			},
			errors,
		);
	}
}

/**
 * Whether `value` is a field's answer saved as it is, by a field whose type
 * agreement with the property a field rule judges: a question whose kind
 * pins a type, or a Hidden Value, whose inferred type the writer-agreement
 * rule reads.
 */
function fieldJudgesItsOwnType(
	ctx: OperationRuleContext,
	value: Expression | undefined,
): boolean {
	const read = caseWriteValueField(value);
	if (read === undefined || read.link) return false;
	const field = ctx.fields.get(read.field);
	return (
		field !== undefined &&
		(field.kind === "hidden" || field.dataType !== undefined)
	);
}

function validateWriteProperty(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	property: string,
	destination: string,
	writerDeclares: boolean,
	errors: ValidationError[],
): void {
	const declared =
		writerDeclares ||
		(ctx.doc.caseTypes ?? [])
			.find((caseType) => caseType.name === destination)
			?.properties.some((entry) => entry.name === property);
	const invalidPropertyFormat = !isCaseOperationProperty(property);
	const propertyTooLong = property.length > MAX_CASE_PROPERTY_LENGTH;
	if (
		!invalidPropertyFormat &&
		!propertyTooLong &&
		(declared === true || isWritableStandardCaseProperty(property))
	)
		return;
	errors.push(
		opError(
			ctx,
			operation,
			"CASE_OPERATION_UNKNOWN_PROPERTY",
			invalidPropertyFormat
				? `Case property "${property}" is invalid. ${CASE_OPERATION_PROPERTY_FORMAT_MESSAGE}`
				: propertyTooLong
					? `Case property "${property}" is longer than ${MAX_CASE_PROPERTY_LENGTH} characters.`
					: `Case property "${property}" is not declared on ${destination}.`,
		),
	);
}

/**
 * A write to the worker's record saves one of the worker details the app
 * declares (Worker information in App setup), never one Nova keeps in step
 * with the worker's profile.
 */
function validateWorkerRecordProperty(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	write: CaseOperationWrite,
	errors: ValidationError[],
): void {
	const location = { property: write.property, caseType: USERCASE_CASE_TYPE };
	if (USERCASE_BUILT_IN_KEYS.includes(write.property)) {
		errors.push(
			opError(
				ctx,
				operation,
				"USERCASE_WRITE_MANAGED_PROPERTY",
				`“${operation.id}” in “${ctx.form.name}” saves to "${write.property}" on the worker's own record. Nova keeps that one in step with the worker's profile, so a value saved there is replaced the next time that worker changes. You can save to a worker detail you added under Worker information instead.`,
				location,
			),
		);
		return;
	}
	const declared = Object.values(userPropertiesOf(ctx.doc)).some(
		(property) => property.slug === write.property,
	);
	if (declared) return;
	errors.push(
		opError(
			ctx,
			operation,
			"USERCASE_WRITE_UNDECLARED_PROPERTY",
			`“${operation.id}” in “${ctx.form.name}” saves to "${write.property}" on the worker's own record, but no worker detail by that name exists. You can add it under Worker information in App setup, or save to one that is already there.`,
			location,
		),
	);
}

/** Where the form's own arm takes Save to Case, the first reason the basic
 * own slot can't hold it; `undefined` where Case Management holds it, as
 * the basic own slot or an advanced form's own load. */
function ownSlotRefusal(
	ctx: OperationRuleContext,
	operation: CaseOperation,
): { readonly ineligibility: string; readonly sentence: string } | undefined {
	const planned = planPlacements(ctx.doc, ctx.formUuid).placements.get(
		operation.uuid,
	);
	if (planned !== undefined && planned.placement.kind !== "save-to-case")
		return undefined;
	const first = placementIneligibility(
		ctx.doc,
		ctx.formUuid,
		{ kind: "operation", operationUuid: operation.uuid },
		{ kind: "basic", slot: "own" },
	)[0];
	return first === undefined
		? undefined
		: {
				ineligibility: first.reason,
				sentence: placementIneligibilitySentence(first.reason),
			};
}

/**
 * A save to the case above (`via`): the form's own case or the first
 * explicitly chosen case of an Advanced chain. Basic Case Management also holds a direct user index
 * with one ordinary declared case type at each end. Other writes walk `parent` and `host` steps the catalog resolves,
 * and only while Case Management saves that arm (HQ's update keys
 * `parent/p` and `host/parent/p`, `xform.py::get_case_parent_id_xpath`;
 * Vellum's Save to Case block saves one case, `saveToCase.js`). Returns the
 * case type the write lands on, when it resolves.
 */
function validateVia(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	write: CaseOperationWrite,
	via: CaseWriteVia,
	origin: string,
	errors: ValidationError[],
): string | undefined {
	const refuse = (
		reason: "new-case" | "target" | "step" | "unresolved" | "placement",
		message: string,
		extra?: Record<string, string>,
	): undefined => {
		errors.push(
			opError(ctx, operation, "CASE_WRITE_VIA_INVALID", message, {
				reason,
				property: write.property,
				...extra,
			}),
		);
		return undefined;
	};
	const newCase =
		operation.action === "create" ||
		(operation.action === "own" && ctx.form.type === "registration");
	if (newCase)
		return refuse(
			"new-case",
			`${write.property} is saved to the case above a case this form creates, and that case has no link yet while the form is open. You can save it from a form that opens the existing case.`,
		);
	const directUserIndex = via.length === 1 && via[0].identifier === "user";
	let firstAdvancedUserWrite = false;
	if (operation.action !== "own") {
		const planned = planPlacements(ctx.doc, ctx.formUuid).placements.get(
			operation.uuid,
		);
		const firstManualLoad =
			operation.action === "update" &&
			operation.target.kind === "expression" &&
			chainLoadOfTarget(ctx.doc, ctx.formUuid, operation.target) === 0 &&
			formCaseSelections(ctx.doc, ctx.formUuid)[0]?.source.kind === "choose" &&
			planned?.placement.kind === "advanced";
		firstAdvancedUserWrite =
			firstManualLoad &&
			directUserIndex &&
			write.property !== "case_name" &&
			write.property !== "owner_id" &&
			caseWriteValueField(write.value)?.link !== true;
		if (
			!firstManualLoad ||
			(!firstAdvancedUserWrite &&
				via.some(
					(step) => step.identifier !== "parent" && step.identifier !== "host",
				))
		)
			return refuse(
				"target",
				"A change can save through a parent or host from this form's own case or its first manually chosen case. You can add a change for the connected case directly.",
			);
	}
	if (isParentUserWritePath(via)) {
		if (caseWriteValueField(write.value)?.link === true)
			return refuse(
				"placement",
				"This linked change saves answers. A separate case change can save attachments.",
			);
		const types = parentUserWriteCaseTypes(via, origin, ctx.caseTypes);
		if (!types)
			return refuse(
				"unresolved",
				"Saving through this path needs a different ordinary case type for each step, with one declared record type at each link.",
			);
		const placement = planPlacements(ctx.doc, ctx.formUuid).placements.get(
			operation.uuid,
		)?.placement;
		if (
			ctx.form.type !== "followup" ||
			ctx.form.caseSelections !== undefined ||
			caseSelectionCardinality(ctx.module) === "multiple" ||
			(ctx.module.caseListConfig?.additionalCaseTypes?.length ?? 0) > 0 ||
			placement?.kind !== "basic" ||
			orderedCaseOperations(ctx.form).some((other) => other.action !== "own") ||
			(operation.links?.length ?? 0) > 0 ||
			operation.writes?.some(
				(other) => other.via !== undefined && !isParentUserWritePath(other.via),
			) ||
			Object.values(ctx.doc.forms).some(
				(form) => form.shadowOf?.form === ctx.formUuid,
			)
		)
			return refuse(
				"placement",
				"This path needs a basic follow-up that opens one case and uses a single linked update path.",
			);
		return types[1];
	}
	const step = via.find(
		(candidate) =>
			candidate.identifier !== "parent" &&
			candidate.identifier !== "host" &&
			!directUserIndex,
	);
	if (step !== undefined)
		return refuse(
			"step",
			`CommCare HQ saves to a case above only through a parent or host link, and “${step.identifier}” is neither.`,
			{ identifier: step.identifier },
		);
	const reached = resolveRelationDestination(
		{ kind: "ancestor", via: directUserIndex ? [{ identifier: "user" }] : via },
		origin,
		ctx.caseTypes,
	);
	if (
		!reached.ok ||
		(directUserIndex &&
			via[0].throughCaseType !== undefined &&
			via[0].throughCaseType !== reached.caseType)
	)
		return refuse(
			"unresolved",
			`${write.property} is saved through a link that doesn't lead to a case type. You can choose the case above it again.`,
		);
	if (directUserIndex) {
		const planned = planPlacements(ctx.doc, ctx.formUuid).placements.get(
			operation.uuid,
		)?.placement;
		if (
			(!firstAdvancedUserWrite && planned?.kind !== "basic") ||
			(firstAdvancedUserWrite && origin === reached.caseType) ||
			RESERVED_CASE_OPERATION_TYPES.has(origin) ||
			RESERVED_CASE_OPERATION_TYPES.has(reached.caseType)
		)
			return refuse(
				"step",
				"Saving through a user link needs an ordinary case at both ends and a form whose case changes use basic Case Management.",
				{ identifier: "user" },
			);
	}
	const placement = ownSlotRefusal(ctx, operation);
	if (placement !== undefined)
		refuse(
			"placement",
			`This form's case is saved through Save to Case, which saves one case per block. ${placement.sentence} You can save ${write.property} with a case change that updates that case instead.`,
			{
				ineligibility: placement.ineligibility,
				placementSentence: placement.sentence,
			},
		);
	return reached.caseType;
}

/**
 * Saving only an answer that changed: any write Case Management or an
 * advanced form's actions save, as HQ's build applies `update_mode: "edit"`
 * to every update map it writes (`xform.py::XFormCaseBlock.add_case_updates`,
 * over the own update, the worker's record, a child case, a load and an open
 * action). It compares the case's value with the answer, and a case the form
 * creates holds none, so there a blank answer saves nothing. Vellum's Save to
 * Case block has no such setting (`saveToCase.js`), so a change saved through
 * one is refused.
 */
function validateOnlyIfChanged(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	write: CaseOperationWrite,
	errors: ValidationError[],
): void {
	if (write.onlyIfChanged !== true) return;
	const placement =
		operation.action === "own"
			? ownSlotRefusal(ctx, operation)
			: savedThroughSaveToCase(ctx, operation);
	if (placement === undefined) return;
	errors.push(
		opError(
			ctx,
			operation,
			"CASE_WRITE_ONLY_IF_CHANGED_INVALID",
			operation.action === "own"
				? `This form's case is saved through Save to Case, which can't save only changed answers. ${placement.sentence} You can save ${write.property} every time, or change the form so Case Management can hold it.`
				: `“${operation.id}” is saved through Save to Case, which can't save only changed answers. You can save ${write.property} every time instead.`,
			{
				reason: "placement",
				property: write.property,
				...(placement.ineligibility !== undefined && {
					ineligibility: placement.ineligibility,
					placementSentence: placement.sentence,
				}),
			},
		),
	);
}

/**
 * Saving a name or an owner only when changed (`CaseFacetOnlyIfChanged`): HQ's
 * build applies `update_mode: "edit"` to the `name` and `owner_id` keys of an
 * update map as to any other key. It needs the facet it qualifies, and a
 * registration's own name is its `open_case.name_update`, whose mode HQ's
 * build never reads (`xform.py::XForm.create_casexml_2`). Save to Case has no
 * such setting, as for a write.
 */
function validateFacetOnlyIfChanged(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	errors: ValidationError[],
): void {
	const flags = (
		Object.keys(CASE_FACET_OF_ONLY_IF_CHANGED) as CaseFacetOnlyIfChanged[]
	).filter((flag) => operation[flag as keyof CaseOperation] === true);
	if (flags.length === 0) return;
	const property = (flag: CaseFacetOnlyIfChanged) =>
		CASE_FACET_OF_ONLY_IF_CHANGED[flag] === "owner" ? "owner_id" : "case_name";
	const words = (flag: CaseFacetOnlyIfChanged) =>
		CASE_FACET_OF_ONLY_IF_CHANGED[flag] === "owner" ? "owner" : "new name";
	const refuse = (
		flag: CaseFacetOnlyIfChanged,
		reason: "facet" | "never-blank" | "registration-name" | "placement",
		message: string,
		extra: Record<string, string> = {},
	) =>
		errors.push(
			opError(ctx, operation, "CASE_WRITE_ONLY_IF_CHANGED_INVALID", message, {
				reason,
				property: property(flag),
				...extra,
			}),
		);
	let placement:
		| { readonly ineligibility?: string; readonly sentence: string }
		| undefined
		| null = null;
	for (const flag of flags) {
		const facet = CASE_FACET_OF_ONLY_IF_CHANGED[flag];
		if (operation[facet] === undefined) {
			refuse(
				flag,
				"facet",
				`“${operation.id}” saves its ${words(flag)} only when it changed, but it saves no ${words(flag)}. You can choose one, or turn off saving it only when it changed.`,
			);
			continue;
		}
		// The worker and "no one" are never blank, so the owner they give is
		// saved every time, and HQ's build sets either one beside the update
		// map (`autoset_owner_id_for_*`), where no mode applies.
		const ownerKind = operation.owner?.kind;
		if (
			flag === "ownerOnlyIfChanged" &&
			(ownerKind === "acting-user" || ownerKind === "unowned")
		) {
			refuse(
				flag,
				"never-blank",
				`“${operation.id}” saves its owner only when it changed, but ${ownerKind === "acting-user" ? "the worker who submits the form" : "no one"} is never a blank answer, so the owner is saved every time. You can turn off saving it only when it changed.`,
			);
			continue;
		}
		if (
			flag === "nameOnlyIfChanged" &&
			operation.action === "own" &&
			ctx.form.type === "registration"
		) {
			refuse(
				flag,
				"registration-name",
				`“${ctx.form.name}” makes a new case, so its name has no earlier value to compare with. You can save the name every time.`,
			);
			continue;
		}
		if (placement === null)
			placement =
				operation.action === "own"
					? ownSlotRefusal(ctx, operation)
					: savedThroughSaveToCase(ctx, operation);
		if (placement === undefined) continue;
		refuse(
			flag,
			"placement",
			operation.action === "own"
				? `This form's case is saved through Save to Case, which can't save only changed answers. ${placement.sentence} You can save its ${words(flag)} every time, or change the form so Case Management can hold it.`
				: `“${operation.id}” is saved through Save to Case, which can't save only changed answers. You can save its ${words(flag)} every time instead.`,
			placement.ineligibility === undefined
				? {}
				: {
						ineligibility: placement.ineligibility,
						placementSentence: placement.sentence,
					},
		);
	}
}

/** A change other than the own arm that Nova saves through Save to Case. */
function savedThroughSaveToCase(
	ctx: OperationRuleContext,
	operation: CaseOperation,
): { readonly ineligibility?: string; readonly sentence: string } | undefined {
	const planned = planPlacements(ctx.doc, ctx.formUuid).placements.get(
		operation.uuid,
	);
	return planned?.placement.kind === "save-to-case"
		? { sentence: "" }
		: undefined;
}

/** Whether `target` is the form's own case as Nova can prove it: the loaded
 * case on a follow-up or close form, the own arm's create on a registration. */
function targetsOwnCase(
	ctx: OperationRuleContext,
	target: CaseTarget,
	ownUuid: Uuid,
): boolean {
	return ctx.form.type === "registration"
		? target.kind === "op" && target.opUuid === ownUuid
		: CASE_LOADING_FORM_TYPES.has(ctx.form.type) && target.kind === "session";
}

/** The managed basic follow-up's empty block only records its timestamp.
 * Its submitted case does not reopen or change a property if the separate
 * authored close has already run. */
function closeBesideEmptyBasicFollowup(
	ctx: OperationRuleContext,
	own: Extract<CaseOperation, { action: "own" }>,
	operation: CaseOperation,
	count: number,
): boolean {
	return (
		ctx.form.type === "followup" &&
		count === 2 &&
		own.placement?.kind === "basic" &&
		own.placement.slot === "own" &&
		!ownCaseOperationHasEffects(own) &&
		operation.action === "close" &&
		operation.target.kind === "session" &&
		operation.placement?.kind === "save-to-case" &&
		operation.closeCondition !== undefined &&
		operation.condition === undefined &&
		operation.forEach === undefined &&
		!operation.writes?.length
	);
}

/**
 * The own arm's effects mean the same wherever its block runs, because no
 * other operation writes what it writes on the form's own case
 * (`CASE_WRITE_DUPLICATE_PROPERTY` reason `own-case`) or closes that case
 * (`CASE_OPERATION_CLOSES_OWN_CASE`). A write through `via` counts on the
 * case `via` reaches. A retype of the own case where the own arm writes is
 * the rolling type proof's (`CASE_OPERATION_TARGET_TYPE_MISMATCH`). An
 * `expression` target is not proven to be the own case, so it is outside
 * these rules.
 */
function ownCaseIndependenceFindings(
	ctx: OperationRuleContext,
	operations: readonly CaseOperation[],
): ValidationError[] {
	const own = operations.find((operation) => operation.action === "own");
	if (own === undefined) return [];
	const ownKeys = (own.writes ?? []).map(caseWriteKeyOf);
	const errors: ValidationError[] = [];
	const duplicate = (operation: CaseOperation, property: string) =>
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_WRITE_DUPLICATE_PROPERTY",
				`“${operation.id}” saves ${property} to this form's case, which this form's own change already saves. You can save it in one of the two.`,
				{
					reason: "own-case" satisfies CaseWriteDuplicateReason,
					property,
					ownOperationUuid: own.uuid,
				},
			),
		);
	for (const operation of operations) {
		if (operation.action === "own") continue;
		if (!targetsOwnCase(ctx, operation.target, own.uuid)) continue;
		if (
			(operation.action === "close" || operation.closeAfter === true) &&
			!closeBesideEmptyBasicFollowup(ctx, own, operation, operations.length)
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_CLOSES_OWN_CASE",
					ctx.form.type === "close"
						? `“${ctx.form.name}” already closes its own case. You can remove “${operation.id}”, or set when it closes in the form's settings.`
						: `“${operation.id}” closes this form's own case. You can make “${ctx.form.name}” a close form, which closes it, and remove this change.`,
					{ formType: ctx.form.type },
				),
			);
		}
		if (own.name !== undefined && operation.rename !== undefined)
			duplicate(operation, "case_name");
		if (own.owner !== undefined && operation.owner !== undefined)
			duplicate(operation, "owner_id");
		for (const write of operation.writes ?? []) {
			const key = caseWriteKeyOf(write);
			if (
				(own.name !== undefined &&
					key.via === undefined &&
					key.property === "case_name") ||
				(own.owner !== undefined &&
					key.via === undefined &&
					key.property === "owner_id") ||
				ownKeys.some((ownKey) => sameCaseWriteKey(ownKey, key))
			)
				duplicate(operation, write.property);
		}
	}
	return errors;
}

/** The facets an update of the worker's record may not carry, each with
 * the words its refusal names it by. */
const WORKER_RECORD_FACETS = [
	["rename", "rename it"],
	["owner", "change its owner"],
	["closeAfter", "close it"],
	["retype", "change its type"],
	["links", "link it to another case"],
	["condition", "run on a condition"],
	["forEach", "run for each row of a repeat"],
] as const;

function isRepeatedWorkerUpdate(operation: CaseOperation): boolean {
	return isWorkerRecordUpdate(operation) && operation.forEach !== undefined;
}

function hasWorkerRecordEffect(
	ctx: OperationRuleContext,
	operation: CaseOperation,
): boolean {
	// An empty advanced load has no submitted block. A basic or retained
	// Save to Case block still advances the case timestamp.
	return (
		operation.action !== "own" ||
		ctx.form.type !== "followup" ||
		ownCaseOperationHasEffects(operation) ||
		operation.placement?.kind === "save-to-case" ||
		!menuEmittedAdvanced(ctx.doc, ctx.moduleUuid)
	);
}

function workerRecordTwiceFinding(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	other: CaseOperation,
): ValidationError {
	return opError(
		ctx,
		operation,
		"CASE_OPERATION_TARGET_INVALID",
		`This form already saves to the worker's record in “${other.id}”. You can add these saves there.`,
		{
			reason: "worker-record-twice" satisfies WorkerRecordReason,
			firstOperationUuid: other.uuid,
		},
	);
}

/** Disjoint single-occurrence writes commute even when HQ moves its managed
 * block after the authored blocks. Empty blocks, aliases and repetitions keep
 * their existing restrictions. */
function disjointDirectWorkerUpdates(
	operations: readonly CaseOperation[],
): boolean {
	const properties = new Set<string>();
	for (const operation of operations) {
		if (
			!isWorkerRecordUpdate(operation) ||
			operation.forEach !== undefined ||
			!operation.writes?.length
		)
			return false;
		for (const write of operation.writes) {
			if (write.via !== undefined || properties.has(write.property))
				return false;
			properties.add(write.property);
		}
	}
	return true;
}

/** The worker's record can only receive property updates. A form's separate
 * direct updates can coexist when every property belongs to one block. */
function workerRecordFindings(
	ctx: OperationRuleContext,
	operations: readonly CaseOperation[],
): ValidationError[] {
	const errors: ValidationError[] = [];
	const workerOperations = operations.filter((operation) =>
		addressesWorkerRecord(ctx.form, operation, ctx.module.caseType),
	);
	const repeatedWorker = workerOperations.find(isRepeatedWorkerUpdate);
	const disjoint = disjointDirectWorkerUpdates(workerOperations);
	let first: CaseOperation | undefined;
	for (const operation of workerOperations) {
		// A repeated direct block cannot also reach the worker through an
		// own case, a worker selection, or another direct worker change.
		if (
			repeatedWorker !== undefined &&
			operation !== repeatedWorker &&
			hasWorkerRecordEffect(ctx, operation)
		)
			errors.push(workerRecordTwiceFinding(ctx, operation, repeatedWorker));
		if (operation.action === "own") continue;
		if (
			operation.action !== "update" ||
			operation.caseType !== USERCASE_CASE_TYPE
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_TARGET_INVALID",
					"The worker's record is a commcare-user case, so only an update of commcare-user can save to it.",
					{ reason: "worker-record-type" satisfies WorkerRecordReason },
				),
			);
			continue;
		}
		if (
			repeatedWorker === undefined &&
			operation.target.kind === "worker-record"
		) {
			if (first === undefined) first = operation;
			else if (!disjoint)
				errors.push(workerRecordTwiceFinding(ctx, operation, first));
		}
		for (const [facet, words] of WORKER_RECORD_FACETS) {
			// Only a direct worker-record target can carry its own condition.
			if (facet === "condition" && operation.target.kind === "worker-record")
				continue;
			if (
				facet === "forEach" &&
				operation.target.kind === "worker-record" &&
				operation.forEach !== undefined &&
				ctx.form.uuid === ctx.formUuid
			) {
				const repeat = operation.forEach.repeat;
				const field = ctx.doc.fields[repeat];
				if (
					field?.kind === "repeat" &&
					ctx.fields.get(repeat)?.repeatPath.length === 1
				) {
					const guards = caseOperationConditionalGuardUuids(
						ctx.doc,
						ctx.formUuid,
						operations,
					).get(operation.uuid);
					if (!guards?.size) continue;
				}
			}
			const value = operation[facet];
			if (value === undefined || (Array.isArray(value) && value.length === 0))
				continue;
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_TARGET_INVALID",
					`The worker's record can only be updated, so “${operation.id}” can't ${words}.`,
					{ reason: "worker-record-facet" satisfies WorkerRecordReason, facet },
				),
			);
		}
	}
	return errors;
}

/**
 * Why the gate refuses a case type an operation names (its own, its retype's,
 * a link's) by the name alone: outside CommCare's case type grammar, or
 * longer than CommCare keeps (`CASE_OPERATION_INVALID_CASE_TYPE`).
 */
export function caseOperationCaseTypeNameProblem(
	caseType: string,
): "grammar" | "too-long" | undefined {
	if (!CASE_TYPE_REGEX.test(caseType)) return "grammar";
	if (caseType.length > MAX_CASE_TYPE_LENGTH) return "too-long";
	return undefined;
}

/** In this range every alternative takes the same authored writes. No later
 * operation can assume which type the new identity has. */
function validateCreateTypeChoice(
	ctx: OperationRuleContext,
	operation: TargetedCaseOperation,
	errors: ValidationError[],
): void {
	const choice = operation.typeChoice;
	if (choice === undefined) return;
	validateCaseType(ctx, operation, choice.otherwise, errors);
	validatePredicateSlot(
		ctx,
		operation,
		choice.condition,
		operationSlot(ctx, operation, "case_operation_type_condition"),
		errors,
	);
	const primary = ctx.caseTypesByName.get(operation.caseType);
	const alternate = ctx.caseTypesByName.get(choice.otherwise);
	const compatibleWrites = (operation.writes ?? []).every((write) => {
		if (
			write.via !== undefined ||
			(write.value.kind === "term" && write.value.term.kind === "capture-link")
		)
			return false;
		if (Object.hasOwn(WRITABLE_STANDARD_CASE_PROPERTY_WORDS, write.property))
			return true;
		const from = primary?.properties.find(
			(property) => property.name === write.property,
		);
		const to = alternate?.properties.find(
			(property) => property.name === write.property,
		);
		return (
			from !== undefined &&
			to !== undefined &&
			from.data_type === to.data_type &&
			from.data_type !== "single_select" &&
			from.data_type !== "multi_select" &&
			(from.options?.length ?? 0) === 0 &&
			(to.options?.length ?? 0) === 0
		);
	});
	const consumers = (ctx.form.caseOperations ?? []).some((other) =>
		caseOperationDependencyUuids(other).has(operation.uuid),
	);
	const suppliesCaseList = Object.values(ctx.doc.modules).some((menu) => {
		const action = menu.caseListRegistrationForm;
		return (
			action?.kind === "always" &&
			action.formUuid === ctx.formUuid &&
			action.target?.kind === "created-case" &&
			action.target.operationUuid === operation.uuid
		);
	});
	const owners = [
		{ entity: "form" as const, uuid: ctx.formUuid },
		...[...ctx.fields.keys()].map((uuid) => ({
			entity: "field" as const,
			uuid,
		})),
	];
	let expressionConsumer = false;
	for (const owner of owners)
		for (const { expression } of expressionSlotValues(ctx.doc, owner))
			walkExpressionNodes(expression, (node) => {
				if (node.kind === "id-of" && node.opUuid === operation.uuid)
					expressionConsumer = true;
			});
	if (
		operation.typeCalculation !== undefined ||
		choice.otherwise === operation.caseType ||
		operation.target.kind !== "new" ||
		operation.target.idFrom !== undefined ||
		operation.target.expr !== undefined ||
		(operation.links?.length ?? 0) > 0 ||
		operation.closeAfter === true ||
		ctx.form.entryCaseCreations?.includes(operation.uuid) === true ||
		expressionContainsIdOf(choice.condition) ||
		consumers ||
		expressionConsumer ||
		suppliesCaseList ||
		!compatibleWrites
	)
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_TYPE_CHOICE_INVALID",
				"A create that chooses between case types needs a new case, compatible saved properties, and no connected case changes.",
			),
		);
}

function validateCaseType(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	caseType: string,
	errors: ValidationError[],
): void {
	if (caseOperationCaseTypeNameProblem(caseType) !== undefined) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_INVALID_CASE_TYPE",
				`Case type "${caseType}" holds only letters, digits, underscores, or hyphens, and is at most ${MAX_CASE_TYPE_LENGTH} characters.`,
			),
		);
	}
	if (!ctx.caseTypesByName.has(caseType)) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_UNKNOWN_CASE_TYPE",
				`Case type "${caseType}" is not declared in this app.`,
			),
		);
	}
	if (RESERVED_CASE_OPERATION_TYPES.has(caseType)) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_RESERVED_CASE_TYPE",
				`Case type "${caseType}" is platform-owned and cannot be changed by a Nova case operation.`,
			),
		);
	}
}

function validateTarget(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	target: CaseTarget,
	priorCreates: ReadonlyMap<Uuid, CaseOperation>,
	slot: FormExpressionSlotRef,
	errors: ValidationError[],
): void {
	switch (target.kind) {
		case "new":
			if (target.expr !== undefined)
				validateTarget(
					ctx,
					operation,
					{ kind: "expression", expr: target.expr },
					priorCreates,
					slot,
					errors,
				);
			return;
		// The worker's record is always there; `workerRecordFindings` holds
		// which operation may target it.
		case "worker-record":
			return;
		case "session":
			if (!ctx.sessionCaseAvailable) {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_SESSION_UNAVAILABLE",
						"The session target is available only when the module selects one case before opening its forms.",
						{
							reason: (slot.slot === "case_operation_link_target_expression"
								? "link-target"
								: "target") satisfies SessionUnavailableReason,
						},
					),
				);
			}
			return;
		case "expression": {
			if (
				target.expr.kind === "term" &&
				target.expr.term.kind === "literal" &&
				typeof target.expr.term.value === "string"
			) {
				const prepared = prepareCaseScalarTextValue(
					target.expr.term.value,
					"reject",
				);
				if (!prepared.ok && prepared.reason === "blank") {
					errors.push(
						opError(
							ctx,
							operation,
							"CASE_OPERATION_TARGET_INVALID",
							`Case operation "${operation.id}" has a blank runtime case target. A calculated target must contain a case id after CommCare-compatible boundary whitespace is removed.`,
							{ reason: "blank-target" satisfies TargetInvalidReason },
						),
					);
				}
			}
			const exactCreateId =
				slot.slot === "case_operation_target_expression" &&
				operation.action === "create" &&
				operation.target.kind === "new" &&
				operation.target.expr !== undefined;
			if (exactCreateId && operation.forEach === undefined) {
				let readsKeyedId = false;
				walkExpressionNodes(target.expr, (node) => {
					if (node.kind !== "id-of") return;
					const create = priorCreates.get(node.opUuid);
					if (
						create?.target?.kind === "new" &&
						create.target.idFrom !== undefined
					)
						readsKeyedId = true;
				});
				if (readsKeyedId)
					errors.push(
						opError(
							ctx,
							operation,
							"CASE_OPERATION_TARGET_INVALID",
							"The form sets this case ID when it opens, before a keyed case has an ID. Choose a value available when the form opens.",
							{ reason: "id-of-target" satisfies TargetInvalidReason },
						),
					);
			}
			if (!exactCreateId && expressionContainsIdOf(target.expr)) {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_TARGET_INVALID",
						"This runtime target is already the known output of a create operation. Target that operation directly so type, order, and repeat correlation stay explicit.",
						{ reason: "id-of-target" satisfies TargetInvalidReason },
					),
				);
			}
			validateExpressionSlot(ctx, operation, target.expr, slot, errors);
			return;
		}
		case "op": {
			const producer = priorCreates.get(target.opUuid);
			if (producer === undefined) {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_REFERENCE_ORDER",
						`Operation "${operation.id}" must reference an earlier create operation.`,
					),
				);
				return;
			}
			validateRepeatReference(ctx, operation, producer, errors);
			return;
		}
	}
}

type OperationScalarSlot =
	| "case_operation_target_expression"
	| "case_operation_condition"
	| "case_operation_close_condition"
	| "case_operation_name"
	| "case_operation_owner"
	| "case_operation_type_condition"
	| "case_operation_owner_condition"
	| "case_operation_later_owner"
	| "case_operation_later_owner_condition"
	| "case_operation_rename";
function operationSlot(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	slot: OperationScalarSlot,
): FormExpressionSlotRef {
	return {
		entity: "form",
		uuid: ctx.formUuid,
		slot,
		member: { operationUuid: operation.uuid },
	};
}

function validateExpressionSlot(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	expression: Expression,
	slot: FormExpressionSlotRef,
	errors: ValidationError[],
	options: { readonly fieldOwnsAssignment?: boolean } = {},
): void {
	const typeContext = slotContext(ctx.doc, slot, ctx.lookupTables ?? new Map());
	if (typeContext === undefined) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_EXPRESSION_TYPE",
				`An expression in case operation "${operation.id}" has no valid owning slot.`,
			),
		);
		return;
	}
	const result = checkExpression(expression, typeContext);
	// Whether a field's answer fits the property it saves to is the field's
	// own rule (`FIELD_KIND_PROPERTY_TYPE_MISMATCH`, `FIELD_KIND_WRITERS_DISAGREE`,
	// `HIDDEN_VALUE_WRITER_TYPE_MISMATCH`), which names the field; the same
	// refusal is not said again here at the operation that saves it.
	const typeErrors = semanticCheckErrors(result).filter(
		(error) =>
			!(
				options.fieldOwnsAssignment === true &&
				error.code === "expected-value" &&
				error.path.length === 0 &&
				(error.reason === undefined || error.reason === "clock-lost")
			),
	);
	if (typeErrors.length > 0)
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_EXPRESSION_TYPE",
				`An expression in case operation "${operation.id}" is not valid here: ${typeErrors.map((error) => error.message).join("; ")}`,
				// The midnight reason names the whole finding only when every error
				// is a write's lost clock; otherwise a refused comparison between
				// moments (or else the first error) rides as `checkCode` and
				// `checkReason`, so that comparison takes its own copy.
				typeErrors.every(
					(error) =>
						error.code === "expected-value" && error.reason === "clock-lost",
				)
					? { reason: "clock-lost" }
					: checkErrorDetails(
							typeErrors.find((error) => error.instant !== undefined) ??
								typeErrors[0],
							typeContext,
						),
			),
		);
	// A link to a captured file is printed as the capture's URL node by case
	// emission, never through an expression, so it has no printing to try.
	else if (
		result.errors.length === 0 &&
		caseWriteValueField(expression)?.link !== true
	)
		validateOnDeviceExpression(ctx, operation, expression, typeContext, errors);
	validateCaseSnapshotUse(
		ctx,
		operation,
		expressionUsesCaseSnapshot(expression, typeContext),
		errors,
	);
	walkExpression(expression, {
		visitExpression(node) {
			if (node.kind === "id-of")
				validateIdOfReference(ctx, operation, node.opUuid, typeContext, errors);
		},
		visitTerm(term, path) {
			validateOperationTerm(
				ctx,
				operation,
				term,
				activeRowScope(expressionContextAtPath(expression, typeContext, path))
					?.kind === "table",
				errors,
			);
		},
	});
}

function validateTextExpression(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	expression: Expression | undefined,
	facet: "create name" | "owner" | "rename",
	slot: FormExpressionSlotRef,
	errors: ValidationError[],
	options: { readonly fieldOwnsAssignment?: boolean } = {},
): void {
	if (expression === undefined) return;
	const locationTerms: Term[] = [];
	walkExpressionTerms(expression, (term) => {
		if (
			term.kind === "fixed-location" ||
			term.kind === "owner-location-at-level"
		) {
			locationTerms.push(term);
		}
	});
	if (
		locationTerms.length > 0 &&
		(facet !== "owner" ||
			expression.kind !== "term" ||
			(expression.term.kind !== "fixed-location" &&
				expression.term.kind !== "owner-location-at-level"))
	) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_EXPRESSION_TYPE",
				"A place destination must be the complete case-owner value; it cannot be nested inside another calculation or used for a case name or rename.",
			),
		);
	}
	validateExpressionSlot(ctx, operation, expression, slot, errors, options);
	if (
		expression.kind !== "term" ||
		expression.term.kind !== "literal" ||
		typeof expression.term.value !== "string"
	) {
		return;
	}
	const prepared = prepareCaseScalarTextValue(expression.term.value, "reject");
	if (prepared.ok) return;
	errors.push(
		opError(
			ctx,
			operation,
			"CASE_OPERATION_EXPRESSION_TYPE",
			prepared.reason === "blank"
				? `Case operation "${operation.id}" has a blank ${facet}. Names, renames, and explicit owners must contain a value after CommCare-compatible boundary whitespace is removed.`
				: `Case operation "${operation.id}" has a ${facet} longer than ${MAX_CASE_SCALAR_TEXT_LENGTH} UTF-16 code units after boundary control characters are removed.`,
		),
	);
}

function validatePredicateSlot(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	predicate: Expression | undefined,
	slot: FormExpressionSlotRef,
	errors: ValidationError[],
): void {
	if (predicate !== undefined)
		validateExpressionSlot(ctx, operation, predicate, slot, errors);
}

/** The id each session value a form's case changes read prints as, from
 * the entry that opens the form, resolved once per rule pass. */
const datumIdsByContext = new WeakMap<
	OperationRuleContext,
	ReturnType<typeof entryDatumIdResolver>
>();
function operationDatumId(
	ctx: OperationRuleContext,
): ReturnType<typeof entryDatumIdResolver> {
	let resolver = datumIdsByContext.get(ctx);
	if (resolver === undefined) {
		resolver = entryDatumIdResolver(
			entryDatumIds(
				ctx.doc,
				formLinkProjectionContext(ctx.doc, { entryMetadataOnly: true }),
				ctx.moduleUuid,
				ctx.formUuid,
			),
		);
		datumIdsByContext.set(ctx, resolver);
	}
	return resolver;
}

/**
 * Typed target compatibility is decided before emission. The remaining dry
 * run is a totality backstop for context-free emitter guards (match functions,
 * relation cardinality, and future guarded arms), not the semantic source for
 * facts such as whether a property-backed date calculation starts from a
 * datetime. The canonical AST carries property identity, not its resolved
 * type, so only the shared ExpressionContext-aware classifier can make that decision.
 */
function validateOnDeviceExpression(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	expression: Expression,
	typeContext: ExpressionContext,
	errors: ValidationError[],
): void {
	// A capture's link is printed as the capture's address, never as an
	// expression, so a whole capture-link value has no on-device form to check.
	if (expression.kind === "term" && expression.term.kind === "capture-link")
		return;
	const compatibilityIssue = findOnDeviceDateAddIssue(expression, typeContext);
	if (compatibilityIssue !== undefined) {
		errors.push(
			onDeviceDateAddOperationError(ctx, operation, compatibilityIssue),
		);
		return;
	}
	try {
		toWire(expression, {
			target: "xform",
			types: typeContext,
			...(typeContext.form === undefined
				? {}
				: {
						form: formNodeProjection(ctx.doc, typeContext.form, {
							surface: "wire",
						}),
					}),
			bindings: {
				datumId: (ref) => operationDatumId(ctx)(ref),
				formFields: identityBindings(typeContext.form?.fields.keys() ?? []),
				operationIds: identityBindings(typeContext.profile.operationIds),
				lookup: {
					naming: inertLookupWireNaming(),
					instanceScope: "xform",
				},
			},
		});
	} catch (error) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_EXPRESSION_TYPE",
				`An expression in case operation "${operation.id}" cannot run on device: ${errorMessage(error)}`,
			),
		);
	}
}

function onDeviceDateAddOperationError(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	issue: OnDeviceDateAddIssue,
): ValidationError {
	const reason =
		issue.reason === "datetime-base"
			? "it starts from a date and time, and running it on the device would discard the time"
			: `it adds calendar-relative ${issue.expression.interval}, which the device cannot calculate faithfully`;
	return opError(
		ctx,
		operation,
		"CASE_OPERATION_EXPRESSION_TYPE",
		`An expression in case operation "${operation.id}" cannot run on device because ${reason}. Use a whole date with seconds, minutes, hours, days, or weeks, or rewrite the calculation.`,
		{
			reason: issue.reason,
			interval: issue.expression.interval,
		},
	);
}

function identityBindings(values: Iterable<Uuid>): ReadonlyMap<Uuid, WireExpr> {
	return new Map([...values].map((uuid) => [uuid, w.form([`__nova_${uuid}`])]));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validateOperationTerm(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	term: Term,
	insideLookup: boolean,
	errors: ValidationError[],
): void {
	if (term.kind !== "field") return;
	const field = ctx.fields.get(term.uuid);
	if (field === undefined) return;
	if (insideLookup) {
		validateLookupFilterFieldCorrelation(ctx, operation, field, errors);
		return;
	}

	const fieldRepeat = field.repeat;
	const operationRepeat = operation.forEach?.repeat;
	if (operationCanReadFormField(fieldRepeat, operationRepeat)) return;
	if (operationRepeat === undefined) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_AMBIGUOUS_REFERENCE",
				"A singular operation cannot read a field that has one value per repeat iteration.",
			),
		);
		return;
	}
	if (operationRepeat !== fieldRepeat) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_REPEAT_CORRELATION",
				"A repeated operation can read repeated fields only from the exact repeat it runs over.",
			),
		);
	}
}

function repeatPathIsPrefix(
	prefix: readonly Uuid[],
	value: readonly Uuid[],
): boolean {
	return (
		prefix.length <= value.length &&
		prefix.every((repeatUuid, index) => value[index] === repeatUuid)
	);
}

/**
 * A table lookup is resolved after the form is complete, so its row filter may
 * read a root answer or an answer correlated to the operation's current or an
 * enclosing repeat. This is deliberately narrower than changing ordinary
 * operation terms: the current case-operation wire can bind those safely only
 * from the exact repeat, while lookup execution owns its own row-filter
 * correlation boundary.
 */
function validateLookupFilterFieldCorrelation(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	field: OperationFieldContext,
	errors: ValidationError[],
): void {
	if (field.repeatPath.length === 0) return;
	const operationRepeat = operation.forEach?.repeat;
	if (operationRepeat === undefined) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_AMBIGUOUS_REFERENCE",
				"A singular operation cannot use a repeated form answer in a lookup-table filter.",
			),
		);
		return;
	}

	const operationRepeatPath = ctx.fields.get(operationRepeat)?.repeatPath;
	if (
		operationRepeatPath === undefined ||
		repeatPathIsPrefix(field.repeatPath, operationRepeatPath)
	) {
		return;
	}
	errors.push(
		opError(
			ctx,
			operation,
			"CASE_OPERATION_REPEAT_CORRELATION",
			"A lookup-table filter in a repeated operation may read root answers plus answers from the operation's current or an enclosing repeat, but not a child, sibling, or unrelated repeat.",
		),
	);
}

function validateCaseSnapshotUse(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	usesCaseSnapshot: boolean,
	errors: ValidationError[],
): void {
	if (ctx.sessionCaseAvailable || !usesCaseSnapshot) return;
	errors.push(
		opError(
			ctx,
			operation,
			"CASE_OPERATION_SESSION_UNAVAILABLE",
			"A case-property or relationship expression requires a case selected before this form opens.",
			{ reason: "case-read" satisfies SessionUnavailableReason },
		),
	);
}

function expressionUsesCaseSnapshot(
	expression: Expression,
	typeContext: ExpressionContext,
): boolean {
	let usesSnapshot = false;
	const root = activeRowScope(typeContext);
	walkExpression(expression, {
		visitTerm(term, path) {
			if (
				term.kind !== "prop" &&
				term.kind !== "owner-location-at-level" &&
				term.kind !== "case-row-type" &&
				term.kind !== "case-index"
			)
				return;
			if (
				activeRowScope(
					expressionContextAtPath(expression, typeContext, path),
				) === root
			)
				usesSnapshot = true;
		},
		visitRelation(_relation, path) {
			if (
				activeRowScope(
					expressionContextAtPath(expression, typeContext, path),
				) === root
			)
				usesSnapshot = true;
		},
	});
	return usesSnapshot;
}

function validateIdOfReference(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	opUuid: Uuid,
	typeContext: ExpressionContext,
	errors: ValidationError[],
): void {
	if (!typeContext.profile.operationIds.has(opUuid)) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_REFERENCE_ORDER",
				`Operation "${operation.id}" must derive ids only from an earlier create operation.`,
			),
		);
		return;
	}
	const producer = orderedCaseOperations(ctx.form).find(
		(candidate) =>
			candidate.uuid === opUuid &&
			(candidate.action === "create" ||
				(candidate.action === "own" && ctx.form.type === "registration")),
	);
	if (producer !== undefined)
		validateRepeatReference(ctx, operation, producer, errors);
}

function validateRepeatReference(
	ctx: OperationRuleContext,
	consumer: CaseOperation,
	producer: CaseOperation,
	errors: ValidationError[],
): void {
	const producerRepeat = producer.forEach?.repeat;
	const consumerRepeat = consumer.forEach?.repeat;
	if (producerRepeat === undefined) return;
	if (consumerRepeat === undefined) {
		errors.push(
			opError(
				ctx,
				consumer,
				"CASE_OPERATION_AMBIGUOUS_REFERENCE",
				`Singular operation "${consumer.id}" cannot refer to the many cases created by repeated operation "${producer.id}".`,
			),
		);
		return;
	}
	if (consumerRepeat !== producerRepeat) {
		errors.push(
			opError(
				ctx,
				consumer,
				"CASE_OPERATION_REPEAT_CORRELATION",
				`Operation "${consumer.id}" and create "${producer.id}" must run over the exact same repeat to correlate each iteration.`,
			),
		);
	}
}

function targetsOperationCase(
	formType: Form["type"],
	operation: CaseOperation,
	target: CaseTarget,
): boolean {
	const own = operationTarget(operation, formType);
	switch (own.kind) {
		case "new": {
			if (target.kind === "op") return target.opUuid === operation.uuid;
			// An idFrom field is only the raw key. The operation's concrete id is
			// Nova-namespaced by app/form/operation/type, so the field expression
			// itself is not an alias for this case.
			return false;
		}
		case "session":
		case "op":
		case "expression":
		case "worker-record":
			return (
				target.kind !== "new" && sameCaseOperationTargetIdentity(own, target)
			);
	}
}

function expressionContainsIdOf(expression: Expression): boolean {
	let found = false;
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "id-of") found = true;
	});
	return found;
}

function collectFormFields(
	doc: BlueprintDoc,
	formUuid: Uuid,
): OperationRuleContext["fields"] {
	const result = new Map<
		Uuid,
		{
			dataType: ReturnType<typeof caseDataTypeForFieldKind>;
			repeat: Uuid | undefined;
			repeatPath: readonly Uuid[];
			kind: string;
		}
	>();
	const walk = (parent: Uuid, repeatPath: readonly Uuid[]) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			const fieldRepeatPath =
				field.kind === "repeat" ? [...repeatPath, field.uuid] : repeatPath;
			result.set(uuid, {
				dataType: caseDataTypeForFieldKind(field.kind),
				repeat: fieldRepeatPath.at(-1),
				repeatPath: fieldRepeatPath,
				kind: field.kind,
			});
			walk(uuid, fieldRepeatPath);
		}
	};
	walk(formUuid, []);
	return result;
}

function opError(
	ctx: OperationRuleContext,
	operation: CaseOperation | undefined,
	code: Parameters<typeof validationError>[0],
	message: string,
	details?: Record<string, string>,
): ValidationError {
	return caseOperationError(
		code,
		message,
		{
			moduleUuid: ctx.moduleUuid,
			moduleName: ctx.module.name,
			formUuid: ctx.formUuid,
			formName: ctx.form.name,
		},
		operation,
		details,
	);
}

/** A finding located at a case operation: form-scoped, the operation's uuid
 * in `location.field`, its uuid and id in `details`. */
export function caseOperationError(
	code: Parameters<typeof validationError>[0],
	message: string,
	place: {
		readonly moduleUuid: Uuid;
		readonly moduleName: string;
		readonly formUuid: Uuid;
		readonly formName: string;
	},
	operation: CaseOperation | undefined,
	details?: Record<string, string>,
): ValidationError {
	return validationError(
		code,
		"form",
		message,
		{
			moduleUuid: place.moduleUuid,
			moduleName: place.moduleName,
			formUuid: place.formUuid,
			formName: place.formName,
			field: operation?.uuid,
		},
		operation === undefined
			? details
			: {
					operationUuid: operation.uuid,
					operationId: operation.id,
					...details,
				},
	);
}
