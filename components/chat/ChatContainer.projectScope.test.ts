import { describe, expect, it } from "vitest";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { canonicalAppGenesis } from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	adoptTranscriptKeepingRicherLocal,
	authoritativeThreadActivationOptions,
	chatCallbackCanPublish,
	chatGenerationCanWrite,
	chatRequestIsRedrive,
	designBuildCanResume,
	designProgressLocksInitialBuild,
	designProgressOwnsActivityStatus,
	designProgressTracksBuildFailure,
	designSessionScopeTracksProgress,
	expectedProjectIdForChatRequest,
	mergeRetainedUserTextSuffix,
	parseAppMaterializationReceipt,
	rememberDesignBuildResumeEligibility,
	retireProjectAttachmentRefs,
	threadActivationNeedsIncompleteSeed,
	threadResumeHealPath,
	threadResumeHealTarget,
	trailingDesignWaitsForInput,
} from "./ChatContainer";

describe("design wait terminal", () => {
	it("recognizes only a successful wait in the trailing assistant step", () => {
		expect(
			trailingDesignWaitsForInput([
				{
					role: "assistant",
					parts: [
						{ type: "step-start" },
						{
							type: "tool-waitForInput",
							state: "output-available",
							output: { ok: true, awaitingInput: true },
						},
					],
				},
			]),
		).toBe(true);
		expect(
			trailingDesignWaitsForInput([
				{
					role: "assistant",
					parts: [
						{ type: "step-start" },
						{
							type: "tool-waitForInput",
							state: "input-available",
						},
					],
				},
			]),
		).toBe(false);
	});
});

describe("interrupted-turn request routing", () => {
	it("preserves automatic regenerate redrive semantics", () => {
		expect(chatRequestIsRedrive("regenerate-message", undefined)).toBe(true);
		expect(chatRequestIsRedrive("submit-message", { redrive: true })).toBe(
			true,
		);
		expect(chatRequestIsRedrive("submit-message", undefined)).toBe(false);
	});

	it("offers only a stopped recoverable build an exact-plan resume", () => {
		expect(
			designBuildCanResume(
				{
					failure: { message: "Temporary failure", recoverable: true },
					seededStage: null,
				},
				true,
				"ready",
			),
		).toBe(true);
		expect(
			designBuildCanResume(
				{
					failure: { message: "Build defect", recoverable: false },
					seededStage: null,
				},
				true,
				"ready",
			),
		).toBe(false);
		expect(
			designBuildCanResume(
				{
					failure: { message: "Temporary failure", recoverable: true },
					seededStage: null,
				},
				true,
				"streaming",
			),
		).toBe(false);
		expect(
			designBuildCanResume(
				{ failure: null, seededStage: "incomplete" },
				true,
				"ready",
			),
		).toBe(true);
	});

	it("retains recoverable resume eligibility across a thread reset and revokes it on terminal evidence", () => {
		const resumable = new Set<string>();
		rememberDesignBuildResumeEligibility(resumable, {
			designSessionId: "design-1",
			failure: { message: "Infrastructure stopped", recoverable: true },
			seededStage: null,
			completion: null,
		});
		expect([...resumable]).toEqual(["design-1"]);
		expect(
			threadActivationNeedsIncompleteSeed({
				designSessionId: "design-1",
				buildUnfinished: true,
				resume: false,
				redrive: false,
				resumableDesignSessionIds: resumable,
			}),
		).toBe(true);
		expect(
			threadActivationNeedsIncompleteSeed({
				designSessionId: "design-1",
				buildUnfinished: true,
				resume: true,
				redrive: false,
				resumableDesignSessionIds: resumable,
			}),
		).toBe(false);

		rememberDesignBuildResumeEligibility(resumable, {
			designSessionId: "design-1",
			failure: null,
			seededStage: null,
			completion: { appId: "app-1", appSeq: 13, plannedSlices: 13 },
		});
		expect(resumable.size).toBe(0);
	});
});

