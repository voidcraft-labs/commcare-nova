// lib/commcare/predicate/__tests__/csqlHoist.test.ts
//
// Acceptance tests for the property-via lift pass — the only
// AST-rewrite phase that runs before CSQL emission. CCHQ's CSQL
// grammar exposes relational reads ONLY through the
// `ancestor-exists` / `subcase-exists` query functions registered on
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`;
// every operator-direct `prop(via)` reference rewrites into an
// enclosing `exists` envelope before the CSQL emitter walks the
// result.
//
// Non-grammar value expressions (`if`, `switch`, `arith`, `concat`,
// `coalesce`, `format-date`, non-LHS `count`, ancestor / any-relation
// `count`) inline as runtime on-device XPath fragments at the CSQL
// emitter — they do NOT rewrite the AST. Tests for that inline
// behaviour live in `csqlEmitter.test.ts`.

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	anyRelationPath,
	eq,
	exists,
	isBlank,
	literal,
	prop,
	relationStep,
	subcasePath,
} from "@/lib/domain/predicate/builders";
import { liftPropertyVias } from "../csqlHoist";

describe("liftPropertyVias — property-via lift (AST shape)", () => {
	// CCHQ's CSQL grammar exposes relational reads only through
	// `ancestor-exists` / `subcase-exists` query functions. The
	// via-lift rewrites every operator-direct `prop(via)` reference
	// into an enclosing `exists` envelope before the value-expression
	// emitter runs. These tests pin the AST shape the rewrite
	// produces; the wire-form assertions live in `csqlEmitter.test.ts`.

	it("rewrites eq with ancestor via on LHS into exists envelope", () => {
		const result = liftPropertyVias(
			eq(
				prop("patient", "name", ancestorPath(relationStep("parent"))),
				literal("Alice"),
			),
		);
		// The outer predicate is an `exists` with the via attached;
		// the inner `where` carries the same comparison shape with
		// the property's via stripped.
		expect(result).toEqual(
			exists(
				ancestorPath(relationStep("parent")),
				eq(prop("patient", "name"), literal("Alice")),
			),
		);
	});

	it("rewrites is-blank with subcase via on its left operand into exists envelope", () => {
		const result = liftPropertyVias(
			isBlank(prop("patient", "name", subcasePath("child"))),
		);
		expect(result).toEqual(
			exists(subcasePath("child"), isBlank(prop("patient", "name"))),
		);
	});

	it("rewrites any-relation via into an OR of direction-specific envelopes", () => {
		const result = liftPropertyVias(
			eq(prop("patient", "name", anyRelationPath("rel")), literal("Alice")),
		);
		// `any-relation` has no direct CCHQ wire form; the rewrite
		// expands to OR-of-direction-specific envelopes, mirroring
		// the on-device emitter's any-relation expansion at
		// `caseListFilterEmitter.ts::emitExistsOrMissing`.
		const inner = eq(prop("patient", "name"), literal("Alice"));
		expect(result).toEqual({
			kind: "or",
			clauses: [
				exists(ancestorPath(relationStep("rel")), inner),
				exists(subcasePath("rel"), inner),
			],
		});
	});

	it("rewrites nested vias inside an authored exists envelope's where clause", () => {
		// The authored `exists` envelope walks one relation; the
		// inner predicate carries a further via on `prop`. The
		// rewrite nests envelopes so each via emits its own
		// direction-specific query function call.
		const result = liftPropertyVias(
			exists(
				subcasePath("child"),
				eq(
					prop("child", "label", ancestorPath(relationStep("parent"))),
					literal("Alice"),
				),
			),
		);
		expect(result).toEqual(
			exists(
				subcasePath("child"),
				exists(
					ancestorPath(relationStep("parent")),
					eq(prop("child", "label"), literal("Alice")),
				),
			),
		);
	});

	it("is idempotent — second pass produces the same AST", () => {
		const p = eq(
			prop("patient", "name", ancestorPath(relationStep("parent"))),
			literal("Alice"),
		);
		const first = liftPropertyVias(p);
		const second = liftPropertyVias(first);
		expect(second).toEqual(first);
	});

	it("returns a fresh predicate when nothing lifts", () => {
		// A predicate composed of only via-free property references
		// flows through the walker without any transformations. The
		// output is a fresh allocation so the caller can mutate
		// either copy without disturbing the other.
		const p = eq(prop("patient", "name"), literal("Alice"));
		const result = liftPropertyVias(p);
		expect(result).toEqual(p);
		// Identity-preserving leaf shapes are allowed — the walker
		// only allocates fresh nodes when something changes.
	});
});
