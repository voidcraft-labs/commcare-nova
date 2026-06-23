// lib/commcare/suite/case-search/__tests__/remoteRequest.test.ts
//
// Acceptance tests for the `<remote-request>` orchestrator. Each
// `it(...)` pins one structural invariant against CCHQ's canonical
// fixtures
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`
// and `search_config_blacklisted_owners.xml`.
//
// The orchestrator composes four child element families: `<post>`,
// `<command>`, `<instance>` declarations, `<session>`, `<stack>`.
// Tests walk the assembled XML for the load-bearing slots — the
// canonical fixtures exercise CCHQ-extension features Nova doesn't
// emit (default_properties, registry, sort, smart links), so a
// byte-for-byte snapshot would fail on those mismatches. Structural
// pins on individual element shapes give surface coverage without
// false-positive churn.

import { describe, expect, it } from "vitest";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseListConfig,
	type CaseSearchConfig,
	type Module,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	input,
	literal,
	prop,
	relationStep,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { emitRemoteRequest } from "../remoteRequest";

// ── Test helpers ────────────────────────────────────────────────────

const MODULE_UUID = asUuid("00000000-0000-4000-8000-000000000010");

function makeListConfig(
	overrides: Partial<CaseListConfig> = {},
): CaseListConfig {
	return { columns: [], searchInputs: [], ...overrides };
}

function makeModule(args: {
	readonly caseType: string;
	readonly caseListConfig?: CaseListConfig;
	readonly caseSearchConfig: CaseSearchConfig;
}): Module {
	return {
		uuid: MODULE_UUID,
		id: "test_module",
		name: "Test Module",
		caseType: args.caseType,
		caseListConfig: args.caseListConfig ?? makeListConfig(),
		caseSearchConfig: args.caseSearchConfig,
	};
}

// ── Top-level shape ─────────────────────────────────────────────────

// Canonical-shape golden for the minimal `<remote-request>` —
// `caseType: "patient"`, empty `caseSearchConfig`, no inputs, no
// filter, web list-first wire flags. Full-string assertion catches
// attribute-order regressions and silent slot drops that the
// per-invariant tests below would individually miss when no test
// reaches the affected line.
//
// Compact serializer output — no per-element whitespace. Element
// order, attribute insertion order, and the XML-spec-equivalent
// entity encodings (`'` → `&apos;`, `<` → `&lt;` etc.) are the
// load-bearing properties. CCHQ's XML parser decodes the entities
// identically before the suite-parse and XPath layers see the
// attribute values. (`$` is not a special XML character, so it rides
// verbatim — as it does in CCHQ's own suite.xml.)
const MINIMAL_REMOTE_REQUEST_XML =
	`<remote-request>` +
	`<post url="https://www.commcarehq.org/a/__DOMAIN__/phone/claim-case/"` +
	` relevant="count(instance(&apos;casedb&apos;)/casedb/case[@case_id=instance(&apos;commcaresession&apos;)/session/data/search_case_id]) = 0">` +
	`<data key="case_id" ref="instance(&apos;commcaresession&apos;)/session/data/search_case_id"/>` +
	`</post>` +
	`<command id="search_command.m0">` +
	`<display><text><locale id="case_search.m0"/></text></display>` +
	`</command>` +
	`<instance id="casedb" src="jr://instance/casedb"/>` +
	`<instance id="commcaresession" src="jr://instance/session"/>` +
	`<instance id="results" src="jr://instance/remote/results"/>` +
	`<session>` +
	`<query url="https://www.commcarehq.org/a/__DOMAIN__/phone/search/__APP_ID__/"` +
	` default_search="false" storage-instance="results" template="case">` +
	`<title><text><locale id="case_search.m0.inputs"/></text></title>` +
	`<data key="case_type" ref="&apos;patient&apos;"/>` +
	`</query>` +
	`<datum id="search_case_id"` +
	` nodeset="instance(&apos;results&apos;)/results/case[@case_type=&apos;patient&apos;][not(commcare_is_related_case=true())]"` +
	` value="./@case_id" detail-confirm="m0_search_long" detail-select="m0_search_short"/>` +
	`</session>` +
	`<stack>` +
	`<push><rewind value="instance(&apos;commcaresession&apos;)/session/data/search_case_id"/></push>` +
	`</stack>` +
	`</remote-request>`;

