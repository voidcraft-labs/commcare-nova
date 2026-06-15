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
			/cannot be the empty string/.test(e.message) || // empty match value
			/Unknown property ''/.test(e.message), // empty property name
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
			// fixtures are themselves valid before transitioning from them.
			expect(
				checkPredicate(current, TYPE_CTX).ok,
				`fixture current is invalid: ${current.kind}`,
			).toBe(true);
			const subjectType = subjectTypeOf(current);
			for (const entry of ALL_ENTRIES) {
				if (!verbEntryAdmitted(entry, current, subjectType, EDIT_CTX)) continue;
				const next = entry.build(current, EDIT_CTX);
				const result = checkPredicate(next, TYPE_CTX);
				if (result.ok) continue;
				expect(
					isCompletenessOnly(result.errors),
					`${entry.id} from ${current.kind}: ${describeFindings(result.errors)}`,
				).toBe(true);
			}
		}
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
			};
			const typeCtx: TypeContext = {
				caseTypes: [PARENT, ct],
				currentCaseType: "ct",
				knownInputs: KNOWN_INPUTS,
			};
			for (const schema of predicateCardSchemaList) {
				// Only the kinds the editor would actually offer here.
				if (!schema.applicable(editCtx)) continue;
				const seed = schema.defaultValue(editCtx);
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
