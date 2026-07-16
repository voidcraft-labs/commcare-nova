// lib/commcare/suite/case-search/__tests__/searchSession.test.ts
//
// Acceptance tests for `emitSearchSession` — the `<session>` body
// of a `<remote-request>`. Coverage walks the canonical
// `<query>`-`<datum>` shape against CCHQ's
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`
// and `search_config_blacklisted_owners.xml` fixtures.
//
// Structural pins:
//
//   1. `<query>` attribute set is exactly
//      `url default_search storage-instance template` per CCHQ's
//      `RemoteRequestFactory.build_remote_request_queries` and the
//      canonical fixtures. No `inline_search`, no `dynamic_search`.
//
//   2. `<query>` storage-instance and `<datum nodeset>` instance ref
//      both flip to `results:inline` when `wire.inlineSearch` is
//      true; both stay on `results` otherwise.
//
//   3. `<data>` slot order matches CCHQ's `_remote_request_query_datums`:
//      `case_type` first, then `commcare_blacklisted_owner_ids` (when
//      set), then `_xpath_query` (when present and non-trivial). The
//      `_xpath_query` slot carries everything — non-grammar value
//      expressions inline as on-device XPath fragments inside the
//      wrapper concat, so no sibling `<data>` slots accompany it.
//
//   4. `_xpath_query` AND-composes `caseListConfig.filter` with every
//      advanced-arm search input's predicate. A `match-all` composed
//      result omits the slot entirely.
//
//   5. `<datum nodeset>` carries the `[not(commcare_is_related_case=true())]`
//      filter from CCHQ's `EXCLUDE_RELATED_CASES_FILTER` constant
//      verbatim.
//
//   6. `<title>` references `case_search.{moduleId}.inputs` and
//      registers the authored title (or Nova's friendly default) in
//      the returned `strings` map.
//
//   7. The instance set returned for the orchestrator includes the
//      base `casedb` + `commcaresession` + the chosen results
//      instance.

import { describe, expect, it } from "vitest";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseListConfig,
	type CaseSearchConfig,
	calculatedColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	arith,
	concat,
	eq,
	literal,
	matchAll,
	prop,
	relationStep,
	subcasePath,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { emitSearchSession } from "../searchSession";
import type { WireShape } from "../types";

// ── Test helpers ────────────────────────────────────────────────────

const INPUT_UUIDS = {
	a: asUuid("00000000-0000-4000-8000-aaaa00000001"),
} as const;

const WEB_LIST_FIRST: WireShape = {
	autoLaunch: false,
	defaultSearch: false,
	inlineSearch: false,
};

const WEB_SKIP_TO_RESULTS: WireShape = {
	autoLaunch: true,
	defaultSearch: true,
	inlineSearch: false,
};

const ANDROID_INLINE: WireShape = {
	autoLaunch: false,
	defaultSearch: false,
	inlineSearch: true,
};

function makeListConfig(
	overrides: Partial<CaseListConfig> = {},
): CaseListConfig {
	return { columns: [], searchInputs: [], ...overrides };
}

// ── `<query>` attribute set ─────────────────────────────────────────

describe("emitSearchSession — <query> attribute set", () => {
	it("emits exactly url, default_search, storage-instance, template (no inline_search, no dynamic_search)", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		// Canonical fixtures pin the four-attribute set; CCHQ's
		// `RemoteRequestFactory.build_remote_request_queries` confirms
		// `default_search` is unconditional and `inline_search` /
		// `dynamic_search` are not emitted.
		expect(xml).toContain(`<query url=`);
		expect(xml).toContain(`default_search="false"`);
		expect(xml).toContain(`storage-instance="results"`);
		expect(xml).toContain(`template="case"`);
		expect(xml).not.toContain(`inline_search=`);
		expect(xml).not.toContain(`dynamic_search=`);
	});

	it("flips default_search to 'true' when wire.defaultSearch is true (web skip-to-results)", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				filter: eq(prop("patient", "active"), literal("yes")),
			}),
			caseSearchConfig: {},
			wire: WEB_SKIP_TO_RESULTS,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`default_search="true"`);
	});
});

// ── Storage instance + datum nodeset (inlineSearch flag) ────────────

describe("emitSearchSession — inlineSearch flag", () => {
	it("emits storage-instance='results' + nodeset on instance('results') for inlineSearch=false", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`storage-instance="results"`);
		// XPath single-quote literals round-trip through the serializer
		// as `&apos;` inside the double-quoted `nodeset` attribute.
		expect(xml).toContain(
			`nodeset="instance(&apos;results&apos;)/results/case[@case_type=&apos;patient&apos;][not(commcare_is_related_case=true())]"`,
		);
	});

	it("emits storage-instance='results:inline' + nodeset on instance('results:inline') for inlineSearch=true (Android)", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: ANDROID_INLINE,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`storage-instance="results:inline"`);
		expect(xml).toContain(
			`nodeset="instance(&apos;results:inline&apos;)/results/case[@case_type=&apos;patient&apos;][not(commcare_is_related_case=true())]"`,
		);
	});
});

// ── <data> slot order ────────────────────────────────────────────────

describe("emitSearchSession — <data> slot order", () => {
	it("emits case_type as the first <data> slot in <query>", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		// XPath single-quote literal round-trips as `&apos;` inside
		// the double-quoted `ref` attribute.
		expect(xml).toContain(`<data key="case_type" ref="&apos;patient&apos;"/>`);
	});

	it("emits commcare_blacklisted_owner_ids second when excludedOwnerIds is set (CCHQ wire token)", () => {
		// CCHQ wire field is `commcare_blacklisted_owner_ids`; Nova's
		// authoring vocabulary is `excludedOwnerIds`. The translation
		// happens in `searchSession.ts`.
		const config: CaseSearchConfig = {
			excludedOwnerIds: term({
				kind: "literal",
				value: "owner-a owner-b",
			}),
		};
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: config,
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(
			`<data key="commcare_blacklisted_owner_ids" ref="&apos;owner-a owner-b&apos;"/>`,
		);
		// Order: case_type first, then commcare_blacklisted_owner_ids.
		const caseTypeIdx = xml.indexOf(`key="case_type"`);
		const excludedIdx = xml.indexOf(`key="commcare_blacklisted_owner_ids"`);
		expect(caseTypeIdx).toBeGreaterThan(-1);
		expect(excludedIdx).toBeGreaterThan(-1);
		expect(caseTypeIdx).toBeLessThan(excludedIdx);
	});

	it("emits _xpath_query as the last <data> slot when caseListConfig.filter is set", () => {
		const filter = eq(prop("patient", "full_name"), literal("Alice"));
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({ filter }),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`<data key="_xpath_query"`);
		// Order: case_type before _xpath_query.
		const caseTypeIdx = xml.indexOf(`key="case_type"`);
		const xpathIdx = xml.indexOf(`key="_xpath_query"`);
		expect(caseTypeIdx).toBeLessThan(xpathIdx);
	});

	it("orders _xpath_query before commcare_blacklisted_owner_ids when both are set", () => {
		// Slot order matches CCHQ's `_remote_request_query_datums`:
		// `case_type` first, then every `default_properties[]` entry
		// (where `_xpath_query` lives on CCHQ's side), then
		// `commcare_blacklisted_owner_ids`. Of those CCHQ slots, only
		// `_xpath_query` and the blacklist land on Nova's authoring
		// surface today.
		const config: CaseSearchConfig = {
			excludedOwnerIds: term({ kind: "literal", value: "owner-a" }),
		};
		const filter = eq(prop("patient", "full_name"), literal("Alice"));
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({ filter }),
			caseSearchConfig: config,
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		const xpathIdx = xml.indexOf(`key="_xpath_query"`);
		const excludedIdx = xml.indexOf(`key="commcare_blacklisted_owner_ids"`);
		expect(xpathIdx).toBeLessThan(excludedIdx);
	});
});

// ── _xpath_query AND-composition ─────────────────────────────────────

describe("emitSearchSession — _xpath_query AND-composition", () => {
	it("omits _xpath_query entirely when no filter and no advanced-arm inputs are authored", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					// Simple-arm inputs DON'T contribute to _xpath_query.
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"full_name",
						"Name",
						"text",
						"full_name",
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).not.toContain(`key="_xpath_query"`);
	});

	it("emits _xpath_query when only caseListConfig.filter is authored", () => {
		const filter = eq(prop("patient", "full_name"), literal("Alice"));
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({ filter }),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`key="_xpath_query"`);
	});

	it("emits _xpath_query when only an advanced-arm search input contributes a predicate", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					advancedSearchInputDef(
						INPUT_UUIDS.a,
						"adv",
						"Advanced",
						"text",
						eq(prop("patient", "status"), literal("active")),
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`key="_xpath_query"`);
	});

	it("inlines non-grammar value expressions into the _xpath_query wrapper, never as sibling <data> slots", () => {
		// CSQL grammar admits a narrow value-expression whitelist;
		// shapes outside the whitelist (e.g. `arith`) inline as
		// on-device XPath fragments inside the wrapper concat. CCHQ's
		// `RemoteQuerySessionManager.initUserAnswers` only seeds the
		// `search-input:results` instance from `<prompt>` defaults,
		// so a sibling `<data>` slot with a synthetic key would
		// resolve to the empty string when the CSQL evaluator reads
		// it AND silently add a server-side property filter against
		// case data that matches no cases. The wire-correct shape is
		// the inline concat the canonical CCHQ pattern documents at
		// `commcare-hq/docs/case_search_query_language.rst::"Example
		// Query + Tips"`.
		const filter = eq(
			arith("+", term(prop("patient", "age")), term(literal(1))),
			term(literal(19)),
		);
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({ filter }),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		// Only the single `_xpath_query` slot is emitted — never a
		// `csql_hoist_<n>` sibling slot.
		expect(xml).not.toContain(`csql_hoist_`);
		const dataSlotMatches = xml.match(/<data key="/g) ?? [];
		// `case_type` + `_xpath_query` = 2 slots; no hoist sibling.
		expect(dataSlotMatches).toHaveLength(2);
		// The arith's on-device emission `(age + 1)` lands inside
		// the wrapper concat as a runtime fragment.
		expect(xml).toContain(`(age + 1)`);
		expect(xml).toContain(`key="_xpath_query"`);
	});

	it("accumulates the search-input instance when a non-grammar value expression nests an input ref", () => {
		// An inlined non-grammar expression carrying `input('base_age')`
		// at runtime needs the `search-input:results` instance declared
		// on the surrounding `<remote-request>` — without it CCHQ's
		// runtime can't resolve `instance('search-input:results')` at
		// search-execution time and raises an XPathException. The
		// instance accumulator walks the original AST (not a rewritten
		// shape), so input refs nested inside `arith` / `concat` /
		// `coalesce` / etc. surface to the accumulator the same way a
		// top-level input ref does. The `when-input-present` envelope
		// satisfies the validator rule
		// `searchInputRefUsesWhenInputPresent` (every bare input ref
		// in the composed `_xpath_query` must be gated).
		const baseAge = { kind: "input" as const, name: "base_age" };
		const filter = whenInput(
			baseAge,
			eq(arith("+", term(baseAge), term(literal(1))), term(literal(19))),
		);
		const { instances, xml } = emitSearchSession({
			caseListConfig: makeListConfig({ filter }),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(instances.has("search-input:results")).toBe(true);
		// And the inline runtime XPath references the input ref via
		// CCHQ's canonical search-input path so the runtime knows what
		// to resolve.
		// XPath single-quote literals round-trip as `&apos;` inside
		// the double-quoted attribute value the serializer renders.
		expect(xml).toContain(
			`instance(&apos;search-input:results&apos;)/input/field[@name=&apos;base_age&apos;]`,
		);
	});

	it("accumulates instances reachable from calc-column expressions for the search-target detail", () => {
		// The `m{N}_search_short` / `m{N}_search_long` details reuse
		// `caseListConfig.columns`. CCHQ resolves a detail's XPath
		// against the enclosing element's declarations — for the
		// search-target details that's this `<remote-request>`. Calc
		// columns referencing `session-user` / `input` terms need the
		// matching instance declared so the local `.ccz` matches the
		// CCHQ-server-regenerated suite (CCHQ runs
		// `InstancesHelper.add_entry_instances` over every detail
		// reachable from the entry).
		const region = { kind: "session-user" as const, field: "region" };
		const { instances } = emitSearchSession({
			caseListConfig: makeListConfig({
				columns: [
					calculatedColumn(
						asUuid("00000000-0000-4000-8000-cccc00000001"),
						"Region tag",
						concat(
							term(region),
							term(literal(": ")),
							term(prop("patient", "case_name")),
						),
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(instances.has("commcaresession")).toBe(true);
		expect(instances.has("casedb")).toBe(true);
	});

	it("AND-composes a filter and an advanced-arm predicate into a single _xpath_query slot", () => {
		// One <data> slot regardless of how many AST predicates
		// contributed; the wire layer carries one `<data
		// key="_xpath_query">` element with the AND-composed CSQL.
		const filter = eq(prop("patient", "full_name"), literal("Alice"));
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				filter,
				searchInputs: [
					advancedSearchInputDef(
						INPUT_UUIDS.a,
						"adv",
						"Advanced",
						"text",
						eq(prop("patient", "status"), literal("active")),
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		const matches = xml.match(/key="_xpath_query"/g) ?? [];
		expect(matches.length).toBe(1);
		// Both predicate fragments compose into the same wire string
		// via CSQL's `and` operator. XPath single-quote literals
		// round-trip as `&apos;`.
		expect(xml).toContain(`full_name = &apos;Alice&apos;`);
		expect(xml).toContain(`status = &apos;active&apos;`);
		expect(xml).toContain(` and `);
	});

	it("drops a `match-all` filter (conjunction identity) instead of prefixing _xpath_query with `match-all() and`", () => {
		// `match-all` is the AND identity — the builder seeds it on
		// "Add a Filter" and an author may leave it untouched. Composed
		// with any other clause it must vanish, NOT emit a literal
		// `concat('match-all() and ', …)` prefix on the wire. (The
		// composer once trusted the shared `and(...)` reducer to drop the
		// identity, but `reduceAnd` deliberately preserves multi-clause
		// sentinels for editing-state fidelity — the drop lives at the
		// emission boundary now.) The advanced predicate carries no
		// `when-input-present` else branch, so a clean emission has no
		// `match-all` token anywhere.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				filter: matchAll(),
				searchInputs: [
					advancedSearchInputDef(
						INPUT_UUIDS.a,
						"adv",
						"Advanced",
						"text",
						eq(prop("patient", "status"), literal("active")),
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).not.toContain("match-all");
		// The advanced predicate is the only effective clause, so it
		// rides alone — no AND envelope wrapping a vanished identity.
		expect(xml).toContain(`status = &apos;active&apos;`);
		expect(xml).toContain(`key="_xpath_query"`);
	});

	it("drops a `match-all` filter composed with a non-exact simple input — no `match-all() and` prefix (exact reported regression)", () => {
		// The reported bug: a `match-all` filter + one fuzzy search input
		// emitted `concat('match-all() and ', if(count(...), …))`. The
		// identity filter must drop, leaving the fuzzy input's
		// `when-input-present` wrapper byte-identical to the no-filter
		// emission. The `'match-all()'` token still appears legitimately
		// as the when-input-present else branch — only the leading
		// `match-all() and ` prefix was the bug.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				filter: matchAll(),
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"name_fuzzy",
						"Name",
						"text",
						"case_name",
						{ mode: { kind: "fuzzy" } },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).not.toContain("match-all() and");
		// Byte-identical to the no-filter fuzzy emission — the identity
		// filter contributed nothing to the composed query.
		expect(xml).toContain(
			`<data key="_xpath_query" ref="concat(if(count(instance(&apos;search-input:results&apos;)/input/field[@name=&apos;name_fuzzy&apos;]), concat(&apos;fuzzy-match(case_name, &quot;&apos;, instance(&apos;search-input:results&apos;)/input/field[@name=&apos;name_fuzzy&apos;], &apos;&quot;)&apos;), &apos;match-all()&apos;))"/>`,
		);
	});

	it("drops a `match-all` nested inside an authored `and` filter — no `match-all() and` at depth", () => {
		// A user authors an "All of these" group, then flips one clause to
		// "Always true": `and(match-all, eq(...))`. The top-level kind is
		// `and`, so a shallow identity drop would keep it and re-emit the
		// `match-all() and …` prefix at depth. `simplifyForEmission`
		// removes the identity recursively, leaving only the real clause.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				filter: and(
					matchAll(),
					eq(prop("patient", "status"), literal("active")),
				),
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"name_fuzzy",
						"Name",
						"text",
						"case_name",
						{ mode: { kind: "fuzzy" } },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).not.toContain("match-all() and");
		// The real clause survives and AND-composes with the fuzzy input.
		expect(xml).toContain(`status = &apos;active&apos;`);
	});
});

// ── Simple-arm-with-via routing into _xpath_query ───────────────────

describe("emitSearchSession — simple-arm-with-via _xpath_query routing", () => {
	// Each `<prompt key="X">` binds one runtime value, but carries no
	// relation-walk metadata — the bare prompt slot can't encode a
	// cross-walk simple input. The wire pipeline routes such inputs
	// through `_xpath_query` so the relation walk survives the
	// round-trip to CCHQ. Self-walk / absent-via simple inputs stay
	// at the prompt slot only.

	it("emits a self-walk simple input as a <prompt> with NO _xpath_query contribution", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"full_name",
						"Name",
						"text",
						"full_name",
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`<prompt key="full_name">`);
		expect(xml).not.toContain(`key="_xpath_query"`);
	});

	it("emits an ancestor-walk simple input as a <prompt exclude='true()'> AND contributes its predicate to _xpath_query", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"parent_name",
						"Parent name",
						"text",
						"case_name",
						{ via: ancestorPath(relationStep("parent")) },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		// Prompt still emits — CCHQ binds the user's typed value to
		// the prompt key at runtime so the explicit predicate can
		// reference it. `exclude="true()"` rides alongside the key
		// so CCHQ's runtime suppresses the bogus auto-match against
		// the prompt key on the wrong case.
		expect(xml).toContain(`<prompt key="parent_name" exclude="true()">`);
		// And the relation-walked predicate lifts into _xpath_query
		// via the lift-pass + `when-input-present` envelope. The
		// XPath attribute value is XML-escaped (single quotes inside
		// double-quoted attrs survive; double quotes inside the
		// nested CSQL string lower to `&quot;`), so the assertions
		// pin the structural fragments rather than the raw CSQL
		// string. CSQL runtime-builds to
		// `ancestor-exists(parent, case_name = "<typed>")`.
		expect(xml).toContain(`key="_xpath_query"`);
		// CCHQ requires `ancestor-exists`'s first arg to be a bare
		// path AST node (`_is_ancestor_path_expression`), so `parent`
		// emits without surrounding quotes — Nova's local suite XML
		// pins the comma to disambiguate from any preceding tokens.
		expect(xml).toContain(`ancestor-exists(parent,`);
		// `when-input-present` envelope wraps the inner CSQL via the
		// canonical `if(count(...), <inner>, 'match-all()')` shape.
		expect(xml).toContain(`if(count(`);
		// XPath single-quote literals round-trip as `&apos;`.
		expect(xml).toContain(`@name=&apos;parent_name&apos;`);
	});

	it("emits a subcase-walk simple input the same way", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"child_status",
						"Child status",
						"text",
						"status",
						{ via: subcasePath("child") },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`<prompt key="child_status" exclude="true()">`);
		expect(xml).toContain(`key="_xpath_query"`);
		expect(xml).toContain(`subcase-exists(`);
		// XPath single-quote literals round-trip as `&apos;`.
		expect(xml).toContain(`&apos;child&apos;`);
		expect(xml).toContain(`@name=&apos;child_status&apos;`);
	});

	it("AND-composes a bare-prompt-compatible and an ancestor-walk simple input cleanly — only the cross-walk contributes to _xpath_query", () => {
		// The bare-prompt-compatible shape is self-walk + default
		// exact + `name === property` — CCHQ's runtime auto-match on
		// the prompt key IS the authored comparison, so the input
		// stays off `_xpath_query` and off the exclude route. The
		// ancestor-walk input alongside it routes through both.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"full_name",
						"Self name",
						"text",
						"full_name",
					),
					simpleSearchInputDef(
						asUuid("00000000-0000-4000-8000-aaaa00000002"),
						"parent_region",
						"Parent region",
						"text",
						"region",
						{ via: ancestorPath(relationStep("parent")) },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		// Bare-prompt-compatible input: no exclude attribute.
		expect(xml).toContain(`<prompt key="full_name">`);
		// Cross-walk input: exclude stamped.
		expect(xml).toContain(`<prompt key="parent_region" exclude="true()">`);
		// Only the ancestor-walked input contributes to _xpath_query;
		// the bare-prompt-compatible one rides on its prompt binding
		// only.
		expect(xml).toContain(`ancestor-exists(`);
		// XPath single-quote literals round-trip as `&apos;`.
		expect(xml).toContain(`@name=&apos;parent_region&apos;`);
		// The bare-prompt-compatible input's name DOES NOT appear
		// inside any `_xpath_query` CSQL because no predicate was
		// derived for it.
		const xpathSlice = xml.split(`key="_xpath_query"`)[1] ?? "";
		expect(xpathSlice).not.toContain(`@name=&apos;full_name&apos;`);
	});
});

// ── <datum> nodeset shape ────────────────────────────────────────────

describe("emitSearchSession — <datum> shape", () => {
	it("emits id='search_case_id', value='./@case_id', detail-confirm + detail-select referencing m{N}_search_long / m{N}_search_short", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 3,
		});
		expect(xml).toContain(`<datum id="search_case_id"`);
		expect(xml).toContain(`value="./@case_id"`);
		expect(xml).toContain(`detail-confirm="m3_search_long"`);
		expect(xml).toContain(`detail-select="m3_search_short"`);
	});

	it("omits detail-confirm when Details has no fields", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 3,
			hasDetailScreen: false,
		});

		expect(xml).toContain(`detail-select="m3_search_short"`);
		expect(xml).not.toContain(`detail-confirm=`);
	});

	it("includes the [not(commcare_is_related_case=true())] filter from CCHQ's EXCLUDE_RELATED_CASES_FILTER", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`[not(commcare_is_related_case=true())]`);
	});
});

