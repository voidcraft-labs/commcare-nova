// lib/commcare/suite/case-search/searchPrompts.ts
//
// Per-input `<prompt>` elements inside `<remote-request>`'s `<query>`
// body — one element per `caseListConfig.searchInputs[i]`. The
// orchestrator splices the result between the `<query>`'s `<data>`
// children and its closing tag.
//
// Simple and advanced arms emit the same `<prompt>` shape — the
// distinction surfaces at search-execution time. Simple-arm slots
// `(property, mode, via)` inform CCHQ's runtime match; the prompt
// itself just declares the input slot. Advanced-arm predicates
// reference the input by name and AND-compose into `_xpath_query`
// (orchestrated above; this module exposes `getAdvancedArmPredicates`
// for that pull).
//
// When a simple-arm input rides on the `_xpath_query` route (the
// gate at `simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission`
// decides), the prompt also emits `exclude="true()"`. CCHQ's runtime
// otherwise auto-matches the typed value against a case property
// named by the prompt key (verified against
// `commcare-hq/.../suite_xml/post_process/remote_requests.py::build_query_prompts`
// — `'key': prop.name` is the prompt key, and CCHQ's case-search
// utils.py `_apply_filter` treats the key as the case property
// name); the auto-match would AND with the explicit predicate and
// silently drop results when `name !== property` or when the
// relation walk doesn't resolve. The `exclude="true()"` attribute
// makes the runtime skip the auto-match (verified at
// `commcare-core/.../session/RemoteQuerySessionManager.java::RemoteQuerySessionManager.getRawQueryParams`)
// while leaving the typed value bound to
// `instance('search-input:results')/input/field[@name='<prompt key>']`
// so the explicit predicate's `input(<prompt key>)` reference still
// resolves.
//
// Type-mapping decisions are CCHQ-authoritative and pinned in the
// mapping table below. Two CCHQ-side gotchas worth highlighting:
// `default_value` is an XML attribute (`@default`), not a child
// `<default>` element; barcode rides on `@appearance="barcode_scan"`,
// not `@input`. Both verified against the `QueryPrompt` model.

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import type {
	SearchInputDef,
	SearchInputType,
	SimpleSearchInputDef,
} from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import type { CaseListEmission } from "../case-list/types";
import { simpleArmNeedsXPathQueryEmission } from "./simpleArmDerivation";

/**
 * Element-returning twin of `CaseListEmission`. The `<remote-request>`
 * orchestrator (`remoteRequest.ts::buildRemoteRequest` via
 * `searchSession.ts::buildSearchSession`) consumes the Elements directly
 * so the per-prompt subtrees slot into the surrounding `<query>` parent
 * without a parse-then-reserialize round-trip; `emitSearchPrompts`
 * serializes the Elements for callers that assert against the rendered
 * XML string (the test surface).
 */
export interface SearchPromptsEmission {
	readonly elements: readonly Element[];
	readonly strings: Record<string, string>;
}

// ── Per-input-type wire-attribute mapping ─────────────────────────
//
// `input` and `appearance` are mutually exclusive on CCHQ's
// `QueryPrompt`. The table populates at most one per row; the
// emitter writes only populated slots, so the `text` arm emits no
// type discriminator and CCHQ renders a plain text input.
//
// `Record<SearchInputType, ...>` keys this exhaustively — a new
// `SearchInputType` arm is a compile error until its row lands.

/**
 * Per-`SearchInputType` mapping to the two CCHQ wire-attribute slots
 * a search prompt routes through:
 *
 *   - `input` — the `<prompt input="...">` XML attribute (CCHQ's
 *     `QueryPrompt.input_` Python field name — the trailing
 *     underscore avoids the `input` builtin; the wire attribute is
 *     plain `@input`). Accepts `select1` / `date` / `daterange` and
 *     drives the widget kind.
 *   - `appearance` — the `<prompt appearance="...">` XML attribute
 *     (CCHQ's `QueryPrompt.appearance` field). CCHQ overlays a
 *     scanner UI on top of a default text input when this carries
 *     `barcode_scan`.
 *
 * The two slots are mutually exclusive — a row populates one slot at
 * most. The shared shape is exported so both wire surfaces (suite
 * XML `<prompt>` and HQ JSON `CaseSearchProperty`) consult the same
 * authoritative table.
 */
export interface PromptAttributeMapping {
	readonly input?: string;
	readonly appearance?: string;
}

