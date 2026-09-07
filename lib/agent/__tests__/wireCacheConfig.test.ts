/** The actual Solutions Architect factory, prompt composition, provider and SDK
 * send to a native loopback Responses peer. This proves outbound settings and
 * stable input prefixes; it makes no claim about a live provider cache hit. */
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { MODEL_ROLES } from "@/lib/models";
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
	tools?: Array<{ name?: string; strict?: boolean; parameters?: unknown }>;
}

async function captureEditTurns(): Promise<CapturedBody[]> {
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
						output: [
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
					const agent = createSolutionsArchitect(ctx, doc);
					const result = await agent.generate({
						messages: [...markStablePrefixBoundary(history), appState],
					});
					expect(result.text).toBe("Ready for your next edit.");
					expect(usage.snapshot()).toMatchObject({
						inputTokens: 11,
						outputTokens: 7,
						stepCount: 1,
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
	it("sends stateless cache settings and real optional tool schemas with a stable prefix", async () => {
		const bodies = await captureEditTurns();
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body.model).toBe(MODEL_ROLES.followUpEditor.modelId);
			expect(body.store).toBe(false);
			expect(body.include).toContain("reasoning.encrypted_content");
			expect(body.reasoning).toMatchObject({
				effort: MODEL_ROLES.followUpEditor.reasoningEffort,
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
				parameters: {
					required: ["moduleUuid"],
					properties: { moduleUuid: { type: "string" }, name: {} },
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
