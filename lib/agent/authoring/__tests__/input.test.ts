import { v7 as uuidv7 } from "uuid";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import {
	echoLookupDefinitions,
	type MakeToolWorkspaceHarnessOptions,
} from "@/lib/agent/__tests__/fixtures";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import {
	type BlueprintDoc,
	orderedCaseOperations,
	translationUnitsById,
} from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";

function authoring(
	options: MakeToolWorkspaceHarnessOptions = {},
	initialDoc?: BlueprintDoc,
) {
	const harness = makeAuthoringHarness(options, initialDoc);
	async function call(name: string, input: unknown) {
		const result = await harness.call(name, input);
		expect(result, name).not.toHaveProperty("error");
		return result;
	}
	return { ...harness, call };
}

it("uses scoped short names for nested questions, wording, conditions, edits and insertion anchors", async () => {
	const h = authoring(
		{},
		namedFormFixture([
			{
				name: "Garden",
				forms: [
					{ name: "Weekly check", type: "survey" },
					{ name: "Other check", type: "survey" },
				],
			},
		]),
	);
	await h.call("addFields", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		fields: [
			{ kind: "group", id: "details", label: "Check details" },
			{
				kind: "date",
				id: "check_date",
				parentUuid: "details",
				label: "Check date",
			},
			{
				kind: "label",
				id: "confirmation",
				label: "Checked on {{check_date}}",
				relevant: "#form/check_date != ''",
			},
		],
	});
	await h.call("removeField", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		fieldUuid: "fixture_placeholder",
	});
	await h.call("addFields", {
		moduleUuid: "Garden",
		formUuid: "Other check",
		fields: [{ kind: "date", id: "check_date", label: "Other date" }],
	});
	await h.call("removeField", {
		moduleUuid: "Garden",
		formUuid: "Other check",
		fieldUuid: "fixture_placeholder",
	});
	const doc = h.currentDoc();
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Weekly check",
	);
	const group = Object.values(doc.fields).find(
		(field) => field.id === "details",
	);
	const date = Object.values(doc.fields).find(
		(field) =>
			field.id === "check_date" && doc.fieldParent[field.uuid] === group?.uuid,
	);
	const confirmation = Object.values(doc.fields).find(
		(field) => field.id === "confirmation",
	);
	if (!form || !group || !date || confirmation?.kind !== "label")
		throw new Error("Missing check fields.");
	expect(confirmation.label.parts).toContainEqual({
		kind: "field-ref",
		uuid: date.uuid,
	});
	expect(confirmation.relevant?.parts).toContainEqual({
		kind: "field-ref",
		uuid: date.uuid,
	});
	await expect(
		h.call("editField", {
			formUuid: "Weekly check",
			fieldUuid: "confirmation",
			updates: { relevant: "/data/check_date != ''" },
		}),
	).rejects.toThrow("Unknown or ambiguous reference");
	expect(h.currentDoc()).toBe(doc);
	await h.call("editField", {
		formUuid: "Weekly check",
		fieldUuid: "confirmation",
		updates: { relevant: "/data/details/check_date != ''" },
	});
	expect(h.currentDoc().fields[confirmation.uuid]).toMatchObject({
		relevant: {
			parts: expect.arrayContaining([{ kind: "path-ref", uuid: date.uuid }]),
		},
	});
	await h.call("addFields", {
		formUuid: "Weekly check",
		parentUuid: "details",
		afterFieldUuid: "check_date",
		fields: [{ kind: "text", id: "note", label: "Note about {{check_date}}" }],
	});
	const note = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "note",
	);
	expect(h.currentDoc().fieldOrder[group.uuid]).toEqual([
		date.uuid,
		note?.uuid,
	]);
	await h.call("editField", {
		formUuid: "Weekly check",
		fieldUuid: "check_date",
		updates: { id: "visit_date" },
	});
	expect(h.currentDoc().fields[confirmation.uuid]).toMatchObject({
		label: {
			parts: expect.arrayContaining([{ kind: "field-ref", uuid: date.uuid }]),
		},
	});
	await h.call("addFields", {
		formUuid: "Weekly check",
		fields: [
			{ kind: "group", id: "history", label: "History" },
			{
				kind: "date",
				id: "visit_date",
				parentUuid: "history",
				label: "Past date",
			},
		],
	});
	const before = h.currentDoc();
	await expect(
		h.call("editField", {
			formUuid: "Weekly check",
			fieldUuid: "visit_date",
			updates: { label: "Changed" },
		}),
	).rejects.toThrow("ambiguous");
	expect(h.currentDoc()).toBe(before);
	await h.call("editField", {
		formUuid: "Weekly check",
		fieldUuid: "details/visit_date",
		updates: { label: "Visit date" },
	});
	expect(h.currentDoc().fields[date.uuid]).toMatchObject({
		label: { parts: [{ kind: "text", text: "Visit date" }] },
	});
});

