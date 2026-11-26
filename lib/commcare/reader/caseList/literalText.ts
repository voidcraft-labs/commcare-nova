import type { FormSyntax } from "../../xpath/formSyntax";

/** The text a string literal spells, or a `concat` of string literals, which is how a literal
 *  holding both quote marks is printed. */
export function literalText(node: FormSyntax | undefined): string | undefined {
	if (node?.kind === "string") return node.value;
	if (node?.kind !== "call" || node.name !== "concat") return undefined;
	let out = "";
	for (const arg of node.args) {
		const part = literalText(arg);
		if (part === undefined) return undefined;
		out += part;
	}
	return out;
}
