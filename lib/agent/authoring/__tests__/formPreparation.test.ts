import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { walkExpression } from "@/lib/domain/expression/walk";

it("omits blank optional creation logic, clears edited logic, and refuses a blank required expression atomically", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{ name: "Survey", forms: [{ name: "Questions", type: "survey" }] },
		]),
	);
	expect(
		await h.call("addFields", {
			formUuid: "Questions",
			fields: [
				{ kind: "int", id: "age", label: "Age", relevant: " ", required: true },
			],
		}),
	).toMatchObject({ ok: true });
	const age = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "age",
	);
	if (age?.kind !== "int") throw new Error("Missing age question");
	expect(age.relevant).toBeUndefined();
	expect(
		await h.call("editField", {
			fieldUuid: age.uuid,
			updates: { required: " " },
		}),
	).toMatchObject({ ok: true });
	expect(h.currentDoc().fields[age.uuid]).not.toHaveProperty("required");
	const before = h.currentDoc();
	await expect(
		h.call("editField", {
			fieldUuid: age.uuid,
			updates: { validate: { expr: " ", msg: "Enter an age." } },
		}),
	).rejects.toThrow("cannot be empty");
	expect(h.currentDoc()).toBe(before);
});

it("binds final sibling, option and parent identities before decoding a forward creation batch", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{ name: "Survey", forms: [{ name: "Questions", type: "survey" }] },
		]),
	);
	const result = await h.call("addFields", {
		formUuid: "Questions",
		fields: [
			{
				kind: "hidden",
				id: "score",
				parentUuid: "details",
				calculate: "if(../choice = 'yes', 1, 0)",
			},
			{
				kind: "single_select",
				id: "choice",
				parentUuid: "details",
				label: "Choice",
				optionsSource: {
					kind: "inline",
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
				},
			},
			{ kind: "group", id: "details", label: "Details" },
		],
	});
	expect(result).toMatchObject({ ok: true });
	const fields = Object.values(h.currentDoc().fields);
	const choice = fields.find((field) => field.id === "choice");
	const score = fields.find((field) => field.id === "score");
	if (
		choice?.kind !== "single_select" ||
		choice.optionsSource.kind !== "inline" ||
		score?.kind !== "hidden" ||
		score.calculate === undefined
	)
		throw new Error("Missing created fields");
	expect(score.calculate).toMatchObject({
		kind: "if",
		cond: {
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "field", uuid: choice.uuid, spelling: "relative" },
			},
			right: {
				kind: "term",
				term: {
					kind: "choice",
					field: choice.uuid,
					options: [choice.optionsSource.options[0].uuid],
				},
			},
		},
	});
	expect(await h.call("getField", { fieldUuid: score.uuid })).toMatchObject({
		field: { calculate: "if(../choice = 'yes', 1, 0)" },
	});
});

it("keeps an unchanged choice occurrence bound while the same edit renames its option value", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{ name: "Survey", forms: [{ name: "Questions", type: "survey" }] },
		]),
	);
	expect(
		await h.call("addFields", {
			formUuid: "Questions",
			fields: [
				{
					kind: "single_select",
					id: "choice",
					label: "Choice",
					validate: { expr: ". = 'yes'", msg: "Choose yes." },
					optionsSource: {
						kind: "inline",
						options: [
							{ value: "yes", label: "Yes" },
							{ value: "no", label: "No" },
						],
					},
				},
			],
		}),
	).toMatchObject({ ok: true });
	const field = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "choice",
	);
	if (field?.kind !== "single_select" || field.optionsSource.kind !== "inline")
		throw new Error("Missing choices");
	const [yes, no] = field.optionsSource.options;
	expect(
		await h.call("editField", {
			fieldUuid: field.uuid,
			updates: {
				validate: { expr: ". = 'yes'", msg: "Choose yes." },
				optionsSource: {
					kind: "inline",
					options: [
						{ optionUuid: yes.uuid, value: "accepted", label: "Yes" },
						{ optionUuid: no.uuid, value: "rejected", label: "No" },
					],
				},
			},
		}),
	).toMatchObject({ ok: true });
	expect(await h.call("getField", { fieldUuid: field.uuid })).toMatchObject({
		field: { validate: { expr: ". = 'accepted'", msg: "Choose yes." } },
	});
});