describe("design progress activity ownership", () => {
	it("treats completed design lineage as edit routing, not active progress", () => {
		expect(
			designSessionScopeTracksProgress(
				{ designSessionId: "design", materializedAppId: "app" },
				false,
			),
		).toBe(false);
		expect(
			designSessionScopeTracksProgress(
				{ designSessionId: "design", materializedAppId: "app" },
				true,
			),
		).toBe(true);
		expect(
			designSessionScopeTracksProgress(
				{ designSessionId: "design", materializedAppId: null },
				false,
			),
		).toBe(true);
	});

	it("keeps the design status through post-materialization build work", () => {
		expect(
			designProgressOwnsActivityStatus(
				{ active: true, stage: "building" },
				"streaming",
			),
		).toBe(true);
		expect(
			designProgressOwnsActivityStatus(
				{ active: true, stage: "reviewing-implementation" },
				"streaming",
			),
		).toBe(true);
	});

	it("shows completion until stream close, then returns to a quiet composer", () => {
		expect(
			designProgressOwnsActivityStatus(
				{ active: true, stage: "ready" },
				"streaming",
			),
		).toBe(true);
		expect(
			designProgressOwnsActivityStatus(
				{ active: true, stage: "ready" },
				"ready",
			),
		).toBe(false);
	});

	it("releases stale working status on a transport error", () => {
		expect(
			designProgressOwnsActivityStatus(
				{ active: true, stage: "building" },
				"error",
			),
		).toBe(false);
		expect(
			designProgressOwnsActivityStatus(
				{ active: true, stage: "failed" },
				"error",
			),
		).toBe(true);
	});

	it("tracks failures across unfinished materialized build phases, not edits", () => {
		const preApp = {
			designSessionId: "design",
			materializedAppId: null,
			activeSlice: null,
		};
		const materialized = { ...preApp, materializedAppId: "app" };
		expect(designProgressTracksBuildFailure(preApp, false)).toBe(true);
		expect(designProgressTracksBuildFailure(materialized, true)).toBe(true);
		expect(designProgressTracksBuildFailure(materialized, false)).toBe(false);
	});

	it("locks only an actually unfinished initial build", () => {
		const historicalDesignThread = {
			active: true,
			stage: "understanding",
		} as const;
		expect(designProgressLocksInitialBuild(historicalDesignThread, true)).toBe(
			true,
		);
		expect(designProgressLocksInitialBuild(historicalDesignThread, false)).toBe(
			false,
		);
		expect(
			designProgressLocksInitialBuild(
				{ active: false, stage: "understanding" },
				true,
			),
		).toBe(true);
		expect(
			designProgressLocksInitialBuild({ active: true, stage: "ready" }, true),
		).toBe(true);
	});
});

