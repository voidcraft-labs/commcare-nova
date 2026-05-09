// lib/commcare/suite/case-search/searchPrompts.ts
//
// Suite-XML emission for the per-input `<prompt>` elements that
// live inside `<remote-request>`'s `<query>` body. One element per
// `caseListConfig.searchInputs[i]`; the `<remote-request>`
// orchestrator splices the result between the `<query>`'s `<data>`
// children and its closing tag.
//
// CCHQ wire shape (verified against
// `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::QueryPrompt`
// and the canonical fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`):
//
//   <prompt key="..."
//           input="..."         (optional — see input-mapping below)
//           appearance="..."    (optional — barcode rides here, NOT input)
//           default="...">      (optional — XPath expression)
//     <display>                 (always emitted — CCHQ canonical shape)
//       <text>
//         <locale id="search_property.{moduleId}.{name}"/>
//       </text>
//     </display>
//   </prompt>
//
// `default_value` is an XML attribute on `<prompt>` (not a child
// `<default>` element) — the CCHQ model registers it as
// `StringField('@default', required=False)`. The wire emitter sets
// the `@default` attribute when `input.default` is present and
// omits it otherwise.
//
// `<display>` always emits because CCHQ's
// `RemoteRequestFactory.build_query_prompts` constructs
// `Display(text=Text(locale_id=…))` unconditionally for every
// property. When the author leaves the input's `label` slot empty,
// the locale registers the `name` as a sensible UX fallback so the
// runtime renders something readable rather than the locale id
// itself.
//
// ## Input-type mapping (CCHQ-authoritative)
//
// CCHQ admits two orthogonal optional attributes on `<prompt>`:
// `@input` (`select1` / `select` / `date` / `daterange` /
// `checkbox`) and `@appearance` (`address` / `barcode_scan` / etc).
// The mapping pinned here mirrors CCHQ's authoring path at
// `commcare-hq/corehq/apps/app_manager/views/modules.py::_update_search_properties`,
// which writes one of `input_` OR `appearance` per property — never
// both — based on the authoring widget kind:
//
//   - `text`       — no `@input`, no `@appearance` (CCHQ default).
//   - `select`     — `input="select1"` (single-select; the multi-
//                    select widget would emit `input="select"`,
//                    Nova's `select` kind is single-select per the
//                    `SEARCH_INPUT_TYPES` documentation in
//                    `lib/domain/modules.ts`).
//   - `date`       — `input="date"`.
//   - `date-range` — `input="daterange"` (CCHQ collapses the two
//                    words; the wire token is `daterange`, not
//                    `date-range`).
//   - `barcode`    — `appearance="barcode_scan"` (NOT `@input`).
//                    CCHQ's authoring path treats barcode as an
//                    on-device input affordance composed via
//                    `appearance`, not a typed prompt input.
//
// ## Per-arm dispatch
//
// `simple` and `advanced` arms emit the same `<prompt>` shape — the
// distinction surfaces at search-execution time, not at prompt
// declaration:
//
//   - **Simple arm.** CCHQ matches the prompt value against the
//     configured property at runtime via the simple-arm
//     `(property, mode, via)` slots. Those slots inform the runtime
//     match, not the wire prompt shape; the prompt block declares
//     the input slot only.
//
//   - **Advanced arm.** The row carries a Predicate that references
//     the input by name through `input("name")` terms; the
//     `<prompt>` element declares the input slot identically; the
//     orchestrator (`<remote-request>` Task) AND-composes every
//     advanced-arm predicate into the `<query>`'s
//     `<data key="_xpath_query">` CSQL string. The empty-input
//     wrapping (`whenInputPresent(input("name"), predicate)`) is the
//     authoring contract enforced by the validator; the wire layer
//     emits the predicate verbatim.
//
// To keep the orchestrator's composition step total and free of
// arm-discrimination logic, this module exposes two helpers:
// `emitSearchPrompts` returns the prompt-element XML + locale
// registrations, and `getAdvancedArmPredicates` returns the
// `(name, predicate)` pairs the orchestrator AND-composes into
// `_xpath_query`. Splitting the helpers (rather than returning a
// tuple) keeps each function single-purpose and lets call sites
// import only what they consume.

import { emitOnDeviceExpression } from "@/lib/commcare/expression";
import type { SearchInputDef, SearchInputType } from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import { escapeXml } from "../../xml";
import type { CaseListEmission } from "../case-list/types";

