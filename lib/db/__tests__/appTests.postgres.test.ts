import { describe, expect, it } from "vitest";
import { AppAccessError } from "../appAccess";
import {
	AppTestUnavailableError,
	advanceAppTestSession,
	createAppTestSession,
	listAppTests,
	readAppTestSteps,
} from "../appTests";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("app_test_sessions_");
const scope = {
	appId: "test-app",
	projectId: "test-project",
	actorUserId: "author",
};

async function setup() {
	await h.seedApp({
		id: scope.appId,
		owner: scope.actorUserId,
		project_id: scope.projectId,
	});
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
}
function start(requestId = "start") {
	return createAppTestSession({
		...scope,
		requestId,
		requestDigest: "start-digest",
		expectedBlueprintSeq: 0,
		initialize: async () => ({
			snapshot: {},
			state: { count: 0 },
			observation: { screen: "home" },
		}),
	});
}

describe("app test session authority and evidence", () => {
	it("distinguishes unavailable test identities from lost app authority without exposing another app's test", async () => {
		await setup();
		const begun = await start();
		const other = { ...scope, appId: "another-app" };
		await h.seedApp({
			id: other.appId,
			owner: scope.actorUserId,
			project_id: scope.projectId,
		});
		expect((await listAppTests(other)).tests).toEqual([]);
		for (const testId of [
			begun.testId,
			"70000000-0000-4000-8000-000000000001",
		]) {
			await expect(
				readAppTestSteps({ ...other, testId }),
			).rejects.toBeInstanceOf(AppTestUnavailableError);
			await expect(
				advanceAppTestSession({
					...other,
					testId,
					requestId: "missing",
					requestDigest: "missing",
					expectedStep: 0,
					action: { kind: "home" },
					advance: async () => {
						throw new Error("Unavailable test must not execute");
					},
				}),
			).rejects.toBeInstanceOf(AppTestUnavailableError);
		}
		expect(
			(await readAppTestSteps({ ...scope, testId: begun.testId })).steps,
		).toHaveLength(1);
		await h.seedProjectMember("colleague", scope.projectId, "viewer");
		const colleague = { ...scope, actorUserId: "colleague" };
		expect(
			(await readAppTestSteps({ ...colleague, testId: begun.testId })).steps,
		).toHaveLength(1);
		await expect(
			advanceAppTestSession({
				...colleague,
				testId: begun.testId,
				requestId: "foreign-creator",
				requestDigest: "foreign-creator",
				expectedStep: 0,
				action: { kind: "home" },
				advance: async () => {
					throw new Error("Another actor must not continue the test");
				},
			}),
		).rejects.toBeInstanceOf(AppTestUnavailableError);
		await h
			.pool()
			.query('DELETE FROM auth_member WHERE "userId" = $1', [
				scope.actorUserId,
			]);
		await expect(
			readAppTestSteps({ ...scope, testId: begun.testId }),
		).rejects.toBeInstanceOf(AppAccessError);
	});

	it("bounds active tests and permits disposal after expiry, step exhaustion or a changed source", async () => {
		await setup();
		const tests = [];
		for (let index = 0; index < 8; index++)
			tests.push(await start(`start-${index}`));
		await expect(start("overflow")).rejects.toThrow("eight active tests");
		const expired = tests[0];
		await h
			.db()
			.updateTable("app_test_sessions")
			.set({ expires_at: new Date(0) })
			.where("id", "=", expired.testId)
			.execute();
		const action = {
			...scope,
			testId: expired.testId,
			requestId: "step",
			requestDigest: "digest",
			expectedStep: 0,
			action: { kind: "observe" },
			advance: async () => ({ state: {}, observation: { ok: true } }),
		};
		await expect(advanceAppTestSession(action)).rejects.toThrow("expired");
		await start("replacement");
		expect(
			(await readAppTestSteps({ ...scope, testId: expired.testId }))
				.disposed_at,
		).not.toBeNull();
		const exhausted = tests[1];
		await h
			.db()
			.updateTable("app_test_sessions")
			.set({ step: 200 })
			.where("id", "=", exhausted.testId)
			.execute();
		await expect(
			advanceAppTestSession({
				...action,
				testId: exhausted.testId,
				expectedStep: 200,
			}),
		).rejects.toThrow("200-step");
		await h
			.db()
			.updateTable("apps")
			.set({ mutation_seq: 1 })
			.where("id", "=", scope.appId)
			.execute();
		const finished = await advanceAppTestSession({
			...action,
			testId: exhausted.testId,
			action: { kind: "finish" },
		});
		expect(finished.observation).toEqual({ ended: true });
		expect(
			await advanceAppTestSession({
				...action,
				testId: exhausted.testId,
				requestId: "finish-again",
				action: { kind: "finish" },
			}),
		).toEqual(finished);
	});
	it("keeps old-runtime evidence readable and disposable without executing another action", async () => {
		await setup();
		const begun = await start();
		await h
			.db()
			.updateTable("app_test_sessions")
			.set({ runtime_version: 1 })
			.where("id", "=", begun.testId)
			.execute();
		const action = {
			...scope,
			testId: begun.testId,
			requestId: "new-step",
			requestDigest: "new-step",
			expectedStep: 0,
			action: { kind: "observe" },
			advance: async () => {
				throw new Error("Old runtime must not execute");
			},
		};
		await expect(advanceAppTestSession(action)).rejects.toThrow(
			"runtime changed",
		);
		expect(
			(await readAppTestSteps({ ...scope, testId: begun.testId })).steps,
		).toHaveLength(1);
		expect(
			await advanceAppTestSession({ ...action, action: { kind: "finish" } }),
		).toMatchObject({ observation: { ended: true } });
		expect(
			(await readAppTestSteps({ ...scope, testId: begun.testId })).disposed_at,
		).not.toBeNull();
	});
	it("serializes a retry into one saved step and retains evidence after disposal", async () => {
		await setup();
		const begun = await start();
		expect(await start()).toEqual(begun);
		let calls = 0;
		const action = {
			...scope,
			testId: begun.testId,
			requestId: "step",
			requestDigest: "step-digest",
			expectedStep: 0,
			action: { kind: "home" },
			advance: async () => {
				calls++;
				return { state: { count: 1 }, observation: { count: 1 } };
			},
		};
		const [first, retry] = await Promise.all([
			advanceAppTestSession(action),
			advanceAppTestSession(action),
		]);
		expect(first).toEqual(retry);
		expect(first.step).toBe(1);
		expect(calls).toBe(1);
		await expect(
			advanceAppTestSession({ ...action, requestDigest: "different" }),
		).rejects.toThrow("different inputs");
		await expect(
			advanceAppTestSession({ ...action, requestId: "new" }),
		).rejects.toThrow("advanced this test");
		await advanceAppTestSession({
			...action,
			requestId: "finish",
			expectedStep: 1,
			advance: async () => ({
				state: {},
				observation: { ended: true },
				finished: true,
			}),
		});
		const evidence = await readAppTestSteps({ ...scope, testId: begun.testId });
		expect(evidence.blueprint_seq).toBe(evidence.currentBlueprintSeq);
		const listed = await listAppTests(scope);
		expect(listed.tests[0].blueprint_seq).toBe(listed.currentBlueprintSeq);
		expect(evidence.disposed_at).not.toBeNull();
		expect(evidence.steps.map((step) => step.observation)).toEqual([
			{ screen: "home" },
			{ count: 1 },
			{ ended: true },
		]);
	});

	it("reauthorizes the real actor before replay, fences changed apps, and records no partial failed step", async () => {
		await setup();
		const begun = await start();
		const action = {
			...scope,
			testId: begun.testId,
			requestId: "step",
			requestDigest: "step-digest",
			expectedStep: 0,
			action: { kind: "home" },
			advance: async () => ({ state: {}, observation: { ok: true } }),
		};
		await expect(
			advanceAppTestSession({
				...action,
				advance: async () => {
					throw new Error("failed observation");
				},
			}),
		).rejects.toThrow("failed observation");
		expect(
			(await readAppTestSteps({ ...scope, testId: begun.testId })).steps,
		).toHaveLength(1);
		await advanceAppTestSession(action);
		await expect(
			advanceAppTestSession({ ...action, actorUserId: "preview-worker" }),
		).rejects.toBeInstanceOf(AppAccessError);
		await h
			.db()
			.updateTable("apps")
			.set({ mutation_seq: 1 })
			.where("id", "=", scope.appId)
			.execute();
		await expect(
			advanceAppTestSession({ ...action, requestId: "new", expectedStep: 1 }),
		).rejects.toThrow("app changed");
		await h
			.pool()
			.query('DELETE FROM auth_member WHERE "userId" = $1', [
				scope.actorUserId,
			]);
		await expect(advanceAppTestSession(action)).rejects.toBeInstanceOf(
			AppAccessError,
		);
		await expect(
			readAppTestSteps({ ...scope, testId: begun.testId }),
		).rejects.toBeInstanceOf(AppAccessError);
	});
});
