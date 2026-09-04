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
import {
	type LookupOptionsSource,
	makeTranslationUnitId,
	type SearchInputDef,
	type SearchInputType,
	searchInputDefault,
	searchInputOptions,
	searchInputRequiredMessage,
	searchInputRuntimeValueType,
	searchRuntimeValidationMessage,
	type TranslationUnitId,
	type WireStringSource,
} from "@/lib/domain";
import {
	isMatchAll,
	type Predicate,
	simplifyForEmission,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { RelationEvaluationScopeContext } from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	emitCaseListFilter,
} from "../../predicate";
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
	readonly translationUnits: Record<string, WireStringSource>;
	/**
	 * Every instance id the prompt children reference: lookup fixtures
	 * behind `<itemset>` nodesets and their row filters, plus whatever
	 * the required / validation tests and hidden values read. The
	 * `<remote-request>` orchestrator declares each one.
	 */
	readonly instances: ReadonlySet<string>;
}

export const RUNTIME_CSQL_QUOTE_VALIDATION_MESSAGE =
	searchRuntimeValidationMessage(new Set(["quote"]))?.message ?? "";

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
	readonly messageKey: string;
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
	combinedMessageKey: string,
): RuntimeCsqlPromptValidation | undefined {
	if (validations.length === 0) return undefined;
	if (validations.length === 1) return validations[0];
	return {
		test: validations.map(({ test }) => `(${test})`).join(" and "),
		message: combinedMessage,
		messageKey: combinedMessageKey,
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
 *     plain `@input`). Accepts `select1` / `select` / `date` /
 *     `daterange` and drives the widget kind
 *     (`commcare-core .../util/screen/QueryScreen.java::getSupportedPrompts`).
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
	date: { input: "date" },
	// CCHQ collapses the token to `daterange` (no hyphen).
	"date-range": { input: "daterange" },
	// CCHQ routes barcode through `@appearance` — the runtime overlays
	// a scanner UI on top of an otherwise-text input.
	barcode: { appearance: "barcode_scan" },
	// One choice from the itemset; CommCare's XForms-derived token.
	select: { input: "select1" },
	// Several choices, stored as one `#,#`-joined answer.
	"multi-select": { input: "select" },
};

// ── Shared prompt projection ─────────────────────────────────────
//
// Both wire surfaces (suite `<prompt>` and HQ `CaseSearchProperty`)
// consume one derived description of a prompt so the two cannot
// disagree about a test, a nodeset, or which message a worker sees.

/** One localized wire string: its source-language text and the
 *  translation unit(s) each language resolves it through. */
export interface SearchPromptText {
	readonly text: string;
	readonly source: WireStringSource;
}

export interface SearchPromptAssertion {
	readonly test: string;
	readonly message: SearchPromptText;
}

export interface SearchPromptItemset {
	/** The suite fixture id the nodeset reads (`item-list:<tag>`). */
	readonly instanceId: string;
	readonly nodeset: string;
	/** Row-relative column wire names. */
	readonly label: string;
	readonly value: string;
}

/**
 * Everything a `<prompt>` / `CaseSearchProperty` carries for one input,
 * already lowered to wire vocabulary.
 */
export interface SearchPromptWire {
	readonly key: string;
	readonly label: SearchPromptText;
	readonly hint?: SearchPromptText;
	readonly appearance?: string;
	readonly hidden: boolean;
	readonly input?: string;
	/** On-device XPath for `@default`: a visible seed or a hidden value. */
	readonly defaultValue?: string;
	readonly exclude: boolean;
	readonly itemset?: SearchPromptItemset;
	readonly required?: SearchPromptAssertion;
	/** Core keeps only the last `<validation>`, so there is at most one. */
	readonly validation?: SearchPromptAssertion;
	/** Every instance id the prompt's children and attributes read. */
	readonly instances: ReadonlySet<string>;
}

