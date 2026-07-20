// components/builder/shared/__tests__/verbMenuBuildFuzz.test.ts
//
// The valid-by-construction GLUE invariant: the EDITOR's own build
// functions — not just the domain helpers — never produce a
// soundness-invalid AST. `validByConstruction.test.ts` pins the helpers
// + reseed; this file pins the wiring on top of them:
//
//   1. Every verb the menu ADMITS for a given subject, when picked,
//      builds a type-correct predicate (the carried subject + reseeded
//      object). Drives the actual `VERB_ENTRIES` / `STRUCTURE_ENTRIES`
//      with the menu's own admission (`verbEntryAdmitted`), so a future
//      card miswiring (a wrong reseed) fails CI.
//   2. Every registry default factory seeds a type-correct AST for a
//      property of ANY type — the "Add affordances land WORKING
//      entities" rule — so an invalid seed (a text `literal("")`
//      opposite an ordered / non-text property) fails CI too.
//
// Both assert `checkPredicate(...).ok` modulo ONLY the two tolerated
// COMPLETENESS states the editor leaves for the author to fill: an empty
// property name and an empty `match` value. Pure — no React, no DOM.

import { describe, expect, it } from "vitest";
import {
	type CaseProperty,
	type CasePropertyDataType,
	type CaseType,
	casePropertyDataTypes,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	type CheckError,
	checkExpression,
	checkPredicate,
	coalesce,
	dateLiteral,
	datetimeLiteral,
	eq,
	exists,
	input,
	isBlank,
	isIn,
	isNull,
	literal,
	match,
	matchAll,
	matchNone,
	multiSelectAny,
	not,
	or,
	type Predicate,
	predicateSchema,
	prop,
	type ResolvedType,
	relationStep,
	type TypeContext,
	term,
	timeLiteral,
	whenInput,
	within,
} from "@/lib/domain/predicate";
import {
	STRUCTURE_ENTRIES,
	subjectOf,
	VERB_ENTRIES,
	verbEntryAdmitted,
} from "../cards/PredicateVerbMenu";
import {
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateCardSchemas,
} from "../editorSchemas";

// ── Fixtures ───────────────────────────────────────────────────────────

/** One property per data type — a subject of any type is constructible. */
function propOf(dt: CasePropertyDataType): CaseProperty {
	const base: CaseProperty = { name: `p_${dt}`, label: dt, data_type: dt };
	if (dt === "single_select" || dt === "multi_select") {
		return {
			...base,
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
		};
	}
	return base;
}

// A parent + child case type, each carrying one property of every type,
// so relation-walk verbs (`exists` / `missing`) resolve a destination
// AND a subject of any type is available.
const PARENT: CaseType = {
	name: "parent_ct",
	properties: casePropertyDataTypes.map(propOf),
};
const CT: CaseType = {
	name: "ct",
	parent_type: "parent_ct",
	properties: casePropertyDataTypes.map(propOf),
};
const CASE_TYPES = [PARENT, CT];
// One known input so `when-input-present` is admitted + resolves.
const KNOWN_INPUTS = [{ name: "q", data_type: "text" as const }];

const EDIT_CTX: PredicateEditContext = {
	caseTypes: CASE_TYPES,
	currentCaseType: "ct",
	knownInputs: KNOWN_INPUTS,
	caseDataScope: "per-case",
};
const TYPE_CTX: TypeContext = {
	caseTypes: CASE_TYPES,
	currentCaseType: "ct",
	knownInputs: KNOWN_INPUTS,
};

const P = (dt: CasePropertyDataType) => prop("ct", `p_${dt}`);

/** A value compatible with an `eq` against a property of type `dt`. */
function eqValue(dt: CasePropertyDataType) {
	switch (dt) {
		case "int":
			return literal(5);
		case "decimal":
			return literal(1.5);
		case "date":
			return dateLiteral("2024-01-01");
		case "datetime":
			return datetimeLiteral("2024-01-01T00:00");
		case "time":
			return timeLiteral("08:00");
		case "geopoint":
			// No geopoint literal widget — `null` is the only valid literal.
			return literal(null);
		default:
			return literal("x"); // text / single_select / multi_select
	}
}

