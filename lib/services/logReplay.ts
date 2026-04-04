/**
 * Log Replay — extracts replay stages from a StoredEvent stream.
 *
 * Consumes StoredEvent[] directly — the same format written by both the file
 * sink (JSONL) and the Firestore sink. No intermediate conversion format.
 *
 * Walks events sequentially. Step events become replay stages (grouped with
 * their emissions via step_index). Message events build progressive chat
 * history. The `applyToBuilder` closure replays emissions through the shared
 * `applyDataPart` function — the same code path as real-time streaming.
 */
import type { UIMessage } from "ai";
import type { JsonValue, StoredEvent } from "@/lib/db/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import type { Builder } from "./builder";
import { applyDataPart } from "./builder";

// ── Types ───────────────────────────────────────────────────────────────

export interface ReplayStage {
	header: string;
	subtitle?: string;
	messages: UIMessage[];
	applyToBuilder: (builder: Builder) => void;
}

interface ExtractionSuccess {
	success: true;
	stages: ReplayStage[];
	doneIndex: number;
}

interface ExtractionError {
	success: false;
	error: string;
}

export type ExtractionResult = ExtractionSuccess | ExtractionError;

/** Lightweight reference to a tool call for stage derivation. */
interface ToolCallRef {
	name: string;
	args: JsonValue;
	output: JsonValue;
}

/** An emission in the shape replay needs (type string + data blob). */
interface ReplayEmission {
	type: string;
	data: JsonValue;
}

// ── Extraction ──────────────────────────────────────────────────────────

/**
 * Extract replay stages from a stream of StoredEvents.
 *
 * Events must be sorted by sequence (the order they were written). This
 * function groups step events with their emissions via step_index, builds
 * progressive chat messages from message/step events, and creates one
 * ReplayStage per interesting tool call.
 */
