/**
 * CodeMirror autocomplete for form expressions.
 *
 * Completion sources, each built from the slot's editor context, so what is
 * offered at a position is what the parser binds and the checker admits
 * there:
 * 1. XPath functions — from FUNCTION_REGISTRY
 * 2. Hashtag references — #form/field, #user/property, #<caseType>/property
 * 3. Data paths — /data/... paths from the current form
 * 4. Relative steps — the questions `../` and `./` reach from the slot
 * 5. Secondary instances — the ids inside `instance('…')`, the paths under
 *    records, a data table, places, the chosen cases, a search's results, a
 *    no-matches form's search fields and the session, each row's predicate,
 *    and the quoted values opposite a record type, a level or a static
 *    select's answer
 *
 * All context detection uses Lezer syntax tree node types rather than regex
 * pattern matching, compared as the editor tree's `NodeType`s
 * (`xpathNodeType`). Node text is only read from identified tree nodes.
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
import type { NodeType, SyntaxNode } from "@lezer/common";
import { CASE_NODE_ATTRIBUTE_PROPERTIES, caseRefAcceptMap } from "@/lib/domain";
import { FUNCTION_REGISTRY } from "@/lib/domain/expressionFunctions";
import { USER_PROPERTIES } from "@/lib/references/provider";
import type {
	ExpressionEditorContext,
	ExpressionReads,
	NamedRead,
} from "./expressionEditorContext";
import type { FormReferenceContext } from "./formReferenceContext";
import { xpathNodeTypes } from "./xpath-language";

// ── Node types ─────────────────────────────────────────────────────────

const T = {
	XPath: xpathNodeTypes("XPath"),
	Child: xpathNodeTypes("Child"),
	Descendant: xpathNodeTypes("Descendant"),
	NameTest: xpathNodeTypes("NameTest"),
	FunctionName: xpathNodeTypes("FunctionName"),
	HashtagRef: xpathNodeTypes("HashtagRef"),
	Invoke: xpathNodeTypes("Invoke"),
	ArgumentList: xpathNodeTypes("ArgumentList"),
	StringLiteral: xpathNodeTypes("StringLiteral"),
	Filtered: xpathNodeTypes("Filtered"),
	AttrSpecified: xpathNodeTypes("AttrSpecified"),
	EqualsExpr: xpathNodeTypes("EqualsExpr"),
	NotEqualsExpr: xpathNodeTypes("NotEqualsExpr"),
	AndExpr: xpathNodeTypes("AndExpr"),
	OrExpr: xpathNodeTypes("OrExpr"),
	ParentStep: xpathNodeTypes("ParentStep"),
	SelfStep: xpathNodeTypes("SelfStep"),
	Slash: xpathNodeTypes("/"),
	OpenBracket: xpathNodeTypes("["),
} as const;

function is(node: SyntaxNode, types: ReadonlySet<NodeType>): boolean {
	return types.has(node.type);
}

/** `is` for a node that may be absent: present and of these types. */
function isNode(
	node: SyntaxNode | null | undefined,
	types: ReadonlySet<NodeType>,
): node is SyntaxNode {
	return node !== null && node !== undefined && types.has(node.type);
}

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
	return is(node, T.Child) || is(node, T.Descendant);
}

/**
 * Walk up through consecutive path nodes to find the root,
 * then check if the first NameTest is "data".
 */
