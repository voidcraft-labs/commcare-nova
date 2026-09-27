import { expect, it } from "vitest";
import { makeDurableAuthoringHarness } from "@/lib/agent/__tests__/durableAuthoringHarness";
import { runValidation } from "@/lib/commcare/validator/runner";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";

const db = setupAppStateTestDb("iterative_creation_", {
	authSchema: "migrated",
});

it("keeps incomplete modules and forms readable, preserves rejected work, and saves only the completed workflow", async () => {
	const h = await makeDurableAuthoringHarness(db);
	const module = await h.call(
		"createModule",
		{ name: "Patients", case_type: "patient" },
		"module",
	);
	expect(module).toMatchObject({
		ok: true,
		columns: [{ uuid: expect.any(String) }],
	});
	expect(module).not.toHaveProperty("forms");
	expect(
		await h.call(
			"createModule",
			{ name: "Patients", case_type: "patient" },
			"module",
		),
	).toEqual(module);
	expect(Object.values((await h.currentDoc()).forms)).toEqual([]);
	expect(
		await h.call("getModule", { moduleUuid: "Patients" }),
	).not.toHaveProperty("error");
	expect(await h.save("incomplete-module")).toMatchObject({ saved: false });
	expect(await loadApp((await h.currentDoc()).appId)).toBeNull();
	const form = await h.call("createForm", {
		moduleUuid: "Patients",
		name: "Register",
		type: "registration",
	});
	expect(form).toMatchObject({ ok: true, formUuid: expect.any(String) });
	expect(form).not.toHaveProperty("fields");
	expect(await h.call("getForm", { formUuid: "Register" })).toMatchObject({
		form: { fields: [] },
	});
	expect(await h.save("empty-form")).toMatchObject({ saved: false });
	expect(await loadApp((await h.currentDoc()).appId)).toBeNull();
	expect(
		await h.call("addFields", {
			formUuid: "Register",
			fields: [
				{ kind: "text", id: "name", label: "Name" },
				{ kind: "label", id: "confirmation", label: "Register {{name}}" },
			],
		}),
	).toMatchObject({ ok: true });
	expect(
		await h.call("updateForm", {
			formUuid: "Register",
			recordName: "#form/name",
		}),
	).toMatchObject({ ok: true });
	const candidate = await h.currentDoc();
	expect(runValidation(candidate, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expect(await h.save("complete")).toMatchObject({ saved: true });
	expect(await loadApp(candidate.appId)).not.toBeNull();
});

it("carries Search answers through explicit questions and record naming", async () => {
	const h = await makeDurableAuthoringHarness(db);
	for (const [name, input] of [
		["createModule", { name: "Patients", case_type: "patient" }],
		[
			"addSearchInputs",
			{
				moduleUuid: "Patients",
				searchInputs: [
					{
						kind: "simple",
						name: "name",
						label: "Name",
						type: "text",
						property: "case_name",
					},
				],
			},
		],
		[
			"createForm",
			{
				moduleUuid: "Patients",
				name: "Register",
				type: "registration",
				entry: { kind: "search-no-matches" },
			},
		],
		[
			"addFields",
			{
				formUuid: "Register",
				fields: [
					{
						kind: "text",
						id: "name",
						label: "Name",
						default_value: "#search/name",
					},
				],
			},
		],
		["updateForm", { formUuid: "Register", recordName: "#form/name" }],
		["createForm", { moduleUuid: "Patients", name: "Visit", type: "followup" }],
		[
			"addFields",
			{
				formUuid: "Visit",
				fields: [{ kind: "text", id: "notes", label: "Notes" }],
			},
		],
	] as const)
		expect(await h.call(name, input)).toMatchObject({ ok: true });
	expect(await h.call("getForm", { formUuid: "Register" })).not.toHaveProperty(
		"error",
	);
	expect(await h.save()).toMatchObject({ saved: true });
});

it("separates record ancestry from the explicit parent selection route", async () => {
	const h = await makeDurableAuthoringHarness(db);
	for (const [name, input] of [
		[
			"createModule",
			{ name: "Gardens", case_type: "garden", case_list_only: true },
		],
		[
			"createModule",
			{ name: "Plots", case_type: "plot", case_list_only: true },
		],
		["setCaseTypeParent", { caseType: "plot", parentType: "garden" }],
	] as const)
		expect(await h.call(name, input)).toMatchObject({ ok: true });
	const plot = Object.values((await h.currentDoc()).modules).find(
		(module) => module.name === "Plots",
	);
	expect(plot?.parentCaseModuleUuid).toBeUndefined();
	expect(
		await h.call("updateModule", {
			moduleUuid: "Plots",
			parentCaseModuleUuid: "Gardens",
		}),
	).toMatchObject({ ok: true });
	const garden = Object.values((await h.currentDoc()).modules).find(
		(module) => module.name === "Gardens",
	);
	expect(
		Object.values((await h.currentDoc()).modules).find(
			(module) => module.name === "Plots",
		)?.parentCaseModuleUuid,
	).toBe(garden?.uuid);
});
