import {
	CASE_PROPERTY_REGEX,
	CASE_TYPE_REGEX,
	MAX_CASE_INDEX_IDENTIFIER_LENGTH,
	MAX_CASE_PROPERTY_LENGTH,
	MAX_CASE_TYPE_LENGTH,
	RESERVED_CASE_PROPERTIES,
	RESERVED_XFORM_NODE_PREFIX,
	XML_ELEMENT_NAME_REGEX,
} from "@/lib/commcare/constants";
import { emitOnDeviceExpression } from "@/lib/commcare/expression";
import { emitCaseListFilter } from "@/lib/commcare/predicate";
import {
	caseOperationTargetTypeOrderViolations,
	caseOperationWireOrderViolationDetails,
	sameCaseOperationTargetIdentity,
} from "@/lib/doc/caseOperationOrder";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	concreteCasePropertyWriterTypes,
	effectiveCaseTypes,
	type Form,
	isCaseFirstModule,
	MAX_CASE_OPERATION_TEXT_LENGTH,
	type Module,
	orderedCaseOperations,
	planCaseRetype,
	prepareCaseOperationTextValue,
	type Uuid,
} from "@/lib/domain";
import {
	checkPredicate,
	checkValueAssignmentExpression,
	checkValueExpression,
	type PredicateAstPath,
	type Term,
	type TypeContext,
	type ValueExpression,
	walkExpressionNodes,
	walkExpressionPredicateNodes,
	walkExpressionTerms,
	walkExpressionTermsWithPaths,
	walkPredicateExpressionNodes,
	walkPredicateNodes,
	walkTerms,
	walkTermsWithPaths,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../errors";
import {
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";

const RESERVED_OPERATION_CASE_TYPES: ReadonlySet<string> = new Set([
	"commcare-user",
	"commcare-case-claim",
	"user-owner-mapping-case",
]);

const RESERVED_OPERATION_PROPERTIES: ReadonlySet<string> = new Set([
	...RESERVED_CASE_PROPERTIES,
	"location_id",
	"hq_user_id",
	"external_id",
	"category",
	"state",
]);

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
	readonly caseFirst: boolean;
	readonly writerTypes: ReturnType<typeof concreteCasePropertyWriterTypes>;
	readonly lookupTables?: LookupTypeIndex;
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
	if (operations.length === 0) return [];

	const caseTypes = effectiveCaseTypes(doc);
	const fields = collectFormFields(doc, formUuid);
	const formTypes = (doc.formOrder[moduleUuid] ?? [])
		.map((uuid) => doc.forms[uuid]?.type)
		.filter((type): type is Form["type"] => type !== undefined);
	const ctx: OperationRuleContext = {
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
		caseFirst: isCaseFirstModule(formTypes, module.caseType !== undefined),
		writerTypes: concreteCasePropertyWriterTypes(doc),
		lookupTables,
	};
	const errors: ValidationError[] = [
		opError(
			ctx,
			operations[0],
			"CASE_OPERATIONS_NOT_ACTIVE",
			"Case operations are stored and wire-complete, but their atomic preview/runtime executor is not active yet.",
		),
	];

	const seenUuids = new Set<Uuid>();
	const seenIds = new Set<string>();
	const priorCreates = new Map<Uuid, CaseOperation>();
	for (const violation of caseOperationTargetTypeOrderViolations(
		doc,
		formUuid,
		operations,
	)) {
		const operation = operations.find(
			(candidate) => candidate.uuid === violation.operationUuid,
		);
		const targetLabel =
			violation.slot === "target"
				? "operation target"
				: violation.slot === "ordinary"
					? "ordinary form action's session target"
					: `link "${violation.slot.slice(5)}" target`;
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_TARGET_TYPE_MISMATCH",
				violation.kind === "known-identity"
					? `The ${targetLabel} is ${violation.actualType} at this point in the operation sequence, not ${violation.expectedType}.`
					: violation.kind === "repeat-alias"
						? `Repeated retype operation "${operation?.id ?? violation.operationUuid}" may address the same case in more than one iteration. After the first ${violation.actualType} transition, a later iteration could no longer consume it as ${violation.expectedType}; use a correlated generated create whose id is fresh per iteration.`
						: `The ${targetLabel} may resolve to the same concrete case as an earlier transition that leaves it as ${violation.actualType}, not ${violation.expectedType}. Use the same typed target reference, or a target Nova can prove is distinct.`,
			),
		);
	}
	const wireOrderViolations = new Map(
		caseOperationWireOrderViolationDetails(doc, formUuid, operations).map(
			(violation) => [violation.operationUuid, violation],
		),
	);
	for (const operation of operations) {
		const wireOrderViolation = wireOrderViolations.get(operation.uuid);
		if (wireOrderViolation !== undefined) {
			let message: string;
			switch (wireOrderViolation.kind) {
				case "multiplicity-scope":
					message = `Case operation "${operation.id}" crosses back to an earlier multiplicity scope, so CommCare's document-order executor cannot preserve the declared operation order.`;
					break;
				case "authored-create-after-noncreate":
					message = `Authored-key create operation "${operation.id}" follows a non-create effect. A retry can address an existing case, and HQ's per-case create sort would no longer match CommCare Core's document order.`;
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
		if (
			!XML_ELEMENT_NAME_REGEX.test(operation.id) ||
			operation.id.startsWith(RESERVED_XFORM_NODE_PREFIX)
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_INVALID_ID",
					`Case operation id "${operation.id}" must be an XML-safe slug outside Nova's reserved namespace.`,
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
		if (operation.action === "create") {
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
	validateFacets(ctx, operation, errors);
	validateCaseType(ctx, operation, operation.caseType, errors);
	if (operation.retype !== undefined) {
		validateCaseType(ctx, operation, operation.retype, errors);
		const producer =
			operation.target.kind === "op"
				? priorCreates.get(operation.target.opUuid)
				: undefined;
		if (
			producer?.target.kind === "new" &&
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
		const plan = planCaseRetype(
			ctx.doc,
			operation.caseType,
			operation.retype,
			new Set(
				(operation.writes ?? [])
					// A conditional write cannot prove a destination requirement:
					// its false branch would retype the case without the value.
					.filter((write) => write.condition === undefined)
					.map((write) => write.property),
			),
		);
		if (!plan.safe) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_RETYPE_UNSAFE",
					`Retyping ${operation.caseType} to ${operation.retype} cannot complete atomically; required destination values are missing: ${plan.missingRequired.join(", ") || "unknown schema"}.`,
				),
			);
		} else if (!plan.wirePortable) {
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
					`Retyping ${operation.caseType} to ${operation.retype} is not portable: ${consequences.join(" and ")}. CommCare's case wire changes only case_type, so Nova admits authored retypes only when every existing JSON property is retained with the exact same type.`,
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

	const typeContext = expressionContext(ctx, priorCreates);
	validateTarget(
		ctx,
		operation,
		operation.target,
		priorCreates,
		typeContext,
		errors,
	);
	if (
		operation.target.kind === "new" &&
		operation.target.idFrom !== undefined
	) {
		const field = ctx.fields.get(operation.target.idFrom);
		if (
			field === undefined ||
			(field.kind !== "hidden" &&
				(field.dataType === undefined ||
					(field.dataType !== "text" && field.dataType !== "single_select")))
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_TARGET_INVALID",
					"An authored create id must come from a scalar string-valued field in this form; a multi-select answer is an array in Nova and cannot be an identity key.",
				),
			);
		} else if (field.repeat !== repeat) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_REPEAT_CORRELATION",
					"An authored create id must be singular with a singular create, or come from the exact repeat the create runs over.",
				),
			);
		}
	}

	validatePredicateSlot(
		ctx,
		operation,
		operation.condition,
		typeContext,
		errors,
	);
	validateTextExpression(
		ctx,
		operation,
		operation.name,
		"create name",
		typeContext,
		errors,
	);
	validateTextExpression(
		ctx,
		operation,
		operation.owner,
		"owner",
		typeContext,
		errors,
	);
	validateTextExpression(
		ctx,
		operation,
		operation.rename,
		"rename",
		typeContext,
		errors,
	);

	const destination = operation.retype ?? operation.caseType;
	const effectiveProperties = new Map(
		(ctx.caseTypesByName.get(destination)?.properties ?? []).map((property) => [
			property.name,
			property,
		]),
	);
	const persistedProperties = new Map(
		(
			(ctx.doc.caseTypes ?? []).find(
				(caseType) => caseType.name === destination,
			)?.properties ?? []
		).map((property) => [property.name, property]),
	);
	const seenWrites = new Set<string>();
	for (const write of operation.writes ?? []) {
		if (
			!CASE_PROPERTY_REGEX.test(write.property) ||
			!XML_ELEMENT_NAME_REGEX.test(write.property) ||
			write.property.length > MAX_CASE_PROPERTY_LENGTH ||
			!persistedProperties.has(write.property)
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_UNKNOWN_PROPERTY",
					`Case property "${write.property}" is not declared on ${destination}.`,
				),
			);
		}
		if (RESERVED_OPERATION_PROPERTIES.has(write.property)) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_RESERVED_PROPERTY",
					`Case property "${write.property}" is reserved; use the operation's dedicated facet instead.`,
				),
			);
		}
		if (seenWrites.has(write.property)) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_INVALID_FACETS",
					`Case property "${write.property}" is written twice by one operation.`,
				),
			);
		}
		seenWrites.add(write.property);
		const expected = effectiveProperties.get(write.property)?.data_type;
		const writerTypes = ctx.writerTypes.get(destination)?.get(write.property);
		if ((writerTypes?.size ?? 0) > 1) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_EXPRESSION_TYPE",
					`Case property "${write.property}" on ${destination} has conflicting writer types: ${[...(writerTypes ?? [])].sort().join(", ")}.`,
				),
			);
		}
		const storageTypes = new Set<CasePropertyDataType>(writerTypes ?? []);
		if (expected !== undefined) storageTypes.add(expected);
		validateExpressionSlot(ctx, operation, write.value, typeContext, errors, {
			storageTypes: [...storageTypes],
		});
		validatePredicateSlot(ctx, operation, write.condition, typeContext, errors);
	}

	const linkIds = new Set<string>();
	for (const link of operation.links ?? []) {
		if (
			!XML_ELEMENT_NAME_REGEX.test(link.identifier) ||
			link.identifier.length > MAX_CASE_INDEX_IDENTIFIER_LENGTH ||
			link.identifier.startsWith(RESERVED_XFORM_NODE_PREFIX) ||
			linkIds.has(link.identifier)
		) {
			errors.push(
				opError(
					ctx,
					operation,
					"CASE_OPERATION_LINK_INVALID",
					`Link identifier "${link.identifier}" must be unique, XML-safe, and at most ${MAX_CASE_INDEX_IDENTIFIER_LENGTH} characters.`,
				),
			);
		}
		linkIds.add(link.identifier);
		validateCaseType(ctx, operation, link.targetType, errors);
		if (link.target !== null) {
			if (link.target.kind === "new") {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_LINK_INVALID",
						"A link target must be an existing/session/runtime case or an earlier create.",
					),
				);
			} else {
				validateTarget(
					ctx,
					operation,
					link.target,
					priorCreates,
					typeContext,
					errors,
				);
			}
			if (targetsOperationCase(operation, link.target)) {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_LINK_INVALID",
						"A case operation cannot link its case to itself.",
					),
				);
			}
		}
	}
}

