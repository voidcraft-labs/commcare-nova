/**
 * Proven Nova-XPath → JavaRosa lowering boundary.
 *
 * This is intentionally separate from `transpiler.ts`: that older experiment
 * contains a date-semantics transform which has no production runtime proof.
 * Wire emitters call this module, whose pass list contains only equivalences
 * verified against the real commcare-core evaluator.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "./parser";

const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((type) => type.name === name);
		if (!found) throw new Error(`Missing parser node type: ${name}`);
		return found;
	};
	return {
		Invoke: one("Invoke"),
		FunctionName: one("FunctionName"),
		ArgumentList: one("ArgumentList"),
		Comma: one(","),
		Error: one("⚠"),
	};
})();

interface SourceEdit {
	readonly from: number;
	readonly to: number;
	readonly replacement: string;
}

/**
 * Lower every Nova-only function in `source` to JavaRosa-native XPath.
 * Invalid source passes through unchanged so the validator remains the owner
 * of user-facing syntax diagnostics.
 */
export function lowerXPathForJavaRosa(source: string): string {
	if (source.trim().length === 0) return source;
	const tree = parser.parse(source);
	let hasError = false;
	tree.iterate({
		enter(cursor) {
			if (cursor.type === T.Error) hasError = true;
		},
	});
	if (hasError) return source;

	const edits: SourceEdit[] = [];
	tree.iterate({
		enter(cursor) {
			if (cursor.type !== T.Invoke) return;
			const node = cursor.node;
			const nameNode = node.getChild(T.FunctionName.id);
			if (
				nameNode === null ||
				source.slice(nameNode.from, nameNode.to) !== "normalize-space"
			) {
				return;
			}

			const argument = oneExpressionArgument(node);
			if (argument === null) return false;
			const loweredArgument = lowerXPathForJavaRosa(
				source.slice(argument.from, argument.to),
			);
			edits.push({
				from: node.from,
				to: node.to,
				replacement:
					`replace(replace(${loweredArgument}, '[ \\t\\r\\n]+', ' '), ` +
					`'^ | $', '')`,
			});
			// The recursively lowered argument already owns any nested call. Do
			// not produce overlapping edits for descendants of this invocation.
			return false;
		},
	});

	return applyEdits(source, edits);
}

function oneExpressionArgument(invoke: SyntaxNode): SyntaxNode | null {
	const args = invoke.getChild(T.ArgumentList.id);
	if (args === null) return null;
	let expression: SyntaxNode | null = null;
	let child = args.firstChild;
	while (child) {
		if (
			child.type.name !== "(" &&
			child.type.name !== ")" &&
			child.type !== T.Comma
		) {
			if (expression !== null) return null;
			expression = child;
		}
		child = child.nextSibling;
	}
	return expression;
}

function applyEdits(source: string, edits: readonly SourceEdit[]): string {
	let result = source;
	for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
		result =
			result.slice(0, edit.from) + edit.replacement + result.slice(edit.to);
	}
	return result;
}
