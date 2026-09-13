import { describe, expect, it } from "vitest";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema, proseText } from "@/lib/domain";
import { projectBlueprintImplementation } from "../blueprint";

function fixture() {
	const doc = buildDoc({
		appName: "Garden",
		caseTypes: [
			{
				name: "plot",
				properties: [
					{
						name: "beds",
						label: proseText("Beds"),
						data_type: "int",
						validation: xp(". >= 1"),
					},
				],
			},
		],
		modules: [
			{
				name: "Plots",
				caseType: "plot",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "plot_name",
								label: proseText("Plot name"),
								caseWrite: { caseType: "plot", property: "case_name" },
							}),
							f({
								kind: "int",
								id: "count",
								label: proseText("Number of beds"),
								required: xp("true()"),
								validate: xp(". >= 1 and . <= 50"),
								validate_msg: proseText("Enter 1 to 50."),
								caseWrite: { caseType: "plot", property: "beds" },
							}),
							f({ kind: "text", id: "comment", label: proseText("Comment") }),
						],
					},
					{
						name: "Register",
						type: "survey",
						fields: [
							f({ kind: "text", id: "comment", label: proseText("Comment") }),
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}

describe("current Blueprint implementation", () => {
	it("keeps form identity, wording and rule scope distinct from actual field-driven writes", () => {
		const doc = fixture();
		const result = projectBlueprintImplementation(doc);
		expect(result.unreadable).toEqual([]);
		expect(result.records[0].properties[0].definition).toMatchObject({
			label: "Beds",
			validation: ". >= 1",
		});
		const forms = result.modules[0].forms;
		expect(forms[0].uuid).not.toBe(forms[1].uuid);
		expect(forms[0].definition).toMatchObject({
			name: "Register",
			fields: expect.arrayContaining([
				expect.objectContaining({
					id: "count",
					label: "Number of beds",
					required: "true()",
					validate: { expr: ". >= 1 and . <= 50", msg: "Enter 1 to 50." },
				}),
			]),
		});
		expect(forms[0].fieldActions).toEqual([
			{
				kind: "primary",
				action: "create",
				caseType: "plot",
				writes: doc.fieldOrder[forms[0].uuid]
					.slice(0, 2)
					.map((fieldUuid, i) => ({
						fieldUuid,
						property: i === 0 ? "case_name" : "beds",
					})),
			},
		]);
		expect(forms[1].fieldActions).toEqual([]);
		const renamed = structuredClone(doc);
		renamed.forms[forms[0].uuid].name = "Start a plot";
		const next = projectBlueprintImplementation(renamed);
		expect(next.modules[0].forms[0].uuid).toBe(forms[0].uuid);
		expect(next.snapshotDigest).not.toBe(result.snapshotDigest);
		expect(next.digest).not.toBe(result.digest);
		const reordered = {
			...doc,
			fields: Object.fromEntries(Object.entries(doc.fields).reverse()),
			fieldParent: {},
		};
		expect(projectBlueprintImplementation(reordered)).toEqual(result);
	});

	it("reports an unreadable private section without hiding the remaining candidate or treating it as absent", () => {
		const doc = fixture();
		const moduleUuid = doc.moduleOrder[0];
		// The private candidate references a child catalog not yet declared.
		doc.modules[moduleUuid].displayCondition = {
			kind: "exists",
			via: { kind: "subcase", ofCaseType: "check", identifier: "parent" },
			where: { kind: "match-all" },
		};
		blueprintDocSchema.parse(toPersistableDoc(doc));
		const result = projectBlueprintImplementation(doc);
		expect(result.modules[0]).toMatchObject({
			uuid: moduleUuid,
			definition: null,
		});
		expect(result.unreadable).toEqual([
			expect.objectContaining({
				kind: "module",
				id: moduleUuid,
				reason: expect.any(String),
			}),
		]);
		expect(result.modules[0].forms[1].definition).toMatchObject({
			type: "survey",
		});
		expect(result.records[0].properties[0].definition).toMatchObject({
			label: "Beds",
		});
		const repaired = projectBlueprintImplementation({
			...doc,
			caseTypes: [
				...(doc.caseTypes ?? []),
				{
					name: "check",
					parent_type: "plot",
					relationship: "child",
					properties: [],
				},
			],
		});
		expect(repaired.unreadable).toEqual([]);
		expect(repaired.modules[0].definition).toMatchObject({
			displayCondition: "exists(children('check', 'parent'), true())",
		});
	});
});
