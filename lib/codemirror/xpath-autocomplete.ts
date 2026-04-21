/**
 * CodeMirror autocomplete for CommCare XPath expressions.
 *
 * Three completion sources:
 * 1. XPath functions — from FUNCTION_REGISTRY (~65 functions)
 * 2. Hashtag references — #case/property, #form/field, #user/property
 * 3. Data paths — /data/... paths from the current form
 *
 * All context detection uses Lezer syntax tree node types (HashtagRef, Child,
 * Descendant, NameTest) rather than regex pattern matching. Node text is only
 * read from identified tree nodes (e.g. extracting the namespace from an
 * opaque HashtagRef token).
 */

import {
	autocompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
	completionKeymap,
	ifNotIn,
	snippetCompletion,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { FUNCTION_REGISTRY } from "@/lib/commcare/validator/functionRegistry";
import { USER_PROPERTIES } from "@/lib/references/provider";
import type { XPathLintContext } from "./xpath-lint";

// ── Static data ────────────────────────────────────────────────────────

const NAMESPACE_OPTIONS: Completion[] = [
	{ label: "#case/", type: "namespace", detail: "case property", boost: 2 },
	{ label: "#form/", type: "namespace", detail: "form field", boost: 1 },
	{ label: "#user/", type: "namespace", detail: "user property", boost: 0 },
];

/** Build snippet template for a function based on its spec. */
function buildFunctionTemplate(
	name: string,
	minArgs: number,
	paramTypes?: string[],
): string {
	if (minArgs === 0) return `${name}()`;
	const params = Array.from({ length: minArgs }, (_, i) => {
		const label = paramTypes?.[i] ?? "";
		return label ? `\${${i + 1}:${label}}` : `\${${i + 1}}`;
	});
	return `${name}(${params.join(", ")})`;
}

/** Cached function completions — built once at module level. */
const functionCompletions: Completion[] = (() => {
	const completions: Completion[] = [];
	for (const [name, spec] of FUNCTION_REGISTRY) {
		const template = buildFunctionTemplate(name, spec.minArgs, spec.paramTypes);
		const arityLabel =
			spec.maxArgs === -1
				? `${spec.minArgs}+`
				: spec.minArgs === spec.maxArgs
					? `${spec.minArgs}`
					: `${spec.minArgs}-${spec.maxArgs}`;
		completions.push(
			snippetCompletion(template, {
				label: name,
				detail: `(${arityLabel}) -> ${spec.returnType}`,
				type: "function",
			}),
		);
	}
	return completions;
})();

// ── Helpers ────────────────────────────────────────────────────────────

function isPathNode(node: SyntaxNode): boolean {
	return node.name === "Child" || node.name === "Descendant";
}

/**
 * Walk up through consecutive path nodes to find the root,
 * then check if the first NameTest is "data".
 */
function findDataPathRoot(node: SyntaxNode): SyntaxNode | null {
	// Walk up to the first path node ancestor
	let current: SyntaxNode | null = node;
	while (current && !isPathNode(current)) current = current.parent;
	if (!current) return null;

	// Continue up through consecutive path nodes to find the root
	let pathRoot = current;
	while (pathRoot.parent && isPathNode(pathRoot.parent))
		pathRoot = pathRoot.parent;

	return pathRoot;
}

/** Read the namespace (case/form/user) from a HashtagRef node's doc text. */
function readHashtagNamespace(
	node: SyntaxNode,
	doc: { sliceString(from: number, to: number): string },
): string {
	// HashtagRef node text is "#prefix/path/..." — namespace is the first segment after #
	const text = doc.sliceString(node.from + 1, node.to); // skip "#"
	const slashIdx = text.indexOf("/");
	return slashIdx >= 0 ? text.slice(0, slashIdx) : text;
}

// ── Completion sources ─────────────────────────────────────────────────

/** XPath function completions — uses NameTest/FunctionName tree nodes. */
function functionSource(ctx: CompletionContext): CompletionResult | null {
	const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
	if (node.name === "NameTest" || node.name === "FunctionName") {
		return { from: node.from, options: functionCompletions };
	}
	// Explicit trigger (Ctrl+Space) at an arbitrary position
	return ctx.explicit ? { from: ctx.pos, options: functionCompletions } : null;
}

/** Hashtag reference completions — uses HashtagRef and Child tree nodes. */
function hashtagSource(
	getContext: () => XPathLintContext | undefined,
): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		const { state, pos } = ctx;
		const tree = syntaxTree(state);
		const node = tree.resolveInner(pos, -1);

		let from: number;
		let namespace: string | undefined; // undefined = Phase 1 (show prefixes)

		// Find HashtagRef — cursor may resolve to the node itself or a child
		// (HashtagType, HashtagSegment, or the localName token inside them)
		const hashtagAncestor =
			node.name === "HashtagRef"
				? node
				: node.parent?.name === "HashtagRef"
					? node.parent
					: node.parent?.parent?.name === "HashtagRef"
						? node.parent?.parent
						: null;

		if (hashtagAncestor) {
			from = hashtagAncestor.from;
			const text = state.doc.sliceString(hashtagAncestor.from + 1, pos); // text typed so far, skip "#"
			const slashIdx = text.indexOf("/");
			if (slashIdx >= 0) {
				namespace = text.slice(0, slashIdx); // "case", "form", or "user"
			}
		} else {
			// Check for cursor after "/" in a path chain rooted at HashtagRef (e.g. #case/|)
			// Tree structure: Child { HashtagRef("#case"), "/", <cursor> }
			let current: SyntaxNode | null = node;
			while (current && !isPathNode(current)) current = current.parent;
			if (!current) return null;

			// Walk up through consecutive path nodes
			let pathRoot = current;
			while (pathRoot.parent && isPathNode(pathRoot.parent))
				pathRoot = pathRoot.parent;

			// Walk down-left to find the anchor node
			let left = pathRoot;
			while (left.firstChild && isPathNode(left.firstChild))
				left = left.firstChild;

			if (left.firstChild?.name !== "HashtagRef") return null;

			from = left.firstChild.from;
			namespace = readHashtagNamespace(left.firstChild, state.doc);
		}

		// Phase 1: inside HashtagRef but no "/" typed yet — show namespace prefixes
		if (namespace === undefined) {
			return { from, options: NAMESPACE_OPTIONS };
		}

		// Phase 2: namespace known — show properties/fields. The lint
		// context is pre-collected at the call site: `caseProperties` is a
		// name→{label?} map, and `formEntries` already carries only the
		// value-producing fields (callers filter before handing it in).
		const lintCtx = getContext();
		let options: Completion[] = [];

		if (namespace === "case" && lintCtx?.caseProperties) {
			options = [...lintCtx.caseProperties.entries()].map(([name, meta]) => ({
				label: `#case/${name}`,
				detail: meta.label,
				type: "property",
			}));
		} else if (namespace === "form" && lintCtx) {
			options = lintCtx.formEntries.map(({ path, label }) => ({
				label: `#form/${path}`,
				detail: label,
				type: "variable",
			}));
		} else if (namespace === "user") {
			options = USER_PROPERTIES.map((p) => ({
				label: `#user/${p.name}`,
				detail: p.label,
				type: "property",
			}));
		}

		if (options.length === 0) return null;

		/* Suppress the dropdown when the typed text already exactly matches a
       known reference — the chip is rendered and there's nothing to complete. */
		const typed = state.doc.sliceString(from, pos);
		if (options.some((o) => o.label === typed)) return null;

		return { from, options };
	};
}

