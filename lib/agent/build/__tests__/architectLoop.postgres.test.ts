import type { ModelMessage, ToolSet } from "ai";
import { expect, it } from "vitest";
import { z } from "zod";
import {
	type ProviderRequest,
	respondWithParts,
} from "@/lib/agent/__tests__/responsesParts";
import { withResponsesPeer } from "@/lib/agent/__tests__/responsesPeer";
import { productionModelStep } from "@/lib/agent/modelStep";
import { readAppPlan, writeAppPlan } from "@/lib/agent/planning/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	type ArchitectLoopArgs,
	describeModelTools,
	runArchitectLoop,
} from "../architectLoop";

const h = setupAppStateTestDb("architect_loop_");

async function fixture() {
	const actorUserId = "architect";
	const projectId = "architect-project";
	const runId = "architect-run";
	await h.seedProjectMember(actorUserId, projectId, "owner");
	const claim = await createAndClaimDesignSessionRun({
		projectId,
		actorUserId,
		runId,
		cost: 1,
	});
	const authority = {
		actorUserId,
		projectId,
		runId,
		sessionId: claim.designSessionId,
		holderNonce: claim.holderNonce,
	};
	return {
		authority,
		spec: {
			designSessionId: claim.designSessionId,
			kind: "architect" as const,
			modelId: "gpt-5.6-luna",
			promptVersion: "test-v1",
			contextVersion: "v1",
			toolsetDigest: "0".repeat(64),
			authority: {
				actorUserId,
				expectedProjectId: projectId,
				runId,
				holderNonce: claim.holderNonce,
			},
		},
	};
}

it("recovers an acknowledged provider response and an unacknowledged plan edit without repurchasing or rewriting either", async () => {
	const { authority, spec } = await fixture();
	const requests: ProviderRequest[] = [];
	const failures: unknown[] = [];
	const usage = new Set<string>();
	let interrupts = true;
	let building = false;
	const inputSchema = z.object({ markdown: z.string() }).strict();
	const tools = (): ToolSet => ({
		writePlan: { inputSchema, strict: false },
		...(building
			? {
					getForm: {
						inputSchema: z.object({ formId: z.string() }),
						strict: false,
					},
				}
			: {}),
	});
	await withResponsesPeer(
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				try {
					requests.push(JSON.parse(Buffer.concat(chunks).toString()));
					if (requests.length > 2) throw new Error("Unexpected paid step");
					respondWithParts(
						response,
						requests.length === 1
							? [
									{
										type: "tool",
										name: "writePlan",
										callId: "plan-call",
										input: {
											markdown:
												"Record each loan separately. Return closes the selected loan.",
										},
									},
								]
							: [{ type: "text", text: "The lending plan is ready." }],
						requests.length,
					);
				} catch (error) {
					failures.push(error);
					response.writeHead(400).end();
				}
			});
		},
		async (provider) => {
			const args: ArchitectLoopArgs = {
				spec,
				system: "Help design a lending app.",
				turnId: "request-1",
				maxSteps: 4,
				signal: new AbortController().signal,
				tools,
				modelStep: productionModelStep(
					provider(spec.modelId),
					"xhigh",
					"loop-test",
				),
				additions: [
					{
						key: "request-1",
						message: { role: "user", content: "Make a tool library app." },
					},
				],
				dispatch: async (call) => {
					const input = inputSchema.parse(call.input);
					const plan = await writeAppPlan({
						authority,
						writer: { editor: "architect" },
						requestId: call.toolCallId,
						expectedRevision: 0,
						change: input,
					});
					building = true;
					if (interrupts) {
						interrupts = false;
						throw new Error("Lost process after plan commit");
					}
					return { kind: "result", output: { revision: plan.revision } };
				},
				onStep: async (_step, identity) => {
					usage.add(`${identity.contextId}:${identity.stepKey}`);
				},
				onRecoveredUsage: (_usage, identity) => {
					usage.add(`${identity.contextId}:${identity.stepKey}`);
				},
				onFinish: async () => ({ kind: "complete" }),
			};
			await expect(runArchitectLoop(args)).rejects.toThrow(
				"Lost process after plan commit",
			);
			expect((await readAppPlan(authority))?.revision).toBe(1);
			const recovered = await runArchitectLoop({
				...args,
				spec: {
					...spec,
					promptVersion: "test-v2",
					toolsetDigest: canonicalJsonDigest(await describeModelTools(tools())),
				},
			});
			expect(recovered.kind).toBe("complete");
			expect(usage.size).toBe(2);
			expect(requests).toHaveLength(2);
			expect(requests[1]?.tools?.map((tool) => tool.name)).toContain("getForm");
			const history = requests[1]?.input ?? [];
			expect(
				history.filter((part) => part.type === "function_call_output"),
			).toMatchObject([{ call_id: "plan-call", output: '{"revision":1}' }]);
			expect((await readAppPlan(authority))?.revision).toBe(1);
			expect(
				await h.db().selectFrom("design_model_contexts").select("id").execute(),
			).toHaveLength(2);
			expect(
				await h
					.db()
					.selectFrom("authoring_plan_revisions")
					.select("revision")
					.execute(),
			).toHaveLength(1);
			expect(
				await h
					.db()
					.selectFrom("design_model_steps")
					.select("step_key")
					.where("event_kind", "=", "completed")
					.execute(),
			).toHaveLength(2);
		},
	);
	expect(failures).toEqual([]);
});

