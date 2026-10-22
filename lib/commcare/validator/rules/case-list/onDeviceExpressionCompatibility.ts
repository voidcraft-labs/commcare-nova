/** Target limitations over the exact slot context and canonical expression edges. */
import {
	findOnDeviceScalarExpressionIssue,
	walkOnDeviceExpression,
} from "@/lib/commcare/expression/onDeviceCompatibility";
import { walkCsqlOnDeviceNodes } from "@/lib/commcare/predicate/csqlRuntimeWalk";
import { isValidStaticGeopointCenter } from "@/lib/commcare/predicate/geopoint";
import {
	descendOnDeviceCaseAnchor,
	type OnDeviceCaseAnchor,
	onDeviceAnchorCaseId,
	ROOT_ON_DEVICE_CASE_ANCHOR,
} from "@/lib/commcare/xpath/wire/rowScope";
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	type Expression,
	type ExpressionContext,
	type ExpressionNode,
	expressionChildContext,
	expressionChildren,
	isRelationPath,
	slotContext,
	walkExpressionNodes,
} from "@/lib/domain/expression";
import {
	canonicalizeRelationPath,
	normalizeRelationEvaluationScopes,
	RelationEvaluationScopeError,
} from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import { type ValidationError, validationError } from "../../errors";
import type { LookupTypeIndex } from "../../lookupTypeContext";
import {
	collectModuleWireSlotFindings,
	type ModuleWireSlotIdentity,
} from "./moduleWireSlots";
import { relationEvaluationContext } from "./shared";

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
	| { reason: "invalid-geopoint-center"; value: string }
	| { reason: "lookup-row-escaped-column" };
type OnDeviceIssue = ScalarIssue | RelationIssue;

