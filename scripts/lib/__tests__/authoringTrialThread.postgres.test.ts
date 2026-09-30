import { type UIMessage, validateUIMessages } from "ai";
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	createAndClaimDesignSessionRun,
	reacquireDesignSessionLease,
	setDesignSessionAwaitingInput,
} from "@/lib/db/designSessions";
import { loadThread, upsertThreadTurn } from "@/lib/db/threads";
import { persistArchitectTrialResponse } from "../authoringTrialThread";
import { answerTrialQuestion } from "../authoringTrialTranscript";

const h = setupAppStateTestDb("trial_thread_", { authSchema: "migrated" });
it("loads a paused evaluator thread with its holder and admits an ordinary question answer", async () => {
	const actor = "trial-author";
	const project = "trial-project";
	const runId = "trial-run";
	await h.seedProjectMember(actor, project, "owner");
	const claim = await createAndClaimDesignSessionRun({
		projectId: project,
		actorUserId: actor,
		runId,
		cost: 1,
	});
	const target = {
		kind: "design-session" as const,
		designSessionId: claim.designSessionId,
	};
	const user: UIMessage = {
		id: "request",
		role: "user",
		parts: [{ type: "text", text: "Build a lending app." }],
	};
	expect(
		await upsertThreadTurn({
			target,
			threadId: "trial-thread",
			runId,
			streamId: "first-stream",
			holderNonce: claim.holderNonce,
			threadType: "build",
			messages: [user],
			expectedProjectId: project,
		}),
	).toBe(true);
	const question: UIMessage = {
		id: "question",
		role: "assistant",
		parts: [
			{
				type: "tool-askQuestions",
				toolCallId: "required",
				state: "input-available",
				input: {
					header: "Borrower",
					questions: [
						{
							question: "Require a name?",
							options: [{ label: "Yes" }, { label: "No" }],
						},
					],
				},
			},
		],
	};
	expect(
		await setDesignSessionAwaitingInput(
			claim.designSessionId,
			runId,
			claim.holderNonce,
			true,
			actor,
			project,
		),
	).toBe("owned");
	await persistArchitectTrialResponse({
		target,
		threadId: "trial-thread",
		streamId: "first-stream",
		expectedProjectId: project,
		responseMessage: question,
		paused: true,
	});
	const loaded = await loadThread(target, "trial-thread", actor);
	expect(loaded).toMatchObject({
		active_stream_id: null,
		run_paused: true,
		holder_nonce: claim.holderNonce,
	});
	if (!loaded) throw new Error("Missing persisted trial thread");
	const answered = answerTrialQuestion(
		await validateUIMessages({ messages: loaded.messages }),
		"required",
		{
			"0": "Yes",
		},
	);
	expect(
		await reacquireDesignSessionLease(
			claim.designSessionId,
			runId,
			loaded.holder_nonce ?? null,
			actor,
			project,
		),
	).toMatchObject({ outcome: "owned" });
	expect(
		await upsertThreadTurn({
			target,
			threadId: "trial-thread",
			runId,
			streamId: "answer-stream",
			holderNonce: loaded.holder_nonce ?? "",
			threadType: "build",
			messages: answered,
			expectedProjectId: project,
		}),
	).toBe(true);
	const resumed = await loadThread(target, "trial-thread", actor);
	expect(resumed?.messages.at(-1)?.parts).toContainEqual(
		expect.objectContaining({
			toolCallId: "required",
			state: "output-available",
			output: { "0": "Yes" },
		}),
	);
	expect(resumed?.active_stream_id).toBe("answer-stream");
});
