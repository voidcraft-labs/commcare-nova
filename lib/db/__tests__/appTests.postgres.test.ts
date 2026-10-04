import { Kysely, PostgresDialect, type PostgresPool, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { AppAccessError } from "../appAccess";
import {
	AppTestUnavailableError,
	advanceAppTestSession,
	createAppTestSession,
	listAppTests,
	readAppTestSteps,
} from "../appTests";
import { __setAppDbForTests, type AppDatabase } from "../pg";
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
			.set({ runtime_version: 2 })
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

it("commits a bounded batch prefix with an exact receipt and rolls every prefix effect back on infrastructure failure", async () => {
	await setup();
	const begun = await start();
	const args = {
		...scope,
		testId: begun.testId,
		requestId: "batch",
		requestDigest: "batch-digest",
		expectedStep: 0,
		actions: [
			{ action: { kind: "observe" } },
			{ action: { kind: "observe" } },
			{ action: { kind: "observe" } },
		],
	};
	let count = 0;
	await expect(
		advanceAppTestSession({
			...args,
			advance: async () => {
				count += 1;
				if (count === 2) throw new Error("connection interrupted");
				return { state: { count }, observation: { count } };
			},
		}),
	).rejects.toThrow("connection interrupted");
	expect(
		(await readAppTestSteps({ ...scope, testId: begun.testId })).steps,
	).toHaveLength(1);
	expect(
		await h.db().selectFrom("app_test_requests").selectAll().execute(),
	).toEqual([]);
	count = 0;
	const response = await advanceAppTestSession({
		...args,
		advance: async () => {
			count += 1;
			return {
				state: { count },
				observation: { count },
				...(count === 2
					? { stopReason: "Worker validation stopped the next action." }
					: {}),
			};
		},
	});
	expect(response).toMatchObject({
		step: 2,
		stopped: { index: 1 },
		results: [{ step: 1 }, { step: 2 }],
	});
	await h
		.db()
		.updateTable("apps")
		.set({ mutation_seq: 1 })
		.where("id", "=", scope.appId)
		.execute();
	expect(
		await advanceAppTestSession({
			...args,
			advance: async () => {
				throw new Error("Receipt replay must not execute");
			},
		}),
	).toEqual(response);
	await expect(
		advanceAppTestSession({
			...args,
			requestDigest: "different",
			advance: async () => {
				throw new Error("Must refuse");
			},
		}),
	).rejects.toThrow("different inputs");
	await h
		.pool()
		.query('DELETE FROM auth_member WHERE "userId" = $1', [scope.actorUserId]);
	await expect(
		advanceAppTestSession({
			...args,
			advance: async () => {
				throw new Error("Must refuse");
			},
		}),
	).rejects.toBeInstanceOf(AppAccessError);
});

it("counts every batch action at the 200-step boundary while keeping finish available", async () => {
	await setup();
	const begun = await start();
	await h
		.db()
		.updateTable("app_test_sessions")
		.set({ step: 199 })
		.where("id", "=", begun.testId)
		.execute();
	const response = await advanceAppTestSession({
		...scope,
		testId: begun.testId,
		requestId: "last-actions",
		requestDigest: "last-actions",
		expectedStep: 199,
		actions: [{ action: { kind: "observe" } }, { action: { kind: "observe" } }],
		advance: async () => ({ state: {}, observation: { seen: true } }),
	});
	expect(response).toMatchObject({
		step: 200,
		results: [{ step: 200 }],
		stopped: { index: 1 },
	});
	const finished = await advanceAppTestSession({
		...scope,
		testId: begun.testId,
		requestId: "finish",
		requestDigest: "finish",
		expectedStep: 200,
		actions: [{ action: { kind: "finish" } }],
		advance: async () => {
			throw new Error("Finish does not run the worker");
		},
	});
	expect(finished).toMatchObject({ step: 201, observation: { ended: true } });
});

it("keeps paged evidence on one upper bound and preserves access to oversized Unicode observations", async () => {
	await setup();
	const text = "Review 🌍 café 漢字\n".repeat(5000);
	const begun = await createAppTestSession({
		...scope,
		requestId: "large",
		requestDigest: "large",
		expectedBlueprintSeq: 0,
		initialize: async () => ({
			snapshot: {},
			state: {},
			observation: { suppliedRecords: [], explanation: text },
		}),
	});
	const first = await readAppTestSteps({
		...scope,
		testId: begun.testId,
		limit: 1,
	});
	expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
		64 * 1024,
	);
	expect(first).toMatchObject({
		runtime_version: 10,
		throughStep: 0,
		provenance: { value: { suppliedRecords: [] } },
		steps: [{ step: 0, observation: null, inspection: { step: 0 } }],
	});
	const inspected = await readAppTestSteps({
		...scope,
		testId: begun.testId,
		throughStep: first.throughStep,
		inspect: { step: 0, path: ["observation", "explanation"] },
	});
	expect(inspected.inspection).toMatchObject({
		kind: "string",
		complete: false,
		nextOffset: expect.any(Number),
	});
	await advanceAppTestSession({
		...scope,
		testId: begun.testId,
		requestId: "later",
		requestDigest: "later",
		expectedStep: 0,
		action: { kind: "observe" },
		advance: async () => ({ state: {}, observation: { later: true } }),
	});
	const originalWindow = await readAppTestSteps({
		...scope,
		testId: begun.testId,
		afterStep: 0,
		throughStep: first.throughStep,
	});
	expect(originalWindow.steps).toEqual([]);
	expect(originalWindow.step).toBe(1);
	const latest = await readAppTestSteps({
		...scope,
		testId: begun.testId,
		afterStep: 0,
	});
	expect(latest.steps).toMatchObject([
		{ step: 1, observation: { later: true } },
	]);
});

it("rolls back the whole action list and receipt when its database deadline expires after a successful prefix", async () => {
	await setup();
	const begun = await start();
	let actions = 0;
	const pool = new Pool({ connectionString: h.uri(), max: 1 });
	const disconnected: Error[] = [];
	pool.on("connect", (client) =>
		client.on("error", (error) => disconnected.push(error)),
	);
	const timed = new Kysely<AppDatabase>({
		dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
	});
	__setAppDbForTests(timed);
	try {
		await expect(
			advanceAppTestSession({
				...scope,
				testId: begun.testId,
				requestId: "deadline",
				requestDigest: "deadline",
				expectedStep: 0,
				deadlineAt: Date.now() + 150,
				actions: [
					{ action: { kind: "observe" } },
					{ action: { kind: "observe" } },
				],
				advance: async (tx) => {
					actions++;
					if (actions === 2) await sql`SELECT pg_sleep(10)`.execute(tx);
					return { state: { count: actions }, observation: { count: actions } };
				},
			}),
		).rejects.toThrow();
	} finally {
		__setAppDbForTests(h.db());
		await timed.destroy();
		if (!pool.ended) await pool.end();
	}
	expect(disconnected).toHaveLength(1);
	expect(disconnected[0].message).toBe("Connection terminated unexpectedly");
	expect(actions).toBe(2);
	const evidence = await readAppTestSteps({ ...scope, testId: begun.testId });
	expect(evidence.steps).toHaveLength(1);
	expect(
		await h
			.db()
			.selectFrom("app_test_requests")
			.selectAll()
			.where("test_id", "=", begun.testId)
			.execute(),
	).toEqual([]);
	expect(
		(
			await h
				.db()
				.selectFrom("app_test_sessions")
				.select("step")
				.where("id", "=", begun.testId)
				.executeTakeFirstOrThrow()
		).step,
	).toBe(0);
});
