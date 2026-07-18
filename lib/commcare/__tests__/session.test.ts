import { describe, expect, it } from "vitest";
import type { HqFormLink } from "@/lib/commcare";
import {
	deriveCaseListEntryDefinition,
	deriveEntryDefinition,
	deriveFormLinkStack,
	derivePostSubmitStack,
	deriveSessionDatums,
	renderEntryXml,
	renderStackXml,
	type StackOperation,
	toHqWorkflow,
} from "@/lib/commcare/session";
import {
	concat as concatExpr,
	eq,
	literal,
	matchAll,
	matchNone,
	prop,
	term,
} from "@/lib/domain/predicate/builders";

// ── deriveSessionDatums ────────────────────────────────────────────

describe("deriveSessionDatums", () => {
	it("returns case_id datum for followup forms with case type", () => {
		const datums = deriveSessionDatums("followup", 0, "patient");
		expect(datums).toHaveLength(1);
		expect(datums[0].id).toBe("case_id");
		expect(datums[0].instanceId).toBe("casedb");
		expect(datums[0].nodeset).toContain("@case_type='patient'");
		expect(datums[0].nodeset).toContain("@status='open'");
		expect(datums[0].detailSelect).toBe("m0_case_short");
	});

	it("uses correct module index in detail reference", () => {
		const datums = deriveSessionDatums("followup", 3, "household");
		expect(datums[0].detailSelect).toBe("m3_case_short");
	});

	it("returns empty for registration forms", () => {
		expect(deriveSessionDatums("registration", 0, "patient")).toEqual([]);
	});

	it("returns empty for survey forms", () => {
		expect(deriveSessionDatums("survey", 0)).toEqual([]);
	});

	it("returns empty for followup without case type", () => {
		expect(deriveSessionDatums("followup", 0)).toEqual([]);
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
		const datums = deriveSessionDatums("followup", 0, "patient", filter);
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][is_priority = 'true']",
		);
	});

	it("omits the filter fragment when the filter is the match-all sentinel", () => {
		const datums = deriveSessionDatums("followup", 0, "patient", matchAll());
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open']",
		);
	});

	it("emits a [false()] fragment for the match-none sentinel", () => {
		// `match-none` faithfully restricts the case list to the
		// empty match set — opposite of match-all's no-op
		// collapse.
		const datums = deriveSessionDatums("followup", 0, "patient", matchNone());
		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][false()]",
		);
	});

	it("applies owner exclusion after the always-on list filter", () => {
		const filter = eq(prop("patient", "is_priority"), literal(true));
		const excludedOwners = term(literal("owner-a owner-b"));
		const datums = deriveSessionDatums(
			"followup",
			0,
			"patient",
			filter,
			undefined,
			excludedOwners,
		);

		expect(datums[0].nodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][is_priority = 'true'][normalize-space('owner-a owner-b') = '' or not(selected(normalize-space('owner-a owner-b'), @owner_id))]",
		);
	});

	it("ignores the filter for non-case-loading form types", () => {
		// Registration / survey forms emit no case-loading datum
		// at all; the filter is meaningful only against the
		// case-loading datum's nodeset, so the empty array is
		// the correct result regardless of filter presence.
		const filter = eq(prop("patient", "is_priority"), literal(true));
		expect(deriveSessionDatums("registration", 0, "patient", filter)).toEqual(
			[],
		);
		expect(deriveSessionDatums("survey", 0, undefined, filter)).toEqual([]);
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
		const datums = deriveSessionDatums(
			"registration",
			0,
			"household",
			undefined,
			actions as never,
		);
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
	describe("app_home", () => {
		it("produces empty create operation for any form type", () => {
			for (const formType of ["registration", "followup", "survey"] as const) {
				const ops = derivePostSubmitStack("app_home", 0, formType, "patient");
				expect(ops).toHaveLength(1);
				expect(ops[0].op).toBe("create");
				expect(ops[0].children).toEqual([]);
			}
		});
	});

	describe("root", () => {
		it("produces root command for any form type", () => {
			for (const formType of ["registration", "followup", "survey"] as const) {
				const ops = derivePostSubmitStack("root", 0, formType);
				expect(ops).toHaveLength(1);
				expect(ops[0].op).toBe("create");
				expect(ops[0].children).toEqual([{ type: "command", value: "'root'" }]);
			}
		});
	});

	describe("module", () => {
		it("produces module command with correct index", () => {
			const ops = derivePostSubmitStack("module", 2, "registration");
			expect(ops).toHaveLength(1);
			expect(ops[0].children).toEqual([{ type: "command", value: "'m2'" }]);
		});
	});

	describe("parent_module (stub)", () => {
		it("falls back to module behavior", () => {
			const parentOps = derivePostSubmitStack(
				"parent_module",
				1,
				"followup",
				"patient",
			);
			const moduleOps = derivePostSubmitStack(
				"module",
				1,
				"followup",
				"patient",
			);
			expect(parentOps).toEqual(moduleOps);
		});
	});

	describe("previous", () => {
		it("includes case_id datum for followup forms", () => {
			const ops = derivePostSubmitStack("previous", 0, "followup", "patient");
			expect(ops).toHaveLength(1);
			expect(ops[0].children).toHaveLength(2);
			expect(ops[0].children[0]).toEqual({ type: "command", value: "'m0'" });
			expect(ops[0].children[1]).toEqual({
				type: "datum",
				id: "case_id",
				value: "instance('commcaresession')/session/data/case_id",
			});
		});

		it("omits case_id datum for registration forms", () => {
			const ops = derivePostSubmitStack(
				"previous",
				0,
				"registration",
				"patient",
			);
			expect(ops[0].children).toHaveLength(1);
		});

		it("omits case_id datum for survey forms", () => {
			const ops = derivePostSubmitStack("previous", 0, "survey");
			expect(ops[0].children).toHaveLength(1);
		});
	});
});

