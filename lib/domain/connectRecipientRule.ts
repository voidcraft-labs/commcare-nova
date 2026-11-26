import type { BlueprintDoc } from "./blueprint";
import { and, eq, literal, matchAll, term } from "./expression/builders";
import type { Expression } from "./expression/types";
import type { Uuid } from "./uuid";

/** PostgreSQL limits these strings by Unicode code points. Core's string-length
 * counts UTF-16 code units, while Java Pattern advances dot by one code point. */
export const CONNECT_RECIPIENT_PATTERN = "\\A(?s:.{0,255})\\z";

/** The predicate on the repeat step keeps Core from restricting the path
 * to the current row when the worker validates an answer in that row. */
export function connectRecipientRule(
	repeat: Uuid,
	recipient: Uuid,
): Expression {
	const values: Expression = {
		kind: "term",
		term: {
			kind: "field",
			uuid: recipient,
			filters: [{ step: { kind: "field", uuid: repeat }, where: [matchAll()] }],
		},
	};
	const joinedLength = (input: Expression): Expression => ({
		kind: "call",
		fn: "string-length",
		args: [{ kind: "call", fn: "join", args: [term(literal("|")), input] }],
	});
	return and(
		{
			kind: "matches-pattern",
			left: term({ kind: "field", uuid: recipient, spelling: "relative" }),
			pattern: CONNECT_RECIPIENT_PATTERN,
		},
		eq(
			joinedLength(values),
			joinedLength({ kind: "call", fn: "distinct-values", args: [values] }),
		),
	);
}

/** Recognize the worker's rule from identities, including a stronger
 * conjunction. A nonempty separator makes dropping even a duplicate blank
 * shorten the joined string. No comparison trims, folds case or casts an ID. */
function hasConnectRecipientRule(
	expression: Expression,
	repeat: Uuid,
	recipient: Uuid,
): boolean {
	if (expression.kind === "and")
		return expression.clauses.some((clause) =>
			hasConnectRecipientRule(clause, repeat, recipient),
		);
	if (expression.kind !== "eq") return false;
	function joined(side: Expression) {
		if (
			side.kind !== "call" ||
			side.fn !== "string-length" ||
			side.args.length !== 1
		)
			return undefined;
		const join = side.args[0];
		if (join?.kind !== "call" || join.fn !== "join" || join.args.length !== 2)
			return undefined;
		const [separator, values] = join.args;
		if (
			separator?.kind !== "term" ||
			separator.term.kind !== "literal" ||
			typeof separator.term.value !== "string" ||
			separator.term.value === ""
		)
			return undefined;
		const distinct = values?.kind === "call" && values.fn === "distinct-values";
		const source =
			distinct && values.args.length === 1 ? values.args[0] : values;
		if (
			source?.kind !== "term" ||
			source.term.kind !== "field" ||
			source.term.role !== undefined ||
			source.term.uuid !== recipient ||
			(source.term.spelling !== undefined &&
				source.term.spelling !== "absolute") ||
			source.term.filters?.length !== 1
		)
			return undefined;
		const [filter] = source.term.filters;
		if (
			filter.step.kind !== "field" ||
			filter.step.uuid !== repeat ||
			filter.step.role !== undefined ||
			filter.where.length !== 1 ||
			filter.where[0]?.kind !== "match-all"
		)
			return undefined;
		return { separator: separator.term.value, distinct };
	}
	const left = joined(expression.left),
		right = joined(expression.right);
	return (
		left !== undefined &&
		right !== undefined &&
		left.separator === right.separator &&
		left.distinct !== right.distinct
	);
}

export function canAskConnectRecipient(
	doc: BlueprintDoc,
	repeat: Uuid,
): boolean {
	const rows = doc.fields[repeat];
	return (
		rows?.kind === "repeat" &&
		rows.repeat_mode === "user_controlled" &&
		rows.relevant === undefined &&
		doc.forms[doc.fieldParent[repeat]] !== undefined
	);
}

/** A text answer visited in every contributing row, with no initial value
 * that can bypass entry. This witness covers a single repeat directly in
 * the form; two separately entered outer rows restart the inner field path. */
export function workerChecksConnectRecipient(
	doc: BlueprintDoc,
	repeat: Uuid,
	recipient: Uuid,
): boolean {
	const answer = doc.fields[recipient];
	if (
		!canAskConnectRecipient(doc, repeat) ||
		answer?.kind !== "text" ||
		doc.fieldParent[recipient] !== repeat ||
		answer.relevant !== undefined ||
		answer.default_value !== undefined ||
		answer.validate === undefined
	)
		return false;
	const required = answer.required;
	if (
		required?.kind !== "match-all" &&
		!(
			required?.kind === "term" &&
			required.term.kind === "literal" &&
			required.term.value === true
		)
	)
		return false;
	return hasConnectRecipientRule(answer.validate, repeat, recipient);
}
