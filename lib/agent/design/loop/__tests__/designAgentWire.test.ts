/** The installed SDK decodes complete Responses streams and executes the actual
 * design tool registry. External Project inspection is controlled solely to
 * observe provider ordering; native Project authority has its own suite. */
import { describe, expect, it } from "vitest";
import { did } from "@/lib/agent/design/__tests__/fixtures";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { MODEL_ROLES } from "@/lib/models";
import {
	isExactRequiredDesignQuestionCall,
	REQUIRED_DESIGN_QUESTIONS_HEADER,
} from "../designAgent";
import {
	catalogInput,
	consumeDesignAgent,
	type ProviderOutput,
	wireAgent,
	withDesignResponses,
} from "./designAgentPeer";

const DESIGN_TOOL_NAMES = [
	"askQuestions",
	"finishDesign",
	"inspectDesign",
	"inspectProjectData",
	"placeModules",
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
	"updateLookupTables",
	"updateModuleCompositions",
	"updateNavigation",
	"updateOpenQuestions",
	"updateRecords",
	"updateWorkflows",
	"waitForInput",
];
const answer = [{ type: "text" as const, text: "I can prepare that design." }];

describe("design agent Responses contract", () => {
	it("preserves one successful streamed tool grammar across all four phases", async () => {
		await withDesignResponses(
			[answer, answer, answer, answer],
			async (model, requests) => {
				for (const phase of [
					"author",
					"review",
					"revision",
					"awaiting-input",
				] as const) {
					const result = await consumeDesignAgent(wireAgent(model, { phase }));
					expect(result.text).toBe("I can prepare that design.");
					expect(result.finishReason).toBe("stop");
				}
				const first = requests[0];
				if (!first) throw new Error("No provider request captured");
				for (const request of requests) {
					expect(JSON.stringify(request.tools)).toBe(
						JSON.stringify(first.tools),
					);
					expect(request.tool_choice).not.toEqual({
						type: "function",
						name: "askQuestions",
					});
					expect(request.model).toBe(MODEL_ROLES.designAuthor.modelId);
					expect(request.store).toBe(false);
					expect(request.include).toContain("reasoning.encrypted_content");
					expect(request.reasoning?.effort).toBe(
						MODEL_ROLES.designAuthor.reasoningEffort,
					);
					expect(request.reasoning?.summary).toBeTruthy();
					expect(request.prompt_cache_key).toBe("nova:design:session-probe");
					expect(request.prompt_cache_options).toEqual({
						mode: "implicit",
						ttl: "30m",
					});
					expect(request.parallel_tool_calls).toBe(true);
				}
				const byName = new Map(first.tools?.map((tool) => [tool.name, tool]));
				expect([...byName.keys()].sort()).toEqual(DESIGN_TOOL_NAMES);
				for (const name of DESIGN_TOOL_NAMES.filter(
					(name) => name !== "askQuestions",
				)) {
					const tool = byName.get(name);
					expect(tool?.strict, name).toBe(true);
					expect(tool?.parameters?.additionalProperties, name).toBe(false);
					expect(tool?.parameters?.required, name).toEqual(
						Object.keys(tool?.parameters?.properties ?? {}),
					);
				}
				expect(byName.get("askQuestions")?.strict).toBe(false);
				expect(
					byName.get("inspectProjectData")?.parameters?.properties?.tableId,
				).toHaveProperty("pattern");
				expect(
					byName.get("inspectProjectData")?.parameters?.properties?.tableId,
				).not.toHaveProperty("anyOf");
			},
		);
	});

	it("forces the first five exact required questions while retaining the stable decoded client tool", async () => {
		const questions = Array.from({ length: 7 }, (_, index) => ({
			id: did(9000 + index),
			question: `Which protocol threshold ${index + 1} applies?`,
			blocking: true,
			relatedElementIds: [did(8000 + index)],
		}));
		const input = {
			header: REQUIRED_DESIGN_QUESTIONS_HEADER,
			questions: questions
				.slice(0, 5)
				.map(({ question }) => ({ question, options: [] })),
		};
		await withDesignResponses(
			[
				[
					{
						type: "tool",
						name: "askQuestions",
						input,
						callId: "required-card",
					},
				],
			],
			async (model, requests) => {
				const result = await consumeDesignAgent(
					wireAgent(model, { requiredUserQuestions: () => questions }),
				);
				expect(requests[0]?.tool_choice).toEqual({
					type: "function",
					name: "askQuestions",
				});
				const wireInput = JSON.stringify(requests[0]?.input);
				for (const question of questions.slice(0, 5))
					expect(wireInput).toContain(question.question);
				for (const question of questions.slice(5))
					expect(wireInput).not.toContain(question.question);
				expect(requests[0]?.tools?.map((tool) => tool.name).sort()).toEqual(
					DESIGN_TOOL_NAMES,
				);
				const calls = result.steps.flatMap((step) => step.toolCalls);
				expect(calls).toHaveLength(1);
				expect(calls[0]).toMatchObject({
					toolCallId: "required-card",
					toolName: "askQuestions",
					input,
				});
				expect(
					isExactRequiredDesignQuestionCall(calls[0]?.input, questions),
				).toBe(true);
				expect(result.steps.flatMap((step) => step.toolResults)).toEqual([]);
			},
		);
	});

	it.each(["askQuestions", "waitForInput"] as const)(
		"honors provider order when %s follows an unfinished server callback",
		async (terminal) => {
			const firstStarted = Promise.withResolvers<void>();
			const allDecoded = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const applied: string[] = [];
			let inspections = 0;
			const pause: ProviderOutput =
				terminal === "askQuestions"
					? {
							type: "tool",
							name: terminal,
							callId: "pause",
							input: {
								header: "Design choice",
								questions: [
									{ question: "Which workflow comes first?", options: [] },
								],
							},
						}
					: {
							type: "tool",
							name: terminal,
							callId: "pause",
							input: { reason: "more-requirements-coming" },
						};
			await withDesignResponses(
				[
					[
						{
							type: "tool",
							name: "inspectProjectData",
							input: catalogInput,
							callId: "before",
						},
						pause,
						{
							type: "tool",
							name: "inspectProjectData",
							input: catalogInput,
							callId: "after",
						},
					],
				],
				async (model) => {
					const agent = wireAgent(model, {}, async () => {
						inspections++;
						firstStarted.resolve();
						await release.promise;
						applied.push("catalog read completed");
						return {
							kind: "catalog",
							projectRevision: parseLookupRevision("0"),
							tables: [],
							complete: true,
						};
					});
					const run = consumeDesignAgent(agent, undefined, (part) => {
						if (part.type === "tool-call" && part.toolCallId === "after")
							allDecoded.resolve();
					});
					try {
						await firstStarted.promise;
						await allDecoded.promise;
						expect(inspections).toBe(1);
						expect(applied).toEqual([]);
					} finally {
						release.resolve();
						await run;
					}
					const result = await run;
					expect(applied).toEqual(["catalog read completed"]);
					expect(inspections).toBe(1);
					expect(result.steps).toHaveLength(1);
					const results = result.steps.flatMap((step) => step.toolResults);
					expect(
						results.find((part) => part.toolCallId === "before")?.output,
					).toMatchObject({ kind: "catalog", complete: true });
					expect(
						results.find((part) => part.toolCallId === "after")?.output,
					).toMatchObject({
						diagnostic: { code: "design-input-pause-terminal" },
					});
					if (terminal === "waitForInput")
						expect(
							results.find((part) => part.toolCallId === "pause")?.output,
						).toEqual({ ok: true, awaitingInput: true });
				},
			);
		},
	);
});
