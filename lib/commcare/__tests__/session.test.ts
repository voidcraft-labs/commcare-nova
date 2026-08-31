import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type {
	MatchedChild,
	ProjectedFormLink,
} from "@/lib/commcare/formLinkProjection";
import {
	deriveCaseListEntryDefinition,
	deriveCaseSelectionDatum,
	deriveEntryDefinition,
	deriveFormLinkStack,
	derivePostSubmitStack,
	deriveSessionDatums,
	renderEntryXml,
	renderStackXml,
	type StackOperation,
	toHqWorkflow,
} from "@/lib/commcare/session";
import { lowerXPathForJavaRosa } from "@/lib/commcare/xpath";
import {
	concat as concatExpr,
	eq,
	input,
	literal,
	matchAll,
	matchNone,
	prop,
	term,
} from "@/lib/domain/predicate/builders";

// ── deriveSessionDatums ────────────────────────────────────────────

describe("deriveSessionDatums", () => {
	it("filters a child population through every value in a selected-parent set", () => {
		const parent = deriveCaseSelectionDatum({
			id: "parent_selected_cases",
			caseType: "household",
			moduleIndex: 0,
			maxSelectValue: 5,
		});
		const child = deriveCaseSelectionDatum({
			id: "case_id",
			caseType: "visit",
			moduleIndex: 1,
			parentSelection: parent,
		});

		expect(child.nodeset).toContain(
			"[index/*[not(@relationship='extension')]=instance('parent_selected_cases')/results/value]",
		);
		expect(child.instanceIds).toBeUndefined();
	});

	it("returns case_id datum for followup forms with case type", () => {
		const datums = deriveSessionDatums({
			formType: "followup",
			moduleIndex: 0,
			caseType: "patient",
		});
		expect(datums).toHaveLength(1);
		expect(datums[0].id).toBe("case_id");
		expect(datums[0].instanceId).toBe("casedb");
		expect(datums[0].nodeset).toContain("@case_type='patient'");
		expect(datums[0].nodeset).toContain("@status='open'");
		expect(datums[0].detailSelect).toBe("m0_case_short");
	});

	it("uses correct module index in detail reference", () => {
		const datums = deriveSessionDatums({
			formType: "followup",
			moduleIndex: 3,
			caseType: "household",
		});
		expect(datums[0].detailSelect).toBe("m3_case_short");
	});

	it("returns empty for registration forms", () => {
		expect(
			deriveSessionDatums({
				formType: "registration",
				moduleIndex: 0,
				caseType: "patient",
			}),
		).toEqual([]);
	});

	it("returns empty for survey forms", () => {
		expect(deriveSessionDatums({ formType: "survey", moduleIndex: 0 })).toEqual(
			[],
		);
	});

	it("returns empty for followup without case type", () => {
		expect(
			deriveSessionDatums({ formType: "followup", moduleIndex: 0 }),
		).toEqual([]);
	});

	// ── caseListConfig.filter integration ──
	//
	// The optional fourth positional parameter compiles the
	// module's case-list filter through `emitNodesetFilter` and
	// appends the bracketed XPath fragment to the nodeset after
	// the canonical `[@case_type][@status]` predicates. Filter
	// precedence (case-type / status first, user filter last)
	// matches CCHQ's
	// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`.

	it("appends the filter fragment after the case-type / status predicates", () => {
		const filter = eq(prop("patient", "is_priority"), literal(true));
		const datums = deriveSessionDatums({
			formType: "followup",
			moduleIndex: 0,
			caseType: "patient",
			caseListFilter: filter,
		});
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][is_priority = 'true']",
		);
	});

	it("omits the filter fragment when the filter is the match-all sentinel", () => {
		const datums = deriveSessionDatums({
			formType: "followup",
			moduleIndex: 0,
			caseType: "patient",
			caseListFilter: matchAll(),
		});
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open']",
		);
	});

	it("emits a [false()] fragment for the match-none sentinel", () => {
		// `match-none` faithfully restricts the case list to the
		// empty match set — opposite of match-all's no-op
		// collapse.
		const datums = deriveSessionDatums({
			formType: "followup",
			moduleIndex: 0,
			caseType: "patient",
			caseListFilter: matchNone(),
		});
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][false()]",
		);
	});

	it("applies owner exclusion after the always-on list filter", () => {
		const filter = eq(prop("patient", "is_priority"), literal(true));
		const excludedOwners = term(literal("owner-a owner-b"));
		const datums = deriveSessionDatums({
			formType: "followup",
			moduleIndex: 0,
			caseType: "patient",
			caseListFilter: filter,
			excludedOwnerIds: excludedOwners,
		});

		const ownerRule = lowerXPathForJavaRosa(
			"normalize-space('owner-a owner-b') = '' or not(selected(normalize-space('owner-a owner-b'), @owner_id))",
		);
		expect(datums[0].nodeset).toBe(
			`instance('casedb')/casedb/case[@case_type='patient'][@status='open'][is_priority = 'true'][${ownerRule}]`,
		);
	});

	it("ignores the filter for non-case-loading form types", () => {
		// Registration / survey forms emit no case-loading datum
		// at all; the filter is meaningful only against the
		// case-loading datum's nodeset, so the empty array is
		// the correct result regardless of filter presence.
		const filter = eq(prop("patient", "is_priority"), literal(true));
		expect(
			deriveSessionDatums({
				formType: "registration",
				moduleIndex: 0,
				caseType: "patient",
				caseListFilter: filter,
			}),
		).toEqual([]);
		expect(
			deriveSessionDatums({
				formType: "survey",
				moduleIndex: 0,
				caseListFilter: filter,
			}),
		).toEqual([]);
	});

	// ── multi-bucket subcase shape (post Step 6 bucketing change) ──
	//
	// The deriveCaseConfig bucketing change in Step 6 allows two repeats
	// in one form to each produce a subcase of the same case type — they
	// land as two distinct OpenSubCaseAction entries with different
	// repeat_context values. The session-datum derivation must skip BOTH
	// from emit (repeat-context subcases mint their case_id via a
	// calculate bind, not a session datum) while still counting them in
	// the index — matching CCHQ's Form.session_var_for_action numbering.
	it("skips emit for every repeat-context subcase but still counts the index", () => {
		const actions = {
			open_case: {
				condition: { type: "always" as const },
				name_update: {
					question_path: "/data/case_name",
					update_mode: "always",
				},
			},
			update_case: { condition: { type: "never" as const }, update: {} },
			case_preload: { condition: { type: "never" as const }, preload: {} },
			close_case: { condition: { type: "never" as const } },
			subcases: [
				{
					doc_type: "OpenSubCaseAction",
					case_type: "child",
					name_update: {
						question_path: "/data/family/case_name",
						update_mode: "always",
					},
					reference_id: "",
					case_properties: {},
					repeat_context: "/data/family",
					relationship: "child" as const,
					close_condition: { type: "never" as const },
					condition: { type: "always" as const },
				},
				{
					doc_type: "OpenSubCaseAction",
					case_type: "child",
					name_update: {
						question_path: "/data/pets/case_name",
						update_mode: "always",
					},
					reference_id: "",
					case_properties: {},
					repeat_context: "/data/pets",
					relationship: "child" as const,
					close_condition: { type: "never" as const },
					condition: { type: "always" as const },
				},
			],
		};
		const datums = deriveSessionDatums({
			formType: "registration",
			moduleIndex: 0,
			caseType: "household",
			actions: actions as never,
		});
		// Only the primary case datum emits — both subcases are
		// repeat-context and skip emit. Without the bucketing fix the
		// derivation would either drop one or duplicate the other (since
		// pre-Step-6 the two subcases collapsed into one).
		expect(datums).toHaveLength(1);
		expect(datums[0].id).toBe("case_id_new_household_0");
	});
});

