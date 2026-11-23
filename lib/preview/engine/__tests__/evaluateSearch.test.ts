import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { hiddenSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import { input, literal, matchesPattern, term } from "@/lib/domain/expression";
import { evaluateSearch } from "../evaluateForm";
import { previewAsMe } from "../identity";
import type { SearchEvaluationInput } from "../searchEvaluation";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

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
	doc.modules[moduleUuid].caseSearchConfig = { formsReadSearch: true };
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (!identity) throw new Error("Missing identity");
	const context = {
		identity,
		device: webAppsDevice(),
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

it("opens and submits the worker platform’s date-range values and keeps internal answers private", async () => {
	const raw = "2024-01-02__2024-02-12__2024-05-21";
	const screen = (
		value: string,
		platform: "web-apps" | "android",
		workflow: "searchFirst" | "skipToResults" = "searchFirst",
	) => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "person",
					properties: [{ name: "dates", label: "Dates", data_type: "date" }],
				},
			],
			modules: [
				{
					name: "Visits",
					caseType: "person",
					caseSearchConfig: workflow === "searchFirst" ? {} : { workflow },
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						searchInputs: [
							simpleSearchInputDef(
								testUuid("tested-period"),
								"dates",
								"Dates",
								"date-range",
								"dates",
								{ default: term(literal(value)) },
							),
						],
					},
					forms: [],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
		if (!identity) throw new Error("Missing worker.");
		const context = {
			identity,
			device: { ...webAppsDevice(), platform },
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		};
		return (
			answers?: { name: string; value: string }[],
			entry?: SearchEvaluationInput["entry"],
		) => evaluateSearch(doc, { moduleUuid, answers, entry }, context);
	};
	const web = screen(raw, "web-apps");
	const shown = await web();
	expect(shown.draft).toContainEqual({
		name: "dates:starting",
		value: "__range__" + raw,
	});
	expect(shown.displayedAnswers).toEqual([
		{ name: "dates", value: "1/2/2024 to 2/12/2024 to 5/21/2024" },
	]);
	expect((await web([])).errors).toEqual({
		dates: "Choose valid start and end dates",
	});
	await expect(
		web([{ name: "dates:starting", value: "injected" }]),
	).rejects.toThrow("unavailable");
	expect(
		(await web([{ name: "dates:from", value: "2024-06-01" }])).errors,
	).toEqual({ dates: "Choose both a start date and an end date" });
	expect(
		(
			await web([
				{ name: "dates:from", value: "2024-06-01" },
				{ name: "dates:to", value: "2024-06-30" },
			])
		).submitted,
	).toEqual([
		{ name: "dates:from", value: "2024-06-01" },
		{ name: "dates:to", value: "2024-06-30" },
	]);
	expect((await screen(raw, "web-apps", "skipToResults")()).submitted).toEqual([
		{ name: "dates:starting", value: raw },
	]);
	await expect(screen("yesterday", "web-apps")()).rejects.toThrow();
	const resumed = await screen("yesterday", "web-apps")(undefined, {
		draft: shown.draft,
		errors: {},
	});
	expect(resumed.displayedAnswers).toEqual(shown.displayedAnswers);
	const cleared = await screen("yesterday", "web-apps")([], {
		draft: [],
		errors: {},
	});
	expect(cleared.submitted).toEqual([]);
	expect((await screen("yesterday", "android")([])).submitted).toEqual([
		{ name: "dates:starting", value: "yesterday" },
	]);
});

/* Web Apps draws the box to also find blank and sends it ticked; Android draws
 * none and reads no `allow_blank_value`, so a run there takes no such answer.
 * The box's answer is true alone: an unticked box is an answer left out. */
it("takes a search for blank on Web Apps alone, and only as true", async () => {
	const doc = buildDoc({
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					searchInputs: [
						simpleSearchInputDef(
							testUuid("blank-village"),
							"village",
							"Village",
							"text",
							"village",
							{ allowBlank: true },
						),
					],
				},
				forms: [],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (!identity) throw new Error("Missing worker.");
	const run = (device: ReturnType<typeof webAppsDevice>, value: string) =>
		evaluateSearch(
			doc,
			{ moduleUuid, answers: [{ name: "village:blank", value }] },
			{
				identity,
				device,
				cases: { rows: [], indices: [] },
				lookup: {
					projectRevision: "0",
					definitions: [],
					rowsByTable: new Map(),
				},
			},
		);
	expect((await run(webAppsDevice(), "true")).submitted).toEqual([
		{ name: "village:blank", value: "true" },
	]);
	await expect(run(webAppsDevice(), "yes")).rejects.toThrow(
		"Search answer village:blank says the worker also searched for blank, so its value is true.",
	);
	await expect(run(androidDevice(), "true")).rejects.toThrow(
		"Android's Search screen shows village without the box to also find blank",
	);
});
