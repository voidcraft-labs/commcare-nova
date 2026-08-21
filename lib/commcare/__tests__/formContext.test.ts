/**
 * Unit coverage for the form-context-aware hashtag expander.
 *
 * Contracts locked in:
 *
 *   - On a registration form, the own-type `#<own_type>/case_id` rewrites to
 *     the form-local path
 *     `/data/case/@case_id` (populated by the case-create scaffolding's
 *     setvalue chain).
 *   - Literal authored `#case/...` fails closed at every wire projection.
 *   - A per-case-type namespace `#<type>/<prop>` resolves to the SAME
 *     parent-index walk the private HQ `#case/parent…/<prop>` projection names,
 *     addressed by the type's reachable-case-type hop depth.
 */

import { describe, expect, it } from "vitest";
import {
	expandCaseToWire,
	expandFlatHashtags,
	hqLoadReference,
} from "@/lib/commcare/hashtags";
import {
	expandHashtagsForSessionStack,
	expandHashtagsInContext,
	type FormHashtagContext,
	vellumShorthandInContext,
} from "@/lib/commcare/hashtags/formContext";

const ctx = (
	formType: FormHashtagContext["formType"],
	caseTypeDepths: ReadonlyMap<string, number> = new Map(),
): FormHashtagContext => ({ formType, caseTypeDepths });

describe("expandHashtagsInContext", () => {
	it.each(["registration", "followup", "close", "survey"] as const)(
		"rejects raw authored #case/ on %s forms",
		(formType) => {
			expect(() =>
				expandHashtagsInContext(
					"#case/case_id",
					ctx(formType, new Map([["patient", 0]])),
				),
			).toThrow('Authored "#case/..." is not a Nova reference');
		},
	);

	it("expands #form/ and #user/ through the flat authored resolver", () => {
		expect(expandHashtagsInContext("#form/x + 1", ctx("registration"))).toBe(
			expandFlatHashtags("#form/x + 1"),
		);
		expect(expandHashtagsInContext("#user/username", ctx("registration"))).toBe(
			expandFlatHashtags("#user/username"),
		);
	});

	describe("per-case-type namespaces", () => {
		// A form whose own loaded case is `pregnancy` (depth 0), parent `mother`
		// (depth 1) — the reachable-case-type depth map the builder passes in.
		const depths = new Map([
			["pregnancy", 0],
			["mother", 1],
		]);

		it("resolves #<own_type>/<prop> byte-identical to #case/<prop>", () => {
			expect(
				expandHashtagsInContext("#pregnancy/ga_weeks", ctx("followup", depths)),
			).toBe(expandCaseToWire(0, "ga_weeks"));
		});

		it("resolves #<parent_type>/<prop> byte-identical to #case/parent/<prop>", () => {
			expect(
				expandHashtagsInContext(
					"#mother/household_code",
					ctx("followup", depths),
				),
			).toBe(expandCaseToWire(1, "household_code"));
		});

		it("rewrites #<own_type>/case_id to /data/case/@case_id on a registration form", () => {
			expect(
				expandHashtagsInContext(
					"#pregnancy/case_id",
					ctx("registration", depths),
				),
			).toBe("/data/case/@case_id");
		});

		it("leaves an unreachable namespace verbatim for the validator to reject", () => {
			expect(
				expandHashtagsInContext("#unknown/x", ctx("followup", depths)),
			).toBe("#unknown/x");
		});

		it("resolves mixed #form/ and #<type>/ refs in one expression", () => {
			expect(
				expandHashtagsInContext(
					"#form/age > #mother/min_age",
					ctx("followup", depths),
				),
			).toBe(`/data/age > ${expandCaseToWire(1, "min_age")}`);
		});
	});

	describe("edge cases", () => {
		it("passes empty input through unchanged", () => {
			expect(expandHashtagsInContext("", ctx("registration"))).toBe("");
		});

		it("leaves non-hashtag XPath unchanged", () => {
			expect(
				expandHashtagsInContext("/data/age > 18", ctx("registration")),
			).toBe("/data/age > 18");
		});
	});
});

