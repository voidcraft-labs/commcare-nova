import {
	type CheckError,
	checkExpression,
	type Predicate,
	predicateSchema,
	type RelationPath,
	relationPathSchema,
	type Term,
	type TypeContext,
	termSchema,
	type ValueExpression,
	valueExpressionSchema,
} from "@/lib/domain/predicate";
import {
	type AuthoredExpression,
	parseAuthoringExpression,
} from "./expressionSyntax";

export interface QueryBindings {
	typeContext: TypeContext;
	/** Resolvers reject missing or ambiguous names in their current scope. */
	reference(namespace: string, path: readonly string[]): Term;
	identity(
		kind: "table" | "column" | "operation" | "location" | "level",
		name: string,
		owner?: string,
	): string;
	forRelation(relation: RelationPath): QueryBindings;
	forTable(tableId: string): QueryBindings;
}

type Node = AuthoredExpression;
type ObjectValue = Record<string, unknown>;
const comparisons: Record<string, string> = {
	"=": "eq",
	"!=": "neq",
	">": "gt",
	">=": "gte",
	"<": "lt",
	"<=": "lte",
};
const arithmetic = new Set(["+", "-", "*", "div", "mod"]);

function arity(
	name: string,
	args: readonly Node[],
	minimum: number,
	maximum = minimum,
) {
	if (args.length < minimum || args.length > maximum)
		throw new Error(
			`${name} expects ${minimum === maximum ? minimum : `${minimum}–${maximum}`} arguments; received ${args.length}.`,
		);
}
function isCall(node: Node, name: string) {
	if (node.kind !== "call" || node.name !== name) return false;
	arity(name, node.args, 0);
	return true;
}

/** Only literal constructors are folded here. This never evaluates app data. */
function literalValue(node: Node): string | number | boolean | null {
	if (node.kind === "literal") return node.value;
	if (node.kind === "negative") {
		const value = literalValue(node.value);
		if (typeof value === "number") return -value;
	}
	if (node.kind === "call") {
		if (["true", "false", "null"].includes(node.name)) {
			arity(node.name, node.args, 0);
			return node.name === "null" ? null : node.name === "true";
		}
		if (node.name === "concat") {
			arity(node.name, node.args, 1, Number.MAX_SAFE_INTEGER);
			const values = node.args.map(literalValue);
			if (values.every((value) => typeof value === "string"))
				return values.join("");
		}
	}
	throw new Error("This argument needs a literal value.");
}
function string(node: Node): string {
	const value = literalValue(node);
	if (typeof value !== "string")
		throw new Error("This argument needs a quoted name or text.");
	return value;
}
function number(node: Node): number {
	const value = literalValue(node);
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error("This argument needs a finite number.");
	return value;
}
function boolean(node: Node): boolean {
	const value = literalValue(node);
	if (typeof value !== "boolean")
		throw new Error("This argument needs true() or false().");
	return value;
}
function literal(node: Node): ObjectValue {
	if (node.kind === "call" && node.name === "literal") {
		arity(node.name, node.args, 1, 2);
		return {
			kind: "literal",
			value: literalValue(node.args[0]),
			...(node.args[1] && { data_type: string(node.args[1]) }),
		};
	}
	const numberNode = node.kind === "negative" ? node.value : node;
	return {
		kind: "literal",
		value: literalValue(node),
		...(numberNode.kind === "literal" &&
			numberNode.decimal && { data_type: "decimal" }),
	};
}

