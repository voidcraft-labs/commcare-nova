// lib/commcare/suite/case-list/__tests__/nodesetFilter.test.ts
//
// Acceptance tests for `emitNodesetFilter` — the wire-emission
// helper that produces the bracketed XPath fragment appending to
// a case-loading entry's session-datum nodeset.
//
// Coverage organizes around three shells:
//
//   1. Empty-fragment shapes — absent filter and `match-all`
//      collapse to the empty string. The surrounding session
//      datum's nodeset stays at the canonical
//      `[@case_type='X'][@status='open']` shape with no third
//      bracket appended.
//   2. Real predicate emissions — single-clause comparisons,
//      logical compositions, and reserved attribute references
//      route through the shared on-device emitter. Each test
//      pins both the inner XPath (the on-device emitter's
//      contract) and the bracket wrapping this layer adds.
//   3. `match-none` emits faithfully — the literal `[false()]`
//      fragment so the case list reflects the authored "match
//      no cases" intent rather than silently widening to every
//      case.
//
// One integration test composes the full session-datum nodeset
// (case-type / status / filter) and pins it against the CCHQ
// canonical shape produced by
// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`.
// The CCHQ fixture at
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/suite-advanced-details.xml::<entry>/<session>/<datum id="case_id_case_clinic">`
// shows the bare `[@case_type][@status]` baseline; the user-
// filter path follows by concatenating the bracketed predicate
// fragment after.

import { describe, expect, it } from "vitest";
import {
	and,
	concat,
	eq,
	exists,
	input,
	literal,
	matchAll,
	matchNone,
	prop,
	sessionUser,
	subcasePath,
	term,
	whenInput,
} from "@/lib/domain/predicate/builders";
import {
	emitExcludedOwnerFilterExpression,
	emitExcludedOwnerNodesetFilter,
	emitNodesetFilter,
} from "../nodesetFilter";

// ============================================================
// SHELL 1 — Empty-fragment shapes
// ============================================================

describe("emitNodesetFilter — absent / match-all collapse", () => {
	it("returns empty string when filter is undefined", () => {
		// Most modules carry no `caseListConfig.filter`; the session-
		// datum nodeset stays at the bare `[@case_type][@status]`
		// shape with no third bracket appended.
		expect(emitNodesetFilter(undefined)).toBe("");
	});

	it("returns empty string for the match-all sentinel", () => {
		// `match-all` is the AND-chain identity; appending
		// `[true()]` to the nodeset would leave the match set
		// unchanged. The cleaner wire form omits the bracket pair.
		expect(emitNodesetFilter(matchAll())).toBe("");
	});

	it("returns empty string when an authored and reduces to match-all", () => {
		// `and(match-all, match-all)` is still the identity — normalized
		// away so no tautological `[true() and true()]` bracket appends.
		expect(emitNodesetFilter(and(matchAll(), matchAll()))).toBe("");
	});

	it("drops a match-all nested inside an authored and, keeping only the real clause", () => {
		// `and(match-all, eq)` ≡ `eq` — the nested identity must vanish so
		// the nodeset reads `[age = 18]`, not `[true() and age = 18]`.
		const filter = and(matchAll(), eq(prop("patient", "age"), literal(18)));
		expect(emitNodesetFilter(filter)).toBe("[age = 18]");
	});
});

// ============================================================
// SHELL 2 — Real predicate emissions
// ============================================================

describe("emitNodesetFilter — predicate compilation", () => {
	it("wraps a comparison predicate in a single bracket pair", () => {
		// The simplest non-trivial filter: equality against a
		// numeric literal. The shared on-device emitter produces
		// `age = 18`; this layer wraps in `[...]` so the result
		// drops directly onto the nodeset.
		const filter = eq(prop("patient", "age"), literal(18));
		expect(emitNodesetFilter(filter)).toBe("[age = 18]");
	});

	it("wraps a string-literal comparison preserving the quoted value", () => {
		// String-literal escape lives in the shared emitter; this
		// layer's contract is just the bracket wrap.
		const filter = eq(prop("patient", "full_name"), literal("Alice"));
		expect(emitNodesetFilter(filter)).toBe("[full_name = 'Alice']");
	});

	it("wraps a compound logical expression as one bracket", () => {
		// Compound predicates compile to a single XPath string;
		// the bracket pair stays a single pair regardless of
		// internal logical structure.
		const filter = and(
			eq(prop("patient", "age"), literal(18)),
			eq(prop("patient", "region"), literal("south")),
		);
		expect(emitNodesetFilter(filter)).toBe("[age = 18 and region = 'south']");
	});

	it("wraps a relational-walk predicate that emits its own brackets internally", () => {
		// Relational quantifiers collect matching destination ids and use
		// selected-token membership against the immediate candidate. This is
		// safe when nested: CommCare Core preserves `current()` from the first
		// predicate forever, so the older `index= current()/@case_id` shape
		// silently re-anchored inner walks to the original list case. The outer
		// wrap remains one bracket pair around the complete membership test.
		const filter = exists(subcasePath("child"));
		expect(emitNodesetFilter(filter)).toBe(
			"[count(@case_id) > 0 and selected(join(' ', instance('casedb')/casedb/case[true()]/index/child), @case_id)]",
		);
	});

	it("leaves the inner emitter free to reference reserved case attributes", () => {
		// Reserved attribute prefixing (`@case_type`, `@status`,
		// etc.) lives in the term emitter. This layer doesn't touch
		// the inner string — it just adds the bracket wrap.
		const filter = eq(prop("patient", "owner_id"), literal("user123"));
		expect(emitNodesetFilter(filter)).toBe("[@owner_id = 'user123']");
	});
});

// ============================================================
// SHELL 3 — match-none faithful emission
// ============================================================

describe("emitNodesetFilter — match-none", () => {
	it("emits the literal [false()] fragment for the match-none sentinel", () => {
		// `match-none` is the boolean-algebra absorbing element of
		// conjunction; the authored intent is "match no cases".
		// Collapsing it to the empty fragment would silently widen
		// the match set to every case, contradicting the AST. The
		// wire `[false()]` is the closest CCHQ shape that
		// preserves the authored emptiness.
		expect(emitNodesetFilter(matchNone())).toBe("[false()]");
	});
});

// ============================================================
// SHELL 4 — Filter precedence integration
// ============================================================

describe("emitNodesetFilter — filter precedence on the full nodeset", () => {
	it("appends after [@case_type][@status] to match the CCHQ canonical shape", () => {
		// Pins the full nodeset shape the session-datum builder
		// produces when both case-type / status and filter are
		// present. CCHQ's
		// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`
		// composes the same string by concatenating
		// `[<case_type>]` / `[@status='open']` / `[<filter>]` in
		// that order; this test verifies Nova produces the identical
		// shape.
		const filter = eq(prop("patient", "is_priority"), literal(true));
		const baseNodeset =
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open']";
		const filterFragment = emitNodesetFilter(filter);
		const fullNodeset = `${baseNodeset}${filterFragment}`;
		expect(fullNodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='patient'][@status='open'][is_priority = 'true']",
		);
	});

	it("leaves the bare nodeset shape untouched when the filter is absent", () => {
		// The absent-filter path produces the canonical bare shape
		// — same string the existing CCHQ fixture
		// `suite-advanced-details.xml::<entry>/<session>/<datum id="case_id_case_clinic">`
		// uses for its case-loading entries.
		const baseNodeset =
			"instance('casedb')/casedb/case[@case_type='clinic'][@status='open']";
		const fullNodeset = `${baseNodeset}${emitNodesetFilter(undefined)}`;
		expect(fullNodeset).toBe(
			"instance('casedb')/casedb/case[@case_type='clinic'][@status='open']",
		);
	});
});

