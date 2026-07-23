// lib/commcare/suite/case-search/searchPrompts.ts
//
// Per-input `<prompt>` elements inside `<remote-request>`'s `<query>`
// body — one element per `caseListConfig.searchInputs[i]`. The
// orchestrator splices the result between the `<query>`'s `<data>`
// children and its closing tag.
//
// Simple and advanced arms share the same prompt metadata; advanced
// arms additionally carry `exclude="true()"` because their authored
// predicate owns the comparison. Simple-arm slots
// `(property, mode, via)` inform CCHQ's runtime match; the prompt
// itself just declares the input slot. Advanced-arm predicates
// reference the input by name and AND-compose into `_xpath_query`
// (orchestrated above; this module exposes `getAdvancedArmPredicates`
// for that pull).
//
// When an input rides on the `_xpath_query` route, the prompt also
// emits `exclude="true()"`. That includes every advanced arm and the
// simple-arm shapes selected by
// `simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission`. CCHQ's runtime
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
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import type {
	SearchInputDef,
	SearchInputType,
	SimpleSearchInputDef,
} from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import type { RelationEvaluationScopeContext } from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import type { CaseListEmission } from "../case-list/types";
import { simpleArmNeedsXPathQueryEmission } from "./simpleArmDerivation";

/**
 * The Element-returning shape `buildSearchPrompts` produces for the
 * `<remote-request>` orchestrator (`remoteRequest.ts::buildRemoteRequest`
 * via `searchSession.ts::buildSearchSession`). The per-prompt subtrees
 * slot into the surrounding `<query>` parent without a parse-then-
 * reserialize round-trip. `emitSearchPrompts` serializes the Elements
 * for callers that assert against the rendered XML string (the test
 * surface).
 */
export interface SearchPromptsEmission {
	readonly elements: readonly Element[];
	readonly strings: Record<string, string>;
}

export const RUNTIME_CSQL_QUOTE_VALIDATION_MESSAGE =
	"This search can't use both single and double quotation marks. Remove one kind and try again";

/**
 * One pre-submit prompt assertion derived from the exact emitted CSQL wrapper.
 * The test can reference several search inputs because a computed runtime value
 * may combine individually safe answers into one unrepresentable CSQL string.
 * CommCare Core evaluates the assertion after populating the shared
 * `search-input:results` instance, so the same test can be attached to every
 * prompt involved in that effective query.
 */
export interface RuntimeCsqlPromptValidation {
	readonly test: string;
	readonly message: string;
}

/**
 * Combine independently-derived runtime constraints into Core's single
 * supported prompt-validation slot. Callers own the combined user-facing copy
 * because a useful instruction is more concise than concatenating several
 * standalone errors. Parentheses preserve each assertion's authored
 * precedence before the shared `and` joins them.
 */
