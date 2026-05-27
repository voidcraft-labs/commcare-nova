// lib/commcare/suite/case-search/__tests__/searchPrompts.test.ts
//
// Acceptance tests for `emitSearchPrompts` + `getAdvancedArmPredicates`.
// Each `it` block pins one observable invariant of the wire shape
// against CCHQ's authoritative source — either the canonical fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`
// or the model declaration at
// `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::QueryPrompt`.
//
// Coverage walks three orthogonal axes:
//
//   1. **Per-`SearchInputType` wire mapping.** Five rows: `text`
//      (no `@input`), `select` (`@input="select1"`), `date`
//      (`@input="date"`), `date-range` (`@input="daterange"`),
//      `barcode` (`@appearance="barcode_scan"`, NOT `@input`). One
//      test per row.
//
//   2. **Display + default contracts.** `<display>` always emits
//      (matches CCHQ canonical shape). The locale-string entry
//      registers `input.label` when set, falling back to
//      `input.name` for empty labels so the runtime renders
//      something readable rather than the locale id itself. The
//      `@default` attribute populates from `input.default` when
//      present, omitted otherwise.
//
//   3. **Per-arm dispatch.** Simple-arm and advanced-arm rows emit
//      the same `<prompt>` shape. Advanced-arm predicates surface
//      via the sibling `getAdvancedArmPredicates` helper for the
//      orchestrator's `_xpath_query` AND-composition. Simple-arm
//      rows do not contribute to that helper's output.
//
//   4. **Attribute order.** When multiple optional attributes
//      populate, the wire emission orders them `key`, `appearance`,
//      `input`, `default` — matching CCHQ's `QueryPrompt` model
//      declaration order in
//      `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py`.
//
// Plus a golden-file comparison against the canonical fixture's
// `<prompt>` block (`name` plain, `dob` date, `consent` checkbox)
// to pin the wire shape end-to-end. The `consent` row exercises a
// `select`-typed input mapping to `select1` rather than the
// fixture's `checkbox` value, since Nova's `SEARCH_INPUT_TYPES`
// does not surface `checkbox` as an authoring kind — `select` is
// the closest authored shape, and `select1` is its CCHQ wire
// mapping. The structural shape (key, input attribute presence,
// display block) matches the fixture row-for-row.

import { describe, expect, it } from "vitest";
import {
	advancedSearchInputDef,
	asUuid,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	dateCoerce,
	dateLiteral,
	eq,
	input,
	literal,
	prop,
	relationStep,
	term,
	today,
	whenInput,
} from "@/lib/domain/predicate/builders";
import { emitSearchPrompts, getAdvancedArmPredicates } from "../searchPrompts";

// ============================================================
// Test helpers
// ============================================================

const INPUT_UUIDS = {
	a: asUuid("00000000-0000-4000-8000-aaaa00000001"),
	b: asUuid("00000000-0000-4000-8000-aaaa00000002"),
	c: asUuid("00000000-0000-4000-8000-aaaa00000003"),
} as const;

/** Wire-side module identifier matching CCHQ's `m{idx}` pattern. */
const MODULE_ID = "m0";

// ============================================================
// Per-input-type wire-attribute mapping
// ============================================================

describe("emitSearchPrompts — per-input-type attribute mapping", () => {
	it("text type omits both @input and @appearance (CCHQ default)", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "name", "Name", "text", "name"),
		];

		const { xml, strings } = emitSearchPrompts(inputs, MODULE_ID);

		// No `input` attr, no `appearance` attr — bare `key`. Compact
		// serializer output, no per-element whitespace.
		expect(xml).toBe(
			`<prompt key="name">` +
				`<display><text><locale id="search_property.m0.name"/></text></display>` +
				`</prompt>`,
		);
		expect(strings).toEqual({ "search_property.m0.name": "Name" });
	});

	it("select type emits input='select1'", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"district",
				"District",
				"select",
				"district",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<prompt key="district" input="select1">`);
	});

	it("date type emits input='date'", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"dob",
				"Date of birth",
				"date",
				"dob",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<prompt key="dob" input="date">`);
	});

	it("date-range type emits input='daterange' (CCHQ collapses the token)", () => {
		// `name === property` (the bare-prompt-correct shape) so the
		// derivation gate keeps this input off the exclude route; the
		// test pins the daterange widget mapping in isolation.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"visit_date",
				"Visit window",
				"date-range",
				"visit_date",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<prompt key="visit_date" input="daterange">`);
	});

	it("barcode type emits appearance='barcode_scan' (NOT @input)", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"id_code",
				"ID code",
				"barcode",
				"id_code",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<prompt key="id_code" appearance="barcode_scan">`);
		// Critical: barcode rides on @appearance, never @input. CCHQ's
		// authoring path at views/modules.py routes `barcode_scan`
		// through `appearance`; `input` would be a wire-shape error.
		expect(xml).not.toContain(`input=`);
	});
});

