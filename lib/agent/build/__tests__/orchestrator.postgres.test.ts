/** The production orchestrator over migrated PostgreSQL. The design-loop
 * outcome is an explicit model boundary; all durable transitions are real. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { FIXTURE_THREAD_ID } from "@/lib/agent/design/__tests__/fixtures";
import { persistAcceptedDesignFixture } from "@/lib/agent/design/__tests__/persistedFixtures";
import { buildDesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { setDesignSessionActiveArtifacts } from "@/lib/db/designSessions";
import {
	type OrchestratorStreamWriter,
	type RunBuildOrchestrationArgs,
	runBuildOrchestration,
} from "../orchestrator";
import { readOrchestrationHead } from "../orchestratorState";

const h = setupAppStateTestDb("orchestrator_native_", { poolMax: 3 });
beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "synthetic-local-only"));
afterEach(() => vi.unstubAllEnvs());
const ACTOR = "owner-test";
const PROJECT = "project-test";
const RUN = "run-orchestrator-native";
const NONCE = "6a0a35a4-1111-4222-8333-944445555666";
async function setup(
	loop: NonNullable<RunBuildOrchestrationArgs["deps"]>["runDesignLoop"],
) {
	const proposedAppId = crypto.randomUUID();
	const session = await h.seedDesignSession({
		proposed_app_id: proposedAppId,
		owner_user_id: ACTOR,
		project_id: PROJECT,
		run_id: RUN,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 60_000),
		reservation: {
			period: "2026-09",
			reserved: 1,
			settled: false,
			userId: ACTOR,
			runId: RUN,
		},
	});
	const chunks: Parameters<OrchestratorStreamWriter["write"]>[0][] = [];
	const args: RunBuildOrchestrationArgs = {
		designSessionId: session,
		proposedAppId,
		projectId: PROJECT,
		projectRole: "owner",
		actorUserId: ACTOR,
		runId: RUN,
		holderNonce: NONCE,
		threadId: FIXTURE_THREAD_ID,
		messages: [
			{
				id: "m1",
				role: "user",
				parts: [{ type: "text", text: "Track patients and their visits." }],
			},
		],
		responseMessageId: "assistant-one",
		writer: {
			write(chunk) {
				chunks.push(chunk);
			},
		},
		apiKey: "synthetic-local-only",
		meter: undefined,
		signal: new AbortController().signal,
		materializedAppId: null,
		finalizeCompletion: async () => {
			throw new Error("No app can complete in pre-app design fixtures");
		},
		deps: {
			buildPackage: (args) =>
				buildDesignSourcePackage({
					...args,
					messages: [
						{
							id: "m1",
							role: "user",
							parts: [
								{ type: "text", text: "Track patients and their visits." },
							],
						},
					],
					deps: {
						async loadAssets(ids) {
							if (ids.length) throw new Error("Text fixture requested assets");
							return [];
						},
						async readExtract() {
							throw new Error("Text fixture requested extraction");
						},
						async loadImage() {
							throw new Error("Text fixture requested image");
						},
					},
				}),
			runDesignLoop: loop,
		},
	};
	return { args, chunks, session };
}

describe("native orchestration", () => {
	it("durably pauses the exact owned session and brackets its one assistant message", async () => {
		const fixture = await setup(async (args) => {
			expect(
				(await readOrchestrationHead(args.designSessionId))?.state.kind,
			).toBe("designing");
			args.writer.write({ type: "text-start", id: "model-text" });
			args.writer.write({
				type: "text-delta",
				id: "model-text",
				delta: "Which queue opens first?",
			});
			args.writer.write({ type: "text-end", id: "model-text" });
			return { kind: "awaiting-input", headRevisionId: null };
		});
		expect(await runBuildOrchestration(fixture.args)).toEqual({
			kind: "awaiting-input",
			pauseOwned: true,
		});
		expect((await readOrchestrationHead(fixture.session))?.state).toEqual({
			kind: "awaiting-user-questions",
			designSessionId: fixture.session,
			designRevisionId: null,
		});
		expect(
			(
				await h
					.db()
					.selectFrom("design_sessions")
					.selectAll()
					.where("id", "=", fixture.session)
					.executeTakeFirstOrThrow()
			).awaiting_input,
		).toBe(true);
		expect(fixture.chunks.map((chunk) => chunk.type)).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		expect(await h.db().selectFrom("apps").selectAll().execute()).toEqual([]);
	});
	it.each([true, false])(
		"records recoverable=%s failures with no canned transcript prose",
		async (recoverable) => {
			const fixture = await setup(async () => ({
				kind: "failed",
				errorType: "offline-provider-protocol",
				message: "The provider response was unusable.",
				recoverable,
			}));
			expect(await runBuildOrchestration(fixture.args)).toEqual({
				kind: "failed",
				errorType: "offline-provider-protocol",
				message: "The provider response was unusable.",
				recoverable,
				appId: null,
			});
			expect(
				(await readOrchestrationHead(fixture.session))?.state,
			).toMatchObject({
				kind: "failed",
				recoverable,
				errorType: "offline-provider-protocol",
			});
			expect(fixture.chunks.map((chunk) => chunk.type)).toEqual([
				"start",
				"finish",
			]);
			expect(await h.db().selectFrom("apps").selectAll().execute()).toEqual([]);
		},
	);
	it("reuses the frozen accepted plan and persists a bounded executor refusal without model prose", async () => {
		const fixture = await setup(async () => {
			throw new Error("A frozen plan must not reenter design");
		});
		const authority = {
			actorUserId: ACTOR,
			runId: RUN,
			holderNonce: NONCE,
			expectedProjectId: PROJECT,
		};
		const accepted = await persistAcceptedDesignFixture({
			designSessionId: fixture.session,
			authority,
		});
		await setDesignSessionActiveArtifacts({
			...authority,
			designSessionId: fixture.session,
			activeDesignRevisionId: accepted.accepted.id,
			activeBuildPlanId: accepted.plan.id,
		});
		let calls = 0;
		const outcome = await runBuildOrchestration({
			...fixture.args,
			deps: {
				...fixture.args.deps,
				executorStep: async () => {
					calls += 1;
					return {
						toolCalls: [],
						text: "private executor prose",
						usage: undefined,
						responseMessages: [
							{ role: "assistant", content: "private executor prose" },
						],
					};
				},
			},
		});
		expect(outcome).toMatchObject({
			kind: "failed",
			errorType: "no-tool-call",
			recoverable: false,
			appId: null,
		});
		expect(calls).toBe(3);
		expect((await readOrchestrationHead(fixture.session))?.state).toMatchObject(
			{ kind: "failed", recoverable: false, errorType: "no-tool-call" },
		);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select(["status", "failure_code"])
				.execute(),
		).toEqual([{ status: "failed", failure_code: "no-tool-call" }]);
		expect(
			await h.db().selectFrom("design_committed_slices").selectAll().execute(),
		).toEqual([]);
		expect(
			await h.db().selectFrom("design_model_steps").selectAll().execute(),
		).toHaveLength(6);
		expect(
			fixture.chunks.filter(
				(chunk) =>
					chunk.type.startsWith("text-") || chunk.type.startsWith("reasoning-"),
			),
		).toEqual([]);
		expect(fixture.chunks.map((chunk) => chunk.type)).toEqual([
			"start",
			"data-design-outline",
			"data-build-plan-summary",
			"data-build-slice-started",
			"finish",
		]);
		expect(await h.db().selectFrom("apps").selectAll().execute()).toEqual([]);
	});
	it("joins an in-flight heartbeat when model work fails and stops its interval", async () => {
		const entered = Promise.withResolvers<void>();
		const failModel = Promise.withResolvers<void>();
		const fault = new Error("provider interrupted while heartbeat waited");
		const fixture = await setup(async () => {
			entered.resolve();
			await failModel.promise;
			throw fault;
		});
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const pending = runBuildOrchestration(fixture.args).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		try {
			await Promise.race([
				entered.promise,
				pending.then((outcome) => {
					throw new Error("Orchestration ended before model entry", {
						cause: outcome,
					});
				}),
			]);
			const outcome = await whileBlocked(
				h,
				(pg) =>
					pg.query("SELECT id FROM design_sessions WHERE id=$1 FOR UPDATE", [
						fixture.session,
					]),
				async () => {
					await vi.advanceTimersByTimeAsync(60_000);
					failModel.resolve();
					return pending;
				},
				async (settled) => {
					expect(settled).toBe(false);
				},
				() => failModel.resolve(),
			);
			expect(outcome).toEqual({ error: fault });
			expect(vi.getTimerCount()).toBe(0);
			expect(fixture.chunks.at(-1)).toEqual({ type: "finish" });
		} finally {
			entered.resolve();
			failModel.resolve();
			await pending;
			vi.useRealTimers();
		}
	});
});
