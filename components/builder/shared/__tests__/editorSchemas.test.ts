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
	ancestorPath,
	checkPredicate,
	type Predicate,
	predicateSchema,
	relationStep,
	type SearchInputDecl,
	subcasePath,
	walkTerms,
} from "@/lib/domain/predicate";
import {
	isAuthorablePredicateKind,
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
	caseDataScope: "per-case",
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
			expect(["authorable", "roundTripOnly"]).toContain(entry.authoring);
			expect(entry.label).toBeTruthy();
			expect(entry.icon).toBeTruthy();
			expect(typeof entry.component).toBe("function");
			expect(typeof entry.defaultValue).toBe("function");
			expect(typeof entry.applicable).toBe("function");
		}
	});
});

describe("predicateCardSchemas — authoring boundary", () => {
	it("keeps strict absence editable for round-trip recovery but never authorable", () => {
		expect(predicateCardSchemas["is-null"].authoring).toBe("roundTripOnly");
		expect(isAuthorablePredicateKind("is-null")).toBe(false);
		expect(isAuthorablePredicateKind("is-blank")).toBe(true);
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

	it("does not offer membership when every property is a geopoint", () => {
		const geopointOnly: PredicateEditContext = {
			caseTypes: [
				{
					name: "geo",
					properties: [
						{ name: "location", label: "Location", data_type: "geopoint" },
					],
				},
			],
			currentCaseType: "geo",
			knownInputs: [],
			caseDataScope: "per-case",
		};

		expect(predicateCardSchemas.in.applicable(geopointOnly)).toBe(false);
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

	it("when-input-present requires a search input and a valid child condition", () => {
		const noInputs: PredicateEditContext = { ...ctx, knownInputs: [] };
		const noConditionSeed: PredicateEditContext = {
			caseTypes: [{ name: "patient", properties: [] }],
			currentCaseType: "patient",
			knownInputs: KNOWN_INPUTS,
			caseDataScope: "per-case",
		};
		expect(
			predicateCardSchemas["when-input-present"].applicable(noInputs),
		).toBe(false);
		expect(
			predicateCardSchemas["when-input-present"].applicable(noConditionSeed),
		).toBe(false);
		expect(predicateCardSchemas["when-input-present"].applicable(ctx)).toBe(
			true,
		);
	});

	it("sentinels remain available but empty logical groups do not invent properties", () => {
		const empty: PredicateEditContext = {
			caseTypes: [{ name: "patient", properties: [] }],
			currentCaseType: "patient",
			knownInputs: [],
			caseDataScope: "per-case",
		};
		expect(predicateCardSchemas["match-all"].applicable(empty)).toBe(true);
		expect(predicateCardSchemas["match-none"].applicable(empty)).toBe(true);
		expect(predicateCardSchemas.and.applicable(empty)).toBe(false);
		expect(predicateCardSchemas.or.applicable(empty)).toBe(false);
		expect(predicateCardSchemas.not.applicable(empty)).toBe(false);

		for (const kind of ["and", "or", "not"] as const) {
			const seed = predicateCardSchemas[kind].defaultValue(empty);
			const result = checkPredicate(seed, {
				caseTypes: [...empty.caseTypes],
				knownInputs: [...empty.knownInputs],
				currentCaseType: empty.currentCaseType,
			});
			expect(result.ok, `${kind} direct factory remains valid`).toBe(true);
		}
	});

	it("related-case defaults prefer a declared parent", () => {
		const parentContext: PredicateEditContext = {
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "patient", parent_type: "household", properties: [] },
			],
			currentCaseType: "patient",
			knownInputs: [],
			caseDataScope: "per-case",
		};

		expect(predicateCardSchemas.exists.applicable(parentContext)).toBe(true);
		expect(predicateCardSchemas.missing.applicable(parentContext)).toBe(true);
		expect(predicateCardSchemas.exists.defaultValue(parentContext).via).toEqual(
			ancestorPath(relationStep("parent")),
		);
	});

	it("related-case defaults use the first declared child when there is no parent", () => {
		const childOnlyContext: PredicateEditContext = {
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "patient", parent_type: "household", properties: [] },
			],
			currentCaseType: "household",
			knownInputs: [],
			caseDataScope: "per-case",
		};

		const seed = predicateCardSchemas.exists.defaultValue(childOnlyContext);
		expect(seed.via).toEqual(subcasePath("parent", "patient"));
		const result = checkPredicate(seed, {
			caseTypes: [...childOnlyContext.caseTypes],
			knownInputs: [],
			currentCaseType: childOnlyContext.currentCaseType,
		});
		expect(result.ok).toBe(true);
	});

	it("related-case choices are unavailable when the catalog has no connection", () => {
		const noRelation: PredicateEditContext = {
			caseTypes: [{ name: "patient", properties: [] }],
			currentCaseType: "patient",
			knownInputs: [],
			caseDataScope: "per-case",
		};
		expect(predicateCardSchemas.exists.applicable(noRelation)).toBe(false);
		expect(predicateCardSchemas.missing.applicable(noRelation)).toBe(false);
	});

	it("relation-only scopes seed valid logical and search-answer conditions", () => {
		const relationOnly: PredicateEditContext = {
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "patient", parent_type: "household", properties: [] },
			],
			currentCaseType: "household",
			knownInputs: KNOWN_INPUTS,
			caseDataScope: "per-case",
		};

		for (const kind of ["and", "or", "not", "when-input-present"] as const) {
			expect(predicateCardSchemas[kind].applicable(relationOnly)).toBe(true);
			const result = checkPredicate(
				predicateCardSchemas[kind].defaultValue(relationOnly),
				{
					caseTypes: [...relationOnly.caseTypes],
					knownInputs: [...relationOnly.knownInputs],
					currentCaseType: relationOnly.currentCaseType,
				},
			);
			expect(result.ok, `${kind} relation-only seed`).toBe(true);
		}
	});
});

