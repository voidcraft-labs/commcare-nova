/**
 * Where a record slot's literal spelled as a date or a date and time is
 * typed. A typed date or date-and-time literal prints the same text as the
 * untyped literal of that text wherever both can stand, so the one a reading
 * gives is decided by the position the literal stands in, never by the print:
 * typed by its own shape where the position requires a date or a date and
 * time, and untyped everywhere else (`canonical.ts`, `untyped-value-literal`,
 * gives the untyped one there).
 *
 * A position requires one where the checker refuses the text there: the date
 * a function's signature takes (`format-date`'s and `date-add`'s), an operand
 * compared with a value of that type or ordered against a value of no known
 * type (a `between`'s bounds against its subject among them), the whole value
 * of a slot that expects one, and each branch of an `if`, `coalesce`,
 * `switch` or `cond` that stands in such a position or beside a branch that
 * gives one. Nothing else does: a `concat`'s part, the value of `date()`,
 * `datetime()` or `double()`, and the whole value of a slot that expects no
 * type each take the text as it is. (A `datetime()` of a literal that a
 * device folds prints the literal of its own instant text, which the reading
 * gives; `canonical.ts`'s `coerced-instant-literal` returns the same.)
 */
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { mapExpressionChildren } from "@/lib/domain/expression/mapAst";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import {
	expressionContextAtPath,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import type {
	CheckPath,
	Expression,
	Term,
} from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { readTypesGiven, valueBranches } from "./canonical";

type Temporal = "date" | "datetime";
const NONE: ReadonlySet<Temporal> = new Set();
const BOTH: ReadonlySet<Temporal> = new Set(["date", "datetime"]);
const ORDERINGS: ReadonlySet<Expression["kind"]> = new Set([
	"gt",
	"gte",
	"lt",
	"lte",
]);
const COMPARISONS: ReadonlySet<Expression["kind"]> = new Set([
	...ORDERINGS,
	"eq",
	"neq",
]);

/** The date or the date and time an untyped literal names by its spelling. */
function untypedTemporal(node: Expression): Temporal | undefined {
	if (node.kind !== "term") return undefined;
	const term = node.term;
	if (
		term.kind !== "literal" ||
		term.data_type !== undefined ||
		typeof term.value !== "string"
	)
		return undefined;
	const shape = literalShape(term.value)?.type;
	return shape === "date" || shape === "datetime" ? shape : undefined;
}

/** Whether `expression` holds an untyped literal spelled as a date or a date
 *  and time anywhere: only such a tree has a literal to type. */
export function holdsUntypedTemporalLiteral(expression: Expression): boolean {
	let found = false;
	walkExpressionTerms(expression, (term) => {
		if (
			!found &&
			term.kind === "literal" &&
			term.data_type === undefined &&
			typeof term.value === "string"
		) {
			const shape = literalShape(term.value)?.type;
			found = shape === "date" || shape === "datetime";
		}
	});
	return found;
}

/** Whether every value `node` gives is a literal spelled as a date or a
 *  date and time, typed or not: such a value says nothing of the type of
 *  what it stands against. */
function givesOnlyLiterals(node: Expression, path: CheckPath): boolean {
	if (node.kind === "term" && node.term.kind === "literal") {
		const shape =
			typeof node.term.value === "string"
				? literalShape(node.term.value)?.type
				: undefined;
		return shape === "date" || shape === "datetime";
	}
	const branching = valueBranches(node, path);
	return (
		branching?.branches.every((branch) =>
			givesOnlyLiterals(branch.value, branch.path),
		) === true
	);
}

/** The types an operand at `path` of `root` requires of a literal it is
 *  compared with: its own date or date and time, both where it is of no known
 *  type in an ordering, and none otherwise. */
function comparedRequires(
	other: Expression,
	path: CheckPath,
	root: Expression,
	context: ExpressionContext,
	ordering: boolean,
): ReadonlySet<Temporal> {
	if (givesOnlyLiterals(other, path)) return ordering ? BOTH : NONE;
	const given = readTypesGiven(other, path, root, context);
	if (given.size > 0) return given;
	let type: string | undefined;
	try {
		const at =
			path.length === 0
				? context
				: expressionContextAtPath(root, context, path);
		type = scalarDataType(typeOf(other, at)?.data);
	} catch {
		return NONE;
	}
	if (type === "date" || type === "datetime") return new Set([type]);
	return ordering && (type === undefined || type === "_any") ? BOTH : NONE;
}

/**
 * `expression`, the whole value of a record slot read in `context`, with each
 * untyped literal spelled as a date or a date and time typed by its shape
 * where its position requires that type. It types nothing else and never
 * takes a type away, so a reading's own choices (a comparison of moments
 * folded to an integer) stand.
 */
export function typedWhereRequired(
	expression: Expression,
	context: ExpressionContext,
): Expression {
	if (context.ruleSet !== "record" || !holdsUntypedTemporalLiteral(expression))
		return expression;
	const expectation = context.profile.expectation;
	const rootRequires: ReadonlySet<Temporal> =
		expectation.kind === "value" &&
		(expectation.type === "date" || expectation.type === "datetime")
			? new Set([expectation.type])
			: NONE;
	const root = expression;

	const visitTerm = (term: Term, path: CheckPath): Term =>
		mapExpressionChildren(
			term,
			(child) =>
				child.kind === "expression"
					? visit(child.value, child.path, NONE)
					: child.kind === "term"
						? visitTerm(child.value, child.path)
						: child.value,
			path,
		);

	/** `node`'s children visited, each with what `requires` says its own
	 *  path requires. */
	const children = (
		node: Expression,
		path: CheckPath,
		requires: (childPath: CheckPath) => ReadonlySet<Temporal>,
	): Expression =>
		mapExpressionChildren(
			node,
			(child) =>
				child.kind === "expression"
					? visit(child.value, child.path, requires(child.path))
					: child.kind === "term"
						? visitTerm(child.value, child.path)
						: child.value,
			path,
		);

	const visit = (
		node: Expression,
		path: CheckPath,
		required: ReadonlySet<Temporal>,
	): Expression => {
		const shape = untypedTemporal(node);
		if (shape !== undefined) {
			if (!required.has(shape) || node.kind !== "term") return node;
			return {
				kind: "term",
				term: { ...node.term, data_type: shape } as Term,
			};
		}
		const branching = valueBranches(node, path);
		if (branching !== undefined) {
			const branchKeys = new Set(
				branching.branches.map((branch) => JSON.stringify(branch.path)),
			);
			const atBranches =
				(given: ReadonlySet<Temporal>) => (childPath: CheckPath) =>
					branchKeys.has(JSON.stringify(childPath)) ? given : NONE;
			// The branches are read first, so a branch the position types
			// gives its type to the literals beside it.
			const read = children(node, path, atBranches(required));
			const given = new Set<Temporal>(required);
			for (const type of readTypesGiven(read, path, root, context))
				given.add(type);
			return given.size === required.size
				? read
				: children(read, path, atBranches(given));
		}
		if (node.kind === "format-date" || node.kind === "date-add") {
			const date = JSON.stringify([...path, "date"]);
			return children(node, path, (childPath) =>
				JSON.stringify(childPath) === date ? BOTH : NONE,
			);
		}
		if (COMPARISONS.has(node.kind) && "left" in node && "right" in node) {
			const ordering = ORDERINGS.has(node.kind);
			const read = children(node, path, () => NONE) as typeof node;
			const left = visit(
				read.left,
				[...path, "left"],
				comparedRequires(
					read.right,
					[...path, "right"],
					root,
					context,
					ordering,
				),
			);
			const right = visit(
				read.right,
				[...path, "right"],
				comparedRequires(read.left, [...path, "left"], root, context, ordering),
			);
			return left === read.left && right === read.right
				? read
				: { ...read, left, right };
		}
		if (node.kind === "between") {
			const read = children(node, path, () => NONE);
			if (read.kind !== "between") return read;
			const bound = comparedRequires(
				read.left,
				[...path, "left"],
				root,
				context,
				true,
			);
			return children(read, path, (childPath) =>
				childPath.at(-1) === "lower" || childPath.at(-1) === "upper"
					? bound
					: NONE,
			);
		}
		return children(node, path, () => NONE);
	};

	return visit(expression, [], rootRequires);
}
