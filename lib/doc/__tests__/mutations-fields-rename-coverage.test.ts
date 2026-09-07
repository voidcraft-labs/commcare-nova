import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xpIn } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planConnectTargetState } from "@/lib/doc/connectTargetState";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import {
	canonicalProseTemplate,
	expressionSource,
	formExpressionSource,
	printProseTemplate,
	printXPath,
	proseText,
	xpathPrintContext,
} from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const Q = (key: string) => testUuid(`rename-projection-${key}`);
const ref = (key: string) =>
	canonicalProseTemplate([
		{ kind: "text", text: "Compare " },
		{ kind: "field-ref", uuid: Q(key) },
	]);
function fixture(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: Q("module"),
				name: "Survey",
				forms: [
					{
						uuid: Q("form"),
						name: "Collect",
						type: "survey",
						postSubmit: "app_home",
						formLinks: [
							{
								uuid: Q("link"),
								condition: "#user/username = 'supervisor'",
								target: {
									type: "form",
									moduleUuid: Q("case-module"),
									formUuid: Q("visit"),
								},
								datums: [{ name: "case_id", xpath: "'patient-id'" }],
							},
						],
						fields: [
							f({
								uuid: Q("age"),
								id: "age",
								kind: "int",
								label: proseText("Age"),
							}),
							f({
								uuid: Q("selected"),
								id: "selected_case",
								kind: "text",
								label: proseText("Selected case"),
							}),
							f({
								uuid: Q("ids"),
								id: "ids",
								kind: "text",
								label: proseText("Case ids"),
							}),
							f({
								uuid: Q("group"),
								id: "group",
								kind: "group",
								children: [
									f({
										uuid: Q("cousin"),
										id: "age",
										kind: "int",
										label: proseText("Other age"),
									}),
								],
							}),
							f({
								uuid: Q("answer"),
								id: "answer",
								kind: "int",
								label: ref("age"),
								hint: ref("cousin"),
								help: ref("age"),
								required: "/data/age > 17",
								relevant: "#form/group/age > 0",
								validate: ". > #form/age",
								validate_msg: ref("age"),
								default_value: "#form/age",
							}),
							f({
								uuid: Q("hidden"),
								id: "computed",
								kind: "hidden",
								calculate: "/data/age + 1",
							}),
							f({
								uuid: Q("select"),
								id: "choice",
								kind: "single_select",
								label: proseText("Choice"),
								optionsSource: {
									kind: "inline",
									options: [
										{ uuid: Q("option"), value: "age", label: ref("age") },
										{
											uuid: Q("option2"),
											value: "other",
											label: proseText("Other"),
										},
									],
								},
							}),
							f({
								uuid: Q("count-repeat"),
								id: "children",
								kind: "repeat",
								repeat_mode: "count_bound",
								repeat_count: "/data/age",
								children: [
									f({ id: "notes", kind: "text", label: proseText("Notes") }),
								],
							}),
							f({
								uuid: Q("query-repeat"),
								id: "cases",
								kind: "repeat",
								repeat_mode: "query_bound",
								data_source: { ids_query: "#form/ids" },
								children: [
									f({ id: "notes", kind: "text", label: proseText("Notes") }),
								],
							}),
						],
					},
					{
						uuid: Q("other-form"),
						name: "Other",
						type: "survey",
						fields: [
							f({
								uuid: Q("other-age"),
								id: "age",
								kind: "int",
								label: proseText("Age"),
							}),
							f({
								uuid: Q("other-watch"),
								id: "watch",
								kind: "hidden",
								calculate: "/data/age + 2",
							}),
						],
					},
				],
			},
			{
				uuid: Q("case-module"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: Q("visit"),
						name: "Visit",
						type: "followup",
						fields: [
							f({ id: "notes", kind: "text", label: proseText("Notes") }),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}
function commit(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations.map((mutation) =>
			mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
		),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}
describe("field reference projection after rename and move", () => {
	it("projects the actual field, repeat and option carriers while leaving stored ASTs and literal values unchanged", () => {
		const before = fixture();
		const next = commit(before, [
			{
				kind: "updateField",
				uuid: Q("age"),
				targetKind: "int",
				patch: { id: "years" },
			},
			{
				kind: "updateField",
				uuid: Q("selected"),
				targetKind: "text",
				patch: { id: "chosen_case" },
			},
			{
				kind: "updateField",
				uuid: Q("ids"),
				targetKind: "text",
				patch: { id: "case_ids" },
			},
		]);
		for (const [slot, expected] of [
			["required", "/data/years > 17"],
			["validate", ". > #form/years"],
			["default_value", "#form/years"],
			["relevant", "#form/group/age > 0"],
			["label", "Compare #form/years"],
			["hint", "Compare #form/group/age"],
			["help", "Compare #form/years"],
			["validate_msg", "Compare #form/years"],
		] as const) {
			expect(expressionSource(next.fields[Q("answer")], slot, next)).toBe(
				expected,
			);
		}
		expect(expressionSource(next.fields[Q("hidden")], "calculate", next)).toBe(
			"/data/years + 1",
		);
		expect(
			expressionSource(next.fields[Q("count-repeat")], "repeat_count", next),
		).toBe("/data/years");
		expect(
			expressionSource(next.fields[Q("query-repeat")], "ids_query", next),
		).toBe("#form/case_ids");
		expect(
			expressionSource(next.fields[Q("other-watch")], "calculate", next),
		).toBe("/data/age + 2");
		const select = next.fields[Q("select")];
		if (
			select.kind !== "single_select" ||
			select.optionsSource.kind !== "inline"
		)
			throw new Error("Expected inline select");
		expect(
			printProseTemplate(select.optionsSource.options[0].label, next),
		).toBe("Compare #form/years");
		expect(select.optionsSource.options[0].value).toBe("age");
		const link = next.forms[Q("form")].formLinks?.[0];
		if (!link?.condition || !link.datums?.[0])
			throw new Error("Expected conditioned link with datum");
		expect(printXPath(link.condition, xpathPrintContext(next))).toBe(
			"#user/username = 'supervisor'",
		);
		expect(printXPath(link.datums[0].xpath, xpathPrintContext(next))).toBe(
			"'patient-id'",
		);
		expect(link.datums[0].name).toBe("case_id");
		expect(next.fields[Q("answer")]).toEqual(before.fields[Q("answer")]);
		expect(next.forms[Q("form")]).toEqual(before.forms[Q("form")]);
	});
	it.each(["condition", "datum"] as const)(
		"refuses form-answer references in after-submit %s instead of treating them as reachable rename carriers",
		(slot) => {
			const before = fixture();
			const patch =
				slot === "condition"
					? { condition: xpIn(before, Q("form"), "#form/age > 17") }
					: {
							datums: [
								{
									name: "case_id",
									xpath: xpIn(before, Q("form"), "/data/selected_case"),
								},
							],
						};
			const verdict = mutationCommitVerdict(
				before,
				[
					{
						kind: "updateFormLink",
						formUuid: Q("form"),
						uuid: Q("link"),
						patch,
					},
				],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok).toBe(false);
			if (!verdict.ok)
				expect(verdict.findings.map((finding) => finding.code)).toContain(
					"INVALID_REF",
				);
		},
	);
	it("renames a container without capturing a same-named root cousin", () => {
		const before = fixture();
		const next = commit(before, [
			{
				kind: "updateField",
				uuid: Q("group"),
				targetKind: "group",
				patch: { id: "details" },
			},
		]);
		expect(expressionSource(next.fields[Q("answer")], "relevant", next)).toBe(
			"#form/details/age > 0",
		);
		expect(expressionSource(next.fields[Q("answer")], "hint", next)).toBe(
			"Compare #form/details/age",
		);
		expect(expressionSource(next.fields[Q("answer")], "required", next)).toBe(
			"/data/age > 17",
		);
	});
	it.each(["learn", "deliver"] as const)(
		"projects %s Connect expressions established by the real whole-app planner",
		(mode) => {
			const base = fixture();
			const connect =
				mode === "learn"
					? {
							assessment: {
								id: "assessment",
								user_score: xpIn(base, Q("form"), "/data/age * 10"),
							},
						}
					: {
							deliver_unit: {
								id: "delivery",
								name: "Delivery",
								entity_id: xpIn(
									base,
									Q("form"),
									"concat(#form/age, '-', today())",
								),
								entity_name: xpIn(base, Q("form"), "#form/age"),
							},
						};
			const plan = planConnectTargetState(base, {
				mode,
				participants: [{ formUuid: Q("form"), connect }],
			});
			if (!plan.ok) throw new Error(plan.messages.join("; "));
			const enabled = commit(base, plan.mutations);
			const renamed = commit(enabled, [
				{
					kind: "updateField",
					uuid: Q("age"),
					targetKind: "int",
					patch: { id: "score" },
				},
			]);
			const moved = commit(renamed, [
				{
					kind: "moveField",
					uuid: Q("age"),
					toParentUuid: Q("group"),
					after: null,
				},
			]);
			expect(moved.forms[Q("form")].connect).toEqual(
				enabled.forms[Q("form")].connect,
			);
			if (mode === "learn")
				expect(
					formExpressionSource(
						moved.forms[Q("form")],
						"assessment_user_score",
						moved,
					),
				).toBe("/data/group/score * 10");
			else {
				expect(
					formExpressionSource(
						moved.forms[Q("form")],
						"deliver_entity_id",
						moved,
					),
				).toBe("concat(#form/group/score, '-', today())");
				expect(
					formExpressionSource(
						moved.forms[Q("form")],
						"deliver_entity_name",
						moved,
					),
				).toBe("#form/group/score");
			}
		},
	);
});
// Case-property renames have an app-wide semantic cascade, unlike field identity.
// Their admitted predicate/automation/relation carriers live in casePropertyRenames.test.ts.
