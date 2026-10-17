/**
 * Unit coverage for the form-context-aware hashtag expander.
 *
 * Contracts locked in:
 *
 *   - On a registration form, the own-type `#<own_type>/case_id` reads the
 *     session datum the entry mints the new case's id into, which the caller
 *     names.
 *   - A default value's form reads print relative to the question it sets.
 *   - Literal authored `#case/...` fails closed at every wire projection.
 *   - A per-case-type namespace `#<type>/<prop>` resolves to the SAME
 *     parent-index walk the private HQ `#case/parent…/<prop>` projection names,
 *     addressed by the type's reachable-case-type hop depth.
 *   - A `vellum:*` shadow carries `#form/` references alone, and none that
 *     heads a predicate or a longer path.
 */

import { describe, expect, it } from "vitest";
import { expandCaseToWire, hqLoadReference } from "@/lib/commcare/hashtags";
import {
	expandHashtagsForDefaultValue,
	expandHashtagsForSessionStack,
	expandHashtagsInContext,
	type FormHashtagContext,
	vellumShorthandInContext,
} from "@/lib/commcare/hashtags/formContext";
import { newCaseIdDatumId } from "@/lib/commcare/session";
import { FormPath } from "@/lib/commcare/xform/formPath";

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
			"/data/x + 1",
		);
		expect(expandHashtagsInContext("#user/username", ctx("registration"))).toBe(
			"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/username",
		);
	});

	describe("per-case-type namespaces", () => {
		// A form whose own loaded case is `pregnancy` (depth 0), parent `mother`
		// (depth 1) — the reachable-case-type depth map the builder passes in.
		const depths = new Map([
			["pregnancy", 0],
			["mother", 1],
		]);

		it("resolves #<own_type>/<prop> to the selected own-case property path", () => {
			expect(
				expandHashtagsInContext("#pregnancy/ga_weeks", ctx("followup", depths)),
			).toBe(
				"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/ga_weeks",
			);
		});

		it("resolves #<parent_type>/<prop> to a parent-index property path", () => {
			expect(
				expandHashtagsInContext(
					"#mother/household_code",
					ctx("followup", depths),
				),
			).toBe(
				"instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent]/household_code",
			);
		});

		it("reads #<own_type>/case_id from the entry's new-case datum on a registration form", () => {
			const ownNewCaseIdRef = `instance('commcaresession')/session/data/${newCaseIdDatumId("pregnancy")}`;
			expect(
				expandHashtagsInContext("concat('P-', #pregnancy/case_id)", {
					...ctx("registration", depths),
					ownNewCaseIdRef,
				}),
			).toBe(
				"concat('P-', instance('commcaresession')/session/data/case_id_new_pregnancy_0)",
			);
			expect(() =>
				expandHashtagsInContext(
					"#pregnancy/case_id",
					ctx("registration", depths),
				),
			).toThrow("names no session datum");
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
			).toBe(
				`/data/age > instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent]/min_age`,
			);
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

describe("expandHashtagsForDefaultValue", () => {
	const formPaths = new Map([
		["zone", FormPath.root().child("zone")],
		["visits", FormPath.root().child("visits")],
		["visits/zone", FormPath.root().child("visits").child("zone")],
	]);
	const c: FormHashtagContext = {
		...ctx("followup", new Map([["patient", 0]])),
		formPaths,
	};

	it("prints each form read relative to the question the default sets", () => {
		expect(
			expandHashtagsForDefaultValue(
				"concat('was ', #form/zone)",
				c,
				FormPath.root().child("root_read"),
			),
		).toBe("concat('was ', current()/../zone)");
		expect(
			expandHashtagsForDefaultValue(
				"#form/zone",
				c,
				FormPath.root().child("visits").child("zone"),
			),
		).toBe("current()/../../zone");
		expect(
			expandHashtagsForDefaultValue(
				"#form/visits/zone",
				c,
				FormPath.root().child("visits").child("sibling_read"),
			),
		).toBe("current()/../zone");
	});

	it("expands case reads as the absolute walk every other slot prints", () => {
		expect(
			expandHashtagsForDefaultValue(
				"#patient/name",
				c,
				FormPath.root().child("root_read"),
			),
		).toBe(expandHashtagsInContext("#patient/name", c));
	});
});

describe("vellumShorthandInContext", () => {
	const depths = new Map([
		["pregnancy", 0],
		["mother", 1],
	]);
	const formPaths = new Map([
		["age", FormPath.root().child("age")],
		["med", FormPath.root().child("med")],
		["items/choice", FormPath.root().child("items").child("choice")],
	]);
	const c: FormHashtagContext = { ...ctx("followup", depths), formPaths };

	it("projects #form/ refs to the editor's own spelling", () => {
		expect(vellumShorthandInContext("#form/age > 18", c)).toBe(
			"#form/age > 18",
		);
		// A ref the form does not map is kept as written.
		expect(
			vellumShorthandInContext("#form/age > 18", ctx("registration")),
		).toBe("#form/age > 18");
	});

	it("writes no shadow for an expression that reads a case, on every form type", () => {
		// The editor's reverse map names a listed case property itself; a
		// shadow of Nova's own would save `#case/status` as a child element and
		// draw an unknown-question warning for an unlisted property.
		for (const formType of [
			"followup",
			"close",
			"registration",
			"survey",
		] as const) {
			const typed: FormHashtagContext = {
				...ctx(formType, depths),
				formPaths,
			};
			expect(vellumShorthandInContext("#pregnancy/ga", typed)).toBeUndefined();
			expect(
				vellumShorthandInContext(
					"#form/med != '' and contains(lower-case(#pregnancy/allergen), 'pen')",
					typed,
				),
			).toBeUndefined();
		}
		expect(vellumShorthandInContext("#mother/code", c)).toBeUndefined();
		expect(vellumShorthandInContext("#case/ga", c)).toBeUndefined();
	});

	it("writes no shadow for #user/, #search/ or an unreachable namespace", () => {
		expect(vellumShorthandInContext("#user/role = 'chw'", c)).toBeUndefined();
		expect(vellumShorthandInContext("#search/name", c)).toBeUndefined();
		expect(vellumShorthandInContext("#unknown/x", c)).toBeUndefined();
	});

	it("writes no shadow when a #form/ ref is the base of a predicate", () => {
		expect(
			vellumShorthandInContext("count(#form/items/choice[. = 'yes']) = 1", c),
		).toBeUndefined();
		expect(
			vellumShorthandInContext(
				"#form/age > count(#form/items/choice[./. = 'yes'])",
				c,
			),
		).toBeUndefined();
	});

	it("writes no shadow when a #form/ ref is the first step of a longer path", () => {
		expect(
			vellumShorthandInContext("#form/items/choice/..", c),
		).toBeUndefined();
		expect(
			vellumShorthandInContext("count(#form/items/choice//x)", c),
		).toBeUndefined();
	});

	it("keeps a shadow whose #form/ ref stands inside another path's predicate", () => {
		expect(
			vellumShorthandInContext(
				"count(instance('casedb')/casedb/case[@case_type = #form/med])",
				c,
			),
		).toBe("count(instance('casedb')/casedb/case[@case_type = #form/med])");
	});

	it("returns undefined when the expression has no hashtags at all", () => {
		expect(vellumShorthandInContext("/data/age > 18", c)).toBeUndefined();
		expect(vellumShorthandInContext("", c)).toBeUndefined();
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

describe("context boundaries remain lexical and identity-scoped", () => {
	it("uses the caller's renamed selection for own and parent paths", () => {
		const c = {
			...ctx(
				"followup",
				new Map([
					["patient", 0],
					["household", 1],
				]),
			),
			currentCaseIdRef:
				"instance('commcaresession')/session/data/case_id_patient",
		};
		expect(expandHashtagsInContext("#patient/case_id", c)).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id_patient]/@case_id",
		);
		expect(expandHashtagsInContext("#household/name", c)).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id_patient]/index/parent]/name",
		);
	});
	it("expands only available one-segment search answers and refuses session reuse", () => {
		const c = {
			...ctx("registration"),
			searchAnswers: {
				instanceId: "search-input:care",
				names: new Set(["name"]),
			},
		};
		expect(
			expandHashtagsInContext(
				"concat(#search/name, '#search/name', #search/missing)",
				c,
			),
		).toBe(
			"concat(instance('search-input:care')/input/field[@name='name'], '#search/name', #search/missing)",
		);
		expect(expandHashtagsInContext("#search/name/path", c)).toBe(
			"#search/name/path",
		);
		expect(expandHashtagsInContext("#search/name", ctx("survey"))).toBe(
			"#search/name",
		);
		expect(() =>
			expandHashtagsForSessionStack("#search/name", new Map()),
		).toThrow(/closed/);
		expect(() => hqLoadReference("#search/name", new Map())).toThrow(
			/no HQ load/,
		);
	});
	it("leaves hashtag-looking string literals untouched in form and session scopes", () => {
		const text = "concat('#case/forbidden', \"#form/closed\", '雪')";
		expect(expandHashtagsInContext(text, ctx("survey"))).toBe(text);
		expect(expandHashtagsForSessionStack(text, new Map())).toBe(text);
		expect(vellumShorthandInContext(text, ctx("followup"))).toBeUndefined();
	});
});