describe("predicateCardSchemas — global scope (no case selected)", () => {
	// A `"global"` slot (a search input's starting value, the
	// search-button display condition) resolves once, before any case is
	// selected — the commit gate rejects every case-property /
	// relationship read there, so the registry must not offer them.
	const globalCtx: PredicateEditContext = { ...ctx, caseDataScope: "global" };

	it("drops every case-data-dependent kind, whatever the schema holds", () => {
		for (const kind of [
			"lt",
			"lte",
			"gt",
			"gte",
			"between",
			"match",
			"within-distance",
			"multi-select-contains",
			"exists",
			"missing",
		] as const) {
			expect(
				predicateCardSchemas[kind].applicable(globalCtx),
				`${kind} must be unavailable in a global slot`,
			).toBe(false);
		}
	});

	it("keeps session-value kinds available with case-data-free seeds", () => {
		for (const kind of [
			"eq",
			"neq",
			"in",
			"is-blank",
			"and",
			"or",
			"not",
			"match-all",
			"match-none",
		] as const) {
			expect(
				predicateCardSchemas[kind].applicable(globalCtx),
				`${kind} must stay available in a global slot`,
			).toBe(true);
			const seed = predicateCardSchemas[kind].defaultValue(globalCtx);
			// Every global seed must type-check AND read no case data —
			// otherwise the first dispatch bounces off the commit gate.
			let readsCaseData = false;
			walkTerms(seed, (term) => {
				if (term.kind === "prop") readsCaseData = true;
			});
			expect(readsCaseData, `${kind} global seed reads case data`).toBe(false);
			const result = checkPredicate(seed, {
				caseTypes: [...globalCtx.caseTypes],
				knownInputs: [...globalCtx.knownInputs],
				currentCaseType: globalCtx.currentCaseType,
			});
			expect(result.ok, `${kind} global seed type-checks`).toBe(true);
		}
	});

	it("stays available even when the case-type schema is empty", () => {
		// The session values exist regardless of the catalog — a module
		// whose case type has no properties still authors a global rule.
		const emptyGlobal: PredicateEditContext = {
			caseTypes: [{ name: "patient", properties: [] }],
			currentCaseType: "patient",
			knownInputs: [],
			caseDataScope: "global",
		};
		expect(predicateCardSchemas.eq.applicable(emptyGlobal)).toBe(true);
		expect(predicateCardSchemas.and.applicable(emptyGlobal)).toBe(true);
	});
});