/**
 * Lower one search input to its wire description. `relationContext`
 * must already carry `knownInputs` for the whole module so `input(...)`
 * reads resolve to their current names; `searchPromptRelationContext`
 * derives it.
 */
export function searchPromptWire(
	input: SearchInputDef,
	runtimeValidation: RuntimeCsqlPromptValidation | undefined,
	relationContext: RelationEvaluationScopeContext,
	lookupNaming?: LookupWireNaming,
): SearchPromptWire {
	const instances = new Set<string>();
	const emission: PromptEmissionContext = {
		relationContext,
		lookupNaming,
		instances,
	};
	const mapping = promptAttributeMapping(input);
	// When `input.label` is empty the locale registers `input.name`
	// — gives the runtime something readable to render rather than
	// the locale id itself.
	const label: SearchPromptText = {
		text: input.label !== "" ? input.label : input.name,
		source: makeTranslationUnitId("search-input", input.uuid, "label"),
	};
	const hint =
		input.kind !== "hidden" && input.hint !== undefined
			? {
					text: input.hint,
					source: makeTranslationUnitId("search-input", input.uuid, "hint"),
				}
			: undefined;
	const options = searchInputOptions(input);
	const itemset =
		options === undefined ? undefined : buildItemset(options, emission);
	const required = buildRequired(input, emission);
	const validation = buildValidation(input, runtimeValidation, emission);
	const seed =
		input.kind === "hidden" ? input.value : searchInputDefault(input);
	const defaultValue =
		seed === undefined ? undefined : compileDefaultExpression(seed, emission);
	return {
		key: input.name,
		label,
		...(hint === undefined ? {} : { hint }),
		...(mapping.appearance === undefined
			? {}
			: { appearance: mapping.appearance }),
		hidden: input.kind === "hidden",
		...(mapping.input === undefined ? {} : { input: mapping.input }),
		...(defaultValue === undefined ? {} : { defaultValue }),
		exclude: searchInputSuppressesAutoMatch(input),
		...(itemset === undefined ? {} : { itemset }),
		...(required === undefined ? {} : { required }),
		...(validation === undefined ? {} : { validation }),
		instances,
	};
}

/**
 * The relation context every prompt expression is lowered under: the
 * caller's context plus the module's complete input list, so `input(...)`
 * reads print the current prompt keys.
 */
export function searchPromptRelationContext(
	searchInputs: ReadonlyArray<SearchInputDef>,
	relationContext: RelationEvaluationScopeContext = {},
): RelationEvaluationScopeContext {
	return {
		...relationContext,
		knownInputs: searchInputs.map((input) => ({
			uuid: input.uuid,
			name: input.name,
			data_type: searchInputRuntimeValueType(input),
		})),
	};
}

// ── Public surface ───────────────────────────────────────────────

