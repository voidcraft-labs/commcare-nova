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
import { asUuid, simpleSearchInputDef } from "@/lib/domain";
import {
	ancestorPath,
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
	seedCustomCondition,
} from "../searchInputResolution";

const CASE_TYPE = "household";

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