export const PROMPT_ATTRIBUTE_MAPPINGS: Readonly<
	Record<SearchInputType, PromptAttributeMapping>
> = {
	// CCHQ default — both attributes omitted, plain text input.
	text: {},
	// Wire attribute `input="select1"`. The runtime widget needs an
	// `<itemset>` child on the prompt to render as a select —
	// `commcare-core`'s `QueryPrompt::isSelect` returns false
	// otherwise and the widget falls back to a text input. Nova's
	// schema does not carry an itemset slot today, so the
	// `searchInputSelectWidgetNotSupported` validator rule rejects
	// the combination at authoring time; this mapping stays as the
	// wire-correct emission for the day the itemset infrastructure
	// lands.
	select: { input: "select1" },
	date: { input: "date" },
	// CCHQ collapses the token to `daterange` (no hyphen).
	"date-range": { input: "daterange" },
	// CCHQ routes barcode through `@appearance` — the runtime overlays
	// a scanner UI on top of an otherwise-text input.
	barcode: { appearance: "barcode_scan" },
};

// ── Public surface ───────────────────────────────────────────────

/**
 * Compose the `<prompt>` element list inside `<remote-request>`'s
 * `<query>` body. Returns the concatenated 8-space-indented XML
 * chunk plus the `search_property.{moduleId}.{name}` locale entries
 * the compiler threads into the per-language string tables. An
 * empty input array yields an empty emission; the orchestrator
 * handles the no-prompt branch without a sentinel.
 *
 * Simple-arm inputs whose authored shape rides on the `_xpath_query`
 * route (per `simpleArmNeedsXPathQueryEmission`) emit
 * `exclude="true()"` so CCHQ's runtime suppresses the bogus
 * auto-match against the prompt key. The advanced arm never emits
 * the attribute — advanced-arm predicates author the entire
 * comparison and rely on the prompt slot binding the typed value at
 * `instance('search-input:results')/input/field[@name='<prompt key>']`,
 * not on any runtime auto-match.
 */
export function buildSearchPrompts(
	searchInputs: ReadonlyArray<SearchInputDef>,
	moduleId: string,
): SearchPromptsEmission {
	const elements: Element[] = [];
	const strings: Record<string, string> = {};

	for (const input of searchInputs) {
		// When `input.label` is empty the locale registers `input.name`
		// — gives the runtime something readable to render rather than
		// the locale id itself.
		const localeId = composeSearchPropertyLocaleId(moduleId, input.name);
		strings[localeId] = input.label !== "" ? input.label : input.name;

		elements.push(
			buildPromptElement(input, localeId, suppressAutoMatch(input)),
		);
	}

	return { elements, strings };
}

/**
 * String adapter — serializes `buildSearchPrompts`'s Elements to a
 * newline-joined string for callers that assert against the rendered
 * XML (the test surface). The orchestrator (`remoteRequest.ts` via
 * `searchSession.ts`) calls `buildSearchPrompts` directly.
 */
export function emitSearchPrompts(
	searchInputs: ReadonlyArray<SearchInputDef>,
	moduleId: string,
): CaseListEmission {
	const { elements, strings } = buildSearchPrompts(searchInputs, moduleId);
	if (elements.length === 0) return { xml: "", strings };
	return {
		xml: elements.map((promptEl) => render(promptEl, RENDER_OPTS)).join("\n"),
		strings,
	};
}

/**
 * Returns `true` if the prompt should carry `exclude="true()"` to
 * suppress CCHQ's runtime auto-match. One source of truth — the
 * simple-arm derivation gate — picks both the `_xpath_query` route
 * and the prompt's exclude attribute. The two surfaces must travel
 * together: a simple-arm input routed through `_xpath_query` without
 * `exclude="true()"` would AND the explicit predicate with CCHQ's
 * auto-match against the prompt key, silently dropping results when
 * `name !== property` or when the relation walk doesn't resolve.
 *
 * Advanced-arm inputs never carry the attribute — their predicate
 * authors the entire comparison; CCHQ's auto-match wouldn't fire
 * meaningfully against them either way, and emitting
 * `exclude="true()"` on every advanced-arm prompt would diverge from
 * CCHQ's typical authoring shape without a runtime benefit.
 */
function suppressAutoMatch(input: SearchInputDef): boolean {
	if (input.kind !== "simple") return false;
	return simpleArmNeedsXPathQueryEmission(input satisfies SimpleSearchInputDef);
}

