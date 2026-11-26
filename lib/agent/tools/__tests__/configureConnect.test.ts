/** Canonical commands over admitted documents and a controlled workspace host.
 * The actual gate and reducer run; persistence and SA/MCP transport are separate boundaries. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import {
	type BlueprintDoc,
	NEW_APP_SETTINGS,
	type Platform,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import {
	configureConnectInputSchema,
	configureConnectTool,
} from "../configureConnect";

const MODULE = testUuid("10000000-0000-4000-8000-000000000000");
const FIRST = testUuid("20000000-0000-4000-8000-000000000000");
const SECOND = testUuid("30000000-0000-4000-8000-000000000000");

/** The app Connect is configured on: Android only unless `runsOnlyOn` says
 * otherwise, since a Connect app runs on Android alone and the tool turns
 * Connect on without narrowing. */
function fixture(runsOnlyOn: Platform | "both" = "android"): BlueprintDoc {
	return buildDoc({
		appId: "connect-app",
		appName: "Connect app",
		appSettings: {
			...NEW_APP_SETTINGS,
			...(runsOnlyOn === "both" ? {} : { runsOnlyOn }),
		},
		modules: [
			{
				uuid: MODULE,
				name: "Learning",
				forms: [
					{
						uuid: FIRST,
						name: "Lesson",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "lesson_note",
								label: proseText("Lesson note"),
							}),
						],
					},
					{
						uuid: SECOND,
						name: "Assessment",
						type: "survey",
						fields: [
							f({
								kind: "int",
								id: "score",
								label: proseText("Score"),
							}),
						],
					},
				],
			},
		],
	});
}

describe("Connect role authoring", () => {
	it("admits both roles on Android before an activity is placed, and keeps a repeated request out of history", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(fixture()));
		const first = await h.runTool(configureConnectTool, {
			roles: ["deliver", "learn"],
		});
		expect(first.result).toMatchObject({
			ok: true,
			roles: ["learn", "deliver"],
		});
		expect(h.currentDoc().connectRoles).toEqual(["learn", "deliver"]);
		expect(
			Object.values(h.currentDoc().fields).some(
				(field) => field.kind === "connect_activity",
			),
		).toBe(false);
		const repeated = await h.runTool(configureConnectTool, {
			roles: ["deliver", "learn"],
		});
		expect(repeated.mutations).toEqual([]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		const off = await h.runTool(configureConnectTool, { roles: [] });
		expect(off.result).toMatchObject({ ok: true, roles: [] });
		expect(h.currentDoc().appSettings.runsOnlyOn).toBe("android");
	});

	it.each(["web-apps", "both"] as const)(
		"keeps the existing app when %s cannot run its Connect activity",
		async (platform) => {
			const doc = expectAdmittedDoc(fixture(platform));
			const h = makeToolWorkspaceHarness(doc);
			const refused = await h.runTool(configureConnectTool, {
				roles: ["learn"],
			});
			expect(refused.result).toHaveProperty("error");
			expect(h.recordMutations).not.toHaveBeenCalled();
			expect(h.currentDoc()).toBe(doc);
		},
	);

	it("refuses duplicate roles and an old form participant record at the callable boundary", () => {
		expect(
			configureConnectInputSchema.safeParse({ roles: ["deliver", "deliver"] })
				.success,
		).toBe(false);
		expect(
			configureConnectInputSchema.safeParse({ mode: "learn", participants: [] })
				.success,
		).toBe(false);
	});
});