describe("vellumShorthandInContext", () => {
	// pregnancy (own, 0) → mother (1) → household (2): the guaranteed own
	// generation plus two ancestor depths HQ's editor only knows when the
	// app's own forms establish the relationship.
	const depths = new Map([
		["pregnancy", 0],
		["mother", 1],
		["household", 2],
	]);

	it("projects a canonical own-type ref onto HQ's private #case/ spelling", () => {
		const c = ctx("followup", depths);
		expect(vellumShorthandInContext("#pregnancy/ga", c)).toBe("#case/ga");
		expect(() => vellumShorthandInContext("#case/ga", c)).toThrow(
			'Authored "#case/..." is not a Nova reference',
		);
	});

	it("suppresses ancestor-generation shadows — HQ derives parent generations from in-app subcase forms, not the catalog", () => {
		// `case_properties.py::get_case_relationships` builds the editor's
		// parent/grandparent generations from case-subcase relationships
		// "appearing in all relevant forms"; Nova's catalog parent link doesn't
		// guarantee any, so a `#case/parent/` shadow could be unexpandable.
		const c = ctx("followup", depths);
		expect(vellumShorthandInContext("#mother/code", c)).toBeUndefined();
		expect(vellumShorthandInContext("#household/head", c)).toBeUndefined();
	});

	it("suppresses #user/ shadows — the usercase namespace is a domain privilege Nova can't know", () => {
		// `casedb_schema.py::get_casedb_schema` adds the user subset only under
		// `domain_has_usercase_access(app.domain)` (off by default), and
		// `Vellum/src/form.js::_updateHashtags` wipes the head-element fallback
		// once data sources load.
		expect(
			vellumShorthandInContext("#user/role = 'chw'", ctx("followup", depths)),
		).toBeUndefined();
		expect(
			vellumShorthandInContext("#user/a/b", ctx("followup")),
		).toBeUndefined();
	});

	it("keeps #form/ refs verbatim", () => {
		expect(
			vellumShorthandInContext("#form/age > 18", ctx("followup", depths)),
		).toBe("#form/age > 18");
	});

	it("translates refs inside a larger mixed expression", () => {
		expect(
			vellumShorthandInContext(
				"#form/med != '' and contains(lower-case(#pregnancy/allergen), 'pen')",
				ctx("followup", depths),
			),
		).toBe("#form/med != '' and contains(lower-case(#case/allergen), 'pen')");
	});

	it("suppresses the WHOLE shadow when any ref has no guaranteed editor spelling", () => {
		expect(
			vellumShorthandInContext(
				"#form/med != '' and #mother/code = 'x'",
				ctx("followup", depths),
			),
		).toBeUndefined();
	});

	it("suppresses every case-namespace shadow on non-case-loading forms", () => {
		// Registration AND survey forms upload with `requires: "none"`, and HQ
		// only feeds the editor case data sources when the form loads a case
		// (`get_casedb_schema` gates on `form.requires_case()`), so even the
		// own-type ref has no editor vocabulary there.
		expect(
			vellumShorthandInContext(
				"#pregnancy/case_id",
				ctx("registration", depths),
			),
		).toBeUndefined();
		expect(
			vellumShorthandInContext("#pregnancy/ga", ctx("survey", depths)),
		).toBeUndefined();
		// #form shadows survive on every form type.
		expect(
			vellumShorthandInContext("#form/age > 18", ctx("registration")),
		).toBe("#form/age > 18");
	});

	it("suppresses an unreachable namespace and relationship-named / multi-segment properties", () => {
		const c = ctx("followup", depths);
		expect(vellumShorthandInContext("#unknown/x", c)).toBeUndefined();
		// A property literally named after a relationship word would be read by
		// the editor as a WALK, diverging from the expanded attribute.
		expect(
			vellumShorthandInContext("#pregnancy/grandparent", c),
		).toBeUndefined();
		expect(vellumShorthandInContext("#pregnancy/parent", c)).toBeUndefined();
		// Multi-segment property path — no editor prefix covers it.
		expect(vellumShorthandInContext("#pregnancy/a/b", c)).toBeUndefined();
	});

	it("returns undefined when the expression has no hashtags at all", () => {
		expect(
			vellumShorthandInContext("/data/age > 18", ctx("followup", depths)),
		).toBeUndefined();
		expect(vellumShorthandInContext("", ctx("followup"))).toBeUndefined();
	});

	it("reports each cleared ref with its expansion via onRef, only when the whole expression clears", () => {
		const c = ctx("followup", depths);
		const seen: Array<[string, string]> = [];
		vellumShorthandInContext(
			"#pregnancy/ga > 20 and #pregnancy/risk = 'high'",
			c,
			(ref, expanded) => seen.push([ref, expanded]),
		);
		expect(seen).toEqual([
			["#case/ga", expandCaseToWire(0, "ga")],
			["#case/risk", expandCaseToWire(0, "risk")],
		]);

		// A suppressed expression reports nothing — its refs must not leak into
		// head metadata for a shadow that was never emitted.
		const none: Array<[string, string]> = [];
		vellumShorthandInContext(
			"#pregnancy/ga > #mother/min_ga",
			c,
			(ref, expanded) => none.push([ref, expanded]),
		);
		expect(none).toEqual([]);
	});
});