function findDataPathRoot(node: SyntaxNode): SyntaxNode | null {
	let current: SyntaxNode | null = node;
	while (current && !isPathNode(current)) current = current.parent;
	if (!current) return null;
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
	if (is(node, T.NameTest) || is(node, T.FunctionName)) {
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
	getReference: () => FormReferenceContext | undefined,
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
			[node, node.parent, node.parent?.parent].find(
				(candidate): candidate is SyntaxNode => isNode(candidate, T.HashtagRef),
			) ?? null;

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

			let pathRoot = current;
			while (pathRoot.parent && isPathNode(pathRoot.parent))
				pathRoot = pathRoot.parent;

			let left = pathRoot;
			while (left.firstChild && isPathNode(left.firstChild))
				left = left.firstChild;

			if (!isNode(left.firstChild, T.HashtagRef)) return null;

			from = left.firstChild.from;
			namespace = readHashtagNamespace(left.firstChild, state.doc);
		}

		const reference = getReference();
		// The live case-type accept set — case-type name → readable property
		// names — narrowed by form type in ONE place (`caseRefAcceptMap`). The
		// namespace and property stages both read it so the editor offers
		// exactly what the checker accepts (no offer-then-reject). On a
		// registration form this is the own type's `case_id` only; a survey
		// form gets an empty set (it loads no case); ancestor types aren't
		// reachable until the case exists.
		const accept = reference?.reachableCaseTypes
			? caseRefAcceptMap(
					reference.reachableCaseTypes,
					reference.formType,
					reference.scope ?? "form",
				)
			: undefined;

		// Namespace stage: inside HashtagRef but no "/" typed yet — show the
		// fixed prefixes plus one per readable case type. A session-scoped
		// slot (an after-submit link) runs after the form has closed, so
		// `#form/` is withheld rather than offered and then refused.
		if (namespace === undefined) {
			const options: Completion[] = STATIC_NAMESPACE_OPTIONS.filter(
				(option) => option.label !== "#form/" || reference?.scope !== "session",
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

		// Reference stage: namespace known — show properties/fields. The
		// reference context's `formEntries` already carries only
		// value-producing fields.
		let options: Completion[] = [];

		if (namespace === "form" && reference && reference.scope !== "session") {
			options = reference.formEntries.map(({ path, label }) => ({
				label: `#form/${path}`,
				detail: label,
				type: "variable",
			}));
		} else if (namespace === "user") {
			const custom = reference?.userProperties ?? [];
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
			const typeEntry = reference?.reachableCaseTypes?.get(namespace);
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
	getReference: () => FormReferenceContext | undefined,
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

		const reference = getReference();
		// No form paths after the form has closed: same rule as `#form/`.
		if (!reference || reference.scope === "session") return null;

		const options: Completion[] = [...reference.validPaths].map((path) => ({
			label: path,
			type: "variable",
		}));

		if (options.length === 0) return null;
		return { from: pathRoot.from, options };
	};
}

// ── Paths ──────────────────────────────────────────────────────────────

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
	if (!is(node, T.Invoke)) return undefined;
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
	if (is(node, T.AttrSpecified)) {
		const named = stepName(node.getChild("NameTest"), text);
		return named === undefined ? undefined : `@${named}`;
	}
	if (!is(node, T.NameTest) || node.firstChild !== null) return undefined;
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
	if (is(node, T.Invoke)) {
		const id = instanceCallId(node, text);
		return id === undefined ? undefined : { id, steps: [] };
	}
	if (is(node, T.Filtered)) return readInstancePath(node.firstChild, text);
	if (!is(node, T.Child)) return undefined;
	const base = readInstancePath(node.firstChild, text);
	const step = stepName(node.lastChild, text);
	return base === undefined || step === undefined
		? undefined
		: { id: base.id, steps: [...base.steps, step] };
}

/** The steps of a relative path written so far: `../grp` is `["..", "grp"]`. */
function readRelativePath(
	node: SyntaxNode | null,
	text: TextOf,
): readonly string[] | undefined {
	if (node === null) return undefined;
	if (is(node, T.ParentStep)) return [".."];
	if (is(node, T.SelfStep)) return ["."];
	if (!is(node, T.Child)) return undefined;
	const base = readRelativePath(node.firstChild, text);
	const step = stepName(node.lastChild, text);
	return base === undefined || step === undefined || step.startsWith("@")
		? undefined
		: [...base, step];
}

/** Whether a path starts with `..` or `.`, so it leaves the row it is in. */
function startsRelative(node: SyntaxNode | undefined): boolean {
	let current: SyntaxNode | null = node ?? null;
	while (current !== null && is(current, T.Child)) current = current.firstChild;
	return isNode(current, T.ParentStep) || isNode(current, T.SelfStep);
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
			readonly quote: number;
			readonly from: number;
			readonly to: number;
	  }
	| undefined {
	if (is(node, T.StringLiteral) && node.parent !== null) {
		if (pos <= node.from || pos >= node.to) return undefined;
		return {
			container: node.parent,
			quote: node.from,
			from: node.from + 1,
			to: node.to - 1,
		};
	}
	let current: SyntaxNode | null = node;
	while (current !== null) {
		let child = current.firstChild;
		while (child !== null && child.from < pos) {
			if (isOpenQuote(child, text))
				return {
					container: current,
					quote: child.from,
					from: child.to,
					to: pos,
				};
			child = child.nextSibling;
		}
		if (
			is(current, T.ArgumentList) ||
			is(current, T.EqualsExpr) ||
			is(current, T.NotEqualsExpr)
		)
			return undefined;
		current = current.parent;
	}
	return undefined;
}

/** The ids `instance('…')` can read in this slot, each with what it holds. */
function instanceIds(reads: ExpressionReads): Completion[] {
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

function named(reads: readonly NamedRead[]): Completion[] {
	return reads.map((read) => step(read.name, read.label));
}

/** The values a place row offers, as a step or inside its predicate. */
function placeValues(
	places: NonNullable<ExpressionReads["places"]>,
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

/** A case row's value, as it prints: the four row attributes with `@`. */
function caseValueName(name: string): string {
	return CASE_NODE_ATTRIBUTE_PROPERTIES.has(name) ? `@${name}` : name;
}

/** A search result's values: the row attributes and the searched type's properties. */
function resultValues(
	results: NonNullable<ExpressionReads["searchResults"]>,
): Completion[] {
	return [
		...[...CASE_NODE_ATTRIBUTE_PROPERTIES].map((name) => step(`@${name}`)),
		...results.properties
			.filter((property) => !CASE_NODE_ATTRIBUTE_PROPERTIES.has(property.name))
			.map((property) => step(property.name, property.label)),
	];
}

/** A records row's values once its type is known: that type's properties
 * (the row attributes with `@`) and its `index/` relations. */
function caseRowValues(
	reads: ExpressionReads,
	caseType: string | undefined,
): Completion[] {
	if (caseType === undefined)
		return [
			{ label: "@case_type = '", detail: "Record type", type: "keyword" },
		];
	const type = reads.caseTypes.find((each) => each.name === caseType);
	if (type === undefined) return [];
	return [
		...type.properties
			.filter((property) => property.name !== "case_type")
			.map((property) => step(caseValueName(property.name), property.label)),
		...type.relations.map((relation) =>
			step(`index/${relation}`, "Related record"),
		),
	];
}

/** The steps an instance offers after the steps already written. */
function instanceSteps(
	reads: ExpressionReads,
	id: string,
	steps: readonly string[],
): Completion[] {
	const at = steps.join("/");
	if (id === "casedb") {
		if (at === "") return [step("casedb/")];
		if (at === "casedb") return [step("case", "Records")];
		return [];
	}
	if (id === "commcaresession") {
		if (at === "") return [step("session/")];
		if (at === "session")
			return [
				...(reads.sessionData.length === 0
					? []
					: [step("data/", "What the form opens with")]),
				step("context/", "This device and session"),
				step("user/", "Worker information"),
			];
		if (at === "session/data")
			return reads.sessionData.map((datum) => step(datum.id, datum.label));
		if (at === "session/context") return named(reads.sessionContext);
		if (at === "session/user") return [step("data/", "Worker information")];
		if (at === "session/user/data") return named(reads.workers);
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

/** The record type a predicate names with `@case_type = '…'`, read through
 * `and` and grouping. */
function namedCaseType(
	node: SyntaxNode | null,
	text: TextOf,
): string | undefined {
	if (node === null) return undefined;
	if (is(node, T.AndExpr)) {
		for (
			let child = node.firstChild;
			child !== null;
			child = child.nextSibling
		) {
			const found = namedCaseType(child, text);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (!is(node, T.EqualsExpr)) return undefined;
	const left = node.firstChild;
	const right = node.lastChild;
	for (const [attribute, value] of [
		[left, right],
		[right, left],
	] as const)
		if (
			stepName(attribute, text) === "@case_type" &&
			isNode(value, T.StringLiteral)
		)
			return text(value.from + 1, value.to - 1);
	return undefined;
}

/** The expression a `Filtered` node's brackets hold. */
function predicateOf(filtered: SyntaxNode): SyntaxNode | null {
	const open = filtered.getChild("[");
	return open?.nextSibling ?? null;
}

/** The record type a records row is narrowed to: by an earlier predicate on
 * the row, or by an earlier clause of the predicate being written. */
function rowCaseType(
	filtered: SyntaxNode,
	operand: SyntaxNode | undefined,
	text: TextOf,
): string | undefined {
	for (
		let row: SyntaxNode | null = filtered.firstChild;
		isNode(row, T.Filtered);
		row = row.firstChild
	) {
		const found = namedCaseType(predicateOf(row), text);
		if (found !== undefined) return found;
	}
	// `[@case_type = 'visit' and |`: the clause before the one being written.
	for (
		let clause = operand?.parent ?? null;
		clause !== null && clause !== filtered;
		clause = clause.parent
	)
		if (is(clause, T.AndExpr)) {
			const found = namedCaseType(clause.firstChild, text);
			if (found !== undefined) return found;
		}
	return undefined;
}

/** What a row's predicate can read: a table's columns, a place's values, a
 * result's values, a record's properties once its type is named. */
function rowPredicateValues(
	reads: ExpressionReads,
	id: string,
	steps: readonly string[],
	caseType: () => string | undefined,
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
	if (id === "casedb")
		return at === "casedb/case" ? caseRowValues(reads, caseType()) : [];
	if (id === "commcaresession") return [];
	const tag = id.startsWith("item-list:") ? id.slice("item-list:".length) : id;
	const table = reads.tables.find((each) => each.tag === tag);
	return table !== undefined && at === `${tag}_list/${tag}`
		? table.columns.map((column) => step(column.wireName, column.label))
		: [];
}

/** The predicate a node is written inside, with the value being written:
 * the step itself, or a clause of an `and` / `or` inside the brackets. */
function enclosingPredicate(
	node: SyntaxNode,
): { readonly filtered: SyntaxNode; readonly operand: SyntaxNode } | undefined {
	let operand: SyntaxNode = node;
	let below: SyntaxNode = node;
	let current = node.parent;
	let inClause = false;
	while (current !== null) {
		if (is(current, T.Filtered))
			return current.firstChild === below
				? undefined
				: { filtered: current, operand };
		if (is(current, T.AndExpr) || is(current, T.OrExpr)) inClause = true;
		else if (
			inClause ||
			(!is(current, T.Child) &&
				!is(current, T.AttrSpecified) &&
				!is(current, T.NameTest))
		)
			return undefined;
		else operand = current;
		below = current;
		current = current.parent;
	}
	return undefined;
}

/** Whether a node sits inside any predicate's brackets. */
function insidePredicate(node: SyntaxNode): boolean {
	for (let current = node; current.parent !== null; current = current.parent)
		if (is(current.parent, T.Filtered) && current.parent.firstChild !== current)
			return true;
	return false;
}

/** The completions for a quoted value, from what sits opposite it. */
function quotedOptions(
	reads: ExpressionReads,
	quoted: NonNullable<ReturnType<typeof quotedValueAt>>,
	text: TextOf,
): Completion[] {
	const { container } = quoted;
	// instance('|'): the call's one argument.
	if (is(container, T.ArgumentList)) {
		const fn = container.parent?.getChild("FunctionName");
		if (
			fn === null ||
			fn === undefined ||
			text(fn.from, fn.to) !== "instance" ||
			container.getChildren("StringLiteral").length > 1
		)
			return [];
		return instanceIds(reads);
	}
	// A static select's starting value is one of its choices.
	if (is(container, T.XPath))
		return (reads.slotChoices ?? []).map((choice) => ({
			label: choice.name,
			type: "constant",
			...(choice.label === undefined ? {} : { detail: choice.label }),
		}));
	if (!is(container, T.EqualsExpr) && !is(container, T.NotEqualsExpr))
		return [];
	const left = container.firstChild;
	const other =
		left !== null && left.to <= quoted.quote ? left : container.lastChild;
	if (other === null || (other.from <= quoted.quote && other.to > quoted.quote))
		return [];
	const opposite = stepName(other, text);
	const predicate = enclosingPredicate(container);
	const row =
		predicate === undefined
			? undefined
			: readInstancePath(predicate.filtered.firstChild, text);
	// [@type = '|'] over places: the level codes.
	if (
		opposite === "@type" &&
		reads.places !== undefined &&
		row?.id === "locations" &&
		row.steps.join("/") === "locations/location"
	)
		return reads.places.levels.map((level) => ({
			label: level.code,
			detail: level.name,
			type: "constant",
		}));
	// [@case_type = '|'] over records: the record types.
	if (
		opposite === "@case_type" &&
		row?.id === "casedb" &&
		row.steps.join("/") === "casedb/case"
	)
		return reads.caseTypes.map((type) => ({
			label: type.name,
			detail: "Record type",
			type: "constant",
		}));
	// Opposite a static select's answer: its choices.
	if (insidePredicate(container)) return [];
	return reads.choicesOpposite(text(other.from, other.to)).map((choice) => ({
		label: choice.name,
		type: "constant",
		...(choice.label === undefined ? {} : { detail: choice.label }),
	}));
}

/**
 * Completions for secondary-instance reads, from the syntax tree: the id
 * inside `instance('…')`, each path step below it, the values a row's
 * predicate reads, and the quoted values opposite a level, a record type
 * or a static select's answer. Quoted values are this source's to
 * complete, so it runs inside a string literal where the other sources
 * stand aside.
 *
 * Exported for unit testing; production callers consume it through the
 * `xpathAutocomplete` extension below.
 */
export function instanceSource(
	getReads: () => ExpressionReads | undefined,
): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		const reads = getReads();
		if (reads === undefined) return null;
		const { state, pos } = ctx;
		const text: TextOf = (from, to) => state.doc.sliceString(from, to);
		const node = syntaxTree(state).resolveInner(pos, -1);

		const quoted = quotedValueAt(node, pos, text);
		if (quoted !== undefined) {
			const options = quotedOptions(reads, quoted, text);
			return options.length === 0
				? null
				: { from: quoted.from, to: quoted.to, options };
		}

		// A step being written: `instance('regions')/|`, `…/regions_list/reg|`, `…/location/@|`.
		const written = isNode(node.parent, T.AttrSpecified) ? node.parent : node;
		const parent = written.parent;
		if (
			isNode(parent, T.Child) &&
			parent.firstChild !== written &&
			(written.type.isError ||
				is(written, T.Slash) ||
				is(written, T.NameTest) ||
				is(written, T.AttrSpecified))
		) {
			const base = readInstancePath(parent.firstChild, text);
			if (base !== undefined) {
				const options = instanceSteps(reads, base.id, base.steps);
				const from =
					is(written, T.Slash) || written.type.isError ? pos : written.from;
				return options.length === 0 ? null : { from, options };
			}
		}

		// Inside a row's predicate: `…/regions[|`, `…/location[na|`.
		const predicate =
			is(node, T.OpenBracket) && isNode(node.parent, T.Filtered)
				? { filtered: node.parent, operand: undefined }
				: enclosingPredicate(written);
		if (predicate !== undefined && !startsRelative(predicate.operand)) {
			const row = readInstancePath(predicate.filtered.firstChild, text);
			if (row === undefined) return null;
			const options = rowPredicateValues(reads, row.id, row.steps, () =>
				rowCaseType(predicate.filtered, predicate.operand, text),
			);
			if (options.length === 0) return null;
			const operand = predicate.operand;
			const from =
				operand === undefined || operand.type.isError ? pos : operand.from;
			return { from, options };
		}
		return null;
	};
}

/**
 * Relative steps: after `../`, `./` or a group named below them, the
 * questions that path reaches from the slot's context node, a group or
 * repeat ending in `/` so its own questions follow. Inside a predicate the
 * context node moves, so this source stands aside there.
 *
 * Exported for unit testing; production callers consume it through the
 * `xpathAutocomplete` extension below.
 */
export function relativeSource(
	getReads: () => ExpressionReads | undefined,
): (ctx: CompletionContext) => CompletionResult | null {
	return (ctx) => {
		const relative = getReads()?.relative;
		if (relative === undefined) return null;
		const { state, pos } = ctx;
		const text: TextOf = (from, to) => state.doc.sliceString(from, to);
		const node = syntaxTree(state).resolveInner(pos, -1);
		const written = node;
		const parent = written.parent;
		if (
			!isNode(parent, T.Child) ||
			parent.firstChild === written ||
			!(
				written.type.isError ||
				is(written, T.Slash) ||
				is(written, T.NameTest)
			) ||
			insidePredicate(parent)
		)
			return null;
		const base = readRelativePath(parent.firstChild, text);
		if (base === undefined) return null;
		const steps = relative(base);
		if (steps === undefined || steps.length === 0) return null;
		const from =
			is(written, T.Slash) || written.type.isError ? pos : written.from;
		return {
			from,
			options: steps.map((each) =>
				step(each.container ? `${each.name}/` : each.name, each.label),
			),
		};
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

/** Create a CodeMirror autocomplete extension for form expressions. */
export function xpathAutocomplete(
	getContext: () => ExpressionEditorContext | undefined,
): Extension {
	const getReference = () => getContext()?.reference;
	const getReads = () => getContext()?.reads;
	// Suppress functions inside hashtag refs (#patient/prop), path steps and
	// quoted text, a quote not yet closed included.
	const wrappedFunctionSource = ifNotIn(
		["StringLiteral", "HashtagRef", "Child", "Descendant"],
		outsideQuotedValue(functionSource),
	);
	const wrappedHashtagSource = ifNotIn(
		["StringLiteral"],
		hashtagSource(getReference),
	);
	const wrappedDataPathSource = ifNotIn(
		["StringLiteral"],
		dataPathSource(getReference),
	);
	const wrappedRelativeSource = ifNotIn(
		["StringLiteral"],
		outsideQuotedValue(relativeSource(getReads)),
	);

	return [
		autocompletion({
			override: [
				wrappedFunctionSource,
				wrappedHashtagSource,
				wrappedDataPathSource,
				wrappedRelativeSource,
				instanceSource(getReads),
			],
			activateOnCompletion: (c) => c.label.endsWith("/"),
			icons: true,
		}),
		keymap.of(completionKeymap),
	];
}
