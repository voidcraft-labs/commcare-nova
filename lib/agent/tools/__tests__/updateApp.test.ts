/** `updateApp` over admitted documents and a controlled workspace host. The
 * production schema, handler, gate and reducer run; persistence and SA/MCP
 * transport are separate boundaries. */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import type { AppSettings, BlueprintDoc } from "@/lib/domain";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import {
	UPDATE_APP_EMPTY_INPUT_MESSAGE,
	updateAppInputSchema,
	updateAppTool,
} from "../updateApp";

function fixture(appSettings?: AppSettings): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Clinic",
			...(appSettings !== undefined && { appSettings }),
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [f({ id: "note", kind: "text", label: "Note" })],
						},
					],
				},
			],
		}),
	);
}

describe("updateApp", () => {
	it("refuses a call that names nothing to change", () => {
		const parsed = updateAppInputSchema.safeParse({});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
			UPDATE_APP_EMPTY_INPUT_MESSAGE,
		]);
	});

	it("renames the app with one setAppName", async () => {
		const harness = makeToolWorkspaceHarness(fixture());
		const outcome = await harness.runTool(updateAppTool, {
			name: "Village Health",
		});
		expect(outcome.mutations).toEqual([
			{ kind: "setAppName", name: "Village Health" },
		]);
		expect(outcome.result).toEqual({
			ok: true,
			summary: { subject: "Village Health", nameChange: "renamed" },
		});
		expect(harness.currentDoc().appName).toBe("Village Health");
	});

	it.each([
		[{ show_saved_forms: true }, { showSavedForms: true }, { saved: true }],
		[
			{ show_incomplete_forms: true },
			{ showIncompleteForms: true },
			{ incomplete: true },
		],
	])(
		"changes one setting alone with one setAppSettings holding it",
		async (input, settings, formLists) => {
			const harness = makeToolWorkspaceHarness(fixture());
			const outcome = await harness.runTool(updateAppTool, input);
			expect(outcome.mutations).toEqual([{ kind: "setAppSettings", settings }]);
			expect(outcome.result).toEqual({ ok: true, summary: { formLists } });
			expect(harness.currentDoc().appSettings).toEqual({
				showSavedForms: false,
				showIncompleteForms: false,
				...settings,
			});
		},
	);

	it("names the app and sets both settings in one batch", async () => {
		const harness = makeToolWorkspaceHarness(fixture());
		const outcome = await harness.runTool(updateAppTool, {
			name: "Village Health",
			show_saved_forms: true,
			show_incomplete_forms: true,
		});
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
		expect(outcome.mutations).toEqual([
			{ kind: "setAppName", name: "Village Health" },
			{
				kind: "setAppSettings",
				settings: { showSavedForms: true, showIncompleteForms: true },
			},
		]);
		expect(harness.currentDoc().appSettings).toEqual({
			showSavedForms: true,
			showIncompleteForms: true,
		});
	});

	it("commits nothing when every given setting already holds", async () => {
		const doc = fixture({ showSavedForms: true, showIncompleteForms: false });
		const harness = makeToolWorkspaceHarness(doc);
		const outcome = await harness.runTool(updateAppTool, {
			show_saved_forms: true,
			show_incomplete_forms: false,
		});
		expect(outcome).toEqual({
			kind: "mutate",
			mutations: [],
			result: { ok: true, summary: { noop: true } },
		});
		expect(harness.recordMutations).not.toHaveBeenCalled();
		expect(harness.currentDoc()).toBe(doc);
	});
});
