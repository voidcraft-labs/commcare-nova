/** Native structured-decision boundary over a frozen, admitted plan and brief. */
import { describe, expect, it } from "vitest";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import {
	fixtureValue,
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import { MODEL_ROLES } from "@/lib/models";
import {
	executionBlockerSchema,
	resolveExecutionBlocker,
} from "../executionBlocker";
import {
	deriveSliceExecutionBrief,
	renderBriefMessage,
} from "../executionBrief";

function fixture() {
	const acceptedContract = makeContract();
	const currentPlan = makeBuildPlan();
	const brief = deriveSliceExecutionBrief({
		contract: acceptedContract,
		revision: {
			id: currentPlan.designRevisionId,
			digest: currentPlan.designRevisionDigest,
		},
		plan: currentPlan,
		sliceId: fixtureValue(currentPlan.slices[0], "first slice").id,
	});
	return {
		acceptedContract,
		currentPlan,
		brief,
		diagnostics: { code: "MISSING_PARENT", candidateRevision: 3 },
		blocker: executionBlockerSchema.parse({
			schemaVersion: 1,
			observations: ["The visit has no patient connection."],
			requestedDecision: "Which connection preserves the accepted workflow?",
		}),
	};
}
const decisions = [
	{ kind: "continue", guidance: "Connect each visit to the selected patient." },
	{
		kind: "contract-revision",
		reason: "Patient ownership is ambiguous.",
		question: "Does each visit belong to one patient?",
		options: ["One patient", "Several patients"],
	},
	{ kind: "ask-user", question: "Which team reviews the visit?", options: [] },
	{
		kind: "unsupported",
		reason: "This accepted operation cannot be represented.",
	},
];
async function generate(decision: unknown, incomplete = false) {
	const args = fixture();
	return withResponsesPeer(
		(_request, response) =>
			respondWithObject(response, JSON.stringify({ decision }), { incomplete }),
		async (_provider, transport) => {
			const context = new DesignGenerationContext({
				apiKey: "synthetic-local",
				transport,
				userId: "actor",
				projectId: "project",
				runId: "run",
				designSessionId: "session",
			});
			return resolveExecutionBlocker(
				context,
				args,
				new AbortController().signal,
			);
		},
	);
}

describe("architect blocker decisions", () => {
	it.each(decisions)(
		"admits a completed $kind decision through the native SDK and original schema",
		async (decision) => {
			expect(await generate(decision)).toMatchObject({
				kind: "produced",
				artifact: decision,
				finishReason: "stop",
				usage: { inputTokens: 11, outputTokens: 7 },
			});
		},
	);
	it("sends the exact accepted inputs and strict decision wrapper to the helper role", async () => {
		const args = fixture();
		let body: Record<string, unknown> | undefined;
		await withResponsesPeer(
			(request, response) => {
				let chunks = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					chunks += chunk;
				});
				request.on("end", () => {
					body = JSON.parse(chunks);
					respondWithObject(
						response,
						JSON.stringify({ decision: decisions[0] }),
					);
				});
			},
			async (_provider, transport) => {
				const context = new DesignGenerationContext({
					apiKey: "synthetic-local",
					transport,
					userId: "actor",
					projectId: "project",
					runId: "run",
					designSessionId: "session",
				});
				await resolveExecutionBlocker(
					context,
					args,
					new AbortController().signal,
				);
			},
		);
		expect(body).toMatchObject({
			model: MODEL_ROLES.executorHelper.modelId,
			store: false,
			stream: true,
			reasoning: { effort: MODEL_ROLES.executorHelper.reasoningEffort },
			text: {
				format: {
					type: "json_schema",
					strict: true,
					schema: {
						type: "object",
						required: ["decision"],
						additionalProperties: false,
					},
				},
			},
			input: expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					content: [
						{
							type: "input_text",
							text: [
								"## Accepted design contract",
								JSON.stringify(args.acceptedContract),
								"## Deterministic build plan",
								JSON.stringify(args.currentPlan),
								"## Accepted execution brief",
								renderBriefMessage(args.brief),
								"## Compiler report",
								JSON.stringify(args.blocker),
								"## Current server diagnostics",
								JSON.stringify(args.diagnostics),
							].join("\n\n"),
						},
					],
				}),
			]),
		});
	});
	it.each([
		{ kind: "plan-repair", reason: "Invent different slices" },
		{ kind: "continue", guidance: "" },
		{
			kind: "continue",
			guidance: "Keep the plan",
			question: "Unexpected field",
		},
		{ kind: "ask-user", question: "Choose", options: ["a", "b", "c", "d"] },
	])(
		"refuses a decoded decision outside the architect's authority: %j",
		async (decision) => {
			expect(await generate(decision)).toMatchObject({
				kind: "not-produced",
				reason: "invalid-structured-output",
			});
		},
	);
	it("does not act on a syntactically complete decision from an incomplete provider response", async () => {
		expect(await generate(decisions[0], true)).toMatchObject({
			kind: "not-produced",
			reason: "length",
		});
	});
	it.each([[], Array.from({ length: 13 }, () => "Repeated observation")])(
		"bounds reports before constructing a model request",
		(observations) => {
			expect(
				executionBlockerSchema.safeParse({ ...fixture().blocker, observations })
					.success,
			).toBe(false);
		},
	);
	it("rejects caller-authored tracking identities in compiler observations", () => {
		expect(
			executionBlockerSchema.safeParse({
				...fixture().blocker,
				affectedConstructionGroupIds: ["invented"],
			}).success,
		).toBe(false);
	});
});
