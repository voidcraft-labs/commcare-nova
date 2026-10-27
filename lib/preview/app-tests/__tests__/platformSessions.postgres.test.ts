/** App Test sessions per platform, through the real service and its
 * persisted checkpoints: where a session starts and returns, which page
 * actions each platform offers, and what a submission's `app_home` opens. */
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { RUNTIME_VERSION } from "@/lib/db/appTests";
import type { BlueprintDoc } from "@/lib/domain";
import { platformUnavailableSentence } from "@/lib/preview/platform";
import { createEvaluationApp } from "../../engine/__tests__/evaluationFixture";
import { sectionEntryDoc } from "../../engine/__tests__/fixtures/sectionEntry";
import { AppTestActionError } from "../errors";
import { continueAppTest, startAppTest } from "../service";
import { type AppTestAction, appTestStartSchema } from "../types";

const h = setupAppStateTestDb("app_test_platforms_", {
	authSchema: "migrated",
});
const scope = {
	appId: "platform-app",
	projectId: "platform-project",
	actorUserId: "author",
};

/** The module and form the test names, by their names. */
function named(doc: BlueprintDoc, moduleName: string, formName: string) {
	const moduleUuid = doc.moduleOrder.find(
		(uuid) => doc.modules[uuid].name === moduleName,
	);
	const formUuid = moduleUuid
		? doc.formOrder[moduleUuid]?.find(
				(uuid) => doc.forms[uuid].name === formName,
			)
		: undefined;
	if (!moduleUuid || !formUuid)
		throw new Error(`Missing ${moduleName} / ${formName}.`);
	return { moduleUuid, formUuid };
}

async function seed(doc: BlueprintDoc): Promise<void> {
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
}

async function begin(input: Record<string, unknown>) {
	let current = await startAppTest(scope, {
		requestId: "start",
		expectedBlueprintSeq: 0,
		input: { purpose: "Run the app on each platform", ...input },
	});
	let request = 0;
	const step = async (action: AppTestAction, sessionId?: string) => {
		current = await continueAppTest(scope, {
			testId: current.testId,
			requestId: `step-${++request}`,
			expectedStep: current.step,
			...(sessionId === undefined
				? { action }
				: { actions: [{ sessionId, action }] }),
		});
		return current.observation as Record<string, unknown>;
	};
	return {
		started: current.observation as Record<string, unknown>,
		step,
		testId: () => current.testId,
	};
}

it("admits a platform for the whole test and for one session", () => {
	expect(
		appTestStartSchema.parse({
			purpose: "Both",
			platform: "android",
			sessions: [{ id: "web", platform: "web-apps" }, { id: "phone" }],
		}),
	).toMatchObject({
		platform: "android",
		sessions: [{ id: "web", platform: "web-apps" }, { id: "phone" }],
	});
	expect(() =>
		appTestStartSchema.parse({ purpose: "Neither", platform: "ios" }),
	).toThrow();
});

it("refuses a platform the saved app does not run on, naming the one it does", async () => {
	const doc = await createEvaluationApp(
		[{ name: "Surveys", forms: [{ name: "Survey", type: "survey" }] }],
		[],
	);
	const webOnly = structuredClone(doc);
	webOnly.appSettings = { ...webOnly.appSettings, runsOnlyOn: "web-apps" };
	await seed(webOnly);
	const refusal = startAppTest(scope, {
		requestId: "start",
		expectedBlueprintSeq: 0,
		input: { purpose: "Run it on a phone", platform: "android" },
	});
	await expect(refusal).rejects.toBeInstanceOf(AppTestActionError);
	await expect(refusal).rejects.toThrow(
		platformUnavailableSentence("android", "a session"),
	);
});

it("starts an Android session on the phone's home screen and returns there", async () => {
	await seed(sectionEntryDoc());
	const run = await begin({ platform: "android" });
	expect(run.started).toMatchObject({
		screen: "device-home",
		platform: { selected: "android" },
		actions: expect.arrayContaining(["continue"]),
	});
	expect(await run.step({ kind: "continue" })).toMatchObject({
		screen: "home",
		platform: { selected: "android" },
	});
	expect(await run.step({ kind: "home" })).toMatchObject({
		screen: "device-home",
	});
	await run.step({ kind: "finish" });
});

