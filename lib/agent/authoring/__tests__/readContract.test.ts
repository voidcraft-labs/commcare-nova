import { expect, it } from "vitest";
import { z } from "zod";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import {
	echoLookupDefinitions,
	LOOKUP_SELECT_DOC,
	lookupSelectDoc,
} from "@/lib/agent/__tests__/fixtures";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { translationUnitsById } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { log } from "@/lib/logger";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { AuthoringInputError, ReadProjectionError } from "../errors";
import { projectAuthoringReadInContext, type ReadToolName } from "../output";

/**
 * The read contract: every registered read tool, called the way a client calls
 * it, answers for an app that uses the features authors actually reach for, and
 * answers in authored form. Named forms start from production canonical scaffolds; authored
 * field and configuration calls then pass the commit gate before reads.
 */
const services = {
	id: lookupTableIdSchema.parse("0198c0de-0000-7000-8000-0000000000b1"),
	name: "Services",
	tag: "services",
	definitionRevision: parseLookupRevision("0"),
	columns: [
		["0198c0de-0000-7000-8000-0000000000b2", "code"],
		["0198c0de-0000-7000-8000-0000000000b3", "name"],
	].map(([id, name]) => ({
		id: lookupColumnIdSchema.parse(id),
		wireName: name,
		label: name,
		dataType: "text" as const,
	})),
};

/** A calculated value reading the Services table, which every read of its
 *  text prints back as `{{= formula}}`. */
const serviceName =
	"{{= instance('services')/services_list/services[code = 'one'][1]/name}}";

