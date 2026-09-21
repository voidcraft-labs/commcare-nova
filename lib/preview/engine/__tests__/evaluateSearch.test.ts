import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { hiddenSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import { input, literal, matchesPattern, term } from "@/lib/domain/predicate";
import { evaluateSearch } from "../evaluateForm";
import { previewAsMe } from "../identity";

it("keeps the search draft and validation between bounded calls, and submits hidden values only after correction", async () => {
	const name = testUuid("11111111-1111-4111-8111-111111111111");
	const phone = testUuid("22222222-2222-4222-8222-222222222222");
	const doc = buildDoc({
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					searchInputs: [
						simpleSearchInputDef(name, "name", "Name", "text", "case_name", {
							default: term(literal("Initial name")),
							required: {},
						}),
						simpleSearchInputDef(phone, "phone", "Phone", "text", "phone", {
							validation: {
								rule: matchesPattern(input(phone), "^[0-9]{3}$"),
								message: "Use three digits",
							},
						}),
						hiddenSearchInputDef(
							testUuid("33333333-3333-4333-8333-333333333333"),
							"region",
							"Region",
							term(literal("north")),
						),
					],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ id: "note", kind: "text" })],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	doc.modules[moduleUuid].caseSearchConfig = { searchFirst: true };
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (!identity) throw new Error("Missing identity");
	const context = {
		identity,
		cases: { rows: [], indices: [] },
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
	};
	const opened = await evaluateSearch(doc, { moduleUuid }, context);
	expect(opened.draft).toContainEqual({ name: "name", value: "Initial name" });
	expect(opened.hasSubmitted).toBe(false);
	const invalid = await evaluateSearch(
		doc,
		{
			moduleUuid,
			answers: [
				{ name: "name", value: "Maya" },
				{ name: "phone", value: "bad" },
			],
		},
		context,
	);
	expect(invalid.errors).toEqual({ phone: "Use three digits" });
	expect(invalid.submitted).toBeUndefined();
	const entry = { draft: invalid.draft, errors: invalid.errors };
	const observed = await evaluateSearch(doc, { moduleUuid, entry }, context);
	expect(observed.draft).toEqual(invalid.draft);
	expect(observed.errors).toEqual(invalid.errors);
	const corrected = await evaluateSearch(
		doc,
		{ moduleUuid, entry, answers: [{ name: "phone", value: "123" }] },
		context,
	);
	expect(corrected.errors).toEqual({});
	expect(corrected.submitted).toEqual(
		expect.arrayContaining([
			{ name: "name", value: "Maya" },
			{ name: "phone", value: "123" },
			{ name: "region", value: "north" },
		]),
	);
	await expect(
		evaluateSearch(
			doc,
			{ moduleUuid, answers: [{ name: "region", value: "south" }] },
			context,
		),
	).rejects.toThrow("unavailable");
});