describe("emitRemoteRequest — top-level shape", () => {
	it("emits the canonical minimal <remote-request> verbatim", () => {
		// Full-string golden: the only `it` in this file that pins the
		// entire emission. Every other `it` covers a structural
		// invariant via substring / ordering assertions; the
		// individual checks together do not enforce attribute order,
		// indentation, whitespace, or the absence of unauthored
		// elements. The golden plugs the "I refactored, nothing
		// complained, but the wire string is subtly different now"
		// failure mode for the canonical shape.
		const { xml } = emitRemoteRequest({
			module: makeModule({
				caseType: "patient",
				caseSearchConfig: {},
			}),
			moduleIndex: 0,
		});
		expect(xml).toBe(MINIMAL_REMOTE_REQUEST_XML);
	});

	it("emits a single <remote-request> element wrapping the four child element families", () => {
		const { xml } = emitRemoteRequest({
			module: makeModule({
				caseType: "patient",
				caseSearchConfig: {},
			}),
			moduleIndex: 0,
		});
		expect(xml).toMatch(/^\s*<remote-request>/);
		expect(xml).toMatch(/<\/remote-request>\s*$/);
		// The four child element families: <post>, <command>,
		// <instance>+, <session>, <stack>. CCHQ's canonical layout
		// pins the order; the orchestrator composes the four blocks
		// in the same sequence.
		const postIdx = xml.indexOf("<post ");
		const commandIdx = xml.indexOf("<command id=");
		const instanceIdx = xml.indexOf("<instance id=");
		const sessionIdx = xml.indexOf("<session>");
		const stackIdx = xml.indexOf("<stack>");
		expect(postIdx).toBeGreaterThan(-1);
		expect(commandIdx).toBeGreaterThan(postIdx);
		expect(instanceIdx).toBeGreaterThan(commandIdx);
		expect(sessionIdx).toBeGreaterThan(instanceIdx);
		expect(stackIdx).toBeGreaterThan(sessionIdx);
	});

	it("throws when the module has no case-search config", () => {
		// Defensive guard — the orchestrator is total against the
		// presence of `caseSearchConfig`. The compiler's call site
		// gates on the same condition; this throw is a backstop.
		expect(() =>
			emitRemoteRequest({
				module: {
					uuid: MODULE_UUID,
					id: "test_module",
					name: "Test Module",
					caseType: "patient",
				},
				moduleIndex: 0,
			}),
		).toThrow();
	});

	it("throws when the module has no case type", () => {
		expect(() =>
			emitRemoteRequest({
				module: {
					uuid: MODULE_UUID,
					id: "test_module",
					name: "Test Module",
					caseSearchConfig: {},
				},
				moduleIndex: 0,
			}),
		).toThrow();
	});
});

// ── <command> element ───────────────────────────────────────────────

describe("emitRemoteRequest — <command> element", () => {
	it("emits id='search_command.m{N}' with the case_search.{m} locale", () => {
		const { xml } = emitRemoteRequest({
			module: makeModule({ caseType: "patient", caseSearchConfig: {} }),
			moduleIndex: 4,
		});
		expect(xml).toContain(`<command id="search_command.m4">`);
		expect(xml).toContain(`<locale id="case_search.m4"/>`);
	});

	it("registers the search command label in strings under case_search.{m}", () => {
		const { strings } = emitRemoteRequest({
			module: makeModule({
				caseType: "patient",
				caseSearchConfig: { searchButtonLabel: "Find patient" },
			}),
			moduleIndex: 0,
		});
		expect(strings["case_search.m0"]).toBe("Find patient");
	});

	it("falls back to a sensible label when no searchButtonLabel is authored", () => {
		const { strings } = emitRemoteRequest({
			module: makeModule({ caseType: "patient", caseSearchConfig: {} }),
			moduleIndex: 0,
		});
		expect(strings["case_search.m0"]).toBe("Search All Cases");
	});
});