/**
 * Compose the `<prompt>` element list inside `<remote-request>`'s
 * `<query>` body. Returns the concatenated 8-space-indented XML
 * chunk plus the `search_property.{moduleId}.{name}` locale entries
 * the compiler threads into the per-language string tables. An
 * empty input array yields an empty emission; the orchestrator
 * handles the no-prompt branch without a sentinel.
 *
 * Every advanced input, every hidden input, and every simple-arm
 * input whose authored shape rides on `_xpath_query` emits
 * `exclude="true()"`. CommCare Core still binds the prompt value into
 * the search-input instance, but it does not also auto-submit the
 * prompt key as a separate case-property filter.
 *
 * Per prompt, the children follow CCHQ's `QueryPrompt` construction
 * order (`remote_requests.py::RemoteRequestFactory.build_query_prompts`):
 * `<display>` (with `<hint>` inside it), `<itemset>`, `<required>`,
 * then the single `<validation>`. Core keeps only the LAST
 * `<validation>` it parses (`xml/QueryPromptParser.java::parse`), so
 * an authored rule and a compiler-derived CSQL guard compose into ONE
 * element whose message is the authored sentence followed by the
 * guard's.
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
	const translationUnits: Record<string, WireStringSource> = {};
	const instances = new Set<string>();
	const promptRelationContext = searchPromptRelationContext(
		searchInputs,
		relationContext,
	);
	const register = (localeId: string, value: SearchPromptText) => {
		strings[localeId] = value.text;
		translationUnits[localeId] = value.source;
		return el("text", {}, [el("locale", { id: localeId })]);
	};

	for (const input of searchInputs) {
		const wire = searchPromptWire(
			input,
			runtimeValidations.get(input.name),
			promptRelationContext,
			lookupNaming,
		);
		for (const id of wire.instances) instances.add(id);

		const displayChildren = [
			register(composeSearchPropertyLocaleId(moduleId, wire.key), wire.label),
		];
		if (wire.hint !== undefined) {
			displayChildren.push(
				el("hint", {}, [
					register(composeHintLocaleId(moduleId, wire.key), wire.hint),
				]),
			);
		}
		const children = [el("display", {}, displayChildren)];
		if (wire.itemset !== undefined) {
			children.push(
				el("itemset", { nodeset: wire.itemset.nodeset }, [
					el("label", { ref: wire.itemset.label }),
					el("value", { ref: wire.itemset.value }),
				]),
			);
		}
		if (wire.required !== undefined) {
			children.push(
				el("required", { test: wire.required.test }, [
					register(
						composeRequiredLocaleId(moduleId, wire.key),
						wire.required.message,
					),
				]),
			);
		}
		if (wire.validation !== undefined) {
			children.push(
				el("validation", { test: wire.validation.test }, [
					register(
						composeValidationLocaleId(moduleId, wire.key),
						wire.validation.message,
					),
				]),
			);
		}
		elements.push(el("prompt", composePromptAttributes(wire), children));
	}

	return { elements, strings, translationUnits, instances };
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
	lookupNaming?: LookupWireNaming,
): CaseListEmission {
	const { elements, strings, translationUnits } = buildSearchPrompts(
		searchInputs,
		moduleId,
		runtimeValidations,
		relationContext,
		lookupNaming,
	);
	if (elements.length === 0) return { xml: "", strings, translationUnits };
	return {
		xml: elements.map((promptEl) => render(promptEl, RENDER_OPTS)).join("\n"),
		strings,
		translationUnits,
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
 *
 * Hidden inputs always carry it too: a system-generated value exists
 * to be read through `input(name)` and carried into the search-input
 * instance, never to match a case property named after it.
 */
