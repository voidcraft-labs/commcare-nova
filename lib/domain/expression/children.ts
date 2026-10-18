/** Every recursive edge in the expression vocabulary, with its stable authoring path. */
import {
	type CheckPath,
	type Expression,
	type FormStepFilter,
	isExpression,
	isRelationPath,
	type RelationPath,
	type Term,
} from "./types";
export type ExpressionNode = Expression | Term;
export type ExpressionChildRole =
	| { readonly kind: "operand"; readonly slot: string }
	| { readonly kind: "item"; readonly slot: string; readonly index: number }
	| {
			readonly kind: "switch-case";
			readonly index: number;
			readonly slot: "when" | "then";
	  }
	| {
			readonly kind: "form-step-filter";
			readonly step: FormStepFilter["step"];
			readonly filterIndex: number;
			readonly predicateIndex: number;
	  };
export type ExpressionChild =
	| {
			readonly kind: "expression";
			readonly value: Expression;
			readonly path: CheckPath;
			readonly role: ExpressionChildRole;
	  }
	| {
			readonly kind: "term";
			readonly value: Term;
			readonly path: CheckPath;
			readonly role: ExpressionChildRole;
	  }
	| {
			readonly kind: "relation";
			readonly value: RelationPath;
			readonly path: CheckPath;
			readonly role: ExpressionChildRole;
	  };
export function expressionChildPath(
	parentKind: ExpressionNode["kind"],
	role: ExpressionChildRole,
	parentPath: CheckPath = [],
): CheckPath {
	switch (role.kind) {
		case "form-step-filter":
			return [
				...parentPath,
				parentKind,
				"filters",
				role.filterIndex,
				"where",
				role.predicateIndex,
			];
		case "switch-case":
			return [...parentPath, "switch", "cases", role.index, role.slot];
		case "item":
			if (parentKind === "and" || parentKind === "or")
				return [...parentPath, parentKind, role.index];
			return [
				...parentPath,
				...(["call", "cases", "table-rows", "locations"].includes(parentKind)
					? [parentKind]
					: []),
				role.slot,
				role.index,
			];
		case "operand": {
			if (parentKind === "term" && role.slot === "term") return parentPath;
			const prefix = [
				"if",
				"switch",
				"count",
				"exists",
				"missing",
				"table-lookup",
				"not",
				"when-input-present",
				"project",
				"negate",
			].includes(parentKind)
				? [parentKind]
				: [];
			return [...parentPath, ...prefix, role.slot];
		}
	}
}
export function expressionChildren(
	node: ExpressionNode,
	path: CheckPath = [],
): readonly ExpressionChild[] {
	const result: ExpressionChild[] = [];
	const add = (
		value: Expression | Term | RelationPath | undefined,
		role: ExpressionChildRole,
	) => {
		if (value === undefined) return;
		const childPath = expressionChildPath(node.kind, role, path);
		if (isExpression(value))
			result.push({ kind: "expression", value, path: childPath, role });
		else if (isRelationPath(value))
			result.push({ kind: "relation", value, path: childPath, role });
		else result.push({ kind: "term", value, path: childPath, role });
	};
	const operand = (
		slot: string,
		value: Expression | Term | RelationPath | undefined,
	) => add(value, { kind: "operand", slot });
	const items = (slot: string, values: readonly (Expression | Term)[]) =>
		values.forEach((value, index) => {
			add(value, { kind: "item", slot, index });
		});
	switch (node.kind) {
		case "term":
			operand("term", node.term);
			break;
		case "prop":
			operand("via", node.via);
			break;
		case "field":
		case "form-node":
		case "repeat-row":
			node.filters?.forEach((filter, filterIndex) => {
				filter.where.forEach((value, predicateIndex) => {
					add(value, {
						kind: "form-step-filter",
						step: filter.step,
						filterIndex,
						predicateIndex,
					});
				});
			});
			break;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "arith":
			operand("left", node.left);
			operand("right", node.right);
			break;
		case "in":
			operand("left", node.left);
			items("values", node.values);
			break;
		case "within-distance":
			operand("property", node.property);
			operand("center", node.center);
			if (typeof node.distance !== "number") operand("distance", node.distance);
			if (typeof node.unit !== "string") operand("unit", node.unit);
			break;
		case "match":
			operand("property", node.property);
			operand("value", node.value);
			break;
		case "multi-select-contains":
			operand("property", node.property);
			items("values", node.values);
			break;
		case "is-blank":
			operand("left", node.left);
			break;
		case "matches-pattern":
			operand("left", node.left);
			if (typeof node.pattern !== "string") operand("pattern", node.pattern);
			break;
		case "between":
			operand("left", node.left);
			operand("lower", node.lower);
			operand("upper", node.upper);
			break;
		case "and":
		case "or":
			items("clauses", node.clauses);
			break;
		case "not":
			operand("clause", node.clause);
			break;
		case "when-input-present":
			operand("input", node.input);
			operand("clause", node.clause);
			break;
		case "exists":
		case "missing":
		case "count":
			operand("via", node.via);
			operand("where", node.where);
			break;
		case "table-lookup":
			operand("where", node.where);
			break;
		case "date-add":
			operand("date", node.date);
			operand("quantity", node.quantity);
			break;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "negate":
		case "choice-name":
			operand("value", node.value);
			break;
		case "format-date":
			operand("date", node.date);
			if (typeof node.pattern !== "string") operand("pattern", node.pattern);
			break;
		case "concat":
			items("parts", node.parts);
			break;
		case "coalesce":
			items("values", node.values);
			break;
		case "value-list":
			items("items", node.items);
			break;
		case "call":
			items("args", node.args);
			break;
		case "if":
			operand("cond", node.cond);
			operand("then", node.then);
			operand("else", node.else);
			break;
		case "switch":
			operand("on", node.on);
			node.cases.forEach((value, index) => {
				add(value.when, { kind: "switch-case", index, slot: "when" });
				add(value.then, { kind: "switch-case", index, slot: "then" });
			});
			operand("fallback", node.fallback);
			break;
		case "cases":
		case "table-rows":
		case "locations":
			items("where", node.where);
			break;
		case "project":
			operand("of", node.of);
			operand("value", node.value);
			break;
		case "match-all":
		case "match-none":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "itext":
		case "here":
		case "selected-cases":
		case "form-case":
		case "input":
		case "session-user":
		case "session-user-property":
		case "session-context":
		case "table-column":
		case "fixed-location":
		case "owner-location-at-level":
		case "literal":
		case "choice":
		case "case-type":
		case "case-row-type":
		case "case-index":
		case "session-datum":
		case "location-level":
		case "location-field":
			break;
		default: {
			const exhaustive: never = node;
			throw new Error(
				`Cannot walk unknown expression node ${String(exhaustive)}.`,
			);
		}
	}
	return result;
}
