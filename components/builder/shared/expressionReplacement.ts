import {
	checkValueExpression,
	coalesce,
	concat,
	dateCoerce,
	datetimeCoerce,
	double,
	formatDate,
	now,
	type TypeContext,
	today,
	unwrapList,
	type ValueExpression,
} from "@/lib/domain/predicate";

const UNARY_KINDS = new Set<ValueExpression["kind"]>([
	"date-coerce",
	"datetime-coerce",
	"double",
	"unwrap-list",
]);

function buildUnary(
	targetKind: ValueExpression["kind"],
	value: ValueExpression,
): ValueExpression | null {
	switch (targetKind) {
		case "date-coerce":
			return dateCoerce(value);
		case "datetime-coerce":
			return datetimeCoerce(value);
		case "double":
			return double(value);
		case "unwrap-list":
			return unwrapList(value);
		default:
			return null;
	}
}

function validCandidate(
	candidate: ValueExpression,
	typeContext: TypeContext,
): ValueExpression | null {
	return checkValueExpression(candidate, typeContext).ok ? candidate : null;
}

/**
 * Plan only the expression-kind changes that retain every authored child and
 * still satisfy the target operator's own operand rules. A null result means
 * the UI must explain the loss and wait for confirmation before using a fresh
 * target default.
 *
 * Date and datetime coercion are true structural twins and always retain the
 * same child, including a legacy-invalid imported child. Other unary carriers
 * look alike in JSON but accept different child types, so they preserve only
 * when the complete candidate passes the real expression checker.
 */
export function planPreservedExpressionReplacement(
	currentValue: ValueExpression,
	targetKind: ValueExpression["kind"],
	typeContext: TypeContext,
): ValueExpression | null {
	if (currentValue.kind === "term") {
		let candidate: ValueExpression | null;
		switch (targetKind) {
			case "date-coerce":
			case "datetime-coerce":
			case "double":
			case "unwrap-list":
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
			currentValue.kind === "datetime-coerce") &&
		(targetKind === "date-coerce" || targetKind === "datetime-coerce")
	) {
		return buildUnary(targetKind, currentValue.value);
	}

	if (
		UNARY_KINDS.has(currentValue.kind) &&
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
