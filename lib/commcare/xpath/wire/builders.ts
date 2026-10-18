import type { InstanceDecl } from "./instances";
import type {
	WireArithmetic,
	WireComparison,
	WireExpr,
	WireFunction,
	WirePath,
	WireRoot,
	WireStep,
} from "./tree";

function path(root: WireRoot, steps: readonly WireStep[] = []): WirePath {
	return { k: "path", root, steps };
}

function step(name: string, predicates: readonly WireExpr[] = []): WireStep {
	return { axis: "child", name, predicates };
}

function call(fn: WireFunction, args: readonly WireExpr[] = []): WireExpr {
	return { k: "call", fn, args };
}

function cmp(op: WireComparison, left: WireExpr, right: WireExpr): WireExpr {
	return { k: "cmp", op, left, right };
}

function arith(op: WireArithmetic, left: WireExpr, right: WireExpr): WireExpr {
	return { k: "arith", op, left, right };
}

function logical(k: "and" | "or", items: readonly WireExpr[]): WireExpr {
	const flat = items.flatMap((item) => (item.k === k ? item.items : [item]));
	if (flat.length === 0) return call(k === "and" ? "true" : "false");
	if (flat.length === 1) return flat[0];
	return { k, items: [flat[0], flat[1], ...flat.slice(2)] };
}

function indexVariable(
	k: "enum-label-var" | "hq-enum-var",
	index: number,
): WireExpr {
	if (!Number.isSafeInteger(index) || index < 0)
		throw new Error(
			"A generated label variable needs a nonnegative integer index.",
		);
	return { k, index };
}

/** The sole constructors used by generated scaffolding and expression lowering. */
export const w = {
	str: (value: string): WireExpr => ({ k: "str", value }),
	num: (value: number): WireExpr => {
		if (!Number.isFinite(value))
			throw new Error("A wire number must be finite.");
		return { k: "num", value };
	},
	cmp,
	eq: (left: WireExpr, right: WireExpr) => cmp("=", left, right),
	ne: (left: WireExpr, right: WireExpr) => cmp("!=", left, right),
	lt: (left: WireExpr, right: WireExpr) => cmp("<", left, right),
	lte: (left: WireExpr, right: WireExpr) => cmp("<=", left, right),
	gt: (left: WireExpr, right: WireExpr) => cmp(">", left, right),
	gte: (left: WireExpr, right: WireExpr) => cmp(">=", left, right),
	arith,
	add: (left: WireExpr, right: WireExpr) => arith("+", left, right),
	sub: (left: WireExpr, right: WireExpr) => arith("-", left, right),
	mul: (left: WireExpr, right: WireExpr) => arith("*", left, right),
	div: (left: WireExpr, right: WireExpr) => arith("div", left, right),
	mod: (left: WireExpr, right: WireExpr) => arith("mod", left, right),
	and: (...items: readonly WireExpr[]) => logical("and", items),
	or: (...items: readonly WireExpr[]) => logical("or", items),
	not: (value: WireExpr) => call("not", [value]),
	neg: (value: WireExpr): WireExpr => ({ k: "neg", value }),
	call,
	path,
	step,
	wildcard: (predicates: readonly WireExpr[] = []): WireStep => ({
		axis: "wildcard",
		predicates,
	}),
	attr: (name: string, predicates: readonly WireExpr[] = []): WireStep => ({
		axis: "attribute",
		name,
		predicates,
	}),
	self: (predicates: readonly WireExpr[] = []): WireStep => ({
		axis: "self",
		predicates,
	}),
	parent: (predicates: readonly WireExpr[] = []): WireStep => ({
		axis: "parent",
		predicates,
	}),
	instance: (decl: InstanceDecl, steps: readonly WireStep[] = []) =>
		path({ k: "instance", decl }, steps),
	current: (steps: readonly WireStep[] = []) => path({ k: "current" }, steps),
	context: (steps: readonly WireStep[] = []) => path({ k: "context" }, steps),
	hqCase: (steps: readonly WireStep[] = []) => path({ k: "hq-case" }, steps),
	form: (
		parts: readonly string[] | readonly WireStep[],
		spelling: "hashtag" | "absolute" = "absolute",
	) =>
		path(
			{ k: "form", spelling },
			parts.map((part) => (typeof part === "string" ? step(part) : part)),
		),
	append: (base: WirePath, steps: readonly WireStep[]) =>
		path(base.root, [...base.steps, ...steps]),
	expansion: (of: "case" | "worker" | "search", expr: WireExpr): WireExpr => ({
		k: "expansion",
		of,
		expr,
	}),
	caseIdVar: (): WireExpr => ({ k: "case-id-var" }),
	nextInputVar: (): WireExpr => ({ k: "next-input-var" }),
	calculatedPropertyVar: (): WireExpr => ({ k: "calculated-property-var" }),
	enumLabelVar: (index: number) => indexVariable("enum-label-var", index),
	imageAltVar: (value: string): WireExpr => ({ k: "image-alt-var", value }),
	hqEnumVar: (index: number) => indexVariable("hq-enum-var", index),
	endpointArgumentVar: (name: string): WireExpr => ({
		k: "endpoint-argument-var",
		name,
	}),
} as const;
