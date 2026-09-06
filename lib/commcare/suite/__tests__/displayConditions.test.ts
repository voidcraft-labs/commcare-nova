/** Private wire projection: these checks assert expression placement, not the
 * runtime truth values. Native navigation evidence evaluates exported rules. */
import { describe, expect, it } from "vitest";
import {
	and,
	concat,
	eq,
	gt,
	gte,
	literal,
	lt,
	lte,
	matchAll,
	matchNone,
	neq,
	prop,
	sessionContext,
	sessionUser,
	term,
} from "@/lib/domain/predicate";
import {
	emitFormDisplayConditionForHq,
	emitFormDisplayConditionForSuite,
	emitModuleDisplayCondition,
} from "../displayConditions";

const anchor =
	"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/selected_patient]";

describe("navigation expression projection", () => {
	it("anchors nested properties to the supplied datum locally and HQ's case placeholder remotely", () => {
		const condition = eq(
			concat(term(prop("patient", "given_name")), term(literal("!"))),
			literal("Ada!"),
		);
		expect(
			emitFormDisplayConditionForSuite(
				condition,
				"patient",
				undefined,
				undefined,
				"selected_patient",
			),
		).toBe(`concat(${anchor}/given_name, '!') = 'Ada!'`);
		expect(emitFormDisplayConditionForHq(condition, "patient")).toBe(
			"concat(#case/given_name, '!') = 'Ada!'",
		);
	});
	it("keeps reserved metadata as attributes and leaves global terms outside the case anchor", () => {
		const condition = eq(prop("patient", "owner_id"), sessionContext("userid"));
		expect(
			emitFormDisplayConditionForSuite(
				condition,
				"patient",
				undefined,
				undefined,
				"selected_patient",
			),
		).toBe(
			`${anchor}/@owner_id = instance('commcaresession')/session/context/userid`,
		);
		expect(emitFormDisplayConditionForHq(condition, "patient")).toBe(
			"#case/@owner_id = instance('commcaresession')/session/context/userid",
		);
		expect(
			emitModuleDisplayCondition(
				eq(sessionUser("role"), literal("supervisor")),
			),
		).toBe("instance('commcaresession')/session/user/data/role = 'supervisor'");
	});
	it.each([
		[eq(prop("patient", "nickname"), literal("")), "nickname = ''"],
		[neq(prop("patient", "nickname"), literal("known")), "nickname != 'known'"],
		[eq(prop("patient", "age"), literal(0)), "age = 0"],
		[neq(prop("patient", "age"), literal(0)), "age != 0"],
		[gt(prop("patient", "age"), literal(0)), "age > 0"],
		[gte(prop("patient", "age"), literal(0)), "age >= 0"],
		[lt(prop("patient", "age"), literal(0)), "age < 0"],
		[lte(prop("patient", "age"), literal(0)), "age <= 0"],
	] as const)(
		"emits the raw comparison %j as %s in both dialects",
		(condition, suffix) => {
			expect(
				emitFormDisplayConditionForSuite(
					condition,
					"patient",
					undefined,
					undefined,
					"selected_patient",
				),
			).toBe(`${anchor}/${suffix}`);
			expect(emitFormDisplayConditionForHq(condition, "patient")).toBe(
				`#case/${suffix}`,
			);
		},
	);
	it("omits folded true conditions, preserves false, and retains a remaining global comparison", () => {
		for (const emit of [
			emitModuleDisplayCondition,
			emitFormDisplayConditionForSuite,
			emitFormDisplayConditionForHq,
		]) {
			expect(emit(undefined)).toBeUndefined();
			expect(
				emit(
					and(matchAll(), {
						kind: "or",
						clauses: [
							matchAll(),
							eq(sessionContext("userid"), literal("someone")),
						],
					}),
				),
			).toBeUndefined();
			expect(emit(matchNone())).toBe("false()");
			expect(
				emit(
					and(
						matchAll(),
						eq(sessionContext("userid"), literal("worker")),
						matchAll(),
					),
				),
			).toBe("instance('commcaresession')/session/context/userid = 'worker'");
		}
	});
});
