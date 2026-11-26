import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	ROUTE,
	twoMenus,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { createModuleTool } from "../createModule";
import { getModuleTool } from "../getModule";
import { updateAppTool } from "../updateApp";
import { updateModuleTool } from "../updateModule";

function rootDoc() {
	return buildDoc({
		modules: [
			{
				name: "Services",
				forms: [
					{
						name: "Welcome",
						type: "survey" as const,
						fields: [f({ id: "welcome", kind: "text" })],
					},
				],
			},
		],
	});
}

describe("module hierarchy shared tools", () => {
	it("keeps the chosen grid while the app shows lists and reads the effective screen layout", async () => {
		const doc = expectAdmittedDoc(rootDoc());
		const [moduleUuid] = doc.moduleOrder;
		const harness = makeToolWorkspaceHarness(doc);
		const chosen = await harness.runTool(updateModuleTool, {
			moduleUuid,
			menu_layout: "grid",
		});
		expect(chosen.result).toMatchObject({ menuLayout: "grid" });
		async function read() {
			return (await harness.runTool(getModuleTool, { moduleUuid })).data;
		}
		expect(await read()).toMatchObject({
			menuLayout: "grid",
			formsMenuLayout: "list",
		});
		await harness.runTool(updateAppTool, { form_menu_layout: "individual" });
		expect(await read()).toMatchObject({
			menuLayout: "grid",
			formsMenuLayout: "grid",
		});
		await harness.runTool(updateModuleTool, {
			moduleUuid,
			menu_layout: "list",
		});
		expect(await read()).toMatchObject({
			menuLayout: "list",
			formsMenuLayout: "list",
		});
	});

	it("refuses a layout on a menu listing another menu's forms and changes nothing", async () => {
		const doc = expectAdmittedDoc(twoMenus());
		const harness = makeToolWorkspaceHarness(doc);
		const refused = await harness.runTool(updateModuleTool, {
			moduleUuid: ROUTE,
			menu_layout: "grid",
		});
		expect(refused.result).toMatchObject({
			error: expect.stringContaining("form_menu_layout on update_app"),
		});
		expect(harness.recordMutations).not.toHaveBeenCalled();
		expect(harness.currentDoc().modules[ROUTE]?.menuLayout).toBeUndefined();
	});

	it("names, reads and clears the results of an inactive search through the shared tools", async () => {
		const doc = expectAdmittedDoc(rootDoc());
		const moduleUuid = doc.moduleOrder[0];
		const harness = makeToolWorkspaceHarness(doc);
		for (const name of ["Région2", null]) {
			const changed = await harness.runTool(updateModuleTool, {
				moduleUuid,
				searchResultsName: name,
			});
			if ("error" in changed.result) throw new Error(changed.result.error);
			const found = await harness.runTool(getModuleTool, { moduleUuid });
			if ("error" in found.data) throw new Error(found.data.error);
			expect(found.data.searchResultsName).toBe(name);
			expect(
				harness.currentDoc().modules[moduleUuid].caseSearchConfig,
			).toBeUndefined();
		}
	});

	it("creates a child record viewer and reads back parent and child identities", async () => {
		const doc = expectAdmittedDoc(rootDoc());
		const parentModuleUuid = doc.moduleOrder[0];
		if (parentModuleUuid === undefined)
			throw new Error("parent fixture missing");
		const harness = makeToolWorkspaceHarness(doc);
		const created = await harness.runTool(createModuleTool, {
			parentModuleUuid,
			name: "Follow-up",
			case_type: "visit",
			case_list_menu_item: {},
		});
		if ("error" in created.result) throw new Error(created.result.error);
		expect(created.result.parentModuleUuid).toBe(parentModuleUuid);
		expect(created.result.childModuleUuids).toEqual([]);
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
		expectAdmittedDoc(harness.currentDoc());

		const parent = await harness.runTool(getModuleTool, {
			moduleUuid: parentModuleUuid,
		});
		if ("error" in parent.data) throw new Error(parent.data.error);
		expect(parent.data.parent_module_uuid).toBeNull();
		expect(parent.data.child_module_uuids).toEqual([created.result.moduleUuid]);

		const child = await harness.runTool(getModuleTool, {
			moduleUuid: created.result.moduleUuid,
		});
		if ("error" in child.data) throw new Error(child.data.error);
		expect(child.data.parent_module_uuid).toBe(parentModuleUuid);
		expect(child.data.child_module_uuids).toEqual([]);
	});
});
