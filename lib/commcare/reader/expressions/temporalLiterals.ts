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
 * gives; `canonical.ts`'s `coerced-instant-literal` returns the same.) A
 * membership's values are compared with its subject, so they are typed again
 * once the subject's own literals are.
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
import { chargeWork, rethrowWorkStop } from "../../workMeter";
import { readTypesGiven, valueBranches } from "./canonical";

type Temporal = "date" | "datetime" | "time";
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

/** The date, the date and time or the time an untyped literal names by its
 *  spelling. */
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
	return shape === "date" || shape === "datetime" || shape === "time"
		? shape
		: undefined;
}

/** Whether `expression` holds an untyped literal spelled as a date, a date
 *  and time or a time anywhere: only such a tree has a literal to type. */
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
			found = shape === "date" || shape === "datetime" || shape === "time";
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
	} catch (error) {
		rethrowWorkStop(error);
		return NONE;
	}
	if (type === "date" || type === "datetime" || type === "time")
		return new Set([type]);
	return ordering && (type === undefined || type === "_any") ? BOTH : NONE;
}

/**
 * `expression`, the whole value of a record slot read in `context`, with each
 * untyped literal spelled as a date or a date and time typed by its shape
 * where its position requires that type. It types nothing else and never
 * takes a type away, so a reading's own choices (a comparison of moments
 * folded to an integer) stand.
 *
 * One pass, each node visited once: a node's children are visited first with
 * nothing required of them, then the node types what its own rule requires of
 * the positions under it from what those visits returned (a comparison's side
 * by the other side, a range's bounds and subject by one another, a date
 * function's date, a branch node's branches by the types its branches give).
 * A requirement reaches a literal only at the position itself or through a
 * branch node's branches, so `typedBy` descends only there, and each
 * branch node remembers what its branches were typed by, so a later
 * requirement types only what that one added. Each visit and each step of a
 * requirement is a unit of the work meter's `visit` door, and each comparison
 * charges the walk to its side and the side's size, which the checker types.
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
	/** What each branch node a visit returned has typed its branches by. */
	const applied = new WeakMap<Expression, ReadonlySet<Temporal>>();
	/** The nodes of each subtree a visit returned. */
	const sizes = new WeakMap<object, number>();
	const sizeOf = (node: object): number => sizes.get(node) ?? 1;

	/** `node`'s children visited, each once, with nothing required of them. */
	const children = <T extends Expression | Term>(
		node: T,
		path: CheckPath,
	): T => {
		let size = 1;
		const out = mapExpressionChildren(
			node,
			(child) => {
				const visited =
					child.kind === "expression"
						? visit(child.value, child.path)
						: child.kind === "term"
							? children(child.value, child.path)
							: child.value;
				if (typeof visited === "object" && visited !== null)
					size += sizeOf(visited);
				return visited;
			},
			path,
		);
		sizes.set(out, size);
		return out;
	};

	/** `node`, visited already, with `requiredAt` of each child's path required of that child. */
	const requireAt = (
		node: Expression,
		path: CheckPath,
		requiredAt: (relative: readonly unknown[]) => ReadonlySet<Temporal>,
	): Expression => {
		const out = mapExpressionChildren(
			node,
			(child) =>
				child.kind === "expression"
					? typedBy(
							child.value,
							child.path,
							requiredAt(child.path.slice(path.length)),
						)
					: child.value,
			path,
		);
		sizes.set(out, sizeOf(node));
		return out;
	};

	/** The relative paths of `node`'s branches, where it is a branch node. */
	const branchPaths = (
		node: Expression,
		path: CheckPath,
	): ReadonlySet<string> | undefined => {
		const branching = valueBranches(node, path);
		return branching === undefined
			? undefined
			: new Set(
					branching.branches.map((branch) =>
						JSON.stringify(branch.path.slice(path.length)),
					),
				);
	};

	/** `node`, visited already, with `required` required of its value: the literal it is typed,
	 *  or each branch of a branch node typed by `required` beside what its branches give. */
	const typedBy = (
		node: Expression,
		path: CheckPath,
		required: ReadonlySet<Temporal>,
	): Expression => {
		if (required.size === 0) return node;
		chargeWork("visit", 1);
		const shape = untypedTemporal(node);
		if (shape !== undefined) {
			if (!required.has(shape) || node.kind !== "term") return node;
			return {
				kind: "term",
				term: { ...node.term, data_type: shape } as Term,
			};
		}
		const branches = branchPaths(node, path);
		if (branches === undefined) return node;
		const before =
			applied.get(node) ?? readTypesGiven(node, path, root, context);
		const given = new Set<Temporal>(before);
		for (const type of required) given.add(type);
		if (given.size === before.size) return node;
		const out = requireAt(node, path, (relative) =>
			branches.has(JSON.stringify(relative)) ? given : NONE,
		);
		applied.set(out, given);
		return out;
	};

	/** What a side compared at `path` requires of the other, the side's walk and size charged. */
	const requiredBy = (
		other: Expression,
		path: CheckPath,
		ordering: boolean,
	): ReadonlySet<Temporal> => {
		chargeWork("visit", path.length + sizeOf(other));
		return comparedRequires(other, path, root, context, ordering);
	};

	/** `node` visited with nothing required of its own value. */
	const visit = (node: Expression, path: CheckPath): Expression => {
		chargeWork("visit", 1);
		if (untypedTemporal(node) !== undefined) return node;
		const read = children(node, path);
		const branches = branchPaths(read, path);
		if (branches !== undefined) {
			// The branches give their types to the literals beside them.
			const given = readTypesGiven(read, path, root, context);
			const out =
				given.size === 0
					? read
					: requireAt(read, path, (relative) =>
							branches.has(JSON.stringify(relative)) ? given : NONE,
						);
			applied.set(out, given);
			return out;
		}
		if (read.kind === "format-date" || read.kind === "date-add")
			return requireAt(read, path, (relative) =>
				relative.length === 1 && relative[0] === "date" ? BOTH : NONE,
			);
		if (COMPARISONS.has(read.kind) && "left" in read && "right" in read) {
			const ordering = ORDERINGS.has(read.kind);
			const left = typedBy(
				read.left,
				[...path, "left"],
				requiredBy(read.right, [...path, "right"], ordering),
			);
			const right = typedBy(
				read.right,
				[...path, "right"],
				requiredBy(read.left, [...path, "left"], ordering),
			);
			if (left === read.left && right === read.right) return read;
			const out = { ...read, left, right };
			sizes.set(out, sizeOf(read));
			return out;
		}
		if (read.kind === "between") {
			const bound = requiredBy(read.left, [...path, "left"], true);
			// The subject is ordered against each bound, as a comparison's side is.
			const subject = new Set<Temporal>();
			for (const [side, at] of [
				[read.lower, "lower"],
				[read.upper, "upper"],
			] as const)
				if (side !== undefined)
					for (const type of requiredBy(side, [...path, at], true))
						subject.add(type);
			return requireAt(read, path, (relative) =>
				relative.length !== 1
					? NONE
					: relative[0] === "lower" || relative[0] === "upper"
						? bound
						: relative[0] === "left"
							? subject
							: NONE,
			);
		}
		if (read.kind === "in") {
			// Each value is compared with the subject, typed by now.
			const given = requiredBy(read.left, [...path, "left"], false);
			const values = read.values.map((value) => {
				if (
					value.kind !== "literal" ||
					value.data_type !== undefined ||
					typeof value.value !== "string"
				)
					return value;
				const shape = literalShape(value.value)?.type;
				return (shape === "date" || shape === "datetime" || shape === "time") &&
					given.has(shape)
					? { ...value, data_type: shape }
					: value;
			});
			if (!values.some((value, index) => value !== read.values[index]))
				return read;
			const out = { ...read, values: values as typeof read.values };
			sizes.set(out, sizeOf(read));
			return out;
		}
		return read;
	};

	return typedBy(visit(expression, []), [], rootRequires);
}