/**
 * Extract the `(name, predicate)` pairs the orchestrator AND-composes
 * into `<data key="_xpath_query">`. Only the advanced arm contributes
 * — simple-arm rows route through CCHQ's runtime matcher and don't
 * appear in the explicit XPath query.
 *
 * Returns predicates verbatim — the emitter does NOT auto-wrap input
 * references. The validator rule `searchInputRefUsesWhenInputPresent`
 * is the structural gate: every authored input ref must already sit
 * inside an enclosing `when-input-present` envelope at this point,
 * because the CSQL runtime resolves an unset input to the empty
 * string and a bare ref would silently match cases whose property
 * equals "" when the user hasn't typed anything.
 */
export function getAdvancedArmPredicates(
	searchInputs: ReadonlyArray<SearchInputDef>,
): ReadonlyArray<{ readonly name: string; readonly predicate: Predicate }> {
	const out: { readonly name: string; readonly predicate: Predicate }[] = [];
	for (const input of searchInputs) {
		if (input.kind === "advanced") {
			out.push({ name: input.name, predicate: input.predicate });
		}
	}
	return out;
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Build the prompt's display-label locale id. Mirrors CCHQ's
 * `search_property_locale` pattern: `search_property.{moduleId}.{name}`.
 */
function composeSearchPropertyLocaleId(moduleId: string, name: string): string {
	return `search_property.${moduleId}.${name}`;
}

/**
 * Build one `<prompt>` Element. CCHQ always emits `<display>` on every
 * `QueryPrompt`, so this function does the same as a child.
 * `suppressAutoMatch` threads through to stamp `exclude="true()"` on
 * the prompt when the simple-arm derivation gate routes the input
 * through `_xpath_query`.
 */
function buildPromptElement(
	input: SearchInputDef,
	localeId: string,
	suppressAutoMatch: boolean,
): Element {
	return el("prompt", composePromptAttributes(input, suppressAutoMatch), [
		el("display", {}, [el("text", {}, [el("locale", { id: localeId })])]),
	]);
}

/**
 * Compose the attribute map for a `<prompt>` element. Insertion order
 * follows `QueryPrompt`'s field declaration order: `key`, `appearance`,
 * `input`, `default`, `exclude`. Absent slots are skipped.
 *
 * `exclude="true()"` rides at the tail to match CCHQ's declaration
 * order on `QueryPrompt` (verified against
 * `commcare-hq/.../suite_xml/post_process/remote_requests.py::build_query_prompts`
 * — the `if prop.exclude: kwargs['exclude'] = "true()"` block fires
 * after the matcher / default / itemset slots have populated). Keeping
 * the attribute order CCHQ-canonical keeps the wire shape
 * byte-comparable against CCHQ's own emission for round-trip
 * verification.
 *
 * Every value flows raw into the attribs object; the serializer
 * XML-escapes `<` / `>` / `&` / `"` / `'` exactly once at render time
 * — `default`'s compiled XPath in particular may carry comparison
 * operators or string literals that the serializer handles by
 * construction.
 */
function composePromptAttributes(
	input: SearchInputDef,
	suppressAutoMatch: boolean,
): Record<string, string> {
	const mapping = PROMPT_ATTRIBUTE_MAPPINGS[input.type];

	const attribs: Record<string, string> = { key: input.name };

	if (mapping.appearance !== undefined) {
		attribs.appearance = mapping.appearance;
	}
	if (mapping.input !== undefined) {
		attribs.input = mapping.input;
	}

	// `default` is the attribute form, not a child `<default>` element
	// — see `QueryPrompt::default_value = StringField('@default', ...)`.
	if (input.default !== undefined) {
		attribs.default = compileDefaultExpression(input.default);
	}

	// `exclude="true()"` is the structural mitigation for the
	// `name !== property` / non-self via simple-arm cases. CCHQ's
	// runtime skips the auto-match against the prompt key when the
	// boolean XPath evaluates to true; the typed value remains bound
	// to the search-input instance for the explicit `_xpath_query`
	// predicate to reference.
	if (suppressAutoMatch) {
		attribs.exclude = "true()";
	}

	return attribs;
}

/**
 * Compile a `ValueExpression` to its on-device XPath wire string.
 * `<prompt default>` is on-device-evaluated; the shared emitter
 * produces the right dialect.
 */
function compileDefaultExpression(expression: ValueExpression): string {
	return emitOnDeviceExpression(expression);
}