it("draws a sectioned form as one screen on Web Apps, with no page actions", async () => {
	const doc = sectionEntryDoc();
	await seed(doc);
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const second = Object.values(doc.fields).find((f) => f.id === "second");
	if (!second) throw new Error("Missing the second section.");
	const run = await begin({ platform: "web-apps" });
	expect(run.started).toMatchObject({ screen: "home" });
	await run.step({ kind: "menu", moduleUuid });
	const opened = await run.step({ kind: "form", formUuid });
	expect(opened).toMatchObject({ platform: { selected: "web-apps" } });
	expect(opened.actions).not.toContain("pageNext");
	expect(opened.actions).not.toContain("pagePrevious");
	const sectioned = await run.step({
		kind: "section",
		sectionUuid: second.uuid,
	});
	expect(sectioned.questions).toEqual(opened.questions);
	await run.step({ kind: "finish" });
});

it("turns an unsectioned form one screen per page on Android and refuses a section", async () => {
	const doc = await createEvaluationApp(
		[{ name: "Surveys", forms: [{ name: "Survey", type: "survey" }] }],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Surveys",
					formUuid: "Survey",
					fields: [
						{ id: "first", kind: "text", label: "First", required: true },
						{ id: "second", kind: "text", label: "Second" },
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Surveys",
					formUuid: "Survey",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	await seed(doc);
	const { moduleUuid, formUuid } = named(doc, "Surveys", "Survey");
	const run = await begin({ platform: "android" });
	await run.step({ kind: "continue" });
	await run.step({ kind: "menu", moduleUuid });
	const firstScreen = await run.step({ kind: "form", formUuid });
	expect(firstScreen).toMatchObject({
		pageNavigation: { canNext: true, canPrevious: false },
	});
	/* A required question left empty holds the turn on its screen, and the
	 * turn reports that it did not complete. */
	expect(await run.step({ kind: "pageNext" })).toMatchObject({
		completed: false,
		pageNavigation: { canNext: true, canPrevious: false },
	});
	await run.step({
		kind: "answer",
		answers: [{ path: "first", value: "Answered" }],
	});
	const secondScreen = await run.step({ kind: "pageNext" });
	expect(secondScreen).toMatchObject({
		completed: true,
		pageNavigation: { canNext: false, canPrevious: true },
	});
	expect(
		await run.step({ kind: "section", sectionUuid: formUuid }),
	).toMatchObject({ completed: false });
	await run.step({ kind: "finish" });
});

it("lands a submission's app_home on the first screen in Web Apps and the phone's home on Android", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Clients",
				caseType: "client",
				forms: [{ name: "Register", type: "registration" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Clients",
					formUuid: "Register",
					fields: [{ id: "name", kind: "text", label: "Name", required: true }],
				},
			},
			{
				toolName: "updateForm",
				input: {
					moduleUuid: "Clients",
					formUuid: "Register",
					recordName: "#form/name",
					post_submit: "app_home",
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Clients",
					formUuid: "Register",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	await seed(doc);
	const { moduleUuid, formUuid } = named(doc, "Clients", "Register");
	const run = await begin({
		sessions: [
			{ id: "web", platform: "web-apps" },
			{ id: "phone", platform: "android" },
		],
	});
	for (const [sessionId, entry, landing] of [
		["web", [], "home"],
		["phone", [{ kind: "continue" }], "device-home"],
	] as const) {
		for (const action of entry) await run.step(action, sessionId);
		await run.step({ kind: "menu", moduleUuid }, sessionId);
		await run.step({ kind: "form", formUuid }, sessionId);
		await run.step(
			{
				kind: "answer",
				answers: [{ path: "name", value: `Asha ${sessionId}` }],
			},
			sessionId,
		);
		expect(await run.step({ kind: "submit" }, sessionId)).toMatchObject({
			sessionId,
			savedInTest: true,
			screen: landing,
			platform: { selected: sessionId === "web" ? "web-apps" : "android" },
		});
	}
	await run.step({ kind: "finish" }, "phone");
});

it("refuses to continue a test started under the previous runtime", async () => {
	await seed(sectionEntryDoc());
	const run = await begin({});
	await h
		.db()
		.updateTable("app_test_sessions")
		.set({ runtime_version: RUNTIME_VERSION - 1 })
		.where("id", "=", run.testId())
		.execute();
	await expect(run.step({ kind: "observe" })).rejects.toThrow(
		"Nova's test runtime changed. Start a new test.",
	);
});
