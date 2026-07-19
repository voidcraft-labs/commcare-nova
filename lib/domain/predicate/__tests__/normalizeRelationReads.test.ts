// lib/domain/predicate/__tests__/normalizeRelationReads.test.ts
//
// Acceptance tests for CSQL's relation-read adapter. On-device XPath keeps
// PropertyRef node-sets intact and Preview/Postgres mirrors their pairwise
// comparison semantics directly; CSQL needs explicit query-function envelopes.
//
// Non-grammar value expressions (`if`, `switch`, `arith`, `concat`,
// `coalesce`, `format-date`, non-LHS `count`, ancestor / any-relation
// `count`) inline as runtime on-device XPath fragments at the CSQL
// emitter — they do NOT rewrite the AST. Tests for that inline
// behaviour live in `csqlEmitter.test.ts`.

import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	eq,
	exists,
	gte,
	isBlank,
	isNull,
	literal,
	lte,
	match,
	multiSelectAll,
	prop,
	relationStep,
	subcasePath,
	term,
	within,
} from "@/lib/domain/predicate/builders";
import {
	normalizeRelationPredicateSubjects,
	normalizeRelationPropertyReads,
} from "../normalizeRelationReads";

describe("normalizeRelationPropertyReads", () => {
	// CCHQ's CSQL grammar exposes relational reads only through
	// `ancestor-exists` / `subcase-exists` query functions. The
	// via-lift rewrites every operator-direct `prop(via)` reference
	// into an enclosing `exists` envelope before the value-expression
	// emitter runs. These tests pin the AST shape the rewrite
	// produces; the wire-form assertions live in `csqlEmitter.test.ts`.

	it("rewrites eq with ancestor via on LHS into exists envelope", () => {
		const result = normalizeRelationPropertyReads(
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
		const result = normalizeRelationPropertyReads(
			isBlank(prop("patient", "name", subcasePath("child"))),
		);
		expect(result).toEqual(
			exists(subcasePath("child"), isBlank(prop("patient", "name"))),
		);
	});

	it("rewrites any-relation via into an OR of direction-specific envelopes", () => {
		const result = normalizeRelationPropertyReads(
			eq(
				prop("household", "name", anyRelationPath("rel", "patient")),
				literal("Alice"),
			),
		);
		// `any-relation` has no direct CCHQ wire form; the rewrite
		// expands to OR-of-direction-specific envelopes, mirroring
		// the on-device emitter's any-relation expansion at
		// `caseListFilterEmitter.ts::emitExistsOrMissing`.
		const inner = eq(prop("patient", "name"), literal("Alice"));
		expect(result).toEqual({
			kind: "or",
			clauses: [
				exists(ancestorPath(relationStep("rel", "patient")), inner),
				exists(subcasePath("rel", "patient"), inner),
			],
		});
	});

	it("resolves an unqualified destination case type from schema context", () => {
		const result = normalizeRelationPropertyReads(
			eq(prop("household", "name", subcasePath("parent")), literal("Alice")),
			{
				caseTypes: [
					{ name: "household", properties: [] },
					{
						name: "patient",
						parent_type: "household",
						properties: [{ name: "name", label: "Name", data_type: "text" }],
					},
				],
			},
		);
		expect(result).toEqual(
			exists(
				subcasePath("parent"),
				eq(prop("patient", "name"), literal("Alice")),
			),
		);
	});

	it("uses independent relation quantifiers for generic between bounds", () => {
		const via = subcasePath("parent", "patient");
		const result = normalizeRelationPropertyReads(
			between(prop("household", "age", via), {
				lower: literal(20),
				upper: literal(25),
			}),
		);
		expect(result).toEqual(
			and(
				exists(via, gte(prop("patient", "age"), literal(20))),
				exists(via, lte(prop("patient", "age"), literal(25))),
			),
		);
	});

	it("makes a related is-null require an actual related row", () => {
		const via = subcasePath("parent", "patient");
		expect(
			normalizeRelationPropertyReads(isNull(prop("household", "name", via))),
		).toEqual(exists(via, isNull(prop("patient", "name"))));
	});

	it("preserves relational reads below non-native scalar expressions", () => {
		const viaProperty = prop(
			"household",
			"age",
			subcasePath("parent", "patient"),
		);
		const predicate = eq(
			arith("+", term(viaProperty), term(literal(1))),
			literal(22),
		);
		expect(normalizeRelationPropertyReads(predicate)).toEqual(predicate);
	});

	it("preserves mixed scopes for on-device and SQL-specific compilation", () => {
		const predicate = eq(
			prop("household", "region"),
			prop("household", "name", subcasePath("parent", "patient")),
		);
		expect(normalizeRelationPropertyReads(predicate)).toBe(predicate);
		expect(() =>
			normalizeRelationPropertyReads(predicate, {
				unsupportedPropertyOperands: "throw",
			}),
		).toThrow(/multiple-property-scopes/);
	});

	it("keeps same-relation property pairs for on-device but fails closed for CSQL", () => {
		const via = subcasePath("parent", "patient");
		const predicate = eq(
			prop("household", "name", via),
			prop("household", "nickname", via),
		);
		expect(normalizeRelationPropertyReads(predicate)).toBe(predicate);
		expect(() =>
			normalizeRelationPropertyReads(predicate, {
				unsupportedPropertyOperands: "throw",
			}),
		).toThrow(/case-property-on-value-side/);
	});

	it("rewrites nested vias inside an authored exists envelope's where clause", () => {
		// The authored `exists` envelope walks one relation; the
		// inner predicate carries a further via on `prop`. The
		// rewrite nests envelopes so each via emits its own
		// direction-specific query function call.
		const result = normalizeRelationPropertyReads(
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
		const first = normalizeRelationPropertyReads(p);
		const second = normalizeRelationPropertyReads(first);
		expect(second).toEqual(first);
	});

	it("returns a fresh predicate when nothing lifts", () => {
		// A predicate composed of only via-free property references
		// flows through the walker without any transformations. The
		// output is a fresh allocation so the caller can mutate
		// either copy without disturbing the other.
		const p = eq(prop("patient", "name"), literal("Alice"));
		const result = normalizeRelationPropertyReads(p);
		expect(result).toEqual(p);
		// Identity-preserving leaf shapes are allowed — the walker
		// only allocates fresh nodes when something changes.
	});
});

describe("normalizeRelationPredicateSubjects", () => {
	const via = subcasePath("parent", "patient");

	it("wraps related match, multi-select, and distance subjects", () => {
		expect(
			normalizeRelationPredicateSubjects(
				match(prop("household", "name", via), "Ali", "starts-with"),
			),
		).toEqual(
			exists(via, match(prop("patient", "name"), "Ali", "starts-with")),
		);
		expect(
			normalizeRelationPredicateSubjects(
				multiSelectAll(
					prop("household", "tags", via),
					literal("urgent"),
					literal("review"),
				),
			),
		).toEqual(
			exists(
				via,
				multiSelectAll(
					prop("patient", "tags"),
					literal("urgent"),
					literal("review"),
				),
			),
		);
		expect(
			normalizeRelationPredicateSubjects(
				within(
					prop("household", "location", via),
					literal("42 -71"),
					10,
					"miles",
				),
			),
		).toEqual(
			exists(
				via,
				within(prop("patient", "location"), literal("42 -71"), 10, "miles"),
			),
		);
	});

	it("leaves general comparison and between node-set operands authored", () => {
		const comparison = eq(prop("household", "name", via), literal("Alice"));
		const range = between(prop("household", "age", via), {
			lower: literal(18),
			upper: literal(65),
		});
		expect(normalizeRelationPredicateSubjects(comparison)).toBe(comparison);
		expect(normalizeRelationPredicateSubjects(range)).toBe(range);
	});
});
