import {
	chosenCaseId,
	chosenCaseProperty,
} from "@/lib/domain/expression/chosenCase";
import type { RecordQueryContext } from "@/lib/domain/expression/context";
import {
	DISTANCE_UNITS,
	type DistanceUnit,
} from "@/lib/domain/expression/distance";
import { scalarDataType, typeOf } from "@/lib/domain/expression/typeChecker";
import {
	type Choice,
	caseTypeNameSchema,
	conditionSchema,
	type Expression,
	type Literal,
	type RelationPath,
	relationPathSchema,
	type Term,
	termSchema,
	valueSchema,
} from "@/lib/domain/expression/types";
import {
	FUNCTION_REGISTRY,
	functionArityIssue,
	QUERY_FUNCTIONS,
} from "@/lib/domain/expressionFunctions";
import type { Uuid } from "@/lib/domain/uuid";
import { AuthoringInputError } from "./errors";
import {
	type AuthoredExpression,
	parseAuthoringExpression,
} from "./expressionSyntax";

export interface QueryBindings {
	typeContext: RecordQueryContext;
	readonly currentCaseType?: string;
	choice(field: Uuid, value: Literal): Literal | Choice;
	/** Resolvers reject missing or ambiguous names in their current scope. */
	reference(namespace: string, path: readonly string[]): Term;
	identity(
		kind: "table" | "column" | "operation" | "location" | "level" | "module",
		name: string,
		owner?: string,
	): string;
	/** The menu a chosen-case read names, refused unless one case is chosen
	 *  there: its module and that module's case type. */
	chosenCaseMenu(name: string): { module: Uuid; caseType: string };
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

function arity(name: string, args: readonly Node[]) {
	const spec = QUERY_FUNCTIONS.get(name);
	if (!spec)
		throw new AuthoringInputError(
			FUNCTION_REGISTRY.has(name)
				? `${name}() is available in form expressions, but not record expressions. The expressions guide describes each function's supported contexts.`
				: `Unknown expression function: ${name}(). The expressions guide lists supported functions.`,
		);
	const issue = functionArityIssue(name, args.length, spec);
	if (issue) throw new AuthoringInputError(issue);
}
function isCall(node: Node, name: string) {
	if (node.kind !== "call" || node.name !== name) return false;
	arity(name, node.args);
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
			arity(node.name, node.args);
			return node.name === "null" ? null : node.name === "true";
		}
		if (node.name === "concat") {
			arity(node.name, node.args);
			const values = node.args.map(literalValue);
			if (values.every((value) => typeof value === "string"))
				return values.join("");
		}
	}
	throw new AuthoringInputError("This argument needs a literal value.");
}
function string(node: Node): string {
	const value = literalValue(node);
	if (typeof value !== "string")
		throw new AuthoringInputError("This argument needs a quoted name or text.");
	return value;
}
function number(node: Node): number {
	const value = literalValue(node);
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new AuthoringInputError("This argument needs a finite number.");
	return value;
}
function boolean(node: Node): boolean {
	const value = literalValue(node);
	if (typeof value !== "boolean")
		throw new AuthoringInputError("This argument needs true() or false().");
	return value;
}
function literal(node: Node): ObjectValue {
	if (node.kind === "call" && node.name === "literal") {
		arity(node.name, node.args);
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

/** Whether `literal()` reads this argument as a literal constructor rather
 *  than a value to compute. */
function isLiteralNode(node: Node): boolean {
	if (node.kind === "literal") return true;
	if (node.kind === "negative")
		return (
			node.value.kind === "literal" && typeof node.value.value === "number"
		);
	if (node.kind !== "call") return false;
	if (["true", "false", "null", "literal"].includes(node.name)) return true;
	return (
		node.name === "concat" &&
		node.args.every(
			(arg) =>
				(arg.kind === "literal" && typeof arg.value === "string") ||
				(arg.kind === "call" && arg.name === "concat" && isLiteralNode(arg)),
		)
	);
}

/** A number argument written as a number, which `number()` reads. */
function isNumberNode(node: Node): boolean {
	const literalNode = node.kind === "negative" ? node.value : node;
	return (
		literalNode.kind === "literal" && typeof literalNode.value === "number"
	);
}

const DISTANCE_UNIT_ALIASES: Readonly<Record<string, DistanceUnit>> = {
	km: "kilometers",
	kilometer: "kilometers",
	mi: "miles",
	mile: "miles",
};

/** A distance unit written as quoted text: one of the nine names or an
 *  alias of one. */
function distanceUnit(node: Node): DistanceUnit {
	const name = string(node);
	const unit = Object.hasOwn(DISTANCE_UNIT_ALIASES, name)
		? DISTANCE_UNIT_ALIASES[name]
		: name;
	if ((DISTANCE_UNITS as readonly string[]).includes(unit))
		return unit as DistanceUnit;
	throw new AuthoringInputError(
		`CommCare doesn't measure distance in ${name}. Use one of ${DISTANCE_UNITS.join(", ")}.`,
	);
}

function relation(node: Node): RelationPath {
	if (node.kind !== "call")
		throw new AuthoringInputError(
			"Name a record relationship with self(), children(), or ancestor().",
		);
	const { name, args } = node;
	let result: ObjectValue;
	if (name === "self") {
		arity(name, args);
		result = { kind: "self" };
	} else if (name === "children" || name === "related") {
		arity(name, args);
		result = {
			kind: name === "children" ? "subcase" : "any-relation",
			identifier: args[1] ? string(args[1]) : "parent",
			...(args[0] &&
				!isCall(args[0], "unbounded") && { ofCaseType: string(args[0]) }),
		};
	} else if (name === "ancestor") {
		arity(name, args);
		result = {
			kind: "ancestor",
			via: args.map((step) => {
				if (step.kind === "call" && step.name === "link") {
					arity(step.name, step.args);
					return {
						identifier: string(step.args[0]),
						...(step.args[1] && { throughCaseType: string(step.args[1]) }),
					};
				}
				return { identifier: string(step) };
			}),
		};
	} else
		throw new AuthoringInputError(`Unknown relationship function: ${name}.`);
	return relationPathSchema.parse(result);
}

function compiler(bindings: QueryBindings) {
	function term(node: Node): ObjectValue {
		if (node.kind === "reference")
			return bindings.reference(node.namespace, node.path);
		if (node.kind === "call") {
			const { name, args } = node;
			arity(name, args);
			if (name === "property") {
				const via = args[2] ? relation(args[2]) : undefined;
				const origin = string(args[0]);
				if (via && origin !== bindings.currentCaseType)
					throw new AuthoringInputError(
						`property() starts from ${bindings.currentCaseType ?? "an unspecified record"}, not ${origin}.`,
					);
				const resolved = via
					? bindings.forRelation(via).reference("case", [string(args[1])])
					: bindings.reference("record", [origin, string(args[1])]);
				if (resolved.kind !== "prop")
					throw new AuthoringInputError("property() needs a record property.");
				return {
					...resolved,
					...(via && { via, caseType: origin }),
				};
			}
			if (name === "via") {
				const path = relation(args[0]);
				const property = compiler(bindings.forRelation(path)).term(args[1]);
				if (property.kind !== "prop" || property.via !== undefined)
					throw new AuthoringInputError(
						"via() needs a record property without an existing relationship.",
					);
				const origin = bindings.currentCaseType;
				if (!origin)
					throw new AuthoringInputError("via() needs an originating record.");
				return { ...property, caseType: origin, via: path };
			}
			if (["field", "search", "user"].includes(name)) {
				return bindings.reference(
					name === "field" ? "form" : name,
					string(args[0]).split("/"),
				);
			}
			if (name === "session") {
				return { kind: "session-context", field: string(args[0]) };
			}
			if (name === "record-type") return { kind: "case-row-type" };
			if (name === "external-user") {
				return { kind: "session-user", field: string(args[0]) };
			}
			if (name === "location") {
				return {
					kind: "fixed-location",
					locationUuid: bindings.identity("location", string(args[0])),
				};
			}
			if (name === "owner-location") {
				return {
					kind: "owner-location-at-level",
					levelUuid: bindings.identity("level", string(args[0])),
					ownerCaseType: string(args[1]),
				};
			}
			if (name === "table-column") {
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

	function choiceFor(
		candidate: ObjectValue,
		opposite: ObjectValue,
	): ObjectValue {
		if (candidate.kind !== "literal" || opposite.kind !== "term")
			return candidate;
		const reference = termSchema.safeParse(opposite.term);
		return reference.success && reference.data.kind === "field"
			? bindings.choice(reference.data.uuid, candidate as Literal)
			: candidate;
	}
	function oppositeValue(
		candidate: ObjectValue,
		opposite: ObjectValue,
	): ObjectValue {
		if (candidate.kind !== "term") return candidate;
		const literal = candidate.term;
		if (
			typeof literal !== "object" ||
			literal === null ||
			!("kind" in literal) ||
			literal.kind !== "literal"
		)
			return candidate;
		return { ...candidate, term: choiceFor(literal as ObjectValue, opposite) };
	}
	/** A comparison operand. A quoted name compared with `record-type()` names
	 *  a record type; `literal('…')` there stays the text it spells. */
	function comparisonOperand(
		node: Node,
		candidate: ObjectValue,
		opposite: ObjectValue,
	): ObjectValue {
		if (
			node.kind === "literal" &&
			typeof node.value === "string" &&
			opposite.kind === "term" &&
			(opposite.term as ObjectValue | undefined)?.kind === "case-row-type" &&
			caseTypeNameSchema.safeParse(node.value).success
		)
			return {
				kind: "term",
				term: { kind: "case-type", caseType: node.value },
			};
		return oppositeValue(candidate, opposite);
	}

	function value(node: Node): ObjectValue {
		if (node.kind === "binary") {
			if (!arithmetic.has(node.operator))
				throw new AuthoringInputError(
					"This slot needs a value; put a condition inside if().",
				);
			const result = {
				kind: "arith",
				op: node.operator,
				left: value(node.left),
				right: value(node.right),
			};

			return result;
		}
		if (node.kind === "negative") {
			if (node.value.kind === "literal" && typeof node.value.value === "number")
				return { kind: "term", term: literal(node) };
			return { kind: "negate", value: value(node.value) };
		}
		if (node.kind !== "call") return { kind: "term", term: term(node) };
		const { name, args } = node;
		if (name === "quotient") {
			arity(name, args);
			const left = valueSchema.parse(value(args[0]));
			const right = valueSchema.parse(value(args[1]));
			if (
				scalarDataType(typeOf(left, bindings.typeContext)?.data) !== "int" ||
				scalarDataType(typeOf(right, bindings.typeContext)?.data) !== "int"
			)
				throw new AuthoringInputError(
					"quotient() needs integer operands. Use div for decimal division.",
				);
			return {
				kind: "arith",
				op: "quotient",
				left,
				right,
			};
		}
		if (["today", "now", "here", "acting-user", "unowned"].includes(name)) {
			arity(name, args);
			return { kind: name };
		}
		if (name === "id-of") {
			arity(name, args);
			return {
				kind: name,
				opUuid: bindings.identity("operation", string(args[0])),
			};
		}
		if (name === "lookup") {
			arity(name, args);
			const tableId = bindings.identity("table", string(args[0]));
			return {
				kind: "table-lookup",
				tableId,
				resultColumnId: bindings.identity("column", string(args[1]), tableId),
				where: compiler(bindings.forTable(tableId)).predicate(args[2]),
			};
		}
		if (name === "date-add") {
			arity(name, args);
			const interval = string(args[2]);
			return {
				kind: name,
				date: value(args[0]),
				quantity: value(args[1]),
				interval: interval.endsWith("s") ? interval : `${interval}s`,
			};
		}
		if (["date", "datetime", "number"].includes(name)) {
			arity(name, args);
			return {
				kind: name === "number" ? "double" : `${name}-coerce`,
				value: value(args[0]),
			};
		}
		if (name === "concat" || name === "coalesce") {
			arity(name, args);
			if (args.length === 0)
				return { kind: "term", term: { kind: "literal", value: "" } };
			return {
				kind: name,
				[name === "concat" ? "parts" : "values"]: args.map(value),
			};
		}
		if (name === "if") {
			arity(name, args);
			return {
				kind: name,
				cond: predicate(args[0]),
				// biome-ignore lint/suspicious/noThenProperty: Canonical AST data, never a callable thenable.
				then: value(args[1]),
				else: value(args[2]),
			};
		}
		if (name === "switch") {
			arity(name, args);
			const cases = [];
			const on = value(args[0]);
			for (let i = 1; i < args.length - 1; i += 2)
				cases.push({
					when: choiceFor(literal(args[i]), on),
					// biome-ignore lint/suspicious/noThenProperty: Canonical AST data, never a callable thenable.
					then: value(args[i + 1]),
				});
			return {
				kind: name,
				on,
				cases,
				fallback: value(args[args.length - 1]),
			};
		}
		if (name === "count") {
			arity(name, args);
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
			arity(name, args);
			return { kind: name, date: value(args[0]), pattern: string(args[1]) };
		}
		if (name === "chosen-case") {
			arity(name, args);
			return chosenCaseId(bindings.chosenCaseMenu(string(args[0])).module);
		}
		if (name === "chosen-case-property") {
			arity(name, args);
			const menu = bindings.chosenCaseMenu(string(args[0]));
			return chosenCaseProperty(menu.module, menu.caseType, string(args[1]));
		}
		return { kind: "term", term: term(node) };
	}
	/** A selection value: a literal is one choice as written, anything else a
	 *  value worked out when the condition runs. */
	function selectionValue(node: Node): ObjectValue {
		return isLiteralNode(node) ? literal(node) : value(node);
	}

	function property(node: Node): ObjectValue {
		const result = term(node);
		if (result.kind !== "prop")
			throw new AuthoringInputError("This argument needs a record property.");
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
			if (kind) {
				const left = value(node.left),
					right = value(node.right);
				return {
					kind,
					left: comparisonOperand(node.left, left, right),
					right: comparisonOperand(node.right, right, left),
				};
			}
		}
		if (node.kind !== "call")
			throw new AuthoringInputError(
				"This slot needs a condition, such as #case/age >= 18.",
			);
		const { name, args } = node;
		if (name === "true" || name === "false") {
			arity(name, args);
			return { kind: name === "true" ? "match-all" : "match-none" };
		}
		if (name === "all" || name === "any") {
			arity(name, args);
			if (args.length === 0)
				return { kind: name === "all" ? "match-all" : "match-none" };
			return {
				kind: name === "all" ? "and" : "or",
				clauses: args.map(predicate),
			};
		}
		if (name === "not") {
			arity(name, args);
			return { kind: name, clause: predicate(args[0]) };
		}
		if (name === "in") {
			arity(name, args);
			const left = value(args[0]);
			return {
				kind: name,
				left,
				values: args.slice(1).map((node) => choiceFor(literal(node), left)),
			};
		}
		if (name === "is-blank") {
			arity(name, args);
			return { kind: name, left: value(args[0]) };
		}
		if (name === "matches-pattern") {
			arity(name, args);
			return { kind: name, left: value(args[0]), pattern: string(args[1]) };
		}
		if (name === "between") {
			arity(name, args);
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
			arity(name, args);
			return {
				kind: "match",
				mode: name,
				property: property(args[0]),
				value: value(args[1]),
			};
		}
		if (name === "selected-any" || name === "selected-all") {
			arity(name, args);
			return {
				kind: "multi-select-contains",
				quantifier: name === "selected-any" ? "any" : "all",
				property: property(args[0]),
				values: args.slice(1).map(selectionValue),
			};
		}
		if (name === "within-distance") {
			arity(name, args);
			const [, , distance, unit] = args;
			return {
				kind: name,
				property: property(args[0]),
				center: value(args[1]),
				distance: isNumberNode(distance) ? number(distance) : value(distance),
				unit:
					unit.kind === "literal" && typeof unit.value === "string"
						? distanceUnit(unit)
						: value(unit),
			};
		}
		if (name === "if") {
			arity(name, args);
			return {
				kind: name,
				cond: predicate(args[0]),
				// biome-ignore lint/suspicious/noThenProperty: Canonical AST data, never a callable thenable.
				then: predicate(args[1]),
				else: predicate(args[2]),
			};
		}
		if (name === "switch") {
			arity(name, args);
			const cases = [];
			const on = value(args[0]);
			for (let i = 1; i < args.length - 1; i += 2)
				cases.push({
					when: choiceFor(literal(args[i]), on),
					// biome-ignore lint/suspicious/noThenProperty: Canonical AST data, never a callable thenable.
					then: predicate(args[i + 1]),
				});
			return {
				kind: name,
				on,
				cases,
				fallback: predicate(args[args.length - 1]),
			};
		}
		if (name === "when-provided") {
			arity(name, args);
			const input = term(args[0]);
			if (input.kind !== "input")
				throw new AuthoringInputError("when-provided() needs a Search answer.");
			return { kind: "when-input-present", input, clause: predicate(args[1]) };
		}
		if (name === "exists" || name === "missing") {
			arity(name, args);
			const via = relation(args[0]);
			return {
				kind: name,
				via,
				...(args[1] && {
					where: compiler(bindings.forRelation(via)).predicate(args[1]),
				}),
			};
		}
		arity(name, args);
		throw new AuthoringInputError(
			`${name}() does not produce a condition. This slot needs a condition, such as #case/age >= 18.`,
		);
	}
	return { predicate, value, term };
}

export function parseQueryValue(
	source: string | number | boolean,
	bindings: QueryBindings,
): Expression {
	return valueSchema.parse(
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
): Expression {
	return conditionSchema.parse(
		compiler(bindings).predicate(parseAuthoringExpression(source)),
	);
}