function validateFacets(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	errors: ValidationError[],
): void {
	const invalid =
		operation.action === "create"
			? operation.target.kind !== "new" ||
				operation.name === undefined ||
				operation.rename !== undefined ||
				operation.retype !== undefined
			: operation.action === "update"
				? operation.target.kind === "new" || operation.name !== undefined
				: operation.target.kind === "new" ||
					operation.name !== undefined ||
					operation.owner !== undefined ||
					operation.rename !== undefined ||
					operation.retype !== undefined ||
					(operation.links?.length ?? 0) > 0;
	if (!invalid) return;
	errors.push(
		opError(
			ctx,
			operation,
			"CASE_OPERATION_INVALID_FACETS",
			`Case operation "${operation.id}" carries facets that are not legal for ${operation.action}.`,
		),
	);
}

function validateCaseType(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	caseType: string,
	errors: ValidationError[],
): void {
	if (
		!CASE_TYPE_REGEX.test(caseType) ||
		caseType.length > MAX_CASE_TYPE_LENGTH
	) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_INVALID_CASE_TYPE",
				`Case type "${caseType}" must start with a letter, contain only letters, digits, underscores, or hyphens, and be at most ${MAX_CASE_TYPE_LENGTH} characters.`,
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
	if (RESERVED_OPERATION_CASE_TYPES.has(caseType)) {
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
	target:
		| Exclude<CaseOperation["target"], { kind: "new" }>
		| CaseOperation["target"],
	priorCreates: ReadonlyMap<Uuid, CaseOperation>,
	typeContext: TypeContext,
	errors: ValidationError[],
): void {
	switch (target.kind) {
		case "new":
			return;
		case "session":
			if (!ctx.caseFirst) {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_SESSION_UNAVAILABLE",
						"The session target is available only when the module selects one case before opening its forms.",
					),
				);
			}
			return;
		case "expression":
			if (expressionContainsIdOf(target.expr)) {
				errors.push(
					opError(
						ctx,
						operation,
						"CASE_OPERATION_TARGET_INVALID",
						"This runtime target is already the known output of a create operation. Target that operation directly so type, order, and repeat correlation stay explicit.",
					),
				);
			}
			validateExpressionSlot(ctx, operation, target.expr, typeContext, errors, {
				storageTypes: ["text"],
			});
			return;
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

function validateExpressionSlot(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	expression: ValueExpression,
	typeContext: TypeContext,
	errors: ValidationError[],
	expectation: {
		readonly compatibleType?: CasePropertyDataType;
		readonly storageTypes?: readonly CasePropertyDataType[];
	} = {},
): void {
	const result =
		expectation.storageTypes === undefined
			? checkValueExpression(
					expression,
					typeContext,
					expectation.compatibleType,
				)
			: checkValueAssignmentExpression(
					expression,
					typeContext,
					expectation.storageTypes,
				);
	const typeErrors = semanticCheckErrors(result);
	if (typeErrors.length > 0) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_EXPRESSION_TYPE",
				`An expression in case operation "${operation.id}" is not valid here: ${typeErrors.map((error) => error.message).join("; ")}`,
			),
		);
	} else if (result.ok) {
		validateOnDeviceExpression(ctx, operation, expression, typeContext, errors);
	}
	validateCaseSnapshotUse(
		ctx,
		operation,
		expressionUsesCaseSnapshot(expression),
		errors,
	);
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "id-of") {
			validateIdOfReference(ctx, operation, node.opUuid, typeContext, errors);
		}
	});
	walkExpressionTermsWithPaths(expression, (term, path) => {
		validateOperationTerm(ctx, operation, term, path, errors);
	});
}