describe("owner exclusion on the ordinary case-list nodeset", () => {
	it("guards blank globally-resolved values before checking owner membership", () => {
		const excludedOwners = term(literal("owner-a owner-b"));

		expect(emitExcludedOwnerFilterExpression(excludedOwners)).toBe(
			"normalize-space('owner-a owner-b') = '' or not(selected(normalize-space('owner-a owner-b'), @owner_id))",
		);
		expect(emitExcludedOwnerNodesetFilter(excludedOwners)).toBe(
			"[normalize-space('owner-a owner-b') = '' or not(selected(normalize-space('owner-a owner-b'), @owner_id))]",
		);
	});

	it.each(["", "   \t  "])(
		"emits no fragment when the exclusion value is statically blank (%j)",
		(value) => {
			// Blank means "exclude nobody" — the runtime guard's identity arm,
			// resolved statically. Emitting the guarded `selected()` test for a
			// literal blank would be a tautological bracket on every row.
			expect(emitExcludedOwnerFilterExpression(term(literal(value)))).toBe(
				undefined,
			);
			expect(emitExcludedOwnerNodesetFilter(term(literal(value)))).toBe("");
		},
	);

	it("normalizes repeated, trailing, and tab whitespace before membership", () => {
		const value = "owner-a  owner-b\t ";
		const literalXpath = `'${value}'`;
		expect(emitExcludedOwnerFilterExpression(term(literal(value)))).toBe(
			`normalize-space(${literalXpath}) = '' or not(selected(normalize-space(${literalXpath}), @owner_id))`,
		);
	});

	it("guards a runtime session value that may resolve blank", () => {
		const xpath =
			"instance('commcaresession')/session/user/data/excluded_owner_ids";
		expect(
			emitExcludedOwnerFilterExpression(
				term(sessionUser("excluded_owner_ids")),
			),
		).toBe(
			`normalize-space(${xpath}) = '' or not(selected(normalize-space(${xpath}), @owner_id))`,
		);
	});

	it("omits the owner predicate when no exclusion expression is authored", () => {
		expect(emitExcludedOwnerFilterExpression(undefined)).toBeUndefined();
		expect(emitExcludedOwnerNodesetFilter(undefined)).toBe("");
	});
});

