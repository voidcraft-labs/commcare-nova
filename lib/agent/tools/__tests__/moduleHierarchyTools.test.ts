import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { createModuleTool } from "../createModule";
import { getModuleTool } from "../getModule";

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
	it("creates a child atomically and returns parent and child identities", async () => {
		const doc = rootDoc();
		const parentModuleUuid = doc.moduleOrder[0];
		if (parentModuleUuid === undefined)
			throw new Error("parent fixture missing");
		const harness = makeToolWorkspaceHarness(doc);
		const created = await harness.runTool(createModuleTool, {
			parentModuleUuid,
			name: "Follow-up",
			forms: [
				{
					name: "Check in",
					type: "survey",
					fields: [
						{
							id: "notes",
							kind: "text",
							label: proseText("Notes"),
						},
					],
				},
			],
		});
		if ("error" in created.result) throw new Error(created.result.error);
		expect(created.result.parentModuleUuid).toBe(parentModuleUuid);
		expect(created.result.childModuleUuids).toEqual([]);

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
