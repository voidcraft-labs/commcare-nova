import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import {
	AUTHORED_CASE_ID_VERSION,
	CASE_LOADING_FORM_TYPES,
	orderedCaseOperations,
} from "@/lib/domain";
import {
	type ValueExpression,
	walkExpressionNodes,
	walkPredicateExpressionNodes,
} from "@/lib/domain/predicate";
import { deepEqual } from "./deepEqual";
import { orderedFieldUuids } from "./fieldWalk";

type KnownTarget = Exclude<CaseOperation["target"], { kind: "new" }>;

interface TargetTypeState {
	readonly target: KnownTarget;
	caseType: string;
	/** Type this identity has in the immutable pre-submission casedb snapshot.
	 * Retypes advance `caseType` only; XForm target selectors must keep filtering
	 * on this original type because every calculate runs before effects apply. */
	readonly snapshotCaseType: string;
	/** Conditions that must have passed for this target to have `caseType`.
	 * A conditional create/retype establishes identity/type only on its true
	 * branch, so every later consumer of that fact inherits these guards. */
	guardUuids: Set<Uuid>;
}

interface TypeChangingTargetState {
	readonly target: KnownTarget;
	readonly caseType: string;
	readonly operationUuid: Uuid;
}

export interface CaseOperationTargetTypeOrderViolation {
	readonly operationUuid: Uuid;
	readonly slot: "target" | `link:${string}` | "ordinary";
	readonly expectedType: string;
	readonly actualType: string;
	readonly kind: "known-identity" | "possible-runtime-alias" | "repeat-alias";
}

export interface CaseOperationExpressionSnapshotTypes {
	/** Pre-submission type for the operation's runtime expression target. */
	readonly target?: string;
	/** Pre-submission types for runtime expression link targets by array slot. */
	readonly links: ReadonlyMap<number, string>;
}

/** Every earlier-create identity one operation consumes, whether through a
 * target/link or an `id-of` nested anywhere in its expressions/conditions. */
export function caseOperationDependencyUuids(
	operation: CaseOperation,
): ReadonlySet<Uuid> {
	const refs = new Set<Uuid>();
	if (operation.target.kind === "op") refs.add(operation.target.opUuid);
	for (const link of operation.links ?? []) {
		if (link.target?.kind === "op") refs.add(link.target.opUuid);
		if (link.target?.kind === "expression") {
			collectExpressionDependencies(link.target.expr, refs);
		}
	}
	if (operation.target.kind === "expression") {
		collectExpressionDependencies(operation.target.expr, refs);
	}
	for (const expression of [
		operation.name,
		operation.owner,
		operation.rename,
	]) {
		if (expression !== undefined)
			collectExpressionDependencies(expression, refs);
	}
	for (const write of operation.writes ?? []) {
		collectExpressionDependencies(write.value, refs);
		if (write.condition !== undefined) {
			collectPredicateDependencies(write.condition, refs);
		}
	}
	if (operation.condition !== undefined) {
		collectPredicateDependencies(operation.condition, refs);
	}
	return refs;
}

function collectExpressionDependencies(
	expression: ValueExpression,
	refs: Set<Uuid>,
): void {
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "id-of") refs.add(node.opUuid);
	});
}

function collectPredicateDependencies(
	predicate: NonNullable<CaseOperation["condition"]>,
	refs: Set<Uuid>,
): void {
	walkPredicateExpressionNodes(predicate, (node) => {
		if (node.kind === "id-of") refs.add(node.opUuid);
	});
}

/**
 * Multiplicity scopes in the order JavaRosa encounters their case-operation
 * groups in the submitted primary instance.
 *
 * The singular `/data/__nova_operations` group is prepended to the form data.
 * A repeated group is appended to the exact repeat iteration template after
 * that template's authored children. The resulting traversal is therefore
 * root first, then repeat scopes in post-order field traversal. This derived
 * order is shared by validation and move planning so the authored fractional
 * order can never promise a sequence the wire tree cannot represent.
 */
