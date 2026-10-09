import type { UIMessage } from "ai";
import type { Transaction } from "kysely";
import { describe, expect, it } from "vitest";
import { commitThreadInputPause } from "@/lib/chat/threadInputRounds";
import {
	claimAndReserveRun,
	completeAndSettleRun,
	reacquireLease,
} from "../apps";
import {
	claimAndReserveDesignSessionRun,
	completeAndSettleDesignSessionRun,
	reacquireDesignSessionLease,
} from "../designSessions";
import type { GenerationTarget } from "../generationTargets";
import { getCurrentPeriod } from "../period";
import type { AppDatabase } from "../pg";
import {
	checkInputRoundInTransaction,
	checkThreadClaimContinuationInTransaction,
	consumeInputRoundInTransaction,
	InputRoundRejectedError,
	loadThread,
	upsertThreadTurn,
} from "../threads";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("input_round_");
const ACTOR = "round-owner";
const PROJECT = "project-test";
const RUN = "initial-run";
const NONCE = "00000000-0000-4000-8000-000000000001";
const THREAD = "input-round-thread";
const user: UIMessage = {
	id: "request",
	role: "user",
	parts: [{ type: "text", text: "Build an intake app" }],
};
const question: UIMessage = {
	id: "assistant",
	role: "assistant",
	parts: [
		{ type: "step-start" },
		{
			type: "tool-askQuestions",
			toolCallId: "question-call",
			state: "input-available",
			input: {
				header: "Workflow",
				questions: [
					{
						question: "Who visits?",
						options: [{ label: "Children" }, { label: "Adults" }],
					},
				],
			},
		},
	],
};
const answered: UIMessage = {
	...question,
	parts: question.parts.map((part) =>
		part.type === "tool-askQuestions" && part.state === "input-available"
			? { ...part, state: "output-available", output: { "0": "Children" } }
			: part,
	),
};

async function seed(
	kind: "app" | "design-session",
	pauseKind: "questions" | "message" | "review" = "questions",
) {
	const period = getCurrentPeriod();
	await h.seedCreditMonth(ACTOR, period, {
		allowance: 1000,
		consumed: 100,
		bonus: 0,
	});
	const reservation = {
		period,
		reserved: 100,
		settled: false,
		userId: ACTOR,
		runId: RUN,
	};
	const target: GenerationTarget =
		kind === "app"
			? {
					kind,
					appId: await h.seedApp({
						owner: ACTOR,
						project_id: PROJECT,
						status: "generating",
						run_id: RUN,
						run_holder_nonce: NONCE,
						reservation,
					}),
				}
			: {
					kind,
					designSessionId: await h.seedDesignSession({
						owner_user_id: ACTOR,
						project_id: PROJECT,
						run_id: RUN,
						run_holder_nonce: NONCE,
						run_actor_user_id: ACTOR,
						run_lease_expires_at: new Date(Date.now() + 600_000),
						reservation,
					}),
				};
	await upsertThreadTurn({
		target,
		threadId: THREAD,
		runId: RUN,
		streamId: "initial-stream",
		holderNonce: NONCE,
		threadType: "build",
		messages: [user],
		expectedProjectId: PROJECT,
	});
	const round = await commitThreadInputPause({
		target,
		holderTarget: target,
		threadId: THREAD,
		streamId: "initial-stream",
		runId: RUN,
		holderNonce: NONCE,
		mode: "build",
		actorUserId: ACTOR,
		expectedProjectId: PROJECT,
		responseMessage:
			pauseKind === "questions"
				? question
				: {
						...answered,
						parts: [
							...answered.parts,
							{ type: "text", text: "Send your next instruction." },
						],
					},
		pause: {
			kind: pauseKind,
			origin: "durable-call-origin",
			toolCallIds: pauseKind === "questions" ? ["question-call"] : [],
		},
	});
	return { target, round, period };
}

async function snapshot(target: GenerationTarget) {
	return {
		thread: await h
			.db()
			.selectFrom("threads")
			.selectAll()
			.where("thread_id", "=", THREAD)
			.executeTakeFirstOrThrow(),
		holder:
			target.kind === "app"
				? await h
						.db()
						.selectFrom("apps")
						.selectAll()
						.where("id", "=", target.appId)
						.executeTakeFirstOrThrow()
				: await h
						.db()
						.selectFrom("design_sessions")
						.selectAll()
						.where("id", "=", target.designSessionId)
						.executeTakeFirstOrThrow(),
		consumed: await h.readConsumed(ACTOR, getCurrentPeriod()),
	};
}