// ── <instance> declarations ─────────────────────────────────────────

describe("emitRemoteRequest — <instance> declarations", () => {
	it("emits casedb, commcaresession, and results for the standalone (web list-first) shape", () => {
		const { xml } = emitRemoteRequest({
			module: makeModule({ caseType: "patient", caseSearchConfig: {} }),
			moduleIndex: 0,
		});
		expect(xml).toContain(`<instance id="casedb" src="jr://instance/casedb"/>`);
		expect(xml).toContain(
			`<instance id="commcaresession" src="jr://instance/session"/>`,
		);
		expect(xml).toContain(
			`<instance id="results" src="jr://instance/remote/results"/>`,
		);
	});

	it("declares search-input:results when an advanced-arm predicate references a search input", () => {
		// CCHQ's runtime resolves `instance('search-input:results')` to
		// the in-flight search input values during `<remote-request>`
		// evaluation. The wire layer accumulates the id from the Term
		// references reachable through `caseListConfig` / `caseSearchConfig`
		// so every XPath the body emits has its instance declared.
		// The validator rule `searchInputRefUsesWhenInputPresent`
		// requires bare `input(...)` refs to be wrapped in a
		// `when-input-present` envelope; the defense-in-depth walker in
		// `composeXPathQueryEmission` throws on any predicate that
		// reaches the wire boundary without the envelope. The advanced-
		// arm predicate here is the wire-valid shape that still
		// references `instance('search-input:results')` (the envelope
		// trigger itself), so the instance accumulator must walk it.
		const advancedInput = advancedSearchInputDef(
			asUuid("00000000-0000-4000-8000-00000000aaaa"),
			"city_q",
			"City",
			"text",
			whenInput(
				input("city_q"),
				eq(prop("patient", "city"), term({ kind: "input", name: "city_q" })),
			),
		);
		const { xml } = emitRemoteRequest({
			module: makeModule({
				caseType: "patient",
				caseListConfig: makeListConfig({ searchInputs: [advancedInput] }),
				caseSearchConfig: {},
			}),
			moduleIndex: 0,
		});
		expect(xml).toContain(
			`<instance id="search-input:results" src="jr://instance/search-input/results"/>`,
		);
	});

	it("declares search-input:results when a simple-arm-with-via input is the only trigger", () => {
		// A simple-arm input whose `via` walks a relation routes through
		// `deriveSimpleArmPredicate` into the `_xpath_query` AND-composition.
		// The derived predicate references
		// `instance('search-input:results')`; the instance accumulator
		// must walk the derived predicate too — without it, the wire
		// would carry an `instance('search-input:results')` XPath with
		// no matching `<instance>` declaration and the runtime would
		// raise an XPath resolution error at search-execution time.
		const simpleViaInput = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-00000000bbbb"),
			"region_q",
			"Region",
			"text",
			"region",
			{ via: ancestorPath(relationStep("parent", "household")) },
		);
		const { xml } = emitRemoteRequest({
			module: makeModule({
				caseType: "patient",
				caseListConfig: makeListConfig({ searchInputs: [simpleViaInput] }),
				caseSearchConfig: {},
			}),
			moduleIndex: 0,
		});
		expect(xml).toContain(
			`<instance id="search-input:results" src="jr://instance/search-input/results"/>`,
		);
	});

	it("declares search-input:results when a search input's default references another input", () => {
		// Per-prompt `default` expressions lower into the `<prompt default="…">`
		// attribute via `emitOnDeviceExpression`. A default that pulls
		// from another input's typed value emits an XPath against
		// `instance('search-input:results')`; the instance accumulator
		// must walk the default expression too.
		const primaryInput = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-00000000cccc"),
			"primary_q",
			"Primary",
			"text",
			"name",
		);
		const echoInput = {
			...simpleSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000dddd"),
				"echo_q",
				"Echo",
				"text",
				"name",
			),
			default: term({ kind: "input", name: "primary_q" }),
		};
		const { xml } = emitRemoteRequest({
			module: makeModule({
				caseType: "patient",
				caseListConfig: makeListConfig({
					searchInputs: [primaryInput, echoInput],
				}),
				caseSearchConfig: {},
			}),
			moduleIndex: 0,
		});
		expect(xml).toContain(
			`<instance id="search-input:results" src="jr://instance/search-input/results"/>`,
		);
	});
});

