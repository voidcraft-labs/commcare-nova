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
import { RESOLVED_REFERENCE_NAMESPACES } from "./reservedNamespaces";
import { checkTypes } from "./typeChecker";

/**
 * One XPath-level diagnostic. `code` is the typed classification (no
 * downstream consumer re-derives it from `message`); `message` is the
 * terse human detail; `position` is the character offset into the
 * expression when known. Consumers that render a user-facing string
 * (the validation runner) switch on `code` and embed `message` as the
 * detail — they never parse `message` to recover structure.
 */
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
	/**
	 * For `INVALID_REF` on a `/data/...` path: the existing field path(s)
	 * whose leaf id matches the unknown reference's leaf — the classic
	 * "you wrote the bare id, but the field lives inside a group" mistake.
	 * Carried as the bare `/data/...` paths the walker resolved; the runner
	 * renders them in the SA's `#form/...` authoring vocabulary. Empty/absent
	 * when no field shares the leaf (a genuine typo, not a missing path
	 * segment).
	 */
	suggestions?: string[];
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
 * @param caseTypeProps - Optional per-case-type accept map (case-type name →
 *   the property names readable on it) for `#<type>/<prop>` ref checking. Built
 *   by `caseTypePropsForValidation` / the deep validator from the form's
 *   reachable case types; `undefined` skips case-ref checking entirely.
 * @param isRegistrationForm - Whether the owning form creates its case. Only
 *   changes the *message* when a case ref is rejected: on a registration form
 *   the own type is narrowed to `case_id`, so a rejected property is "not yet
 *   available" rather than "doesn't exist". The accept map already encodes the
 *   narrowing; this just lets the message say why.
 */
