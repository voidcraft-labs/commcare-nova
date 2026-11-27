import type { Uuid } from "@/lib/domain/uuid";
import type { WireExpr } from "../../xpath/wire/tree";

/** The source spelling is scoped to one calculation. All names end with the
 * complete, equal-width identity, so HQ's replacements cannot overlap each other. */
export function caseTextWireKey(uuid: Uuid, variant = 0): string {
	return `${caseTextKeyPrefix(variant)}case_text_${uuid.replaceAll("-", "")}`;
}

const VARIANT_HEX_WIDTH = 8;
const NUMBERED_PREFIX_LENGTH = VARIANT_HEX_WIDTH + 2;

function caseTextKeyPrefix(variant: number): string {
	if (variant === 0) return "";
	if (variant === 1) return "v";
	return `v${variant.toString(16).padStart(VARIANT_HEX_WIDTH, "0")}_`;
}

/** HQ substitutes the key across the stored expression. Find unused spellings
 * among the actual wire lexemes before writing either a variable or its enum
 * entry. Numbered prefixes have fixed width even in a long source literal. */
export function caseTextKeyVariants(
	wire: WireExpr,
	texts: readonly { uuid: Uuid }[],
): Map<Uuid, number> {
	const variants = new Map<Uuid, number>();
	if (!texts.length) return variants;
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
	if (!occupied.size) return variants;
	for (const { uuid } of texts) {
		const prefixes = new Set<string>();
		const key = caseTextWireKey(uuid);
		for (const lexeme of occupied) {
			let position = lexeme.indexOf(key);
			while (position !== -1) {
				prefixes.add("");
				if (lexeme[position - 1] === "v") prefixes.add("v");
				if (position >= NUMBERED_PREFIX_LENGTH)
					prefixes.add(
						lexeme.slice(position - NUMBERED_PREFIX_LENGTH, position),
					);
				position = lexeme.indexOf(key, position + key.length);
			}
		}
		let variant = 0;
		while (prefixes.has(caseTextKeyPrefix(variant))) variant++;
		if (variant) variants.set(uuid, variant);
	}
	return variants;
}

export function bindCaseTextVariables(
	wire: WireExpr,
	variants: ReadonlyMap<Uuid, number>,
): WireExpr {
	if (!variants.size) return wire;
	// Several generated expressions share subtrees. Keep them shared so the
	// serializer's own per-node caches also apply after the names are bound.
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
				return { ...node, variant: variants.get(node.textUuid) };
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
