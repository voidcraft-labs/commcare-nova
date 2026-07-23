/**
 * Rule: keep schema-valid server-only / multi-valued expressions out of scalar
 * module slots evaluated by CommCare Core on the device.
 *
 * Core has no `unwrap-list` XPath function. CCHQ does expose that function in
 * its server-side CSQL grammar, so advanced search predicates retain a native
 * CSQL `unwrap-list`; only a subtree that the CSQL emitter interpolates through
 * on-device XPath is rejected.
 *
 * Standalone scalar ValueExpression roots have one additional cardinality
 * rule: a subcase or direction-agnostic property read can return several case
 * values, while Core's scalar evaluator requires one. Authors use `count` for
 * an aggregate or move the read into a related-case predicate. Self and
 * ancestor reads stay valid. Predicate-rooted slots are not subject to this
 * check because the shared relation-scope normalizer lowers their related reads
 * into explicit quantifiers.
 *
 * The slot inventory lives in `moduleWireSlots.ts`; this rule visits every
 * calculated definition — latent ones included — so a later visibility or
 * input change cannot activate a runtime-failing expression.
 */

import { findOnDeviceScalarExpressionIssue } from "@/lib/commcare/expression/onDeviceCompatibility";
import {
	isValidStaticGeopointCenter,
	walkCsqlOnDeviceNodes,
} from "@/lib/commcare/predicate";
import {
	descendOnDeviceCaseAnchor,
	type OnDeviceCaseAnchor,
	onDeviceAnchorCaseId,
	ROOT_ON_DEVICE_CASE_ANCHOR,
} from "@/lib/commcare/predicate/relationPresenceEmitter";
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	type Predicate,
	type TypeContext,
	type ValueExpression,
	walkPredicateExpressionNodes,
	walkPredicateNodes,
} from "@/lib/domain/predicate";
import {
	canonicalizeRelationPath,
	normalizeRelationEvaluationScopes,
	RelationEvaluationScopeError,
} from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import { type ValidationError, validationError } from "../../errors";
import type { LookupTypeIndex } from "../../lookupTypeContext";
import {
	collectModuleWireSlotFindings,
	type ModuleWireSlotIdentity,
} from "./moduleWireSlots";
import { moduleTypeContext } from "./shared";

type UnwrapListExpression = Extract<ValueExpression, { kind: "unwrap-list" }>;
type ScalarIssue = NonNullable<
	ReturnType<typeof findOnDeviceScalarExpressionIssue>
>;
type RelationIssue =
	| {
			reason: "mixed-property-scopes" | "unrebasable-relation-scope";
			detail: string;
	  }
	| {
			reason: "nested-multi-case-count";
			relationKind: "subcase" | "any-relation";
	  }
	| {
			reason: "invalid-geopoint-center";
			value: string;
	  };
type OnDeviceIssue = ScalarIssue | RelationIssue;

export function onDeviceExpressionCompatibility(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const ctx = moduleTypeContext(mod, doc, lookupTables);

	return collectModuleWireSlotFindings(mod, moduleUuid, {
		calculatedColumns: "all-definitions",
		judgePredicate(predicate, slot) {
			return judgePredicateSlot(predicate, ctx, slot);
		},
		judgeCsqlPredicate(predicate, slot) {
			return judgeCsqlPredicateSlot(predicate, ctx, slot);
		},
		judgeExpression(expression, slot) {
			return judgeScalarExpressionSlot(expression, ctx, slot);
		},
	});
}

function judgePredicateSlot(
	predicate: Predicate,
	ctx: TypeContext,
	slot: ModuleWireSlotIdentity,
): ValidationError | undefined {
	const invalidCenter = firstInvalidLiteralGeopointCenter(predicate);
	if (invalidCenter !== undefined) {
		return buildError(slot, invalidCenter);
	}
	const offender = firstUnwrapListInPredicate(predicate);
	if (offender !== undefined) {
		return buildError(slot, { reason: "unwrap-list", expression: offender });
	}
	const issue = firstRelationIssueInPredicate(predicate, ctx);
	return issue === undefined ? undefined : buildError(slot, issue);
}

function judgeScalarExpressionSlot(
	expression: ValueExpression,
	ctx: TypeContext,
	slot: ModuleWireSlotIdentity,
): ValidationError | undefined {
	const issue = findOnDeviceScalarExpressionIssue(expression, ctx);
	if (issue !== undefined) {
		return buildError(slot, issue);
	}
	let invalidCenter: RelationIssue | undefined;
	walkPredicateCarriersInExpression(expression, (predicate) => {
		if (invalidCenter === undefined) {
			invalidCenter = firstInvalidLiteralGeopointCenter(predicate);
		}
	});
	if (invalidCenter !== undefined) {
		return buildError(slot, invalidCenter);
	}
	const relationIssue = firstRelationIssueInExpression(expression, ctx);
	return relationIssue === undefined
		? undefined
		: buildError(slot, relationIssue);
}

