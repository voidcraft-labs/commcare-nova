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
//   2. **Optional slot presence.** `<display>` element omits when
//      `input.label` is empty; `<default>` attribute omits when
//      `input.default` is absent; both populate when set.
//
//   3. **Per-arm dispatch.** Simple-arm and advanced-arm rows emit
//      the same `<prompt>` shape. Advanced-arm predicates surface
//      via the sibling `getAdvancedArmPredicates` helper for the
//      orchestrator's `_xpath_query` AND-composition. Simple-arm
//      rows do not contribute to that helper's output.
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
	dateCoerce,
	dateLiteral,
	eq,
	input,
	literal,
	prop,
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

		// No `input` attr, no `appearance` attr — bare `key`.
		expect(xml).toBe(
			[
				`        <prompt key="name">`,
				`          <display>`,
				`            <text>`,
				`              <locale id="search_property.m0.name"/>`,
				`            </text>`,
				`          </display>`,
				`        </prompt>`,
			].join("\n"),
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
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"visit_window",
				"Visit window",
				"date-range",
				"visit_date",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<prompt key="visit_window" input="daterange">`);
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
	it("populates @default with the compiled on-device XPath when input.default is set", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "since", "Since", "date", "dob", {
				default: today(),
			}),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		// `today()` is a CCHQ on-device value function — the emitter
		// renders it as the wire string `today()`. The attribute value
		// is XML-attribute-escaped; `today()` contains no XML-unsafe
		// characters, so the literal string appears intact.
		expect(xml).toContain(`default="today()"`);
	});

	it("omits @default attribute when input.default is absent", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "name", "Name", "text", "name"),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).not.toContain(`default=`);
	});

	it("compiles a date-coerce default through the on-device emitter", () => {
		// `dateCoerce(literal)` lowers to wire `date(<literal>)` — the
		// XPath idiom for a typed date value that the runtime parses
		// before comparison. The compiled attribute body uses single
		// quotes around the date string, so the XML attribute's
		// surrounding double quotes stay safe; the `escapeXml` pass
		// covers `&` / `<` / `>` / `"` if any of those leak in
		// future shapes.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "since", "Since", "date", "dob", {
				default: dateCoerce(term(dateLiteral("2024-01-01"))),
			}),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`default="date('2024-01-01')"`);
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
		// Indent depth (8 spaces for `<prompt>`, 10 for `<display>`,
		// 12 for `<text>`, 14 for `<locale>`) matches the fixture's
		// `<query>` body indent.
		const expected = [
			`        <prompt key="name">`,
			`          <display>`,
			`            <text>`,
			`              <locale id="search_property.m0.name"/>`,
			`            </text>`,
			`          </display>`,
			`        </prompt>`,
			`        <prompt key="dob" input="date">`,
			`          <display>`,
			`            <text>`,
			`              <locale id="search_property.m0.dob"/>`,
			`            </text>`,
			`          </display>`,
			`        </prompt>`,
			`        <prompt key="consent" input="select1">`,
			`          <display>`,
			`            <text>`,
			`              <locale id="search_property.m0.consent"/>`,
			`            </text>`,
			`          </display>`,
			`        </prompt>`,
		].join("\n");

		expect(xml).toBe(expected);
		expect(strings).toEqual({
			"search_property.m0.name": "Name",
			"search_property.m0.dob": "Date of birth",
			"search_property.m0.consent": "Consent",
		});
	});
});
