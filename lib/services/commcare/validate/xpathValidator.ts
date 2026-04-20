/**
 * Comprehensive XPath validator — Lezer CST tree walker.
 *
 * Performs two-phase validation in a single pass over the parse tree:
 * 1. Syntax: Detects Lezer error nodes (⚠) for malformed expressions
 * 2. Semantics: Validates function names, argument counts, and node references
 *
 * Same architecture as TypeScript's checker or Rust's type checker — the parser
 * gives us structure, this walker gives us semantics.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";
import { extractPathRefs } from "@/lib/preview/xpath/dependencies";
import {
	FUNCTION_REGISTRY,
	findCaseInsensitiveMatch,
} from "./functionRegistry";
import { checkTypes } from "./typeChecker";

export interface XPathError {
	code:
		| "XPATH_SYNTAX"
		| "UNKNOWN_FUNCTION"
		| "WRONG_ARITY"
		| "INVALID_REF"
		| "INVALID_CASE_REF"
		| "TYPE_ERROR";
	message: string;
	position?: number;
}

// Pre-resolve node types for zero string comparisons at runtime
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Missing parser node type: ${name}`);
		return found;
	};
	const many = (name: string) => new Set(all.filter((t) => t.name === name));
	return {
		Invoke: one("Invoke"),
		FunctionName: one("FunctionName"),
		ArgumentList: one("ArgumentList"),
		Comma: one(","),
		HashtagRef: one("HashtagRef"),
		Error: one("⚠"),
		Children: many("Child"),
		Descendants: many("Descendant"),
	};
})();

/**
 * Validate an XPath expression. Walks every node in the parse tree.
 *
 * @param expr - The XPath expression string
 * @param validPaths - Optional set of valid /data/... paths for node ref checking
 * @param caseProperties - Optional set of valid case property names for #case/ ref checking
 */
export function validateXPath(
	expr: string,
	validPaths?: Set<string>,
	caseProperties?: Set<string>,
): XPathError[] {
	if (!expr) return [];

	const tree = parser.parse(expr);
	const errors: XPathError[] = [];

	// Walk every node in the tree
	tree.iterate({
		enter(node) {
			// Phase 1: Syntax errors — Lezer's own error recovery nodes
			if (node.type === T.Error) {
				const context = expr.slice(
					Math.max(0, node.from - 10),
					Math.min(expr.length, node.to + 10),
				);
				errors.push({
					code: "XPATH_SYNTAX",
					message: `Syntax error near "${context.trim()}"`,
					position: node.from,
				});
				return;
			}

			// Phase 2a: Function call validation
			if (node.type === T.Invoke) {
				validateFunctionCall(node.node, expr, errors);
				return;
			}

			// Phase 2b: Hashtag reference validation (#case/prop)
			if (node.type === T.HashtagRef && caseProperties) {
				const text = expr.slice(node.from, node.to);
				if (text.startsWith("#case/")) {
					const prop = text.slice(6); // after "#case/"
					if (!caseProperties.has(prop)) {
						errors.push({
							code: "INVALID_CASE_REF",
							message: `Unknown case property "${prop}" in ${text}`,
							position: node.from,
						});
					}
				}
			}
		},
	});

	// Phase 2c: Path reference validation (/data/... refs must exist)
	if (validPaths) {
		const refs = extractPathRefs(expr);
		for (const ref of refs) {
			if (!validPaths.has(ref)) {
				errors.push({
					code: "INVALID_REF",
					message: `References unknown field path "${ref}"`,
				});
			}
		}
	}

	// Phase 3: Type checking — bottom-up inference + constraint validation
	const typeErrors = checkTypes(expr);
	for (const err of typeErrors) {
		errors.push({ ...err, position: err.position });
	}

	return errors;
}

/** Validate a single function call node (Invoke). */
function validateFunctionCall(
	node: SyntaxNode,
	source: string,
	errors: XPathError[],
): void {
	// Extract function name
	const nameNode = node.getChild(T.FunctionName.id);
	if (!nameNode) return;

	const funcName = source.slice(nameNode.from, nameNode.to);

	// Look up in registry
	const spec = FUNCTION_REGISTRY.get(funcName);
	if (!spec) {
		// Check for case-insensitive match to give helpful suggestion
		const suggestion = findCaseInsensitiveMatch(funcName);
		if (suggestion) {
			errors.push({
				code: "UNKNOWN_FUNCTION",
				message: `Unknown function "${funcName}()" — did you mean "${suggestion}()"? Function names are case-sensitive`,
				position: nameNode.from,
			});
		} else {
			errors.push({
				code: "UNKNOWN_FUNCTION",
				message: `Unknown function "${funcName}()"`,
				position: nameNode.from,
			});
		}
		return;
	}

	// Count arguments
	const argList = node.getChild(T.ArgumentList.id);
	if (!argList) return;

	const argCount = countArguments(argList, source);

	// Check custom validate first
	if (spec.validate) {
		const err = spec.validate(argCount);
		if (err) {
			errors.push({
				code: "WRONG_ARITY",
				message: `${funcName}() called with ${argCount} argument${argCount !== 1 ? "s" : ""}: ${err}`,
				position: nameNode.from,
			});
			return;
		}
	}

	// Check min/max
	if (argCount < spec.minArgs) {
		errors.push({
			code: "WRONG_ARITY",
			message: `${funcName}() requires ${spec.minArgs === spec.maxArgs ? `exactly ${spec.minArgs}` : `at least ${spec.minArgs}`} argument${spec.minArgs !== 1 ? "s" : ""}, got ${argCount}`,
			position: nameNode.from,
		});
	} else if (spec.maxArgs !== -1 && argCount > spec.maxArgs) {
		errors.push({
			code: "WRONG_ARITY",
			message: `${funcName}() accepts at most ${spec.maxArgs} argument${spec.maxArgs !== 1 ? "s" : ""}, got ${argCount}`,
			position: nameNode.from,
		});
	}
}

/** Count comma-separated arguments in an ArgumentList node. */
function countArguments(argList: SyntaxNode, _source: string): number {
	// Empty parens = 0 args
	let child = argList.firstChild;
	let hasExpr = false;
	let commas = 0;

	while (child) {
		if (child.type === T.Comma) {
			commas++;
		} else if (child.type.id !== T.ArgumentList.id) {
			// Skip open/close parens which are anonymous tokens
			const name = child.type.name;
			if (name !== "(" && name !== ")") {
				hasExpr = true;
			}
		}
		child = child.nextSibling;
	}

	if (!hasExpr && commas === 0) return 0;
	return commas + 1;
}
