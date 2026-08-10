/**
 * Wire-body pin for the design agent's OpenAI Responses request: built
 * through the REAL factory (`createDesignAgent` + `createDesignLoopTools`)
 * against a capturing fetch that never sends. The drift guards:
 *
 *  - bounded stages, inspection, and tiny finalizers ride `strict: true`
 *    with the strict wire projection, while askQuestions stays non-strict;
 *  - parallel tool calls are disabled because workspace revisions are ordered;
 *  - the per-session prompt-cache triple and the statelessness pair are on
 *    the wire exactly as the SA's (`wireCacheConfig.test.ts` discipline);
 *  - the loop runs at the drafting ceiling (xhigh).
 */

import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, it } from "vitest";
import { createDesignAgent } from "@/lib/agent/design/loop/designAgent";
import { DesignRepairTracker } from "@/lib/agent/design/loop/gates";
import { createDesignLoopTools } from "@/lib/agent/design/loop/tools";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { computeSourcePackageDigest } from "@/lib/agent/design/sourcePackage";
import { DESIGN_MODEL } from "@/lib/models";

interface CapturedBody {
	model?: string;
	store?: boolean;
	include?: string[];
	reasoning?: { effort?: string; summary?: string };
	prompt_cache_key?: string;
	prompt_cache_options?: { mode?: string; ttl?: string };
	parallel_tool_calls?: boolean;
	tools?: Array<{
		name?: string;
		strict?: boolean;
		parameters?: {
			type?: string;
			additionalProperties?: boolean;
			required?: string[];
			properties?: Record<string, unknown>;
		};
	}>;
}

function fixturePkg(): DesignSourcePackage {
	const ref = {
		kind: "message" as const,
		threadId: "00000000-0000-4000-8000-000000000001",
		messageId: "m1",
		partIndex: 0,
	};
	const unsealed: Omit<DesignSourcePackage, "packageDigest"> = {
		schemaVersion: 1,
		designSessionId: "00000000-0000-4000-8000-000000000002",
		projectId: "proj-1",
		request: { blocks: [{ ref, text: "Build it.", truncated: false }] },
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: [],
		sources: [{ ref }],
	};
	return { ...unsealed, packageDigest: computeSourcePackageDigest(unsealed) };
}

async function captureDesignTurnBody(): Promise<CapturedBody> {
	let captured: CapturedBody | null = null;
	const capture: typeof fetch = async (_url, init) => {
		captured ??= JSON.parse(init?.body as string) as CapturedBody;
		return new Response(JSON.stringify({ error: { message: "intercepted" } }), {
			status: 400,
		});
	};
	const openai = createOpenAI({ apiKey: "sk-fake-never-sent", fetch: capture });
	const pkg = fixturePkg();
	const tools = createDesignLoopTools({
		designSessionId: pkg.designSessionId,
		runId: "run-1",
		authority: {
			actorUserId: "u",
			runId: "run-1",
			holderNonce: "00000000-0000-4000-8000-000000000003",
			expectedProjectId: "p",
		},
		currentPkg: pkg,
		catalogText: "CATALOG",
		ctx: {
			userId: "u",
			projectId: "p",
			runId: "run-1",
			target: { kind: "design-session", designSessionId: pkg.designSessionId },
			model: () => openai(DESIGN_MODEL),
			trackSubGeneration: () => {},
			runStructured: async () => {
				throw new Error("never called at registration time");
			},
		},
		signal: new AbortController().signal,
		repair: new DesignRepairTracker(),
		loadAncestry: async () => {
			throw new Error("never called at registration time");
		},
		rebuildPackageForDigest: async () => null,
	});
	const agent = createDesignAgent({
		model: openai(DESIGN_MODEL),
		tools,
		catalogText: "CATALOG",
		constraintsText: "CONSTRAINTS",
		instructions: "You are Nova's designer.",
		promptCacheKey: "nova:design:session-probe",
		fatalError: () => undefined,
		freshStateMessage: async () => ({
			role: "user",
			content: "# Design session state (server-derived)",
		}),
	});
	/* `generate`, not `stream`: the capturing fetch fails every request, and
	 * a failed stream strands the SDK's internal tee/result promises as
	 * async leaks. The blocking call builds the identical request body. */
	await agent
		.generate({
			prompt: [
				{ role: "user", content: [{ type: "text", text: "Build it." }] },
			],
		})
		.catch(() => {
			// expected: the capturing fetch answers 400 after recording the body
		});
	if (!captured) throw new Error("no request captured");
	return captured;
}

describe("design agent Responses wire body", () => {
	it("carries strict ordered tools, the cache triple, and xhigh reasoning", async () => {
		const body = await captureDesignTurnBody();

		expect(body.model).toBe(DESIGN_MODEL);
		expect(body.store).toBe(false);
		expect(body.include).toContain("reasoning.encrypted_content");
		expect(body.reasoning?.effort).toBe("xhigh");
		expect(body.reasoning?.summary).toBeTruthy();
		expect(body.prompt_cache_key).toBe("nova:design:session-probe");
		expect(body.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		expect(body.parallel_tool_calls).toBe(false);

		const byName = new Map((body.tools ?? []).map((t) => [t.name, t]));
		for (const name of [
			"stageContract",
			"stageRevision",
			"stagePlan",
			"inspectDesignWorkspace",
			"submitContract",
			"requestReview",
			"submitRevision",
			"submitPlan",
		]) {
			const tool = byName.get(name);
			expect(tool, name).toBeDefined();
			expect(tool?.strict, name).toBe(true);
			/* The strict projection's signature: a closed object whose every
			 * property is required (optionality is the null union). */
			expect(tool?.parameters?.additionalProperties, name).toBe(false);
			expect(tool?.parameters?.required ?? [], name).toEqual(
				Object.keys(tool?.parameters?.properties ?? {}),
			);
		}
		expect(byName.get("askQuestions")?.strict).toBe(false);
	});
});