it("pairs a paused question with its answer before adding a later user message", async () => {
	const { spec } = await fixture();
	const captured: ModelMessage[][] = [];
	let answered = false;
	let calls = 0;
	const args: ArchitectLoopArgs = {
		spec,
		system: "Plan the app.",
		turnId: "first",
		maxSteps: 3,
		signal: new AbortController().signal,
		tools: () => ({}),
		additions: [
			{
				key: "first",
				message: { role: "user", content: "Build an app for field visits." },
			},
		],
		modelStep: async (request) => {
			captured.push([...request.messages]);
			calls++;
			const responseMessages: ModelMessage[] =
				calls === 1
					? [
							{
								role: "assistant",
								content: [
									{
										type: "tool-call",
										toolCallId: "question",
										toolName: "askQuestions",
										input: {},
									},
								],
							},
						]
					: [
							{
								role: "assistant",
								content: "The plan accounts for offline work.",
							},
						];
			return {
				text: calls === 1 ? "" : "The plan accounts for offline work.",
				toolCalls: [],
				responseMessages,
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					totalTokens: 15,
					inputTokenDetails: {
						noCacheTokens: 10,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
					outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
				},
			};
		},
		dispatch: async () =>
			answered
				? { kind: "result", output: { offline: true } }
				: { kind: "awaiting-input" },
		onStep: async () => {},
		onRecoveredUsage: () => {},
		onFinish: async () => ({ kind: "complete" }),
	};
	expect((await runArchitectLoop(args)).kind).toBe("awaiting-input");
	answered = true;
	expect(
		(
			await runArchitectLoop({
				...args,
				additions: [
					...args.additions,
					{
						key: "later",
						message: {
							role: "user",
							content: "Also include a follow-up visit.",
						},
					},
				],
			})
		).kind,
	).toBe("complete");
	expect(captured[1]?.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"tool",
		"user",
	]);
	expect(calls).toBe(2);
});

it("keeps a new user request through two context changes when the intervening process dies before a response", async () => {
	const { spec } = await fixture();
	const requests: ProviderRequest[] = [];
	const failures: unknown[] = [];
	await withResponsesPeer(
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				try {
					requests.push(JSON.parse(Buffer.concat(chunks).toString()));
					respondWithParts(
						response,
						[{ type: "text", text: "The plan is ready." }],
						requests.length,
					);
				} catch (error) {
					failures.push(error);
					response.writeHead(400).end();
				}
			});
		},
		async (provider) => {
			const original = {
				key: "request:first",
				message: {
					role: "user" as const,
					content: "Plan a community garden app.",
				},
			};
			const refinement = {
				key: "request:refinement",
				message: {
					role: "user" as const,
					content: "Also track who holds each plot and when their lease ends.",
				},
			};
			const args: ArchitectLoopArgs = {
				spec,
				system: "Help plan the app.",
				turnId: "first",
				maxSteps: 4,
				signal: new AbortController().signal,
				additions: [original],
				tools: () => ({}),
				modelStep: productionModelStep(
					provider(spec.modelId),
					"medium",
					"rollover-test",
				),
				dispatch: async () => {
					throw new Error("No tool call expected");
				},
				onStep: async () => {},
				onRecoveredUsage: () => {},
				onFinish: async () => ({ kind: "complete" }),
			};
			await runArchitectLoop(args);
			const next = {
				...args,
				turnId: "refinement",
				additions: [original, refinement],
			};
			await expect(
				runArchitectLoop({
					...next,
					spec: { ...spec, promptVersion: "v2" },
					modelStep: async () => {
						throw new Error("Lost process before provider dispatch");
					},
				}),
			).rejects.toThrow("Lost process before provider dispatch");
			await runArchitectLoop({
				...next,
				spec: { ...spec, promptVersion: "v3" },
			});
			expect(requests).toHaveLength(2);
			const input = requests[1]?.input ?? [];
			const text = JSON.stringify(input);
			expect(text.split(original.message.content)).toHaveLength(2);
			expect(text.split(refinement.message.content)).toHaveLength(2);
		},
	);
	expect(failures).toEqual([]);
});

it.each([false, true])(
	"settles a provider response once when empty=%s, including hosted tool search",
	async (empty) => {
		const { spec } = await fixture();
		let requests = 0;
		let dispatches = 0;
		await withResponsesPeer(
			(request, response) => {
				request.resume();
				request.on("end", () => {
					requests++;
					respondWithParts(
						response,
						empty
							? []
							: [
									{ type: "search", query: "field wording" },
									{ type: "text", text: "The app is ready." },
								],
						requests,
					);
				});
			},
			async (provider) => {
				const args: ArchitectLoopArgs = {
					spec,
					system: "Build the app.",
					turnId: "finish",
					maxSteps: 1,
					signal: new AbortController().signal,
					tools: () => ({
						toolSearch: provider.tools.toolSearch({ execution: "server" }),
					}),
					modelStep: productionModelStep(
						provider(spec.modelId),
						"medium",
						"finish-test",
					),
					additions: [
						{
							key: "request",
							message: { role: "user", content: "Finish the app." },
						},
					],
					dispatch: async () => {
						dispatches++;
						return { kind: "result", output: {} };
					},
					onStep: async () => {},
					onRecoveredUsage: () => {},
					onFinish: async () => ({ kind: "complete" }),
				};
				if (empty) {
					await expect(runArchitectLoop(args)).rejects.toThrow(
						"no response content",
					);
				} else {
					expect(await runArchitectLoop(args)).toMatchObject({
						kind: "complete",
						text: "The app is ready.",
					});
					expect(await runArchitectLoop(args)).toMatchObject({
						kind: "complete",
						text: "The app is ready.",
					});
				}
				expect(requests).toBe(1);
				expect(dispatches).toBe(0);
				const completed = await h
					.db()
					.selectFrom("design_model_steps")
					.selectAll()
					.where("event_kind", "=", "completed")
					.execute();
				expect(completed).toHaveLength(1);
				expect(completed[0]?.usage).toMatchObject({
					inputTokens: 10,
					outputTokens: 5,
				});
			},
		);
	},
);