export function caseOperationMultiplicityScopes(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Array<Uuid | undefined> {
	const scopes: Array<Uuid | undefined> = [undefined];
	const walk = (parentUuid: Uuid): void => {
		for (const uuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			walk(uuid);
			if (field.kind === "repeat") scopes.push(uuid);
		}
	};
	walk(formUuid);
	return scopes;
}

/**
 * Reasons authored operation order cannot have one HQ/Core meaning: moving
 * backwards across physical multiplicity scopes, placing a possibly-existing
 * authored-key create after non-create work, or combining a repeated authored
 * create with a possibly-aliasing later effect under one repeated execution
 * ancestor. A missing scope belongs to an already-invalid legacy document and
 * is reported by the repeat-reference rule instead.
 */
export type CaseOperationWireOrderViolation =
	| {
			readonly operationUuid: Uuid;
			readonly kind: "multiplicity-scope" | "authored-create-after-noncreate";
	  }
	| {
			readonly operationUuid: Uuid;
			readonly kind: "repeated-authored-key-alias";
			readonly producerUuid: Uuid;
	  };

export function caseOperationWireOrderViolations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operations: readonly CaseOperation[] = orderedCaseOperations(
		doc.forms[formUuid] ?? {},
	),
): Uuid[] {
	return [
		...new Set(
			caseOperationWireOrderViolationDetails(doc, formUuid, operations).map(
				(violation) => violation.operationUuid,
			),
		),
	];
}

export function caseOperationWireOrderViolationDetails(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operations: readonly CaseOperation[] = orderedCaseOperations(
		doc.forms[formUuid] ?? {},
	),
): CaseOperationWireOrderViolation[] {
	const scopeRank = new Map(
		caseOperationMultiplicityScopes(doc, formUuid).map((scope, index) => [
			scope,
			index,
		]),
	);
	const repeatedAncestors = repeatedOperationScopeAncestors(doc, formUuid);
	const createsByUuid = new Map<Uuid, CaseOperation>();
	const repeatedAuthoredCreates: CaseOperation[] = [];
	let furthestRank = -1;
	let sawNonCreate = false;
	const broken: CaseOperationWireOrderViolation[] = [];
	for (const operation of operations) {
		const rank = scopeRank.get(operation.forEach?.repeat);
		if (rank !== undefined) {
			if (rank < furthestRank) {
				broken.push({
					operationUuid: operation.uuid,
					kind: "multiplicity-scope",
				});
			} else furthestRank = rank;
		}
		// HQ sorts blocks for one case create-first while Core follows document
		// order. A generated uuid is fresh, but a namespaced authored key is a
		// deterministic upsert identity and may already exist from an earlier
		// submission; therefore its create cannot appear after a non-create block
		// whose runtime id might resolve to that same case.
		if (
			operation.action === "create" &&
			operation.target.kind === "new" &&
			operation.target.idFrom !== undefined &&
			sawNonCreate
		) {
			broken.push({
				operationUuid: operation.uuid,
				kind: "authored-create-after-noncreate",
			});
		}
		if (operation.action !== "create") {
			sawNonCreate = true;
			if (operation.target.kind !== "new") {
				for (const producer of repeatedAuthoredCreates) {
					if (
						!operationScopesShareRepeatedExecutionAncestor(
							repeatedAncestors,
							producer.forEach?.repeat,
							operation.forEach?.repeat,
						) ||
						caseOperationTargetsProvablyDistinct(
							{ kind: "op", opUuid: producer.uuid },
							operation.target,
							createsByUuid,
						)
					) {
						continue;
					}
					// Core walks submitted repeat instances in iteration-major order,
					// while HQ groups blocks by concrete case id and stable-sorts every
					// create before non-create effects. Duplicate authored keys make
					// C1,U1,C2,U2 one case and HQ turns that into C1,C2,U1,U2. If
					// producer and consumer share any repeated execution ancestor,
					// Nova cannot promise the two processors the same result.
					broken.push({
						operationUuid: operation.uuid,
						kind: "repeated-authored-key-alias",
						producerUuid: producer.uuid,
					});
				}
			}
		} else {
			createsByUuid.set(operation.uuid, operation);
			if (
				operation.target.kind === "new" &&
				operation.target.idFrom !== undefined &&
				operation.forEach !== undefined
			) {
				repeatedAuthoredCreates.push(operation);
			}
		}
	}
	return [
		...new Map(
			broken.map((violation) => [
				`${violation.operationUuid}:${violation.kind}${violation.kind === "repeated-authored-key-alias" ? `:${violation.producerUuid}` : ""}`,
				violation,
			]),
		).values(),
	];
}

