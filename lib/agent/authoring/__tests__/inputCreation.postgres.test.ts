import { expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeDurableAuthoringHarness } from "@/lib/agent/__tests__/durableAuthoringHarness";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { FormEngine } from "@/lib/preview/engine/formEngine";

const db = setupAppStateTestDb("authoring_input_creation_", {
	authSchema: "migrated",
});
it("creates and edits record names without making the author construct name writers or declare the type twice", async () => {
	const h = await makeDurableAuthoringHarness(db);
	await h.call("createModule", { name: "Loans", case_type: "loan" });
	await h.call("createForm", {
		moduleUuid: "Loans",
		name: "Lend",
		type: "registration",
	});
	await h.call("addFields", {
		moduleUuid: "Loans",
		formUuid: "Lend",
		fields: [
			{
				kind: "text",
				id: "borrower",
				label: "Borrower",
				caseWrite: { caseType: "loan", property: "borrower" },
			},
			{
				kind: "text",
				id: "tool",
				label: "Tool",
				caseWrite: { caseType: "loan", property: "tool" },
			},
		],
	});
	await h.call("updateForm", {
		moduleUuid: "Loans",
		formUuid: "Lend",
		recordName: "concat(#form/borrower, ' - ', #form/tool)",
	});
	await h.call("configureCaseList", {
		moduleUuid: "Loans",
		columns: [{ kind: "plain", field: "case_name", header: "Loan" }],
	});
	const form = Object.values((await h.currentDoc()).forms).find(
		(form) => form.name === "Lend",
	);
	if (!form) throw new Error("The form was not created.");
	const submission = async () => {
		const doc = await h.currentDoc();
		const engine = new FormEngine(
			{
				form: doc.forms[form.uuid],
				formUuid: form.uuid,
				fields: doc.fields,
				fieldOrder: doc.fieldOrder,
				caseTypes: doc.caseTypes ?? [],
			},
			"loan",
		);
		engine.setValue("/data/borrower", "Ada");
		engine.setValue("/data/tool", "Drill");
		return engine.computeSubmissionMutation({
			entryKey: "11111111-1111-4111-8111-111111111111",
		});
	};
	expect(await submission()).toMatchObject({
		kind: "registration",
		primary: {
			caseName: "Ada - Drill",
			properties: { borrower: "Ada", tool: "Drill" },
		},
	});
	const read = z
		.object({ recordName: z.string() })
		.parse(await h.call("getForm", { formUuid: "Lend", moduleUuid: "Loans" }));
	const before = await h.currentDoc();
	await h.call("updateForm", {
		formUuid: "Lend",
		moduleUuid: "Loans",
		recordName: read.recordName,
	});
	expect(await h.currentDoc()).toEqual(before);
	await h.call("updateForm", {
		formUuid: "Lend",
		moduleUuid: "Loans",
		recordName: "#form/borrower",
	});
	expect(await submission()).toMatchObject({
		kind: "registration",
		primary: {
			caseName: "Ada",
			properties: { borrower: "Ada", tool: "Drill" },
		},
	});
	await h.call("createForm", {
		moduleUuid: "Loans",
		name: "Quick lend",
		type: "registration",
	});
	await h.call("addFields", {
		moduleUuid: "Loans",
		formUuid: "Quick lend",
		fields: [{ kind: "text", id: "name", label: "Loan name" }],
	});
	await h.call("updateForm", {
		moduleUuid: "Loans",
		formUuid: "Quick lend",
		recordName: "#form/name",
	});
	const quick = Object.values((await h.currentDoc()).forms).find(
		(form) => form.name === "Quick lend",
	);
	if (!quick) throw new Error("The quick form was not created.");
	const doc = await h.currentDoc();
	const engine = new FormEngine(
		{
			form: quick,
			formUuid: quick.uuid,
			fields: doc.fields,
			fieldOrder: doc.fieldOrder,
			caseTypes: doc.caseTypes ?? [],
		},
		"loan",
	);
	engine.setValue("/data/name", "Saw for Bea");
	expect(
		engine.computeSubmissionMutation({
			entryKey: "11111111-1111-4111-8111-111111111111",
		}),
	).toMatchObject({ primary: { caseName: "Saw for Bea" } });
	expect(doc.fieldOrder[quick.uuid]).toHaveLength(1);
	expect(await h.save()).toMatchObject({ saved: true });
});

it("binds Search rules to renamed answers and seeds a new no-matches form from them", async () => {
	const h = await makeDurableAuthoringHarness(db);
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
	await h.call("createModule", { name: "Clients", case_type: "client" });
	await h.call("createForm", {
		moduleUuid: "Clients",
		name: "Review",
		type: "followup",
	});
	await h.call("addFields", {
		moduleUuid: "Clients",
		formUuid: "Review",
		fields: [{ kind: "label", id: "name", label: "{{#case/case_name}}" }],
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
	const module = Object.values((await h.currentDoc()).modules).find(
		(module) => module.name === "Clients",
	);
	const input = module?.caseListConfig?.searchInputs[0];
	if (!input) throw new Error("Missing Search input.");
	await h.call("updateSearchInput", {
		moduleUuid: "Clients",
		searchInputUuid: "name",
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
		searchInputUuid: "name",
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
	});
	await h.call("addFields", {
		moduleUuid: "Clients",
		formUuid: "Add after search",
		fields: [
			{
				kind: "text",
				id: "name",
				caseWrite: { caseType: "client", property: "case_name" },
				default_value: "#search/client_name",
			},
		],
	});
	const seeded = Object.values((await h.currentDoc()).forms).find(
		(form) => form.name === "Add after search",
	);
	if (!seeded) throw new Error("Missing no-matches form.");
	const fieldId = (await h.currentDoc()).fieldOrder[seeded.uuid][0];
	expect((await h.currentDoc()).fields[fieldId]).toMatchObject({
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
	expect(await h.save()).toMatchObject({ saved: true });
});