describe("hqLoadReference", () => {
	const depths = new Map([
		["pregnancy", 0],
		["mother", 1],
		["household", 2],
		["village", 3],
	]);

	it("translates per-type refs to the #case/ generation vocabulary", () => {
		expect(hqLoadReference("#pregnancy/ga", depths)).toBe("#case/ga");
		expect(hqLoadReference("#mother/code", depths)).toBe("#case/parent/code");
		expect(hqLoadReference("#household/head", depths)).toBe(
			"#case/grandparent/head",
		);
	});

	it("falls back to a parent chain past the named generations", () => {
		expect(hqLoadReference("#village/name", depths)).toBe(
			"#case/parent/parent/parent/name",
		);
	});

	it("rejects authored #case/ and passes #user/ plus unreachable namespaces through", () => {
		expect(() => hqLoadReference("#case/ga", depths)).toThrow(
			'Authored "#case/..." is not a Nova reference',
		);
		expect(hqLoadReference("#user/role", depths)).toBe("#user/role");
		expect(hqLoadReference("#unknown/x", depths)).toBe("#unknown/x");
	});
});

describe("expandHashtagsForSessionStack", () => {
	const depths = new Map([
		["patient", 0],
		["household", 1],
	]);
	const SESSION = "instance('commcaresession')/session/data";

	it("walks from the selected case by default, and reads case_id as the attribute", () => {
		expect(
			expandHashtagsForSessionStack("#patient/mood = 'good'", depths),
		).toBe(
			`instance('casedb')/casedb/case[@case_id = ${SESSION}/case_id]/mood = 'good'`,
		);
		expect(expandHashtagsForSessionStack("#patient/case_id", depths)).toBe(
			`${SESSION}/case_id`,
		);
		expect(expandHashtagsForSessionStack("#household/case_id", depths)).toBe(
			`instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = ${SESSION}/case_id]/index/parent]/@case_id`,
		);
	});

	it("walks from the case a registration form created when told so", () => {
		const created = `${SESSION}/case_id_new_patient_0`;
		expect(
			expandHashtagsForSessionStack("#patient/mood", depths, created),
		).toBe(`instance('casedb')/casedb/case[@case_id = ${created}]/mood`);
		expect(
			expandHashtagsForSessionStack("#patient/case_id", depths, created),
		).toBe(created);
		expect(
			expandHashtagsForSessionStack("#household/village", depths, created),
		).toBe(
			`instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = ${created}]/index/parent]/village`,
		);
	});

	it("refuses a form read outright: the validator keeps #form/ out of a session slot first", () => {
		expect(() => expandHashtagsForSessionStack("#form/note", depths)).toThrow(
			/closed/,
		);
	});
});

describe("expandCaseToWire case_id leaf", () => {
	it("reads the casedb @case_id attribute in form scope too", () => {
		expect(expandCaseToWire(1, "case_id")).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent]/@case_id",
		);
	});
});