// ── <post> structural invariants ───────────────────────────────────

describe("emitRemoteRequest — <post>", () => {
	it("emits the canonical relevant guard and case_id data child", () => {
		const { xml } = emitRemoteRequest({
			module: makeModule({ caseType: "patient", caseSearchConfig: {} }),
			moduleIndex: 0,
		});
		// XPath single-quote literals round-trip through the serializer
		// as `&apos;` inside the double-quoted attribute values.
		expect(xml).toContain(
			`relevant="count(instance(&apos;casedb&apos;)/casedb/case[@case_id=instance(&apos;commcaresession&apos;)/session/data/search_case_id]) = 0"`,
		);
		expect(xml).toContain(
			`<data key="case_id" ref="instance(&apos;commcaresession&apos;)/session/data/search_case_id"/>`,
		);
	});

	it("emits the URL with the __DOMAIN__ placeholder", () => {
		const { xml } = emitRemoteRequest({
			module: makeModule({ caseType: "patient", caseSearchConfig: {} }),
			moduleIndex: 0,
		});
		expect(xml).toContain(
			`url="https://www.commcarehq.org/a/__DOMAIN__/phone/claim-case/"`,
		);
	});
});

// ── <stack> rewind frame ────────────────────────────────────────────

describe("emitRemoteRequest — <stack>", () => {
	it("emits a single <push> frame containing a <rewind> targeting the search_case_id session datum", () => {
		const { xml } = emitRemoteRequest({
			module: makeModule({ caseType: "patient", caseSearchConfig: {} }),
			moduleIndex: 0,
		});
		// CCHQ's `RemoteRequestFactory.build_stack` no-smart-link
		// branch emits one frame with one rewind value. XPath
		// single-quote literals round-trip as `&apos;` inside the
		// double-quoted `value` attribute.
		expect(xml).toContain(
			`<rewind value="instance(&apos;commcaresession&apos;)/session/data/search_case_id"/>`,
		);
		const pushMatches = xml.match(/<push>/g) ?? [];
		expect(pushMatches.length).toBe(1);
	});
});

// ── WireShape return + autoLaunch threading ─────────────────────────