// ── <title> + locale strings ────────────────────────────────────────

describe("emitSearchSession — <title> + locale strings", () => {
	it("emits the case_search.{moduleId}.inputs locale id", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 2,
		});
		expect(xml).toContain(`<locale id="case_search.m2.inputs"/>`);
	});

	it("registers the authored searchScreenTitle in strings under the title locale id", () => {
		const { strings } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: { searchScreenTitle: "Find a patient" },
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(strings["case_search.m0.inputs"]).toBe("Find a patient");
	});

	it("falls back to Nova's friendly title when no title is authored", () => {
		const { strings } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(strings["case_search.m0.inputs"]).toBe("Search");
	});
});

// ── <description> + locale strings ──────────────────────────────────
//
// `<description>` sits as a sibling of `<title>` on `<query>` —
// between `<title>` and the `<data>` slot list. CCHQ's
// `RemoteRequestFactory.build_remote_request_queries` emits the
// element only when `module.search_config.description != {}`. Nova
// gates emission on `caseSearchConfig.searchScreenSubtitle` being a
// non-empty string: an absent or empty-string subtitle elides the
// element entirely and registers no locale entry, matching CCHQ's
// gate so the runtime never resolves a blank locale fallback.

describe("emitSearchSession — <description> + locale strings", () => {
	it("emits <description> with the case_search.{moduleId}.description locale id when subtitle is authored", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: { searchScreenSubtitle: "Search by **name**." },
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 2,
		});
		expect(xml).toContain(`<description>`);
		expect(xml).toContain(`<locale id="case_search.m2.description"/>`);
	});

	it("places <description> between </title> and the first <data> slot", () => {
		// CCHQ's `RemoteRequestQuery` factory orders the query's
		// children as title → description → data → prompts. The pin
		// catches a regression that drops the description after the
		// data slots or before the title.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: { searchScreenSubtitle: "Search by name." },
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		const titleCloseIdx = xml.indexOf("</title>");
		const descriptionOpenIdx = xml.indexOf("<description>");
		const firstDataIdx = xml.indexOf("<data ");
		expect(titleCloseIdx).toBeGreaterThan(-1);
		expect(descriptionOpenIdx).toBeGreaterThan(titleCloseIdx);
		expect(firstDataIdx).toBeGreaterThan(descriptionOpenIdx);
	});

	it("registers the authored subtitle in strings under the description locale id", () => {
		const { strings } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {
				searchScreenSubtitle: "Search by **name** or village.",
			},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(strings["case_search.m0.description"]).toBe(
			"Search by **name** or village.",
		);
	});

	it("omits <description> and the description locale entry when subtitle is undefined", () => {
		const { xml, strings } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).not.toContain(`<description>`);
		expect(strings["case_search.m0.description"]).toBeUndefined();
	});

	// "Empty-string subtitle omits <description>" is no longer a
	// distinct case to test — the schema's
	// `searchScreenSubtitle: z.string().min(1).optional()` rejects
	// empty strings at parse time, so the only way to express "no
	// subtitle" is `undefined`. The "no subtitle authored" test
	// above covers the only reachable no-subtitle shape.
});