for (const kind of ["app", "design-session"] as const)
	describe(`${kind} input round`, () => {
		it("commits the pending invitation, final response and pause together; a failed state commit changes nothing", async () => {
			const { target, round } = await seed(kind);
			const before = await snapshot(target);
			expect(before.thread.active_stream_id).toBeNull();
			expect(before.thread.input_round).toEqual(round);
			expect(before.holder.awaiting_input).toBe(true);
			await expect(
				commitThreadInputPause({
					target,
					holderTarget: target,
					threadId: THREAD,
					streamId: "initial-stream",
					runId: RUN,
					holderNonce: NONCE,
					mode: "build",
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
					responseMessage: question,
					pause: {
						kind: "questions",
						origin: "durable-call-origin",
						toolCallIds: ["question-call"],
					},
					commitState: async () => {
						throw new Error("Committed pause state must not append twice");
					},
				}),
			).resolves.toEqual(round);
			expect(await snapshot(target)).toEqual(before);
			expect((await loadThread(target, THREAD, ACTOR))?.input_round).toEqual(
				round,
			);
			await expect(
				commitThreadInputPause({
					target,
					holderTarget: target,
					threadId: THREAD,
					streamId: "initial-stream",
					runId: RUN,
					holderNonce: NONCE,
					mode: "build",
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
					responseMessage: { ...question, id: "different" },
					pause: {
						kind: "message",
						origin: "different-origin",
						toolCallIds: [],
					},
					commitState: async (tx) => {
						await tx
							.updateTable("threads")
							.set({ summary: "uncommitted-state" })
							.where("thread_id", "=", THREAD)
							.execute();
						throw new Error("state commit failed");
					},
				}),
			).rejects.toThrow("state commit failed");
			expect(await snapshot(target)).toEqual(before);
		});

		it("admits exactly one concurrent free answer and does not renew or append on a duplicate", async () => {
			const { target, round } = await seed(kind);
			const attempt = (streamId: string) => {
				const continuation = {
					check: async (tx: Transaction<AppDatabase>) =>
						checkInputRoundInTransaction(tx, {
							target,
							threadId: THREAD,
							inputRoundId: round.id,
							holderNonce: NONCE,
							actorUserId: ACTOR,
							runId: RUN,
							messages: [user, answered],
						}),
					commit: async (tx: Transaction<AppDatabase>) => {
						await upsertThreadTurn(
							{
								target,
								threadId: THREAD,
								runId: RUN,
								streamId,
								holderNonce: NONCE,
								threadType: "build",
								messages: [user, answered],
								expectedProjectId: PROJECT,
							},
							tx,
						);
						await consumeInputRoundInTransaction(tx, {
							threadId: THREAD,
							streamId,
							messages: [user, answered],
						});
					},
				};
				return target.kind === "app"
					? reacquireLease(
							target.appId,
							RUN,
							NONCE,
							"build",
							ACTOR,
							PROJECT,
							continuation,
						)
					: reacquireDesignSessionLease(
							target.designSessionId,
							RUN,
							NONCE,
							ACTOR,
							PROJECT,
							continuation,
						);
			};
			const results = await Promise.allSettled([
				attempt("answer-a"),
				attempt("answer-b"),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const loser = results.find((result) => result.status === "rejected");
			expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(
				InputRoundRejectedError,
			);
			const won = await snapshot(target);
			expect(won.thread.input_round?.state).toBe("consumed");
			expect(won.thread.active_stream_id).toBe(
				won.thread.input_round?.acceptedStreamId,
			);
			expect(won.holder.awaiting_input).toBe(false);
			expect(won.thread.messages).toHaveLength(2);
			await expect(attempt("answer-c")).rejects.toBeInstanceOf(
				InputRoundRejectedError,
			);
			expect(await snapshot(target)).toEqual(won);
			await expect(
				commitThreadInputPause({
					target,
					holderTarget: target,
					threadId: THREAD,
					streamId: won.thread.active_stream_id as string,
					runId: RUN,
					holderNonce: NONCE,
					mode: "build",
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
					responseMessage: question,
					pause: {
						kind: "questions",
						origin: "durable-call-origin",
						toolCallIds: ["question-call"],
					},
				}),
			).rejects.toThrow("consumed input round");
			expect(await snapshot(target)).toEqual(won);
		});

		it("checks a chargeable answer before replacing the reservation, and atomically binds only one new holder", async () => {
			const { target, round } = await seed(kind);
			const followup: UIMessage = {
				id: "followup",
				role: "user",
				parts: [{ type: "text", text: "Use the attached workflow too" }],
			};
			const messages = [user, answered, followup];
			const attempt = (id: string, nonce: string) => {
				const continuation = {
					check: async (tx: Transaction<AppDatabase>) =>
						checkInputRoundInTransaction(tx, {
							target,
							threadId: THREAD,
							inputRoundId: round.id,
							holderNonce: NONCE,
							actorUserId: ACTOR,
							runId: RUN,
							messages,
						}),
					commit: async (tx: Transaction<AppDatabase>, holderNonce: string) => {
						await upsertThreadTurn(
							{
								target,
								threadId: THREAD,
								runId: id,
								streamId: id,
								holderNonce,
								threadType: "build",
								messages,
								expectedProjectId: PROJECT,
							},
							tx,
						);
						await consumeInputRoundInTransaction(tx, {
							threadId: THREAD,
							streamId: id,
							messages,
						});
					},
				};
				return target.kind === "app"
					? claimAndReserveRun(
							target.appId,
							"build",
							id,
							ACTOR,
							100,
							PROJECT,
							nonce,
							{ continuation },
						)
					: claimAndReserveDesignSessionRun(
							target.designSessionId,
							id,
							ACTOR,
							100,
							PROJECT,
							nonce,
							continuation,
						);
			};
			const results = await Promise.allSettled([
				attempt("charged-a", "00000000-0000-4000-8000-000000000002"),
				attempt("charged-b", "00000000-0000-4000-8000-000000000003"),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const loser = results.find((result) => result.status === "rejected");
			expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(
				InputRoundRejectedError,
			);
			const won = await snapshot(target);
			expect(won.thread.input_round?.state).toBe("consumed");
			expect(won.thread.run_id).toBe(won.thread.input_round?.acceptedStreamId);
			expect(won.thread.messages).toHaveLength(3);
			expect(won.consumed).toBe(100);
			await expect(
				attempt("charged-c", "00000000-0000-4000-8000-000000000004"),
			).rejects.toBeInstanceOf(InputRoundRejectedError);
			expect(await snapshot(target)).toEqual(won);
		});

		it("projects only the old unresolved final card and consumes that exact invitation once", async () => {
			const { target } = await seed(kind);
			await h
				.db()
				.updateTable("threads")
				.set({ input_round: null })
				.where("thread_id", "=", THREAD)
				.execute();
			const loaded = await loadThread(target, THREAD, ACTOR);
			expect(loaded?.input_round?.id).toMatch(/^legacy-questions:/);
			expect(loaded?.input_round?.toolCallIds).toEqual(["question-call"]);
			expect((await snapshot(target)).thread.input_round).toBeNull();
			const check = async (tx: Transaction<AppDatabase>) =>
				checkInputRoundInTransaction(tx, {
					target,
					threadId: THREAD,
					inputRoundId: loaded?.input_round?.id,
					holderNonce: NONCE,
					actorUserId: ACTOR,
					runId: RUN,
					messages: [user, answered],
				});
			const commit = async (tx: Transaction<AppDatabase>) => {
				await upsertThreadTurn(
					{
						target,
						threadId: THREAD,
						runId: RUN,
						streamId: "legacy-answer",
						holderNonce: NONCE,
						threadType: "build",
						messages: [user, answered],
						expectedProjectId: PROJECT,
					},
					tx,
				);
				await consumeInputRoundInTransaction(tx, {
					threadId: THREAD,
					streamId: "legacy-answer",
					messages: [user, answered],
				});
			};
			await (target.kind === "app"
				? reacquireLease(target.appId, RUN, NONCE, "build", ACTOR, PROJECT, {
						check,
						commit,
					})
				: reacquireDesignSessionLease(
						target.designSessionId,
						RUN,
						NONCE,
						ACTOR,
						PROJECT,
						{ check, commit },
					));
			expect((await snapshot(target)).thread.input_round).toMatchObject({
				id: loaded?.input_round?.id,
				state: "consumed",
				acceptedStreamId: "legacy-answer",
			});
		});

		it("does not turn historical answered cards followed by prose into an invitation", async () => {
			const { target } = await seed(kind);
			const legacyEnd: UIMessage = {
				...answered,
				parts: [
					...answered.parts,
					{ type: "text", text: "Tell me when you are ready." },
				],
			};
			await h
				.db()
				.updateTable("threads")
				.set({ input_round: null, messages: JSON.stringify([user, legacyEnd]) })
				.where("thread_id", "=", THREAD)
				.execute();
			expect((await loadThread(target, THREAD, ACTOR))?.input_round).toBeNull();
			const before = await snapshot(target);
			const check = async (tx: Transaction<AppDatabase>) =>
				checkInputRoundInTransaction(tx, {
					target,
					threadId: THREAD,
					holderNonce: NONCE,
					actorUserId: ACTOR,
					runId: RUN,
					messages: [user, legacyEnd],
				});
			const commit = async () => {
				throw new Error("Must not commit historical answers");
			};
			await expect(
				target.kind === "app"
					? reacquireLease(target.appId, RUN, NONCE, "build", ACTOR, PROJECT, {
							check,
							commit,
						})
					: reacquireDesignSessionLease(
							target.designSessionId,
							RUN,
							NONCE,
							ACTOR,
							PROJECT,
							{ check, commit },
						),
			).rejects.toBeInstanceOf(InputRoundRejectedError);
			expect(await snapshot(target)).toEqual(before);
		});

		it.each(["message", "review"] as const)(
			"requires a fresh user message for a %s pause instead of replaying historical answers",
			async (pauseKind) => {
				const { target, round } = await seed(kind, pauseKind);
				const before = await snapshot(target);
				const history = before.thread.messages as UIMessage[];
				const continueWith = (messages: UIMessage[]) => {
					const continuation = {
						check: async (tx: Transaction<AppDatabase>) =>
							checkInputRoundInTransaction(tx, {
								target,
								threadId: THREAD,
								inputRoundId: round.id,
								holderNonce: NONCE,
								actorUserId: ACTOR,
								runId: RUN,
								messages,
							}),
						commit: async (tx: Transaction<AppDatabase>, nonce: string) => {
							await upsertThreadTurn(
								{
									target,
									threadId: THREAD,
									runId: "typed-resume",
									streamId: "typed-resume",
									holderNonce: nonce,
									threadType: "build",
									messages,
									expectedProjectId: PROJECT,
								},
								tx,
							);
							await consumeInputRoundInTransaction(tx, {
								threadId: THREAD,
								streamId: "typed-resume",
								messages,
							});
						},
					};
					return target.kind === "app"
						? claimAndReserveRun(
								target.appId,
								"build",
								"typed-resume",
								ACTOR,
								100,
								PROJECT,
								"00000000-0000-4000-8000-000000000005",
								{ continuation },
							)
						: claimAndReserveDesignSessionRun(
								target.designSessionId,
								"typed-resume",
								ACTOR,
								100,
								PROJECT,
								"00000000-0000-4000-8000-000000000005",
								continuation,
							);
				};
				await expect(continueWith(history)).rejects.toBeInstanceOf(
					InputRoundRejectedError,
				);
				expect(await snapshot(target)).toEqual(before);
				const fresh: UIMessage = {
					id: "new-instruction",
					role: "user",
					parts: [
						{ type: "text", text: "Please continue with the review changes." },
					],
				};
				await continueWith([...history, fresh]);
				const after = await snapshot(target);
				expect(after.thread.messages).toEqual([...history, fresh]);
				expect(after.thread.input_round).toMatchObject({
					id: round.id,
					state: "consumed",
					acceptedStreamId: "typed-resume",
				});
				await expect(continueWith([...history, fresh])).rejects.toBeInstanceOf(
					InputRoundRejectedError,
				);
				expect(await snapshot(target)).toEqual(after);
			},
		);

		it("deduplicates a legacy typed answer after unpause, while admitting a distinct user message after completion", async () => {
			const { target } = await seed(kind, "message");
			await h
				.db()
				.updateTable("threads")
				.set({ input_round: null })
				.where("thread_id", "=", THREAD)
				.execute();
			const history = (await snapshot(target)).thread.messages as UIMessage[];
			const first: UIMessage = {
				id: "legacy-typed",
				role: "user",
				parts: [{ type: "text", text: "Continue" }],
			};
			const attempt = (messages: UIMessage[], id: string, nonce: string) => {
				let consume = false;
				const continuation = {
					check: async (tx: Transaction<AppDatabase>) => {
						consume = await checkThreadClaimContinuationInTransaction(tx, {
							target,
							threadId: THREAD,
							holderNonce: NONCE,
							actorUserId: ACTOR,
							runId: RUN,
							messages,
						});
					},
					commit: async (tx: Transaction<AppDatabase>, holderNonce: string) => {
						await upsertThreadTurn(
							{
								target,
								threadId: THREAD,
								runId: id,
								streamId: id,
								holderNonce,
								threadType: "build",
								messages,
								expectedProjectId: PROJECT,
								clearInputRound: !consume,
							},
							tx,
						);
						if (consume)
							await consumeInputRoundInTransaction(tx, {
								threadId: THREAD,
								streamId: id,
								messages,
							});
					},
				};
				return target.kind === "app"
					? claimAndReserveRun(
							target.appId,
							"build",
							id,
							ACTOR,
							100,
							PROJECT,
							nonce,
							{ continuation },
						)
					: claimAndReserveDesignSessionRun(
							target.designSessionId,
							id,
							ACTOR,
							100,
							PROJECT,
							nonce,
							continuation,
						);
			};
			const messages = [...history, first];
			await attempt(
				messages,
				"legacy-winner",
				"00000000-0000-4000-8000-000000000006",
			);
			const live = await snapshot(target);
			await expect(
				attempt(
					messages,
					"legacy-duplicate",
					"00000000-0000-4000-8000-000000000007",
				),
			).rejects.toBeInstanceOf(InputRoundRejectedError);
			expect(await snapshot(target)).toEqual(live);
			if (target.kind === "app")
				await completeAndSettleRun(
					target.appId,
					"legacy-winner",
					"00000000-0000-4000-8000-000000000006",
				);
			else
				await completeAndSettleDesignSessionRun(
					target.designSessionId,
					"legacy-winner",
					"00000000-0000-4000-8000-000000000006",
				);
			await expect(
				attempt(
					messages,
					"legacy-late-duplicate",
					"00000000-0000-4000-8000-000000000007",
				),
			).rejects.toBeInstanceOf(InputRoundRejectedError);
			const next: UIMessage = {
				id: "distinct-new-turn",
				role: "user",
				parts: [{ type: "text", text: "Add a follow-up visit" }],
			};
			await attempt(
				[...messages, next],
				"fresh-turn",
				"00000000-0000-4000-8000-000000000008",
			);
			const fresh = await snapshot(target);
			expect(fresh.thread.input_round).toBeNull();
			expect(fresh.thread.messages).toEqual([...messages, next]);
			expect(fresh.consumed).toBe(200);
		});

		it("projects a released pending invitation as closed so a new instruction does not echo a stale round without its holder", async () => {
			const { target, round } = await seed(kind);
			if (target.kind === "app")
				await completeAndSettleRun(target.appId, RUN, NONCE);
			else
				await completeAndSettleDesignSessionRun(
					target.designSessionId,
					RUN,
					NONCE,
				);
			expect((await snapshot(target)).thread.input_round).toEqual(round);
			const loaded = await loadThread(target, THREAD, ACTOR);
			expect(loaded?.run_paused).not.toBe(true);
			expect(loaded?.holder_nonce).toBeUndefined();
			expect(loaded?.input_round).toBeNull();
		});

		it("refuses incomplete answers and mismatched question identity before touching the holder", async () => {
			const { target, round } = await seed(kind);
			const before = await snapshot(target);
			for (const message of [
				{
					...answered,
					parts: answered.parts.map((part) =>
						part.type === "tool-askQuestions" &&
						part.state === "output-available"
							? { ...part, output: {} }
							: part,
					),
				},
				{ ...answered, id: "unrelated-assistant" },
			]) {
				const check = async (tx: Transaction<AppDatabase>) =>
					checkInputRoundInTransaction(tx, {
						target,
						threadId: THREAD,
						inputRoundId: round.id,
						holderNonce: NONCE,
						actorUserId: ACTOR,
						runId: RUN,
						messages: [user, message],
					});
				await expect(
					target.kind === "app"
						? reacquireLease(
								target.appId,
								RUN,
								NONCE,
								"build",
								ACTOR,
								PROJECT,
								{
									check,
									commit: async () => {
										throw new Error("Must not commit");
									},
								},
							)
						: reacquireDesignSessionLease(
								target.designSessionId,
								RUN,
								NONCE,
								ACTOR,
								PROJECT,
								{
									check,
									commit: async () => {
										throw new Error("Must not commit");
									},
								},
							),
				).rejects.toBeInstanceOf(InputRoundRejectedError);
				expect(await snapshot(target)).toEqual(before);
			}
		});
	});