// Representative CURRENT predicates: an `eq` per subject type, plus one
// of every predicate shape on a fitting subject.
const CURRENTS: Predicate[] = [
	...casePropertyDataTypes.map((dt) => eq(P(dt), eqValue(dt))),
	// Null can sit opposite every scalar type, but list-shaped transitions
	// must replace an all-null candidate because the persisted schemas reject
	// lists with no non-null value.
	eq(P("text"), literal(null)),
	eq(P("multi_select"), literal(null)),
	// A calculated null-only subject resolves to `_any`. Ordered verbs are
	// admitted for it, but their carried object must still be reseeded to an
	// ordered type rather than preserving this text value.
	eq(coalesce(term(literal(null)), term(literal(null))), literal("unordered")),
	// Equality between literals is valid, but absence checks over a direct
	// literal are not meaningful and must stay out of the verb menu.
	eq(literal("same"), literal("same")),
	match(P("text"), term(literal("x")), "fuzzy"),
	match(P("date"), term(literal("x")), "fuzzy-date"),
	isIn(P("int"), literal(1), literal(2)),
	isIn(P("text"), literal("a"), literal("b")),
	isNull(P("text")),
	isBlank(P("text")),
	multiSelectAny(P("multi_select"), literal("a")),
	within(P("geopoint"), literal("12 34"), 5, "miles"),
	and(eq(P("text"), literal("x")), eq(P("int"), literal(5))),
	or(eq(P("text"), literal("x")), eq(P("int"), literal(5))),
	not(eq(P("text"), literal("x"))),
	exists(ancestorPath(relationStep("parent"))),
	whenInput(input("q"), matchAll()),
	matchAll(),
	matchNone(),
];

const ALL_ENTRIES = [...VERB_ENTRIES, ...STRUCTURE_ENTRIES];

/** The two tolerated COMPLETENESS states ("fill this in") — every other
 *  finding is a soundness failure the editor must never author. */
function isCompletenessOnly(errors: readonly CheckError[]): boolean {
	return errors.every(
		(e) =>
			e.code === "match-value-empty" || // empty match value
			e.code === "unknown-property", // empty property name in these seeds
	);
}

function describeFindings(errors: readonly CheckError[]): string {
	return errors.map((e) => e.message).join(" | ");
}

function subjectTypeOf(p: Predicate): ResolvedType | undefined {
	const s = subjectOf(p);
	if (s === undefined) return undefined;
	return checkExpression(s, TYPE_CTX, [], []);
}

// ── 1. Verb-menu builds ────────────────────────────────────────────────

