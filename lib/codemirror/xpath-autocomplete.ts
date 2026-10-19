/**
 * CodeMirror autocomplete for CommCare XPath expressions.
 *
 * Four completion sources:
 * 1. XPath functions — from FUNCTION_REGISTRY (~65 functions)
 * 2. Hashtag references — #form/field, #user/property, #<caseType>/property
 * 3. Data paths — /data/... paths from the current form
 * 4. Secondary instances — the ids inside `instance('…')` and the paths
 *    under a data table, places, the chosen cases, a search's results, a
 *    no-matches form's search fields and the session's values
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
import { CASE_NODE_ATTRIBUTE_PROPERTIES, caseRefAcceptMap } from "@/lib/domain";
import { FUNCTION_REGISTRY } from "@/lib/domain/expressionFunctions";
import { USER_PROPERTIES } from "@/lib/references/provider";
import type { XPathInstanceReads, XPathReferenceContext } from "./xpath-lint";

// ── Static data ────────────────────────────────────────────────────────

/** The fixed namespace prefixes — case-type prefixes are appended per-form. */
const STATIC_NAMESPACE_OPTIONS: Completion[] = [
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

/** Read the namespace (case-type/form/user) from a HashtagRef node's text. */
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

/**
 * Hashtag reference completions — uses HashtagRef and Child tree nodes.
 *
 * Exported for unit testing; production callers consume it through the
 * `xpathAutocomplete` extension below.
 */
export function hashtagSource(
	getContext: () => XPathReferenceContext | undefined,
): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		const { state, pos } = ctx;
		const tree = syntaxTree(state);
		const node = tree.resolveInner(pos, -1);

		let from: number;
		let namespace: string | undefined; // undefined = namespace stage (show prefixes)

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
				namespace = text.slice(0, slashIdx); // case-type name, "form", or "user"
			}
		} else {
			// Check for a cursor after "/" in a hashtag path (e.g. #patient/|).
			// Tree structure: Child { HashtagRef("#patient"), "/", <cursor> }
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

		const lintCtx = getContext();
		// The live case-type accept set — case-type name → readable property
		// names — narrowed by form type in ONE place (`caseRefAcceptMap`). The
		// namespace and property stages both read it so the editor offers
		// exactly what the validator accepts (no offer-then-reject). On a
		// registration form this is the own type's `case_id` only; a survey
		// form gets an empty set (it loads no case); ancestor types aren't
		// reachable until the case exists.
		const accept = lintCtx?.reachableCaseTypes
			? caseRefAcceptMap(
					lintCtx.reachableCaseTypes,
					lintCtx.formType,
					lintCtx.scope ?? "form",
				)
			: undefined;

		// Namespace stage: inside HashtagRef but no "/" typed yet — show the
		// fixed prefixes plus one per readable case type. A session-scoped
		// slot (an after-submit link) runs after the form has closed, so
		// `#form/` is withheld rather than offered and then refused.
		if (namespace === undefined) {
			const options: Completion[] = STATIC_NAMESPACE_OPTIONS.filter(
				(option) => option.label !== "#form/" || lintCtx?.scope !== "session",
			);
			if (accept) {
				for (const typeName of accept.keys()) {
					options.push({
						label: `#${typeName}/`,
						type: "namespace",
						detail: "case property",
						boost: 2,
					});
				}
			}
			return { from, options };
		}

		// Reference stage: namespace known — show properties/fields. The lint
		// context's `formEntries` already carries only value-producing fields
		// (callers filter before handing it in).
		let options: Completion[] = [];

		if (namespace === "form" && lintCtx && lintCtx.scope !== "session") {
			options = lintCtx.formEntries.map(({ path, label }) => ({
				label: `#form/${path}`,
				detail: label,
				type: "variable",
			}));
		} else if (namespace === "user") {
			const custom = lintCtx?.userProperties ?? [];
			const customSlugs = new Set(custom.map((property) => property.slug));
			options = [
				...custom.map((property) => ({
					label: `#user/${property.slug}`,
					displayLabel: property.label,
					detail: property.slug,
					type: "property",
					boost: 2,
				})),
				...USER_PROPERTIES.filter(
					(property) => !customSlugs.has(property.name),
				).map((p) => ({
					label: `#user/${p.name}`,
					detail: p.label,
					type: "property",
				})),
			];
		} else if (accept?.has(namespace)) {
			// A readable case type — offer exactly its accepted properties.
			// `case_id` is seeded into every type's index (label "case id"), so
			// every prop here has a label without a special case.
			const typeEntry = lintCtx?.reachableCaseTypes?.get(namespace);
			options = [...(accept.get(namespace) ?? [])].map((prop) => ({
				label: `#${namespace}/${prop}`,
				detail: typeEntry?.properties.get(prop)?.label,
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
	getContext: () => XPathReferenceContext | undefined,
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
		// No form paths after the form has closed: same rule as `#form/`.
		if (!lintCtx || lintCtx.scope === "session") return null;

		const options: Completion[] = [...lintCtx.validPaths].map((path) => ({
			label: path,
			type: "variable",
		}));

		if (options.length === 0) return null;
		return { from: pathRoot.from, options };
	};
}

// ── Secondary instances ────────────────────────────────────────────────

type TextOf = (from: number, to: number) => string;

/** The related-case exclusion every read of a search's results starts with. */
const SEARCH_RESULTS_ROW = "case[not(commcare_is_related_case = true())]";

/** A place's own children, readable with no level or property behind them. */
const PLACE_FIELDS = [
	"name",
	"site_code",
	"external_id",
	"latitude",
	"longitude",
] as const;

/** The instance id of an `instance('…')` call, or undefined for any other node. */
function instanceCallId(node: SyntaxNode, text: TextOf): string | undefined {
	if (node.name !== "Invoke") return undefined;
	const fn = node.getChild("FunctionName");
	if (fn === null || text(fn.from, fn.to) !== "instance") return undefined;
	const literal = node.getChild("ArgumentList")?.getChild("StringLiteral");
	return literal === null || literal === undefined
		? undefined
		: text(literal.from + 1, literal.to - 1);
}

/** A path step's name as it prints, `@` included for an attribute. */
function stepName(node: SyntaxNode | null, text: TextOf): string | undefined {
	if (node === null) return undefined;
	if (node.name === "AttrSpecified") {
		const named = stepName(node.getChild("NameTest"), text);
		return named === undefined ? undefined : `@${named}`;
	}
	if (node.name !== "NameTest" || node.firstChild !== null) return undefined;
	return text(node.from, node.to);
}

/**
 * The instance an expression reads from and the named steps below it, read
 * from the syntax tree: `instance('regions')/regions_list/regions[…]` is
 * `{ id: "regions", steps: ["regions_list", "regions"] }`. A predicate on a
 * step leaves the step's name as it is.
 */
function readInstancePath(
	node: SyntaxNode | null,
	text: TextOf,
): { readonly id: string; readonly steps: readonly string[] } | undefined {
	if (node === null) return undefined;
	if (node.name === "Invoke") {
		const id = instanceCallId(node, text);
		return id === undefined ? undefined : { id, steps: [] };
	}
	if (node.name === "Filtered") return readInstancePath(node.firstChild, text);
	if (node.name !== "Child") return undefined;
	const base = readInstancePath(node.firstChild, text);
	const step = stepName(node.lastChild, text);
	return base === undefined || step === undefined
		? undefined
		: { id: base.id, steps: [...base.steps, step] };
}

/** Whether a node is the parser's error mark for a lone opening quote. */
function isOpenQuote(node: SyntaxNode | null, text: TextOf): boolean {
	if (node === null || !node.type.isError || node.to !== node.from + 1)
		return false;
	const quote = text(node.from, node.to);
	return quote === "'" || quote === '"';
}

/**
 * Where the cursor sits inside a quoted value: the literal itself, or the
 * text after a quote not yet closed. `container` is the node the quoted
 * value is a direct child of.
 */
function quotedValueAt(
	node: SyntaxNode,
	pos: number,
	text: TextOf,
):
	| {
			readonly container: SyntaxNode;
			readonly from: number;
			readonly to: number;
	  }
	| undefined {
	if (node.name === "StringLiteral" && node.parent !== null) {
		if (pos <= node.from || pos >= node.to) return undefined;
		return { container: node.parent, from: node.from + 1, to: node.to - 1 };
	}
	let current: SyntaxNode | null = node;
	while (current !== null) {
		let child = current.firstChild;
		while (child !== null && child.from < pos) {
			if (isOpenQuote(child, text))
				return { container: current, from: child.to, to: pos };
			child = child.nextSibling;
		}
		if (current.name === "ArgumentList" || current.name === "EqualsExpr")
			return undefined;
		current = current.parent;
	}
	return undefined;
}

/** The ids `instance('…')` can read in this slot, each with what it holds. */
function instanceIds(reads: XPathInstanceReads): Completion[] {
	return [
		{ label: "casedb", detail: "Cases", type: "namespace" },
		{ label: "commcaresession", detail: "Session", type: "namespace" },
		...reads.tables.map((table) => ({
			label: table.tag,
			detail: table.name,
			type: "namespace",
		})),
		...(reads.places === undefined
			? []
			: [{ label: "locations", detail: "Places", type: "namespace" }]),
		...(reads.selectedCases === undefined
			? []
			: [
					{
						label: reads.selectedCases,
						detail: "The cases chosen together",
						type: "namespace",
					},
				]),
		...(reads.searchResults === undefined
			? []
			: [
					{
						label: "results:inline",
						detail: "What the search found",
						type: "namespace",
					},
				]),
		...(reads.searchInputs === undefined
			? []
			: [
					{
						label: "search-input:results:inline",
						detail: "The search answers",
						type: "namespace",
					},
				]),
	];
}

function step(label: string, detail?: string): Completion {
	return {
		label,
		type: label.startsWith("@") ? "property" : "variable",
		...(detail === undefined ? {} : { detail }),
	};
}

/** The values a place row offers, as a step or inside its predicate. */
function placeValues(
	places: NonNullable<XPathInstanceReads["places"]>,
	inPredicate: boolean,
): Completion[] {
	return [
		...(inPredicate
			? [{ label: "@type = '", detail: "Level", type: "keyword" }]
			: [step("@type", "Level")]),
		step("@id", "Place"),
		...places.levels.map((level) => step(`@${level.code}_id`, level.name)),
		...PLACE_FIELDS.map((field) => step(field)),
		...(inPredicate
			? places.properties.map((property) =>
					step(`location_data/${property.slug}`, property.label),
				)
			: places.properties.length > 0
				? [step("location_data/", "Place properties")]
				: []),
	];
}

/** A search result's values: the row attributes and the searched type's properties. */
function resultValues(
	results: NonNullable<XPathInstanceReads["searchResults"]>,
): Completion[] {
	return [
		...[...CASE_NODE_ATTRIBUTE_PROPERTIES].map((name) => step(`@${name}`)),
		...results.properties
			.filter((property) => !CASE_NODE_ATTRIBUTE_PROPERTIES.has(property.name))
			.map((property) => step(property.name, property.label)),
	];
}

/** The steps an instance offers after the steps already written. */
function instanceSteps(
	reads: XPathInstanceReads,
	id: string,
	steps: readonly string[],
): Completion[] {
	const at = steps.join("/");
	if (id === "commcaresession") {
		if (reads.sessionData.length === 0) return [];
		if (at === "") return [step("session/")];
		if (at === "session") return [step("data/")];
		if (at === "session/data")
			return reads.sessionData.map((datum) => step(datum.id, datum.label));
		return [];
	}
	if (id === "locations" && reads.places !== undefined) {
		if (at === "") return [step("locations/")];
		if (at === "locations") return [step("location")];
		if (at === "locations/location") return placeValues(reads.places, false);
		if (at === "locations/location/location_data")
			return reads.places.properties.map((property) =>
				step(property.slug, property.label),
			);
		return [];
	}
	if (id === reads.selectedCases) {
		if (at === "") return [step("results/")];
		if (at === "results") return [step("value")];
		return [];
	}
	if (id === "results:inline" && reads.searchResults !== undefined) {
		if (at === "") return [step("results/")];
		if (at === "results")
			return [{ ...step(SEARCH_RESULTS_ROW), detail: "What the search found" }];
		if (at === "results/case") return resultValues(reads.searchResults);
		return [];
	}
	if (
		id === "search-input:results:inline" &&
		reads.searchInputs !== undefined
	) {
		// Core's shape for a Search answer (`VirtualInstances.java::
		// buildSearchInputInstance`), the one the parser reads.
		if (at === "") return [step("input/")];
		if (at === "input")
			return reads.searchInputs.map((name) =>
				step(`field[@name = '${name}']`, "Search answer"),
			);
		return [];
	}
	const tag = id.startsWith("item-list:") ? id.slice("item-list:".length) : id;
	const table = reads.tables.find((each) => each.tag === tag);
	if (table === undefined) return [];
	if (at === "") return [step(`${tag}_list/`)];
	if (at === `${tag}_list`) return [step(tag, table.name)];
	if (at === `${tag}_list/${tag}`)
		return table.columns.map((column) => step(column.wireName, column.label));
	return [];
}

/** What a row's predicate can read: a table's columns, a place's values, a result's values. */
function rowPredicateValues(
	reads: XPathInstanceReads,
	id: string,
	steps: readonly string[],
): Completion[] {
	const at = steps.join("/");
	if (id === "locations")
		return at === "locations/location" && reads.places !== undefined
			? placeValues(reads.places, true)
			: [];
	if (id === "results:inline")
		return at === "results/case" && reads.searchResults !== undefined
			? resultValues(reads.searchResults)
			: [];
	if (id === "casedb" || id === "commcaresession") return [];
	const tag = id.startsWith("item-list:") ? id.slice("item-list:".length) : id;
	const table = reads.tables.find((each) => each.tag === tag);
	return table !== undefined && at === `${tag}_list/${tag}`
		? table.columns.map((column) => step(column.wireName, column.label))
		: [];
}

/** The predicate a node is written inside, with the expression it filters. */
function enclosingPredicate(
	node: SyntaxNode,
): { readonly filtered: SyntaxNode; readonly operand: SyntaxNode } | undefined {
	let operand: SyntaxNode = node;
	let current = node.parent;
	while (current !== null) {
		if (current.name === "Filtered")
			return current.firstChild === operand
				? undefined
				: { filtered: current, operand };
		if (!["Child", "AttrSpecified", "NameTest"].includes(current.name))
			return undefined;
		operand = current;
		current = current.parent;
	}
	return undefined;
}

/**
 * Completions for secondary-instance reads, from the syntax tree: the id
 * inside `instance('…')`, each path step below it, the values a row's
 * predicate reads, and a place's level code opposite `@type`. Quoted values
 * are this source's to complete, so it runs inside a string literal where
 * the other sources stand aside.
 *
 * Exported for unit testing; production callers consume it through the
 * `xpathAutocomplete` extension below.
 */
export function instanceSource(
	getContext: () => XPathReferenceContext | undefined,
): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		const reads = getContext()?.instanceReads;
		if (reads === undefined) return null;
		const { state, pos } = ctx;
		const text: TextOf = (from, to) => state.doc.sliceString(from, to);
		const node = syntaxTree(state).resolveInner(pos, -1);

		const quoted = quotedValueAt(node, pos, text);
		if (quoted !== undefined) {
			const { container } = quoted;
			// instance('|'): the call's one argument.
			if (container.name === "ArgumentList") {
				const fn = container.parent?.getChild("FunctionName");
				if (
					fn === null ||
					fn === undefined ||
					text(fn.from, fn.to) !== "instance" ||
					container.getChildren("StringLiteral").length > 1
				)
					return null;
				return {
					from: quoted.from,
					to: quoted.to,
					options: instanceIds(reads),
				};
			}
			// [@type = '|'] over places: the level codes.
			if (container.name === "EqualsExpr" && reads.places !== undefined) {
				const left = stepName(container.firstChild, text);
				const predicate = enclosingPredicate(container);
				const row =
					predicate === undefined
						? undefined
						: readInstancePath(predicate.filtered.firstChild, text);
				if (
					left === "@type" &&
					row?.id === "locations" &&
					row.steps.join("/") === "locations/location"
				)
					return {
						from: quoted.from,
						to: quoted.to,
						options: reads.places.levels.map((level) => ({
							label: level.code,
							detail: level.name,
							type: "constant",
						})),
					};
			}
			return null;
		}

		// A step being written: `instance('regions')/|`, `…/regions_list/reg|`, `…/location/@|`.
		const written = node.parent?.name === "AttrSpecified" ? node.parent : node;
		const parent = written.parent;
		if (
			parent?.name === "Child" &&
			parent.firstChild !== written &&
			(written.type.isError ||
				written.name === "/" ||
				written.name === "NameTest" ||
				written.name === "AttrSpecified")
		) {
			const base = readInstancePath(parent.firstChild, text);
			if (base !== undefined) {
				const options = instanceSteps(reads, base.id, base.steps);
				const from =
					written.name === "/" || written.type.isError ? pos : written.from;
				return options.length === 0 ? null : { from, options };
			}
		}

		// Inside a row's predicate: `…/regions[|`, `…/location[na|`.
		const predicate =
			node.name === "[" && node.parent?.name === "Filtered"
				? { filtered: node.parent, operand: undefined }
				: enclosingPredicate(written);
		if (predicate !== undefined) {
			const row = readInstancePath(predicate.filtered.firstChild, text);
			if (row === undefined) return null;
			const options = rowPredicateValues(reads, row.id, row.steps);
			if (options.length === 0) return null;
			const operand = predicate.operand;
			const from =
				operand === undefined || operand.type.isError ? pos : operand.from;
			return { from, options };
		}
		return null;
	};
}

/** A source that stands aside while the cursor is inside quoted text. */
function outsideQuotedValue(
	source: (ctx: CompletionContext) => CompletionResult | null,
): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
		const text: TextOf = (from, to) => ctx.state.doc.sliceString(from, to);
		return quotedValueAt(node, ctx.pos, text) === undefined
			? source(ctx)
			: null;
	};
}

// ── Factory ────────────────────────────────────────────────────────────

/** Create a CodeMirror autocomplete extension for CommCare XPath. */
export function xpathAutocomplete(
	getContext: () => XPathReferenceContext | undefined,
): Extension {
	// Suppress functions inside hashtag refs (#patient/prop), path steps and
	// quoted text, a quote not yet closed included.
	const wrappedFunctionSource = ifNotIn(
		["StringLiteral", "HashtagRef", "Child", "Descendant"],
		outsideQuotedValue(functionSource),
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
				instanceSource(getContext),
			],
			activateOnCompletion: (c) => c.label.endsWith("/"),
			icons: true,
		}),
		keymap.of(completionKeymap),
	];
}