/** Repeat scopes whose runtime iterations enclose each operation scope,
 * including the scope itself. Two operation definitions that share one of
 * these ancestors execute once per common-ancestor iteration rather than as
 * two globally contiguous definition-level batches. */
function repeatedOperationScopeAncestors(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlyMap<Uuid, ReadonlySet<Uuid>> {
	const result = new Map<Uuid, ReadonlySet<Uuid>>();
	const walk = (parentUuid: Uuid, ancestors: readonly Uuid[]): void => {
		for (const uuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			const nextAncestors =
				field.kind === "repeat" ? [...ancestors, uuid] : ancestors;
			if (field.kind === "repeat") {
				result.set(uuid, new Set(nextAncestors));
			}
			if (doc.fieldOrder[uuid] !== undefined) walk(uuid, nextAncestors);
		}
	};
	walk(formUuid, []);
	return result;
}

function operationScopesShareRepeatedExecutionAncestor(
	ancestorsByScope: ReadonlyMap<Uuid, ReadonlySet<Uuid>>,
	left: Uuid | undefined,
	right: Uuid | undefined,
): boolean {
	if (left === undefined || right === undefined) return false;
	const leftAncestors = ancestorsByScope.get(left);
	const rightAncestors = ancestorsByScope.get(right);
	if (leftAncestors === undefined || rightAncestors === undefined) return false;
	for (const ancestor of leftAncestors) {
		if (rightAncestors.has(ancestor)) return true;
	}
	return false;
}

/**
 * Static target-type transitions for identities Nova can prove are the same.
 *
 * Multiple operations may intentionally address one case. A retype changes the
 * type expected by every later operation/link on that same operation-created,
 * session, or structurally-identical expression target. This pass is shared by
 * mutation planning so removing/reordering the retype cannot strand a later
 * consumer even though that dependency is semantic rather than an `id-of` UUID
 * edge. Dynamic expressions that are not structurally identical remain runtime
 * descriptor checks.
 */
export function caseOperationTargetTypeOrderViolations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operations: readonly CaseOperation[] = orderedCaseOperations(
		doc.forms[formUuid] ?? {},
	),
): CaseOperationTargetTypeOrderViolation[] {
	return analyzeCaseOperationTargetOrder(doc, formUuid, operations).violations;
}

/**
 * Conditions inherited by each operation from conditional creates/retypes it
 * consumes. The XForm emitter AND the later preview/runtime executor must apply
 * these predicates with the operation's own condition. Otherwise a skipped
 * producer would leave a consumer running against a missing identity or the
 * pre-retype case type.
 */
export function caseOperationConditionalGuardUuids(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operations: readonly CaseOperation[] = orderedCaseOperations(
		doc.forms[formUuid] ?? {},
	),
): ReadonlyMap<Uuid, ReadonlySet<Uuid>> {
	return analyzeCaseOperationTargetOrder(doc, formUuid, operations).guards;
}

/**
 * Runtime expression targets are authorized against the one pre-submission
 * case snapshot, even after an earlier operation has semantically retyped the
 * same identity. This projection keeps the snapshot lookup type separate from
 * the rolling type asserted by `caseOperationTargetTypeOrderViolations`.
 */