export function extractReplayStages(events: StoredEvent[]): ExtractionResult {
	if (!events.length) {
		return { success: false, error: "No events in log." };
	}

	/* Pre-index emissions by step_index for O(1) lookup */
	const emissionsByStep = new Map<number, ReplayEmission[]>();
	for (const { event } of events) {
		if (event.type !== "emission") continue;
		if (!emissionsByStep.has(event.step_index))
			emissionsByStep.set(event.step_index, []);
		emissionsByStep.get(event.step_index)!.push({
			type: event.emission_type,
			data: event.emission_data,
		});
	}

	const stages: ReplayStage[] = [];
	let accumulatedParts: UIMessage["parts"] = [];
	let currentRequest = -1;
	let baseMessages: UIMessage[] = [];
	let scaffold: JsonValue = null;

	function buildProgressiveMessages(): UIMessage[] {
		if (accumulatedParts.length === 0) return [...baseMessages];
		return [
			...baseMessages,
			{
				id: `assistant-${currentRequest}`,
				role: "assistant",
				parts: [...accumulatedParts],
				content: "",
			} as UIMessage,
		];
	}

	for (const stored of events) {
		const { event } = stored;

		/* Request boundary — finalize previous assistant message, add next user message */
		if (stored.request !== currentRequest) {
			if (currentRequest >= 0 && accumulatedParts.length > 0) {
				baseMessages = [
					...baseMessages,
					{
						id: `assistant-${currentRequest}`,
						role: "assistant",
						parts: [...accumulatedParts],
						content: "",
					} as UIMessage,
				];
				accumulatedParts = [];
			}
			currentRequest = stored.request;
		}

		if (event.type === "message") {
			baseMessages = [
				...baseMessages,
				{
					id: event.id,
					role: "user",
					parts: [{ type: "text", text: event.text }],
					content: event.text,
				} as UIMessage,
			];
			continue;
		}

		if (event.type !== "step") continue;

		/* Track scaffold from this step's emissions */
		const stepEmissions = emissionsByStep.get(event.step_index) ?? [];
		for (const em of stepEmissions) {
			if (em.type === "data-scaffold") scaffold = em.data;
		}

		/* Accumulate parts into progressive assistant message */
		if (event.reasoning) {
			accumulatedParts.push({
				type: "reasoning",
				reasoning: event.reasoning,
			} as any);
		}
		if (event.text) {
			accumulatedParts.push({ type: "text", text: event.text } as any);
		}
		for (const tc of event.tool_calls) {
			accumulatedParts.push({
				type: `tool-${tc.name}`,
				toolCallId: `replay-${event.step_index}-${tc.name}`,
				toolName: tc.name,
				input: tc.args,
				state: "output-available",
				...(tc.output !== null ? { output: tc.output } : {}),
			} as any);
		}

		/* Create stages from interesting tool calls */
		const interestingCalls = event.tool_calls.filter(
			(tc) => toolToHeader(tc.name) !== undefined,
		);

		if (interestingCalls.length === 0) {
			if (stepEmissions.length > 0) {
				stages.push({
					header: "Update",
					messages: buildProgressiveMessages(),
					applyToBuilder: (b) => {
						for (const em of stepEmissions) applyDataPart(b, em.type, em.data);
					},
				});
			}
		} else if (interestingCalls.length === 1) {
			stages.push({
				header: toolToHeader(interestingCalls[0].name)!,
				subtitle: deriveSubtitle(interestingCalls[0], stepEmissions, scaffold),
				messages: buildProgressiveMessages(),
				applyToBuilder: (b) => {
					for (const em of stepEmissions) applyDataPart(b, em.type, em.data);
				},
			});
		} else {
			const emissionMap = distributeEmissions(stepEmissions, interestingCalls);
			for (let i = 0; i < interestingCalls.length; i++) {
				const tc = interestingCalls[i];
				const distributed = emissionMap.get(i) ?? [];
				stages.push({
					header: toolToHeader(tc.name)!,
					subtitle: deriveSubtitle(tc, distributed, scaffold),
					messages: buildProgressiveMessages(),
					applyToBuilder: (b) => {
						for (const em of distributed) applyDataPart(b, em.type, em.data);
					},
				});
			}
		}
	}

	/* Done stage — synthetic final stage that completes generation */
	const doneIndex = stages.length;
	stages.push({
		header: "Done",
		messages: buildProgressiveMessages(),
		applyToBuilder: (b) => {
			const tree = b.treeData;
			if (tree) {
				b.completeGeneration({
					blueprint: {
						...tree,
						case_types: b.caseTypes ?? null,
					} as AppBlueprint,
					hqJson: {},
					success: true,
				});
			}
		},
	});

	if (stages.length <= 1) {
		return { success: false, error: "This log contains no generation data." };
	}

	return { success: true, stages, doneIndex };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Distribute a step's emissions across multiple tool calls by matching
 * moduleIndex/formIndex from emission data to tool call args.
 * Unmatched emissions go to the first tool call.
 */
function distributeEmissions(
	emissions: ReplayEmission[],
	toolCalls: ToolCallRef[],
): Map<number, ReplayEmission[]> {
	const result = new Map<number, ReplayEmission[]>();
	for (let i = 0; i < toolCalls.length; i++) result.set(i, []);

	for (const em of emissions) {
		const d = em.data as Record<string, any>;
		let matchedIdx = -1;

		for (let i = 0; i < toolCalls.length; i++) {
			const tc = toolCalls[i];
			const args = tc.args as Record<string, any>;

			if (
				tc.name === "addQuestions" &&
				(em.type === "data-form-done" || em.type === "data-form-updated") &&
				d.moduleIndex === args.moduleIndex &&
				d.formIndex === args.formIndex
			) {
				matchedIdx = i;
				break;
			}
			if (
				(tc.name === "editQuestion" ||
					tc.name === "addQuestion" ||
					tc.name === "removeQuestion" ||
					tc.name === "updateForm") &&
				em.type === "data-form-updated" &&
				d.moduleIndex === args.moduleIndex &&
				d.formIndex === args.formIndex
			) {
				matchedIdx = i;
				break;
			}
			if (
				(tc.name === "updateModule" ||
					tc.name === "createModule" ||
					tc.name === "removeModule" ||
					tc.name === "createForm" ||
					tc.name === "removeForm" ||
					tc.name === "renameCaseProperty") &&
				em.type === "data-blueprint-updated"
			) {
				matchedIdx = i;
				break;
			}
		}

		if (matchedIdx >= 0) {
			result.get(matchedIdx)!.push(em);
		} else {
			result.get(0)!.push(em);
		}
	}

	return result;
}

/** Map tool call name to replay stage header. Returns undefined for non-stage tools. */
function toolToHeader(toolName: string): string | undefined {
	switch (toolName) {
		case "askQuestions":
			return "Conversation";
		case "generateSchema":
			return "Data Model";
		case "generateScaffold":
			return "Scaffold";
		case "addModule":
			return "Module";
		case "addQuestions":
			return "Form";
		case "validateApp":
			return "Validation";
		case "editQuestion":
		case "addQuestion":
		case "removeQuestion":
		case "updateModule":
		case "updateForm":
		case "createForm":
		case "removeForm":
		case "createModule":
		case "removeModule":
		case "renameCaseProperty":
			return "Edit";
		default:
			return undefined;
	}
}

function deriveSubtitle(
	tc: ToolCallRef,
	emissions: ReplayEmission[],
	scaffold: JsonValue,
): string | undefined {
	const args = tc.args as Record<string, any>;

	switch (tc.name) {
		case "askQuestions":
			return args?.header;
		case "addModule": {
			const name = (scaffold as any)?.modules?.[args?.moduleIndex]?.name;
			return name ?? `Module ${args?.moduleIndex}`;
		}
		case "addQuestions": {
			const formEm = emissions.find(
				(e) => e.type === "data-form-done" || e.type === "data-form-updated",
			);
			const formName = (formEm?.data as any)?.form?.name;
			if (formName) return formName;
			const sfName = (scaffold as any)?.modules?.[args?.moduleIndex]?.forms?.[
				args?.formIndex
			]?.name;
			return sfName ?? `Form ${args?.formIndex}`;
		}
		case "editQuestion":
			return `Update ${args?.questionId}`;
		case "addQuestion":
			return `Add ${(args?.question as any)?.id ?? "question"}`;
		case "removeQuestion":
			return `Remove ${args?.questionId}`;
		case "updateModule":
			return "Update module";
		case "updateForm":
			return "Update form";
		case "createForm":
			return `Add form "${args?.name}"`;
		case "removeForm":
			return "Remove form";
		case "createModule":
			return `Add module "${args?.name}"`;
		case "removeModule":
			return "Remove module";
		case "renameCaseProperty":
			return `Rename ${args?.oldName} → ${args?.newName}`;
		default:
			return undefined;
	}
}

// ── Module-level singleton store ────────────────────────────────────────

interface ReplayData {
	stages: ReplayStage[];
	doneIndex: number;
	appName?: string;
}

let replayStore: ReplayData | undefined;

export function setReplayData(
	stages: ReplayStage[],
	doneIndex: number,
	appName?: string,
) {
	replayStore = { stages, doneIndex, appName };
}

/** Consume replay data. Returns the stored data and clears the store
 * atomically — subsequent calls return undefined. This ensures replay
 * state is always one-shot: the store can never leak stale data across
 * navigations regardless of which path the user takes. */
export function consumeReplayData(): ReplayData | undefined {
	const data = replayStore;
	replayStore = undefined;
	return data;
}
