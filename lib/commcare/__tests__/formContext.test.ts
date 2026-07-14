/**
 * Unit coverage for the form-context-aware hashtag expander.
 *
 * Contracts locked in:
 *
 *   - On a registration form, `#case/case_id` (and the own-type
 *     `#<own_type>/case_id`) rewrites to the form-local path
 *     `/data/case/@case_id` (populated by the case-create scaffolding's
 *     setvalue chain). Every other `#case/<X>` is left in place / expanded to
 *     the case-loading shape so the validator + binding oracle reject it.
 *   - On every other form type (followup / close / survey),
 *     `expandHashtagsInContext` is identical to the context-free
 *     `expandHashtags` for the flat + literal-`#case/` namespaces.
 *   - A per-case-type namespace `#<type>/<prop>` resolves to the SAME
 *     parent-index walk as `#case/parent…/<prop>`, addressed by the type's
 *     reachable-case-type hop depth: own (depth 0) is byte-identical to
 *     `#case/<prop>`, an ancestor (depth N) to `#case/parent×N/<prop>`.
 */

import { describe, expect, it } from "vitest";
import { expandHashtags, hqLoadReference } from "@/lib/commcare/hashtags";
import {
	expandHashtagsInContext,
	type FormHashtagContext,
	vellumShorthandInContext,
} from "@/lib/commcare/hashtags/formContext";

const ctx = (
	formType: FormHashtagContext["formType"],
	caseTypeDepths: ReadonlyMap<string, number> = new Map(),
): FormHashtagContext => ({ formType, caseTypeDepths });