function judgeCsqlPredicateSlot(
	predicate: Predicate,
	ctx: TypeContext,
	slot: ModuleWireSlotIdentity,
): ValidationError | undefined {
	const invalidCenter = firstInvalidLiteralGeopointCenter(predicate);
	if (invalidCenter !== undefined) {
		return buildError(slot, invalidCenter);
	}
	const normalization = normalizeRelationScopes(predicate, ctx);
	if ("issue" in normalization) {
		return buildError(slot, normalization.issue);
	}
	let offender: UnwrapListExpression | undefined;
	let nestedCount: RelationIssue | undefined;
	walkCsqlOnDeviceNodes(normalization.predicate, {
		visitPredicate(node) {
			if (nestedCount === undefined) {
				nestedCount = firstNestedMultiCaseCountInPredicate(node, ctx);
			}
		},
		visitExpression(node) {
			if (offender === undefined && node.kind === "unwrap-list") {
				offender = node;
			}
			if (nestedCount === undefined) {
				nestedCount = firstNestedMultiCaseCountInExpression(node, ctx);
			}
		},
	});
	if (offender !== undefined) {
		return buildError(slot, { reason: "unwrap-list", expression: offender });
	}
	return nestedCount === undefined ? undefined : buildError(slot, nestedCount);
}

function firstUnwrapListInPredicate(
	predicate: Predicate,
): UnwrapListExpression | undefined {
	let offender: UnwrapListExpression | undefined;
	walkPredicateExpressionNodes(predicate, (node) => {
		if (offender === undefined && node.kind === "unwrap-list") {
			offender = node;
		}
	});
	return offender;
}

function firstInvalidLiteralGeopointCenter(
	predicate: Predicate,
): RelationIssue | undefined {
	let issue: RelationIssue | undefined;
	walkPredicateNodes(predicate, (node) => {
		if (issue !== undefined || node.kind !== "within-distance") return;
		const center = node.center;
		if (
			center.kind !== "term" ||
			center.term.kind !== "literal" ||
			typeof center.term.value !== "string" ||
			isValidStaticGeopointCenter(center.term.value)
		) {
			return;
		}
		issue = {
			reason: "invalid-geopoint-center",
			value: center.term.value,
		};
	});
	return issue;
}

function normalizeRelationScopes(
	predicate: Predicate,
	ctx: TypeContext,
):
	| { readonly predicate: Predicate }
	| {
			readonly issue: Extract<
				RelationIssue,
				{ reason: "mixed-property-scopes" | "unrebasable-relation-scope" }
			>;
	  } {
	try {
		return {
			predicate: normalizeRelationEvaluationScopes(predicate, ctx),
		};
	} catch (error) {
		if (!(error instanceof RelationEvaluationScopeError)) throw error;
		return {
			issue: { reason: error.reason, detail: error.message },
		};
	}
}

function firstRelationIssueInPredicate(
	predicate: Predicate,
	ctx: TypeContext,
): RelationIssue | undefined {
	const normalization = normalizeRelationScopes(predicate, ctx);
	if ("issue" in normalization) return normalization.issue;
	return firstNestedMultiCaseCountInPredicate(normalization.predicate, ctx);
}

function firstRelationIssueInExpression(
	expression: ValueExpression,
	ctx: TypeContext,
): RelationIssue | undefined {
	let scopeIssue: RelationIssue | undefined;
	walkPredicateCarriersInExpression(expression, (predicate) => {
		if (scopeIssue !== undefined) return;
		const normalization = normalizeRelationScopes(predicate, ctx);
		if ("issue" in normalization) scopeIssue = normalization.issue;
	});
	return scopeIssue ?? firstNestedMultiCaseCountInExpression(expression, ctx);
}