// ============================================================
// <display> presence depends on input.label
// ============================================================

describe("emitSearchPrompts — <display> element + locale registration", () => {
	it("registers the input.label string at the search_property locale id", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "name", "Name", "text", "name"),
		];

		const { xml, strings } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<display>`);
		expect(xml).toContain(`<locale id="search_property.m0.name"/>`);
		expect(strings).toEqual({ "search_property.m0.name": "Name" });
	});

	it("falls back to input.name when input.label is empty (still emits <display>)", () => {
		// CCHQ canonical shape always emits `<display>` — the wire
		// emitter matches that and registers a sensible UX fallback
		// (`name`) at the locale id rather than registering an empty
		// string (which would leave the runtime rendering nothing).
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "name", "", "text", "name"),
		];

		const { xml, strings } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<display>`);
		expect(xml).toContain(`<locale id="search_property.m0.name"/>`);
		expect(strings).toEqual({ "search_property.m0.name": "name" });
	});
});

// ============================================================
// @default attribute depends on input.default
// ============================================================

describe("emitSearchPrompts — @default attribute conditional on input.default", () => {
	it("populates @default with the compiled on-device XPath in the canonical attribute slot", () => {
		// The full wire string pins `@default` BEFORE `@exclude` per
		// CCHQ's `QueryPrompt` model declaration order. A regression
		// that flipped attribute order — say, emitting `default`
		// before `input`, or `exclude` before `default` — would fail
		// this exact-string check. The fixture uses `name === property`
		// (the bare-prompt-correct shape) so the derivation gate
		// keeps the input off the exclude route; a sibling test
		// covers the `name !== property` + default combination.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "dob", "Since", "date", "dob", {
				default: today(),
			}),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		// Compact serializer output.
		expect(xml).toBe(
			`<prompt key="dob" input="date" default="today()">` +
				`<display><text><locale id="search_property.m0.dob"/></text></display>` +
				`</prompt>`,
		);
	});

	it("omits @default attribute when input.default is absent", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "name", "Name", "text", "name"),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).not.toContain(`default=`);
	});

	it("compiles a date-coerce default through the on-device emitter", () => {
		// `dateCoerce(literal)` lowers to wire `date(<literal>)` —
		// the XPath idiom for a typed date value that the runtime
		// parses before comparison. The `escapeXml` helper covers
		// `&` / `<` / `>` / `"` — defense for compiled XPath bodies
		// that may contain these characters; this particular body
		// uses single quotes around the date string, so nothing in
		// it needs escaping.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "since", "Since", "date", "dob", {
				default: dateCoerce(term(dateLiteral("2024-01-01"))),
			}),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		// XPath single-quote literals (`'2024-01-01'`) round-trip
		// through the serializer as `&apos;` inside the double-quoted
		// `default` attribute value.
		expect(xml).toContain(`default="date(&apos;2024-01-01&apos;)"`);
	});

	it("orders attributes key, appearance, input, default for a barcode + default combination", () => {
		// Hits both orthogonal optional slots — `appearance` (from
		// the barcode mapping) AND `default` (author-set) — to pin
		// the canonical declaration order across the broader
		// matrix. `barcode` does not normally carry a `default`,
		// but the attribute-emission code is mapping-driven so the
		// combination exercises the slot ordering directly.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"id_code",
				"ID code",
				"barcode",
				"id_code",
				{ default: today() },
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(
			`<prompt key="id_code" appearance="barcode_scan" default="today()">`,
		);
	});
});

// ============================================================
// exclude="true()" — bogus-auto-match suppression
// ============================================================