// ============================================================
// SHELL 5 — Unanswered-Search substitution
// ============================================================
//
// The ordinary case-list nodeset evaluates before any Search runs.
// Core resolves `instance('search-input:results')` on such an entry
// to a declared-but-unloaded instance and throws
// `XPathMissingInstanceException` from `XPathPathExpr.evalRaw` the
// moment ANY expression references it — before `normalize-space(...)
// = ''` or `if(count(...))` guards can evaluate. Both ordinary-list
// emitters therefore substitute the unanswered reading statically:
// no instance reference may survive on this wire surface.

describe("unanswered-Search substitution on the ordinary nodeset", () => {
	it("emits no owner fragment for a pure Search-answer exclusion", () => {
		// `input(...)` reads blank before Search; blank means "exclude
		// nobody", so the entire fragment collapses away instead of
		// referencing the unloaded search-input instance.
		const exclusion = term(input("excluded_owners"));
		expect(emitExcludedOwnerFilterExpression(exclusion)).toBeUndefined();
		expect(emitExcludedOwnerNodesetFilter(exclusion)).toBe("");
	});

	it("keeps non-Search arms of a composite exclusion, blanking the input ref", () => {
		// `concat(input(...), ' ', session-user)` — the Search arm reads
		// blank; the session arm is real at ordinary-list evaluation time
		// and must survive.
		const exclusion = concat(
			term(input("excluded_owners")),
			term(literal(" ")),
			term(sessionUser("excluded_owner_ids")),
		);
		const emitted = emitExcludedOwnerFilterExpression(exclusion);
		expect(emitted).toBe(
			"normalize-space(concat('', ' ', instance('commcaresession')/session/user/data/excluded_owner_ids)) = '' or not(selected(normalize-space(concat('', ' ', instance('commcaresession')/session/user/data/excluded_owner_ids)), @owner_id))",
		);
		expect(emitted).not.toContain("search-input:results");
	});

	it("collapses a when-input-present envelope in the filter to its unanswered arm", () => {
		// The envelope's clause only applies once the input is answered;
		// on the ordinary list that is never, so only the always-on
		// conjunct survives — with no `if(count(instance(...)))` guard
		// left to crash the entry.
		const filter = and(
			whenInput(
				input("name_query"),
				eq(prop("patient", "full_name"), term(input("name_query"))),
			),
			eq(prop("patient", "is_priority"), literal(true)),
		);
		expect(emitNodesetFilter(filter)).toBe("[is_priority = 'true']");
	});

	it("emits no bracket when the filter is only an envelope", () => {
		const filter = whenInput(
			input("name_query"),
			eq(prop("patient", "full_name"), term(input("name_query"))),
		);
		expect(emitNodesetFilter(filter)).toBe("");
	});

	it("does not mutate the authored filter AST", () => {
		const filter = whenInput(
			input("name_query"),
			eq(prop("patient", "full_name"), term(input("name_query"))),
		);
		const snapshot = structuredClone(filter);
		emitNodesetFilter(filter);
		expect(filter).toEqual(snapshot);
	});
});