describe("expandHashtagsInContext", () => {
	describe("registration forms", () => {
		it("rewrites #case/case_id to /data/case/@case_id", () => {
			expect(
				expandHashtagsInContext("#case/case_id", ctx("registration")),
			).toBe("/data/case/@case_id");
		});

		it("rewrites #case/case_id inside a larger expression", () => {
			expect(
				expandHashtagsInContext(
					"concat(#case/case_id, '-suffix')",
					ctx("registration"),
				),
			).toBe("concat(/data/case/@case_id, '-suffix')");
		});

		it("leaves #case/<other> un-rewritten so it surfaces as a build error downstream", () => {
			// The un-rewritten ref flows through the case-loading expansion; the
			// binding-resolution oracle then catches that registration entries
			// declare no `case_id` datum and throws at compile time.
			const result = expandHashtagsInContext(
				"#case/some_other_prop",
				ctx("registration"),
			);
			// It expands to the case-loading shape — NOT to /data/case/@case_id,
			// which is reserved for the form's own allocated case_id.
			expect(result).not.toContain("/data/case/@case_id");
		});

		it("rewrites only the exact #case/case_id token (not prefix matches)", () => {
			// A hashtag whose segment starts with "case_id" — e.g. a hypothetical
			// `case_id_x` property — must NOT be rewritten. Lezer matches on the
			// segment boundary, not by string prefix.
			const result = expandHashtagsInContext(
				"#case/case_id_extension",
				ctx("registration"),
			);
			expect(result).not.toContain("/data/case/@case_id");
		});

		it("expands #form/ and #user/ hashtags the same way the context-free expander does", () => {
			expect(expandHashtagsInContext("#form/x + 1", ctx("registration"))).toBe(
				expandHashtags("#form/x + 1"),
			);
			expect(
				expandHashtagsInContext("#user/username", ctx("registration")),
			).toBe(expandHashtags("#user/username"));
		});
	});

	describe("non-registration forms", () => {
		for (const formType of ["followup", "close", "survey"] as const) {
			it(`expands #case/case_id the case-loading way on ${formType}`, () => {
				expect(expandHashtagsInContext("#case/case_id", ctx(formType))).toBe(
					expandHashtags("#case/case_id"),
				);
			});

			it(`expands #case/<other> identically to the context-free expander on ${formType}`, () => {
				expect(
					expandHashtagsInContext("#case/total_visits", ctx(formType)),
				).toBe(expandHashtags("#case/total_visits"));
			});
		}
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
			).toBe(expandHashtags("#case/ga_weeks"));
		});

		it("resolves #<parent_type>/<prop> byte-identical to #case/parent/<prop>", () => {
			expect(
				expandHashtagsInContext(
					"#mother/household_code",
					ctx("followup", depths),
				),
			).toBe(expandHashtags("#case/parent/household_code"));
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
			).toBe(`/data/age > ${expandHashtags("#case/parent/min_age")}`);
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
	// pregnancy (own, 0) → mother (1) → household (2) → village (3): the full
	// generation ladder plus one depth past HQ's editor vocabulary.
	const depths = new Map([
		["pregnancy", 0],
		["mother", 1],
		["household", 2],
		["village", 3],
	]);

	it("projects each per-type depth onto HQ's case generations", () => {
		const c = ctx("followup", depths);
		expect(vellumShorthandInContext("#pregnancy/ga", c)).toBe("#case/ga");
		expect(vellumShorthandInContext("#mother/code", c)).toBe(
			"#case/parent/code",
		);
		expect(vellumShorthandInContext("#household/head", c)).toBe(
			"#case/grandparent/head",
		);
	});

	it("suppresses the shadow past HQ's three generations (depth ≥ 3)", () => {
		expect(
			vellumShorthandInContext("#village/name", ctx("followup", depths)),
		).toBeUndefined();
	});

	it("normalizes a transitional #case/parent/parent/ chain to #case/grandparent/", () => {
		expect(
			vellumShorthandInContext("#case/parent/parent/head", ctx("followup")),
		).toBe("#case/grandparent/head");
		expect(vellumShorthandInContext("#case/parent/code", ctx("followup"))).toBe(
			"#case/parent/code",
		);
	});

	it("keeps #form/ and #user/ refs verbatim", () => {
		expect(
			vellumShorthandInContext(
				"#form/age > 18 and #user/role = 'chw'",
				ctx("followup", depths),
			),
		).toBe("#form/age > 18 and #user/role = 'chw'");
	});

	it("translates refs inside a larger mixed expression", () => {
		expect(
			vellumShorthandInContext(
				"#form/med != '' and contains(lower-case(#pregnancy/allergen), 'pen')",
				ctx("followup", depths),
			),
		).toBe("#form/med != '' and contains(lower-case(#case/allergen), 'pen')");
	});

	it("suppresses the WHOLE shadow when any ref has no editor spelling", () => {
		expect(
			vellumShorthandInContext(
				"#form/med != '' and #village/name = 'x'",
				ctx("followup", depths),
			),
		).toBeUndefined();
	});

	it("suppresses every case-namespace shadow on a registration form", () => {
		// HQ only feeds the editor case data sources when the form loads a case
		// (`get_casedb_schema` gates on `form.requires_case()`), so even the
		// own-type case_id ref has no editor vocabulary there.
		expect(
			vellumShorthandInContext(
				"#pregnancy/case_id",
				ctx("registration", depths),
			),
		).toBeUndefined();
		expect(
			vellumShorthandInContext("#case/case_id", ctx("registration")),
		).toBeUndefined();
		// #form / #user shadows survive.
		expect(
			vellumShorthandInContext("#form/age > 18", ctx("registration")),
		).toBe("#form/age > 18");
	});

	it("suppresses an unreachable namespace and relationship-named / multi-segment properties", () => {
		const c = ctx("followup", depths);
		expect(vellumShorthandInContext("#unknown/x", c)).toBeUndefined();
		// A property literally named `grandparent` would be read by the editor
		// as a relationship WALK, diverging from the expanded attribute.
		expect(vellumShorthandInContext("#case/grandparent", c)).toBeUndefined();
		expect(
			vellumShorthandInContext("#pregnancy/grandparent", c),
		).toBeUndefined();
		// Multi-segment property path — no editor prefix covers it.
		expect(vellumShorthandInContext("#pregnancy/a/b", c)).toBeUndefined();
		// Bare relationship ref (no property) — same.
		expect(vellumShorthandInContext("#case/parent", c)).toBeUndefined();
	});

	it("returns undefined when the expression has no hashtags at all", () => {
		expect(
			vellumShorthandInContext("/data/age > 18", ctx("followup", depths)),
		).toBeUndefined();
		expect(vellumShorthandInContext("", ctx("followup"))).toBeUndefined();
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

	it("passes #case/, #user/, and unreachable namespaces through verbatim", () => {
		expect(hqLoadReference("#case/ga", depths)).toBe("#case/ga");
		expect(hqLoadReference("#case/parent/code", depths)).toBe(
			"#case/parent/code",
		);
		expect(hqLoadReference("#user/role", depths)).toBe("#user/role");
		expect(hqLoadReference("#unknown/x", depths)).toBe("#unknown/x");
	});
});
