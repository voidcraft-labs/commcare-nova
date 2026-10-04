/** The actual Solutions Architect factory, prompt composition, provider and SDK
 * send to a native loopback Responses peer. This proves outbound settings and
 * stable input prefixes; it makes no claim about a live provider cache hit. */
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { MODEL_ROLES } from "@/lib/models";
import { appOverview } from "../appOverview";
import { buildAppStateMessage, markStablePrefixBoundary } from "../prompts";
import { createSolutionsArchitect } from "../solutionsArchitect";
import { expectAdmittedDoc, surveyFixture } from "./admittedFixture";
import { makeTestContext } from "./fixtures";
import { withResponsesPeer } from "./responsesPeer";

// This suite does no tool work. A step still refreshes its run lease, whose
// persistence is covered separately; retain every model/request owner.
vi.mock("@/lib/db/apps", () => ({
	refreshBuildLiveness: vi.fn().mockResolvedValue(undefined),
	refreshEditLease: vi.fn().mockResolvedValue(undefined),
}));

interface CapturedBody {
	model?: string;
	store?: boolean;
	include?: string[];
	reasoning?: { effort?: string; summary?: string };
	prompt_cache_key?: string;
	prompt_cache_options?: { mode?: string; ttl?: string };
	input?: Array<{
		role?: string;
		/** A plain string on system/developer items, part arrays elsewhere. */
		content?:
			| string
			| Array<{
					text?: string;
					prompt_cache_breakpoint?: { mode?: string };
			  }>;
	}>;
	tools?: Array<{
		type: string;
		name?: string;
		strict?: boolean;
		parameters?: unknown;
		defer_loading?: boolean;
	}>;
}

async function captureEditTurns(
	invalidQuestionFirst = false,
): Promise<CapturedBody[]> {
	const bodies: CapturedBody[] = [];
	await withResponsesPeer(
		(request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				bodies.push(JSON.parse(body));
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						id: "resp_local",
						created_at: 1,
						model: MODEL_ROLES.followUpEditor.modelId,
						output:
							invalidQuestionFirst && bodies.length === 1
								? [
										{
											type: "function_call",
											id: "fc_empty",
											call_id: "empty-question",
											name: "askQuestions",
											arguments: JSON.stringify({
												header: "Workflow complete",
												questions: [],
											}),
											status: "completed",
										},
									]
								: [
										{
											type: "message",
											role: "assistant",
											id: "msg_local",
											content: [
												{
													type: "output_text",
													text: "Ready for your next edit.",
													annotations: [],
												},
											],
										},
									],
						usage: { input_tokens: 11, output_tokens: 7 },
					}),
				);
			});
		},
		async (_provider, transport) => {
			const history: ModelMessage[] = [
				{ role: "user", content: "Review this app" },
				{ role: "assistant", content: "I have the current app." },
				{ role: "user", content: "What is here?" },
			];
			const original = structuredClone(history);
			for (const appName of ["Clinic North", "Clinic South"]) {
				const doc = expectAdmittedDoc({
					...surveyFixture(),
					appId: "a-probe",
					appName,
				});
				const appState = buildAppStateMessage(doc);
				if (!appState) throw new Error("Admitted app has no state message");
				const { ctx, usage } = makeTestContext({ appId: "a-probe", transport });
				try {
					const agent = createSolutionsArchitect(ctx, {
						invoke: async () => {
							throw new Error(
								"This provider-wire check does not invoke tools.",
							);
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
					const result = await agent.generate({
						messages: [...markStablePrefixBoundary(history), appState],
					});
					expect(result.text).toBe("Ready for your next edit.");
					expect(ctx.pausedOnInput()).toBe(false);
					const steps =
						invalidQuestionFirst && appName === "Clinic North" ? 2 : 1;
					expect(usage.snapshot()).toMatchObject({
						inputTokens: 11 * steps,
						outputTokens: 7 * steps,
						stepCount: steps,
					});
				} finally {
					await ctx.stopRunLeaseHeartbeat();
				}
			}
			expect(history).toEqual(original);
		},
	);
	return bodies;
}

describe("actual SA edit-turn Responses wire", () => {
	it("rejects an empty question round and lets the actual SDK repair it without pausing", async () => {
		const bodies = await captureEditTurns(true);
		expect(bodies).toHaveLength(3);
		expect(
			bodies[0].tools?.find((tool) => tool.name === "askQuestions")?.parameters,
		).toMatchObject({
			properties: { questions: { minItems: 1, maxItems: 5 } },
		});
		expect(bodies[1].input).toContainEqual(
			expect.objectContaining({
				type: "function_call_output",
				call_id: "empty-question",
			}),
		);
	});

	it("sends stateless cache settings and real optional tool schemas with a stable prefix", async () => {
		const bodies = await captureEditTurns();
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body.model).toBe("gpt-6.1-sol");
			expect(body.store).toBe(false);
			expect(body.tools).toContainEqual(
				expect.objectContaining({ type: "tool_search" }),
			);
			for (const name of ["startAppTest", "continueAppTest", "readAppTest"]) {
				const tool = body.tools?.find((tool) => tool.name === name);
				expect(tool).toMatchObject({ type: "function", strict: false });
				expect(tool?.defer_loading).not.toBe(true);
			}
			expect(body.include).toContain("reasoning.encrypted_content");
			expect(body.reasoning).toMatchObject({
				effort: "xhigh",
				summary: "auto",
			});
			expect(body.prompt_cache_key).toBe("nova:app:a-probe");
			expect(body.prompt_cache_options).toEqual({
				mode: "implicit",
				ttl: "30m",
			});
			expect(
				body.tools?.find((tool) => tool.name === "updateModule"),
			).toMatchObject({
				strict: false,
				defer_loading: true,
				parameters: {
					required: ["moduleUuid"],
					properties: {
						moduleUuid: {
							type: "string",
							description: "Module name or stable ID.",
						},
						name: {},
					},
				},
			});
			const input = body.input ?? [];
			const breakpoints = input.flatMap((item, index) =>
				(Array.isArray(item.content) ? item.content : []).flatMap((part) =>
					part.prompt_cache_breakpoint
						? [
								{
									index,
									role: item.role,
									mode: part.prompt_cache_breakpoint.mode,
								},
							]
						: [],
				),
			);
			expect(breakpoints).toEqual([
				{ index: input.length - 2, role: "user", mode: "explicit" },
			]);
		}
		expect(bodies[0].input?.slice(0, -1)).toEqual(
			bodies[1].input?.slice(0, -1),
		);
		expect(JSON.stringify(bodies[0].input?.at(-1))).toContain("Clinic North");
		expect(JSON.stringify(bodies[1].input?.at(-1))).toContain("Clinic South");
	});
});