function validateTextExpression(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	expression: ValueExpression | undefined,
	facet: "create name" | "owner" | "rename",
	typeContext: TypeContext,
	errors: ValidationError[],
): void {
	if (expression === undefined) return;
	validateExpressionSlot(ctx, operation, expression, typeContext, errors, {
		storageTypes: ["text"],
	});
	if (
		expression.kind !== "term" ||
		expression.term.kind !== "literal" ||
		typeof expression.term.value !== "string"
	) {
		return;
	}
	const prepared = prepareCaseOperationTextValue(expression.term.value);
	if (prepared.ok) return;
	errors.push(
		opError(
			ctx,
			operation,
			"CASE_OPERATION_EXPRESSION_TYPE",
			prepared.reason === "blank"
				? `Case operation "${operation.id}" has a blank ${facet}. Names, renames, and explicit owners must contain a value after CommCare-compatible boundary whitespace is removed.`
				: `Case operation "${operation.id}" has a ${facet} longer than ${MAX_CASE_OPERATION_TEXT_LENGTH} UTF-16 code units after boundary whitespace is removed.`,
		),
	);
}

function validatePredicateSlot(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	predicate: CaseOperation["condition"],
	typeContext: TypeContext,
	errors: ValidationError[],
): void {
	if (predicate === undefined) return;
	const result = checkPredicate(predicate, typeContext);
	const typeErrors = semanticCheckErrors(result);
	if (typeErrors.length > 0) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_EXPRESSION_TYPE",
				`A condition in case operation "${operation.id}" is not valid here: ${typeErrors.map((error) => error.message).join("; ")}`,
			),
		);
	} else if (result.ok) {
		validateOnDevicePredicate(ctx, operation, predicate, typeContext, errors);
	}
	validateCaseSnapshotUse(
		ctx,
		operation,
		predicateUsesCaseSnapshot(predicate),
		errors,
	);
	walkPredicateExpressionNodes(predicate, (node) => {
		if (node.kind === "id-of") {
			validateIdOfReference(ctx, operation, node.opUuid, typeContext, errors);
		}
	});
	walkTermsWithPaths(predicate, (term, path) => {
		validateOperationTerm(ctx, operation, term, path, errors);
	});
}