it("binds new questions, case operations, and case-list order without predeclared identities", async () => {
	const h = authoring(
		{},
		namedFormFixture([
			{
				name: "Clients",
				caseType: "client",
				forms: [{ name: "Visit", type: "close" }],
			},
		]),
	);
	await h.call("generateSchema", {
		caseTypes: [
			{
				name: "client",
				properties: [{ name: "case_name", label: "Name", data_type: "text" }],
			},
			{
				name: "visit",
				properties: [{ name: "source_id", label: "Source", data_type: "text" }],
			},
		],
	});
	await h.call("addFields", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fields: [
			{ kind: "text", id: "name", label: "Visit name" },
			{ kind: "group", id: "confirmation", label: "Confirmation" },
			{
				kind: "single_select",
				id: "done",
				parentUuid: "confirmation",
				label: "Finished?",
				optionsSource: {
					kind: "inline",
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
				},
			},
		],
	});
	await h.call("updateForm", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		close_condition: { fieldUuid: "done", answer: "yes" },
	});
	await h.call("removeField", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fieldUuid: "fixture_placeholder",
	});
	const form = Object.values(h.currentDoc().forms).find(
		(item) => item.name === "Visit",
	);
	const done = Object.values(h.currentDoc().fields).find(
		(item) => item.id === "done",
	);
	if (!form || !done) throw new Error("Missing visit form.");
	expect(form.closeCondition).toMatchObject({
		field: done.uuid,
		answer: "yes",
	});
	await h.call("editField", {
		formUuid: "Visit",
		fieldUuid: "done",
		updates: { id: "finished" },
	});
	await h.call("updateForm", {
		formUuid: "Visit",
		close_condition: { fieldUuid: "finished", answer: "yes" },
	});
	expect(h.currentDoc().forms[form.uuid].closeCondition?.field).toBe(done.uuid);
	await h.call("addCaseOperations", {
		formUuid: "Visit",
		operations: [
			{
				operation: {
					id: "create_visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: "#form/name",
					writes: [],
				},
			},
			{
				operation: {
					id: "tag_visit",
					action: "update",
					caseType: "visit",
					target: { kind: "op", opUuid: "create_visit" },
					writes: [{ property: "source_id", value: "id-of('create_visit')" }],
				},
			},
		],
	});
	const operations = orderedCaseOperations(h.currentDoc().forms[form.uuid]);
	expect(operations[1]).toMatchObject({
		target: { kind: "op", opUuid: operations[0].uuid },
		writes: [
			{
				property: "source_id",
				value: { kind: "id-of", opUuid: operations[0].uuid },
			},
		],
	});
	await h.call("configureCaseList", {
		moduleUuid: "Clients",
		columns: [{ kind: "plain", field: "case_name", header: "Client" }],
		resultsColumnOrder: ["Client", "Name"],
	});
	const module = Object.values(h.currentDoc().modules).find(
		(item) => item.name === "Clients",
	);
	if (!module) throw new Error("Missing client module.");
	const result = await h.call("getModule", { moduleUuid: "Clients" });
	const column = module.caseListConfig?.columns.find(
		(item) => item.header === "Client",
	);
	expect(result).toMatchObject({
		results_column_order: [
			column?.uuid,
			module.caseListConfig?.columns[0].uuid,
		],
	});
	const before = h.currentDoc();
	await expect(
		h.call("updateForm", {
			formUuid: "Visit",
			close_condition: { fieldUuid: "missing", answer: "yes" },
		}),
	).rejects.toThrow("not in this scope");
	expect(h.currentDoc()).toEqual(before);
	await expect(
		h.call("configureCaseList", {
			moduleUuid: "Clients",
			columns: [{ kind: "plain", field: "case_name", header: "Client" }],
			resultsColumnOrder: ["Client", "Name"],
		}),
	).rejects.toThrow("ambiguous");
	expect(h.currentDoc()).toEqual(before);
});

