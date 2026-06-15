// Pins the custom-condition conversion contract: picking "Custom
// Condition" on a search input must land a predicate the commit gate
// ACCEPTS, and converting back must recover the property it was
// anchored on.
//
// The bug this guards against: the seed compared the property to the
// typed value with a BARE `input(...)` ref. A bare search-input ref in
// a wire-emission-bound slot resolves to the empty string before
// anyone searches, so the validator (`CASE_LIST_BARE_SEARCH_INPUT_REF`,
// `requires-envelope` mode) rejects it — the conversion failed the
// moment it was chosen ("Change not applied"). The seed now wraps the
// comparison in the same `when-input-present` envelope the standard
// match modes derive at wire-emit (`deriveSimpleArmPredicate`), which
// the rule's own test proves the gate accepts.

import { describe, expect, it } from "vitest";
import { asUuid, type CaseType, simpleSearchInputDef } from "@/lib/domain";
import {
	ancestorPath,
	checkPredicate,
	eq,
	input,
	literal,
	matchAll,
	prop,
	relationStep,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import {
	recoverAnchoredProperty,
	searchInputDecls,
	seedCustomCondition,
} from "../searchInputResolution";

const CASE_TYPE = "household";

const CASE_TYPES: CaseType[] = [
	{
		name: "household",
		properties: [{ name: "case_name", label: "Name", data_type: "text" }],
	} as CaseType,
];

describe("seedCustomCondition", () => {
	it("wraps an input-bound comparison in a when-input-present envelope", () => {
		// The exact shape from the screenshot: one text search on
		// `case_name`, reference name `case_name`.
		const row = simpleSearchInputDef(
			asUuid("si-1"),
			"case_name",
			"Name",
			"text",
			"case_name",
		);
		const seeded = seedCustomCondition(row, CASE_TYPE);

		// Top-level is the envelope, NOT a bare comparison — this is the
		// difference between a gate rejection and a clean commit.
		expect(seeded.kind).toBe("when-input-present");
		// Byte-for-byte the canonical shape the standard "exact" mode
		// derives at wire-emit, so what the gate already proves valid is
		// exactly what the seed produces.
		expect(seeded).toEqual(
			whenInput(
				input("case_name"),
				eq(prop(CASE_TYPE, "case_name"), input("case_name")),
			),
		);
	});

	it("seeds a nameless row against a literal, carrying no input ref", () => {
		// A row the author hasn't named yet has no input to gate on; the
		// comparison reads against an empty literal and needs no envelope.
		const row = simpleSearchInputDef(
			asUuid("si-1"),
			"",
			"Name",
			"text",
			"case_name",
		);
		const seeded = seedCustomCondition(row, CASE_TYPE);

		expect(seeded).toEqual(eq(prop(CASE_TYPE, "case_name"), term(literal(""))));
	});

	it("seeds an unbound row as match-all", () => {
		const row = simpleSearchInputDef(
			asUuid("si-1"),
			"case_name",
			"Name",
			"text",
			"",
		);
		expect(seedCustomCondition(row, CASE_TYPE)).toEqual(matchAll());
	});

	it("preserves a parent-case walk in the seeded property ref", () => {
		// A row bound to a parent property keeps its relation walk, so
		// the seed reads the property on the case it actually searches —
		// not on the current case type, which may not even declare it.
		const via = ancestorPath(relationStep("parent"));
		const row = simpleSearchInputDef(
			asUuid("si-1"),
			"region",
			"Region",
			"text",
			"region",
			{ via },
		);
		const seeded = seedCustomCondition(row, "patient");
		expect(seeded).toEqual(
			whenInput(
				input("region"),
				eq(prop("patient", "region", via), input("region")),
			),
		);
	});
});

describe("searchInputDecls", () => {
	it("includes the edited row so its own custom condition resolves", () => {
		// The exact screenshot scenario: a single search input named
		// `case_name` converted to a custom condition. The seed
		// self-references `input("case_name")`, so the row's OWN
		// declaration must be in scope — excluding it made the editor
		// report "Unknown search input 'case_name'." against a condition
		// the commit gate and wire emitter both accept.
		const row = simpleSearchInputDef(
			asUuid("si-1"),
			"case_name",
			"Name",
			"text",
			"case_name",
		);
		const decls = searchInputDecls([row], CASE_TYPES, CASE_TYPE);
		expect(decls.map((d) => d.name)).toContain("case_name");

		// The seeded custom condition must type-check clean — the same
		// verdict the validator's `moduleTypeContext` reaches.
		const seeded = seedCustomCondition(row, CASE_TYPE);
		expect(
			checkPredicate(seeded, {
				caseTypes: CASE_TYPES,
				knownInputs: [...decls],
				currentCaseType: CASE_TYPE,
			}).ok,
		).toBe(true);
	});

	it("skips rows that have no reference name yet", () => {
		const named = simpleSearchInputDef(asUuid("si-1"), "a", "A", "text", "");
		const unnamed = simpleSearchInputDef(asUuid("si-2"), "", "B", "text", "");
		expect(
			searchInputDecls([named, unnamed], CASE_TYPES, CASE_TYPE).map(
				(d) => d.name,
			),
		).toEqual(["a"]);
	});
});

describe("recoverAnchoredProperty", () => {
	it("recovers the property through the when-input-present envelope", () => {
		const row = simpleSearchInputDef(
			asUuid("si-1"),
			"case_name",
			"Name",
			"text",
			"case_name",
		);
		// The forward seed round-trips: custom → standard lands back on
		// the same property rather than re-seeding a different one.
		const seeded = seedCustomCondition(row, CASE_TYPE);
		expect(recoverAnchoredProperty(seeded)).toBe("case_name");
	});

	it("recovers the property from a bare left-anchored comparison", () => {
		// Hand-authored (or chat/MCP) conditions without an envelope still
		// recover the same way.
		const bare = eq(prop(CASE_TYPE, "status"), input("status"));
		expect(recoverAnchoredProperty(bare)).toBe("status");
	});

	it("does not recover when the left side walks to another case", () => {
		const crossWalk = eq(
			prop("patient", "status", ancestorPath(relationStep("parent"))),
			input("status"),
		);
		expect(recoverAnchoredProperty(crossWalk)).toBeUndefined();
	});
});
