import {
	checkExpression,
	coalesce,
	concat,
	dateCoerce,
	datetimeCoerce,
	double,
	type Expression,
	type ExpressionContext,
	formatDate,
	now,
	today,
} from "@/lib/domain/expression";

const UNARY_KINDS = new Set<Expression["kind"]>([
	"date-coerce",
	"datetime-coerce",
	"double",
	"negate",
]);

function buildUnary(
	targetKind: Expression["kind"],
	value: Expression,
): Expression | null {
	switch (targetKind) {
		case "date-coerce":
			return dateCoerce(value);
		case "datetime-coerce":
			return datetimeCoerce(value);
		case "double":
			return double(value);
		case "negate":
			return { kind: "negate", value };
		default:
			return null;
	}
}

function validCandidate(
	candidate: Expression,
	typeContext: ExpressionContext,
): Expression | null {
	return checkExpression(candidate, typeContext).errors.length === 0
		? candidate
		: null;
}

/**
 * Plan only the expression-kind changes that retain every authored child and
 * still satisfy the target operator's own operand rules. A null result means
 * the UI must explain the loss and wait for confirmation before using a fresh
 * target default.
 *
 * Unary carriers can look alike in JSON while accepting different child
 * types, so preservation is allowed only when the complete candidate passes
 * the real expression checker.
 */
export function planPreservedExpressionReplacement(
	currentValue: Expression,
	targetKind: Expression["kind"],
	typeContext: ExpressionContext,
): Expression | null {
	if (currentValue.kind === "term") {
		let candidate: Expression | null;
		switch (targetKind) {
			case "date-coerce":
			case "datetime-coerce":
			case "double":
			case "negate":
				candidate = buildUnary(targetKind, currentValue);
				break;
			case "concat":
				candidate = concat(currentValue);
				break;
			case "coalesce":
				candidate = coalesce(currentValue);
				break;
			case "format-date":
				candidate = formatDate(currentValue, "short");
				break;
			default:
				candidate = null;
		}
		return candidate === null ? null : validCandidate(candidate, typeContext);
	}

	if (
		(currentValue.kind === "date-coerce" ||
			currentValue.kind === "datetime-coerce" ||
			currentValue.kind === "double" ||
			currentValue.kind === "negate") &&
		UNARY_KINDS.has(targetKind) &&
		"value" in currentValue
	) {
		const candidate = buildUnary(targetKind, currentValue.value);
		return candidate === null ? null : validCandidate(candidate, typeContext);
	}

	if (
		(currentValue.kind === "concat" || currentValue.kind === "coalesce") &&
		(targetKind === "concat" || targetKind === "coalesce")
	) {
		const values =
			currentValue.kind === "concat" ? currentValue.parts : currentValue.values;
		const [first, ...rest] = values;
		const candidate =
			targetKind === "concat"
				? concat(first, ...rest)
				: coalesce(first, ...rest);
		return validCandidate(candidate, typeContext);
	}

	if (
		(currentValue.kind === "today" || currentValue.kind === "now") &&
		(targetKind === "today" || targetKind === "now")
	) {
		return targetKind === "today" ? today() : now();
	}

	return null;
}
