import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { proseText } from "@/lib/domain";

const authoring = () => makeAuthoringHarness();

async function fixture() {
	return makeAuthoringHarness(
		{},
		buildDoc({
			caseTypes: ["plot", "garden"].map((name) => ({
				name,
				properties: [
					{
						name: "beds",
						label: proseText("Beds"),
						data_type: "int" as const,
						hint: proseText("Original hint"),
						required: xp("true()"),
						validation: xp(". >= 1"),
						validation_msg: proseText("Enter at least one bed."),
					},
				],
			})),
			modules: [
				{
					name: "Plots",
					caseType: "plot",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Plot" },
					]),
					forms: [
						{
							name: "Register plot",
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
									id: "bed_count",
									label: proseText("Beds in this plot"),
									hint: proseText("Question-specific help"),
									validate: {
										expr: xp(". >= 1 and . <= 50"),
										msg: proseText("Enter 1 to 50."),
									},
									caseWrite: { caseType: "plot", property: "beds" },
								}),
							],
						},
					],
				},
			],
		}),
	);
}

describe("record property authoring", () => {
	it("removes unused definitions together but refuses an app writer or built-in metadata without a partial edit", async () => {
		const h = await fixture();
		const before = structuredClone(h.currentDoc());
		expect(
			await h.call("removeCaseProperties", {
				properties: [
					{ caseType: "garden", property: "beds" },
					{ caseType: "plot", property: "beds" },
				],
			}),
		).toHaveProperty("error");
		expect(h.currentDoc()).toEqual(before);
		expect(
			await h.call("removeCaseProperties", {
				properties: [{ caseType: "plot", property: "case_name" }],
			}),
		).toHaveProperty("error");
		expect(
			await h.call("removeCaseProperties", {
				properties: [{ caseType: "garden", property: "beds" }],
			}),
		).toMatchObject({ ok: true });
		expect(
			h
				.currentDoc()
				.caseTypes?.find((type) => type.name === "garden")
				?.properties.some((property) => property.name === "beds"),
		).toBe(false);
	});

	it("declares an empty catalog and reports an unchanged declaration without another write", async () => {
		const h = authoring();
		const input = { caseTypes: [{ name: "plot", properties: [] }] };
		expect(await h.call("generateSchema", input)).toMatchObject({
			ok: true,
			recorded: ["plot"],
		});
		const before = structuredClone(h.currentDoc());
		expect(await h.call("generateSchema", input)).toMatchObject({
			ok: true,
			recorded: [],
			unchanged: ["plot"],
		});
		expect(h.currentDoc()).toEqual(before);
	});
	it("edits wording while preserving stored rules, other records, and form content", async () => {
		const h = await fixture();
		const before = structuredClone(h.currentDoc());
		expect(
			await h.call("getCaseProperty", { caseType: "plot", property: "beds" }),
		).toMatchObject({
			caseType: "plot",
			property: {
				name: "beds",
				label: "Beds",
				data_type: "int",
				required: "true()",
				validation: ". >= 1",
				validation_msg: "Enter at least one bed.",
			},
		});
		expect(
			await h.call("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: {
					label: "Number of beds",
					hint: null,
				},
			}),
		).toMatchObject({ ok: true });
		expect(
			await h.call("getCaseProperty", { caseType: "plot", property: "beds" }),
		).toEqual({
			caseType: "plot",
			property: {
				name: "beds",
				label: "Number of beds",
				data_type: "int",
				required: "true()",
				validation: ". >= 1",
				validation_msg: "Enter at least one bed.",
			},
		});
		expect(
			h.currentDoc().caseTypes?.find((record) => record.name === "garden"),
		).toEqual(before.caseTypes?.find((record) => record.name === "garden"));
		expect(h.currentDoc().forms).toEqual(before.forms);
		expect(h.currentDoc().fields).toEqual(before.fields);
		const writes = h.recordMutations.mock.calls.length;
		expect(
			await h.call("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: { label: "Number of beds", hint: null },
			}),
		).toMatchObject({ ok: true });
		expect(h.recordMutations).toHaveBeenCalledTimes(writes);
	});

	it("refuses missing targets and options inconsistent with the stored type without changing the app", async () => {
		const h = await fixture();
		const before = structuredClone(h.currentDoc());
		expect(
			await h.call("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: { options: [{ value: "one", label: "One" }] },
			}),
		).toHaveProperty("error");
		expect(h.currentDoc()).toEqual(before);
		for (const name of ["getCaseProperty", "updateCaseProperty"]) {
			expect(
				await h.call(name, {
					caseType: "plot",
					property: "absent",
					...(name === "updateCaseProperty"
						? { updates: { label: "Absent" } }
						: {}),
				}),
			).toHaveProperty("error");
		}
		expect(h.currentDoc()).toEqual(before);
		for (const updates of [
			{},
			{ name: "renamed" },
			{ data_type: "decimal" },
			{ label: null },
		])
			await expect(
				h.call("updateCaseProperty", {
					caseType: "plot",
					property: "beds",
					updates,
				}),
			).rejects.toThrow();
	});

	it.each(["required", "validation", "validation_msg"])(
		"refuses authoring the retired catalog rule %s through creation or update",
		async (key) => {
			const h = await fixture();
			const before = structuredClone(h.currentDoc());
			for (const value of [
				null,
				key === "validation_msg" ? "Enter an age." : "true()",
			]) {
				await expect(
					h.call("generateSchema", {
						caseTypes: [
							{
								name: "visit",
								properties: [{ name: "age", label: "Age", [key]: value }],
							},
						],
					}),
				).rejects.toThrow();
				await expect(
					h.call("updateCaseProperty", {
						caseType: "plot",
						property: "beds",
						updates: { [key]: value },
					}),
				).rejects.toThrow();
				expect(h.currentDoc()).toEqual(before);
			}
		},
	);

	it.each([
		{ required: xp("true()") },
		{
			validation: xp(". >= 1"),
			validation_msg: proseText("Enter at least one bed."),
		},
	])(
		"preserves stored rules when extending an otherwise bare catalog",
		async (rules) => {
			const h = makeAuthoringHarness(
				{},
				buildDoc({
					caseTypes: [
						{
							name: "plot",
							properties: [
								{
									name: "beds",
									label: proseText("beds"),
									data_type: "int",
									...rules,
								},
							],
						},
					],
					modules: [
						{
							name: "Observations",
							forms: [
								{
									name: "Record an observation",
									type: "survey",
									fields: [f({ kind: "text", id: "notes" })],
								},
							],
						},
					],
				}),
			);
			const before = structuredClone(h.currentDoc());
			expect(
				await h.call("generateSchema", {
					caseTypes: [
						{
							name: "plot",
							properties: [{ name: "beds", label: "beds", data_type: "int" }],
						},
					],
				}),
			).toHaveProperty("error");
			expect(h.currentDoc()).toEqual(before);
			expect(
				await h.call("generateSchema", {
					caseTypes: [
						{
							name: "plot",
							properties: [
								{ name: "area", label: "Area", data_type: "decimal" },
							],
						},
					],
				}),
			).toMatchObject({ ok: true, extended: ["plot"] });
			expect(
				h.currentDoc().caseTypes?.find((record) => record.name === "plot")
					?.properties,
			).toEqual([
				...(before.caseTypes?.find((record) => record.name === "plot")
					?.properties ?? []),
				{ name: "area", label: proseText("Area"), data_type: "decimal" },
			]);
		},
	);
});