export function caseOperationExpressionSnapshotTypes(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operations: readonly CaseOperation[] = orderedCaseOperations(
		doc.forms[formUuid] ?? {},
	),
): ReadonlyMap<Uuid, CaseOperationExpressionSnapshotTypes> {
	return analyzeCaseOperationTargetOrder(doc, formUuid, operations)
		.expressionSnapshotTypes;
}

function analyzeCaseOperationTargetOrder(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operations: readonly CaseOperation[],
): {
	readonly violations: CaseOperationTargetTypeOrderViolation[];
	readonly guards: ReadonlyMap<Uuid, ReadonlySet<Uuid>>;
	readonly expressionSnapshotTypes: ReadonlyMap<
		Uuid,
		CaseOperationExpressionSnapshotTypes
	>;
} {
	const state: TargetTypeState[] = [];
	const typeChangingTargets: TypeChangingTargetState[] = [];
	const createsByUuid = new Map<Uuid, CaseOperation>();
	const moduleCaseType = moduleCaseTypeForForm(doc, formUuid);
	if (moduleCaseType !== undefined) {
		state.push({
			target: { kind: "session" },
			caseType: moduleCaseType,
			snapshotCaseType: moduleCaseType,
			guardUuids: new Set(),
		});
	}
	const violations: CaseOperationTargetTypeOrderViolation[] = [];
	const guards = new Map<Uuid, ReadonlySet<Uuid>>();
	const expressionSnapshotTypes = new Map<
		Uuid,
		CaseOperationExpressionSnapshotTypes
	>();

	const assertType = (
		operationUuid: Uuid,
		slot: CaseOperationTargetTypeOrderViolation["slot"],
		target: KnownTarget,
		expectedType: string,
		requiredGuards: Set<Uuid>,
	): TargetTypeState | undefined => {
		let known = findTargetState(state, target);
		if (known === undefined) {
			// The first expression-target assertion is authorized later from the
			// server-owned descriptor. Remember it so an exact later expression
			// participates in deterministic retype ordering.
			if (target.kind === "expression") {
				known = {
					target,
					caseType: expectedType,
					snapshotCaseType: expectedType,
					guardUuids: new Set(),
				};
				state.push(known);
			}
		}
		if (known !== undefined && known.caseType !== expectedType) {
			violations.push({
				operationUuid,
				slot,
				expectedType,
				actualType: known.caseType,
				kind: "known-identity",
			});
		} else if (known !== undefined) {
			for (const guardUuid of known.guardUuids) requiredGuards.add(guardUuid);
		}

		// Two different runtime expressions (or an expression and the session
		// case) can still resolve to one concrete id. The immutable casedb type
		// filter cannot see an earlier retype: it would happily resolve the old
		// snapshot row and Core would apply this operation to the new rolling
		// type. Unless identities are statically equal or provably distinct, any
		// differing post-transition type is therefore a soundness violation.
		const possibleAliasTypes = new Set(
			typeChangingTargets
				.filter(
					(change) =>
						!sameCaseOperationTargetIdentity(change.target, target) &&
						!caseOperationTargetsProvablyDistinct(
							change.target,
							target,
							createsByUuid,
						) &&
						change.caseType !== expectedType,
				)
				.map((change) => change.caseType),
		);
		for (const possibleAliasType of possibleAliasTypes) {
			violations.push({
				operationUuid,
				slot,
				expectedType,
				actualType: possibleAliasType,
				kind: "possible-runtime-alias",
			});
		}
		return known;
	};

	for (const operation of operations) {
		const requiredGuards = new Set<Uuid>();
		let expressionTargetSnapshotType: string | undefined;
		const expressionLinkSnapshotTypes = new Map<number, string>();
		for (const dependency of caseOperationDependencyUuids(operation)) {
			const producer = findTargetState(state, {
				kind: "op",
				opUuid: dependency,
			});
			for (const guardUuid of producer?.guardUuids ?? []) {
				requiredGuards.add(guardUuid);
			}
		}

		if (operation.action !== "create" && operation.target.kind !== "new") {
			const known = assertType(
				operation.uuid,
				"target",
				operation.target,
				operation.caseType,
				requiredGuards,
			);
			if (operation.target.kind === "expression") {
				expressionTargetSnapshotType = known?.snapshotCaseType;
			}
		}

		for (const [linkIndex, link] of (operation.links ?? []).entries()) {
			if (link.target === null || link.target.kind === "new") continue;
			const known = assertType(
				operation.uuid,
				`link:${link.identifier}`,
				link.target,
				link.targetType,
				requiredGuards,
			);
			if (link.target.kind === "expression" && known !== undefined) {
				expressionLinkSnapshotTypes.set(linkIndex, known.snapshotCaseType);
			}
		}
		guards.set(operation.uuid, requiredGuards);
		expressionSnapshotTypes.set(operation.uuid, {
			...(expressionTargetSnapshotType === undefined
				? {}
				: { target: expressionTargetSnapshotType }),
			links: expressionLinkSnapshotTypes,
		});

		// Establish effects only after every target/link assertion has added its
		// inherited guards. The operation wrapper is one atomic unit, so a guard
		// needed by a link also guards the created identity or retype result.
		const outputGuards = new Set(requiredGuards);
		if (operation.condition !== undefined) outputGuards.add(operation.uuid);
		if (operation.action === "create") {
			createsByUuid.set(operation.uuid, operation);
			rememberTargetState(
				state,
				{ kind: "op", opUuid: operation.uuid },
				operation.caseType,
				outputGuards,
			);
			rememberTypeChangingTarget(
				typeChangingTargets,
				{ kind: "op", opUuid: operation.uuid },
				operation.caseType,
				operation.uuid,
			);
		} else if (
			operation.target.kind !== "new" &&
			operation.retype !== undefined
		) {
			if (
				operation.retype !== operation.caseType &&
				operation.forEach !== undefined &&
				!repeatedRetypeTargetsFreshCorrelatedCase(operation, createsByUuid)
			) {
				violations.push({
					operationUuid: operation.uuid,
					slot: "target",
					expectedType: operation.caseType,
					actualType: operation.retype,
					kind: "repeat-alias",
				});
			}
			rememberTargetState(
				state,
				operation.target,
				operation.retype,
				outputGuards,
			);
			rememberTypeChangingTarget(
				typeChangingTargets,
				operation.target,
				operation.retype,
				operation.uuid,
			);
		}
	}

	// Advanced blocks execute before the form's ordinary primary update and
	// subcase blocks. Those legacy actions still consume the loaded session
	// case as the module's declared type: a primary field writes to it, while a
	// subcase's parent index names that type. Treat that final implicit consumer
	// as part of the same rolling proof, otherwise an advanced retype can make
	// the later ordinary block apply patient-shaped wire to a visit case. A
	// close-only action is deliberately absent here because close is type-blind.
	if (
		moduleCaseType !== undefined &&
		ordinaryFormActionsRequireSessionType(doc, formUuid, moduleCaseType)
	) {
		const sessionTarget: KnownTarget = { kind: "session" };
		for (const change of typeChangingTargets) {
			if (change.caseType === moduleCaseType) continue;
			if (sameCaseOperationTargetIdentity(change.target, sessionTarget)) {
				violations.push({
					operationUuid: change.operationUuid,
					slot: "ordinary",
					expectedType: moduleCaseType,
					actualType: change.caseType,
					kind: "known-identity",
				});
			} else if (
				!caseOperationTargetsProvablyDistinct(
					change.target,
					sessionTarget,
					createsByUuid,
				)
			) {
				violations.push({
					operationUuid: change.operationUuid,
					slot: "ordinary",
					expectedType: moduleCaseType,
					actualType: change.caseType,
					kind: "possible-runtime-alias",
				});
			}
		}
	}
	return { violations, guards, expressionSnapshotTypes };
}