// ── derivePostSubmitStack ──────────────────────────────────────────

describe("derivePostSubmitStack", () => {
	const previousFrame: MatchedChild[] = [
		{ type: "command", id: "m0" },
		{
			type: "datum",
			id: "case_id",
			value: "instance('commcaresession')/session/data/case_id",
		},
	];

	describe("app_home", () => {
		it("emits no frame — an empty stack pops to home, HQ's `default`", () => {
			// `finishAndPop` on an empty stack ends the session; an empty
			// `<create/>` would land in the same place with one more frame.
			expect(derivePostSubmitStack("app_home", 0, previousFrame)).toEqual([]);
		});
	});

	describe("module", () => {
		it("produces module command with correct index", () => {
			const ops = derivePostSubmitStack("module", 2, []);
			expect(ops).toHaveLength(1);
			expect(ops[0].children).toEqual([{ type: "command", value: "'m2'" }]);
		});
	});

	describe("previous", () => {
		it("pushes the projected previous frame verbatim", () => {
			const ops = derivePostSubmitStack("previous", 0, previousFrame);
			expect(ops).toHaveLength(1);
			expect(ops[0].children).toEqual([
				{ type: "command", value: "'m0'" },
				{
					type: "datum",
					id: "case_id",
					value: "instance('commcaresession')/session/data/case_id",
				},
			]);
		});

		it("emits no frame when the previous frame is empty", () => {
			expect(derivePostSubmitStack("previous", 0, [])).toEqual([]);
		});
	});
});