function walkPredicateCarriersInExpression(
	expression: ValueExpression,
	visit: (predicate: Predicate) => void,
): void {
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return;
		case "date-add":
			walkPredicateCarriersInExpression(expression.date, visit);
			walkPredicateCarriersInExpression(expression.quantity, visit);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			walkPredicateCarriersInExpression(expression.value, visit);
			return;
		case "format-date":
			walkPredicateCarriersInExpression(expression.date, visit);
			return;
		case "arith":
			walkPredicateCarriersInExpression(expression.left, visit);
			walkPredicateCarriersInExpression(expression.right, visit);
			return;
		case "concat":
			for (const part of expression.parts) {
				walkPredicateCarriersInExpression(part, visit);
			}
			return;
		case "coalesce":
			for (const value of expression.values) {
				walkPredicateCarriersInExpression(value, visit);
			}
			return;
		case "if":
			visit(expression.cond);
			walkPredicateCarriersInExpression(expression.then, visit);
			walkPredicateCarriersInExpression(expression.else, visit);
			return;
		case "switch":
			walkPredicateCarriersInExpression(expression.on, visit);
			for (const switchCase of expression.cases) {
				walkPredicateCarriersInExpression(switchCase.then, visit);
			}
			walkPredicateCarriersInExpression(expression.fallback, visit);
			return;
		case "count":
			if (expression.where !== undefined) visit(expression.where);
			return;
		case "table-lookup":
			visit(expression.where);
			return;
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`onDeviceExpressionCompatibility: unhandled expression ${String(_exhaustive)}`,
			);
		}
	}
}

function firstNestedMultiCaseCountInPredicate(
	predicate: Predicate,
	context: TypeContext,
	anchor: OnDeviceCaseAnchor = ROOT_ON_DEVICE_CASE_ANCHOR,
): RelationIssue | undefined {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
		case "multi-select-contains":
			return undefined;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return (
				firstNestedMultiCaseCountInExpression(
					predicate.left,
					context,
					anchor,
				) ??
				firstNestedMultiCaseCountInExpression(predicate.right, context, anchor)
			);
		case "in":
		case "is-null":
		case "is-blank":
			return firstNestedMultiCaseCountInExpression(
				predicate.left,
				context,
				anchor,
			);
		case "between":
			return (
				firstNestedMultiCaseCountInExpression(
					predicate.left,
					context,
					anchor,
				) ??
				(predicate.lower === undefined
					? undefined
					: firstNestedMultiCaseCountInExpression(
							predicate.lower,
							context,
							anchor,
						)) ??
				(predicate.upper === undefined
					? undefined
					: firstNestedMultiCaseCountInExpression(
							predicate.upper,
							context,
							anchor,
						))
			);
		case "match":
			return firstNestedMultiCaseCountInExpression(
				predicate.value,
				context,
				anchor,
			);
		case "within-distance":
			return firstNestedMultiCaseCountInExpression(
				predicate.center,
				context,
				anchor,
			);
		case "and":
		case "or":
			for (const clause of predicate.clauses) {
				const issue = firstNestedMultiCaseCountInPredicate(
					clause,
					context,
					anchor,
				);
				if (issue !== undefined) return issue;
			}
			return undefined;
		case "not":
		case "when-input-present":
			return firstNestedMultiCaseCountInPredicate(
				predicate.clause,
				context,
				anchor,
			);
		case "exists":
		case "missing": {
			const relation = canonicalizeRelationPath(predicate.via, context);
			const childContext =
				relation.destinationCaseType === undefined
					? context
					: {
							...context,
							currentCaseType: relation.destinationCaseType,
						};
			return predicate.where === undefined
				? undefined
				: firstNestedMultiCaseCountInPredicate(
						predicate.where,
						childContext,
						descendOnDeviceCaseAnchor(anchor, relation.via),
					);
		}
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`onDeviceExpressionCompatibility: unhandled predicate ${String(_exhaustive)}`,
			);
		}
	}
}