function relation(node: Node): RelationPath {
	if (node.kind !== "call")
		throw new Error(
			"Name a record relationship with self(), children(), or ancestor().",
		);
	const { name, args } = node;
	let result: ObjectValue;
	if (name === "self") {
		arity(name, args, 0);
		result = { kind: "self" };
	} else if (name === "children" || name === "related") {
		arity(name, args, 0, 2);
		result = {
			kind: name === "children" ? "subcase" : "any-relation",
			identifier: args[1] ? string(args[1]) : "parent",
			...(args[0] &&
				!isCall(args[0], "unbounded") && { ofCaseType: string(args[0]) }),
		};
	} else if (name === "ancestor") {
		arity(name, args, 1, Number.MAX_SAFE_INTEGER);
		result = {
			kind: "ancestor",
			via: args.map((step) => {
				if (step.kind === "call" && step.name === "link") {
					arity(step.name, step.args, 1, 2);
					return {
						identifier: string(step.args[0]),
						...(step.args[1] && { throughCaseType: string(step.args[1]) }),
					};
				}
				return { identifier: string(step) };
			}),
		};
	} else throw new Error(`Unknown relationship function: ${name}.`);
	return relationPathSchema.parse(result);
}

function compiler(bindings: QueryBindings) {
	const numericType = (value: ObjectValue) =>
		queryValueType(valueExpressionSchema.parse(value), bindings.typeContext);
	function term(node: Node): ObjectValue {
		if (node.kind === "reference")
			return bindings.reference(node.namespace, node.path);
		if (node.kind === "call") {
			const { name, args } = node;
			if (name === "property") {
				arity(name, args, 2, 3);
				const via = args[2] ? relation(args[2]) : undefined;
				const origin = string(args[0]);
				if (via && origin !== bindings.typeContext.currentCaseType)
					throw new Error(
						`property() starts from ${bindings.typeContext.currentCaseType ?? "an unspecified record"}, not ${origin}.`,
					);
				const resolved = via
					? bindings.forRelation(via).reference("case", [string(args[1])])
					: bindings.reference("record", [origin, string(args[1])]);
				if (resolved.kind !== "prop")
					throw new Error("property() needs a record property.");
				return {
					...resolved,
					...(via && { via, caseType: origin }),
				};
			}
			if (name === "via") {
				arity(name, args, 2);
				const path = relation(args[0]);
				const property = compiler(bindings.forRelation(path)).term(args[1]);
				if (property.kind !== "prop" || property.via !== undefined)
					throw new Error(
						"via() needs a record property without an existing relationship.",
					);
				const origin = bindings.typeContext.currentCaseType;
				if (!origin) throw new Error("via() needs an originating record.");
				return { ...property, caseType: origin, via: path };
			}
			if (["field", "search", "user"].includes(name)) {
				arity(name, args, 1);
				return bindings.reference(
					name === "field" ? "form" : name,
					string(args[0]).split("/"),
				);
			}
			if (name === "session") {
				arity(name, args, 1);
				return { kind: "session-context", field: string(args[0]) };
			}
			if (name === "external-user") {
				arity(name, args, 1);
				return { kind: "session-user", field: string(args[0]) };
			}
			if (name === "location") {
				arity(name, args, 1);
				return {
					kind: "fixed-location",
					locationUuid: bindings.identity("location", string(args[0])),
				};
			}
			if (name === "owner-location") {
				arity(name, args, 2);
				return {
					kind: "owner-location-at-level",
					levelUuid: bindings.identity("level", string(args[0])),
					ownerCaseType: string(args[1]),
				};
			}
			if (name === "table-column") {
				arity(name, args, 2);
				const tableId = bindings.identity("table", string(args[0]));
				return {
					kind: "table-column",
					tableId,
					columnId: bindings.identity("column", string(args[1]), tableId),
				};
			}
		}
		return literal(node);
	}

	function value(node: Node): ObjectValue {
		if (node.kind === "binary") {
			if (!arithmetic.has(node.operator))
				throw new Error(
					"This slot needs a value; put a condition inside if().",
				);
			const result = {
				kind: "arith",
				op: node.operator,
				left: value(node.left),
				right: value(node.right),
			};
			// Field expressions use real division. Keep that meaning here even
			// when the canonical query engine would infer integer operands.
			if (node.operator === "div" && numericType(result) === "int")
				result.left = { kind: "double", value: result.left };
			return result;
		}
		if (node.kind === "negative") {
			if (node.value.kind === "literal" && typeof node.value.value === "number")
				return { kind: "term", term: literal(node) };
			return {
				kind: "arith",
				op: "*",
				left: { kind: "term", term: { kind: "literal", value: -1 } },
				right: value(node.value),
			};
		}
		if (node.kind !== "call") return { kind: "term", term: term(node) };
		const { name, args } = node;
		if (name === "quotient") {
			arity(name, args, 2);
			const result = {
				kind: "arith",
				op: "div",
				left: value(args[0]),
				right: value(args[1]),
			};
			if (numericType(result) !== "int")
				throw new Error("quotient() needs integer operands.");
			return result;
		}
		if (["today", "now", "acting-user", "unowned"].includes(name)) {
			arity(name, args, 0);
			return { kind: name };
		}
		if (name === "id-of") {
			arity(name, args, 1);
			return {
				kind: name,
				opUuid: bindings.identity("operation", string(args[0])),
			};
		}
		if (name === "lookup") {
			arity(name, args, 3);
			const tableId = bindings.identity("table", string(args[0]));
			return {
				kind: "table-lookup",
				tableId,
				resultColumnId: bindings.identity("column", string(args[1]), tableId),
				where: compiler(bindings.forTable(tableId)).predicate(args[2]),
			};
		}
		if (name === "date-add") {
			arity(name, args, 3);
			const interval = string(args[2]);
			return {
				kind: name,
				date: value(args[0]),
				quantity: value(args[1]),
				interval: interval.endsWith("s") ? interval : `${interval}s`,
			};
		}
		if (["date", "datetime", "number"].includes(name)) {
			arity(name, args, 1);
			return {
				kind: name === "number" ? "double" : `${name}-coerce`,
				value: value(args[0]),
			};
		}
		if (name === "concat" || name === "coalesce") {
			arity(name, args, 1, Number.MAX_SAFE_INTEGER);
			return {
				kind: name,
				[name === "concat" ? "parts" : "values"]: args.map(value),
			};
		}
		if (name === "if") {
			arity(name, args, 3);
			return {
				kind: name,
				cond: predicate(args[0]),
				// biome-ignore lint/suspicious/noThenProperty: Canonical AST data, never a callable thenable.
				then: value(args[1]),
				else: value(args[2]),
			};
		}
		if (name === "switch") {
			if (args.length < 4 || args.length % 2 !== 0)
				throw new Error(
					"switch() needs a value, one or more match/result pairs, and a fallback.",
				);
			const cases = [];
			for (let i = 1; i < args.length - 1; i += 2)
				// biome-ignore lint/suspicious/noThenProperty: Canonical AST data, never a callable thenable.
				cases.push({ when: literal(args[i]), then: value(args[i + 1]) });
			return {
				kind: name,
				on: value(args[0]),
				cases,
				fallback: value(args[args.length - 1]),
			};
		}
		if (name === "count") {
			arity(name, args, 1, 2);
			const via = relation(args[0]);
			return {
				kind: name,
				via,
				...(args[1] && {
					where: compiler(bindings.forRelation(via)).predicate(args[1]),
				}),
			};
		}
		if (name === "format-date") {
			arity(name, args, 2);
			return { kind: name, date: value(args[0]), pattern: string(args[1]) };
		}
		return { kind: "term", term: term(node) };
	}

	function property(node: Node): ObjectValue {
		const result = term(node);
		if (result.kind !== "prop")
			throw new Error("This argument needs a record property.");
		return result;
	}
	function predicate(node: Node): ObjectValue {
		if (node.kind === "literal" && typeof node.value === "boolean")
			return { kind: node.value ? "match-all" : "match-none" };
		if (node.kind === "binary") {
			if (node.operator === "and" || node.operator === "or")
				return {
					kind: node.operator,
					clauses: [predicate(node.left), predicate(node.right)],
				};
			const kind = comparisons[node.operator];
			if (kind)
				return { kind, left: value(node.left), right: value(node.right) };
		}
		if (node.kind !== "call")
			throw new Error("This slot needs a condition, such as #case/age >= 18.");
		const { name, args } = node;
		if (name === "true" || name === "false") {
			arity(name, args, 0);
			return { kind: name === "true" ? "match-all" : "match-none" };
		}
		if (name === "all" || name === "any") {
			arity(name, args, 1, Number.MAX_SAFE_INTEGER);
			return {
				kind: name === "all" ? "and" : "or",
				clauses: args.map(predicate),
			};
		}
		if (name === "not") {
			arity(name, args, 1);
			return { kind: name, clause: predicate(args[0]) };
		}
		if (name === "in") {
			arity(name, args, 2, Number.MAX_SAFE_INTEGER);
			return {
				kind: name,
				left: value(args[0]),
				values: args.slice(1).map(literal),
			};
		}
		if (name === "is-blank") {
			arity(name, args, 1);
			return { kind: name, left: value(args[0]) };
		}
		if (name === "matches-pattern") {
			arity(name, args, 2);
			return { kind: name, left: value(args[0]), pattern: string(args[1]) };
		}
		if (name === "between") {
			arity(name, args, 3, 5);
			return {
				kind: name,
				left: value(args[0]),
				...(!isCall(args[1], "unbounded") && { lower: value(args[1]) }),
				...(!isCall(args[2], "unbounded") && { upper: value(args[2]) }),
				lowerInclusive: args[3] ? boolean(args[3]) : true,
				upperInclusive: args[4] ? boolean(args[4]) : true,
			};
		}
		if (["fuzzy", "phonetic", "fuzzy-date", "starts-with"].includes(name)) {
			arity(name, args, 2);
			return {
				kind: "match",
				mode: name,
				property: property(args[0]),
				value: value(args[1]),
			};
		}
		if (name === "selected-any" || name === "selected-all") {
			arity(name, args, 2, Number.MAX_SAFE_INTEGER);
			return {
				kind: "multi-select-contains",
				quantifier: name === "selected-any" ? "any" : "all",
				property: property(args[0]),
				values: args.slice(1).map(literal),
			};
		}
		if (name === "within-distance") {
			arity(name, args, 4);
			const unit = string(args[3]);
			return {
				kind: name,
				property: property(args[0]),
				center: value(args[1]),
				distance: number(args[2]),
				unit:
					unit === "km" || unit === "kilometer"
						? "kilometers"
						: unit === "mi" || unit === "mile"
							? "miles"
							: unit,
			};
		}
		if (name === "when-provided") {
			arity(name, args, 2);
			const input = term(args[0]);
			if (input.kind !== "input")
				throw new Error("when-provided() needs a Search answer.");
			return { kind: "when-input-present", input, clause: predicate(args[1]) };
		}
		if (name === "exists" || name === "missing") {
			arity(name, args, 1, 2);
			const via = relation(args[0]);
			return {
				kind: name,
				via,
				...(args[1] && {
					where: compiler(bindings.forRelation(via)).predicate(args[1]),
				}),
			};
		}
		throw new Error(`Unknown condition function: ${name}.`);
	}
	return { predicate, value, term };
}

export function queryValueType(value: ValueExpression, context: TypeContext) {
	const errors: CheckError[] = [];
	const result = checkExpression(value, context, errors, []);
	if (errors.length || result === undefined)
		throw new Error(
			errors.map((error) => error.message).join(" ") ||
				"Could not resolve this value's type.",
		);
	return result;
}

export function parseQueryValue(
	source: string | number | boolean,
	bindings: QueryBindings,
): ValueExpression {
	return valueExpressionSchema.parse(
		compiler(bindings).value(parseAuthoringExpression(source)),
	);
}

export function parseQueryReference(
	source: string | number | boolean,
	bindings: QueryBindings,
): Term {
	return termSchema.parse(
		compiler(bindings).term(parseAuthoringExpression(source)),
	);
}

export function parseQueryRelationship(source: string): RelationPath {
	return relation(parseAuthoringExpression(source));
}

export function parseQueryPredicate(
	source: string | boolean,
	bindings: QueryBindings,
): Predicate {
	return predicateSchema.parse(
		compiler(bindings).predicate(parseAuthoringExpression(source)),
	);
}