// ── deriveFormLinkStack ────────────────────────────────────────────

/** A projected link as the stack derivation receives it. */
function projectedLink(
	uuid: string,
	children: MatchedChild[],
	guard?: string,
): ProjectedFormLink {
	return {
		uuid: testUuid(uuid),
		...(guard !== undefined && { guard }),
		target: { type: "module", moduleUuid: testUuid("unused") },
		children,
		datums: [],
		unmatched: [],
		missing: [],
		unused: [],
	};
}

describe("deriveFormLinkStack", () => {
	const formTarget: MatchedChild[] = [
		{ type: "command", id: "m2" },
		{ type: "command", id: "m2-f3" },
	];

	it("emits one `<create if>` per link carrying the projection's guard and children", () => {
		const ops = deriveFormLinkStack(
			{
				links: [projectedLink("l1", formTarget, "/data/refer = 'yes'")],
				fallback: { kind: "guarded", guard: "not(/data/refer = 'yes')" },
			},
			"app_home",
			0,
			[],
		);
		// `app_home` as the fallback emits no frame, so the guarded
		// fallback adds nothing.
		expect(ops).toEqual([
			{
				op: "create",
				ifClause: "/data/refer = 'yes'",
				children: [
					{ type: "command", value: "'m2'" },
					{ type: "command", value: "'m2-f3'" },
				],
			},
		]);
	});

	it("emits no `if` at all for an unguarded frame", () => {
		// `if=""` fails Core's `StackOpParser` — absence is the only
		// spelling of "always".
		const ops = deriveFormLinkStack(
			{
				links: [projectedLink("l1", [{ type: "command", id: "m4" }])],
				fallback: { kind: "none" },
			},
			"app_home",
			0,
			[],
		);
		expect(ops).toEqual([
			{ op: "create", children: [{ type: "command", value: "'m4'" }] },
		]);
		expect("ifClause" in ops[0]).toBe(false);
	});

	it("carries matched datum children after the commands", () => {
		const ops = deriveFormLinkStack(
			{
				links: [
					projectedLink("l1", [
						{ type: "command", id: "m1" },
						{ type: "command", id: "m1-f0" },
						{ type: "datum", id: "case_id", value: "/data/patient_id" },
					]),
				],
				fallback: { kind: "none" },
			},
			"app_home",
			0,
			[],
		);
		expect(ops[0].children).toEqual([
			{ type: "command", value: "'m1'" },
			{ type: "command", value: "'m1-f0'" },
			{ type: "datum", id: "case_id", value: "/data/patient_id" },
		]);
	});

	it("appends the fallback frame with the projection's guard when the list ends conditionally", () => {
		const ops = deriveFormLinkStack(
			{
				links: [
					projectedLink("l1", [{ type: "command", id: "m0" }], "/data/a = 1"),
					projectedLink(
						"l2",
						[{ type: "command", id: "m1" }],
						"(/data/b = 2) and not(/data/a = 1)",
					),
				],
				fallback: {
					kind: "guarded",
					guard: "not(/data/a = 1) and not((/data/b = 2) and not(/data/a = 1))",
				},
			},
			"module",
			3,
			[],
		);
		expect(ops).toHaveLength(3);
		expect(ops[2]).toEqual({
			op: "create",
			ifClause: "not(/data/a = 1) and not((/data/b = 2) and not(/data/a = 1))",
			children: [{ type: "command", value: "'m3'" }],
		});
	});

	it("routes a `previous` fallback through the projected previous frame", () => {
		const ops = deriveFormLinkStack(
			{
				links: [projectedLink("l1", [{ type: "command", id: "m1" }], "a = 1")],
				fallback: { kind: "guarded", guard: "not(a = 1)" },
			},
			"previous",
			0,
			[
				{ type: "command", id: "m0" },
				{ type: "command", id: "m0-f1" },
			],
		);
		expect(ops[1]).toEqual({
			op: "create",
			ifClause: "not(a = 1)",
			children: [
				{ type: "command", value: "'m0'" },
				{ type: "command", value: "'m0-f1'" },
			],
		});
	});

	it("emits no fallback frame when a terminal unconditional link is the else", () => {
		const ops = deriveFormLinkStack(
			{
				links: [
					projectedLink("l1", [{ type: "command", id: "m0" }], "a = 1"),
					projectedLink("l2", [{ type: "command", id: "m1" }], "not(a = 1)"),
				],
				fallback: { kind: "suppressed-by-else" },
			},
			"module",
			3,
			[],
		);
		expect(ops).toHaveLength(2);
	});
});

