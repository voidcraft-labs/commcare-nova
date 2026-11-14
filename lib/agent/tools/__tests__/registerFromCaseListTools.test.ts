/** Registration from the case list (`Module.caseListRegistrationForm`, the
 * `always` arm) through the shared `updateModule`, `setMenuMedia`,
 * `getModule` and `getForm` tools, over admitted documents, the production
 * planner, reducer and commit gate. Catches a first offer that stores no
 * `afterSubmit`, an update that drops the button's stored media, media
 * written onto a list that offers no form, and a read that loses the arm. */

import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import { getFormTool } from "../getForm";
import { getModuleTool } from "../getModule";
import { setMenuMediaTool } from "../media/setMenuMedia";
import { updateModuleTool } from "../updateModule";

vi.mock("@/lib/db/apps", () => ({
	loadAppProjectId: vi.fn(() =>
		Promise.resolve({ kind: "found", projectId: "project-1" }),
	),
}));
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetsByIds: () => {
		throw new Error("Built-in icons and clears read no asset row.");
	},
	findSourceAssets: () => {
		throw new Error("Menu media commands must not discover source documents.");
	},
}));

const HOST = testUuid("offer-host");
const REGISTRATION_MENU = testUuid("offer-registration-menu");
const REGISTER = testUuid("offer-register");

/** A case list whose one form opens an existing patient, and another menu
 *  holding a registration form of the same case type. */
function doc(registerPostSubmit?: "firstMenu"): BlueprintDoc {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "offer-host",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "offer-registration-menu",
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "offer-register",
						name: "Register patient",
						type: "registration",
						...(registerPostSubmit !== undefined && {
							postSubmit: registerPostSubmit,
						}),
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
}

function harness(start = doc()) {
	return makeToolWorkspaceHarness(expectAdmittedDoc(start), {
		projectId: "project-1",
	});
}

async function readModule(h: ReturnType<typeof harness>, moduleUuid: string) {
	const result = await h.runTool(getModuleTool, { moduleUuid });
	if ("error" in result.data) throw new Error(result.data.error);
	return result.data;
}

