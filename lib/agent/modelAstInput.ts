/**
 * Model-facing shorthand for Nova's Predicate / ValueExpression AST.
 *
 * The canonical document shape keeps every Term lifted through
 * `{ kind: "term", term: ... }` whenever a value expression is expected.
 * Models naturally omit that mechanical wrapper, though, and write the same
 * direct Term shape accepted by Nova's typed expression builders. This module
 * accepts that authoring shorthand at model boundaries and normalizes it
 * before the shared tool schema parses the call. MCP and stored Blueprint
 * documents continue to speak the canonical AST directly.
 */

const TERM_KINDS = new Set([
	"prop",
	"input",
	"session-user",
	"session-user-property",
	"session-context",
	"form-field",
	"table-column",
	"fixed-location",
	"owner-location-at-level",
	"literal",
]);

const PREDICATE_KINDS = new Set([
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"within-distance",
	"match",
	"multi-select-contains",
	"match-all",
	"match-none",
	"is-blank",
	"matches-pattern",
	"between",
	"and",
	"or",
	"not",
	"when-input-present",
	"exists",
	"missing",
]);

const VALUE_EXPRESSION_KINDS = new Set([
	"term",
	"today",
	"now",
	"id-of",
	"acting-user",
	"unowned",
	"table-lookup",
	"date-add",
	"date-coerce",
	"datetime-coerce",
	"double",
	"arith",
	"concat",
	"coalesce",
	"if",
	"switch",
	"count",
	"format-date",
]);