export function searchInputSuppressesAutoMatch(input: SearchInputDef): boolean {
	if (input.kind !== "simple") return true;
	return simpleArmNeedsXPathQueryEmission(input);
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

/** What one prompt's lowering reads, and where it records its instances. */
interface PromptEmissionContext {
	readonly relationContext: RelationEvaluationScopeContext;
	readonly lookupNaming: LookupWireNaming | undefined;
	readonly instances: Set<string>;
}

/**
 * Attribute / child slots for a `<prompt>`: the per-`SearchInputType`
 * widget mapping for a visible input, or the fixed hidden shape
 * (`hidden="true"` and no widget) for a system-generated value.
 */
function promptAttributeMapping(input: SearchInputDef): PromptAttributeMapping {
	return input.kind === "hidden" ? {} : PROMPT_ATTRIBUTE_MAPPINGS[input.type];
}

/**
 * Build the prompt's display-label locale id. Mirrors CCHQ's
 * `search_property_locale` pattern: `search_property.{moduleId}.{name}`.
 * The three child locale ids follow CCHQ's `id_strings.py` siblings
 * (`search_property_hint_locale`, `search_property_required_text`,
 * `search_property_validation_text`).
 */
function composeSearchPropertyLocaleId(moduleId: string, name: string): string {
	return `search_property.${moduleId}.${name}`;
}

function composeHintLocaleId(moduleId: string, name: string): string {
	return `search_property.${moduleId}.${name}.hint`;
}

function composeRequiredLocaleId(moduleId: string, name: string): string {
	return `search_property.${moduleId}.${name}.required.text`;
}

function composeValidationLocaleId(moduleId: string, name: string): string {
	return `search_property.${moduleId}.${name}.validation.0.text`;
}

/**
 * Lower a lookup-backed choice list to its `<itemset>`. The nodeset
 * iterates the suite fixture's rows (`instance('item-list:<tag>')`, the
 * suite-scope spelling CCHQ pins in
 * `test_suite_remote_request.py::test_prompt_itemset`), `label` and
 * `value` name the two columns' current wire names as row-relative
 * steps, and an authored row filter becomes the nodeset predicate. The
 * search screen has no case, so the filter's case anchor is
 * unaddressable; the validator admits only table columns and globals
 * there.
 */
function buildItemset(
	options: LookupOptionsSource,
	emission: PromptEmissionContext,
): SearchPromptItemset {
	const { lookupNaming, relationContext, instances } = emission;
	if (lookupNaming === undefined) {
		throw new Error(
			"searchPromptWire: a lookup-backed choice input reached wire emission with no lookup wire naming. The compile boundary supplies naming; every other surface should reject lookup carriers before emission.",
		);
	}
	const table = lookupNaming.tableFor(options.tableId);
	instances.add(table.fixtureId);
	let filterText = "";
	if (options.filter !== undefined) {
		const filter = simplifyForEmission(options.filter);
		if (!isMatchAll(filter)) {
			filterText = `[${emitCaseListFilter(
				filter,
				"casedb",
				relationContext,
				{ kind: "unaddressable" },
				{
					lookup: {
						naming: lookupNaming,
						instanceScope: "suite",
						rowScope: {
							tableId: options.tableId,
							caseAnchor: { kind: "unaddressable" },
						},
					},
				},
			)}]`;
			for (const id of collectPredicateInstances(filter, lookupNaming)) {
				instances.add(id);
			}
		}
	}
	return {
		instanceId: table.fixtureId,
		nodeset: `instance('${table.fixtureId}')/${table.listElementName}/${table.rowElementName}${filterText}`,
		label: table.wireNameFor(options.labelColumnId),
		value: table.wireNameFor(options.valueColumnId),
	};
}

/**
 * Lower `required` for an input that is always or conditionally
 * required. Core evaluates the test against the search-input instance
 * and reports the message only when the answer is empty
 * (`session/RemoteQuerySessionManager.java::validateUserAnswers`). An
 * always-required input carries the literal `true()`; a conditional
 * one carries its authored predicate lowered to on-device XPath. The
 * message is the author's sentence or Nova's default, so every runtime
 * shows the same words.
 */
function buildRequired(
	input: SearchInputDef,
	emission: PromptEmissionContext,
): SearchPromptAssertion | undefined {
	const message = searchInputRequiredMessage(input);
	if (input.kind === "hidden" || message === undefined) return undefined;
	const when = input.required?.when;
	return {
		test: when === undefined ? "true()" : emitScreenPredicate(when, emission),
		message: {
			text: message,
			source:
				input.required?.message === undefined
					? makeTranslationUnitId("system", "search-required", "default")
					: makeTranslationUnitId(
							"search-input",
							input.uuid,
							"required-message",
						),
		},
	};
}

/**
 * Lower the prompt's single validation. Core keeps only the last
 * `<validation>` it parses, so the authored rule and the compiler's
 * CSQL guard share the slot: the test ANDs both (each parenthesized),
 * and the message joins the authored sentence with the guard's. Each
 * half keeps its own translation unit; the locale table joins them per
 * language.
 */
function buildValidation(
	input: SearchInputDef,
	runtimeValidation: RuntimeCsqlPromptValidation | undefined,
	emission: PromptEmissionContext,
): SearchPromptAssertion | undefined {
	const authored = input.kind === "hidden" ? undefined : input.validation;
	if (authored === undefined && runtimeValidation === undefined) {
		return undefined;
	}
	const tests: string[] = [];
	const messages: string[] = [];
	const units: TranslationUnitId[] = [];
	if (authored !== undefined) {
		tests.push(emitScreenPredicate(authored.rule, emission));
		messages.push(authored.message);
		units.push(
			makeTranslationUnitId("search-input", input.uuid, "validation-message"),
		);
	}
	if (runtimeValidation !== undefined) {
		tests.push(runtimeValidation.test);
		messages.push(runtimeValidation.message);
		units.push(
			makeTranslationUnitId(
				"system",
				"search-validation",
				runtimeValidation.messageKey,
			),
		);
	}
	return {
		test:
			tests.length === 1 ? tests[0] : tests.map((t) => `(${t})`).join(" and "),
		message: {
			text: messages.join(" "),
			source: units.length === 1 ? units[0] : units,
		},
	};
}

/**
 * Lower a search-screen predicate (`required.when` / `validation.rule`)
 * to the on-device XPath Core evaluates against the search-input
 * instance. No case is selected on that screen, so the case anchor is
 * unaddressable; the validator admits only globals and the module's
 * own `input(...)` reads, which print as absolute instance paths.
 */
function emitScreenPredicate(
	predicate: Predicate,
	emission: PromptEmissionContext,
): string {
	const { lookupNaming, relationContext, instances } = emission;
	for (const id of collectPredicateInstances(
		predicate,
		lookupNaming,
		"suite",
		relationContext.searchInputInstanceId,
	)) {
		instances.add(id);
	}
	return emitCaseListFilter(
		predicate,
		"casedb",
		relationContext,
		{ kind: "unaddressable" },
		lookupNaming === undefined
			? {}
			: { lookup: { naming: lookupNaming, instanceScope: "suite" } },
	);
}

/**
 * Compose the attribute map for a `<prompt>` element. Insertion order
 * follows `QueryPrompt`'s field declaration order: `key`, `appearance`,
 * `hidden`, `input`, `default`, `exclude`. Absent slots are skipped.
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
 *
 * A hidden input is `hidden="true"` plus its value in `default`
 * (`test_suite_remote_request.py::test_prompt_hidden`); Core re-evaluates
 * that default at every query-screen construction
 * (`util/screen/QueryScreen.java::init`) and seeds it into the answers
 * even under `default_search`.
 */
function composePromptAttributes(
	wire: SearchPromptWire,
): Record<string, string> {
	const attribs: Record<string, string> = { key: wire.key };
	if (wire.appearance !== undefined) attribs.appearance = wire.appearance;
	if (wire.hidden) attribs.hidden = "true";
	if (wire.input !== undefined) attribs.input = wire.input;
	// `default` is the attribute form, not a child `<default>` element
	// — see `QueryPrompt::default_value = StringField('@default', ...)`.
	if (wire.defaultValue !== undefined) attribs.default = wire.defaultValue;
	// `exclude="true()"` is the structural mitigation for the
	// explicit-predicate route. CCHQ's runtime skips the auto-match
	// against the prompt key when the boolean XPath evaluates to true;
	// the typed value remains bound to the search-input instance for
	// the explicit `_xpath_query` predicate to reference.
	if (wire.exclude) attribs.exclude = "true()";
	return attribs;
}

/**
 * Compile a `ValueExpression` to its on-device XPath wire string.
 * `<prompt default>` is on-device-evaluated; the shared emitter
 * produces the right dialect.
 */
function compileDefaultExpression(
	expression: ValueExpression,
	emission: PromptEmissionContext,
): string {
	const { lookupNaming, relationContext, instances } = emission;
	for (const id of collectExpressionInstances(
		expression,
		lookupNaming,
		"suite",
		relationContext.searchInputInstanceId,
	)) {
		instances.add(id);
	}
	return emitOnDeviceExpression(
		expression,
		undefined,
		relationContext,
		undefined,
		lookupNaming === undefined
			? {}
			: { lookup: { naming: lookupNaming, instanceScope: "suite" } },
	);
}
