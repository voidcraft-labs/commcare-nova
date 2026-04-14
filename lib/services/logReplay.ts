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
import { applyDataPart } from "./builder";
import type { BuilderEngine } from "./builderEngine";

// ── Types ───────────────────────────────────────────────────────────────

export interface ReplayStage {
	header: string;
	subtitle?: string;
	messages: UIMessage[];
	applyToBuilder: (engine: BuilderEngine) => void;
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
		emissionsByStep.get(event.step_index)?.push({
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
				type: "reasoning" as const,
				reasoning: event.reasoning,
				text: event.reasoning,
			} as unknown as UIMessage["parts"][number]);
		}
		if (event.text) {
			accumulatedParts.push({
				type: "text" as const,
				text: event.text,
			} as UIMessage["parts"][number]);
		}
		for (const tc of event.tool_calls) {
			accumulatedParts.push({
				type: `tool-${tc.name}`,
				toolCallId: `replay-${event.step_index}-${tc.name}`,
				toolName: tc.name,
				input: tc.args,
				state: "output-available",
				...(tc.output !== null ? { output: tc.output } : {}),
			} as UIMessage["parts"][number]);
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
						for (const em of stepEmissions)
							applyDataPart(b, em.type, em.data as Record<string, unknown>);
					},
				});
			}
		} else if (interestingCalls.length === 1) {
			stages.push({
				header: toolToHeader(interestingCalls[0].name) ?? "Update",
				subtitle: deriveSubtitle(interestingCalls[0], stepEmissions, scaffold),
				messages: buildProgressiveMessages(),
				applyToBuilder: (b) => {
					for (const em of stepEmissions)
						applyDataPart(b, em.type, em.data as Record<string, unknown>);
				},
			});
		} else {
			const emissionMap = distributeEmissions(stepEmissions, interestingCalls);
			for (let i = 0; i < interestingCalls.length; i++) {
				const tc = interestingCalls[i];
				const distributed = emissionMap.get(i) ?? [];
				stages.push({
					header: toolToHeader(tc.name) ?? "Update",
					subtitle: deriveSubtitle(tc, distributed, scaffold),
					messages: buildProgressiveMessages(),
					applyToBuilder: (b) => {
						for (const em of distributed)
							applyDataPart(b, em.type, em.data as Record<string, unknown>);
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
			/* Transition lifecycle flags for the final replay stage. Entity data
			 * was already dispatched into the doc store by the intermediate stages
			 * (scaffold setters, form-content setters), so there's no blueprint
			 * hand-off to perform here — just flip the session-store flags to
			 * Completed so the replay UI shows the done state. */
			b.store.getState().completeGeneration();
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
		const d = em.data as Record<string, unknown>;
		let matchedIdx = -1;

		for (let i = 0; i < toolCalls.length; i++) {
			const tc = toolCalls[i];
			const args = tc.args as Record<string, unknown>;

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
			result.get(matchedIdx)?.push(em);
		} else {
			result.get(0)?.push(em);
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
	const args = tc.args as Record<string, unknown>;

	switch (tc.name) {
		case "askQuestions":
			return args?.header as string | undefined;
		case "addModule": {
			const sf = scaffold as Record<string, unknown> | null;
			const modules = (sf as Record<string, unknown>)?.modules as
				| Array<Record<string, unknown>>
				| undefined;
			const name = modules?.[args?.moduleIndex as number]?.name as
				| string
				| undefined;
			return name ?? `Module ${args?.moduleIndex}`;
		}
		case "addQuestions": {
			const formEm = emissions.find(
				(e) => e.type === "data-form-done" || e.type === "data-form-updated",
			);
			const formData = formEm?.data as Record<string, unknown> | undefined;
			const formName = (formData?.form as Record<string, unknown> | undefined)
				?.name as string | undefined;
			if (formName) return formName;
			const sf2 = scaffold as Record<string, unknown> | null;
			const mods = (sf2 as Record<string, unknown>)?.modules as
				| Array<Record<string, unknown>>
				| undefined;
			const sfName = (
				mods?.[args?.moduleIndex as number]?.forms as
					| Array<Record<string, unknown>>
					| undefined
			)?.[args?.formIndex as number]?.name as string | undefined;
			return sfName ?? `Form ${args?.formIndex}`;
		}
		case "editQuestion":
			return `Update ${args?.questionId}`;
		case "addQuestion":
			return `Add ${(args?.question as Record<string, unknown> | undefined)?.id ?? "question"}`;
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
