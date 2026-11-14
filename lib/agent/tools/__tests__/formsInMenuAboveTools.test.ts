/** Where a menu's forms show, through the shared `updateModule` and
 * `getModule` tools over admitted documents, the production reducer and the
 * commit gate. Catches an input the gate refuses with no sentence to repair
 * it by, and a read that does not say which screen lists the forms. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import { getModuleTool } from "../getModule";
import { updateModuleTool } from "../updateModule";

const INTAKE = testUuid("above-intake");
const CLINIC = testUuid("above-clinic");
const ROUNDS = testUuid("above-rounds");
const ENTRY = testUuid("above-entry");

/** A top-level menu holding one registration form, and a top-level clinic
 *  menu with a submenu of its own, each a menu with its own screen. */
function doc(): BlueprintDoc {
	const built = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "above-intake",
				name: "Intake",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register patient",
						type: "registration",
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
			{
				uuid: "above-clinic",
				name: "Clinic",
				forms: [
					{
						name: "Clinic survey",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "above-rounds",
				name: "Rounds",
				forms: [
					{
						name: "Rounds survey",
						type: "survey",
						fields: [f({ kind: "text", id: "seen", label: proseText("Seen") })],
					},
				],
			},
		],
	});
	built.modules[ROUNDS].parentModuleUuid = CLINIC;
	return built;
}

async function read(
	h: ReturnType<typeof makeToolWorkspaceHarness>,
	uuid: string,
) {
	const result = await h.runTool(getModuleTool, { moduleUuid: uuid });
	if ("error" in result.data) throw new Error(result.data.error);
	return result.data;
}

describe("forms_in_menu_above through the module tools", () => {
	it("shows a top-level menu's forms on the first menu, reads where they list, and gives the menu its screen back", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc()));
		const before = await read(h, INTAKE);
		expect(before.formsInMenuAbove).toBe(false);
		expect(before.listsOn).toEqual({ kind: "menu", moduleUuid: INTAKE });

		const on = await h.runTool(updateModuleTool, {
			moduleUuid: INTAKE,
			forms_in_menu_above: true,
		});
		if ("error" in on.result) throw new Error(on.result.error);
		expect(on.result.formsInMenuAbove).toBe(true);
		expect(h.currentDoc().modules[INTAKE]?.formsInMenuAbove).toBe(true);
		const above = await read(h, INTAKE);
		expect(above.formsInMenuAbove).toBe(true);
		expect(above.listsOn).toEqual({ kind: "first-menu" });

		const off = await h.runTool(updateModuleTool, {
			moduleUuid: INTAKE,
			forms_in_menu_above: null,
		});
		if ("error" in off.result) throw new Error(off.result.error);
		expect(off.result.formsInMenuAbove).toBe(false);
		expect(h.currentDoc().modules[INTAKE]?.formsInMenuAbove).toBeUndefined();
		expect((await read(h, INTAKE)).listsOn).toEqual({
			kind: "menu",
			moduleUuid: INTAKE,
		});
	});

	it("reads a submenu that shows its forms above as listed on its parent's screen", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc()));
		const on = await h.runTool(updateModuleTool, {
			moduleUuid: ROUNDS,
			forms_in_menu_above: true,
		});
		if ("error" in on.result) throw new Error(on.result.error);
		expect((await read(h, ROUNDS)).listsOn).toEqual({
			kind: "menu",
			moduleUuid: CLINIC,
		});
	});

	it("refuses a menu an entry point opens with the gate's sentence, and changes nothing", async () => {
		const start = doc();
		start.modules[INTAKE].entryPoint = { uuid: ENTRY, id: "intake" };
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(start));
		const refused = await h.runTool(updateModuleTool, {
			moduleUuid: INTAKE,
			forms_in_menu_above: true,
		});
		expect(refused.mutations).toEqual([]);
		if (!("error" in refused.result)) throw new Error("expected a refusal");
		expect(refused.result.error).toContain("Intake");
		expect(refused.result.error.length).toBeGreaterThan(40);
		expect(h.currentDoc().modules[INTAKE]?.formsInMenuAbove).toBeUndefined();
	});
});