export function onDeviceExpressionCompatibility(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const judge = (
		expression: Expression,
		slot: ModuleWireSlotIdentity,
		mode: "condition" | "value" | "csql",
	) => {
		const ctx = slotContext(doc, slot.ref, lookupTables ?? new Map());
		if (ctx === undefined) return undefined;
		const issue = findSlotIssue(expression, ctx, mode);
		return issue === undefined ? undefined : buildError(slot, issue);
	};
	return collectModuleWireSlotFindings(mod, moduleUuid, {
		judgePredicate: (expression, slot) => judge(expression, slot, "condition"),
		judgeCsqlPredicate: (expression, slot) => judge(expression, slot, "csql"),
		judgeExpression: (expression, slot) => judge(expression, slot, "value"),
	});
}
function findSlotIssue(
	expression: Expression,
	ctx: ExpressionContext,
	mode: "condition" | "value" | "csql",
): OnDeviceIssue | undefined {
	try {
		if (mode === "value") {
			const scalar = findOnDeviceScalarExpressionIssue(expression, ctx);
			if (scalar !== undefined) return scalar;
		}
		let invalidCenter: RelationIssue | undefined;
		walkExpressionNodes(expression, (node) => {
			if (invalidCenter !== undefined || node.kind !== "within-distance")
				return;
			const center = node.center;
			if (
				center.kind === "term" &&
				center.term.kind === "literal" &&
				typeof center.term.value === "string" &&
				!isValidStaticGeopointCenter(center.term.value)
			)
				invalidCenter = {
					reason: "invalid-geopoint-center",
					value: center.term.value,
				};
		});
		if (invalidCenter !== undefined) return invalidCenter;
		const normalized = normalizeRelationEvaluationScopes(
			expression,
			relationEvaluationContext(ctx),
		);
		if (mode === "csql") {
			let issue: RelationIssue | undefined;
			walkCsqlOnDeviceNodes(normalized, ctx, {
				visitExpression: (node, lexicalContext) => {
					issue ??= nestedMultiCaseCount(node, lexicalContext);
				},
			});
			return issue;
		}
		let lookupIssue: RelationIssue | undefined;
		walkOnDeviceExpression(normalized, ctx, (node, lexicalContext) => {
			if (lookupIssue !== undefined || node.kind !== "table-lookup") return;
			// The lookup's captured case is preserved while its columns remain row-local.
			const where = expressionChildren(node).find(
				(child) => child.role.kind === "operand" && child.role.slot === "where",
			);
			if (where?.kind !== "expression") return;
			lookupIssue = escapedLookupColumn(
				where.value,
				expressionChildContext(node, where, lexicalContext),
			);
		});
		return lookupIssue ?? nestedMultiCaseCount(normalized, ctx);
	} catch (error) {
		if (!(error instanceof RelationEvaluationScopeError)) throw error;
		return { reason: error.reason, detail: error.message };
	}
}
/** A nested lookup binds its own fixture row; other child edges keep the read's identity. */
function readsThisTableColumn(node: ExpressionNode): boolean {
	if (node.kind === "table-column") return true;
	if (node.kind === "table-lookup" || node.kind === "table-rows") return false;
	return expressionChildren(node).some(
		(child) => child.kind !== "relation" && readsThisTableColumn(child.value),
	);
}
function escapedLookupColumn(
	expression: Expression,
	ctx: ExpressionContext,
): RelationIssue | undefined {
	const normalized = normalizeRelationEvaluationScopes(
		expression,
		relationEvaluationContext(ctx),
	);
	let escaped = false;
	walkExpressionNodes(normalized, (node) => {
		if (
			(node.kind === "exists" ||
				node.kind === "missing" ||
				(node.kind === "count" && isRelationPath(node.via))) &&
			node.where !== undefined &&
			readsThisTableColumn(node.where)
		)
			escaped = true;
	});
	return escaped ? { reason: "lookup-row-escaped-column" } : undefined;
}
function nestedMultiCaseCount(
	node: ExpressionNode,
	ctx: ExpressionContext,
	anchor: OnDeviceCaseAnchor = ROOT_ON_DEVICE_CASE_ANCHOR,
): RelationIssue | undefined {
	const relationNode =
		node.kind === "exists" ||
		node.kind === "missing" ||
		(node.kind === "count" && isRelationPath(node.via));
	let relationAnchor = anchor;
	if (relationNode) {
		const via = node.via;
		if (!isRelationPath(via))
			throw new Error("A relation node lost its relation path.");
		const relation = canonicalizeRelationPath(
			via,
			relationEvaluationContext(ctx),
		);
		if (
			node.kind === "count" &&
			onDeviceAnchorCaseId(anchor) === undefined &&
			(relation.via.kind === "subcase" || relation.via.kind === "any-relation")
		)
			return {
				reason: "nested-multi-case-count",
				relationKind: relation.via.kind,
			};
		relationAnchor = descendOnDeviceCaseAnchor(anchor, relation.via);
	}
	for (const child of expressionChildren(node)) {
		if (child.kind === "relation") continue;
		const childAnchor =
			relationNode &&
			child.role.kind === "operand" &&
			child.role.slot === "where"
				? relationAnchor
				: anchor;
		const issue = nestedMultiCaseCount(
			child.value,
			expressionChildContext(node, child, ctx),
			childAnchor,
		);
		if (issue !== undefined) return issue;
	}
	return undefined;
}

/** One finding per authored slot provides one stable, actionable repair. */
function buildError(
	args: ModuleWireSlotIdentity,
	issue: OnDeviceIssue,
): ValidationError {
	const message = (() => {
		switch (issue.reason) {
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
			case "lookup-row-escaped-column":
				return `Module "${args.mod.name}" compares a lookup column with a related case's information in ${args.slotLabel}. CommCare evaluates the related-case part away from the lookup row, so the lookup column cannot be read there. Compare the lookup column with the current case's own information, or check the related case in its own condition.`;
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
						...(issue.property.caseType === undefined
							? {}
							: { caseType: issue.property.caseType }),
						...(issue.property.via === undefined
							? {}
							: { relationKind: issue.property.via.kind }),
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