describe("emitSearchPrompts — exclude attribute (simple-arm bogus-auto-match suppression)", () => {
	it("emits exclude='true()' on a simple-arm input whose `name !== property` (self-walk, default exact)", () => {
		// CCHQ's runtime auto-matches the typed value against the case
		// property NAMED BY the prompt key — verified at
		// `commcare-hq/.../suite_xml/post_process/remote_requests.py::build_query_prompts`
		// (`'key': prop.name`) and `commcare-hq/.../case_search/utils.py::_apply_filter`
		// (the non-special key path routes the prompt key as the case
		// property name). When `name !== property` the auto-match
		// queries a case property that may not exist; the `<prompt
		// exclude="true()">` attribute suppresses the auto-match while
		// keeping the typed value bound to the search-input instance
		// for the explicit `_xpath_query` predicate.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"name_search",
				"Search by name",
				"text",
				"case_name",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<prompt key="name_search" exclude="true()">`);
	});

	it("emits exclude='true()' on a simple-arm input whose mode is fuzzy / starts-with / phonetic / fuzzy-date (every non-default mode)", () => {
		// Same suppression: every non-default mode routes through
		// `_xpath_query`, so the bare-prompt auto-match would AND
		// against the explicit matcher predicate and silently narrow
		// the result set.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"name_fuzzy",
				"Name (fuzzy)",
				"text",
				"name_fuzzy",
				{ mode: { kind: "fuzzy" } },
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`exclude="true()"`);
	});

	it("emits exclude='true()' on a simple-arm input with a non-self via (cross-walk)", () => {
		// Cross-walk simple-arm: the bare prompt has no relation-walk
		// metadata, so the explicit predicate carries the walk and the
		// prompt rides exclude='true()' to silence the auto-match
		// against the prompt key on the wrong case.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"parent_name",
				"Parent name",
				"text",
				"case_name",
				{ via: ancestorPath(relationStep("parent")) },
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`exclude="true()"`);
	});

	it("does NOT emit exclude attribute when `name === property` AND self-walk AND default exact mode (the bare-prompt-correct case)", () => {
		// CCHQ's auto-match against the prompt key IS the authored
		// comparison here — emitting `exclude="true()"` would suppress
		// the very behaviour the user wants. Pin the negative so a
		// regression that over-applies the exclude attribute surfaces.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"case_name",
				"Name",
				"text",
				"case_name",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).not.toContain(`exclude=`);
	});

	it("does NOT emit exclude attribute on an advanced-arm input", () => {
		// Advanced-arm inputs author their entire predicate; CCHQ's
		// runtime auto-match against the prompt key isn't part of
		// their semantic, so the attribute would be noise. Diverging
		// from CCHQ's typical advanced-arm wire shape without a
		// runtime benefit is its own footgun.
		const inputs: SearchInputDef[] = [
			advancedSearchInputDef(
				INPUT_UUIDS.a,
				"name",
				"Name",
				"text",
				eq(prop("patient", "name"), literal("Alice")),
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).not.toContain(`exclude=`);
	});

	it("places exclude='true()' AFTER default attribute (CCHQ-canonical declaration order)", () => {
		// CCHQ's `QueryPrompt` model declares `exclude` after the
		// default-value slot; pin the full attribute order so a
		// regression that flipped exclude before default would fail
		// this exact-string check.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"since_search",
				"Since",
				"date",
				"dob",
				{ default: today() },
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(
			`<prompt key="since_search" input="date" default="today()" exclude="true()">`,
		);
	});
});

// ============================================================
// Per-arm dispatch
// ============================================================

describe("emitSearchPrompts — per-arm dispatch", () => {
	it("simple-arm and advanced-arm emit the same <prompt> shape", () => {
		// Both arms carry the same `(name, label, type)` triple — the
		// wire output should be byte-identical for them. The arms
		// diverge in their predicate composition (advanced contributes
		// to `_xpath_query`), not in the prompt-element wire shape.
		// Uses `name === property` on the simple arm so the simple-arm
		// derivation gate keeps both arms in the no-exclude branch.
		const simple: SearchInputDef = simpleSearchInputDef(
			INPUT_UUIDS.a,
			"name",
			"Name",
			"text",
			"name",
		);
		const advanced: SearchInputDef = advancedSearchInputDef(
			INPUT_UUIDS.b,
			"name",
			"Name",
			"text",
			eq(prop("patient", "name"), literal("Alice")),
		);

		const simpleEmission = emitSearchPrompts([simple], MODULE_ID);
		const advancedEmission = emitSearchPrompts([advanced], MODULE_ID);

		expect(simpleEmission.xml).toBe(advancedEmission.xml);
	});

	it("advanced-arm predicates surface via getAdvancedArmPredicates", () => {
		const predicate = whenInput(
			input("name"),
			eq(prop("patient", "name"), literal("Alice")),
		);

		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "first", "First", "text", "first"),
			advancedSearchInputDef(INPUT_UUIDS.b, "name", "Name", "text", predicate),
		];

		const advancedPredicates = getAdvancedArmPredicates(inputs);

		// Simple-arm row contributes nothing; only the advanced-arm
		// row surfaces in the helper's output. The orchestrator
		// AND-composes these into `<data key="_xpath_query">`.
		expect(advancedPredicates).toEqual([{ name: "name", predicate }]);
	});

	it("getAdvancedArmPredicates returns empty for all-simple inputs", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "first", "First", "text", "first"),
			simpleSearchInputDef(INPUT_UUIDS.b, "last", "Last", "text", "last"),
		];

		expect(getAdvancedArmPredicates(inputs)).toEqual([]);
	});

	it("getAdvancedArmPredicates preserves source-array ordering", () => {
		// The orchestrator AND-composes the predicates into one CSQL
		// clause; the relative order is observable in the wire string.
		// The helper preserves source-array order so the orchestrator
		// can reproduce author intent verbatim.
		const p1 = eq(prop("patient", "name"), literal("A"));
		const p2 = eq(prop("patient", "age"), literal(10));

		const inputs: SearchInputDef[] = [
			advancedSearchInputDef(INPUT_UUIDS.a, "name", "Name", "text", p1),
			simpleSearchInputDef(INPUT_UUIDS.b, "first", "First", "text", "first"),
			advancedSearchInputDef(INPUT_UUIDS.c, "age", "Age", "text", p2),
		];

		expect(getAdvancedArmPredicates(inputs)).toEqual([
			{ name: "name", predicate: p1 },
			{ name: "age", predicate: p2 },
		]);
	});
});

// ============================================================
// Empty-input + ordering invariants
// ============================================================

describe("emitSearchPrompts — empty + ordering invariants", () => {
	it("empty searchInputs array yields empty xml + empty strings", () => {
		const { xml, strings } = emitSearchPrompts([], MODULE_ID);

		expect(xml).toBe("");
		expect(strings).toEqual({});
	});

	it("preserves source-array order across multi-input emission", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "name", "Name", "text", "name"),
			simpleSearchInputDef(INPUT_UUIDS.b, "dob", "DOB", "date", "dob"),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		// Simple ordering check: `name` prompt opens before `dob` prompt.
		const nameIdx = xml.indexOf(`key="name"`);
		const dobIdx = xml.indexOf(`key="dob"`);
		expect(nameIdx).toBeGreaterThanOrEqual(0);
		expect(dobIdx).toBeGreaterThanOrEqual(0);
		expect(nameIdx).toBeLessThan(dobIdx);
	});

	it("threads moduleId through every locale id", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "name", "Name", "text", "name"),
		];

		const m0 = emitSearchPrompts(inputs, "m0");
		const m3 = emitSearchPrompts(inputs, "m3");

		expect(m0.xml).toContain(`search_property.m0.name`);
		expect(m3.xml).toContain(`search_property.m3.name`);
		expect(m0.strings).toEqual({ "search_property.m0.name": "Name" });
		expect(m3.strings).toEqual({ "search_property.m3.name": "Name" });
	});
});

// ============================================================
// Golden-file comparison against canonical fixture
// ============================================================

describe("emitSearchPrompts — golden-file vs CCHQ remote_request.xml", () => {
	it("matches the fixture's <prompt> block shape (name + dob + select)", () => {
		// The fixture at
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`
		// carries three prompts:
		//   - `name` (text, no `@input`)
		//   - `dob` (date, `@input="date"`)
		//   - `consent` (checkbox, `@input="checkbox"`)
		//
		// Nova's authoring vocabulary surfaces `text` / `select` /
		// `date` / `date-range` / `barcode`. `checkbox` is not an
		// authored kind; the closest mapping is `select`, which CCHQ
		// renders as `input="select1"`. The structural shape (key
		// attribute, input-attr presence, display block, locale id
		// pattern) matches the fixture row-for-row.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "name", "Name", "text", "name"),
			simpleSearchInputDef(
				INPUT_UUIDS.b,
				"dob",
				"Date of birth",
				"date",
				"dob",
			),
			simpleSearchInputDef(
				INPUT_UUIDS.c,
				"consent",
				"Consent",
				"select",
				"consent",
			),
		];

		const { xml, strings } = emitSearchPrompts(inputs, MODULE_ID);

		// Pin the exact wire string so any structural drift surfaces.
		// Compact serializer output — element order and attribute
		// insertion order are the load-bearing properties; the
		// surrounding orchestrator joins the three `<prompt>` elements
		// with a newline as it composes the `<query>` body.
		const expected = [
			`<prompt key="name">` +
				`<display><text><locale id="search_property.m0.name"/></text></display>` +
				`</prompt>`,
			`<prompt key="dob" input="date">` +
				`<display><text><locale id="search_property.m0.dob"/></text></display>` +
				`</prompt>`,
			`<prompt key="consent" input="select1">` +
				`<display><text><locale id="search_property.m0.consent"/></text></display>` +
				`</prompt>`,
		].join("\n");

		expect(xml).toBe(expected);
		expect(strings).toEqual({
			"search_property.m0.name": "Name",
			"search_property.m0.dob": "Date of birth",
			"search_property.m0.consent": "Consent",
		});
	});
});
