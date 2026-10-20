import {
	type ExpressionNode,
	expressionChildren,
} from "@/lib/domain/expression/children";
import {
	type ExpressionContext,
	withFormContextNode,
} from "@/lib/domain/expression/context";
import { relativePath } from "@/lib/domain/expression/relativePath";
import {
	type Expression,
	type FormNodeRef,
	formNodeKey,
	isRelationPath,
	type Term,
} from "@/lib/domain/expression/types";
import type { FormNodeProjection } from "../formNodeProjection";
import { w } from "./builders";
import type { WireExpr, WirePath, WireStep } from "./tree";

export type FormReadTerm = Extract<
	Term,
	{ kind: "field" | "form-node" | "repeat-row" }
>;

export interface FormRead {
	readonly node: FormNodeRef;
	readonly kind: "value" | "cardinality";
}

/** Exact reads of finite form nodes. Navigation through a parent is not a
 * read of that parent. Native trigger ordering uses both kinds; live-count
 * feedback can additionally distinguish a row's existence from its value. */
export function formReads(expression: Expression): readonly FormRead[] {
	const reads = new Map<string, FormRead>();
	const visit = (node: ExpressionNode, kind: FormRead["kind"]): void => {
		if (
			node.kind === "field" ||
			node.kind === "form-node" ||
			node.kind === "repeat-row"
		) {
			const identity = formReadNode(node);
			reads.set(`${kind}:${formNodeKey(identity)}`, { node: identity, kind });
		}
		for (const child of expressionChildren(node)) {
			if (child.kind === "relation") continue;
			let childKind: FormRead["kind"] = "value";
			if (
				node.kind === "count" &&
				!isRelationPath(node.via) &&
				child.role.kind === "operand" &&
				child.role.slot === "via"
			)
				childKind = "cardinality";
			else if (
				kind === "cardinality" &&
				(node.kind === "term" ||
					node.kind === "coalesce" ||
					(node.kind === "if" &&
						child.role.kind === "operand" &&
						child.role.slot !== "cond") ||
					(node.kind === "switch" &&
						((child.role.kind === "switch-case" &&
							child.role.slot === "then") ||
							(child.role.kind === "operand" &&
								child.role.slot === "fallback"))))
			)
				childKind = kind;
			visit(child.value, childKind);
		}
	};
	visit(expression, "value");
	return [...reads.values()];
}

/** A leaf's identity is independent of the path spelling that reaches it. */
export function formReadNode(term: FormReadTerm): FormNodeRef {
	switch (term.kind) {
		case "field":
			return {
				kind: "field",
				uuid: term.uuid,
				...(term.role === undefined ? {} : { role: term.role }),
			};
		case "repeat-row":
			return {
				kind: "repeat-row",
				repeat: term.repeat,
				attribute: term.attribute,
			};
		case "form-node":
			return term.node;
	}
}

/** Lower one form read from the shared identity graph. The source slot remains
 * current()'s origin while predicates replace only the lexical context node. */
export function formReadToWire(
	term: FormReadTerm,
	types: ExpressionContext,
	projection: FormNodeProjection,
	emit: (expression: Expression, context: ExpressionContext) => WireExpr,
): WirePath {
	const target = formReadNode(term);
	const coordinates = projection.graph.path(target);
	if (coordinates === undefined)
		throw new Error(
			`The form read '${formNodeKey(target)}' has no declared instance coordinate. Check the owning form supplied to wire emission.`,
		);
	const filters = new Map(
		(term.filters ?? []).map((filter) => [formNodeKey(filter.step), filter]),
	);
	for (const [key] of filters) {
		if (!coordinates.some((node) => formNodeKey(node) === key))
			throw new Error(
				`The filtered form step '${key}' is not on the read's identity path. The expression must pass the form-path checker before emission.`,
			);
	}
	const step = (node: FormNodeRef): WireStep => {
		const name = projection.step(node);
		if (name === undefined)
			throw new Error(
				`The form node '${formNodeKey(node)}' has no emitted name. Check the form-node projection at this compile boundary.`,
			);
		const filter = filters.get(formNodeKey(node));
		const predicates =
			filter?.where.map((where) =>
				emit(where, withFormContextNode(types, node)),
			) ?? [];
		return name.attribute
			? w.attr(name.name, predicates)
			: w.step(name.name, predicates);
	};
	const defaultValue =
		types.slot.entity === "field" && types.slot.slot === "default_value";
	const spelling =
		defaultValue &&
		(term.spelling === undefined || term.spelling === "absolute")
			? "current"
			: term.spelling;
	// An authored `/data/...` read and its `#form/...` twin are one read to
	// Vellum: both take the hashtag root, so the shadow exists, and is
	// withheld, exactly where it is for `#form/`. Outside Vellum mode the root
	// prints `/data` either way, so runtime bytes never depend on this.
	if (spelling === undefined || spelling === "absolute")
		return w.form(coordinates.slice(1).map(step), "hashtag");
	const origin = spelling === "current" ? types.sourceNode : types.contextNode;
	const from = origin === undefined ? undefined : projection.graph.path(origin);
	if (from === undefined)
		throw new Error(
			`The ${spelling} form read has no source coordinate. Supply the actual slot context before emitting a relative form path.`,
		);
	const firstFiltered = coordinates.findIndex((node) =>
		filters.has(formNodeKey(node)),
	);
	const path = relativePath(
		from,
		coordinates,
		(left, right) => formNodeKey(left) === formNodeKey(right),
		firstFiltered < 0 ? undefined : firstFiltered,
	);
	const steps = [
		...Array.from({ length: path.up }, () => w.parent()),
		...path.down.map(step),
	];
	if (steps.length === 0) steps.push(w.self());
	return spelling === "current" ? w.current(steps) : w.context(steps);
}