describe("valid by construction — every admitted verb build type-checks", () => {
	it("no admitted verb pick yields a soundness-invalid AST", () => {
		for (const current of CURRENTS) {
			// The editor only ever opens a valid tree — pin that the
			// fixtures are themselves schema-valid and type-valid before
			// transitioning from them.
			expect(
				predicateSchema.safeParse(current).success,
				`fixture current does not parse: ${current.kind}`,
			).toBe(true);
			expect(
				checkPredicate(current, TYPE_CTX).ok,
				`fixture current is invalid: ${current.kind}`,
			).toBe(true);
			const subjectType = subjectTypeOf(current);
			for (const entry of ALL_ENTRIES) {
				if (!verbEntryAdmitted(entry, current, subjectType, EDIT_CTX)) continue;
				const next = entry.build(current, EDIT_CTX);
				expect(
					predicateSchema.safeParse(next).success,
					`${entry.id} from ${current.kind} produced a schema-invalid AST`,
				).toBe(true);
				const result = checkPredicate(next, TYPE_CTX);
				if (result.ok) continue;
				expect(
					isCompletenessOnly(result.errors),
					`${entry.id} from ${current.kind}: ${describeFindings(result.errors)}`,
				).toBe(true);
			}
		}
	});

	it("admits verbs from a related-property subject by its destination type", () => {
		const origin: CaseType = {
			name: "child",
			parent_type: "parent",
			properties: [{ name: "rank", label: "Rank", data_type: "int" }],
		};
		const destination: CaseType = {
			name: "parent",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{
					name: "tags",
					label: "Tags",
					data_type: "multi_select",
					options: [{ value: "a", label: "A" }],
				},
				{ name: "place", label: "Place", data_type: "geopoint" },
			],
		};
		const editCtx: PredicateEditContext = {
			caseTypes: [origin, destination],
			currentCaseType: "child",
			knownInputs: [],
			caseDataScope: "per-case",
		};
		const typeCtx: TypeContext = {
			caseTypes: [origin, destination],
			currentCaseType: "child",
			knownInputs: [],
		};
		const via = ancestorPath(relationStep("parent", "parent"));
		const cases: ReadonlyArray<{
			current: Predicate;
			entryId: string;
			expectedKind: Predicate["kind"];
		}> = [
			{
				current: eq(prop("child", "name", via), literal("A")),
				entryId: "match:starts-with",
				expectedKind: "match",
			},
			{
				current: eq(prop("child", "tags", via), literal("a")),
				entryId: "msc:any",
				expectedKind: "multi-select-contains",
			},
			{
				current: eq(prop("child", "place", via), literal(null)),
				entryId: "within-distance",
				expectedKind: "within-distance",
			},
		];

		for (const fixture of cases) {
			const entry = VERB_ENTRIES.find(
				(candidate) => candidate.id === fixture.entryId,
			);
			if (entry === undefined) throw new Error(`Missing ${fixture.entryId}`);
			const subject = subjectOf(fixture.current);
			if (subject === undefined) throw new Error("Expected a sentence subject");
			const subjectType = checkExpression(subject, typeCtx, [], []);
			expect(
				verbEntryAdmitted(entry, fixture.current, subjectType, editCtx),
				fixture.entryId,
			).toBe(true);
			const next = entry.build(fixture.current, editCtx);
			expect(next.kind).toBe(fixture.expectedKind);
			expect(predicateSchema.safeParse(next).success).toBe(true);
			expect(checkPredicate(next, typeCtx).ok).toBe(true);
		}
	});

	it("keeps strict absence recovery-only instead of authoring an unexportable edit", () => {
		const entry = VERB_ENTRIES.find((candidate) => candidate.id === "is-null");
		if (entry === undefined) throw new Error("Missing strict absence verb");
		const current = isNull(P("text"));
		const ordinary = eq(P("text"), literal("saved"));

		expect(
			verbEntryAdmitted(entry, current, subjectTypeOf(current), EDIT_CTX),
		).toBe(true);
		expect(
			verbEntryAdmitted(entry, ordinary, subjectTypeOf(ordinary), EDIT_CTX),
		).toBe(false);
		expect(predicateCardSchemas["is-null"].authoring).toBe("roundTripOnly");
	});

	it("does not admit an absence check for a direct literal subject", () => {
		const entry = VERB_ENTRIES.find((candidate) => candidate.id === "is-blank");
		if (entry === undefined) throw new Error("Missing blank verb");
		const current = eq(literal("same"), literal("same"));

		expect(
			verbEntryAdmitted(entry, current, subjectTypeOf(current), EDIT_CTX),
		).toBe(false);
	});
});

// ── 2. Registry default seeds ──────────────────────────────────────────

describe("valid by construction — every registry default seeds a valid AST", () => {
	it("a default factory lands type-correct for a property of ANY first type", () => {
		// Vary which type is FIRST so the kinds that anchor on the first /
		// first-ordered property (comparison / membership / range) seed
		// against every data type — the seed must match the property's own
		// type, never a stray text `literal("")`.
		for (const firstType of casePropertyDataTypes) {
			const ordered = [
				firstType,
				...casePropertyDataTypes.filter((t) => t !== firstType),
			];
			const ct: CaseType = {
				name: "ct",
				parent_type: "parent_ct",
				properties: ordered.map(propOf),
			};
			const editCtx: PredicateEditContext = {
				caseTypes: [PARENT, ct],
				currentCaseType: "ct",
				knownInputs: KNOWN_INPUTS,
				caseDataScope: "per-case",
			};
			const typeCtx: TypeContext = {
				caseTypes: [PARENT, ct],
				currentCaseType: "ct",
				knownInputs: KNOWN_INPUTS,
			};
			for (const schema of predicateCardSchemaList) {
				// Only the kinds the editor would actually offer here.
				if (schema.authoring !== "authorable" || !schema.applicable(editCtx)) {
					continue;
				}
				const seed = schema.defaultValue(editCtx);
				expect(
					predicateSchema.safeParse(seed).success,
					`${schema.kind} default (first=${firstType}) does not parse`,
				).toBe(true);
				const result = checkPredicate(seed, typeCtx);
				if (result.ok) continue;
				expect(
					isCompletenessOnly(result.errors),
					`${schema.kind} default (first=${firstType}): ${describeFindings(result.errors)}`,
				).toBe(true);
			}
		}
	});
});
