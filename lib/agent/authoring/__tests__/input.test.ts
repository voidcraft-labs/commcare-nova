import { v7 as uuidv7 } from "uuid";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	echoLookupDefinitions,
	type MakeToolWorkspaceHarnessOptions,
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import {
	SHARED_TOOL_REGISTRY,
	type SharedToolRegistryEntry,
} from "@/lib/agent/sharedToolRegistry";
import { translationUnitsById } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { prepareAuthoringInput } from "../input";
import { projectAuthoringRead } from "../output";
import { authoringToolSchema } from "../toolSchema";

function authoring(options: MakeToolWorkspaceHarnessOptions = {}) {
	const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc(), options);
	async function call(name: string, input: unknown) {
		const entry: SharedToolRegistryEntry | undefined =
			SHARED_TOOL_REGISTRY.find((entry) => entry.saName === name);
		if (!entry) throw new Error(`Unknown tool ${name}.`);
		const authored = authoringToolSchema(
			name,
			entry.tool.inputSchema,
		).authored.parse(input);
		return harness.workspace.invoke({
			toolName: name,
			async execute(ctx) {
				const canonical = await prepareAuthoringInput({
					toolName: name,
					schema: entry.tool.inputSchema,
					input: authored,
					ctx,
				});
				const outcome = await entry.tool.execute(canonical, ctx);
				const result = outcome.kind === "read" ? outcome.data : outcome.result;
				expect(result, name).not.toHaveProperty("error");
				return outcome.kind === "read"
					? projectAuthoringRead({
							toolName: name,
							data: result,
							doc: ctx.snapshot.doc,
						})
					: result;
			},
		});
	}
	return { ...harness, call };
}

it("edits named fields after creation and preserves authored wording through read and rename", async () => {
	const h = authoring();
	await h.call("createModule", {
		name: "Visit",
		forms: [
			{
				name: "Survey",
				type: "survey",
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
			},
		],
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
	const h = authoring({
		lookupCatalog,
		lookupDefinitions: echoLookupDefinitions([table]),
	});
	await h.call("createModule", {
		name: "Services",
		forms: [
			{
				name: "Survey",
				type: "survey",
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
			},
		],
	});
	for (const filter of [true, "session('username') = 'ada@example.org'"]) {
		await h.call("setFieldOptionsSource", {
			fieldUuid: "service",
			source: {
				kind: "lookup",
				tableId: table.id,
				valueColumnId: table.columns[0].id,
				labelColumnId: table.columns[1].id,
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
		const h = authoring();
		await h.call("createModule", {
			name: "Visit",
			forms: [
				{
					name: "Survey",
					type: "survey",
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
				},
			],
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
	const h = authoring();
	await h.call("createModule", {
		name: "Learning",
		forms: ["First assessment", "Second assessment"].map((name) => ({
			name,
			type: "survey",
			fields: [{ kind: "int", id: "score", label: "Score" }],
		})),
	});
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
	const h = authoring();
	await h.call("createModule", {
		name: "Visit",
		forms: [
			{
				name: "Survey",
				type: "survey",
				fields: [
					{ kind: "text", id: "name", label: "Name" },
					{ kind: "label", id: "hello", label: "Hello {{name}}" },
				],
			},
		],
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
	expect(source.sourceFingerprint).toMatch(/^source:[\w-]{43}$/);
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
});

it("binds Search rules to renamed answers and seeds a new no-matches form from them", async () => {
	const h = authoring();
	await h.call("generateSchema", {
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: "Client name", data_type: "text" },
				],
			},
		],
	});
	await h.call("createModule", {
		name: "Clients",
		case_type: "client",
		case_list_columns: [{ kind: "plain", field: "case_name", header: "Name" }],
		forms: [
			{
				name: "Review",
				type: "followup",
				fields: [{ kind: "label", id: "name", label: "{{#case/case_name}}" }],
			},
		],
	});
	await h.call("addSearchInputs", {
		moduleUuid: "Clients",
		searchInputs: [
			{
				name: "name",
				kind: "simple",
				type: "text",
				label: "Name",
				property: "case_name",
			},
		],
	});
	const module = Object.values(h.currentDoc().modules).find(
		(module) => module.name === "Clients",
	);
	const input = module?.caseListConfig?.searchInputs[0];
	if (!input) throw new Error("Missing Search input.");
	await h.call("updateSearchInput", {
		moduleUuid: "Clients",
		searchInputUuid: input.uuid,
		searchInput: {
			name: "name",
			kind: "simple",
			type: "text",
			label: "Name",
			property: "case_name",
			validation: { rule: "#search/name != ''", message: "Enter a name." },
		},
	});
	await h.call("updateSearchInput", {
		moduleUuid: "Clients",
		searchInputUuid: input.uuid,
		searchInput: {
			name: "client_name",
			kind: "simple",
			type: "text",
			label: "Client name",
			property: "case_name",
			validation: {
				rule: "#search/client_name != ''",
				message: "Enter a name.",
			},
		},
	});
	await h.call("createForm", {
		moduleUuid: "Clients",
		name: "Add after search",
		formUuid: testUuid("authored-search-registration"),
		type: "registration",
		entry: { kind: "search-no-matches" },
		fields: [
			{
				kind: "text",
				id: "name",
				caseWrite: { caseType: "client", property: "case_name" },
				default_value: "#search/client_name",
			},
		],
	});
	const seeded = Object.values(h.currentDoc().forms).find(
		(form) => form.name === "Add after search",
	);
	if (!seeded) throw new Error("Missing no-matches form.");
	const fieldId = h.currentDoc().fieldOrder[seeded.uuid][0];
	expect(h.currentDoc().fields[fieldId]).toMatchObject({
		default_value: {
			parts: [{ kind: "search-answer-ref", searchInputUuid: input.uuid }],
		},
	});
	const result = await h.call("getModule", { moduleUuid: "Clients" });
	expect(result).toMatchObject({
		case_list_config: {
			searchInputs: [
				{
					name: "client_name",
					validation: { rule: "(#search/client_name != '')" },
				},
			],
		},
	});
});
