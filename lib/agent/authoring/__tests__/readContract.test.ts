import { expect, it } from "vitest";
import { z } from "zod";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import {
	LOOKUP_SELECT_DOC,
	lookupSelectDoc,
} from "@/lib/agent/__tests__/fixtures";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { log } from "@/lib/logger";
import { AuthoringInputError, ReadProjectionError } from "../errors";
import { projectAuthoringReadInContext, type ReadToolName } from "../output";

/**
 * The read contract: every registered read tool, called the way a client calls
 * it, answers for an app that uses the features authors actually reach for, and
 * answers in authored form. The app is built through the same authored tool
 * calls, so the commit gate has admitted every value a read then has to print.
 */
async function populatedApp() {
	const h = makeAuthoringHarness();
	const ok = async (name: string, input: unknown) => {
		const result = await h.call(name, input);
		expect(result, name).not.toHaveProperty("error");
		expect(result, name).not.toMatchObject({ ok: false });
		return result;
	};
	await ok("generateSchema", {
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: "Client name", data_type: "text" },
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "state", label: "State", data_type: "text" },
				],
			},
			{
				name: "visit",
				properties: [{ name: "source_id", label: "Source", data_type: "text" }],
			},
		],
	});
	await ok("createModule", {
		name: "Clients",
		case_type: "client",
		case_list_columns: [
			{ kind: "plain", field: "case_name", header: "Name" },
			{ kind: "plain", field: "age", header: "Age" },
		],
		forms: [
			{
				name: "Register",
				type: "registration",
				recordName: "#form/name",
				fields: [
					{
						kind: "text",
						id: "name",
						label: "Name",
						hint: "As written on their card",
						required: true,
						caseWrite: { caseType: "client", property: "case_name" },
					},
					{
						kind: "int",
						id: "age",
						label: "Age",
						validate: { expr: ". >= 0", msg: "Enter an age of 0 or more." },
						caseWrite: { caseType: "client", property: "age" },
					},
					{ kind: "date", id: "seen_on", label: "Seen on" },
					{ kind: "group", id: "household", label: "Household" },
					{
						kind: "single_select",
						id: "head",
						parentUuid: "household",
						label: "Head of household?",
						relevant: "#form/age >= 18",
						optionsSource: {
							kind: "inline",
							options: [
								{ value: "yes", label: "Yes" },
								{ value: "no", label: "No" },
							],
						},
					},
					{
						kind: "multi_select",
						id: "needs",
						label: "Needs",
						optionsSource: {
							kind: "inline",
							options: [
								{ value: "food", label: "Food" },
								{ value: "water", label: "Water" },
							],
						},
					},
					{ kind: "hidden", id: "double_age", calculate: "#form/age * 2" },
					{ kind: "label", id: "summary", label: "Registering {{name}}" },
				],
			},
			{
				name: "Visit",
				type: "followup",
				fields: [
					{ kind: "label", id: "who", label: "{{#case/case_name}}" },
					{ kind: "text", id: "note", label: "Visit note" },
				],
			},
		],
	});
	await ok("addSearchInputs", {
		moduleUuid: "Clients",
		searchInputs: [
			{
				name: "name",
				kind: "simple",
				type: "text",
				label: "Name",
				property: "case_name",
				validation: { rule: "#search/name != ''", message: "Enter a name." },
			},
		],
	});
	await ok("addCaseOperations", {
		formUuid: "Visit",
		operations: [
			{
				operation: {
					id: "create_visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: "#form/note",
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
	await ok("createModule", {
		name: "Learning",
		forms: [
			{
				name: "Assessment",
				type: "survey",
				fields: [{ kind: "int", id: "score", label: "Score" }],
			},
		],
	});
	await ok("configureConnect", {
		mode: "learn",
		participants: [
			{
				formUuid: "Assessment",
				connect: { assessment: { user_score: "#form/score" } },
			},
		],
	});
	await ok("addLanguage", { language: { language: "fra" } });
	await ok("setMenuMedia", {
		items: [
			{
				target: "module",
				moduleUuid: "Clients",
				icon: "household",
				audioLabel: null,
			},
			{
				target: "form",
				moduleUuid: "Clients",
				formUuid: "Register",
				icon: "register",
				audioLabel: null,
			},
			{
				target: "form",
				moduleUuid: "Clients",
				formUuid: "Visit",
				icon: "follow_up",
				audioLabel: null,
			},
		],
	});
	return h;
}

/** One authored input per registered read tool. The type makes a new read tool
 * a compile error here until someone decides how it is swept. `null` records a
 * read whose data lives in Postgres or object storage (Project tables, media,
 * places, worker records), which this document-only harness cannot supply. */
const readInputs: Record<ReadToolName, readonly unknown[] | null> = {
	getLookupTables: null,
	getLookupTableRows: null,
	evaluateForm: null,
	listMediaAssets: null,
	getOrganization: null,
	getAuthoringGuide: [{ topic: "expressions" }],
	getUsers: [{}],
	getAutomations: [{}],
	getLanguages: [{}],
	getEntryPoints: [{}],
	getTranslatableContent: [{ language: { language: "fra" }, limit: 50 }],
	getCaseProperty: [
		{ caseType: "client", property: "age" },
		{ caseType: "visit", property: "source_id" },
	],
	searchBlueprint: [{ query: "name" }],
	getModule: [{ moduleUuid: "Clients" }, { moduleUuid: "Learning" }],
	getForm: [
		{ moduleUuid: "Clients", formUuid: "Register" },
		{ moduleUuid: "Clients", formUuid: "Visit" },
		{ moduleUuid: "Learning", formUuid: "Assessment" },
	],
	getField: [
		{ moduleUuid: "Clients", formUuid: "Register", fieldUuid: "head" },
		{ moduleUuid: "Clients", formUuid: "Register", fieldUuid: "summary" },
	],
	getCaseOperations: [{ moduleUuid: "Clients", formUuid: "Visit" }],
};

it("reads every part of a populated app as authored content", async () => {
	const h = await populatedApp();
	for (const [name, inputs] of Object.entries(readInputs)) {
		for (const input of inputs ?? []) {
			const label = `${name} ${JSON.stringify(input)}`;
			const result = await h.call(name, input);
			expect(result, label).not.toHaveProperty("error");
			const printed = JSON.stringify(result);
			// Stored identities and expression storage never reach a reader.
			expect(printed, label).not.toContain("nova-icon:");
			expect(printed, label).not.toContain('"parts":');
		}
	}
});

it("reads menu icons in the form setMenuMedia accepts, so a read can be written back", async () => {
	const h = await populatedApp();
	const tile = z.object({ uuid: z.string(), icon: z.string().nullable() });
	const module = tile
		.extend({ forms: z.array(tile) })
		.parse(await h.call("getModule", { moduleUuid: "Clients" }));
	expect(module.icon).toBe("household");
	expect(module.forms.map((form) => form.icon)).toEqual([
		"register",
		"follow_up",
	]);
	const form = z
		.object({ form: tile })
		.parse(await h.call("getForm", { formUuid: "Register" }));
	expect(form.form.icon).toBe("register");

	const before = h.currentDoc();
	await h.call("setMenuMedia", {
		items: [
			{
				target: "module",
				moduleUuid: module.uuid,
				icon: module.icon,
				audioLabel: null,
			},
			...module.forms.map((item) => ({
				target: "form",
				moduleUuid: module.uuid,
				formUuid: item.uuid,
				icon: item.icon,
				audioLabel: null,
			})),
		],
	});
	expect(h.currentDoc()).toEqual(before);
});

it("records a value it cannot print as Nova's failure, never as the caller's input", async () => {
	const h = await populatedApp();
	const doc = h.currentDoc();
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Register",
	);
	if (!form) throw new Error("Missing form.");
	// The defect behind the original outage: a tool body handing the projection
	// a slot that is already in authored form.
	const alreadyAuthored = { form: { ...form, icon: "register", fields: [] } };
	const failure = await h.workspace.invoke({
		toolName: "getForm",
		execute: (ctx) =>
			projectAuthoringReadInContext("getForm", alreadyAuthored, ctx).then(
				() => undefined,
				(error: unknown) => error,
			),
	});
	expect(failure).toBeInstanceOf(ReadProjectionError);
	expect(failure).not.toBeInstanceOf(AuthoringInputError);
	expect(log.error).toHaveBeenCalledOnce();
	expect(log.error).toHaveBeenCalledWith(
		"[authoring] read projection failed",
		expect.any(Error),
		expect.objectContaining({ toolName: "getForm" }),
	);
});

it("leaves a failed Project data read as its own retryable failure", async () => {
	// Loading data tables is a live read that races with a co-member's edit.
	// Calling that an unreadable app would record a false defect and tell the
	// caller not to try again, when trying again is what works.
	const raced = new Error("Project data changed while it was loading.");
	const h = makeAuthoringHarness(
		{ lookupCatalog: () => Promise.reject(raced) },
		lookupSelectDoc({
			kind: "lookup",
			tableId: lookupTableIdSchema.parse(
				"0198c0de-0000-7000-8000-0000000000a1",
			),
			valueColumnId: lookupColumnIdSchema.parse(
				"0198c0de-0000-7000-8000-0000000000a2",
			),
			labelColumnId: lookupColumnIdSchema.parse(
				"0198c0de-0000-7000-8000-0000000000a3",
			),
		}),
	);
	await expect(
		h.call("getForm", {
			moduleUuid: LOOKUP_SELECT_DOC.moduleUuid,
			formUuid: LOOKUP_SELECT_DOC.formUuid,
		}),
	).rejects.toBe(raced);
	expect(log.error).not.toHaveBeenCalled();
});

it("keeps literal hashtags distinct from explicit answer, case and worker insertions", async () => {
	const h = await populatedApp();
	const wording =
		"Literal #form/name; answer {{name}}; worker {{#user/commcare_first_name}}; braces \\{{example}}";
	expect(
		await h.call("editField", {
			moduleUuid: "Clients",
			formUuid: "Register",
			fieldUuid: "name",
			updates: { hint: wording },
		}),
	).toMatchObject({ ok: true });
	const source = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "name",
	);
	if (!source || !("hint" in source)) throw new Error("Missing name hint");
	expect(source.hint?.parts).toEqual([
		{ kind: "text", text: "Literal #form/name; answer " },
		{ kind: "field-ref", uuid: source.uuid },
		{ kind: "text", text: "; worker " },
		{ kind: "user-ref", property: "commcare_first_name" },
		{ kind: "text", text: "; braces {{example}}" },
	]);
	const before = h.currentDoc();
	await expect(
		h.call("editField", {
			fieldUuid: source.uuid,
			updates: { hint: "{{missing_answer}}" },
		}),
	).rejects.toThrow("Unknown or ambiguous reference");
	expect(h.currentDoc()).toEqual(before);
	expect(
		await h.call("editField", {
			fieldUuid: source.uuid,
			updates: { id: "full_name" },
		}),
	).toMatchObject({ ok: true });
	const read = await h.call("getField", { fieldUuid: source.uuid });
	expect(read).toMatchObject({
		field: {
			hint: "Literal #form/name; answer {{full_name}}; worker {{#user/commcare_first_name}}; braces \\{\\{example}}",
		},
	});
	// The populated follow-up was authored with an explicit selected-case insertion.
	const who = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "who",
	);
	if (!who || !("label" in who) || !who.label)
		throw new Error("Missing selected-case wording");
	expect(who.label.parts).toEqual([
		{ kind: "case-ref", caseType: "client", property: "case_name" },
	]);
});