// ── deriveEntryDefinition ──────────────────────────────────────────

describe("deriveEntryDefinition", () => {
	it("builds complete entry for followup form with previous navigation", () => {
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			previousFrame: [
				{ type: "command", id: "m0" },
				{
					type: "datum",
					id: "case_id",
					value: "instance('commcaresession')/session/data/case_id",
				},
			],
		});
		expect(entry.commandId).toBe("m0-f1");
		expect(entry.localeId).toBe("forms.m0f1");
		// `casedb` from the case datum, `commcaresession` from the previous
		// frame's datum value — the entry evaluates that stack expression too.
		expect(entry.instances.map((instance) => instance.id)).toEqual([
			"casedb",
			"commcaresession",
		]);
		expect(entry.session?.datums).toHaveLength(1);
		expect(entry.stack?.operations).toHaveLength(1);
	});

	it("declares no session instance when the previous frame carries no datum", () => {
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "survey",
			postSubmit: "previous",
			previousFrame: [{ type: "command", id: "m0" }],
		});
		expect(entry.instances).toEqual([]);
	});

	it("never declares search-input:results on the ordinary entry, matching the substituted nodeset", () => {
		// The ordinary case-loading entry evaluates before any Search
		// runs, so the nodeset emission substitutes Search-input refs to
		// their unanswered reading and the accumulator collects from the
		// SAME substituted tree — a declared-but-unloaded
		// `search-input:results` instance would itself throw
		// `XPathMissingInstanceException` in Core the moment the nodeset
		// referenced it.
		const filter = eq(prop("patient", "city"), input(testUuid("city_q")));
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListFilter: filter,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("casedb");
		expect(ids).not.toContain("search-input:results");
		const nodeset = entry.session?.datums[0]?.nodeset ?? "";
		expect(nodeset).not.toContain("search-input:results");
	});

	it("accumulates the commcaresession instance when the case-list filter references a session term", () => {
		const filter = eq(
			prop("patient", "region"),
			term({ kind: "session-user", field: "region" }),
		);
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListFilter: filter,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("commcaresession");
		const session = entry.instances.find((i) => i.id === "commcaresession");
		expect(session?.src).toBe("jr://instance/session");
	});

	it("accumulates commcaresession when the search-button display condition references a session term", () => {
		// The search-button display condition lowers to the
		// `<action relevant>` attribute on the case-list short detail.
		// That attribute evaluates in the enclosing `<entry>` context,
		// so every instance the predicate references needs an
		// `<instance>` declaration on the entry — same accumulation
		// rule the case-list filter applies.
		const displayCondition = eq(
			term({ kind: "session-user", field: "region" }),
			prop("patient", "region"),
		);
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			searchButtonDisplayCondition: displayCondition,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("commcaresession");
	});

	it("accumulates both selected-case instances for form-command relevance", () => {
		const displayCondition = eq(prop("patient", "status"), literal("open"));
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			relationContext: {},
			formDisplayCondition: displayCondition,
		});
		expect(entry.instances.map((instance) => instance.id)).toEqual(
			expect.arrayContaining(["casedb", "commcaresession"]),
		);
	});

	it("accumulates instances referenced by the owner-exclusion expression", () => {
		const excludedOwners = term({
			kind: "session-user",
			field: "excluded_owner_ids",
		});
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			excludedOwnerIds: excludedOwners,
		});

		expect(entry.instances).toContainEqual({
			id: "commcaresession",
			src: "jr://instance/session",
		});
		const ownerRule = lowerXPathForJavaRosa(
			"normalize-space(instance('commcaresession')/session/user/data/excluded_owner_ids) = '' or not(selected(normalize-space(instance('commcaresession')/session/user/data/excluded_owner_ids), @owner_id))",
		);
		expect(entry.session?.datums[0].nodeset).toContain(`[${ownerRule}]`);
	});

	it("omits detail-confirm when a case-list viewer has no Details fields", () => {
		const entry = deriveCaseListEntryDefinition(
			0,
			"patient",
			undefined,
			undefined,
			undefined,
			false,
		);
		const datum = entry.session?.datums[0];

		expect(datum?.detailSelect).toBe("m0_case_short");
		expect(datum?.detailConfirm).toBeUndefined();
	});

	it("accumulates search-input:results when the search-button display condition references a search input", () => {
		const displayCondition = eq(input(testUuid("city_q")), literal("active"));
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			searchButtonDisplayCondition: displayCondition,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("search-input:results");
	});

	it("accumulates instances reachable from calc-column expressions", () => {
		// Calc-column expressions land on `m{N}_case_short` /
		// `m{N}_case_long`. CCHQ resolves a detail's XPath against
		// the enclosing entry's declarations; without this
		// accumulation, the local `.ccz` would emit an
		// `instance('commcaresession')` reference inside the detail
		// without a matching declaration on the entry, and the
		// runtime would raise `XPathException` at case-list render
		// time.
		const calcExpressions = [
			concatExpr(
				term({ kind: "session-user", field: "region" }),
				term(literal(": ")),
				term({ kind: "prop", caseType: "patient", property: "case_name" }),
			),
		];
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListColumnExpressions: calcExpressions,
		});
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("commcaresession");
		expect(ids).toContain("casedb");
	});

	it("dedups instances across calc-column expressions and the case-list filter", () => {
		// Both surfaces reference `commcaresession`; the accumulator
		// must not double-emit the declaration.
		const filter = eq(
			prop("patient", "region"),
			term({ kind: "session-user", field: "region" }),
		);
		const calcExpressions = [
			concatExpr(term({ kind: "session-user", field: "language" })),
		];
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListFilter: filter,
			caseListColumnExpressions: calcExpressions,
		});
		const sessionInstances = entry.instances.filter(
			(i) => i.id === "commcaresession",
		);
		expect(sessionInstances).toHaveLength(1);
	});

	it("dedups instances across the case-list filter and the display condition", () => {
		// Both predicates reference the same `commcaresession`
		// instance; the accumulator should not double-emit.
		const filter = eq(
			prop("patient", "region"),
			term({ kind: "session-user", field: "region" }),
		);
		const displayCondition = eq(
			term({ kind: "session-user", field: "language" }),
			literal("en"),
		);
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 1,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			caseListFilter: filter,
			searchButtonDisplayCondition: displayCondition,
		});
		const sessionInstances = entry.instances.filter(
			(i) => i.id === "commcaresession",
		);
		expect(sessionInstances).toHaveLength(1);
	});

	it("omits stack for default destination", () => {
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 0,
			formType: "registration",
			postSubmit: "app_home",
		});
		expect(entry.stack).toBeUndefined();
	});

	it("prioritizes formLinks over simple post_submit", () => {
		// When formLinks is present, the stack is derived from the links
		// (with the post_submit value used only as the fallback frame)
		// rather than from post_submit directly.
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/xyz",
			moduleIndex: 0,
			formIndex: 0,
			formType: "survey",
			postSubmit: "module",
			formLinks: {
				links: [
					projectedLink(
						"l1",
						[
							{ type: "command", id: "m1" },
							{ type: "command", id: "m1-f0" },
						],
						"/data/go = 'yes'",
					),
				],
				fallback: { kind: "guarded", guard: "not(/data/go = 'yes')" },
			},
		});
		const ops = entry.stack?.operations;
		expect(ops).toBeDefined();
		expect(ops?.[0].ifClause).toBe("/data/go = 'yes'");
		expect(ops?.[1].ifClause).toBe("not(/data/go = 'yes')");
		expect(ops?.[1].children).toEqual([{ type: "command", value: "'m0'" }]);
	});

	it("routes a `previous` post-submit through the projected previous frame", () => {
		// A forms-first module's previous frame is [m0, m0-f1] (HQ pops the
		// trailing non-selection datums), not Nova's old [m0, case_id].
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/xyz",
			moduleIndex: 0,
			formIndex: 1,
			formType: "registration",
			postSubmit: "previous",
			caseType: "patient",
			previousFrame: [
				{ type: "command", id: "m0" },
				{ type: "command", id: "m0-f1" },
			],
		});
		expect(entry.stack?.operations).toEqual([
			{
				op: "create",
				children: [
					{ type: "command", value: "'m0'" },
					{ type: "command", value: "'m0-f1'" },
				],
			},
		]);
	});

	it("declares every secondary instance used by form-link stack XPath", () => {
		// The guard reads casedb + the session; a datum child reads the
		// session; an explicit datum reads the session user. The entry
		// declares each instance once, on the entry that evaluates it.
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/xyz",
			moduleIndex: 0,
			formIndex: 0,
			formType: "survey",
			postSubmit: "previous",
			formLinks: {
				links: [
					{
						...projectedLink(
							"l1",
							[
								{ type: "command", id: "m1" },
								{ type: "command", id: "m1-f0" },
								{
									type: "datum",
									id: "case_id",
									value: "instance('commcaresession')/session/data/case_id",
								},
							],
							"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/status = 'open'",
						),
						datums: [
							{
								name: "worker",
								xpath: "instance('commcaresession')/session/user/data/username",
							},
						],
					},
				],
				fallback: { kind: "suppressed-by-else" },
			},
		});

		expect(entry.instances).toEqual([
			{ id: "casedb", src: "jr://instance/casedb" },
			{ id: "commcaresession", src: "jr://instance/session" },
		]);
	});

	it("declares the instances a guarded fallback guard reads", () => {
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/xyz",
			moduleIndex: 0,
			formIndex: 0,
			formType: "survey",
			postSubmit: "module",
			formLinks: {
				links: [
					projectedLink(
						"l1",
						[{ type: "command", id: "m1" }],
						"instance('commcaresession')/session/user/data/role = 'chw'",
					),
				],
				fallback: {
					kind: "guarded",
					guard:
						"not(instance('commcaresession')/session/user/data/role = 'chw')",
				},
			},
		});
		expect(entry.instances).toEqual([
			{ id: "commcaresession", src: "jr://instance/session" },
		]);
	});
});