/**
 * Whether the ordinary FormActions emitted after advanced operations have a
 * type-sensitive reference to the form's loaded session case.
 *
 * Case-loading forms do so when they contain a primary property writer, or
 * when they create a child case whose parent index points back at the primary
 * case. `case_name` is not an ordinary update property on a follow-up/close
 * form. Preloads run before submission, and an otherwise write-free close
 * action only needs an id, so neither is a final type consumer.
 *
 * This intentionally speaks only Nova's field annotations. Reserved/media
 * mappings are independently invalid and filtered at the wire boundary; on a
 * valid document every mapping counted here becomes one of the two ordinary
 * effects above.
 */
export function ordinaryFormActionsRequireSessionType(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string,
): boolean {
	const form = doc.forms[formUuid];
	if (form === undefined || !CASE_LOADING_FORM_TYPES.has(form.type)) {
		return false;
	}
	const visit = (parentUuid: Uuid): boolean => {
		for (const fieldUuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[fieldUuid];
			if (field === undefined) continue;
			const casePropertyOn = (
				field as typeof field & { readonly case_property_on?: unknown }
			).case_property_on;
			if (
				typeof casePropertyOn === "string" &&
				casePropertyOn.length > 0 &&
				(casePropertyOn !== moduleCaseType || field.id !== "case_name")
			) {
				return true;
			}
			if (doc.fieldOrder[fieldUuid] !== undefined && visit(fieldUuid)) {
				return true;
			}
		}
		return false;
	};
	return visit(formUuid);
}