/**
 * The operation checker is the pre-emission gate, so a schema-valid AST may
 * not survive validation and then trip one of the on-device emitter's
 * deliberate portability guards. Running the real emitter here with inert
 * identity bindings keeps this rule coupled to the exact dialect it protects
 * (calendar date-add, server-only functions, relation cardinality, and future
 * guarded arms) without duplicating that compatibility vocabulary.
 */
function validateOnDeviceExpression(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	expression: ValueExpression,
	typeContext: TypeContext,
	errors: ValidationError[],
): void {
	try {
		emitOnDeviceExpression(expression, "casedb", typeContext, undefined, {
			formFields: identityBindings(typeContext.formFields?.keys() ?? []),
			operationIds: identityBindings(typeContext.operationIds ?? []),
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

function validateOnDevicePredicate(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	predicate: NonNullable<CaseOperation["condition"]>,
	typeContext: TypeContext,
	errors: ValidationError[],
): void {
	try {
		emitCaseListFilter(predicate, "casedb", typeContext, undefined, {
			formFields: identityBindings(typeContext.formFields?.keys() ?? []),
			operationIds: identityBindings(typeContext.operationIds ?? []),
		});
	} catch (error) {
		errors.push(
			opError(
				ctx,
				operation,
				"CASE_OPERATION_EXPRESSION_TYPE",
				`A condition in case operation "${operation.id}" cannot run on device: ${errorMessage(error)}`,
			),
		);
	}
}

function identityBindings(values: Iterable<Uuid>): ReadonlyMap<Uuid, string> {
	return new Map([...values].map((uuid) => [uuid, `/data/__nova_${uuid}`]));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validateOperationTerm(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	term: Term,
	path: PredicateAstPath,
	errors: ValidationError[],
): void {
	if (term.kind !== "field") return;
	const field = ctx.fields.get(term.uuid);
	if (field === undefined) return;
	if (isInsideTableLookupWhere(path)) {
		validateLookupFilterFieldCorrelation(ctx, operation, field, errors);
		return;
	}

	const fieldRepeat = field.repeat;
	if (fieldRepeat === undefined) return;
	const operationRepeat = operation.forEach?.repeat;
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

function isInsideTableLookupWhere(path: PredicateAstPath): boolean {
	for (let index = 0; index + 1 < path.length; index++) {
		if (path[index] === "table-lookup" && path[index + 1] === "where") {
			return true;
		}
	}
	return false;
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
	if (ctx.caseFirst || !usesCaseSnapshot) return;
	errors.push(
		opError(
			ctx,
			operation,
			"CASE_OPERATION_SESSION_UNAVAILABLE",
			"A case-property or relationship expression requires a case selected before this form opens.",
		),
	);
}

function expressionUsesCaseSnapshot(expression: ValueExpression): boolean {
	let usesSnapshot = false;
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "prop") usesSnapshot = true;
	});
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "count") usesSnapshot = true;
	});
	walkExpressionPredicateNodes(expression, (node) => {
		if (node.kind === "exists" || node.kind === "missing") usesSnapshot = true;
	});
	return usesSnapshot;
}