it("resolves sibling organization levels before admitting a complete hierarchy", async () => {
	const h = authoring();
	await h.call("addOrganizationLevels", {
		levels: [
			{
				code: "district",
				name: "District",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			},
			{
				code: "clinic",
				name: "Clinic",
				parentLevelUuid: "District",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			},
		],
	});
	const levels = Object.values(h.currentDoc().organizationLevels ?? {});
	expect(levels.find((item) => item.name === "Clinic")?.parentLevelUuid).toBe(
		levels.find((item) => item.name === "District")?.uuid,
	);
	await h.call("addLocationProperties", {
		properties: [{ slug: "staff", label: "Staff", levelUuids: ["Clinic"] }],
	});
	expect(
		Object.values(h.currentDoc().locationProperties ?? {})[0].levelUuids,
	).toEqual([levels.find((item) => item.name === "Clinic")?.uuid]);
});

it("edits named fields after creation and preserves authored wording through read and rename", async () => {
	const h = authoring(
		{},
		namedFormFixture([
			{ name: "Visit", forms: [{ name: "Survey", type: "survey" }] },
		]),
	);
	await h.call("addFields", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fields: [
			{
				kind: "int",
				id: "age",
				label: "Age",
				validate: { expr: ". >= 0", msg: "Age cannot be negative." },
			},
			{
				kind: "label",
				id: "summary",
				label: "Age: {{age}}",
				relevant: "#form/age >= 18",
			},
		],
	});
	await h.call("removeField", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fieldUuid: "fixture_placeholder",
	});
	const age = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "age",
	);
	if (!age) throw new Error("Missing age field.");
	await h.call("editField", {
		fieldUuid: age.uuid,
		updates: { id: "years", label: "Age in years" },
	});
	const result = await h.call("getField", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fieldUuid: "summary",
	});
	expect(result).toMatchObject({
		field: { label: "Age: {{years}}", relevant: "#form/years >= 18" },
	});
	expect(await h.call("searchBlueprint", { query: "Age:" })).toMatchObject({
		results: [{ field: "label", value: "Age: {{years}}" }],
	});
	expect(await h.call("getField", { fieldUuid: age.uuid })).toMatchObject({
		field: { validate: { expr: ". >= 0", msg: "Age cannot be negative." } },
	});
	await h.call("editField", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fieldUuid: "summary",
		updates: { label: "Recorded age: {{years}}" },
	});
	const summary = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "summary",
	);
	expect(summary).toMatchObject({
		label: {
			parts: [
				{ kind: "text", text: "Recorded age: " },
				{ kind: "field-ref", uuid: age.uuid },
			],
		},
	});
	expect(
		await h.call("getForm", { moduleUuid: "Visit", formUuid: "Survey" }),
	).toMatchObject({
		form: {
			fields: [
				{ uuid: age.uuid, id: "years" },
				{ id: "summary", label: "Recorded age: {{years}}" },
			],
		},
	});
});