export function validateXPath(
	expr: string,
	validPaths?: Set<string>,
	caseTypeProps?: Map<string, Set<string>>,
	isRegistrationForm = false,
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

			// Phase 2b: Hashtag reference validation (#<type>/prop). The
			// namespace is the token between `#` and the first `/`. `#form/`,
			// `#user/`, and the transitional `#case/` are resolved by the wire,
			// not case-type refs — `checkCaseHashtag` skips them; everything else
			// names a case type. In an XPath expression a hashtag is a deliberate
			// reference, so the strict `surface: "xpath"` rule applies (an
			// unreachable namespace IS an error) — unlike the lenient prose rule.
			if (node.type === T.HashtagRef && caseTypeProps) {
				const text = expr.slice(node.from, node.to);
				const slashIdx = text.indexOf("/");
				if (slashIdx > 1) {
					const ns = text.slice(1, slashIdx);
					const rest = text.slice(slashIdx + 1);
					const message = checkCaseHashtag(
						text,
						ns,
						rest,
						caseTypeProps,
						isRegistrationForm,
						"xpath",
					);
					if (message) {
						errors.push({
							code: "INVALID_CASE_REF",
							message,
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
				const suggestions = suggestPathsByLeaf(ref, validPaths);
				errors.push({
					code: "INVALID_REF",
					message: `References unknown field path "${ref}"`,
					...(suggestions.length > 0 && { suggestions }),
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
	// Without `validPaths` or `caseTypeProps` the check is a no-op:
	// schema tooling and agent-prompt callers that don't supply context
	// shouldn't get false positives. The editor always supplies context
	// via useFormLintContext.
	if (validPaths || caseTypeProps) {
		const knownNames = collectKnownNames(validPaths, caseTypeProps);
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

/** The trailing segment of a `/data/a/b/c` path (`c`). */
function leafOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * Find existing field paths whose leaf id matches the unknown ref's leaf.
 * The common cause of an INVALID_REF is the SA writing a field's bare id
 * (`#form/consent` → `/data/consent`) when the field actually lives inside a
 * group (`/data/consent_grp/consent`) — the path must mirror the form's
 * group nesting. When one or more existing fields share the unknown ref's
 * leaf, those are exactly the paths the SA most likely meant; we return them
 * so the error can say so. Returns the matches sorted for a deterministic
 * message; an exact match of the unknown ref itself is excluded (it can't be
 * unknown and present at once, but the guard keeps the suggestion honest).
 */
function suggestPathsByLeaf(ref: string, validPaths: Set<string>): string[] {
	const leaf = leafOf(ref);
	const matches: string[] = [];
	for (const path of validPaths) {
		if (path !== ref && leafOf(path) === leaf) matches.push(path);
	}
	return matches.sort();
}

/**
 * Judge one `#<namespace>/<rest>` hashtag reference against a form's per-type
 * accept map. The single home of the case-ref validity rule, shared by the
 * XPath walker (Phase 2b above) and the deep validator's PROSE scan.
 *
 * The two surfaces are NOT judged identically — the validator must agree with
 * the wire emitter, which treats them differently:
 *
 *   - In an XPATH expression a hashtag is a deliberate reference, so an
 *     unreachable namespace is a real error (`surface: "xpath"`).
 *   - In PROSE the emitter (`xform/builder.ts::buildLabelNodes`) lowers a
 *     hashtag to `<output>` ONLY when it resolves (`#form/`, `#user/`, the
 *     transitional `#case/`, or a REACHABLE case type) and leaves everything
 *     else — innocent prose (`#N/A`, `#priority/high`), a typo'd type
 *     (`#mothre/code`), a child-type write target (`#child/name`) — as literal
 *     text with NO error. So in prose we flag a case ref ONLY when its
 *     namespace IS a reachable case type (the emitter would lower it) AND the
 *     property is invalid on that type; an unreachable namespace is innocent
 *     prose, matching the emitter's leniency (`surface: "prose"`).
 *
 * `ns` / `rest` are the namespace and property path either side of the first
 * `/`. `#form/`, `#user/`, and the transitional `#case/` are resolved by the
 * wire before any per-type lookup (`RESOLVED_REFERENCE_NAMESPACES`), so they're
 * never rejected as an unknown case type. Returns the rejection message, or
 * `undefined` when accepted (the caller owns the error `code` + `position`).
 *
 * Survey forms get an empty accept map (`caseRefAcceptMap`), so on a survey no
 * namespace is reachable — an empty map is the signal that the form loads no
 * case, and an XPath case ref there gets a survey-specific message.
 */
export function checkCaseHashtag(
	text: string,
	ns: string,
	rest: string,
	caseTypeProps: Map<string, Set<string>>,
	isRegistrationForm: boolean,
	surface: "xpath" | "prose",
): string | undefined {
	if (RESOLVED_REFERENCE_NAMESPACES.has(ns)) return undefined;
	const props = caseTypeProps.get(ns);
	if (!props) {
		// `ns` is not a reachable case type for this form.
		// PROSE matches the emitter's leniency: it lowers a prose hashtag only
		// when the namespace resolves, leaving an unreachable/innocent token as
		// literal text — so there's nothing to flag here.
		if (surface === "prose") return undefined;
		// A survey form loads no case, so its accept map is empty — there's no
		// case to read a reference from at all.
		if (caseTypeProps.size === 0) {
			return `Reference "${text}" can't resolve on a survey form. A survey form loads no case, so a case reference like "${text}" has nothing to read from here. Remove it, or change the form type to followup or close so the case is loaded.`;
		}
		return `Reference "${text}" points at case type "${ns}", which this form can't read. A form can reference its own case type or one of its ancestors (a parent in the case hierarchy). Check the case type's spelling, or whether it's actually reachable from this form.`;
	}
	if (!props.has(rest)) {
		return isRegistrationForm
			? `Reference "${text}" can't resolve on a form that creates a case. The "${ns}" case doesn't exist yet here, so only its newly-allocated id is available — not its other properties. Use "#${ns}/case_id" for the new case's id, or move this reference to a follow-up form where "${ns}" already exists.`
			: `Case type "${ns}" has no property "${rest}" (referenced as "${text}"). Add that property to "${ns}", or reference a property it already declares.`;
	}
	return undefined;
}

/**
 * Build the set of identifiers that count as a valid relative reference.
 * The leaf segment of every absolute path resolves the relative-reference
 * case (a sibling field at any depth shares its name with the relative
 * `name` reference); case property names — flattened across every reachable
 * case type — cover the case-side (a bare relative ref carries no type, so any
 * type's property counts).
 */
function collectKnownNames(
	validPaths: Set<string> | undefined,
	caseTypeProps: Map<string, Set<string>> | undefined,
): Set<string> {
	const names = new Set<string>();
	if (validPaths) {
		for (const path of validPaths) {
			const idx = path.lastIndexOf("/");
			names.add(idx >= 0 ? path.slice(idx + 1) : path);
		}
	}
	if (caseTypeProps) {
		for (const props of caseTypeProps.values()) {
			for (const prop of props) names.add(prop);
		}
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