// ── renderStackXml ─────────────────────────────────────────────────

describe("renderStackXml", () => {
	it("renders empty string for no operations", () => {
		expect(renderStackXml([])).toBe("");
	});

	it("renders empty create", () => {
		const xml = renderStackXml([{ op: "create", children: [] }]);
		expect(xml).toContain("<create/>");
	});

	it("renders clear operation", () => {
		const xml = renderStackXml([{ op: "clear", children: [] }]);
		expect(xml).toContain("<clear/>");
		expect(xml).not.toContain("</clear>");
	});

	it("renders conditional clear", () => {
		const xml = renderStackXml([
			{ op: "clear", ifClause: "true()", children: [] },
		]);
		expect(xml).toContain('<clear if="true()"/>');
	});

	it("renders push operation", () => {
		const op: StackOperation = {
			op: "push",
			children: [{ type: "datum", id: "case_id", value: "abc" }],
		};
		const xml = renderStackXml([op]);
		expect(xml).toContain("<push>");
		expect(xml).toContain("</push>");
		expect(xml).toContain('id="case_id"');
	});

	it("renders create with children", () => {
		const op: StackOperation = {
			op: "create",
			ifClause: "age > 18",
			children: [{ type: "command", value: "'m1-f0'" }],
		};
		const xml = renderStackXml([op]);
		// `>` in the `if` attribute round-trips through the XML
		// entity `&gt;` — same XML-spec-equivalent encoding the
		// XForm emitter produces. A conforming parser decodes both
		// forms identically; CCHQ and JavaRosa see `age > 18`.
		expect(xml).toContain('<create if="age &gt; 18">');
		expect(xml).toContain("</create>");
		// XPath single-quote string literals round-trip as `&apos;`
		// inside double-quoted attribute values. Same encoding the
		// XForm path uses on every `<setvalue value="instance(...)`.
		expect(xml).toContain('<command value="&apos;m1-f0&apos;"/>');
	});

	it("renders multiple operations", () => {
		const ops: StackOperation[] = [
			{
				op: "create",
				ifClause: "x = 1",
				children: [{ type: "command", value: "'m0-f0'" }],
			},
			{ op: "create", children: [{ type: "command", value: "'m0'" }] },
		];
		const xml = renderStackXml(ops);
		expect(xml).toContain('if="x = 1"');
		expect(xml).toContain('<command value="&apos;m0-f0&apos;"/>');
		expect(xml).toContain('<command value="&apos;m0&apos;"/>');
	});
});

