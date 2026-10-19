import { instantMicros } from "../instant";
import type { WireExpr } from "../tree";

/** The operand `instant.ts::instantMicros` reads, when `wire` is that
 * parse: read structurally from the tree, never from its text. */
export function instantMicrosOperand(wire: WireExpr): WireExpr | undefined {
	if (wire.k !== "arith" || wire.op !== "+") return undefined;
	const fraction = wire.right;
	if (fraction.k !== "call" || fraction.fn !== "if") return undefined;
	const test = fraction.args[0];
	if (test?.k !== "call" || test.fn !== "starts-with") return undefined;
	const tail = test.args[0];
	if (tail?.k !== "call" || tail.fn !== "substr") return undefined;
	const operand = tail.args[0];
	return operand !== undefined && sameWire(wire, instantMicros(operand))
		? operand
		: undefined;
}

function sameWire(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	)
		return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) =>
		sameWire(
			(a as Record<string, unknown>)[key],
			(b as Record<string, unknown>)[key],
		),
	);
}

/** Every node of a wire tree, read structurally. */
export function wireNodes(wire: WireExpr): WireExpr[] {
	const found: WireExpr[] = [];
	const visit = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if ("k" in value) found.push(value as WireExpr);
		for (const child of Object.values(value)) visit(child);
	};
	visit(wire);
	return found;
}

/** The literal texts an instant parse can read: each string literal its
 * operand is, or chooses as a branch of an `if` or a value of a `coalesce`. */
export function parsedLiteralTexts(wire: WireExpr): readonly string[] {
	const texts: string[] = [];
	const branch = (text: WireExpr): void => {
		if (text.k === "str") texts.push(text.value);
		else if (text.k === "call" && text.fn === "if") {
			const [, whenTrue, whenFalse] = text.args;
			if (whenTrue !== undefined) branch(whenTrue);
			if (whenFalse !== undefined) branch(whenFalse);
		} else if (text.k === "call" && text.fn === "coalesce")
			for (const value of text.args) branch(value);
	};
	for (const node of wireNodes(wire)) {
		const operand = instantMicrosOperand(node);
		if (operand !== undefined) branch(operand);
	}
	return texts;
}