it("declares generated count names from the complete batch before binding another expression", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{ name: "Survey", forms: [{ name: "Questions", type: "survey" }] },
		]),
	);
	expect(
		await h.call("addFields", {
			formUuid: "Questions",
			fields: [
				{
					kind: "label",
					id: "summary",
					label: "Items",
					relevant: "../nova_count_items_1 > 0",
				},
				{ kind: "int", id: "count", label: "Count" },
				{
					kind: "text",
					id: "nova_count_items",
					label: "An authored name collision",
				},
				{
					kind: "repeat",
					id: "items",
					label: "Items",
					repeat: { mode: "count_bound", count: "#form/count" },
				},
				{ kind: "text", id: "answer", label: "Answer", parentUuid: "items" },
			],
		}),
	).toMatchObject({ ok: true });
	const repeat = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "items",
	);
	const summary = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "summary",
	);
	if (
		summary?.kind !== "label" ||
		summary.relevant === undefined ||
		repeat === undefined
	)
		throw new Error("Missing repeat");
	const nodes: unknown[] = [];
	walkExpression(summary.relevant, {
		visitTerm: (term) => {
			if (term.kind === "form-node") nodes.push(term.node);
		},
	});
	expect(nodes).toEqual([
		{ kind: "repeat", repeat: repeat.uuid, role: "count-result" },
	]);
	expect(await h.call("getField", { fieldUuid: summary.uuid })).toMatchObject({
		field: { relevant: "../nova_count_items_1 > 0" },
	});
});

it("binds Connect scoring and record naming from their real pending evaluation nodes", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture(
			[
				{
					name: "People",
					caseType: "person",
					forms: [{ name: "Visit", type: "followup" }],
				},
			],
			// The app becomes a Connect app, which runs on Android alone.
			{ runsOnlyOn: "android" },
		),
	);
	expect(
		await h.call("addFields", {
			formUuid: "Visit",
			fields: [{ kind: "int", id: "score", label: "Score" }],
		}),
	).toMatchObject({ ok: true });
	expect(
		await h.call("configureConnect", {
			mode: "learn",
			participants: [
				{
					formUuid: "Visit",
					connect: { assessment: { user_score: "../../../score" } },
				},
			],
		}),
	).toMatchObject({ ok: true });
	expect(await h.call("getForm", { formUuid: "Visit" })).toMatchObject({
		form: { connect: { assessment: { user_score: "../../../score" } } },
	});
	expect(
		await h.call("updateForm", {
			formUuid: "Visit",
			recordName: "concat('Person ', ../score)",
		}),
	).toMatchObject({ ok: true });
	expect(await h.call("getForm", { formUuid: "Visit" })).toMatchObject({
		recordName: "concat('Person ', ../score)",
	});
});