// ── Per-input-type wire-attribute mapping ─────────────────────────
//
// The mapping table is the single source of truth for the
// `(input, appearance)` attribute slots. Adding a new
// `SearchInputType` is a compile error if its row is missing — the
// `Record<SearchInputType, ...>` keying enforces exhaustiveness.
//
// `input` and `appearance` are mutually exclusive at the CCHQ
// authoring layer; the table reflects that — at most one slot is
// populated per row. The wire emitter writes only the populated
// slots, so the `text` arm (both empty) emits no type-discriminator
// attributes and CCHQ's runtime renders a plain text input.

interface PromptAttributeMapping {
	/** Value for the `<prompt input="...">` attribute, when present. */
	readonly input?: string;
	/** Value for the `<prompt appearance="...">` attribute, when present. */
	readonly appearance?: string;
}

const PROMPT_ATTRIBUTE_MAPPINGS: Readonly<
	Record<SearchInputType, PromptAttributeMapping>
> = {
	// CCHQ's default: omit both attributes. The runtime renders a
	// plain text input.
	text: {},
	// Single-select picker (CCHQ's `input_="select1"`). The Itemset
	// child element that CCHQ pairs with `select1` is not yet
	// modeled in Nova's authoring surface; the wire layer emits the
	// type discriminator and leaves itemset configuration for a
	// future enhancement.
	select: { input: "select1" },
	// CCHQ collapses the type discriminator to `date`.
	date: { input: "date" },
	// CCHQ collapses the type discriminator to `daterange` (single
	// token, not the `date-range` shape Nova uses internally).
	"date-range": { input: "daterange" },
	// CCHQ routes barcode through `@appearance`, not `@input`. The
	// runtime reads `appearance="barcode_scan"` as an on-device
	// input affordance that overlays a scanner UI on top of an
	// otherwise-text input.
	barcode: { appearance: "barcode_scan" },
};

// ── Public surface ───────────────────────────────────────────────

/**
 * Compose the `<prompt>` element list that lives inside a
 * `<remote-request>`'s `<query>` body. One element per
 * `caseListConfig.searchInputs[i]`. The result's `xml` field is the
 * concatenated multi-line XML chunk (each `<prompt>` indented to 8
 * spaces from column zero, matching the canonical fixture's
 * `<query>` indent depth); the `strings` field collects the
 * `search_property.{moduleId}.{input.name}` locale registrations
 * the surrounding compiler threads into `app_strings.txt`.
 *
 * The function is total over the input — every `SearchInputDef` arm
 * produces a well-formed `<prompt>` element. An empty
 * `searchInputs` array yields an empty XML string and an empty
 * locale map; the orchestrator handles the no-prompt branch
 * structurally without a special-case sentinel.
 *
 * `moduleId` is the wire-side module identifier (`m0`, `m1`, …)
 * supplied by the orchestrator. The locale-id pattern follows
 * CCHQ's `id_strings.py::search_property_locale`
 * (`search_property.{moduleId}.{name}`).
 */
export function emitSearchPrompts(
	searchInputs: ReadonlyArray<SearchInputDef>,
	moduleId: string,
): CaseListEmission {
	if (searchInputs.length === 0) {
		return { xml: "", strings: {} };
	}

	const lines: string[] = [];
	const strings: Record<string, string> = {};

	for (const input of searchInputs) {
		// Every input gets a `<display>` block — matches CCHQ's
		// canonical wire shape, where `Display(text=Text(locale_id=…))`
		// is always present on every `QueryPrompt`. The locale id
		// follows `search_property.{moduleId}.{name}` per CCHQ's
		// `id_strings.py::search_property_locale`. When `input.label`
		// is empty, the locale registers the `name` as a sensible UX
		// fallback so the runtime renders something readable rather
		// than the locale id itself.
		const localeId = composeSearchPropertyLocaleId(moduleId, input.name);
		strings[localeId] = input.label !== "" ? input.label : input.name;

		lines.push(emitPromptElement(input, localeId));
	}

	return { xml: lines.join("\n"), strings };
}

/**
 * Extract the `(name, predicate)` pairs the `<remote-request>`
 * orchestrator AND-composes into `<data key="_xpath_query">`. Only
 * the `advanced` arm contributes predicates — simple-arm rows route
 * through CCHQ's runtime `(property, mode, via)` matcher and don't
 * appear in the explicit XPath query.
 *
 * Returning the predicates verbatim (without the
 * `whenInputPresent(...)` empty-input wrapper) is intentional. The
 * authoring contract is that advanced-arm predicates either
 * (a) reference no input — constant filter clauses — or
 * (b) wrap input references through `whenInputPresent` themselves.
 * The validator enforces this contract; the wire emitter trusts it.
 *
 * The `name` field is the `input.name` slot — the same value that
 * appears as `<prompt key="...">` in the wire output of
 * `emitSearchPrompts`. The orchestrator threads each predicate
 * through `emitCsql` and AND-composes the results.
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
 * Build the locale id that resolves to the prompt's display label.
 * Mirrors CCHQ's `id_strings.py::search_property_locale` —
 * `search_property.{moduleId}.{name}`. The validator gates
 * `searchInputs[i].name` upstream against CCHQ's identifier rules;
 * the consumer at `composeDisplayBlock` runs `escapeXml` on the
 * interpolated id as a defense for the case where the validator's
 * coverage drifts from CCHQ's grammar.
 */
