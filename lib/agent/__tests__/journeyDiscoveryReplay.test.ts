import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { MODEL_ROLES } from "@/lib/models";
import { appOverview } from "../appOverview";
import { architectToolDefinitions } from "../build/authoringTools";
import { productionModelStep } from "../modelStep";
import { createSolutionsArchitect } from "../solutionsArchitect";
import { expectAdmittedDoc, surveyFixture } from "./admittedFixture";
import { makeTestContext } from "./fixtures";
import {
	type ProviderOutput,
	type ProviderRequest,
	respondWithParts,
} from "./responsesParts";
import { withResponsesPeer } from "./responsesPeer";

vi.mock("@/lib/db/apps", () => ({
	refreshBuildLiveness: vi.fn().mockResolvedValue(undefined),
	refreshEditLease: vi.fn().mockResolvedValue(undefined),
}));

/** Scripted provider output proves the real adapter and role composition. It
 * does not reproduce a live provider's discovery failure or model judgment. */
describe("journey availability after compaction", () => {
	it.each(["architect", "peer", "editor"] as const)(
		"keeps %s journey schemas eager and replays empty discovery, loaded schemas and direct calls",
		async (role) => {
			const bodies: ProviderRequest[] = [];
			const failures: unknown[] = [];
			const invocations: unknown[] = [];
			const messages: ModelMessage[] = [
				{ role: "user", content: "History before the opaque checkpoint" },
			];
			const output = { tests: [] };
			let loadedModule: Record<string, unknown> | undefined;
			await withResponsesPeer(
				(request, response) => {
					const buffers: Buffer[] = [];
					request.on("data", (chunk: Buffer) => buffers.push(chunk));
					request.on("end", () => {
						try {
							const body: ProviderRequest = JSON.parse(
								Buffer.concat(buffers).toString(),
							);
							const index = bodies.length;
							bodies.push(body);
							let parts: ProviderOutput[];
							if (index === 0) {
								const module = body.tools?.find(
									(tool) => tool.name === "getModule",
								);
								if (!module) throw new Error("Missing deferred module reader");
								loadedModule = { ...module, output_schema: null };
								parts = [
									{
										type: "compaction",
										id: "checkpoint",
										encryptedContent: "opaque-provider-state",
									},
									{ type: "search", query: "readAppTest" },
									{
										type: "tool",
										name: "readAppTest",
										namespace: "readAppTest",
										callId: "read-in-compacted-response",
										input: {},
									},
								];
							} else if (index === 1 && loadedModule) {
								parts = [
									{
										type: "search",
										query: "getModule",
										loadedTools: [loadedModule],
									},
									{
										type: "tool",
										name: "readAppTest",
										namespace: "readAppTest",
										callId: "read-journey",
										input: {},
									},
								];
							} else if (index === 2) {
								parts = [
									{ type: "text", text: "The retained journey is readable." },
								];
							} else {
								throw new Error(`Unexpected provider request ${index}`);
							}
							respondWithParts(response, parts, index);
						} catch (error) {
							failures.push(error);
							response.writeHead(400).end();
						}
					});
				},
				async (provider, transport) => {
					if (role === "editor") {
						const doc = expectAdmittedDoc(surveyFixture());
						const { ctx } = makeTestContext({ transport });
						try {
							const agent = createSolutionsArchitect(ctx, {
								invoke: async (name, input, requestId) => {
									invocations.push({ name, input, requestId });
									return output;
								},
								snapshot: async () => ({
									mode: "canonical",
									doc,
									revision: 0,
									canonicalSeq: 0,
									projectId: ctx.projectId,
								}),
								status: async () => ({
									workId: "wire-check",
									appId: doc.appId,
									projectId: ctx.projectId,
									revision: null,
									pendingChanges: 0,
									stale: false,
									savedRevision: 0,
									app: appOverview(doc),
									diagnostics: null,
								}),
							});
							const result = await agent.stream({ messages });
							await result.consumeStream();
							expect(await result.text).toBe(
								"The retained journey is readable.",
							);
						} finally {
							await ctx.stopRunLeaseHeartbeat();
						}
					} else {
						const config = MODEL_ROLES[role];
						const step = productionModelStep(
							provider(config.modelId),
							config.reasoningEffort,
							`nova:${role}:wire-check`,
						);
						for (let index = 0; index < 3; index++) {
							const result = await step({
								system: "Inspect the saved journey",
								messages,
								tools: architectToolDefinitions({
									role,
									building: true,
									hasApp: true,
								}),
								signal: new AbortController().signal,
							});
							messages.push(...result.responseMessages);
							for (const call of result.toolCalls) {
								invocations.push({
									name: call.toolName,
									input: call.input,
									requestId: call.toolCallId,
								});
								messages.push({
									role: "tool",
									content: [
										{
											type: "tool-result",
											toolCallId: call.toolCallId,
											toolName: call.toolName,
											output: { type: "json", value: output },
										},
									],
								});
							}
						}
					}
				},
			);
			expect(failures).toEqual([]);
			expect(bodies).toHaveLength(3);
			expect(invocations).toEqual([
				{
					name: "readAppTest",
					input: {},
					requestId: "read-in-compacted-response",
				},
				{ name: "readAppTest", input: {}, requestId: "read-journey" },
			]);
			for (const body of bodies) {
				expect(body).toMatchObject({
					model: "gpt-6.1-sol",
					reasoning: { effort: "xhigh", summary: "auto" },
					store: false,
					context_management: [
						{ type: "compaction", compact_threshold: 256_000 },
					],
				});
				expect(body.include).toContain("reasoning.encrypted_content");
				expect(body.tools).toContainEqual({ type: "tool_search" });
				expect(
					body.tools?.find((tool) => tool.name === "getModule"),
				).toMatchObject({
					defer_loading: true,
					strict: false,
				});
				for (const name of ["startAppTest", "continueAppTest", "readAppTest"]) {
					const tool = body.tools?.find((item) => item.name === name);
					expect(tool).toMatchObject({ type: "function", strict: false });
					expect(tool?.defer_loading).not.toBe(true);
					expect(tool?.parameters?.properties).toBeDefined();
				}
			}
			expect(bodies[1].tools).toEqual(bodies[0].tools);
			expect(bodies[2].tools).toEqual(bodies[0].tools);
			for (const body of bodies.slice(1)) {
				expect(body.input).toContainEqual({
					type: "compaction",
					id: "checkpoint",
					encrypted_content: "opaque-provider-state",
				});
				expect(JSON.stringify(body.input)).not.toContain(
					"History before the opaque checkpoint",
				);
				expect(body.input).toContainEqual(
					expect.objectContaining({ type: "tool_search_output", tools: [] }),
				);
			}
			expect(bodies[2].input).toContainEqual(
				expect.objectContaining({
					type: "tool_search_output",
					tools: [loadedModule],
				}),
			);
			expect(bodies[2].input).toContainEqual(
				expect.objectContaining({
					type: "function_call",
					call_id: "read-journey",
					name: "readAppTest",
					namespace: "readAppTest",
					arguments: "{}",
				}),
			);
			expect(bodies[2].input).toContainEqual({
				type: "function_call_output",
				call_id: "read-journey",
				output: JSON.stringify(output),
			});
		},
	);
});
