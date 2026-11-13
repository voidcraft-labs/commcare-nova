/**
 * A generated node's base name writes its owner's id as it stands, hyphens
 * included. An authored question named like that base (a question ID HQ's
 * form builder takes) makes the allocator step to the next suffix, so a
 * generated node never shares a name with an authored one.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { questionIdProblem } from "@/lib/domain/questionId";
import { planGeneratedNodes } from "../xform/generatedNodes";

function form() {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: "Name" }],
			},
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
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "first-name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "hidden",
								id: "nova_trimmed_first-name",
								calculate: "'authored'",
							}),
							f({ kind: "int", id: "visit-rows" }),
							f({
								kind: "repeat",
								id: "visits",
								repeat_mode: "count_bound",
								repeat_count: "#form/visit-rows + 1",
								children: [f({ kind: "text", id: "note" })],
							}),
							f({
								kind: "hidden",
								id: "nova_count_visits",
								calculate: "'authored'",
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const uuidOf = (id: string) => {
		const field = Object.values(doc.fields).find((field) => field.id === id);
		if (field === undefined) throw new Error(`no field ${id}`);
		return field.uuid;
	};
	return { plan: planGeneratedNodes(doc, formUuid), uuidOf };
}

describe("generated names beside hyphenated question IDs", () => {
	it("steps past an authored sibling named as a hyphenated owner's base", () => {
		const { plan, uuidOf } = form();
		expect(plan.trimmed(uuidOf("first-name"))).toBe(
			"nova_trimmed_first-name_1",
		);
		expect(plan.count(uuidOf("visits"))).toBe("nova_count_visits_1");
	});

	it("gives every generated name of the root a distinct question ID HQ's form builder takes", () => {
		const { plan, uuidOf } = form();
		const names = [
			plan.trimmed(uuidOf("first-name")),
			plan.count(uuidOf("visits")),
			"first-name",
			"nova_trimmed_first-name",
			"visit-rows",
			"visits",
			"nova_count_visits",
		];
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(questionIdProblem(name)).toBeUndefined();
	});
});