function predicateUsesCaseSnapshot(
	predicate: NonNullable<CaseOperation["condition"]>,
): boolean {
	let usesSnapshot = false;
	walkTerms(predicate, (term) => {
		if (term.kind === "prop") usesSnapshot = true;
	});
	walkPredicateNodes(predicate, (node) => {
		if (node.kind === "exists" || node.kind === "missing") usesSnapshot = true;
	});
	walkPredicateExpressionNodes(predicate, (node) => {
		if (node.kind === "count") usesSnapshot = true;
	});
	return usesSnapshot;
}

function validateIdOfReference(
	ctx: OperationRuleContext,
	operation: CaseOperation,
	opUuid: Uuid,
	typeContext: TypeContext,
	errors: ValidationError[],
): void {
	if (!typeContext.operationIds?.has(opUuid)) {
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
		(candidate) => candidate.uuid === opUuid && candidate.action === "create",
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

function expressionContext(
	ctx: OperationRuleContext,
	priorCreates: ReadonlyMap<Uuid, CaseOperation>,
): TypeContext {
	return {
		caseTypes: [...ctx.caseTypes],
		knownInputs: [],
		currentCaseType: ctx.module.caseType,
		formFields: new Map(
			[...ctx.fields]
				.filter(
					([, field]) =>
						field.dataType !== undefined || field.kind === "hidden",
				)
				.map(([uuid, field]) => [uuid, field.dataType]),
		),
		operationIds: new Set(priorCreates.keys()),
		caseOperationValues: true,
		...(ctx.lookupTables !== undefined && {
			lookupTables: ctx.lookupTables,
		}),
	};
}

function targetsOperationCase(
	operation: CaseOperation,
	target: CaseOperation["target"],
): boolean {
	switch (operation.target.kind) {
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
			return (
				target.kind !== "new" &&
				sameCaseOperationTargetIdentity(operation.target, target)
			);
	}
}

function expressionContainsIdOf(expression: ValueExpression): boolean {
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
): ValidationError {
	return validationError(
		code,
		"form",
		message,
		{
			moduleUuid: ctx.moduleUuid,
			moduleName: ctx.module.name,
			formUuid: ctx.formUuid,
			formName: ctx.form.name,
			field: operation?.uuid,
		},
		operation === undefined
			? undefined
			: { operationUuid: operation.uuid, operationId: operation.id },
	);
}
