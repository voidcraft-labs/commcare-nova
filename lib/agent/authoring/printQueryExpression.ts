import type {
	Literal,
	Predicate,
	RelationPath,
	Term,
	TypeContext,
	ValueExpression,
} from "@/lib/domain/predicate";
import { quoteAuthoringLiteral as quote } from "./expressionSyntax";
import { queryValueType } from "./queryExpressions";

export interface QueryPrintContext {
	typeContext: TypeContext;
	forRelation(relation: RelationPath): QueryPrintContext;
	forTable(tableId: string): QueryPrintContext;
	/** Prefer names from the same scoped view used to resolve authored input. */
	reference(term: Term): string | undefined;
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

/** XPath's number grammar has no exponent notation. */
function numeric(value: number): string {
	const text = String(value);
	const [coefficient, exponent] = text.toLowerCase().split("e");
	if (exponent === undefined) return text;
	const sign = coefficient.startsWith("-") ? "-" : "";
	const [integer, fraction = ""] = coefficient.slice(sign.length).split(".");
	const digits = integer + fraction;
	const point = integer.length + Number(exponent);
	return (
		sign +
		(point <= 0
			? `0.${"0".repeat(-point)}${digits}`
			: point >= digits.length
				? digits + "0".repeat(point - digits.length)
				: `${digits.slice(0, point)}.${digits.slice(point)}`)
	);
}
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
			case "prop":
				return value.via === undefined
					? call("property", quote(value.caseType), quote(value.property))
					: call(
							"property",
							quote(value.caseType),
							quote(value.property),
							relation(value.via),
						);
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
		}
	}
	function expression(value: ValueExpression): string {
		switch (value.kind) {
			case "term":
				return term(value.term);
			case "today":
			case "now":
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
				if (
					value.op === "div" &&
					queryValueType(value, context.typeContext) === "int"
				)
					return call(
						"quotient",
						expression(value.left),
						expression(value.right),
					);
				return `(${expression(value.left)} ${value.op} ${expression(value.right)})`;
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
						literal(entry.when),
						expression(entry.then),
					]),
					expression(value.fallback),
				);
			case "count":
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
				return call(value.kind, expression(value.date), quote(value.pattern));
		}
	}
	function predicate(value: Predicate): string {
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
					...value.values.map(literal),
				);
			case "within-distance":
				return call(
					value.kind,
					term(value.property),
					expression(value.center),
					numeric(value.distance),
					quote(value.unit),
				);
			case "is-blank":
				return call(value.kind, expression(value.left));
			case "matches-pattern":
				return call(value.kind, expression(value.left), quote(value.pattern));
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
				return call(value.mode, term(value.property), expression(value.value));
			case "multi-select-contains":
				return call(
					value.quantifier === "any" ? "selected-any" : "selected-all",
					term(value.property),
					...value.values.map(literal),
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
		}
	}
	return { value: expression, predicate };
}