function firstNestedMultiCaseCountInExpression(
	expression: ValueExpression,
	context: TypeContext,
	anchor: OnDeviceCaseAnchor = ROOT_ON_DEVICE_CASE_ANCHOR,
): RelationIssue | undefined {
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return undefined;
		case "date-add":
			return (
				firstNestedMultiCaseCountInExpression(
					expression.date,
					context,
					anchor,
				) ??
				firstNestedMultiCaseCountInExpression(
					expression.quantity,
					context,
					anchor,
				)
			);
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			return firstNestedMultiCaseCountInExpression(
				expression.value,
				context,
				anchor,
			);
		case "format-date":
			return firstNestedMultiCaseCountInExpression(
				expression.date,
				context,
				anchor,
			);
		case "arith":
			return (
				firstNestedMultiCaseCountInExpression(
					expression.left,
					context,
					anchor,
				) ??
				firstNestedMultiCaseCountInExpression(expression.right, context, anchor)
			);
		case "concat":
			for (const part of expression.parts) {
				const issue = firstNestedMultiCaseCountInExpression(
					part,
					context,
					anchor,
				);
				if (issue !== undefined) return issue;
			}
			return undefined;
		case "coalesce":
			for (const value of expression.values) {
				const issue = firstNestedMultiCaseCountInExpression(
					value,
					context,
					anchor,
				);
				if (issue !== undefined) return issue;
			}
			return undefined;
		case "if":
			return (
				firstNestedMultiCaseCountInPredicate(
					expression.cond,
					context,
					anchor,
				) ??
				firstNestedMultiCaseCountInExpression(
					expression.then,
					context,
					anchor,
				) ??
				firstNestedMultiCaseCountInExpression(expression.else, context, anchor)
			);
		case "switch": {
			const onIssue = firstNestedMultiCaseCountInExpression(
				expression.on,
				context,
				anchor,
			);
			if (onIssue !== undefined) return onIssue;
			for (const switchCase of expression.cases) {
				const issue = firstNestedMultiCaseCountInExpression(
					switchCase.then,
					context,
					anchor,
				);
				if (issue !== undefined) return issue;
			}
			return firstNestedMultiCaseCountInExpression(
				expression.fallback,
				context,
				anchor,
			);
		}
		case "count": {
			const relation = canonicalizeRelationPath(expression.via, context);
			if (
				onDeviceAnchorCaseId(anchor) === undefined &&
				(relation.via.kind === "subcase" ||
					relation.via.kind === "any-relation")
			) {
				return {
					reason: "nested-multi-case-count",
					relationKind: relation.via.kind,
				};
			}
			const childContext =
				relation.destinationCaseType === undefined
					? context
					: {
							...context,
							currentCaseType: relation.destinationCaseType,
						};
			return expression.where === undefined
				? undefined
				: firstNestedMultiCaseCountInPredicate(
						expression.where,
						childContext,
						descendOnDeviceCaseAnchor(anchor, relation.via),
					);
		}
		case "table-lookup":
			return firstNestedMultiCaseCountInPredicate(
				expression.where,
				context,
				anchor,
			);
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`onDeviceExpressionCompatibility: unhandled expression ${String(_exhaustive)}`,
			);
		}
	}
}

/** One finding per authored slot provides one stable, actionable repair. */
function buildError(
	args: ModuleWireSlotIdentity,
	issue: OnDeviceIssue,
): ValidationError {
	const message = (() => {
		switch (issue.reason) {
			case "unwrap-list":
				return `Module "${args.mod.name}" turns stored list text into several values in ${args.slotLabel}, but that setting runs in an app screen that can only use one value. Replace it with a single-value calculation.`;
			case "table-lookup":
				return `Module "${args.mod.name}" uses a lookup-table expression in ${args.slotLabel}, but lookup execution is not active yet. Remove the lookup until lookup-table support is available.`;
			case "multi-valued-relation-read":
				return `Module "${args.mod.name}" reads case property "${issue.property.property}" through a relationship that can return several cases in ${args.slotLabel}, but that setting needs one value. Use an explicit related-case count or move the check into a related-case condition.`;
			case "mixed-property-scopes":
				return `Module "${args.mod.name}" compares information from different case rows inside one condition in ${args.slotLabel}. Keep each condition on one case, then combine the completed related-case conditions with All, Any, or Not.`;
			case "unrebasable-relation-scope":
				return `Module "${args.mod.name}" combines a related-case value with another related-case condition or count inside the same calculation in ${args.slotLabel}. Move the related-case condition outside the value calculation so each relationship has a clear case to evaluate.`;
			case "nested-multi-case-count":
				return `Module "${args.mod.name}" counts child cases from inside another related-case condition in ${args.slotLabel}. CommCare cannot keep the inner child count attached to the current related case. Move that count to its own top-level condition, or count an ancestor instead.`;
			case "invalid-geopoint-center":
				return `Module "${args.mod.name}" uses "${issue.value}" as a location in ${args.slotLabel}, but it is not a valid latitude and longitude. Enter coordinates such as "42.3601, -71.0589"; altitude and accuracy are optional.`;
			default: {
				const _exhaustive: never = issue;
				return String(_exhaustive);
			}
		}
	})();

	return validationError(
		"CASE_LIST_EXPRESSION_NOT_ON_DEVICE",
		"module",
		message,
		{ moduleUuid: args.moduleUuid, moduleName: args.mod.name },
		{
			reason: issue.reason,
			slot: args.slot,
			surface: args.surface,
			...(issue.reason === "multi-valued-relation-read"
				? {
						property: issue.property.property,
						caseType: issue.property.caseType,
						relationKind: issue.property.via?.kind,
					}
				: {}),
			...(issue.reason === "nested-multi-case-count"
				? { relationKind: issue.relationKind }
				: {}),
			...(issue.reason === "invalid-geopoint-center"
				? { value: issue.value }
				: {}),
			...(args.input !== undefined
				? {
						inputUuid: args.input.uuid,
						inputName: args.input.name,
						inputLabel: args.input.label,
					}
				: {}),
			...(args.column !== undefined
				? {
						columnUuid: args.column.uuid,
						columnLabel: args.column.label,
					}
				: {}),
		},
	);
}