/** Tool-body keys whose object value is always a ValueExpression. */
const TOOL_VALUE_SLOTS = new Set([
	"expr",
	"expression",
	"default",
	"excludedOwnerIds",
]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function withMembers(
	source: JsonRecord,
	members: Readonly<Record<string, unknown>>,
): JsonRecord {
	return { ...source, ...members };
}

function normalizeMembers(source: JsonRecord): JsonRecord {
	return Object.fromEntries(
		Object.entries(source).map(([key, member]) => [
			key,
			TOOL_VALUE_SLOTS.has(key) && record(member) !== null
				? normalizeValue(member)
				: normalizeAny(member),
		]),
	);
}

function normalizeValue(value: unknown): unknown {
	const source = record(value);
	if (source === null) return normalizeAny(value);
	const kind = source.kind;
	if (typeof kind === "string" && TERM_KINDS.has(kind)) {
		return { kind: "term", term: normalizeAny(source) };
	}
	if (typeof kind !== "string" || !VALUE_EXPRESSION_KINDS.has(kind)) {
		return normalizeAny(source);
	}

	switch (kind) {
		case "term":
			return withMembers(source, { term: normalizeAny(source.term) });
		case "table-lookup":
			return withMembers(source, { where: normalizePredicate(source.where) });
		case "date-add":
			return withMembers(source, {
				date: normalizeValue(source.date),
				quantity: normalizeValue(source.quantity),
			});
		case "date-coerce":
		case "datetime-coerce":
		case "double":
			return withMembers(source, { value: normalizeValue(source.value) });
		case "arith":
			return withMembers(source, {
				left: normalizeValue(source.left),
				right: normalizeValue(source.right),
			});
		case "concat":
			return withMembers(source, {
				parts: Array.isArray(source.parts)
					? source.parts.map(normalizeValue)
					: source.parts,
			});
		case "coalesce":
			return withMembers(source, {
				values: Array.isArray(source.values)
					? source.values.map(normalizeValue)
					: source.values,
			});
		case "if":
			return withMembers(
				source,
				Object.fromEntries([
					["cond", normalizePredicate(source.cond)],
					// biome-ignore lint/suspicious/noThenProperty: `then` is the canonical ValueExpression slot.
					["then", normalizeValue(source.then)],
					["else", normalizeValue(source.else)],
				]),
			);
		case "switch":
			return withMembers(source, {
				on: normalizeValue(source.on),
				cases: Array.isArray(source.cases)
					? source.cases.map((entry) => {
							const item = record(entry);
							return item === null
								? normalizeAny(entry)
								: withMembers(
										item,
										Object.fromEntries([
											// biome-ignore lint/suspicious/noThenProperty: `then` is the canonical switch-case slot.
											["then", normalizeValue(item.then)],
										]),
									);
						})
					: source.cases,
				fallback: normalizeValue(source.fallback),
			});
		case "count":
			return source.where === undefined
				? normalizeAny(source)
				: withMembers(source, { where: normalizePredicate(source.where) });
		case "format-date":
			return withMembers(source, { date: normalizeValue(source.date) });
		default:
			return normalizeMembers(source);
	}
}

function normalizePredicate(value: unknown): unknown {
	const source = record(value);
	if (source === null) return normalizeAny(value);
	const kind = source.kind;
	if (typeof kind !== "string" || !PREDICATE_KINDS.has(kind)) {
		return normalizeAny(source);
	}

	switch (kind) {
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return withMembers(source, {
				left: normalizeValue(source.left),
				right: normalizeValue(source.right),
			});
		case "in":
			return withMembers(source, {
				left: normalizeValue(source.left),
				values: normalizeAny(source.values),
			});
		case "within-distance":
			return withMembers(source, {
				property: normalizeAny(source.property),
				center: normalizeValue(source.center),
			});
		case "is-blank":
		case "matches-pattern":
			return withMembers(source, { left: normalizeValue(source.left) });
		case "match":
			return withMembers(source, { value: normalizeValue(source.value) });
		case "between":
			return withMembers(source, {
				left: normalizeValue(source.left),
				...(source.lower !== undefined && {
					lower: normalizeValue(source.lower),
				}),
				...(source.upper !== undefined && {
					upper: normalizeValue(source.upper),
				}),
			});
		case "and":
		case "or":
			return withMembers(source, {
				clauses: Array.isArray(source.clauses)
					? source.clauses.map(normalizePredicate)
					: source.clauses,
			});
		case "not":
			return withMembers(source, {
				clause: normalizePredicate(source.clause),
			});
		case "when-input-present":
			return withMembers(source, {
				input: normalizeAny(source.input),
				clause: normalizePredicate(source.clause),
			});
		case "exists":
		case "missing":
			return source.where === undefined
				? normalizeAny(source)
				: withMembers(source, { where: normalizePredicate(source.where) });
		default:
			return normalizeMembers(source);
	}
}

function normalizeCaseOperation(source: JsonRecord): JsonRecord {
	return withMembers(source, {
		...(source.condition !== undefined && {
			condition: normalizePredicate(source.condition),
		}),
		...(source.name !== undefined && { name: normalizeValue(source.name) }),
		...(source.owner !== undefined && { owner: normalizeValue(source.owner) }),
		...(source.rename !== undefined && {
			rename: normalizeValue(source.rename),
		}),
		...(Array.isArray(source.writes) && {
			writes: source.writes.map((entry) => {
				const write = record(entry);
				return write === null
					? normalizeAny(entry)
					: withMembers(write, {
							value: normalizeValue(write.value),
							...(write.condition !== undefined && {
								condition: normalizePredicate(write.condition),
							}),
						});
			}),
		}),
	});
}

function normalizeAny(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeAny);
	const source = record(value);
	if (source === null) return value;
	if (
		(source.action === "create" ||
			source.action === "update" ||
			source.action === "close") &&
		typeof source.id === "string" &&
		typeof source.caseType === "string" &&
		source.target !== undefined
	) {
		return normalizeCaseOperation(source);
	}
	if (typeof source.kind === "string") {
		if (PREDICATE_KINDS.has(source.kind)) return normalizePredicate(source);
		if (VALUE_EXPRESSION_KINDS.has(source.kind)) return normalizeValue(source);
	}
	if (
		source.kind === "hidden" &&
		typeof source.name === "string" &&
		source.value !== undefined
	) {
		// A hidden Search input: its `value` is the one ValueExpression slot
		// keyed by a word other tool bodies use for plain data.
		return withMembers(normalizeMembers(source), {
			value: normalizeValue(source.value),
		});
	}
	return normalizeMembers(source);
}

/** Normalize a whole model-authored tool input without mutating it. */
export function normalizeModelAstInput(value: unknown): unknown {
	return normalizeAny(value);
}