describe("authoritative thread activation", () => {
	it("passes through the actor-bound holder nonce and clears it when omitted", () => {
		expect(
			authoritativeThreadActivationOptions(
				{
					run_id: "run-paused",
					holder_nonce: "00000000-0000-4000-8000-000000000001",
					active_stream_id: "stream-live",
					messages: [],
				},
				true,
			),
		).toEqual({
			runId: "run-paused",
			holderNonce: "00000000-0000-4000-8000-000000000001",
			resume: true,
			redrive: false,
			buildResume: true,
			buildUnfinished: true,
			designSessionId: null,
		});
		expect(
			authoritativeThreadActivationOptions(
				{
					run_id: "run-terminal",
					active_stream_id: null,
					messages: [],
				},
				false,
			),
		).toMatchObject({ holderNonce: undefined, resume: false, redrive: false });
		expect(
			authoritativeThreadActivationOptions(
				{
					run_id: "run-already-redriven",
					active_stream_id: null,
					resume_interrupted: true,
					messages: [],
				},
				true,
				{ allowRedrive: false },
			),
		).toMatchObject({ redrive: false, buildResume: false });
	});

	it("re-drives an interrupted turn whose transcript ends on a PARTIAL assistant message", () => {
		/* Barrier persistence: a dead run leaves closed-state parts behind, so
		 * the trigger is the server's interruption stamp, never trailing role. */
		expect(
			authoritativeThreadActivationOptions(
				{
					run_id: "run-dead",
					active_stream_id: null,
					resume_interrupted: true,
					messages: [
						{
							id: "m1",
							role: "user" as const,
							parts: [{ type: "text", text: "go" }],
						},
						{
							id: "m2",
							role: "assistant" as const,
							parts: [{ type: "text", text: "half an answer" }],
						},
					],
				},
				true,
			),
		).toMatchObject({ redrive: true, buildResume: true });
	});

	it("never re-drives an ANSWERED trailing ask round (the answers live in that message)", () => {
		expect(
			authoritativeThreadActivationOptions(
				{
					run_id: "run-dead",
					active_stream_id: null,
					resume_interrupted: true,
					messages: [
						{
							id: "m1",
							role: "user" as const,
							parts: [{ type: "text", text: "go" }],
						},
						{
							id: "m2",
							role: "assistant" as const,
							parts: [
								{ type: "step-start" },
								{
									type: "tool-askQuestions",
									state: "output-available",
									toolCallId: "c1",
								},
							],
						},
					],
				},
				true,
			),
		).toMatchObject({ redrive: false });
	});

	it("never re-drives an answered round buried under a later completed step (a died continuation)", () => {
		/* The continuation appended a completed step to the SAME message after
		 * the answered round, then died. The ask parts are no longer in the
		 * message's LAST step, but the user's answers still live in the
		 * message a re-drive would trim, so the WHOLE message is scanned. */
		expect(
			authoritativeThreadActivationOptions(
				{
					run_id: "run-dead",
					active_stream_id: null,
					resume_interrupted: true,
					messages: [
						{
							id: "m1",
							role: "user" as const,
							parts: [{ type: "text", text: "go" }],
						},
						{
							id: "m2",
							role: "assistant" as const,
							parts: [
								{ type: "step-start" },
								{
									type: "tool-askQuestions",
									state: "output-available",
									toolCallId: "c1",
								},
								{ type: "step-start" },
								{ type: "text", text: "a completed post-answer step" },
							],
						},
					],
				},
				true,
			),
		).toMatchObject({ redrive: false });
	});

	it("blocks an unanswered ask round only while the run is GENUINELY paused", () => {
		const askRound = {
			run_id: "run-ask",
			active_stream_id: null,
			resume_interrupted: true,
			messages: [
				{
					id: "m1",
					role: "user" as const,
					parts: [{ type: "text", text: "go" }],
				},
				{
					id: "m2",
					role: "assistant" as const,
					parts: [
						{ type: "step-start" },
						{
							type: "tool-askQuestions",
							state: "input-available",
							toolCallId: "c1",
						},
					],
				},
			],
		};
		/* Genuinely paused: the answer POST is the recovery path. */
		expect(
			authoritativeThreadActivationOptions(
				{ ...askRound, run_paused: true },
				true,
			),
		).toMatchObject({ redrive: false });
		/* Died before it could pause: the card shows but nothing can answer
		 * it, so re-driving (and re-asking) is correct recovery. */
		expect(authoritativeThreadActivationOptions(askRound, true)).toMatchObject({
			redrive: true,
		});
	});
});

