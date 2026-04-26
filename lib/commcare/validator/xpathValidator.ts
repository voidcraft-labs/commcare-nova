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

import type { NodeType, SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";
import { extractPathRefs } from "@/lib/preview/xpath/dependencies";
import {
	FUNCTION_REGISTRY,
	findCaseInsensitiveMatch,
} from "./functionRegistry";
import { checkTypes } from "./typeChecker";

interface XPathError {
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
		NameTest: one("NameTest"),
		AttrSpecified: one("AttrSpecified"),
		AxisSpecified: one("AxisSpecified"),
		Filtered: one("Filtered"),
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

	// Phase 2d: Relative-reference validation. XPath parses any bare
	// identifier as a NameTest (`child::name`), so a typo like `kldfnfkj`
	// is syntactically legal — it just refers to a child element with
	// that name. Without this phase, every junk string on a `validate` /
	// `relevant` / `required` XPath saves and waits to fail at runtime.
	//
	// A NameTest's semantic role depends on its parent in the AST:
	//   - inside Child / Descendant → path segment (Phase 2c handles paths)
	//   - inside HashtagRef → hashtag segment (Phase 2b handles those)
	//   - inside AttrSpecified (@foo) → attribute name (we don't model attrs)
	//   - inside AxisSpecified (axis::foo) → axis-qualified step (skipped)
	//   - inside the predicate position of Filtered → relative-to-context,
	//     the schema doesn't tell us what's valid in that scope
	//   - everywhere else (top-level expression, operator operand, function
	//     argument) → relative reference to a sibling field, validate
	//     against a known-name set
	//
	// `walkValuePositions` recursively descends the AST and only visits
	// children that are value positions, mirroring how a real semantic
	// checker resolves names. No exclusion list to drift out of date —
	// each node type explicitly declares which children are references.
	//
	// Without `validPaths` or `caseProperties` the check is a no-op:
	// schema tooling and agent-prompt callers that don't supply context
	// shouldn't get false positives. The editor always supplies context
	// via useFormLintContext.
	if (validPaths || caseProperties) {
		const knownNames = collectKnownNames(validPaths, caseProperties);
		walkValuePositions(tree.topNode, expr, (name, position) => {
			if (!knownNames.has(name)) {
				errors.push({
					code: "INVALID_REF",
					message: `Unknown reference "${name}"`,
					position,
				});
			}
		});
	}

	// Phase 3: Type checking — bottom-up inference + constraint validation
	const typeErrors = checkTypes(expr);
	for (const err of typeErrors) {
		errors.push({ ...err, position: err.position });
	}

	return errors;
}

/**
 * Build the set of identifiers that count as a valid relative reference.
 * The leaf segment of every absolute path resolves the relative-reference
 * case (a sibling field at any depth shares its name with the relative
 * `name` reference); case property names cover the case-side.
 */
function collectKnownNames(
	validPaths: Set<string> | undefined,
	caseProperties: Set<string> | undefined,
): Set<string> {
	const names = new Set<string>();
	if (validPaths) {
		for (const path of validPaths) {
			const idx = path.lastIndexOf("/");
			names.add(idx >= 0 ? path.slice(idx + 1) : path);
		}
	}
	if (caseProperties) {
		for (const prop of caseProperties) names.add(prop);
	}
	return names;
}

/**
 * Recursive descent that visits expression-position children of `node` and
 * invokes `emit` for every relative-reference NameTest it reaches. Each
 * node type explicitly declares which of its children carry expression
 * semantics; non-expression children (path segments, attribute names,
 * predicate context, function names) are skipped at the source.
 */
function walkValuePositions(
	node: SyntaxNode,
	source: string,
	emit: (name: string, position: number) => void,
): void {
	const t = node.type;

	// Reached a value-position NameTest — it's a relative reference.
	if (t === T.NameTest) {
		emit(source.slice(node.from, node.to), node.from);
		return;
	}

	// Path expressions, attribute / axis steps, and hashtags are all
	// validated by other phases (or intentionally not validated for lack of
	// schema). Their NameTest children are not value-position references.
	if (
		isPathNode(t) ||
		t === T.AttrSpecified ||
		t === T.AxisSpecified ||
		t === T.HashtagRef
	) {
		return;
	}

	// Function calls: skip the FunctionName, recurse into argument
	// expressions. Phase 2a validates the function name itself.
	// `getChild` matches by the type ID (see also `validateFunctionCall`).
	if (t === T.Invoke) {
		const argList = node.getChild(T.ArgumentList.id);
		if (argList) {
			let arg = argList.firstChild;
			while (arg) {
				walkValuePositions(arg, source, emit);
				arg = arg.nextSibling;
			}
		}
		return;
	}

	// Filtered = `expr [ predicate ]`. The first expr is a value position
	// (the path being filtered); the predicate is evaluated relative to the
	// filtered node's context, which the form schema can't describe — skip.
	if (t === T.Filtered) {
		const filtered = node.firstChild;
		if (filtered) walkValuePositions(filtered, source, emit);
		return;
	}

	// Default: every direct child is a value position (binary / unary
	// operators, parenthesized exprs, the top XPath node, etc.).
	let child = node.firstChild;
	while (child) {
		walkValuePositions(child, source, emit);
		child = child.nextSibling;
	}
}

/** Lezer emits separate node types per grammar production for `Child` and
 *  `Descendant`; `T.Children` / `T.Descendants` are sets of those duplicates. */
function isPathNode(t: NodeType): boolean {
	return T.Children.has(t) || T.Descendants.has(t);
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