describe("register_from_case_list on update_module", () => {
	it("stores the first offer back to the list where after_submit is omitted, and reads it from both ends", async () => {
		const h = harness();
		const offered = await h.runTool(updateModuleTool, {
			moduleUuid: HOST,
			register_from_case_list: {
				formUuid: REGISTER,
				label: "Register a new patient",
			},
		});
		if ("error" in offered.result) throw new Error(offered.result.error);
		expect(offered.result.registerFromCaseList).toBe(true);
		expect(h.currentDoc().modules[HOST]?.caseListRegistrationForm).toEqual({
			kind: "always",
			formUuid: REGISTER,
			label: "Register a new patient",
			afterSubmit: "case-list",
		});
		// The form stays on its own menu.
		expect(h.currentDoc().formOrder[REGISTRATION_MENU]).toContain(REGISTER);

		const host = await readModule(h, HOST);
		expect(host.caseListRegistrationForm).toEqual({
			kind: "always",
			formUuid: REGISTER,
			label: "Register a new patient",
			afterSubmit: "case-list",
			followsFormAfterSubmit: false,
			icon: null,
			audio_label: null,
		});
		const menu = await readModule(h, REGISTRATION_MENU);
		expect(menu.forms[0]).toMatchObject({
			uuid: REGISTER,
			opensFromCaseList: false,
			offeredOnCaseListsOf: [HOST],
		});
		const form = await h.runTool(getFormTool, {
			moduleUuid: REGISTRATION_MENU,
			formUuid: REGISTER,
		});
		if ("error" in form.data) throw new Error(form.data.error);
		expect(form.data.offeredOnCaseListsOf).toEqual([HOST]);
	});

	it("keeps the Register button's media across an update that changes where a worker goes", async () => {
		const h = harness();
		await h.runTool(updateModuleTool, {
			moduleUuid: HOST,
			register_from_case_list: { formUuid: REGISTER },
		});
		const media = await h.runTool(setMenuMediaTool, {
			items: [
				{
					target: "case-list-registration",
					moduleUuid: HOST,
					icon: "register",
					audioLabel: null,
				},
			],
		});
		if (typeof media.result === "object" && "error" in media.result)
			throw new Error(media.result.error);
		const updated = await h.runTool(updateModuleTool, {
			moduleUuid: HOST,
			register_from_case_list: { formUuid: REGISTER, after_submit: "new-case" },
		});
		if ("error" in updated.result) throw new Error(updated.result.error);
		expect(h.currentDoc().modules[HOST]?.caseListRegistrationForm).toEqual({
			kind: "always",
			formUuid: REGISTER,
			icon: "nova-icon:register",
			afterSubmit: "new-case",
		});
		// An omitted after_submit keeps the stored choice.
		await h.runTool(updateModuleTool, {
			moduleUuid: HOST,
			register_from_case_list: { formUuid: REGISTER, label: "New patient" },
		});
		expect(h.currentDoc().modules[HOST]?.caseListRegistrationForm).toEqual({
			kind: "always",
			formUuid: REGISTER,
			label: "New patient",
			icon: "nova-icon:register",
			afterSubmit: "new-case",
		});
	});

	it("says a form with its own after-submit follows it from the list", async () => {
		const h = harness(doc("firstMenu"));
		const offered = await h.runTool(updateModuleTool, {
			moduleUuid: HOST,
			register_from_case_list: { formUuid: REGISTER },
		});
		if ("error" in offered.result) throw new Error(offered.result.error);
		expect((await readModule(h, HOST)).caseListRegistrationForm).toMatchObject({
			kind: "always",
			afterSubmit: "case-list",
			followsFormAfterSubmit: true,
		});
	});

	it("stops offering the form with null, in a clear that survives JSON", async () => {
		const h = harness();
		await h.runTool(updateModuleTool, {
			moduleUuid: HOST,
			register_from_case_list: { formUuid: REGISTER },
		});
		const offeredDoc = h.currentDoc();
		const cleared = await h.runTool(updateModuleTool, {
			moduleUuid: HOST,
			register_from_case_list: null,
		});
		if ("error" in cleared.result) throw new Error(cleared.result.error);
		expect(cleared.result.registerFromCaseList).toBe(false);
		expect(
			applyOverWire(offeredDoc, cleared.mutations).modules[HOST]
				?.caseListRegistrationForm,
		).toBeUndefined();
	});

	it("refuses a form that registers no case of the list's type, in the gate's words", async () => {
		const h = harness();
		const refused = await h.runTool(updateModuleTool, {
			moduleUuid: HOST,
			register_from_case_list: {
				formUuid: h.currentDoc().formOrder[HOST]?.[0] ?? REGISTER,
			},
		});
		expect(refused.mutations).toEqual([]);
		if (!("error" in refused.result)) throw new Error("expected a refusal");
		expect(refused.result.error).toContain("Visit");
		expect(
			h.currentDoc().modules[HOST]?.caseListRegistrationForm,
		).toBeUndefined();
	});
});

describe("set_menu_media on a case list's Register button", () => {
	it("refuses a list that offers no registration form, naming the input that offers one", async () => {
		const h = harness();
		const result = await h.runTool(setMenuMediaTool, {
			items: [
				{
					target: "case-list-registration",
					moduleUuid: HOST,
					icon: "register",
					audioLabel: null,
				},
			],
		});
		expect(result.mutations).toEqual([]);
		const error = (result.result as { error?: string }).error ?? "";
		expect(error).toContain("items[0]");
		expect(error).toContain("offers no registration form on its case list");
		expect(error).toContain("register_from_case_list on update_module");
		expect(
			h.currentDoc().modules[HOST]?.caseListRegistrationForm,
		).toBeUndefined();
	});
});