function composeSearchPropertyLocaleId(moduleId: string, name: string): string {
	return `search_property.${moduleId}.${name}`;
}

/**
 * Emit a single `<prompt>` element for one search input. The XML
 * indent depth is 8 spaces from column zero — the canonical
 * `<query>` body indent in CCHQ's `remote_request.xml` fixture.
 *
 * `localeId` is the registered display-label locale id. CCHQ's
 * canonical wire shape always emits `<display>` (the
 * `Display(text=Text(locale_id=…))` constructor in
 * `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_query_prompts`
 * runs unconditionally for every property), so this function always
 * emits the `<display>` block as a child.
 */
function emitPromptElement(input: SearchInputDef, localeId: string): string {
	const attrs = composePromptAttributes(input);
	const displayBlock = composeDisplayBlock(localeId);

	return [
		`        <prompt${attrs}>`,
		...displayBlock,
		`        </prompt>`,
	].join("\n");
}

/**
 * Compose the attribute list for a `<prompt>` element. Attribute
 * order follows CCHQ's `QueryPrompt` model declaration order: `key`
 * first (the discriminator), then `appearance`, then `input`, then
 * `default`. Only populated slots emit; absent slots are skipped so
 * the wire string stays minimal.
 *
 * Every interpolated value routes through `escapeXml` so XML-
 * unsafe characters in `name` / `default`-compiled XPath / mapped
 * attribute values can't break the wire shape. The mapping table's
 * values are CCHQ literals (XML-safe by inspection); the escape
 * pass on them is defensive — costless and forward-compatible if
 * the table grows.
 */
function composePromptAttributes(input: SearchInputDef): string {
	const mapping = PROMPT_ATTRIBUTE_MAPPINGS[input.type];

	const parts: string[] = [];
	parts.push(` key="${escapeXml(input.name)}"`);

	// `appearance` precedes `input` in CCHQ's authoring path — when
	// both are populated (no current type combines them, but the
	// mapping table allows growth) the ordering matches CCHQ's
	// QueryPrompt field declaration order.
	if (mapping.appearance !== undefined) {
		parts.push(` appearance="${escapeXml(mapping.appearance)}"`);
	}
	if (mapping.input !== undefined) {
		parts.push(` input="${escapeXml(mapping.input)}"`);
	}

	// `default` is an attribute, not a child element. The compiled
	// on-device XPath may contain XML-unsafe characters (`<` / `>`
	// / `&` in expression bodies); the escape pass makes the
	// attribute-value form safe across every input.default shape.
	if (input.default !== undefined) {
		const defaultXPath = compileDefaultExpression(input.default);
		parts.push(` default="${escapeXml(defaultXPath)}"`);
	}

	return parts.join("");
}

/**
 * Compose the `<display>` child block of a `<prompt>` element.
 * Returns the per-line XML chunks the caller joins with newlines;
 * the leading indent on each line matches the surrounding
 * `<prompt>` indent + 2 spaces.
 *
 * The locale id embeds the input's `name` slot, which the schema
 * declares as a bare `z.string()` (no character-set enforcement).
 * `escapeXml` runs on the interpolated id so an XML-unsafe `name`
 * slot (`&` / `<` / `>` / `"`) cannot break the surrounding
 * attribute quoting. The validator gates `searchInputs[i].name`
 * upstream against CCHQ's identifier rules; this defense covers
 * the case where the validator's coverage drifts from CCHQ's
 * grammar.
 */
function composeDisplayBlock(localeId: string): readonly string[] {
	return [
		`          <display>`,
		`            <text>`,
		`              <locale id="${escapeXml(localeId)}"/>`,
		`            </text>`,
		`          </display>`,
	];
}

/**
 * Compile a `ValueExpression` AST to its on-device XPath wire
 * string. The `<prompt default>` slot is on-device-evaluated; the
 * shared on-device emitter at
 * `lib/commcare/expression/onDeviceEmitter.ts` produces the right
 * dialect.
 */
function compileDefaultExpression(expression: ValueExpression): string {
	return emitOnDeviceExpression(expression);
}
