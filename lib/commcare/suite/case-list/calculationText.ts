import type { Uuid } from "@/lib/domain/uuid";
import type { WireExpr } from "../../xpath/wire/tree";

/** The source spelling is scoped to one calculation. All names end with the
 * complete, equal-width identity, so HQ's replacements cannot overlap each other. */
export function caseTextWireKey(uuid: Uuid, padding = 0): string {
	return `${"v".repeat(padding)}case_text_${uuid.replaceAll("-", "")}`;
}

/** HQ substitutes the key across its entire stored expression, including
 * quoted text, property names and resolved lookup names. Choose a spelling
 * absent from those actual wire lexemes before writing either the variable
 * or its enum entry. Padding is numeric on the wire tree, so a projection
 * asking for the keys of an already bound expression gets the same answers. */
export function caseTextKeyPadding(
	wire: WireExpr,
	texts: readonly { uuid: Uuid }[],
): Map<Uuid, number> {
	const padding = new Map<Uuid, number>();
	if (!texts.length) return padding;
	const occupied = new Set<string>();
	const seen = new Set<object>();
	const pending: unknown[] = [wire];
	while (pending.length) {
		const value = pending.pop();
		if (typeof value === "string" && value.includes("case_text_"))
			occupied.add(value);
		if (value && typeof value === "object" && !seen.has(value)) {
			seen.add(value);
			for (const child of Object.values(value)) pending.push(child);
		}
	}
	if (!occupied.size) return padding;
	for (const { uuid } of texts) {
		let count = 0;
		const key = caseTextWireKey(uuid);
		for (const lexeme of occupied) {
			let position = lexeme.indexOf(key);
			while (position !== -1) {
				let prefix = position;
				while (prefix > 0 && lexeme[prefix - 1] === "v") prefix--;
				count = Math.max(count, position - prefix + 1);
				position = lexeme.indexOf(key, position + key.length);
			}
		}
		if (count) padding.set(uuid, count);
	}
	return padding;
}

export function bindCaseTextVariables(
	wire: WireExpr,
	padding: ReadonlyMap<Uuid, number>,
): WireExpr {
	if (!padding.size) return wire;
	// Several generated expressions share subtrees. Keep them shared so the
	// serializer's own per-node caches also apply after a spelling is padded.
	const bound = new WeakMap<WireExpr, WireExpr>();
	function bind(node: WireExpr): WireExpr {
		const previous = bound.get(node);
		if (previous) return previous;
		const result = bindChildren(node);
		bound.set(node, result);
		return result;
	}
	function bindChildren(node: WireExpr): WireExpr {
		switch (node.k) {
			case "case-text-variable":
				return { ...node, padding: padding.get(node.textUuid) };
			case "arith":
			case "cmp":
				return { ...node, left: bind(node.left), right: bind(node.right) };
			case "and":
			case "or": {
				const [first, second, ...rest] = node.items;
				return {
					...node,
					items: [bind(first), bind(second), ...rest.map(bind)],
				};
			}
			case "neg":
				return { ...node, value: bind(node.value) };
			case "paren":
			case "expansion":
				return { ...node, expr: bind(node.expr) };
			case "call":
				return { ...node, args: node.args.map(bind) };
			case "path":
				return {
					...node,
					steps: node.steps.map((step) => ({
						...step,
						predicates: step.predicates.map(bind),
					})),
				};
			default:
				return node;
		}
	}
	return bind(wire);
}