// ── Instance accumulation ───────────────────────────────────────────

describe("emitSearchSession — instance accumulation", () => {
	it("includes casedb, commcaresession, and the chosen results instance in the returned set (standalone)", () => {
		const { instances } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(instances.has("casedb")).toBe(true);
		expect(instances.has("commcaresession")).toBe(true);
		expect(instances.has("results")).toBe(true);
		expect(instances.has("results:inline")).toBe(false);
	});

	it("flips the results instance to 'results:inline' when wire.inlineSearch is true", () => {
		const { instances } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: ANDROID_INLINE,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(instances.has("results:inline")).toBe(true);
		expect(instances.has("results")).toBe(false);
	});
});

// ── <prompt> body composition ───────────────────────────────────────

describe("emitSearchSession — <prompt> body", () => {
	it("includes the prompt block from emitSearchPrompts inside <query>", () => {
		const { xml, strings } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"full_name",
						"Name",
						"text",
						"full_name",
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`<prompt key="full_name"`);
		expect(strings["search_property.m0.full_name"]).toBe("Name");
	});

	it("emits a clean <query> body when no search inputs are authored", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig(),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).not.toContain(`<prompt`);
		expect(xml).toContain(`</query>`);
	});
});

// ── Non-exact mode routing on self-walk inputs ───────────────────────

