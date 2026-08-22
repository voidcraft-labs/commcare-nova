/**
 * Wire-body pin for the design agent's OpenAI Responses request: built
 * through the REAL factory (`createDesignAgent` + `createDesignLoopTools`)
 * against a capturing fetch that never sends. The drift guards:
 *
 *  - semantic updates, inspection, and tiny finalizers ride `strict: true`
 *    with the strict wire projection, while askQuestions stays non-strict;
 *  - parallel tool calls are enabled while the server serializes their
 *    workspace effects in response order;
 *  - the per-session prompt-cache triple and the statelessness pair are on
 *    the wire exactly as the SA's (`wireCacheConfig.test.ts` discipline);
 *  - the loop carries the configured design-author reasoning effort.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, it } from "vitest";
import { did } from "@/lib/agent/design/__tests__/fixtures";
import type { OpenQuestion } from "@/lib/agent/design/contract";
import {
	createDesignAgent,
	isExactRequiredDesignQuestionCall,
	REQUIRED_DESIGN_QUESTIONS_HEADER,
	requiredDesignQuestionAuthorizationKey,
	requiredDesignQuestionBatchWasAnswered,
	requiredDesignQuestionCardAuthorizationKey,
	requiredDesignQuestionInputSchema,
	requiredDesignQuestionStep,
	unansweredRequiredDesignQuestions,
} from "@/lib/agent/design/loop/designAgent";
import { DesignRepairTracker } from "@/lib/agent/design/loop/gates";
import {
	collectDesignReferenceBindings,
	createDesignLoopTools,
	designCreationIdentityIssue,
	designReservedReferenceIssue,
	resolveDesignWorkspaceHandles,
} from "@/lib/agent/design/loop/tools";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { computeSourcePackageDigest } from "@/lib/agent/design/sourcePackage";
import { MODEL_ROLES } from "@/lib/models";

interface CapturedBody {
	model?: string;
	store?: boolean;
	include?: string[];
	reasoning?: { effort?: string; summary?: string };
	prompt_cache_key?: string;
	prompt_cache_options?: { mode?: string; ttl?: string };
	parallel_tool_calls?: boolean;
	tool_choice?: { type?: string; name?: string };
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

const DESIGN_TOOL_NAMES = [
	"askQuestions",
	"finishDesign",
	"inspectDesign",
	"requestReview",
	"setDesignRoot",
	"updateAccess",
	"updateActors",
	"updateAssumptions",
	"updateDecisions",
	"updateExternalRequirements",
	"updateFindingDispositions",
	"updateFormCompositions",
	"updateLists",
	"updateModuleCompositions",
	"updateNavigation",
	"updateOpenQuestions",
	"updateRecords",
	"updateWorkflows",
	"waitForInput",
] as const;

function requiredQuestions(
	texts: readonly string[],
	identityBase = 9000,
): OpenQuestion[] {
	return texts.map((question, index) => ({
		id: did(identityBase + index),
		question,
		blocking: true,
		relatedElementIds: [did(identityBase - 1000 + index)],
	}));
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

async function captureDesignTurnBody(
	requiredQuestions: readonly OpenQuestion[] = [],
	phase: "author" | "review" | "revision" | "awaiting-input" = "author",
): Promise<CapturedBody> {
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
			model: () => openai(MODEL_ROLES.designAuthor.modelId),
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
		ancestryChanged: () => {},
		rebuildPackageForDigest: async () => null,
	});
	const agent = createDesignAgent({
		model: openai(MODEL_ROLES.designAuthor.modelId),
		tools,
		phase,
		catalogText: "CATALOG",
		constraintsText: "CONSTRAINTS",
		instructions: "You are Nova's designer.",
		promptCacheKey: "nova:design:session-probe",
		fatalError: () => undefined,
		requiredUserQuestions: () => requiredQuestions,
		freshStateMessage: async () => ({
			role: "user",
			content: "# Design session state (server-derived)",
		}),
		stepsBeforeStream: 0,
		contextGeneration: 0,
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
	it("appends the exact required question batch and forces its tool", () => {
		const questions = requiredQuestions(
			Array.from(
				{ length: 7 },
				(_, index) => `Which protocol threshold ${index + 1} applies?`,
			),
		);
		const step = requiredDesignQuestionStep(questions);
		expect(step).toMatchObject({
			message: { role: "user" },
			toolChoice: { type: "tool", toolName: "askQuestions" },
		});
		expect(step?.message.content).toContain(questions[0]?.question);
		expect(step?.message.content).not.toContain(questions[5]?.question);
		expect(requiredDesignQuestionStep([])).toBeNull();
	});

	it("keeps the question schema stable while the exact batch rides the message", async () => {
		const questions = requiredQuestions(
			Array.from(
				{ length: 7 },
				(_, index) => `Which protocol threshold ${index + 1} applies?`,
			),
		);
		const schema = requiredDesignQuestionInputSchema(questions);
		const exactInput = {
			header: REQUIRED_DESIGN_QUESTIONS_HEADER,
			questions: questions.slice(0, 5).map((question) => ({
				question: question.question,
				options: [],
			})),
		};
		expect(await schema.validate?.(exactInput)).toMatchObject({
			success: true,
		});
		expect(isExactRequiredDesignQuestionCall(exactInput, questions)).toBe(true);
		expect(
			isExactRequiredDesignQuestionCall(
				{ ...exactInput, questions: exactInput.questions.slice(0, 1) },
				questions,
			),
		).toBe(false);
		expect(
			await schema.validate?.({
				...exactInput,
				questions: exactInput.questions.map((question, index) =>
					index === 0 ? { ...question, question: "A paraphrase?" } : question,
				),
			}),
		).toMatchObject({ success: true });
		expect(
			isExactRequiredDesignQuestionCall(
				{
					...exactInput,
					questions: exactInput.questions.map((question, index) =>
						index === 0 ? { ...question, question: "A paraphrase?" } : question,
					),
				},
				questions,
			),
		).toBe(false);
		/* Model-proposed candidate options ride an exact call freely: the
		 * authorization property is prose exactness, and options are the
		 * recommended defaults the user can tap instead of typing. The marker
		 * follows the conversation language, so a localized spelling is
		 * exact-call-compatible too. */
		expect(
			isExactRequiredDesignQuestionCall(
				{
					...exactInput,
					questions: exactInput.questions.map((question, index) =>
						index === 0
							? {
									...question,
									options: [{ label: "Dos días (Recomendado)" }],
								}
							: question,
					),
				},
				questions,
			),
		).toBe(true);
		const projected = await schema.jsonSchema;
		expect(projected).toEqual(
			await requiredDesignQuestionInputSchema([]).jsonSchema,
		);

		const body = await captureDesignTurnBody(questions);
		expect(body.tool_choice).toEqual({
			type: "function",
			name: "askQuestions",
		});
		const askQuestions = body.tools?.find(
			(tool) => tool.name === "askQuestions",
		);
		expect(body.tools?.map((tool) => tool.name).sort()).toEqual(
			DESIGN_TOOL_NAMES,
		);
		expect(askQuestions?.parameters).toEqual(await schema.jsonSchema);

		const answered = [
			{
				id: "assistant-1",
				role: "assistant",
				parts: [
					{ type: "step-start" },
					{
						type: "tool-askQuestions",
						toolCallId: "question-call-1",
						state: "output-available",
						input: exactInput,
						output: Object.fromEntries(
							exactInput.questions.map((_, index) => [String(index), "Answer"]),
						),
					},
				],
			},
		] as never;
		const authorizationKey = requiredDesignQuestionAuthorizationKey(questions);
		const authorized = new Set([
			authorizationKey,
			requiredDesignQuestionCardAuthorizationKey({
				toolCallId: "question-call-1",
				authorizationKey,
				input: exactInput,
			}),
		]);
		expect(requiredDesignQuestionAuthorizationKey(questions)).toHaveLength(410);
		expect(
			requiredDesignQuestionAuthorizationKey(
				requiredQuestions(
					Array.from({ length: 100 }, (_, index) => `Question ${index + 1}?`),
				),
			).length,
		).toBeLessThan(512);
		/* Seven questions are pending but the round cap presented only the first
		 * five, so the answered card covers Q1-Q5 and the unasked Q6-Q7 still
		 * need their own round before staging is authorized. */
		expect(
			requiredDesignQuestionBatchWasAnswered(answered, questions, authorized),
		).toBe(false);
		expect(
			unansweredRequiredDesignQuestions(answered, questions, authorized).map(
				(question) => question.id,
			),
		).toEqual(questions.slice(5).map((question) => question.id));
		/* An answer binds to the exact question identity: once the pending set
		 * is exactly the answered card's questions — in any order, and however
		 * bounded stages shrank it — staging is authorized. */
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				questions.slice(0, 5),
				authorized,
			),
		).toBe(true);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				questions.slice(1, 5),
				authorized,
			),
		).toBe(true);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				[...questions.slice(0, 5)].reverse(),
				authorized,
			),
		).toBe(true);
		/* A newly introduced question never inherits an old answer, and only it
		 * is demanded again — the four already-answered identities stay
		 * answered instead of coming back to the user. */
		const newlyIntroduced = requiredQuestions(
			["A newly introduced decision?"],
			9500,
		);
		const shiftedPending = [
			...questions.slice(0, 4),
			...newlyIntroduced,
		] as OpenQuestion[];
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				shiftedPending,
				authorized,
			),
		).toBe(false);
		expect(
			unansweredRequiredDesignQuestions(answered, shiftedPending, authorized),
		).toEqual(newlyIntroduced);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				[
					...questions.slice(0, 4),
					...requiredQuestions(["A different final decision?"], 9600),
				],
				authorized,
			),
		).toBe(false);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				questions.slice(4),
				authorized,
			),
		).toBe(false);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[
					...answered,
					{
						id: "user-after-crash",
						role: "user",
						parts: [{ type: "text", text: "Please continue." }],
					},
				] as never,
				questions.slice(0, 5),
				authorized,
			),
		).toBe(true);
		/* A redundant newer card for identities the durable answered card already
		 * covers cannot un-answer them; coverage is per question identity, not
		 * per newest card. */
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[
					...answered,
					{
						...(answered[0] as object),
						id: "assistant-newer-unanswered",
						parts: [
							{ type: "step-start" },
							{
								type: "tool-askQuestions",
								state: "input-available",
								input: exactInput,
							},
						],
					},
				] as never,
				questions.slice(0, 5),
				authorized,
			),
		).toBe(true);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[
					{
						...(answered[0] as object),
						parts: [
							{ type: "step-start" },
							{
								type: "tool-askQuestions",
								state: "output-available",
								input: exactInput,
								output: {},
							},
						],
					},
				] as never,
				questions.slice(0, 5),
				authorized,
			),
		).toBe(false);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				questions.slice(5),
				authorized,
			),
		).toBe(false);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[
					{
						...(answered[0] as object),
						parts: [
							{ type: "step-start" },
							{
								type: "tool-askQuestions",
								state: "output-available",
								input: {
									...exactInput,
									questions: exactInput.questions.slice(0, 1),
								},
								output: { "0": "Answer" },
							},
						],
					},
				] as never,
				questions.slice(0, 5),
				authorized,
			),
		).toBe(false);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				questions.slice(0, 5),
				new Set(),
			),
		).toBe(false);
		const reusedTextWithNewIdentity = requiredQuestions(
			[questions[0]?.question ?? ""],
			9700,
		);
		const newAuthorizationKey = requiredDesignQuestionAuthorizationKey(
			reusedTextWithNewIdentity,
		);
		expect(newAuthorizationKey).not.toBe(authorizationKey);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				answered,
				reusedTextWithNewIdentity,
				new Set([...authorized, newAuthorizationKey]),
			),
		).toBe(false);
	});

	it("binds forward references eagerly instead of forcing a staging order", () => {
		const designSessionId = "00000000-0000-4000-8000-000000000002";
		const handle = "@source_record";
		const designId = resolveDesignWorkspaceHandles(
			{ handle },
			designSessionId,
		) as string;
		const input = { selection: { ids: [{ handle }] } };

		/* A handle already in the ledger mints no new binding. */
		expect(
			collectDesignReferenceBindings(
				input,
				[{ handle, designId, entityKind: "record" }],
				designSessionId,
			),
		).toEqual([]);
		/* A forward reference mints its deterministic identity under the
		 * `referenced` marker kind — the later declaration converges on the
		 * same UUID, so staging order stops mattering. */
		expect(collectDesignReferenceBindings(input, [], designSessionId)).toEqual([
			{ handle, designId, entityKind: "referenced" },
		]);
		/* A declaration in the same call already binds; no reference row. */
		expect(
			collectDesignReferenceBindings(
				{
					...input,
					collections: [
						{ collection: "records", upserts: [{ id: { handle } }] },
					],
				},
				[],
				designSessionId,
			),
		).toEqual([]);
		/* The reserved finding namespace never mints a design identity. */
		expect(
			designReservedReferenceIssue({ selection: { ids: [{ handle: "@f2" }] } }),
		).toContain("@f2");
		expect(designReservedReferenceIssue(input)).toBeNull();

		const rawSourceUpsert = {
			collections: [{ collection: "records", upserts: [{ id: designId }] }],
		};
		expect(
			designCreationIdentityIssue(
				rawSourceUpsert,
				{ records: [] },
				{ records: [{ id: designId, properties: [] }] },
			),
		).toBeNull();
		expect(
			designCreationIdentityIssue(rawSourceUpsert, { records: [] }),
		).toContain("raw UUID");
	});

	it("keeps review finding UUIDs outside the design identity namespace", () => {
		const findingId = did(8501);
		const removedFindingId = did(8502);

		expect(
			designCreationIdentityIssue(
				{
					collections: [],
					dispositions: {
						collection: "dispositions",
						upserts: [
							{
								findingId,
								status: "addressed",
								rationale: "The reviewed correction is staged.",
							},
						],
						removeIds: [removedFindingId],
					},
				},
				{ records: [] },
			),
		).toBeNull();
		expect(
			designCreationIdentityIssue(
				{
					collections: [
						{
							collection: "workflows",
							upserts: [],
							removeIds: [findingId],
						},
					],
				},
				{ workflows: [] },
			),
		).toContain("unknown raw design UUID");
	});

	it("sends one byte-stable tool contract through every design phase", async () => {
		const bodies = await Promise.all(
			(["author", "review", "revision", "awaiting-input"] as const).map(
				(phase) => captureDesignTurnBody([], phase),
			),
		);
		const first = JSON.stringify(bodies[0]?.tools);
		for (const body of bodies.slice(1)) {
			expect(JSON.stringify(body.tools)).toBe(first);
			expect(body.tool_choice).not.toEqual({
				type: "function",
				name: "askQuestions",
			});
		}
	});

	it("carries strict ordered tools, the cache triple, and configured reasoning", async () => {
		const body = await captureDesignTurnBody();

		expect(body.model).toBe(MODEL_ROLES.designAuthor.modelId);
		expect(body.store).toBe(false);
		expect(body.include).toContain("reasoning.encrypted_content");
		expect(body.reasoning?.effort).toBe(
			MODEL_ROLES.designAuthor.reasoningEffort,
		);
		expect(body.reasoning?.summary).toBeTruthy();
		expect(body.prompt_cache_key).toBe("nova:design:session-probe");
		expect(body.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		expect(body.parallel_tool_calls).toBe(true);

		const byName = new Map((body.tools ?? []).map((t) => [t.name, t]));
		for (const name of DESIGN_TOOL_NAMES.filter(
			(name) => name !== "askQuestions",
		)) {
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
		expect([...byName.keys()].sort()).toEqual(DESIGN_TOOL_NAMES);
	});
});
