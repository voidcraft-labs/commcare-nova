import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import {
	count,
	exists,
	gt,
	ifExpr,
	literal,
	missing,
	subcasePath,
	term,
} from "@/lib/domain/predicate";
import { runValidation } from "../validator/runner";

export const relationInstanceScenarios = [
	"count",
	"count-condition",
	"exists",
	"missing",
] as const;
export type RelationInstanceScenario =
	(typeof relationInstanceScenarios)[number];

/** Each document has only one relation consumer. No unrelated property read
 * may accidentally supply the instance that makes this expression executable. */
export function relationInstanceFixture(scenario: RelationInstanceScenario) {
	const formUuid = testUuid("relation-instance-form");
	const doc = buildDoc({
		appName: "Relation instance evidence",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "visit_count", label: "Visits", data_type: "int" },
				],
			},
			{ name: "visit", parent_type: "patient", properties: [] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: formUuid,
						name: "Review visits",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
	const relation = subcasePath("parent", "visit");
	doc.forms[formUuid].caseOperations = [
		{
			uuid: testUuid("record-visits"),
			id: "record_visits",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			...(scenario === "exists" ? { condition: exists(relation) } : {}),
			...(scenario === "count-condition"
				? { condition: gt(count(relation), literal(0)) }
				: {}),
			writes: [
				{
					property: "visit_count",
					value:
						scenario === "count"
							? count(relation)
							: scenario === "missing"
								? ifExpr(missing(relation), term(literal(1)), term(literal(0)))
								: term(literal(1)),
				},
			],
		},
	];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return doc;
}
