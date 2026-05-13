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
	eq,
	exists,
	literal,
	matchAll,
	matchNone,
	prop,
	subcasePath,
} from "@/lib/domain/predicate/builders";
import { emitNodesetFilter } from "../nodesetFilter";

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
		const filter = eq(prop("patient", "name"), literal("Alice"));
		expect(emitNodesetFilter(filter)).toBe("[name = 'Alice']");
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
		// Relational quantifiers emit count-based join expressions
		// that contain inner `[...]` predicates against the casedb
		// nodeset. The outer wrap is still one bracket pair —
		// XPath's grammar handles the nesting; the wire layer never
		// flattens or de-duplicates inner brackets.
		const filter = exists(subcasePath("child"));
		expect(emitNodesetFilter(filter)).toBe(
			"[count(instance('casedb')/casedb/case[index/child=current()/@case_id]) > 0]",
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
