import { describe, expect, it } from "vitest";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import {
	authoritativeThreadActivationOptions,
	chatCallbackCanPublish,
	chatGenerationCanWrite,
	expectedProjectIdForChatRequest,
	mergeRetainedUserTextSuffix,
	parseCreatedAppActivation,
	retireProjectAttachmentRefs,
} from "./ChatContainer";

describe("authoritative thread activation", () => {
	it("passes through the actor-bound holder nonce and clears it when omitted", () => {
		expect(
			authoritativeThreadActivationOptions(
				{
					run_id: "run-paused",
					holder_nonce: "00000000-0000-4000-8000-000000000001",
					active_stream_id: "stream-live",
				},
				true,
			),
		).toEqual({
			runId: "run-paused",
			holderNonce: "00000000-0000-4000-8000-000000000001",
			resume: true,
			redrive: false,
			buildResume: true,
		});
		expect(
			authoritativeThreadActivationOptions(
				{
					run_id: "run-terminal",
					active_stream_id: null,
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
				},
				true,
				{ allowRedrive: false },
			),
		).toMatchObject({ redrive: false, buildResume: false });
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
		const receipt = {
			appId: "app-1",
			projectId: "project-1",
			role: "editor",
			canEdit: true,
			baseSeq: 0,
		};

		expect(parseCreatedAppActivation(receipt)).toEqual(receipt);
		expect(
			parseCreatedAppActivation({ ...receipt, role: undefined }),
		).toBeNull();
		expect(parseCreatedAppActivation({ ...receipt, baseSeq: -1 })).toBeNull();
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
			canEdit: true,
			scopeEpoch: 2,
		};

		expect(chatGenerationCanWrite(destination, 2, "pending")).toBe(false);
		expect(chatGenerationCanWrite(destination, 1, "ready")).toBe(false);
		expect(chatGenerationCanWrite(undefined, 2, "ready")).toBe(false);
		expect(chatGenerationCanWrite(destination, 2, "ready")).toBe(true);
	});

	it("keeps a failed same-thread hydration unable to overwrite its stored transcript", () => {
		const destination = {
			accessPhase: "authorized",
			canEdit: true,
			scopeEpoch: 2,
		};

		expect(chatGenerationCanWrite(destination, 2, "failed")).toBe(false);
	});
});