// ── renderEntryXml ─────────────────────────────────────────────────

describe("renderEntryXml", () => {
	it("renders the HQ multi-select instance-datum exactly", () => {
		const datum = deriveCaseSelectionDatum({
			id: "selected_cases",
			caseType: "patient",
			moduleIndex: 0,
			maxSelectValue: 15,
		});
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/multi",
			moduleIndex: 0,
			formIndex: 0,
			formType: "followup",
			postSubmit: "app_home",
			caseType: "patient",
			projectedSessionDatums: [datum],
		});
		const xml = renderEntryXml(entry);
		expect(xml).toContain(
			`<instance id="selected_cases" src="jr://instance/selected-entities/selected_cases"/>`,
		);
		expect(xml).toContain(
			`<instance-datum id="selected_cases" nodeset="instance(&apos;casedb&apos;)/casedb/case[@case_type=&apos;patient&apos;][@status=&apos;open&apos;]" value="./@case_id" detail-select="m0_case_short" max-select-value="15"/>`,
		);
	});

	it("renders basic registration entry without stack", () => {
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/abc",
			moduleIndex: 0,
			formIndex: 0,
			formType: "registration",
			postSubmit: "app_home",
		});
		const xml = renderEntryXml(entry);
		expect(xml).toContain("<entry>");
		expect(xml).toContain("<form>http://openrosa.org/formdesigner/abc</form>");
		expect(xml).not.toContain("<stack>");
		expect(xml).toContain("</entry>");
	});

	it("renders followup entry with session and stack", () => {
		const entry = deriveEntryDefinition({
			formXmlns: "http://openrosa.org/formdesigner/xyz",
			moduleIndex: 1,
			formIndex: 2,
			formType: "followup",
			postSubmit: "previous",
			caseType: "patient",
			previousFrame: [
				{ type: "command", id: "m1" },
				{
					type: "datum",
					id: "case_id",
					value: "instance('commcaresession')/session/data/case_id",
				},
			],
		});
		const xml = renderEntryXml(entry);
		expect(xml).toContain("<session>");
		expect(xml).toContain('id="case_id"');
		expect(xml).toContain("<stack>");
		// XPath single-quote literals round-trip as `&apos;` inside
		// double-quoted attribute values.
		expect(xml).toContain('<command value="&apos;m1&apos;"/>');
	});
});

// ── HQ workflow mapping ────────────────────────────────────────────

describe("toHqWorkflow", () => {
	it("maps all destinations correctly", () => {
		expect(toHqWorkflow("app_home")).toBe("default");
		expect(toHqWorkflow("module")).toBe("module");
		expect(toHqWorkflow("previous")).toBe("previous_screen");
	});
});
