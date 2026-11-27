import { v7 as uuidv7 } from "uuid";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import {
	echoLookupDefinitions,
	type MakeToolWorkspaceHarnessOptions,
} from "@/lib/agent/__tests__/fixtures";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import {
	ENDPOINT_FORM,
	endpointWireFixture,
} from "@/lib/commcare/__tests__/endpointWireFixture";
import {
	ROUTE,
	twoMenus,
	VISIT,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
import {
	type BlueprintDoc,
	orderedCaseOperations,
	translationUnitsById,
} from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/expression";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { AuthoringInputError } from "../errors";

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

it("chooses a supplied creation by the operation name on the deep link's form", async () => {
	const doc = endpointWireFixture("registration");
	const operation = doc.forms[ENDPOINT_FORM].caseOperations?.find(
		(row) => row.action === "own",
	);
	if (!operation) throw new Error("Missing registration operation");
	const h = authoring({}, doc);
	await h.call("updateEntryPoint", {
		entryPointUuid: "visit",
		patch: { caseCreationUuids: [operation.id] },
	});
	expect(h.currentDoc().forms[ENDPOINT_FORM].entryCaseCreations).toEqual([
		operation.uuid,
	]);
});

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
	expect(confirmation.relevant).toMatchObject({
		kind: "neq",
		left: { kind: "term", term: { kind: "field", uuid: date.uuid } },
	});
	await expect(
		h.call("editField", {
			formUuid: "Weekly check",
			fieldUuid: "confirmation",
			updates: { relevant: "/data/check_date != ''" },
		}),
	).rejects.toThrow("doesn't reach an available value");
	expect(h.currentDoc()).toBe(doc);
	await h.call("editField", {
		formUuid: "Weekly check",
		fieldUuid: "confirmation",
		updates: { relevant: "/data/details/check_date != ''" },
	});
	expect(h.currentDoc().fields[confirmation.uuid]).toMatchObject({
		relevant: {
			kind: "neq",
			left: {
				kind: "term",
				term: { kind: "field", uuid: date.uuid, spelling: "absolute" },
			},
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
		close_condition: "#form/confirmation/done = 'yes'",
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
	// The condition stores the question's identity, never its path.
	const doneRead = {
		kind: "eq",
		left: { kind: "term", term: { kind: "field", uuid: done.uuid } },
	};
	expect(form.closeCondition).toMatchObject(doneRead);
	await h.call("editField", {
		formUuid: "Visit",
		fieldUuid: "done",
		updates: { id: "finished" },
	});
	await h.call("updateForm", {
		formUuid: "Visit",
		close_condition: "#form/confirmation/finished = 'yes'",
	});
	expect(h.currentDoc().forms[form.uuid].closeCondition).toMatchObject(
		doneRead,
	);
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
	// The close form's own case runs first; the added changes follow it.
	const operations = orderedCaseOperations(h.currentDoc().forms[form.uuid]);
	expect(operations[0]).toMatchObject({ action: "own" });
	expect(operations[2]).toMatchObject({
		target: { kind: "op", opUuid: operations[1].uuid },
		writes: [
			{
				property: "source_id",
				value: { kind: "id-of", opUuid: operations[1].uuid },
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
			close_condition: "#form/missing = 'yes'",
		}),
	).rejects.toThrow(AuthoringInputError);
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

it("loads the table scope for a count of a table's rows in a menu badge and conditions", async () => {
	const table = {
		id: lookupTableIdSchema.parse(uuidv7()),
		name: "Clinics",
		tag: "clinics",
		definitionRevision: parseLookupRevision("0"),
		columns: [
			{
				id: lookupColumnIdSchema.parse(uuidv7()),
				wireName: "name",
				label: "name",
				dataType: "text" as const,
			},
		],
	};
	const lookupCatalog = vi.fn(async () => ({
		projectId: "project-test",
		projectRevision: parseLookupRevision("1"),
		definitions: [table],
	}));
	const h = authoring(
		{ lookupCatalog, lookupDefinitions: echoLookupDefinitions([table]) },
		namedFormFixture([
			{ name: "Clinics", forms: [{ name: "Survey", type: "survey" }] },
		]),
	);
	await h.call("updateModule", {
		moduleUuid: "Clinics",
		badge: {
			kind: "calculation",
			expression: "count(table-rows('Clinics'))",
		},
		displayCondition: "count(table-rows('Clinics')) > 0",
	});
	await h.call("updateForm", {
		moduleUuid: "Clinics",
		formUuid: "Survey",
		displayCondition: "count(table-rows('Clinics')) > 0",
	});
	expect(lookupCatalog).toHaveBeenCalled();
	const doc = h.currentDoc();
	const menu = Object.values(doc.modules).find(
		(module) => module.name === "Clinics",
	);
	const form = Object.values(doc.forms).find(
		(one) => one.displayCondition !== undefined,
	);
	expect({
		badge: JSON.stringify(menu?.badge),
		menuCondition: JSON.stringify(menu?.displayCondition),
		formCondition: JSON.stringify(form?.displayCondition),
	}).toEqual({
		badge: expect.stringContaining(table.id),
		menuCondition: expect.stringContaining(table.id),
		formCondition: expect.stringContaining(table.id),
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
		namedFormFixture(
			[
				{
					name: "Learning",
					forms: formNames.map((name) => ({ name, type: "survey" })),
				},
			],
			// The app becomes a Connect app, which runs on Android alone.
			{ runsOnlyOn: "android" },
		),
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
	await h.call("configureConnect", { roles: ["learn"] });
	for (const formUuid of ["First assessment", "Second assessment"]) {
		expect(
			await h.call("addFields", {
				formUuid,
				fields: [
					{
						kind: "connect_activity",
						id: "quiz",
						activity: { kind: "assessment", score: "#form/score" },
					},
				],
			}),
		).toMatchObject({ ok: true });
	}
	const doc = h.currentDoc();
	for (const form of Object.values(doc.forms).filter((form) =>
		form.name.endsWith("assessment"),
	)) {
		const [score, quiz] = doc.fieldOrder[form.uuid];
		expect(doc.fields[quiz]).toMatchObject({
			activity: {
				kind: "assessment",
				score: {
					kind: "term",
					term: { kind: "field", uuid: score },
				},
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
	const wording = {
		operation: "set",
		unitId: unit.id,
		expectedSourceFingerprint: current.sourceFingerprint,
		value: "Salut {{name}}, {{name}}",
	};
	const setTarget = (changeShownValues: boolean) =>
		h.call("updateTranslations", {
			language: { language: "fra" },
			updates: [{ ...wording, changeShownValues }],
		});
	await expect(setTarget(false)).rejects.toThrow();
	await setTarget(true);
	expect(h.currentDoc().localization?.translations.fra[unit.id]).toMatchObject({
		valueMode: "independent-values",
		review: "needs-review",
	});
	await h.call("editField", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fieldUuid: "hello",
		updates: { label: "Hello {{name}}, {{name}}" },
	});
	const matching = await readRevision();
	await reviewCall(matching.revision);
	expect(
		h.currentDoc().localization?.translations.fra[unit.id],
	).not.toHaveProperty("valueMode");
});

it("keeps a translation that shows values of its own until an edit says what to do with them", async () => {
	const fixture = namedFormFixture([
		{ name: "Visit", forms: [{ name: "Survey", type: "survey" }] },
	]);
	const h = authoring({}, fixture);
	await h.call("addFields", {
		moduleUuid: "Visit",
		formUuid: "Survey",
		fields: [
			{ kind: "text", id: "name", label: "Name" },
			{ kind: "text", id: "family", label: "Family" },
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
	const read = async () =>
		z
			.object({
				items: z.array(
					z.object({
						sourceFingerprint: z.string(),
						explicit: z
							.object({ showsOwnValues: z.literal(true).optional() })
							.nullable()
							.optional(),
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
	const setInput = async (value: string, changeShownValues?: boolean) => ({
		language: { language: "fra" },
		updates: [
			{
				operation: "set",
				unitId: unit.id,
				expectedSourceFingerprint: (await read()).sourceFingerprint,
				value,
				...(changeShownValues !== undefined && { changeShownValues }),
			},
		],
	});
	const set = async (value: string, changeShownValues?: boolean) =>
		h.call("updateTranslations", await setInput(value, changeShownValues));
	await set("Bonjour {{family}}", true);
	expect((await read()).explicit?.showsOwnValues).toBe(true);
	const own = structuredClone(h.currentDoc());
	/* A translation of the source, as a model re-translating it writes it. */
	const refused = await makeAuthoringHarness({}, h.currentDoc()).call(
		"updateTranslations",
		await setInput("Bonjour {{name}} !"),
	);
	expect(refused).toMatchObject({
		error: expect.stringContaining("Set changeShownValues to true"),
	});
	await expect(set("Bonjour {{name}} !")).rejects.toThrow();
	expect(h.currentDoc()).toEqual(own);
	/* Rewording while keeping its own values says so. */
	await set("Salut {{family}}", true);
	expect(h.currentDoc().localization?.translations.fra[unit.id]).toMatchObject({
		valueMode: "independent-values",
	});
	/* Showing the source's values again says so too. */
	await set("Bonjour {{name}} !", false);
	expect(
		h.currentDoc().localization?.translations.fra[unit.id],
	).not.toHaveProperty("valueMode");
	expect((await read()).explicit?.showsOwnValues).toBeUndefined();
});

it("adds a deep link to a form a menu lists from another menu, through that listing menu", async () => {
	const doc = twoMenus();
	const route = doc.modules[ROUTE];
	if (route?.formsFromMenu === undefined) throw new Error("Missing route");
	route.formsFromMenu = { ...route.formsFromMenu, entryPoints: undefined };
	const h = authoring({}, expectAdmittedDoc(doc));
	await h.call("addEntryPoint", {
		target: { kind: "form", moduleUuid: ROUTE, formUuid: VISIT },
		id: "clinic-visit",
	});
	expect(
		h.currentDoc().modules[ROUTE].formsFromMenu?.entryPoints,
	).toMatchObject([{ formUuid: VISIT, entryPoint: { id: "clinic-visit" } }]);
});

it("reads and writes #case on a menu that lists another menu's forms as that menu's case type", async () => {
	const h = authoring({}, expectAdmittedDoc(twoMenus()));
	await h.call("setCaseListFilter", {
		moduleUuid: ROUTE,
		filter: "#case/case_name = 'Ada'",
	});
	expect(h.currentDoc().modules[ROUTE].caseListConfig?.filter).toEqual(
		eq(prop("patient", "case_name"), literal("Ada")),
	);
	const read = (await h.call("getModule", { moduleUuid: ROUTE })) as {
		case_type: string;
		case_list_config: { filter: unknown };
	};
	expect(read.case_type).toBe("patient");
	expect(read.case_list_config.filter).toBe("(#case/case_name = 'Ada')");
});

it("names a form behavior's choice text by its value beside the question that holds it", async () => {
	const h = authoring(
		{},
		namedFormFixture([
			{ name: "Garden", forms: [{ name: "Weekly check", type: "survey" }] },
		]),
	);
	await h.call("addFields", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		fields: [
			{ kind: "text", id: "note", label: "Note" },
			{
				kind: "single_select",
				id: "done",
				label: "Finished?",
				optionsSource: {
					kind: "inline",
					options: [
						{ value: "yes", label: "Yes, send it" },
						{ value: "no", label: "Not yet" },
					],
				},
			},
		],
	});
	await h.call("updateForm", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		automaticSubmissionText: {
			carrier: { field: "done", role: "select-option-label", option: "yes" },
		},
		skipAutomaticSyncText: {
			carrier: { field: "done", role: "select-option-label", option: "no" },
		},
	});
	const doc = h.currentDoc();
	const form = Object.values(doc.forms).find(
		(item) => item.name === "Weekly check",
	);
	const done = Object.values(doc.fields).find((item) => item.id === "done");
	if (done?.kind !== "single_select" || done.optionsSource.kind !== "inline")
		throw new Error("Missing the choice question.");
	const [yes, no] = done.optionsSource.options;
	expect(form?.automaticSubmissionText).toEqual({
		carrier: {
			field: done.uuid,
			role: "select-option-label",
			option: yes?.uuid,
		},
	});
	expect(form?.skipAutomaticSyncText).toEqual({
		carrier: {
			field: done.uuid,
			role: "select-option-label",
			option: no?.uuid,
		},
	});
});

it("lets Nova choose a question label for automatic submission that no other behavior holds", async () => {
	const h = authoring(
		{},
		namedFormFixture([
			{ name: "Garden", forms: [{ name: "Weekly check", type: "survey" }] },
		]),
	);
	await h.call("addFields", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		fields: [
			{ kind: "text", id: "first", label: "First" },
			{ kind: "text", id: "second", label: "Second" },
		],
	});
	await h.call("removeField", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		fieldUuid: "fixture_placeholder",
	});
	// The first label holds one behavior and, in the same call, a second.
	await h.call("updateForm", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		skipAutomaticSyncText: { carrier: { field: "first", role: "field-label" } },
		automaticSubmissionText: true,
	});
	const doc = h.currentDoc();
	const form = Object.values(doc.forms).find(
		(item) => item.name === "Weekly check",
	);
	const second = Object.values(doc.fields).find((item) => item.id === "second");
	expect(form?.automaticSubmissionText).toEqual({
		carrier: { field: second?.uuid, role: "field-label" },
	});
});

it("reads a form without listing each of its texts again, and names a behavior's text from the question tree", async () => {
	const h = authoring(
		{},
		namedFormFixture([
			{ name: "Garden", forms: [{ name: "Weekly check", type: "survey" }] },
		]),
	);
	await h.call("addFields", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		fields: [{ kind: "text", id: "note", label: "Note", hint: "Any note" }],
	});
	const read = await h.call("getForm", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
	});
	expect(read).not.toHaveProperty("behaviorTextChoices");
	await h.call("updateForm", {
		moduleUuid: "Garden",
		formUuid: "Weekly check",
		validateChangedAnswersText: {
			carrier: { field: "note", role: "field-hint" },
		},
	});
	const note = Object.values(h.currentDoc().fields).find(
		(item) => item.id === "note",
	);
	const form = Object.values(h.currentDoc().forms).find(
		(item) => item.name === "Weekly check",
	);
	expect(form?.validateChangedAnswersText).toEqual({
		carrier: { field: note?.uuid, role: "field-hint" },
	});
});

it("admits a delivery in each row a worker adds where the row asks for a recipient ID no other row repeats, as its refusal says", async () => {
	const h = authoring(
		{},
		namedFormFixture([
			{ name: "Visits", forms: [{ name: "Round", type: "survey" }] },
		]),
	);
	await h.call("updateApp", { runs_only_on: "android" });
	await h.call("configureConnect", { roles: ["deliver"] });
	const fields = (validate?: { expr: string; msg: string }) => ({
		moduleUuid: "Visits",
		formUuid: "Round",
		fields: [
			{
				kind: "repeat",
				id: "visits",
				label: "Visits",
				repeat: { mode: "user_controlled" },
			},
			{
				kind: "text",
				id: "recipient_id",
				parentUuid: "visits",
				label: "Recipient ID",
				required: "true()",
				...(validate && { validate }),
			},
			{
				kind: "connect_activity",
				id: "visit",
				parentUuid: "visits",
				activity: {
					kind: "delivery",
					name: "Visit",
					entityId: "../../../recipient_id",
				},
			},
		],
	});
	const refused = await makeAuthoringHarness({}, h.currentDoc()).call(
		"addFields",
		fields(),
	);
	expect(refused).toMatchObject({
		error: expect.stringContaining(
			"string-length(join('|', distinct-values(#form/<repeat>[true()]/<id>)))",
		),
	});
	await h.call(
		"addFields",
		fields({
			expr: "string-length(join('|', #form/visits[true()]/recipient_id)) = string-length(join('|', distinct-values(#form/visits[true()]/recipient_id)))",
			msg: "Each visit needs its own recipient ID.",
		}),
	);
	const visit = Object.values(h.currentDoc().fields).find(
		(item) => item.id === "visit",
	);
	expect(visit?.kind).toBe("connect_activity");
});

it("authors a meter and result mappings by question name in one add and a subsequent edit", async () => {
	const fixture = namedFormFixture([
		{ name: "Meters", forms: [{ name: "Read meter", type: "survey" }] },
	]);
	const h = authoring(
		{},
		{
			...fixture,
			appSettings: { ...fixture.appSettings, runsOnlyOn: "android" },
		},
	);
	await h.call("addFields", {
		formUuid: "Read meter",
		fields: [
			{ kind: "text", id: "unit", label: "Unit" },
			{ kind: "int", id: "reading", label: "Reading" },
			{
				kind: "text",
				id: "meter",
				label: "Open the meter",
				androidApp: {
					kind: "open-app",
					action: "org.example.MEASURE",
					send: [{ name: "unit", value: "#form/unit" }],
					receive: [{ name: "measurement", question: "reading" }],
				},
			},
		],
	});
	const fields = Object.values(h.currentDoc().fields);
	const meter = fields.find((field) => field.id === "meter");
	const unit = fields.find((field) => field.id === "unit");
	const reading = fields.find((field) => field.id === "reading");
	expect(meter?.kind === "text" && meter.androidApp).toMatchObject({
		kind: "open-app",
		action: "org.example.MEASURE",
		send: [
			{
				name: "unit",
				value: { kind: "term", term: { kind: "field", uuid: unit?.uuid } },
			},
		],
		receive: [{ name: "measurement", question: reading?.uuid }],
	});
	await h.call("editField", {
		formUuid: "Read meter",
		fieldUuid: "reading",
		updates: { androidApp: { kind: "use-question", question: "meter" } },
	});
	expect(
		Object.values(h.currentDoc().fields).find(
			(field) => field.id === "reading",
		),
	).toMatchObject({
		androidApp: { kind: "use-question", question: meter?.uuid },
	});
	const owner = { formUuid: "Read meter", fieldUuid: "meter" };
	const initial = await h.call("getField", owner);
	const action = {
		kind: "open-app",
		action: "org.example.MEASURE",
		send: [{ name: "unit", value: "#form/unit" }],
		receive: [{ name: "measurement", question: "reading" }],
	};
	expect(initial).toMatchObject({ field: { androidApp: action } });
	await h.call("editField", { ...owner, updates: { androidApp: action } });
	await h.call("editField", {
		formUuid: "Read meter",
		fieldUuid: "reading",
		updates: { id: "amount" },
	});
	expect(await h.call("getField", owner)).toMatchObject({
		field: {
			androidApp: {
				...action,
				receive: [{ name: "measurement", question: "amount" }],
			},
		},
	});
	expect(
		await h.call("getField", { formUuid: "Read meter", fieldUuid: "amount" }),
	).toMatchObject({
		field: { androidApp: { kind: "use-question", question: "meter" } },
	});
});
