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
//      `@default` attribute populates from a scalar input's
//      `input.default` when present. Date range deliberately omits the
//      historical scalar slot because one expression cannot seed both ends.
//
//   3. **Per-arm dispatch.** Both arms emit prompt bindings. Advanced
//      prompts carry `exclude="true()"` so CommCare Core binds their
//      values without also auto-matching the prompt key as a case
//      property. Their predicates surface via the sibling
//      `getAdvancedArmPredicates` helper for `_xpath_query`.
//
//   4. **Attribute order.** When multiple optional attributes
//      populate, the wire emission orders them `key`, `appearance`,
//      `input`, `default` — matching CCHQ's `QueryPrompt` model
//      declaration order in
//      `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py`.
//
// Plus a golden-file comparison against the canonical fixture's
// `<prompt>` block (plain text, `dob` date, `consent` checkbox)
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
	type CaseListConfig,
	type SearchInputDef,
	type SearchInputType,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	count,
	dateAdd,
	dateCoerce,
	dateLiteral,
	double,
	eq,
	gt,
	input,
	literal,
	prop,
	relationStep,
	subcasePath,
	term,
	today,
	whenInput,
	within,
} from "@/lib/domain/predicate/builders";
import {
	emitSearchPrompts,
	getAdvancedArmPredicates,
	RUNTIME_CSQL_QUOTE_VALIDATION_MESSAGE,
} from "../searchPrompts";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
} from "../xpathQuery";

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
	it("combines quote and calendar-number rules into Core's one validation slot", () => {
		const predicate = whenInput(
			input("months"),
			eq(
				prop("patient", "due_date"),
				dateAdd(today(), "months", double(term(input("months")))),
			),
		);
		const inputDef = advancedSearchInputDef(
			INPUT_UUIDS.a,
			"months",
			"Months",
			"text",
			predicate,
		);
		const config: CaseListConfig = { columns: [], searchInputs: [inputDef] };
		const validations = buildRuntimeCsqlPromptValidations(
			composeXPathQueryEmission(config, "patient"),
		);
		const validation = validations.get("months");

		expect(validation?.test).toContain(
			"number(instance('search-input:results')",
		);
		expect(validation?.test).toContain("= floor(number(");
		expect(validation?.test).toContain(
			"count(instance('search-input:results')",
		);
		expect(validation?.test).toContain("contains(");
		expect(validation?.message).toContain("whole number");
		const { xml } = emitSearchPrompts([inputDef], MODULE_ID, validations);
		expect(xml.match(/<validation /g)).toHaveLength(1);
	});

	it("uses a nonnegative whole-number rule for prompted child counts", () => {
		const predicate = whenInput(
			input("minimum"),
			gt(count(subcasePath("child")), double(term(input("minimum")))),
		);
		const inputDef = advancedSearchInputDef(
			INPUT_UUIDS.a,
			"minimum",
			"Minimum",
			"text",
			predicate,
		);
		const config: CaseListConfig = { columns: [], searchInputs: [inputDef] };
		const validation = buildRuntimeCsqlPromptValidations(
			composeXPathQueryEmission(config, "patient"),
		).get("minimum");

		expect(validation?.test).toContain(") >= 0");
		expect(validation?.test).toContain(
			"count(instance('search-input:results')",
		);
		expect(validation?.message).toContain("zero or greater");
	});

	it("keeps independent computed location obligations on their own prompts", () => {
		const first = advancedSearchInputDef(
			INPUT_UUIDS.a,
			"near_home",
			"Near home",
			"text",
			whenInput(
				input("near_home"),
				within(
					prop("patient", "home_location"),
					input("near_home"),
					5,
					"kilometers",
				),
			),
		);
		const second = advancedSearchInputDef(
			INPUT_UUIDS.b,
			"near_work",
			"Near work",
			"text",
			whenInput(
				input("near_work"),
				within(
					prop("patient", "work_location"),
					input("near_work"),
					5,
					"kilometers",
				),
			),
		);
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				{ ...first, predicate: and(first.predicate, second.predicate) },
				second,
			],
		};
		const validations = buildRuntimeCsqlPromptValidations(
			composeXPathQueryEmission(config, "patient"),
		);

		expect(validations.get("near_home")?.test).toContain("near_home");
		expect(validations.get("near_home")?.test).not.toContain("near_work");
		expect(validations.get("near_work")?.test).toContain("near_work");
		expect(validations.get("near_work")?.test).not.toContain("near_home");
	});

	it("emits one localized quote validation only for a CSQL-bound prompt", () => {
		const input = simpleSearchInputDef(
			INPUT_UUIDS.a,
			"name_query",
			"Name",
			"text",
			"case_name",
		);
		const { xml, strings } = emitSearchPrompts(
			[input],
			MODULE_ID,
			new Map([
				[
					"name_query",
					{
						test: `not(contains(., "'") and contains(., '"'))`,
						message: RUNTIME_CSQL_QUOTE_VALIDATION_MESSAGE,
					},
				],
			]),
		);

		expect(xml).toContain(
			`<validation test="not(contains(., &quot;&apos;&quot;) and contains(., &apos;&quot;&apos;))">`,
		);
		expect(xml.match(/<validation /g)).toHaveLength(1);
		expect(xml).toContain(
			`<locale id="search_property.m0.name_query.validation.0.text"/>`,
		);
		expect(strings).toEqual({
			"search_property.m0.name_query": "Name",
			"search_property.m0.name_query.validation.0.text":
				RUNTIME_CSQL_QUOTE_VALIDATION_MESSAGE,
		});
	});

	it("does not restrict an auto-match-only prompt", () => {
		const input = simpleSearchInputDef(
			INPUT_UUIDS.a,
			"case_name",
			"Name",
			"text",
			"case_name",
		);
		const { xml, strings } = emitSearchPrompts([input], MODULE_ID, new Map());
		expect(xml).not.toContain("<validation");
		expect(strings).toEqual({ "search_property.m0.case_name": "Name" });
	});

	it("derives prompt validation from the effective query dataflow, including the always-on filter", () => {
		const filterValue = advancedSearchInputDef(
			INPUT_UUIDS.a,
			"filter_value",
			"Status",
			"text",
			{ kind: "match-all" },
		);
		const sibling = advancedSearchInputDef(
			INPUT_UUIDS.b,
			"sibling",
			"Region",
			"text",
			{ kind: "match-all" },
		);
		const owner = advancedSearchInputDef(
			INPUT_UUIDS.c,
			"owner",
			"Owner row",
			"text",
			whenInput(
				input("sibling"),
				eq(prop("patient", "region"), input("sibling")),
			),
		);
		const triggerOnly = advancedSearchInputDef(
			asUuid("00000000-0000-4000-8000-aaaa00000004"),
			"trigger_only",
			"Optional rule",
			"text",
			whenInput(
				input("trigger_only"),
				eq(prop("patient", "status"), literal("active")),
			),
		);
		const config: CaseListConfig = {
			columns: [],
			filter: whenInput(
				input("filter_value"),
				eq(prop("patient", "status"), input("filter_value")),
			),
			searchInputs: [filterValue, sibling, owner, triggerOnly],
		};

		const validations = buildRuntimeCsqlPromptValidations(
			composeXPathQueryEmission(config, "patient"),
		);

		expect([...validations.keys()].sort()).toEqual(["filter_value", "sibling"]);
		expect(validations.get("filter_value")?.test).toContain(
			"@name='filter_value'",
		);
		expect(validations.get("filter_value")?.test).not.toContain(
			"@name='sibling'",
		);
		expect(validations.get("sibling")?.test).toContain("@name='sibling'");
		expect(validations.get("sibling")?.test).not.toContain("@name='owner'");
	});

	it.each<SearchInputType>([
		"text",
		"select",
		"date",
		"date-range",
		"barcode",
	])("attaches the same CSQL quote guard to an explicitly bound %s prompt", (type) => {
		const inputName = `query_${type.replace("-", "_")}`;
		const inputDef = advancedSearchInputDef(
			INPUT_UUIDS.a,
			inputName,
			"Query",
			type,
			whenInput(
				input(inputName),
				eq(prop("patient", "case_name"), input(inputName)),
			),
		);
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [inputDef],
		};
		const validations = buildRuntimeCsqlPromptValidations(
			composeXPathQueryEmission(config, "patient"),
		);
		const { xml } = emitSearchPrompts([inputDef], MODULE_ID, validations);

		expect(validations.get(inputName)?.test).toContain(`@name='${inputName}'`);
		expect(xml.match(/<validation /g)).toHaveLength(1);
	});

	it("text type omits both @input and @appearance (CCHQ default)", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"full_name",
				"Name",
				"text",
				"full_name",
			),
		];

		const { xml, strings } = emitSearchPrompts(inputs, MODULE_ID);

		// No `input` attr, no `appearance` attr — bare `key`. Compact
		// serializer output, no per-element whitespace.
		expect(xml).toBe(
			`<prompt key="full_name">` +
				`<display><text><locale id="search_property.m0.full_name"/></text></display>` +
				`</prompt>`,
		);
		expect(strings).toEqual({ "search_property.m0.full_name": "Name" });
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

		expect(xml).toContain(`<prompt key="dob" input="date" exclude="true()">`);
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

	it("never emits a legacy scalar default on a paired date-range prompt", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"visit_date",
				"Visit window",
				"date-range",
				"visit_date",
				{ default: today() },
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<prompt key="visit_date" input="daterange">`);
		expect(xml).not.toContain(" default=");
	});

	it("keeps a legacy date-opened target on the canonical daterange prompt", () => {
		const { xml } = emitSearchPrompts(
			[
				simpleSearchInputDef(
					INPUT_UUIDS.a,
					"date_opened",
					"Date opened",
					"date-range",
					"date-opened",
				),
			],
			MODULE_ID,
		);

		expect(xml).toContain(`<prompt key="date_opened" input="daterange">`);
		expect(xml).not.toContain(`exclude="true()"`);
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
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"full_name",
				"Name",
				"text",
				"full_name",
			),
		];

		const { xml, strings } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<display>`);
		expect(xml).toContain(`<locale id="search_property.m0.full_name"/>`);
		expect(strings).toEqual({ "search_property.m0.full_name": "Name" });
	});

	it("falls back to input.name when input.label is empty (still emits <display>)", () => {
		// CCHQ canonical shape always emits `<display>` — the wire
		// emitter matches that and registers a sensible UX fallback
		// (`full_name`) at the locale id rather than registering an empty
		// string (which would leave the runtime rendering nothing).
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "full_name", "", "text", "full_name"),
		];

		const { xml, strings } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<display>`);
		expect(xml).toContain(`<locale id="search_property.m0.full_name"/>`);
		expect(strings).toEqual({ "search_property.m0.full_name": "full_name" });
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
		// this exact-string check. Calendar-day matching routes through the
		// explicit same-day predicate, so the prompt suppresses Core's implicit
		// exact match while still binding the entered/default value.
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "dob", "Since", "date", "dob", {
				default: today(),
			}),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		// Compact serializer output.
		expect(xml).toBe(
			`<prompt key="dob" input="date" default="today()" exclude="true()">` +
				`<display><text><locale id="search_property.m0.dob"/></text></display>` +
				`</prompt>`,
		);
	});

	it("omits @default attribute when input.default is absent", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"full_name",
				"Name",
				"text",
				"full_name",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).not.toContain(`default=`);
	});

	it("compiles a date-coerce default through the on-device emitter", () => {
		// `dateCoerce(literal)` lowers to wire `date(<literal>)` —
		// the XPath idiom for a typed date value that the runtime
		// parses before comparison. The serializer handles XML
		// escaping of any `<` / `>` / `&` / `"` / `'` characters in
		// the compiled body at render time; this particular body
		// uses single quotes around the date string, which round-trip
		// as `&apos;` inside the double-quoted attribute value.
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

	it("emits exclude='true()' for canonical lifecycle status so CCHQ does not query the nonexistent bare status key", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"status",
				"Case status",
				"text",
				"status",
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		// CCHQ indexes lifecycle status as `@status`; its bare-prompt path
		// would query a dynamic property named `status` and match nothing.
		expect(xml).toContain(`<prompt key="status" exclude="true()">`);
	});

	it("does NOT emit exclude when input name and property equal the canonical searchable wire key", () => {
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

	it("emits exclude='true()' on an advanced-arm input", () => {
		// The prompt still binds the typed value into the search-input
		// instance. `exclude` prevents CommCare Core from ALSO submitting
		// `full_name=<value>` as an implicit property query alongside the
		// authored `_xpath_query` predicate.
		const inputs: SearchInputDef[] = [
			advancedSearchInputDef(
				INPUT_UUIDS.a,
				"full_name",
				"Name",
				"text",
				eq(prop("patient", "full_name"), literal("Alice")),
			),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		expect(xml).toContain(`<prompt key="full_name" exclude="true()">`);
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
	it("both arms emit the same prompt metadata while advanced suppresses Core's auto-match", () => {
		// Both arms carry the same `(name, label, type)` metadata. The
		// exact simple input relies on Core's implicit property matcher;
		// the advanced input authors its matcher in `_xpath_query`, so its
		// prompt must bind the value with `exclude="true()"`.
		const simple: SearchInputDef = simpleSearchInputDef(
			INPUT_UUIDS.a,
			"full_name",
			"Name",
			"text",
			"full_name",
		);
		const advanced: SearchInputDef = advancedSearchInputDef(
			INPUT_UUIDS.b,
			"full_name",
			"Name",
			"text",
			eq(prop("patient", "full_name"), literal("Alice")),
		);

		const simpleEmission = emitSearchPrompts([simple], MODULE_ID);
		const advancedEmission = emitSearchPrompts([advanced], MODULE_ID);

		expect(simpleEmission.strings).toEqual(advancedEmission.strings);
		expect(simpleEmission.xml).toContain(`<prompt key="full_name">`);
		expect(simpleEmission.xml).not.toContain(`exclude=`);
		expect(advancedEmission.xml).toContain(
			`<prompt key="full_name" exclude="true()">`,
		);
	});

	it("keeps advanced widget/default metadata and places exclude after default", () => {
		const advanced = advancedSearchInputDef(
			INPUT_UUIDS.a,
			"visited_after",
			"",
			"date",
			eq(prop("patient", "visit_date"), literal("2026-07-17")),
			{ default: today() },
		);

		const { xml, strings } = emitSearchPrompts([advanced], MODULE_ID);

		expect(xml).toContain(
			`<prompt key="visited_after" input="date" default="today()" exclude="true()">`,
		);
		expect(strings[`search_property.${MODULE_ID}.visited_after`]).toBe(
			"visited_after",
		);
	});

	it("advanced-arm predicates surface via getAdvancedArmPredicates", () => {
		const predicate = whenInput(
			input("full_name"),
			eq(prop("patient", "full_name"), literal("Alice")),
		);

		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(INPUT_UUIDS.a, "first", "First", "text", "first"),
			advancedSearchInputDef(
				INPUT_UUIDS.b,
				"full_name",
				"Name",
				"text",
				predicate,
			),
		];

		const advancedPredicates = getAdvancedArmPredicates(inputs);

		// Simple-arm row contributes nothing; only the advanced-arm
		// row surfaces in the helper's output. The orchestrator
		// AND-composes these into `<data key="_xpath_query">`.
		expect(advancedPredicates).toEqual([{ name: "full_name", predicate }]);
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
		const p1 = eq(prop("patient", "full_name"), literal("A"));
		const p2 = eq(prop("patient", "age"), literal(10));

		const inputs: SearchInputDef[] = [
			advancedSearchInputDef(INPUT_UUIDS.a, "full_name", "Name", "text", p1),
			simpleSearchInputDef(INPUT_UUIDS.b, "first", "First", "text", "first"),
			advancedSearchInputDef(INPUT_UUIDS.c, "age", "Age", "text", p2),
		];

		expect(getAdvancedArmPredicates(inputs)).toEqual([
			{ name: "full_name", predicate: p1 },
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
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"full_name",
				"Name",
				"text",
				"full_name",
			),
			simpleSearchInputDef(INPUT_UUIDS.b, "dob", "DOB", "date", "dob"),
		];

		const { xml } = emitSearchPrompts(inputs, MODULE_ID);

		// Simple ordering check: `full_name` prompt opens before `dob` prompt.
		const nameIdx = xml.indexOf(`key="full_name"`);
		const dobIdx = xml.indexOf(`key="dob"`);
		expect(nameIdx).toBeGreaterThanOrEqual(0);
		expect(dobIdx).toBeGreaterThanOrEqual(0);
		expect(nameIdx).toBeLessThan(dobIdx);
	});

	it("threads moduleId through every locale id", () => {
		const inputs: SearchInputDef[] = [
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"full_name",
				"Name",
				"text",
				"full_name",
			),
		];

		const m0 = emitSearchPrompts(inputs, "m0");
		const m3 = emitSearchPrompts(inputs, "m3");

		expect(m0.xml).toContain(`search_property.m0.full_name`);
		expect(m3.xml).toContain(`search_property.m3.full_name`);
		expect(m0.strings).toEqual({ "search_property.m0.full_name": "Name" });
		expect(m3.strings).toEqual({ "search_property.m3.full_name": "Name" });
	});
});

// ============================================================
// Golden-file comparison against canonical fixture
// ============================================================

describe("emitSearchPrompts — golden-file vs CCHQ remote_request.xml", () => {
	it("matches the fixture's <prompt> block shape (text + dob + select)", () => {
		// The fixture at
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`
		// carries three prompts:
		//   - `name` (text, no `@input`); this test uses the nonreserved
		//     `full_name` fixture while preserving the same prompt structure
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
			simpleSearchInputDef(
				INPUT_UUIDS.a,
				"full_name",
				"Name",
				"text",
				"full_name",
			),
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
			`<prompt key="full_name">` +
				`<display><text><locale id="search_property.m0.full_name"/></text></display>` +
				`</prompt>`,
			`<prompt key="dob" input="date" exclude="true()">` +
				`<display><text><locale id="search_property.m0.dob"/></text></display>` +
				`</prompt>`,
			`<prompt key="consent" input="select1">` +
				`<display><text><locale id="search_property.m0.consent"/></text></display>` +
				`</prompt>`,
		].join("\n");

		expect(xml).toBe(expected);
		expect(strings).toEqual({
			"search_property.m0.full_name": "Name",
			"search_property.m0.dob": "Date of birth",
			"search_property.m0.consent": "Consent",
		});
	});
});