/** /data/... path completions — uses Child/Descendant + NameTest tree nodes. */
function dataPathSource(
	getContext: () => XPathLintContext | undefined,
): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		const { state, pos } = ctx;
		const node = syntaxTree(state).resolveInner(pos, -1);

		const pathRoot = findDataPathRoot(node);
		if (!pathRoot) return null;

		// Walk down-left to find the first NameTest — must be "data"
		let left = pathRoot;
		while (left.firstChild && isPathNode(left.firstChild))
			left = left.firstChild;
		const firstNameTest = left.getChild("NameTest");
		if (!firstNameTest) return null;
		if (state.doc.sliceString(firstNameTest.from, firstNameTest.to) !== "data")
			return null;

		const lintCtx = getContext();
		if (!lintCtx) return null;

		const options: Completion[] = [...lintCtx.validPaths].map((path) => ({
			label: path,
			type: "variable",
		}));

		if (options.length === 0) return null;
		return { from: pathRoot.from, options };
	};
}

// ── Factory ────────────────────────────────────────────────────────────

/** Create a CodeMirror autocomplete extension for CommCare XPath. */
export function xpathAutocomplete(
	getContext: () => XPathLintContext | undefined,
): Extension {
	// Suppress functions inside hashtag refs (#case/prop) and path steps (/data/step)
	const wrappedFunctionSource = ifNotIn(
		["StringLiteral", "HashtagRef", "Child", "Descendant"],
		functionSource,
	);
	const wrappedHashtagSource = ifNotIn(
		["StringLiteral"],
		hashtagSource(getContext),
	);
	const wrappedDataPathSource = ifNotIn(
		["StringLiteral"],
		dataPathSource(getContext),
	);

	return [
		autocompletion({
			override: [
				wrappedFunctionSource,
				wrappedHashtagSource,
				wrappedDataPathSource,
			],
			activateOnCompletion: (c) => c.label.endsWith("/"),
			icons: true,
		}),
		keymap.of(completionKeymap),
	];
}
