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

const selectedCase =
	"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]";

describe("navigation display-condition emission", () => {
	it("emits module session values without inventing a case context", () => {
		expect(
			emitModuleDisplayCondition(
				eq(sessionUser("role"), literal("supervisor")),
			),
		).toBe("instance('commcaresession')/session/user/data/role = 'supervisor'");
	});

	it("anchors form properties structurally to the selected suite case", () => {
		expect(
			emitFormDisplayConditionForSuite(
				eq(prop("patient", "status"), literal("open")),
				"patient",
			),
		).toBe(`${selectedCase}/@status = 'open'`);
	});

	it("preserves HQ's #case interpolation contract and reserved attributes", () => {
		expect(
			emitFormDisplayConditionForHq(
				eq(prop("patient", "owner_id"), sessionContext("userid")),
				"patient",
			),
		).toBe(
			"#case/@owner_id = instance('commcaresession')/session/context/userid",
		);
	});

	it("threads the selected-case leaf through nested value expressions", () => {
		const condition = eq(
			concat(term(prop("patient", "given_name")), term(literal("!"))),
			literal("Ada!"),
		);
		expect(emitFormDisplayConditionForSuite(condition, "patient")).toBe(
			`concat(${selectedCase}/given_name, '!') = 'Ada!'`,
		);
	});

	it("preserves Core's absent-node comparison semantics without guards", () => {
		const cases = [
			[
				eq(prop("patient", "nickname"), literal("")),
				`${selectedCase}/nickname = ''`,
			],
			[
				neq(prop("patient", "nickname"), literal("known")),
				`${selectedCase}/nickname != 'known'`,
			],
			[eq(prop("patient", "age"), literal(0)), `${selectedCase}/age = 0`],
			[neq(prop("patient", "age"), literal(0)), `${selectedCase}/age != 0`],
			[gt(prop("patient", "age"), literal(0)), `${selectedCase}/age > 0`],
			[gte(prop("patient", "age"), literal(0)), `${selectedCase}/age >= 0`],
			[lt(prop("patient", "age"), literal(0)), `${selectedCase}/age < 0`],
			[lte(prop("patient", "age"), literal(0)), `${selectedCase}/age <= 0`],
		] as const;
		for (const [condition, expected] of cases) {
			const emitted = emitFormDisplayConditionForSuite(condition, "patient");
			expect(emitted).toBe(expected);
			expect(emitted).not.toMatch(/count\(|boolean\(|string-length\(/);
		}
	});

	it("folds deeply always-true conditions to an absent wire attribute", () => {
		expect(
			emitModuleDisplayCondition(
				and(
					matchAll(),
					eq(sessionContext("userid"), sessionContext("userid")),
					matchAll(),
				),
			),
		).toContain("userid");
		expect(
			emitModuleDisplayCondition({
				kind: "or",
				clauses: [matchAll(), eq(sessionContext("userid"), literal("someone"))],
			}),
		).toBeUndefined();
	});
});