// ── deriveFormLinkStack ────────────────────────────────────────────

describe("deriveFormLinkStack", () => {
	it("emits module + form commands for conditional form targets", () => {
		const links: HqFormLink[] = [
			{
				condition: "/data/refer = 'yes'",
				target: { type: "form", moduleIndex: 2, formIndex: 3 },
			},
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		// One conditional link + one fallback (negated condition).
		expect(ops).toHaveLength(2);
		expect(ops[0]).toEqual({
			op: "create",
			ifClause: "/data/refer = 'yes'",
			children: [
				{ type: "command", value: "'m2'" },
				{ type: "command", value: "'m2-f3'" },
			],
		});
		expect(ops[1].ifClause).toBe("not(/data/refer = 'yes')");
	});

	it("emits only module command for module targets", () => {
		const links: HqFormLink[] = [
			{ target: { type: "module", moduleIndex: 4 } },
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		// Unconditional link, no fallback needed.
		expect(ops).toHaveLength(1);
		expect(ops[0]).toEqual({
			op: "create",
			children: [{ type: "command", value: "'m4'" }],
		});
	});

	it("appends datum overrides after the command children", () => {
		const links: HqFormLink[] = [
			{
				target: { type: "form", moduleIndex: 1, formIndex: 0 },
				datums: [{ name: "case_id", xpath: "/data/patient_id" }],
			},
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		expect(ops[0].children).toEqual([
			{ type: "command", value: "'m1'" },
			{ type: "command", value: "'m1-f0'" },
			{ type: "datum", id: "case_id", value: "/data/patient_id" },
		]);
	});

	it("skips the fallback when every link is unconditional", () => {
		const links: HqFormLink[] = [
			{ target: { type: "form", moduleIndex: 0, formIndex: 1 } },
			{ target: { type: "module", moduleIndex: 2 } },
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		expect(ops).toHaveLength(2);
		expect(ops.every((op) => op.ifClause === undefined)).toBe(true);
	});

	it("ANDs negated conditions into the fallback", () => {
		const links: HqFormLink[] = [
			{
				condition: "/data/a = 1",
				target: { type: "form", moduleIndex: 0, formIndex: 0 },
			},
			{
				condition: "/data/b = 2",
				target: { type: "module", moduleIndex: 1 },
			},
		];
		const ops = deriveFormLinkStack(links, "module", 3, "followup", "patient");
		// Two conditional links + one fallback.
		expect(ops).toHaveLength(3);
		expect(ops[2].ifClause).toBe("not(/data/a = 1) and not(/data/b = 2)");
		// Fallback body mirrors the simple post-submit derivation for "module".
		expect(ops[2].children).toEqual([{ type: "command", value: "'m3'" }]);
	});

	it("wraps `or`-joined operands inside each not() without splitting them", () => {
		// XPath's `and` binds tighter than `or`, so a naive fallback like
		// `not(a) or b and not(c) or d` would silently change truth-table
		// semantics. `not(a or b) and not(c or d)` is the correct form
		// and depends on `not()` enclosing the entire condition verbatim.
		// This test pins that wrapping against a future refactor that
		// forgets the parenthesization.
		const links: HqFormLink[] = [
			{
				condition: "#form/q = 'a' or #form/q = 'b'",
				target: { type: "form", moduleIndex: 0, formIndex: 0 },
			},
			{
				condition: "#form/r = 1 or #form/r = 2",
				target: { type: "module", moduleIndex: 1 },
			},
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		expect(ops).toHaveLength(3);
		expect(ops[2].ifClause).toBe(
			"not(#form/q = 'a' or #form/q = 'b') and not(#form/r = 1 or #form/r = 2)",
		);
	});
});

// ── deriveEntryDefinition ──────────────────────────────────────────

describe("deriveEntryDefinition", () => {
	it("builds complete entry for followup form with previous navigation", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
		);
		expect(entry.commandId).toBe("m0-f1");
		expect(entry.localeId).toBe("forms.m0f1");
		expect(entry.instances).toHaveLength(1);
		expect(entry.session?.datums).toHaveLength(1);
		expect(entry.stack?.operations).toHaveLength(1);
	});

	it("accumulates the search-input:results instance when the case-list filter references an input", () => {
		// The case-list filter's bracketed XPath fragment lives inside
		// the case-loading datum's nodeset. Any instance the fragment
		// references must be declared on the `<entry>` itself; an
		// undeclared instance breaks `instance('...')` resolution at
		// runtime.
		const filter = eq(
			prop("patient", "city"),
			term({ kind: "input", name: "city_q" }),
		);
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
			undefined,
			filter,
		);
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("casedb");
		expect(ids).toContain("search-input:results");
		const searchInput = entry.instances.find(
			(i) => i.id === "search-input:results",
		);
		expect(searchInput?.src).toBe("jr://instance/search-input/results");
	});

	it("accumulates the commcaresession instance when the case-list filter references a session term", () => {
		const filter = eq(
			prop("patient", "region"),
			term({ kind: "session-user", field: "region" }),
		);
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
			undefined,
			filter,
		);
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
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
			undefined,
			undefined,
			displayCondition,
		);
		const ids = entry.instances.map((i) => i.id);
		expect(ids).toContain("commcaresession");
	});

	it("accumulates instances referenced by the owner-exclusion expression", () => {
		const excludedOwners = term({
			kind: "session-user",
			field: "excluded_owner_ids",
		});
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			excludedOwners,
		);

		expect(entry.instances).toContainEqual({
			id: "commcaresession",
			src: "jr://instance/session",
		});
		expect(entry.session?.datums[0].nodeset).toContain(
			"[normalize-space(instance('commcaresession')/session/user/data/excluded_owner_ids) = '' or not(selected(normalize-space(instance('commcaresession')/session/user/data/excluded_owner_ids), @owner_id))]",
		);
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
		const displayCondition = eq(
			term({ kind: "input", name: "city_q" }),
			literal("active"),
		);
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
			undefined,
			undefined,
			displayCondition,
		);
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
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
			undefined,
			undefined,
			undefined,
			calcExpressions,
		);
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
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
			undefined,
			filter,
			undefined,
			calcExpressions,
		);
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
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
			undefined,
			filter,
			displayCondition,
		);
		const sessionInstances = entry.instances.filter(
			(i) => i.id === "commcaresession",
		);
		expect(sessionInstances).toHaveLength(1);
	});

	it("omits stack for default destination", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			0,
			"registration",
			"app_home",
		);
		expect(entry.stack).toBeUndefined();
	});

	it("prioritizes formLinks over simple post_submit", () => {
		// When formLinks is present, the stack is derived from the links
		// (with the post_submit value used only as the negated-conditions
		// fallback) rather than from post_submit directly.
		const links: HqFormLink[] = [
			{
				condition: "/data/go = 'yes'",
				target: { type: "form", moduleIndex: 1, formIndex: 0 },
			},
		];
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/xyz",
			0,
			0,
			"survey",
			"app_home",
			undefined,
			links,
		);
		const ops = entry.stack?.operations;
		expect(ops).toBeDefined();
		expect(ops?.[0].ifClause).toBe("/data/go = 'yes'");
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
	it("renders basic registration entry without stack", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			0,
			"registration",
			"app_home",
		);
		const xml = renderEntryXml(entry);
		expect(xml).toContain("<entry>");
		expect(xml).toContain("<form>http://openrosa.org/formdesigner/abc</form>");
		expect(xml).not.toContain("<stack>");
		expect(xml).toContain("</entry>");
	});

	it("renders followup entry with session and stack", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/xyz",
			1,
			2,
			"followup",
			"previous",
			"patient",
		);
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
		expect(toHqWorkflow("root")).toBe("root");
		expect(toHqWorkflow("module")).toBe("module");
		expect(toHqWorkflow("parent_module")).toBe("parent_module");
		expect(toHqWorkflow("previous")).toBe("previous_screen");
	});
});