describe("new-app Project handoff", () => {
	it("keeps the Project seeded by /build/new instead of a later active-Project cookie", () => {
		const buildNewSession = {
			appId: undefined,
			projectId: "project-seeded-before-cross-tab-switch",
		};

		expect(expectedProjectIdForChatRequest(buildNewSession)).toBe(
			"project-seeded-before-cross-tab-switch",
		);
		expect(
			expectedProjectIdForChatRequest({
				appId: "existing-app",
				projectId: "project-does-not-ride-existing-app-requests",
			}),
		).toBeUndefined();
	});

	it("accepts only a complete authoritative activation receipt", () => {
		const empty: BlueprintDoc = {
			appId: "app-1",
			appName: "",
			connectType: null,
			caseTypes: null,
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
			fieldParent: {},
		};
		const genesis = canonicalAppGenesis(empty);
		const verdict = mutationCommitVerdict(
			empty,
			genesis.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
		const receipt = {
			eventVersion: 1,
			designSessionId: null,
			appId: "app-1",
			projectId: "project-1",
			role: "editor",
			canEdit: true,
			seq: 1,
			batchId: "genesis:app-1",
			changeSetId: null,
			snapshotDigest: "ab".repeat(32),
			blueprint: toPersistableDoc(verdict.nextDoc),
			starter: {
				moduleUuid: genesis.moduleUuid,
				formUuid: genesis.formUuid,
				fieldUuid: genesis.fieldUuid,
			},
		};

		expect(parseAppMaterializationReceipt(receipt)).toEqual(receipt);
		expect(
			parseAppMaterializationReceipt({ ...receipt, role: undefined }),
		).toBeNull();
		expect(parseAppMaterializationReceipt({ ...receipt, seq: 0 })).toBeNull();
		expect(
			parseAppMaterializationReceipt({
				...receipt,
				starter: { ...receipt.starter, fieldUuid: genesis.formUuid },
			}),
		).toBeNull();
		expect(
			parseAppMaterializationReceipt({ ...receipt, unexpected: true }),
		).toBeNull();
		/* A design-slice receipt has no starter and an arbitrary meaningful
		 * blueprint; only identity + digest shape are asserted structurally. */
		expect(
			parseAppMaterializationReceipt({
				...receipt,
				designSessionId: "0b944e00-722d-48ab-8d4d-47e922970b5f",
				changeSetId: "cs-1",
				starter: null,
			}),
		).toMatchObject({ starter: null });
		expect(
			parseAppMaterializationReceipt({
				...receipt,
				snapshotDigest: "not-a-digest",
			}),
		).toBeNull();
	});
});

describe("post-resume transcript healing", () => {
	it("uses the design-session authority before an app exists", () => {
		const target = threadResumeHealTarget(undefined, "design-1");
		expect(target).toEqual({ kind: "design-session", id: "design-1" });
		if (target === null) throw new Error("Expected a design-session target.");
		expect(threadResumeHealPath(target, "thread/1")).toBe(
			"/api/design-sessions/design-1/threads/thread%2F1",
		);
	});

	it("switches to the app authority after materialization", () => {
		const target = threadResumeHealTarget("app-1", "design-1");
		expect(target).toEqual({ kind: "app", id: "app-1" });
		if (target === null) throw new Error("Expected an app target.");
		expect(threadResumeHealPath(target, "thread-1")).toBe(
			"/api/apps/app-1/threads/thread-1",
		);
	});
});

describe("adoptTranscriptKeepingRicherLocal", () => {
	it("keeps the richer LOCAL assistant copy, drops local-only messages, and leaves user messages stored", () => {
		const stored = [
			{
				id: "u1",
				role: "user" as const,
				parts: [{ type: "text" as const, text: "go" }],
			},
			{
				id: "a1",
				role: "assistant" as const,
				parts: [{ type: "text" as const, text: "partial" }],
			},
		] as NovaUIMessage[];
		const local = [
			{
				id: "u1",
				role: "user" as const,
				parts: [
					{ type: "text" as const, text: "go" },
					{ type: "text" as const, text: "phantom extra" },
				],
			},
			{
				id: "a1",
				role: "assistant" as const,
				parts: [
					{ type: "text" as const, text: "partial" },
					{ type: "text" as const, text: " plus the delivered tail" },
				],
			},
			{
				id: "a-clawed",
				role: "assistant" as const,
				parts: [{ type: "text" as const, text: "a clawed-back partial" }],
			},
		] as NovaUIMessage[];

		const adopted = adoptTranscriptKeepingRicherLocal(stored, local);
		expect(adopted.map((m) => m.id)).toEqual(["u1", "a1"]);
		// Stored stays authoritative for user messages…
		expect(adopted[0]?.parts).toHaveLength(1);
		// …while a delivered answer the stored row lags is not truncated.
		expect(adopted[1]?.parts.map((p) => (p as { text: string }).text)).toEqual([
			"partial",
			" plus the delivered tail",
		]);
	});
});

describe("retireProjectAttachmentRefs", () => {
	it("preserves app-owned text/model metadata but removes all Project asset details", () => {
		const messages = [
			{
				id: "user-1",
				role: "user",
				parts: [{ type: "text", text: "Use the attached protocol" }],
				metadata: {
					attachments: [
						{
							assetId: "source-asset",
							kind: "pdf",
							filename: "source-client.pdf",
							mimeType: "application/pdf",
							title: "Source title",
							summary: "Source summary",
						},
					],
				},
			},
			{
				id: "assistant-1",
				role: "assistant",
				parts: [{ type: "text", text: "I can help." }],
				metadata: { model: "model-1" },
			},
		] as NovaUIMessage[];

		const retired = retireProjectAttachmentRefs(messages);

		expect(retired[0]).toMatchObject({
			parts: [{ type: "text", text: "Use the attached protocol" }],
		});
		expect(retired[0].metadata).toBeUndefined();
		expect(retired[1].metadata).toEqual({ model: "model-1" });
		expect(JSON.stringify(retired)).not.toContain("source-asset");
		expect(JSON.stringify(retired)).not.toContain("source-client.pdf");
	});
});

describe("mergeRetainedUserTextSuffix", () => {
	it("keeps only an absent trailing user turn and reconstructs it without Project metadata", () => {
		const shared = {
			id: "shared-user",
			role: "user",
			parts: [{ type: "text", text: "Existing turn" }],
		} as NovaUIMessage;
		const authoritative = [
			shared,
			{
				id: "destination-assistant",
				role: "assistant",
				parts: [{ type: "text", text: "Stored answer" }],
			},
		] as NovaUIMessage[];
		const retainedLocal = [
			{
				id: "older-unshared-user",
				role: "user",
				parts: [{ type: "text", text: "Do not resurrect old history" }],
			},
			shared,
			{
				id: "optimistic-user",
				role: "user",
				parts: [{ type: "text", text: "Keep this unsaved request" }],
				metadata: {
					attachments: [
						{
							assetId: "source-asset",
							kind: "pdf",
							filename: "source-only.pdf",
							mimeType: "application/pdf",
						},
					],
				},
			},
		] as NovaUIMessage[];

		const merged = mergeRetainedUserTextSuffix(authoritative, retainedLocal);

		expect(merged.map((message) => message.id)).toEqual([
			"shared-user",
			"destination-assistant",
			"optimistic-user",
		]);
		expect(merged.at(-1)).toEqual({
			id: "optimistic-user",
			role: "user",
			parts: [{ type: "text", text: "Keep this unsaved request" }],
		});
		expect(JSON.stringify(merged)).not.toContain("source-asset");
		expect(JSON.stringify(merged)).not.toContain("source-only.pdf");
		expect(JSON.stringify(merged)).not.toContain(
			"Do not resurrect old history",
		);
	});

	it("does not duplicate a trailing turn already present in the authoritative thread", () => {
		const turn = {
			id: "persisted-user",
			role: "user",
			parts: [{ type: "text", text: "Already saved" }],
		} as NovaUIMessage;

		expect(mergeRetainedUserTextSuffix([turn], [turn])).toEqual([turn]);
	});
});

describe("chatCallbackCanPublish", () => {
	it("rejects stale and not-yet-authoritative Chat continuations", () => {
		const destination = { accessPhase: "authorized", scopeEpoch: 4 };

		expect(chatCallbackCanPublish(destination, 3, "ready")).toBe(false);
		expect(chatCallbackCanPublish(destination, 4, "pending")).toBe(false);
		expect(chatCallbackCanPublish(destination, 4, "failed")).toBe(false);
		expect(chatCallbackCanPublish(destination, 4, "ready")).toBe(true);
	});
});

describe("chatGenerationCanWrite", () => {
	it("fails closed for a held destination hydration, old epoch, or missing session", () => {
		const destination = {
			accessPhase: "authorized",
			projectCanEdit: true,
			scopeEpoch: 2,
		};

		expect(chatGenerationCanWrite(destination, 2, "pending")).toBe(false);
		expect(chatGenerationCanWrite(destination, 1, "ready")).toBe(false);
		expect(chatGenerationCanWrite(undefined, 2, "ready")).toBe(false);
		expect(chatGenerationCanWrite(destination, 2, "ready")).toBe(true);
	});

	it("uses Project authority while the initial-build lock keeps direct editors read-only", () => {
		const initialBuild = {
			accessPhase: "authorized",
			projectCanEdit: true,
			canEdit: false,
			scopeEpoch: 2,
		};

		expect(chatGenerationCanWrite(initialBuild, 2, "ready")).toBe(true);
		expect(
			chatGenerationCanWrite(
				{ ...initialBuild, projectCanEdit: false },
				2,
				"ready",
			),
		).toBe(false);
	});

	it("keeps a failed same-thread hydration unable to overwrite its stored transcript", () => {
		const destination = {
			accessPhase: "authorized",
			projectCanEdit: true,
			scopeEpoch: 2,
		};

		expect(chatGenerationCanWrite(destination, 2, "failed")).toBe(false);
	});
});