export function sameCaseOperationTargetIdentity(
	left: KnownTarget,
	right: KnownTarget,
): boolean {
	if (left.kind !== right.kind) {
		// `id-of(create)` is the expression spelling of the exact same
		// identity as an operation target. Validation rejects this alias in a
		// target slot so author intent stays typed, but identity-sensitive
		// safety (self-link/retype/remove/order) must still recognize it.
		if (left.kind === "op" && right.kind === "expression") {
			return isIdOf(right.expr, left.opUuid);
		}
		if (left.kind === "expression" && right.kind === "op") {
			return isIdOf(left.expr, right.opUuid);
		}
		return false;
	}
	switch (left.kind) {
		case "session":
			return true;
		case "op":
			return right.kind === "op" && left.opUuid === right.opUuid;
		case "expression":
			return right.kind === "expression" && deepEqual(left.expr, right.expr);
	}
}

function isIdOf(expression: ValueExpression, opUuid: Uuid): boolean {
	return expression.kind === "id-of" && expression.opUuid === opUuid;
}

function exactOperationTargetUuid(target: KnownTarget): Uuid | undefined {
	if (target.kind === "op") return target.opUuid;
	if (target.kind === "expression" && target.expr.kind === "id-of") {
		return target.expr.opUuid;
	}
	return undefined;
}

function staticExpressionCaseId(target: KnownTarget): string | undefined {
	if (
		target.kind === "expression" &&
		target.expr.kind === "term" &&
		target.expr.term.kind === "literal" &&
		typeof target.expr.term.value === "string"
	) {
		return target.expr.term.value;
	}
	return undefined;
}

/**
 * Identities that cannot alias without a UUID collision. Two operation-created
 * cases have distinct operation namespaces; a generated create is also fresh
 * relative to every pre-submission session/expression target. Authored-key
 * creates may be retries of an existing session/expression case, so only their
 * separation from a different operation UUID is provable.
 */
