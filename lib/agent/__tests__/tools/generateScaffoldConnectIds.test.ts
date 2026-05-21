/**
 * Connect-id source enforcement on the `generateScaffold` tool.
 *
 * The scaffold is where the SA first lands per-form connect blocks. Like
 * `update_form`, it must autofill an omitted id (valid, unique, name-
 * derived, stored on the doc) and FAIL THE CALL on an explicit invalid id
 * — writing nothing. These tests pin both arms.
 */

import { describe, expect, it, vi } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { generateScaffoldTool } from "../../tools/generateScaffold";
import { makeMinimalDoc, makeTestContext } from "../fixtures";

vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
}));

/** Empty doc the scaffold builds onto. */
function emptyDoc(): BlueprintDoc {
	return makeMinimalDoc();
}

describe("generateScaffold connect-id validity", () => {
	it("autofills omitted connect ids from the module/form name", async () => {
		const { ctx } = makeTestContext();
		const result = await generateScaffoldTool.execute(
			{
				app_name: "Training App",
				connect_type: "learn",
				modules: [
					{
						name: "Onboarding",
						forms: [
							{
								name: "Intro Lesson",
								type: "survey",
								// id-less learn_module → autofilled from module name.
								connect: {
									learn_module: {
										name: "Intro",
										description: "x",
										time_estimate: 5,
									},
								},
							},
						],
					},
				],
			},
			ctx,
			emptyDoc(),
		);

		// No error; the scaffold landed.
		expect(result.result).not.toHaveProperty("error");
		const moduleUuid = result.newDoc.moduleOrder[0];
		const formUuid = result.newDoc.formOrder[moduleUuid][0];
		const lm = result.newDoc.forms[formUuid]?.connect?.learn_module;
		expect(lm?.id).toBe("onboarding"); // toSnakeId("Onboarding")
	});

	it("fails the whole call (no mutations) on an explicit invalid id", async () => {
		const { ctx } = makeTestContext();
		const result = await generateScaffoldTool.execute(
			{
				app_name: "Training App",
				connect_type: "learn",
				modules: [
					{
						name: "Onboarding",
						forms: [
							{
								name: "Intro Lesson",
								type: "survey",
								connect: {
									learn_module: {
										id: "bad id", // illegal element name
										name: "Intro",
										description: "x",
										time_estimate: 5,
									},
								},
							},
						],
					},
				],
			},
			ctx,
			emptyDoc(),
		);

		expect(result.mutations).toEqual([]);
		expect(result.result).toHaveProperty("error");
		expect((result.result as { error: string }).error).toContain("bad id");
	});
});