describe("emitRemoteRequest — WireShape", () => {
	it("returns the WireShape computed via compileForPlatform for the orchestrator's call site to consume", () => {
		// `wire.autoLaunch` is the bool the case-list short-detail
		// emitter needs to render the `<action auto_launch>` attribute
		// on `m{N}_case_short`. Returning the shape lets the surrounding
		// compiler thread the bool through without recomputing.
		const { wire } = emitRemoteRequest({
			module: makeModule({ caseType: "patient", caseSearchConfig: {} }),
			moduleIndex: 0,
		});
		// Default platform is web; an empty config falls into the
		// list-first fallback (every flag false).
		expect(wire.autoLaunch).toBe(false);
		expect(wire.defaultSearch).toBe(false);
		expect(wire.inlineSearch).toBe(false);
	});

	it("computes autoLaunch=true + defaultSearch=true when caseListConfig has a filter and zero search inputs (web skip-to-results)", () => {
		const { wire } = emitRemoteRequest({
			module: makeModule({
				caseType: "patient",
				caseListConfig: makeListConfig({
					filter: eq(prop("patient", "active"), literal("yes")),
				}),
				caseSearchConfig: {},
			}),
			moduleIndex: 0,
		});
		expect(wire.autoLaunch).toBe(true);
		expect(wire.defaultSearch).toBe(true);
		expect(wire.inlineSearch).toBe(false);
	});

	it("emits the list-first wire shape on the Android platform branch", () => {
		// Android always emits CCHQ's standard `<remote-request>`
		// shape — all three flags false. `inline_search: true` without
		// `auto_launch: true` reaches undefined CCHQ behavior per
		// `module_uses_inline_search`, so the list-first shape is the
		// only structurally sound Android emission.
		const { wire } = emitRemoteRequest({
			module: makeModule({ caseType: "patient", caseSearchConfig: {} }),
			moduleIndex: 0,
			platformContext: { platform: "android" },
		});
		expect(wire.autoLaunch).toBe(false);
		expect(wire.defaultSearch).toBe(false);
		expect(wire.inlineSearch).toBe(false);
	});
});

// ── End-to-end composition (Nova-shaped fixture) ────────────────────

describe("emitRemoteRequest — Nova-shaped end-to-end composition", () => {
	it("emits a complete <remote-request> for a module with filter, simple inputs, advanced inputs, and excluded owners", () => {
		// Cover every authoring slot the orchestrator routes — the
		// composed wire shape stays well-formed XML and surfaces every
		// load-bearing data slot in CCHQ's canonical order.
		const config: CaseSearchConfig = {
			searchScreenTitle: "Find a patient",
			searchButtonLabel: "Search now",
			excludedOwnerIds: term({
				kind: "literal",
				value: "owner-x",
			}),
		};
		const filter = eq(prop("patient", "active"), literal("yes"));
		const { xml, strings } = emitRemoteRequest({
			module: makeModule({
				caseType: "patient",
				caseListConfig: makeListConfig({
					filter,
					searchInputs: [
						simpleSearchInputDef(
							asUuid("00000000-0000-4000-8000-aaaa00000001"),
							"name",
							"Name",
							"text",
							"name",
						),
						advancedSearchInputDef(
							asUuid("00000000-0000-4000-8000-aaaa00000002"),
							"adv",
							"Advanced",
							"text",
							eq(prop("patient", "status"), literal("active")),
						),
					],
				}),
				caseSearchConfig: config,
			}),
			moduleIndex: 0,
		});

		// All four child element families compose.
		expect(xml).toContain("<post ");
		expect(xml).toContain(`<command id="search_command.m0">`);
		expect(xml).toContain(`<instance id="casedb"`);
		expect(xml).toContain("<session>");
		expect(xml).toContain("<stack>");

		// Data slots in canonical order. XPath single-quote literals
		// round-trip as `&apos;` inside the double-quoted `ref`
		// attribute values.
		expect(xml).toContain(`<data key="case_type" ref="&apos;patient&apos;"/>`);
		expect(xml).toContain(
			`<data key="commcare_blacklisted_owner_ids" ref="&apos;owner-x&apos;"/>`,
		);
		expect(xml).toContain(`<data key="_xpath_query"`);

		// Per-input prompt + locale.
		expect(xml).toContain(`<prompt key="name"`);
		expect(xml).toContain(`<prompt key="adv"`);

		// Strings registered.
		expect(strings["case_search.m0"]).toBe("Search now");
		expect(strings["case_search.m0.inputs"]).toBe("Find a patient");
		expect(strings["search_property.m0.name"]).toBe("Name");
		expect(strings["search_property.m0.adv"]).toBe("Advanced");

		// Datum references the search-target detail ids.
		expect(xml).toContain(`detail-confirm="m0_search_long"`);
		expect(xml).toContain(`detail-select="m0_search_short"`);
	});
});
