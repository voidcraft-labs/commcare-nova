import type { RecordQueryContext } from "@/lib/domain/expression/context";
import { formatNumeric } from "@/lib/domain/expression/numberLiteral";
import {
	type Expression,
	isExpression,
	isRelationPath,
	type Literal,
	type RelationPath,
	type Term,
} from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import { quoteAuthoringLiteral as quote } from "./expressionSyntax";

export interface QueryPrintContext {
	typeContext: RecordQueryContext;
	forRelation(relation: RelationPath): QueryPrintContext;
	forTable(tableId: string): QueryPrintContext;
	reference(term: Term): string | undefined;
	choiceValues(
		field: Uuid,
		options: readonly Uuid[],
	): readonly string[] | undefined;
	name(
		kind: "table" | "column" | "operation" | "location" | "level",
		id: string,
		owner?: string,
	): string;
}

const comparisonOperators = {
	eq: "=",
	neq: "!=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};
const call = (name: string, ...args: string[]) => `${name}(${args.join(", ")})`;

const numeric = formatNumeric;
function literal(value: Literal): string {
	const content =
		typeof value.value === "string"
			? quote(value.value)
			: typeof value.value === "number"
				? numeric(value.value)
				: value.value === null
					? "null()"
					: `${value.value}()`;
	// Distinguish a literal containing both quote styles from a calculated concat.
	return value.data_type !== undefined
		? call("literal", content, quote(value.data_type))
		: content.startsWith("concat(")
			? call("literal", content)
			: content;
}
function relation(value: RelationPath): string {
	switch (value.kind) {
		case "self":
			return "self()";
		case "ancestor":
			return call(
				"ancestor",
				...value.via.map((step) =>
					step.throughCaseType === undefined
						? quote(step.identifier)
						: call("link", quote(step.identifier), quote(step.throughCaseType)),
				),
			);
		case "subcase":
		case "any-relation":
			return call(
				value.kind === "subcase" ? "children" : "related",
				value.ofCaseType === undefined
					? "unbounded()"
					: quote(value.ofCaseType),
				quote(value.identifier),
			);
	}
}

export function queryPrinter(context: QueryPrintContext) {
	const identity = (
		kind: Parameters<QueryPrintContext["name"]>[0],
		id: string,
		owner?: string,
	) => quote(context.name(kind, id, owner));
	function term(value: Term): string {
		const reference = context.reference(value);
		if (reference !== undefined) return reference;
		switch (value.kind) {
			case "literal":
				return literal(value);
			case "form-case":
				return `#${value.caseType}/${value.property}`;
			case "prop":
				if (value.caseType === undefined)
					throw new Error("This record property has no scoped record type.");
				return value.via === undefined
					? call("property", quote(value.caseType), quote(value.property))
					: call(
							"property",
							quote(value.caseType),
							quote(value.property),
							relation(value.via),
						);
			case "choice": {
				const values = context.choiceValues(value.field, value.options);
				if (values === undefined)
					throw new Error("A saved choice no longer belongs to its question.");
				return literal({ kind: "literal", value: values.join(" ") });
			}
			case "case-type":
				return quote(value.caseType);
			case "case-row-type":
				return "record-type()";
			case "input":
				return call("search", quote(value.searchInputUuid));
			case "field":
				return call("field", quote(value.uuid));
			case "session-user":
				return call("external-user", quote(value.field));
			case "session-user-property":
				return call("user", quote(value.userPropertyUuid));
			case "session-context":
				return call("session", quote(value.field));
			case "table-column":
				return call(
					"table-column",
					identity("table", value.tableId),
					identity("column", value.columnId, value.tableId),
				);
			case "fixed-location":
				return call("location", identity("location", value.locationUuid));
			case "owner-location-at-level":
				return call(
					"owner-location",
					identity("level", value.levelUuid),
					quote(value.ownerCaseType),
				);
			default:
				throw new Error(
					`The saved ${value.kind} reference has no record-dialect spelling.`,
				);
		}
	}
	function expression(value: Expression): string {
		switch (value.kind) {
			case "term":
				return term(value.term);
			case "today":
			case "now":
			case "here":
			case "acting-user":
			case "unowned":
				return call(value.kind);
			case "id-of":
				return call(value.kind, identity("operation", value.opUuid));
			case "table-lookup":
				return call(
					"lookup",
					identity("table", value.tableId),
					identity("column", value.resultColumnId, value.tableId),
					queryPrinter(context.forTable(value.tableId)).predicate(value.where),
				);
			case "date-add":
				return call(
					value.kind,
					expression(value.date),
					expression(value.quantity),
					quote(value.interval),
				);
			case "date-coerce":
				return call("date", expression(value.value));
			case "datetime-coerce":
				return call("datetime", expression(value.value));
			case "double":
				return call("number", expression(value.value));
			case "arith":
				return value.op === "quotient"
					? call("quotient", expression(value.left), expression(value.right))
					: `(${expression(value.left)} ${value.op} ${expression(value.right)})`;
			case "negate":
				return `-(${expression(value.value)})`;
			case "concat":
				return call(value.kind, ...value.parts.map(expression));
			case "coalesce":
				return call(value.kind, ...value.values.map(expression));
			case "if":
				return call(
					value.kind,
					predicate(value.cond),
					expression(value.then),
					expression(value.else),
				);
			case "switch":
				return call(
					value.kind,
					expression(value.on),
					...value.cases.flatMap((entry) => [
						term(entry.when),
						expression(entry.then),
					]),
					expression(value.fallback),
				);
			case "count":
				if (!isRelationPath(value.via))
					throw new Error("A record count needs a relationship.");
				return call(
					value.kind,
					relation(value.via),
					...(value.where === undefined
						? []
						: [
								queryPrinter(context.forRelation(value.via)).predicate(
									value.where,
								),
							]),
				);
			case "format-date":
				return call(
					value.kind,
					expression(value.date),
					typeof value.pattern === "string"
						? quote(value.pattern)
						: expression(value.pattern),
				);
			default:
				throw new Error(
					`The saved ${value.kind} tree has no record value spelling.`,
				);
		}
	}
	function predicate(value: Expression): string {
		switch (value.kind) {
			case "eq":
			case "neq":
			case "gt":
			case "gte":
			case "lt":
			case "lte":
				return `(${expression(value.left)} ${comparisonOperators[value.kind]} ${expression(value.right)})`;
			case "match-all":
				return "true()";
			case "match-none":
				return "false()";
			case "and":
			case "or":
				return call(
					value.kind === "and" ? "all" : "any",
					...value.clauses.map(predicate),
				);
			case "not":
				return call(value.kind, predicate(value.clause));
			case "in":
				return call(
					value.kind,
					expression(value.left),
					...value.values.map(term),
				);
			case "within-distance":
				return call(
					value.kind,
					term(value.property),
					expression(value.center),
					typeof value.distance === "number"
						? numeric(value.distance)
						: expression(value.distance),
					typeof value.unit === "string"
						? quote(value.unit)
						: expression(value.unit),
				);
			case "is-blank":
				return call(value.kind, expression(value.left));
			case "matches-pattern":
				return call(
					value.kind,
					expression(value.left),
					typeof value.pattern === "string"
						? quote(value.pattern)
						: expression(value.pattern),
				);
			case "between":
				return call(
					value.kind,
					expression(value.left),
					value.lower === undefined ? "unbounded()" : expression(value.lower),
					value.upper === undefined ? "unbounded()" : expression(value.upper),
					`${value.lowerInclusive}()`,
					`${value.upperInclusive}()`,
				);
			case "match":
				return call(
					value.mode,
					isExpression(value.property)
						? expression(value.property)
						: term(value.property),
					expression(value.value),
				);
			case "multi-select-contains":
				return call(
					value.quantifier === "any" ? "selected-any" : "selected-all",
					isExpression(value.property)
						? expression(value.property)
						: term(value.property),
					...value.values.map((value) =>
						isExpression(value) ? expression(value) : term(value),
					),
				);
			case "when-input-present":
				return call(
					"when-provided",
					term(value.input),
					predicate(value.clause),
				);
			case "exists":
			case "missing":
				return call(
					value.kind,
					relation(value.via),
					...(value.where === undefined
						? []
						: [
								queryPrinter(context.forRelation(value.via)).predicate(
									value.where,
								),
							]),
				);
			default:
				throw new Error(
					`The saved ${value.kind} tree has no record condition spelling.`,
				);
		}
	}
	return { value: expression, predicate, term, relationship: relation };
}
