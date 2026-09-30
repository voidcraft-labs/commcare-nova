import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamText, toUIMessageStream, type UIMessageChunk } from "ai";
import { expect, it } from "vitest";
import { z } from "zod";
import { respondWithParts } from "@/lib/agent/__tests__/responsesParts";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import { projectArchitectHistory } from "@/lib/agent/architectHistory";
import { productionModelStep } from "@/lib/agent/modelStep";
import { createNovaOpenAI } from "@/lib/agent/openaiProvider";
import { MODEL_ROLES, reasoningProviderOptions } from "@/lib/models";
import { standardPilotTransport } from "../authoringPilotLedger";
import {
	loadTrialConfig,
	parseTrialConfig,
	type TrialRole,
	verifyTrialResume,
	verifyTrialWire,
} from "../authoringTrialConfig";
import {
	answerTrialQuestion,
	foldTrialChunks,
	trialConversationWithResponse,
} from "../authoringTrialTranscript";

it("checks all semantic role requests after real SDK serialization", async () => {
	const config = await loadTrialConfig(undefined, "architect");
	let received = 0;
	await withResponsesPeer(
		(_request, response) => {
			received += 1;
			respondWithObject(response, "Recorded.");
		},
		async (_provider, transport) => {
			for (const name of Object.keys(MODEL_ROLES) as TrialRole[]) {
				const provider = createNovaOpenAI(
					"local-only",
					standardPilotTransport(async (input, init) => {
						const body = new Request(input, init);
						const text = await body.text();
						verifyTrialWire(text, config, name);
						const request = JSON.parse(text);
						expect(() =>
							verifyTrialWire(
								JSON.stringify({ ...request, store: true }),
								config,
								name,
							),
						).toThrow();
						expect(() =>
							verifyTrialWire(
								JSON.stringify({
									...request,
									reasoning: { effort: "minimal" },
								}),
								config,
								name,
							),
						).toThrow(/role/);
						return transport(input, init);
					}),
				);
				const model = MODEL_ROLES[name];
				const step = productionModelStep(
					provider(model.modelId),
					model.reasoningEffort,
					`trial:${name}`,
				);
				const result = await step({
					system: "A local transport check.",
					messages: [{ role: "user", content: "Record this." }],
					tools: {},
					signal: new AbortController().signal,
					maxOutputTokens: 128_000,
				});
				expect(result.text).toBe("Recorded.");
			}
		},
	);
	expect(received).toBe(5);
});

it("refuses changed roles, unbounded runtime, or changed resume provenance", async () => {
	const config = await loadTrialConfig(undefined, "architect");
	expect(() => parseTrialConfig({ ...config, timeoutMinutes: 91 })).toThrow();
	expect(() =>
		parseTrialConfig({
			...config,
			expectedModels: {
				...config.expectedModels,
				peer: { modelId: "another-model", reasoningEffort: "medium" },
			},
		}),
	).toThrow(/installed peer/);
	const directory = await mkdtemp(join(tmpdir(), "nova-trial-config-"));
	const current = {
		config,
		code: {
			head: "frozen",
			trackedPatchSha256: "model-patch",
			patch: "captured",
		},
		ledger: "/original-ledger",
	};
	try {
		await writeFile(
			join(directory, "trial-config.json"),
			JSON.stringify(current),
		);
		await expect(
			verifyTrialResume(directory, current),
		).resolves.toBeUndefined();
		await expect(
			verifyTrialResume(directory, { ...current, ledger: "/new-ledger" }),
		).rejects.toThrow(/original code/);
		await expect(
			verifyTrialResume(directory, {
				...current,
				code: { ...current.code, head: "changed" },
			}),
		).rejects.toThrow(/original code/);
		await expect(
			verifyTrialResume(directory, {
				...current,
				config: {
					...config,
					reviewPolicy: {
						kind: "diagnostic",
						maxPeerRequests: 320,
						maxArchitectRequests: 400,
					},
				},
			}),
		).rejects.toThrow(/original code/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("retains the SDK question identity when folding and answering a completed trial transcript", async () => {
	const chunks: UIMessageChunk[] = [];
	await withResponsesPeer(
		(_request, response) => {
			respondWithParts(
				response,
				[
					{
						type: "tool",
						name: "askQuestions",
						callId: "ordinary-question",
						input: { question: "Keep prior records?" },
					},
				],
				1,
			);
		},
		async (provider) => {
			const result = streamText({
				model: provider(MODEL_ROLES.followUpEditor.modelId),
				messages: [{ role: "user", content: "Help with the app." }],
				tools: {
					askQuestions: { inputSchema: z.object({ question: z.string() }) },
				},
				providerOptions: reasoningProviderOptions("xhigh"),
				maxRetries: 0,
			});
			const reader = toUIMessageStream({
				stream: result.stream,
				generateMessageId: () => "server-response",
			}).getReader();
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					chunks.push(next.value);
				}
			} finally {
				reader.releaseLock();
			}
		},
	);
	const response = await foldTrialChunks(chunks);
	expect(response?.id).toBe("server-response");
	if (!response) throw new Error("Missing SDK response.");
	const answered = answerTrialQuestion([response], "ordinary-question", {
		"0": "Keep them.",
	});
	expect(answered[0]).toMatchObject({
		id: "server-response",
		parts: expect.arrayContaining([
			expect.objectContaining({
				type: "tool-askQuestions",
				toolCallId: "ordinary-question",
				state: "output-available",
				input: { question: "Keep prior records?" },
				output: { "0": "Keep them." },
			}),
		]),
	});
	expect(() => answerTrialQuestion([response], "other-question", {})).toThrow(
		/no matching question/,
	);
	const history = await projectArchitectHistory({
		messages: answered,
		model: MODEL_ROLES.followUpEditor.modelId,
		tools: {
			askQuestions: { inputSchema: z.object({ question: z.string() }) },
		},
	});
	expect(history.modelMessages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				role: "tool",
				content: expect.arrayContaining([
					expect.objectContaining({
						toolCallId: "ordinary-question",
						output: { type: "json", value: { "0": "Keep them." } },
					}),
				]),
			}),
		]),
	);
	const continued = await foldTrialChunks(
		[
			{ type: "start", messageId: "server-response" },
			{ type: "text-start", id: "reply" },
			{
				type: "text-delta",
				id: "reply",
				delta: "Prior records remain available.",
			},
			{ type: "text-end", id: "reply" },
			{ type: "finish" },
		],
		answered[0],
	);
	const conversation = trialConversationWithResponse(answered, continued);
	expect(conversation).toHaveLength(1);
	expect(conversation[0].parts).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				toolCallId: "ordinary-question",
				state: "output-available",
			}),
			expect.objectContaining({
				type: "text",
				text: "Prior records remain available.",
			}),
		]),
	);
});
