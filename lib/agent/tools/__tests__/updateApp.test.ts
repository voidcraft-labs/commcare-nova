/** `updateApp` over admitted documents and a controlled workspace host. The
 * production schema, handler, gate and reducer run; persistence and SA/MCP
 * transport are separate boundaries. */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import {
	describeCommitFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type AppSettings,
	type BlueprintDoc,
	NEW_APP_SETTINGS,
} from "@/lib/domain";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import {
	UPDATE_APP_EMPTY_INPUT_MESSAGE,
	updateAppInputSchema,
	updateAppTool,
} from "../updateApp";

function fixture(
	appSettings?: AppSettings,
	extraFields: ReturnType<typeof f>[] = [],
): BlueprintDoc {
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
							fields: [
								f({ id: "note", kind: "text", label: "Note" }),
								...extraFields,
							],
						},
					],
				},
			],
		}),
	);
}

const ANDROID_ONLY: AppSettings = {
	...NEW_APP_SETTINGS,
	runsOnlyOn: "android",
};

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

	describe("runs_only_on", () => {
		it("narrows the app with one setAppSettings and reports where it runs", async () => {
			const harness = makeToolWorkspaceHarness(fixture());
			const outcome = await harness.runTool(updateAppTool, {
				runs_only_on: "android",
			});
			expect(outcome.mutations).toEqual([
				{ kind: "setAppSettings", settings: { runsOnlyOn: "android" } },
			]);
			expect(outcome.result).toEqual({
				ok: true,
				summary: { platforms: "android" },
			});
			expect(harness.currentDoc().appSettings.runsOnlyOn).toBe("android");
		});

		it("returns an Android-only app to both with runsOnlyOn null", async () => {
			const harness = makeToolWorkspaceHarness(fixture(ANDROID_ONLY));
			const outcome = await harness.runTool(updateAppTool, {
				runs_only_on: null,
			});
			expect(outcome.mutations).toEqual([
				{ kind: "setAppSettings", settings: { runsOnlyOn: null } },
			]);
			expect(outcome.result).toEqual({
				ok: true,
				summary: { platforms: "both" },
			});
			expect(harness.currentDoc().appSettings.runsOnlyOn).toBeUndefined();
		});

		it.each([
			["the platform it already runs on", ANDROID_ONLY, "android"],
			["both, where it already runs on both", undefined, null],
		] as const)("stages nothing for %s", async (_, settings, runsOnlyOn) => {
			const doc = fixture(settings);
			const harness = makeToolWorkspaceHarness(doc);
			const outcome = await harness.runTool(updateAppTool, {
				runs_only_on: runsOnlyOn,
			});
			expect(outcome).toEqual({
				kind: "mutate",
				mutations: [],
				result: { ok: true, summary: { noop: true } },
			});
			expect(harness.recordMutations).not.toHaveBeenCalled();
		});

		it("refuses to add Web Apps to an app holding a date-and-time question, in the gate's own words", async () => {
			const doc = fixture(ANDROID_ONLY, [
				f({ id: "visit_time", kind: "datetime", label: "Visit time" }),
			]);
			const harness = makeToolWorkspaceHarness(doc);
			const outcome = await harness.runTool(updateAppTool, {
				runs_only_on: null,
			});
			const gate = mutationCommitVerdict(
				doc,
				[{ kind: "setAppSettings", settings: { runsOnlyOn: null } }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (gate.ok) throw new Error("The gate admitted the widening.");
			expect(outcome.mutations).toEqual([]);
			expect(outcome.result).toEqual({
				error: describeCommitFindings(gate.findings),
			});
			expect(outcome.result).toMatchObject({
				error: expect.stringContaining('Question "visit_time"'),
			});
			expect(harness.recordMutations).not.toHaveBeenCalled();
			expect(harness.currentDoc()).toBe(doc);
		});
	});
});