it.each(["editField", "setFieldOptionsSource"])(
	"%s preserves expressions when inline choices become case-backed",
	async (tool) => {
		const h = makeAuthoringHarness(
			{},
			namedFormFixture([
				{ name: "Survey", forms: [{ name: "Questions", type: "survey" }] },
				{
					name: "Patients",
					caseType: "patient",
					forms: [{ name: "Visit", type: "followup" }],
				},
			]),
		);
		expect(
			await h.call("addFields", {
				formUuid: "Questions",
				fields: [
					{
						kind: "single_select",
						id: "choice",
						label: "Choice",
						optionsSource: {
							kind: "inline",
							options: [
								{ value: "yes", label: "Yes" },
								{ value: "no", label: "No" },
							],
						},
					},
					{
						kind: "label",
						id: "explanation",
						label: "More information",
						relevant: "#form/choice = 'yes'",
					},
				],
			}),
		).toMatchObject({ ok: true });
		const field = Object.values(h.currentDoc().fields).find(
			(item) => item.id === "choice",
		);
		const dependent = Object.values(h.currentDoc().fields).find(
			(item) => item.id === "explanation",
		);
		if (field === undefined || dependent === undefined)
			throw new Error("Missing fixture questions");
		const removedChoices = {
			kind: "inline",
			options: [
				{ value: "maybe", label: "Maybe" },
				{ value: "later", label: "Later" },
			],
		};
		const beforeRemoval = h.currentDoc();
		expect(
			await h.call(
				tool,
				tool === "editField"
					? {
							fieldUuid: field.uuid,
							updates: { optionsSource: removedChoices },
						}
					: { fieldUuid: field.uuid, source: removedChoices },
			),
		).toMatchObject({ error: expect.any(String) });
		expect(h.currentDoc()).toBe(beforeRemoval);
		const source = {
			kind: "cases",
			caseType: "patient",
			labelProperty: "case_name",
		};
		expect(
			await h.call(
				tool,
				tool === "editField"
					? {
							fieldUuid: field.uuid,
							updates: { optionsSource: source },
						}
					: { fieldUuid: field.uuid, source },
			),
		).toMatchObject({ ok: true, preservedChoiceCount: 1 });
		expect(h.currentDoc().fields[dependent.uuid]).toMatchObject({
			relevant: {
				kind: "eq",
				right: { kind: "term", term: { kind: "literal", value: "yes" } },
			},
		});
		expect(
			await h.call("getField", { fieldUuid: dependent.uuid }),
		).toMatchObject({
			field: { relevant: "#form/choice = 'yes'" },
		});
	},
);

it("prepares new after-submit link slots and binds carried selection names to the destination", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Intake",
				caseType: "patient",
				forms: [{ name: "Register", type: "registration" }],
			},
			{
				name: "Care",
				caseType: "patient",
				forms: [{ name: "Visit", type: "followup" }],
			},
		]),
	);
	const target = { type: "form", moduleUuid: "Care", formUuid: "Visit" };
	expect(
		await h.call("addFormLinks", {
			formUuid: "Register",
			links: [
				{
					link: {
						target,
						condition: "true()",
						datums: [{ name: "case_id", xpath: "#patient/case_id" }],
					},
				},
			],
		}),
	).toMatchObject({ ok: true });
	const sourceForm = Object.values(h.currentDoc().forms).find(
		(form) => form.name === "Register",
	);
	const targetModule = Object.values(h.currentDoc().modules).find(
		(module) => module.name === "Care",
	);
	if (sourceForm === undefined || targetModule === undefined)
		throw new Error("Missing form-link fixture");
	expect(sourceForm.formLinks?.[0]?.datums).toEqual([
		{
			name: { kind: "selected-case", module: targetModule.uuid },
			xpath: {
				kind: "term",
				term: { kind: "form-case", caseType: "patient", property: "case_id" },
			},
		},
	]);
	expect(await h.call("getForm", { formUuid: sourceForm.uuid })).toMatchObject({
		form: {
			formLinks: [
				{
					condition: "true()",
					datums: [{ name: "case_id", xpath: "#patient/case_id" }],
				},
			],
		},
	});
	const before = h.currentDoc();
	await expect(
		h.call("addFormLinks", {
			formUuid: sourceForm.uuid,
			links: [
				{
					link: {
						target,
						condition: "true()",
						datums: [{ name: "not_a_selection", xpath: "'missing'" }],
					},
				},
			],
		}),
	).rejects.toThrow();
	expect(h.currentDoc()).toBe(before);
	const link = sourceForm.formLinks?.[0];
	if (link === undefined) throw new Error("Missing prepared form link");
	expect(
		await h.call("updateFormLink", {
			formUuid: sourceForm.uuid,
			linkUuid: link.uuid,
			link: {
				target,
				condition: "",
				datums: [{ name: "case_id", xpath: "#patient/case_id" }],
			},
		}),
	).toMatchObject({ ok: true });
	expect(
		h.currentDoc().forms[sourceForm.uuid]?.formLinks?.[0]?.condition,
	).toBeUndefined();
});
