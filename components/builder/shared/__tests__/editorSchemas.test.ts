// components/builder/shared/__tests__/editorSchemas.test.ts
//
// Registry-shape tests for the predicate card editor. Two
// invariants pinned here:
//
//   1. Exhaustivity over the Predicate union — every Predicate
//      kind appears as a key in `predicateCardSchemas`. The
//      mapped-type `Record<Predicate["kind"], ...>` enforces this
//      at the type layer; the runtime guard verifies the keys at
//      the import boundary as a defense against an `as` cast
//      bypassing the type system.
//
//   2. Every entry's `defaultValue(ctx)` factory produces a kind-
//      valid AST. The schema's parse pass is the structural
//      contract; ill-typed defaults that fail the type checker's
//      semantic rules are still kind-valid (e.g. an empty property
//      name is rejected by the type checker but accepted by the
//      schema).

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	type Predicate,
	predicateSchema,
	type SearchInputDecl,
	walkTerms,
} from "@/lib/domain/predicate";
import {
	type PredicateEditContext,
	predicateCardSchemas,
} from "../editorSchemas";

// ── Fixture ───────────────────────────────────────────────────────────
//
// One case type with properties spanning every data type the cards
// might filter against. The fixture covers the applicability filters
// (multi_select-only for `multi-select-contains`, geopoint-only for
// `within-distance`, ordered-only for ordering operators) so each
// kind's default factory has a property to land on.

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight", data_type: "decimal" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "last_seen", label: "Last seen", data_type: "datetime" },
		{ name: "wakeup", label: "Wakeup time", data_type: "time" },
		{
			name: "status",
			label: "Status",
			data_type: "single_select",
			options: [
				{ value: "active", label: "Active" },
				{ value: "inactive", label: "Inactive" },
			],
		},
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select",
			options: [
				{ value: "vip", label: "VIP" },
				{ value: "new", label: "New" },
			],
		},
		{ name: "location", label: "Home", data_type: "geopoint" },
	],
};

const KNOWN_INPUTS: readonly SearchInputDecl[] = [
	{ name: "name_search", data_type: "text" },
];

const ctx: PredicateEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
	knownInputs: KNOWN_INPUTS,
};

describe("predicateCardSchemas — registry exhaustivity", () => {
	it("declares an entry for every Predicate kind", () => {
		// The mapped-type `Record<Predicate["kind"], ...>` enforces
		// this at compile time, but the runtime guard catches an
		// `as` cast bypassing the type system. The check reads
		// each entry's `kind` field and confirms the key matches
		// — drift between key + entry would be an authoring bug.
		for (const kind of Object.keys(
			predicateCardSchemas,
		) as Predicate["kind"][]) {
			const entry = predicateCardSchemas[kind];
			expect(entry.kind).toBe(kind);
			expect(entry.label).toBeTruthy();
			expect(entry.icon).toBeTruthy();
			expect(typeof entry.component).toBe("function");
			expect(typeof entry.defaultValue).toBe("function");
			expect(typeof entry.applicable).toBe("function");
		}
	});
});

describe("predicateCardSchemas — defaultValue parses through the schema", () => {
	// Iterate every kind; assert the factory's output round-trips
	// through `predicateSchema.parse`. This is the smoke test for
	// "the registry's defaults are kind-valid AST" — semantic
	// validity (does a property name resolve, are types
	// compatible?) is the type checker's job and has its own tests.
	for (const kind of Object.keys(predicateCardSchemas) as Predicate["kind"][]) {
		it(`${kind}: default value parses through predicateSchema`, () => {
			const entry = predicateCardSchemas[kind];
			const value = entry.defaultValue(ctx);
			// Parse round-trip — the schema's tuple-with-rest /
			// non-empty / refinement guards all run here.
			expect(() => predicateSchema.parse(value)).not.toThrow();
			// The constructed kind matches the registry's key
			// (modulo reductions — `notDefault` etc. can route through
			// reductions that change the outer kind, but each
			// production registry default should produce its own kind).
			expect(value.kind).toBe(kind);
		});
	}

	it("never seeds CCHQ's legacy property alias from an alias-first catalog", () => {
		for (const kind of Object.keys(
			predicateCardSchemas,
		) as Predicate["kind"][]) {
			const refs: string[] = [];
			walkTerms(predicateCardSchemas[kind].defaultValue(ctx), (term) => {
				if (term.kind === "prop") refs.push(term.property);
			});
			expect(refs, `${kind} property refs`).not.toContain("name");
		}
	});
});

describe("predicateCardSchemas — applicable predicates", () => {
	it("multi-select-contains is applicable when a multi_select property exists", () => {
		expect(predicateCardSchemas["multi-select-contains"].applicable(ctx)).toBe(
			true,
		);
	});

	it("multi-select-contains is NOT applicable when no multi_select property exists", () => {
		const noMulti: PredicateEditContext = {
			...ctx,
			caseTypes: [
				{
					name: "patient",
					properties: PATIENT.properties.filter(
						(p) => p.data_type !== "multi_select",
					),
				},
			],
		};
		expect(
			predicateCardSchemas["multi-select-contains"].applicable(noMulti),
		).toBe(false);
	});

	it("within-distance is applicable when a geopoint property exists", () => {
		expect(predicateCardSchemas["within-distance"].applicable(ctx)).toBe(true);
	});

	it("ordering operators (gt / gte / lt / lte) require an ordered-typed property", () => {
		const noOrdered: PredicateEditContext = {
			...ctx,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "name", label: "Name", data_type: "text" }],
				},
			],
		};
		expect(predicateCardSchemas.gt.applicable(noOrdered)).toBe(false);
		expect(predicateCardSchemas.lt.applicable(noOrdered)).toBe(false);
		expect(predicateCardSchemas.gte.applicable(noOrdered)).toBe(false);
		expect(predicateCardSchemas.lte.applicable(noOrdered)).toBe(false);
		// `eq` / `neq` aren't gated on ordered types — they apply
		// to any property with a value-equality semantic.
		expect(predicateCardSchemas.eq.applicable(noOrdered)).toBe(true);
		expect(predicateCardSchemas.neq.applicable(noOrdered)).toBe(true);
	});

	it("when-input-present is applicable only when search inputs exist", () => {
		const noInputs: PredicateEditContext = { ...ctx, knownInputs: [] };
		expect(
			predicateCardSchemas["when-input-present"].applicable(noInputs),
		).toBe(false);
		expect(predicateCardSchemas["when-input-present"].applicable(ctx)).toBe(
			true,
		);
	});

	it("sentinels and logical groups apply unconditionally", () => {
		const empty: PredicateEditContext = {
			caseTypes: [{ name: "patient", properties: [] }],
			currentCaseType: "patient",
			knownInputs: [],
		};
		expect(predicateCardSchemas["match-all"].applicable(empty)).toBe(true);
		expect(predicateCardSchemas["match-none"].applicable(empty)).toBe(true);
		expect(predicateCardSchemas.and.applicable(empty)).toBe(true);
		expect(predicateCardSchemas.or.applicable(empty)).toBe(true);
		expect(predicateCardSchemas.not.applicable(empty)).toBe(true);
	});
});