async function populatedApp() {
	const h = makeAuthoringHarness(
		{
			lookupCatalog: async () => ({
				projectId: "project-test",
				projectRevision: parseLookupRevision("1"),
				definitions: [services],
			}),
			lookupDefinitions: echoLookupDefinitions([services]),
		},
		namedFormFixture(
			[
				{
					name: "Clients",
					caseType: "client",
					forms: [
						{ name: "Register", type: "registration" },
						{ name: "Visit", type: "followup" },
					],
				},
				{ name: "Learning", forms: [{ name: "Assessment", type: "survey" }] },
			],
			// The app becomes a Connect app, which runs on Android alone.
			{ runsOnlyOn: "android" },
		),
	);
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
	await ok("addFields", {
		moduleUuid: "Clients",
		formUuid: "Register",
		fields: [
			{
				kind: "text",
				id: "name",
				label: "Name",
				hint: "As written on their card",
				required: true,
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
						// A calculated value in a choice label.
						{ value: "food", label: "Food {{= concat('for ', #form/name)}}" },
						{ value: "water", label: "Water" },
					],
				},
			},
			{ kind: "hidden", id: "double_age", calculate: "#form/age * 2" },
			{ kind: "label", id: "summary", label: "Registering {{name}}" },
			// A calculated value in a label, reading a data table.
			{ kind: "label", id: "service", label: `Service name: ${serviceName}` },
		],
	});
	await ok("updateForm", {
		moduleUuid: "Clients",
		formUuid: "Register",
		recordName: "#form/name",
	});
	await ok("removeField", {
		moduleUuid: "Clients",
		formUuid: "Register",
		fieldUuid: "fixture_placeholder",
	});
	await ok("addFields", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fields: [
			{ kind: "label", id: "who", label: "{{#case/case_name}}" },
			{ kind: "text", id: "note", label: "Visit note" },
		],
	});
	await ok("removeField", {
		moduleUuid: "Clients",
		formUuid: "Visit",
		fieldUuid: "fixture_placeholder",
	});
	await ok("addCaseListColumns", {
		moduleUuid: "Clients",
		columns: [{ kind: "plain", field: "age", header: "Age" }],
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
			{
				name: "state",
				kind: "advanced",
				type: "text",
				label: "State",
				// A list of values, which every read prints as list(...).
				predicate:
					"when-provided(#search/state, #case/state = list('north', #search/state))",
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
	await ok("addFields", {
		moduleUuid: "Learning",
		formUuid: "Assessment",
		fields: [{ kind: "int", id: "score", label: "Score" }],
	});
	await ok("removeField", {
		moduleUuid: "Learning",
		formUuid: "Assessment",
		fieldUuid: "fixture_placeholder",
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
	readAppTest: null,
	listMediaAssets: null,
	readSource: null,
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
	searchBlueprint: [{ query: "name" }, { query: "Food" }],
	getModule: [{ moduleUuid: "Clients" }, { moduleUuid: "Learning" }],
	getForm: [
		{ moduleUuid: "Clients", formUuid: "Register" },
		{ moduleUuid: "Clients", formUuid: "Visit" },
		{ moduleUuid: "Learning", formUuid: "Assessment" },
	],
	getField: [
		{ moduleUuid: "Clients", formUuid: "Register", fieldUuid: "head" },
		{ moduleUuid: "Clients", formUuid: "Register", fieldUuid: "summary" },
		{ moduleUuid: "Clients", formUuid: "Register", fieldUuid: "service" },
		{ moduleUuid: "Clients", formUuid: "Register", fieldUuid: "needs" },
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

it("prints a calculated value as {{= formula}} in every read that shows its text, and reviews a translation holding one", async () => {
	const h = await populatedApp();
	const label = `Service name: ${serviceName}`;
	const choice = "Food {{= concat('for ', #form/name)}}";

	const form = JSON.stringify(
		await h.call("getForm", { moduleUuid: "Clients", formUuid: "Register" }),
	);
	expect(form).toContain(JSON.stringify(label));
	expect(form).toContain(JSON.stringify(choice));

	const found = JSON.stringify(
		await h.call("searchBlueprint", { query: "Service name" }),
	);
	expect(found).toContain(JSON.stringify(label));

	const unit = [...translationUnitsById(h.currentDoc()).values()].find(
		(unit) => unit.role === "field-label" && unit.context.fieldId === "service",
	);
	if (unit === undefined) throw new Error("The service label has no unit.");
	const entry = z.object({
		id: z.string(),
		source: z.string(),
		sourceFingerprint: z.string(),
		revision: z.string().optional(),
		effective: z.string().optional(),
		status: z.string(),
	});
	const read = async () => {
		const items = z
			.object({ items: z.array(entry) })
			.parse(
				await h.call("getTranslatableContent", {
					language: { language: "fra" },
					query: "Service name",
					limit: 10,
				}),
			)
			.items.filter((item) => item.id === unit.id);
		expect(items).toHaveLength(1);
		return items[0];
	};
	const source = await read();
	expect(source.source).toBe(label);

	const translated = `Nom du service : ${serviceName}`;
	expect(
		await h.call("updateTranslations", {
			language: { language: "fra" },
			updates: [
				{
					operation: "set",
					unitId: unit.id,
					expectedSourceFingerprint: source.sourceFingerprint,
					value: translated,
				},
			],
		}),
	).toMatchObject({ ok: true });
	const pending = await read();
	expect(pending).toMatchObject({
		effective: translated,
		status: "needs-review",
	});
	if (pending.revision === undefined)
		throw new Error("The translation has no review revision.");
	expect(
		await h.call("updateTranslations", {
			language: { language: "fra" },
			updates: [
				{ operation: "review", unitId: unit.id, revision: pending.revision },
			],
		}),
	).toMatchObject({ ok: true });
	expect(await read()).toMatchObject({
		effective: translated,
		status: "ready",
	});
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

it("reads a case list item's and a Register button's icons as setMenuMedia takes them, so a read can be written back", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Patients",
				caseType: "patient",
				forms: [{ name: "Visit", type: "followup" }],
			},
			{
				name: "Registration",
				caseType: "patient",
				forms: [{ name: "Register patient", type: "registration" }],
			},
		]),
	);
	const doc = h.currentDoc();
	const register = Object.values(doc.forms).find(
		(form) => form.name === "Register patient",
	);
	if (register === undefined)
		throw new Error("The fixture holds no Register patient form.");
	for (const input of [
		{
			moduleUuid: "Patients",
			register_from_case_list: { formUuid: register.uuid },
		},
		{
			items: [
				{
					target: "case-list-menu-item",
					moduleUuid: "Patients",
					icon: "household",
					audioLabel: null,
				},
				{
					target: "case-list-registration",
					moduleUuid: "Patients",
					icon: "register",
					audioLabel: null,
				},
			],
		},
	]) {
		const result = await h.call(
			"register_from_case_list" in input ? "updateModule" : "setMenuMedia",
			input,
		);
		expect(result).not.toHaveProperty("error");
	}
	const slots = z.object({
		icon: z.string().nullable(),
		audio_label: z.string().nullable(),
	});
	const module = z
		.object({
			uuid: z.string(),
			caseListMenuItem: slots,
			caseListRegistrationForm: slots.extend({ kind: z.literal("always") }),
		})
		.parse(await h.call("getModule", { moduleUuid: "Patients" }));
	expect(module.caseListMenuItem).toMatchObject({
		icon: "household",
		audio_label: null,
	});
	expect(module.caseListRegistrationForm).toMatchObject({
		icon: "register",
		audio_label: null,
	});

	const before = h.currentDoc();
	await h.call("setMenuMedia", {
		items: [
			{
				target: "case-list-menu-item",
				moduleUuid: module.uuid,
				icon: module.caseListMenuItem.icon,
				audioLabel: module.caseListMenuItem.audio_label,
			},
			{
				target: "case-list-registration",
				moduleUuid: module.uuid,
				icon: module.caseListRegistrationForm.icon,
				audioLabel: module.caseListRegistrationForm.audio_label,
			},
		],
	});
	expect(h.currentDoc()).toEqual(before);
});

it("reads a group's display flags under the names addFields and editField take", async () => {
	const h = await populatedApp();
	const added = await h.call("addFields", {
		moduleUuid: "Learning",
		formUuid: "Assessment",
		fields: [
			{
				kind: "group",
				id: "one_screen",
				label: "Shown *as typed*",
				field_list: true,
				plain_label: true,
			},
		],
	});
	expect(added).not.toHaveProperty("error");
	const address = {
		moduleUuid: "Learning",
		formUuid: "Assessment",
		fieldUuid: "one_screen",
	};
	const flags = z.object({
		kind: z.string(),
		field_list: z.literal(true),
		plain_label: z.literal(true),
	});
	const read = z
		.object({ field: flags })
		.parse(await h.call("getField", address)).field;
	expect(read).not.toHaveProperty("fieldList");
	expect(read).not.toHaveProperty("plainLabel");
	// A form read nests the same field projection.
	const form = JSON.stringify(
		await h.call("getForm", { formUuid: "Assessment" }),
	);
	expect(form).toContain('"field_list":true');
	expect(form).toContain('"plain_label":true');
	expect(form).not.toContain('"fieldList"');
	expect(form).not.toContain('"plainLabel"');

	const before = h.currentDoc();
	const sent = await h.call("editField", {
		...address,
		updates: {
			kind: read.kind,
			field_list: read.field_list,
			plain_label: read.plain_label,
		},
	});
	expect(sent).not.toHaveProperty("error");
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
	).rejects.toThrow("must name one answer or record property");
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

it("reads captured-file case writes through both form and operation reads", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Patients",
				caseType: "patient",
				forms: [{ name: "Visit", type: "followup" }],
			},
		]),
	);
	expect(
		await h.call("addFields", {
			formUuid: "Visit",
			fields: [
				{
					kind: "image",
					id: "photo",
					label: "Photo",
					caseWrite: { caseType: "patient", property: "photo_link" },
				},
			],
		}),
	).toMatchObject({ ok: true });
	for (const name of ["getForm", "getCaseOperations"]) {
		const result = await h.call(name, { formUuid: "Visit" });
		expect(JSON.stringify(result)).toContain("capture-link(#form/photo)");
	}
	expect(
		await h.call("editField", {
			fieldUuid: "photo",
			updates: { id: "portrait" },
		}),
	).toMatchObject({ ok: true });
	const result = await h.call("getCaseOperations", { formUuid: "Visit" });
	expect(JSON.stringify(result)).toContain("capture-link(#form/portrait)");
});