function caseOperationTargetsProvablyDistinct(
	left: KnownTarget,
	right: KnownTarget,
	createsByUuid: ReadonlyMap<Uuid, CaseOperation>,
): boolean {
	const leftOp = exactOperationTargetUuid(left);
	const rightOp = exactOperationTargetUuid(right);
	if (leftOp !== undefined && rightOp !== undefined) return leftOp !== rightOp;
	if (leftOp !== undefined && generatedCreate(createsByUuid.get(leftOp))) {
		return true;
	}
	if (rightOp !== undefined && generatedCreate(createsByUuid.get(rightOp))) {
		return true;
	}
	if (
		leftOp !== undefined &&
		authoredCreateCannotEqualExpression(createsByUuid.get(leftOp), right)
	) {
		return true;
	}
	if (
		rightOp !== undefined &&
		authoredCreateCannotEqualExpression(createsByUuid.get(rightOp), left)
	) {
		return true;
	}
	const leftLiteral = staticExpressionCaseId(left);
	const rightLiteral = staticExpressionCaseId(right);
	return (
		leftLiteral !== undefined &&
		rightLiteral !== undefined &&
		leftLiteral !== rightLiteral
	);
}

function authoredCreateCannotEqualExpression(
	operation: CaseOperation | undefined,
	target: KnownTarget,
): boolean {
	if (
		operation?.action !== "create" ||
		operation.target.kind !== "new" ||
		operation.target.idFrom === undefined ||
		target.kind !== "expression"
	) {
		return false;
	}
	if (
		target.expr.kind === "term" &&
		target.expr.term.kind === "field" &&
		target.expr.term.uuid === operation.target.idFrom
	) {
		// The field is the raw key; a nonempty fixed prefix makes equality with
		// the derived id impossible.
		return true;
	}
	const literal = staticExpressionCaseId(target);
	return (
		literal !== undefined && !literal.startsWith(`${AUTHORED_CASE_ID_VERSION}:`)
	);
}

function generatedCreate(operation: CaseOperation | undefined): boolean {
	return (
		operation?.action === "create" &&
		operation.target.kind === "new" &&
		operation.target.idFrom === undefined
	);
}

function repeatedRetypeTargetsFreshCorrelatedCase(
	operation: CaseOperation,
	createsByUuid: ReadonlyMap<Uuid, CaseOperation>,
): boolean {
	if (operation.forEach === undefined || operation.target.kind !== "op") {
		return false;
	}
	const producer = createsByUuid.get(operation.target.opUuid);
	return (
		generatedCreate(producer) &&
		producer?.forEach?.repeat === operation.forEach.repeat
	);
}

function findTargetState(
	state: readonly TargetTypeState[],
	target: KnownTarget,
): TargetTypeState | undefined {
	return state.find((entry) =>
		sameCaseOperationTargetIdentity(entry.target, target),
	);
}

function rememberTargetState(
	state: TargetTypeState[],
	target: KnownTarget,
	caseType: string,
	guardUuids: ReadonlySet<Uuid>,
): void {
	const existing = findTargetState(state, target);
	if (existing === undefined) {
		state.push({
			target,
			caseType,
			snapshotCaseType: caseType,
			guardUuids: new Set(guardUuids),
		});
	} else {
		existing.caseType = caseType;
		existing.guardUuids = new Set(guardUuids);
	}
}

function rememberTypeChangingTarget(
	state: TypeChangingTargetState[],
	target: KnownTarget,
	caseType: string,
	operationUuid: Uuid,
): void {
	// Keep every transition, not only the latest nominal type. A later
	// conditional restoration runs on a narrower branch than the transition it
	// restores: A: patient->visit followed by B: visit->patient still leaves a
	// visit on A && !B. Different runtime target ASTs and the final ordinary
	// FormActions cannot inherit enough guards to make that branch disappear,
	// so alias/final-consumer safety must conservatively see the full history.
	state.push({ target, caseType, operationUuid });
}

function moduleCaseTypeForForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
): string | undefined {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid)) return doc.modules[moduleUuid]?.caseType;
	}
	return undefined;
}