it("loads the table scope for a lookup filter even when the condition uses no row column", async () => {
	const table = {
		id: lookupTableIdSchema.parse(uuidv7()),
		name: "Services",
		tag: "services",
		definitionRevision: parseLookupRevision("0"),
		columns: ["code", "name"].map((name) => ({
			id: lookupColumnIdSchema.parse(uuidv7()),
			wireName: name,
			label: name,
			dataType: "text" as const,
		})),
	};
	const lookupCatalog = vi.fn(async () => ({
		projectId: "project-test",
		projectRevision: parseLookupRevision("1"),
		definitions: [table],
	}));
	const h = authoring(
		{
			lookupCatalog,
			lookupDefinitions: echoLookupDefinitions([table]),
		},
		namedFormFixture([
			{ name: "Services", forms: [{ name: "Survey", type: "survey" }] },
		]),
	);
	await h.call("addFields", {
		moduleUuid: "Services",
		formUuid: "Survey",
		fields: [
			{
				kind: "single_select",
				id: "service",
				label: "Service",
				optionsSource: {
					kind: "inline",
					options: [
						{ value: "one", label: "One" },
						{ value: "two", label: "Two" },
					],
				},
			},
		],
	});
	await h.call("removeField", {
		moduleUuid: "Services",
		formUuid: "Survey",
		fieldUuid: "fixture_placeholder",
	});
	for (const filter of [true, "session('username') = 'ada@example.org'"]) {
		await h.call("setFieldOptionsSource", {
			fieldUuid: "service",
			source: {
				kind: "lookup",
				tableId: "Services",
				valueColumnId: "code",
				labelColumnId: "name",
				filter,
			},
		});
	}
	expect(lookupCatalog).toHaveBeenCalled();
	const field = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "service",
	);
	expect(field).toMatchObject({
		optionsSource: { kind: "lookup", tableId: table.id },
	});
});

it.each(["outer", "outer/inner"])(
	"binds full parent path %s when descendants share its leaf name",
	async (parentPath) => {
		const h = authoring(
			{},
			namedFormFixture([
				{ name: "Visit", forms: [{ name: "Survey", type: "survey" }] },
			]),
		);
		await h.call("addFields", {
			moduleUuid: "Visit",
			formUuid: "Survey",
			fields: [
				{ kind: "group", id: "outer", label: "Outer" },
				{ kind: "group", id: "inner", label: "Inner", parentUuid: "outer" },
				{
					kind: "text",
					id: "name",
					label: "Name",
					parentUuid: "outer/inner",
				},
			],
		});
		await h.call("removeField", {
			moduleUuid: "Visit",
			formUuid: "Survey",
			fieldUuid: "fixture_placeholder",
		});
		const leaf = parentPath.split("/").at(-1);
		await h.call("addFields", {
			moduleUuid: "Visit",
			formUuid: "Survey",
			fields: [
				{
					kind: "group",
					id: leaf,
					label: "Detail",
					parentUuid: parentPath,
				},
				{
					kind: "group",
					id: leaf,
					label: "More detail",
					parentUuid: `${parentPath}/${leaf}`,
				},
				{
					kind: "text",
					id: "comment",
					label: "Comment",
					parentUuid: `${parentPath}/${leaf}/${leaf}`,
				},
			],
		});
		expect(
			await h.call("getField", {
				moduleUuid: "Visit",
				formUuid: "Survey",
				fieldUuid: `${parentPath}/${leaf}/${leaf}/comment`,
			}),
		).toMatchObject({ field: { id: "comment" } });
	},
);

it("binds named Connect participants and their score expressions to each form", async () => {
	const formNames = ["First assessment", "Second assessment"];
	const h = authoring(
		{},
		namedFormFixture([
			{
				name: "Learning",
				forms: formNames.map((name) => ({ name, type: "survey" })),
			},
		]),
	);
	for (const formUuid of formNames) {
		await h.call("addFields", {
			moduleUuid: "Learning",
			formUuid,
			fields: [{ kind: "int", id: "score", label: "Score" }],
		});
		await h.call("removeField", {
			moduleUuid: "Learning",
			formUuid,
			fieldUuid: "fixture_placeholder",
		});
	}
	await h.call("configureConnect", {
		mode: "learn",
		participants: ["First assessment", "Second assessment"].map((formUuid) => ({
			formUuid,
			connect: { assessment: { user_score: "#form/score" } },
		})),
	});
	const doc = h.currentDoc();
	for (const form of Object.values(doc.forms).filter((form) =>
		form.name.endsWith("assessment"),
	)) {
		const scoreUuid = doc.fieldOrder[form.uuid][0];
		expect(form.connect).toMatchObject({
			assessment: {
				user_score: { parts: [{ kind: "field-ref", uuid: scoreUuid }] },
			},
		});
	}
});