describe("emitSearchSession — non-exact mode routing on self-walk inputs", () => {
	// CCHQ's `CaseSearchProperty` carries no per-input matcher-strategy
	// flag, and the runtime default for a bare prompt is exact full-
	// string match. Every non-exact mode (`fuzzy` / `phonetic` /
	// `starts-with` / `fuzzy-date`) must therefore route through
	// `_xpath_query` even when the input's `via` is absent / self.

	it("routes a self-walk `fuzzy` simple input into _xpath_query as fuzzy-match(prop, input)", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"name_fuzzy",
						"Name",
						"text",
						"case_name",
						{ mode: { kind: "fuzzy" } },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		// The prompt slot still emits — CCHQ binds the user-typed
		// value into `search-input:results` regardless. The matcher
		// strategy rides on the `_xpath_query` slot.
		expect(xml).toContain(`<prompt key="name_fuzzy"`);
		// Pin the full `_xpath_query` ref. The fragment encodes the
		// wire contract: (1) the value is wrapped in CSQL
		// double-quote brackets so CCHQ's `unwrap_value` reads the
		// runtime-resolved string as a string literal rather than
		// rejecting it as a path (`commcare-hq/.../case_search/dsl_utils.py::unwrap_value`
		// raises `CaseFilterError` on a bare `Step`); (2) the
		// envelope is `when-input-present` so an unset input
		// contributes `match-all()` instead of matching against
		// empty-string. The `&quot;` pair is `"` XML-escaped for
		// attribute context.
		// Pin the full `_xpath_query` ref. The fragment encodes the
		// wire contract: (1) the value wraps in CSQL double-quote
		// brackets so CCHQ's `unwrap_value` reads the runtime-resolved
		// string as a string literal rather than rejecting it as a
		// path; (2) the envelope is `when-input-present` so an unset
		// input contributes `match-all()` instead of matching against
		// empty-string. XPath single-quote literals (`'…'`) round-trip
		// through the serializer as `&apos;` inside the double-quoted
		// `ref` attribute value.
		expect(xml).toContain(
			`<data key="_xpath_query" ref="concat(if(count(instance(&apos;search-input:results&apos;)/input/field[@name=&apos;name_fuzzy&apos;]), concat(&apos;fuzzy-match(case_name, &quot;&apos;, instance(&apos;search-input:results&apos;)/input/field[@name=&apos;name_fuzzy&apos;], &apos;&quot;)&apos;), &apos;match-all()&apos;))"/>`,
		);
	});

	it("routes a self-walk `starts-with` simple input into _xpath_query as starts-with(prop, input)", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"name_starts",
						"Name",
						"text",
						"case_name",
						{ mode: { kind: "starts-with" } },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		// `starts-with` is the one mode JavaRosa-on-device also
		// supports (via `XPathStartsWithFunc`); on the CSQL side the
		// value still wraps in double-quote brackets so the
		// runtime-resolved string interpolates as a string literal.
		expect(xml).toContain(
			`<data key="_xpath_query" ref="concat(if(count(instance(&apos;search-input:results&apos;)/input/field[@name=&apos;name_starts&apos;]), concat(&apos;starts-with(case_name, &quot;&apos;, instance(&apos;search-input:results&apos;)/input/field[@name=&apos;name_starts&apos;], &apos;&quot;)&apos;), &apos;match-all()&apos;))"/>`,
		);
	});

	it("routes a self-walk `phonetic` simple input into _xpath_query as phonetic-match(prop, input)", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"name_phon",
						"Name",
						"text",
						"case_name",
						{ mode: { kind: "phonetic" } },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(
			`<data key="_xpath_query" ref="concat(if(count(instance(&apos;search-input:results&apos;)/input/field[@name=&apos;name_phon&apos;]), concat(&apos;phonetic-match(case_name, &quot;&apos;, instance(&apos;search-input:results&apos;)/input/field[@name=&apos;name_phon&apos;], &apos;&quot;)&apos;), &apos;match-all()&apos;))"/>`,
		);
	});

	it("routes a self-walk `fuzzy-date` simple input into _xpath_query as fuzzy-date(prop, input)", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"dob_fdate",
						"DOB",
						"date",
						"dob",
						{ mode: { kind: "fuzzy-date" } },
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(
			`<data key="_xpath_query" ref="concat(if(count(instance(&apos;search-input:results&apos;)/input/field[@name=&apos;dob_fdate&apos;]), concat(&apos;fuzzy-date(dob, &quot;&apos;, instance(&apos;search-input:results&apos;)/input/field[@name=&apos;dob_fdate&apos;], &apos;&quot;)&apos;), &apos;match-all()&apos;))"/>`,
		);
	});

	it("does NOT route a blank-property simple input into _xpath_query (transient editor state, validator carries the authoring error)", () => {
		// The schema admits `property === ""` as the "row added, not
		// yet picked" transient editor state. Deriving a predicate
		// against `prop(caseType, "", …)` would emit malformed XPath
		// (`<empty> = instance(...)`); the wire emitter falls back to
		// the bare-prompt shape so the compile path stays clean while
		// the validator surfaces the authoring error as
		// `CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY`.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(INPUT_UUIDS.a, "name_q", "Name", "text", "", {
						mode: { kind: "fuzzy" },
					}),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).not.toContain(`<data key="_xpath_query"`);
		// The prompt still emits — the typed value binds into
		// `search-input:results` for downstream evaluation once the
		// property is filled in.
		expect(xml).toContain(`<prompt key="name_q"`);
		// And the bare-prompt routing means no `exclude="true()"` —
		// the prompt is in the transient state, not actively gated.
		expect(xml).not.toContain(`exclude="true()"`);
	});

	it("does NOT route a self-walk `exact` simple input with `name === property` into _xpath_query (rides on bare prompt)", () => {
		// The bare-prompt-correct shape: self-walk + default exact AND
		// `name === property` so CCHQ's runtime auto-match against
		// the prompt key IS the authored comparison. The simple-arm
		// derivation gate keeps this input off `_xpath_query` and off
		// the `<prompt exclude="true()">` route.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"case_name",
						"Name",
						"text",
						"case_name",
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`<prompt key="case_name">`);
		// CCHQ's runtime default already does exact match — no
		// `_xpath_query` predicate needed.
		expect(xml).not.toContain(`<data key="_xpath_query"`);
		// And no `exclude="true()"` — the auto-match is the wanted
		// runtime behaviour for this shape.
		expect(xml).not.toContain(`exclude=`);
	});

	it("routes canonical lifecycle status through explicit @status CSQL", () => {
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"status",
						"Case status",
						"text",
						"status",
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});

		expect(xml).toContain(`<prompt key="status" exclude="true()">`);
		expect(xml).toContain(`<data key="_xpath_query"`);
		expect(xml).toContain("@status = ");
	});

	it("routes a self-walk `exact` simple input with `name !== property` into _xpath_query AND emits exclude='true()' on the prompt", () => {
		// The bogus-auto-match case: `name="name_search"` /
		// `property="case_name"`. Without the routing + exclude
		// stamp, CCHQ's runtime would auto-match the typed value
		// against a case property called `name_search` (which may
		// not exist) and silently produce zero results. The explicit
		// `_xpath_query` predicate compares the typed value against
		// the authored target `case_name`, and `exclude="true()"`
		// suppresses the bogus auto-match while leaving the typed
		// value bound to the search-input instance.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"name_search",
						"Name",
						"text",
						"case_name",
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`<prompt key="name_search" exclude="true()">`);
		expect(xml).toContain(`<data key="_xpath_query"`);
		expect(xml).toContain("case_name = ");
		// XPath single-quote literal round-trips as `&apos;`.
		expect(xml).toContain("@name=&apos;name_search&apos;");
	});

	it("does NOT route a self-walk `range` simple input with `name === property` into _xpath_query (daterange widget handles two-bound)", () => {
		// The bare-prompt-correct range shape: self-walk AND
		// `name === property` so CCHQ's daterange widget can carry
		// the two-bound semantic against the authored property.
		const { xml } = emitSearchSession({
			caseListConfig: makeListConfig({
				searchInputs: [
					simpleSearchInputDef(
						INPUT_UUIDS.a,
						"visit_date",
						"Visit",
						"date-range",
						"visit_date",
					),
				],
			}),
			caseSearchConfig: {},
			wire: WEB_LIST_FIRST,
			caseType: "patient",
			moduleIndex: 0,
		});
		expect(xml).toContain(`<prompt key="visit_date"`);
		expect(xml).not.toContain(`<data key="_xpath_query"`);
		expect(xml).not.toContain(`exclude=`);
	});
});

// ── Defense-in-depth on bare search-input refs ───────────────────────

describe("composeXPathQueryEmission — defense in depth on bare input refs", () => {
	// The validator rule `searchInputRefUsesWhenInputPresent` is the
	// authoring-time gate; this defense-in-depth walker at the wire
	// boundary throws if a bare ref survives to emission (validator
	// bypassed via runtime AST construction / `as any` / partial union
	// widening). Reaching the throw is a structural failure shape, not
	// a user-surfaced error.

	it("throws when an advanced-arm predicate carries a bare input ref outside any when-input-present envelope", () => {
		const bareRefPredicate = eq(
			prop("patient", "city"),
			term({ kind: "input", name: "city_q" }),
		);
		expect(() =>
			emitSearchSession({
				caseListConfig: makeListConfig({
					searchInputs: [
						advancedSearchInputDef(
							INPUT_UUIDS.a,
							"city_q",
							"City",
							"text",
							bareRefPredicate,
						),
					],
				}),
				caseSearchConfig: {},
				wire: WEB_LIST_FIRST,
				caseType: "patient",
				moduleIndex: 0,
			}),
		).toThrow(/bare search-input reference/);
	});
});