export function combineRuntimeCsqlPromptValidations(
	validations: readonly RuntimeCsqlPromptValidation[],
	combinedMessage: string,
): RuntimeCsqlPromptValidation | undefined {
	if (validations.length === 0) return undefined;
	if (validations.length === 1) return validations[0];
	return {
		test: validations.map(({ test }) => `(${test})`).join(" and "),
		message: combinedMessage,
	};
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
 * Every advanced input and every simple-arm input whose authored
 * shape rides on `_xpath_query` emits `exclude="true()"`. CommCare
 * Core still binds the prompt value into the search-input instance,
 * but it does not also auto-submit the prompt key as a separate case-
 * property filter.
 */
export function buildSearchPrompts(
	searchInputs: ReadonlyArray<SearchInputDef>,
	moduleId: string,
	runtimeValidations: ReadonlyMap<
		string,
		RuntimeCsqlPromptValidation
	> = new Map(),
	relationContext: RelationEvaluationScopeContext = {},
	lookupNaming?: LookupWireNaming,
): SearchPromptsEmission {
	const elements: Element[] = [];
	const strings: Record<string, string> = {};

	for (const input of searchInputs) {
		// When `input.label` is empty the locale registers `input.name`
		// — gives the runtime something readable to render rather than
		// the locale id itself.
		const localeId = composeSearchPropertyLocaleId(moduleId, input.name);
		strings[localeId] = input.label !== "" ? input.label : input.name;
		const runtimeValidation = runtimeValidations.get(input.name);
		const validationLocaleId = runtimeValidation
			? composeRuntimeCsqlValidationLocaleId(moduleId, input.name)
			: undefined;
		if (validationLocaleId !== undefined && runtimeValidation !== undefined) {
			strings[validationLocaleId] = runtimeValidation.message;
		}

		elements.push(
			buildPromptElement(
				input,
				localeId,
				searchInputSuppressesAutoMatch(input),
				validationLocaleId,
				runtimeValidation?.test,
				relationContext,
				lookupNaming,
			),
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
	runtimeValidations?: ReadonlyMap<string, RuntimeCsqlPromptValidation>,
	relationContext: RelationEvaluationScopeContext = {},
): CaseListEmission {
	const { elements, strings } = buildSearchPrompts(
		searchInputs,
		moduleId,
		runtimeValidations,
		relationContext,
	);
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
 * Advanced-arm inputs always carry the attribute: their prompt must
 * bind the typed value for `input(name)` references, but their authored
 * predicate owns the comparison. Without `exclude`, CommCare Core also
 * submits the prompt as a normal case-property query parameter and
 * silently ANDs that unintended auto-match with `_xpath_query`.
 */
export function searchInputSuppressesAutoMatch(input: SearchInputDef): boolean {
	if (input.kind === "advanced") return true;
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

function composeRuntimeCsqlValidationLocaleId(
	moduleId: string,
	name: string,
): string {
	return `search_property.${moduleId}.${name}.validation.0.text`;
}

/**
 * Build one `<prompt>` Element. CCHQ always emits `<display>` on every
 * `QueryPrompt`, so this function does the same as a child.
 * `suppressAutoMatch` threads through to stamp `exclude="true()"` on
 * any prompt whose comparison is authored in `_xpath_query` rather
 * than CommCare Core's implicit prompt-key matcher.
 */
function buildPromptElement(
	input: SearchInputDef,
	localeId: string,
	suppressAutoMatch: boolean,
	validationLocaleId: string | undefined,
	validationTest: string | undefined,
	relationContext: RelationEvaluationScopeContext,
	lookupNaming?: LookupWireNaming,
): Element {
	const children = [
		el("display", {}, [el("text", {}, [el("locale", { id: localeId })])]),
	];
	if (validationLocaleId !== undefined && validationTest !== undefined) {
		children.push(
			el("validation", { test: validationTest }, [
				el("text", {}, [el("locale", { id: validationLocaleId })]),
			]),
		);
	}
	return el(
		"prompt",
		composePromptAttributes(
			input,
			suppressAutoMatch,
			relationContext,
			lookupNaming,
		),
		children,
	);
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
	relationContext: RelationEvaluationScopeContext,
	lookupNaming?: LookupWireNaming,
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
	// The historical scalar default slot cannot represent CommCare's paired
	// daterange answer. Validation asks legacy authors to remove it; omission
	// here is the final defense against turning one date into an exact query.
	if (input.type !== "date-range" && input.default !== undefined) {
		attribs.default = compileDefaultExpression(
			input.default,
			relationContext,
			lookupNaming,
		);
	}

	// `exclude="true()"` is the structural mitigation for the
	// explicit-predicate route. CCHQ's
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
function compileDefaultExpression(
	expression: ValueExpression,
	relationContext: RelationEvaluationScopeContext,
	lookupNaming?: LookupWireNaming,
): string {
	return emitOnDeviceExpression(
		expression,
		undefined,
		relationContext,
		undefined,
		lookupNaming === undefined ? {} : { lookup: { naming: lookupNaming } },
	);
}
