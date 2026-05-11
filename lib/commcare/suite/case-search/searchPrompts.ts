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
// Type-mapping decisions are CCHQ-authoritative and pinned in the
// mapping table below. Two CCHQ-side gotchas worth highlighting:
// `default_value` is an XML attribute (`@default`), not a child
// `<default>` element; barcode rides on `@appearance="barcode_scan"`,
// not `@input`. Both verified against the `QueryPrompt` model.

import type { SearchInputDef, SearchInputType } from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import { escapeXml } from "../../xml";
import type { CaseListEmission } from "../case-list/types";

// ── Per-input-type wire-attribute mapping ─────────────────────────
//
// `input` and `appearance` are mutually exclusive on CCHQ's
// `QueryPrompt`. The table populates at most one per row; the
// emitter writes only populated slots, so the `text` arm emits no
// type discriminator and CCHQ renders a plain text input.
//
// `Record<SearchInputType, ...>` keys this exhaustively — a new
// `SearchInputType` arm is a compile error until its row lands.

interface PromptAttributeMapping {
	/** Value for the `<prompt input="...">` attribute, when present. */
	readonly input?: string;
	/** Value for the `<prompt appearance="...">` attribute, when present. */
	readonly appearance?: string;
}

const PROMPT_ATTRIBUTE_MAPPINGS: Readonly<
	Record<SearchInputType, PromptAttributeMapping>
> = {
	// CCHQ default — both attributes omitted, plain text input.
	text: {},
	// CCHQ's `input_="select1"`. The runtime widget renders the
	// option list from the property's declared options at search
	// time; Nova doesn't project an `<itemset>` child into the prompt.
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
		// When `input.label` is empty the locale registers `input.name`
		// — gives the runtime something readable to render rather than
		// the locale id itself.
		const localeId = composeSearchPropertyLocaleId(moduleId, input.name);
		strings[localeId] = input.label !== "" ? input.label : input.name;

		lines.push(emitPromptElement(input, localeId));
	}

	return { xml: lines.join("\n"), strings };
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
 * Emit one `<prompt>` element. CCHQ always emits `<display>` on
 * every `QueryPrompt`, so this function does the same as a child.
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
 * Compose the attribute list for a `<prompt>` element. Order
 * follows `QueryPrompt`'s field declaration order: `key`,
 * `appearance`, `input`, `default`. Absent slots are skipped.
 *
 * Every interpolated value routes through `escapeXml` — `default`'s
 * compiled XPath in particular may carry `<` / `>` / `&` in
 * expression bodies. The escape pass on the mapping table's CCHQ-
 * literal values is defensive; costless and forward-compatible.
 */
function composePromptAttributes(input: SearchInputDef): string {
	const mapping = PROMPT_ATTRIBUTE_MAPPINGS[input.type];

	const parts: string[] = [];
	parts.push(` key="${escapeXml(input.name)}"`);

	if (mapping.appearance !== undefined) {
		parts.push(` appearance="${escapeXml(mapping.appearance)}"`);
	}
	if (mapping.input !== undefined) {
		parts.push(` input="${escapeXml(mapping.input)}"`);
	}

	// `default` is the attribute form, not a child `<default>` element
	// — see `QueryPrompt::default_value = StringField('@default', ...)`.
	if (input.default !== undefined) {
		const defaultXPath = compileDefaultExpression(input.default);
		parts.push(` default="${escapeXml(defaultXPath)}"`);
	}

	return parts.join("");
}

/**
 * Compose the `<display>` child block. The schema declares
 * `input.name` as bare `z.string()`; `escapeXml` on the
 * interpolated locale id defends against an XML-unsafe `name`
 * slipping past the validator's identifier-rule coverage.
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
 * Compile a `ValueExpression` to its on-device XPath wire string.
 * `<prompt default>` is on-device-evaluated; the shared emitter
 * produces the right dialect.
 */
function compileDefaultExpression(expression: ValueExpression): string {
	return emitOnDeviceExpression(expression);
}