it("uses each translation unit's own form and preserves inserted identities", async () => {
	const h = authoring(
		{},
		namedFormFixture([
			{ name: "Visit", forms: [{ name: "Survey", type: "survey" }] },
		]),
	);
	await h.call("addFields", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fields: [
			{ kind: "text", id: "name", label: "Name" },
			{ kind: "label", id: "hello", label: "Hello {{name}}" },
		],
	});
	await h.call("removeField", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fieldUuid: "fixture_placeholder",
	});
	const unit = [...translationUnitsById(h.currentDoc()).values()].find(
		(unit) => unit.role === "field-label" && unit.context.fieldId === "hello",
	);
	if (!unit) throw new Error("Missing translation source.");
	await h.call("addLanguage", { language: { language: "fra" } });
	const source = z
		.object({ items: z.array(z.object({ sourceFingerprint: z.string() })) })
		.parse(
			await h.call("getTranslatableContent", {
				language: { language: "fra" },
				query: "Hello",
				limit: 10,
			}),
		).items[0];
	await h.call("updateTranslations", {
		language: { language: "fra" },
		updates: [
			{
				operation: "set",
				unitId: unit.id,
				expectedSourceFingerprint: source.sourceFingerprint,
				value: "Bonjour {{name}}",
			},
		],
	});
	expect(
		await h.call("getTranslatableContent", {
			language: { language: "fra" },
			query: "Hello",
			limit: 10,
		}),
	).toMatchObject({
		items: [
			{
				source: "Hello {{name}}",
				effective: "Bonjour {{name}}",
				status: "needs-review",
			},
		],
	});
	await h.call("editField", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fieldUuid: "hello",
		updates: { label: "Hello, {{name}}!" },
	});
	const review = z
		.object({
			items: z.array(
				z.object({
					sourceFingerprint: z.string(),
					status: z.literal("out-of-date"),
					revision: z.string(),
				}),
			),
		})
		.parse(
			await h.call("getTranslatableContent", {
				language: { language: "fra" },
				query: "Hello",
				limit: 10,
			}),
		).items[0];
	expect(review.sourceFingerprint).not.toBe(source.sourceFingerprint);
	await h.call("updateTranslations", {
		language: { language: "fra" },
		updates: [
			{
				operation: "review",
				unitId: unit.id,
				revision: review.revision,
			},
		],
	});
	expect(
		await h.call("getTranslatableContent", {
			language: { language: "fra" },
			query: "Hello",
			limit: 10,
		}),
	).toMatchObject({
		items: [{ status: "ready", effective: "Bonjour {{name}}" }],
	});
	const readRevision = async () =>
		z
			.object({
				items: z.array(
					z.object({ revision: z.string(), sourceFingerprint: z.string() }),
				),
			})
			.parse(
				await h.call("getTranslatableContent", {
					language: { language: "fra" },
					query: "Hello",
					limit: 10,
				}),
			).items[0];
	const reviewCall = (revision: string) =>
		h.call("updateTranslations", {
			language: { language: "fra" },
			updates: [{ operation: "review", unitId: unit.id, revision }],
		});
	const beforeTargetEdit = await readRevision();
	await h.call("updateTranslations", {
		language: { language: "fra" },
		updates: [
			{
				operation: "set",
				unitId: unit.id,
				expectedSourceFingerprint: beforeTargetEdit.sourceFingerprint,
				value: "Salut {{name}}",
			},
		],
	});
	const targetEdited = structuredClone(h.currentDoc());
	await expect(reviewCall(beforeTargetEdit.revision)).rejects.toThrow();
	expect(h.currentDoc()).toEqual(targetEdited);
	const beforeSourceEdit = await readRevision();
	await h.call("editField", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fieldUuid: "hello",
		updates: { label: "Hello there, {{name}}!" },
	});
	const sourceEdited = structuredClone(h.currentDoc());
	await expect(reviewCall(beforeSourceEdit.revision)).rejects.toThrow();
	expect(h.currentDoc()).toEqual(sourceEdited);
	const current = await readRevision();
	await reviewCall(current.revision);
	expect(
		await h.call("getTranslatableContent", {
			language: { language: "fra" },
			query: "Hello",
			limit: 10,
		}),
	).toMatchObject({
		items: [{ status: "ready", effective: "Salut {{name}}" }],
	});
});
