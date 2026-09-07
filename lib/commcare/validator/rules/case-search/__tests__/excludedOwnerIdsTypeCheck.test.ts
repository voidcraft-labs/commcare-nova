import { describe, expect, it } from "vitest";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import {
	concat,
	count,
	eq,
	exists,
	ifExpr,
	literal,
	prop,
	sessionContext,
	subcasePath,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	admittedCaseListDoc,
	findings,
} from "../../case-list/__tests__/caseListRuleFixture";

function candidate(expression: ValueExpression | undefined) {
	const base = admittedCaseListDoc({
		caseTypes: [
			{ name: "patient", properties: [] },
			{ name: "visit", parent_type: "patient", properties: [] },
		],
	});
	const id = base.moduleOrder[0];
	const doc = {
		...base,
		modules: {
			...base.modules,
			[id]: {
				...base.modules[id],
				caseSearchConfig:
					expression === undefined
						? undefined
						: {
								searchActionEnabled: false as const,
								excludedOwnerIds: expression,
							},
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}
const caseData = "CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE";
describe("assigned-case exclusion admission", () => {
	it.each([
		term(prop("patient", "owner_id")),
		concat(term(literal("owner-")), term(prop("patient", "case_name"))),
		count(subcasePath("parent", "visit")),
		ifExpr(
			exists(subcasePath("parent", "visit")),
			term(literal("a")),
			term(literal("")),
		),
	])(
		"refuses case reads through $kind before generic type checking",
		(expression) => {
			const errors = findings(candidate(expression));
			expect(errors.map((error) => error.code)).toEqual([caseData]);
			expect(errors[0].details?.slot).toBe("caseSearchConfig.excludedOwnerIds");
		},
	);
	it.each([
		undefined,
		term(literal("owner-a owner-b")),
		term(sessionContext("userid")),
		ifExpr(
			eq(sessionContext("username"), literal("A")),
			concat(term(sessionContext("userid")), term(literal(" owner-b"))),
			term(literal("")),
		),
	])("admits global text $kind", (expression) =>
		expect(findings(candidate(expression))).toEqual([]),
	);
	it("refuses a numeric global result with one type finding", () => {
		const errors = findings(candidate(term(literal(42))));
		expect(errors.map((error) => error.code)).toEqual([
			"CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR",
		]);
		expect(errors[0].message).toContain("Expected 'text'");
	});
});
