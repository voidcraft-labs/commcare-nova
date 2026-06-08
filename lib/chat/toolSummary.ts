// Friendly presentation of the SA's tool calls for the chat transcript.
//
// The Solutions Architect emits many fine-grained tool calls per turn
// (addFields, addCaseListColumn, …). `ChatMessage` groups each consecutive RUN
// of edit-tool calls into a collapsed "N changes" summary; this module is the
// vocabulary that summary speaks.
//
// Each mutating tool returns a prose `message` (the contract the SA + MCP
// clients read) AND a structured `summary` (`{ location, subject }`) — the
// names the tool already resolved, exposed as discrete fields. We render the
// summary, NOT the prose: the prose buries the location at the end and leaks
// uuids / "index 0". A call without a `summary` (a read tool, or one not yet
// wired) falls back to its prose so it still reads sensibly.

import type { ToolUIPart } from "ai";
import type { ToolCallSummary } from "@/lib/agent/tools/shared/toolCallSummary";

/** Friendly "<verb> <noun>" action phrases, keyed by tool name. The transcript
 *  appends the call's `summary.subject` in quotes when present, so these stay
 *  as the bare verb+noun ("Added column" → `Added column "Age"`). */
const TOOL_ACTIONS: Record<string, string> = {
	addFields: "Added fields",
	addField: "Added field",
	editField: "Updated field",
	removeField: "Removed field",
	createForm: "Created form",
	updateForm: "Updated form",
	removeForm: "Removed form",
	createModule: "Created module",
	updateModule: "Renamed module",
	removeModule: "Removed module",
	addCaseListColumn: "Added column",
	updateCaseListColumn: "Updated column",
	removeCaseListColumn: "Removed column",
	reorderCaseListColumns: "Reordered columns",
	addSearchInput: "Added search input",
	updateSearchInput: "Updated search input",
	removeSearchInput: "Removed search input",
	reorderSearchInputs: "Reordered search inputs",
	setCaseListFilter: "Set the case-list filter",
	setCaseSearchAdvanced: "Updated advanced search",
	setCaseSearchDisplay: "Updated the search screen",
	validateApp: "Validated the app",
	searchBlueprint: "Searched the app",
	getModule: "Inspected a module",
	getForm: "Inspected a form",
	getField: "Inspected a field",
};

/** Tools whose single call performs a MULTI-ITEM action — the friendly action
 *  folds in `summary.count` ("Added 3 fields", "Reordered 5 columns"), each
 *  pluralizing its own noun. Falls back to the static `TOOL_ACTIONS` phrase when
 *  the count is absent (e.g. a read tool, or a call not carrying a summary). */
const COUNTABLE_ACTIONS: Record<string, (n: number) => string> = {
	addFields: (n) => `Added ${n} ${n === 1 ? "field" : "fields"}`,
	reorderCaseListColumns: (n) =>
		`Reordered ${n} ${n === 1 ? "column" : "columns"}`,
	reorderSearchInputs: (n) =>
		`Reordered ${n} ${n === 1 ? "search input" : "search inputs"}`,
};

export type ToolStatus = "pending" | "done" | "failed";

/** Tool name without the AI SDK `tool-` part-type prefix. */
const toolName = (part: ToolUIPart): string => part.type.replace(/^tool-/, "");

/** Whether a part is an edit-tool call that groups into the change summary.
 *  Excludes the specially-rendered tools: `askQuestions` (its own card) and the
 *  build-mode generators (the signal grid + GenerationProgress own that). */
export const isEditToolPart = (part: { type: string }): boolean =>
	part.type.startsWith("tool-") &&
	part.type !== "tool-askQuestions" &&
	part.type !== "tool-generateSchema" &&
	part.type !== "tool-generateScaffold";

/** The mutating-tool success shape we read for presentation. All fields are
 *  optional here because we narrow defensively off the part's `unknown`
 *  output — a failed call carries `{ error }` instead, a read tool carries its
 *  own payload, and an in-flight call carries nothing yet. */
interface MutationOutput {
	message?: string;
	summary?: ToolCallSummary;
	error?: string;
}

/** Narrow a part's output to the mutating-success shape, or null. */
const outputOf = (part: ToolUIPart): MutationOutput | null => {
	if (part.state !== "output-available") return null;
	const out = part.output;
	return typeof out === "object" && out !== null
		? (out as MutationOutput)
		: null;
};

/** A failed `validateApp` OUTCOME: the call returns `{ success:false, errors }`.
 *  This is the one case where a completed tool call must read as a failure —
 *  the app didn't validate. Returns the error list, or null when not applicable.
 *  Exported so the transcript can render the list as collapsed bullets rather
 *  than dumping the joined string. */
export const validateErrors = (part: ToolUIPart): string[] | null => {
	if (toolName(part) !== "validateApp" || part.state !== "output-available") {
		return null;
	}
	const out = part.output as
		| { success?: boolean; errors?: string[] }
		| undefined;
	if (out?.success === false) {
		return out.errors?.length ? out.errors : ["Validation failed."];
	}
	return null;
};

/** Per-call status, treating a failed validateApp outcome and an `{ error }`
 *  result as failures even though the call itself executed. */
export const toolStatus = (part: ToolUIPart): ToolStatus => {
	if (part.state === "input-streaming" || part.state === "input-available") {
		return "pending";
	}
	if (part.state === "output-error" || validateErrors(part)) return "failed";
	if (outputOf(part)?.error !== undefined) return "failed";
	return "done";
};

/** The headline action for a call: the friendly verb+noun, with the call's
 *  subject appended in quotes when the tool reported one. Falls back to the raw
 *  tool name so a newly-added tool still reads before it's mapped here. */
export const toolAction = (part: ToolUIPart): string => {
	const name = toolName(part);
	const summary = outputOf(part)?.summary;
	// Multi-item actions fold the count into the verb+noun ("Added 3 fields").
	const countable = COUNTABLE_ACTIONS[name];
	if (countable && typeof summary?.count === "number") {
		return countable(summary.count);
	}
	const action = TOOL_ACTIONS[name] ?? name;
	return summary?.subject ? `${action} "${summary.subject}"` : action;
};

/** The container breadcrumb ("Clients") shown beneath the action, or null when
 *  the act is top-level (creating a module) or the call carries no summary. */
export const toolLocation = (part: ToolUIPart): string | null =>
	outputOf(part)?.summary?.location ?? null;

/** Secondary line beneath the action: an error to surface, validateApp's
 *  outcome, or — for a call without a structured summary (read tools, or one
 *  not yet wired) — its raw prose so nothing renders blank. Null when the
 *  action + location already say everything. */
export const toolDetail = (part: ToolUIPart): string | null => {
	const verrors = validateErrors(part);
	if (verrors) return verrors.join("\n");
	if (toolName(part) === "validateApp" && toolStatus(part) === "done") {
		return "App successfully validated.";
	}
	// A tool that threw, or whose input the schema rejected, surfaces as
	// `output-error` with the AI SDK's raw `errorText` (e.g. an
	// "AI_ToolExecutionError: …"). That text is recorded server-side — the run's
	// event log plus a warn line, see `generationContext.ts`'s
	// `handleAgentStep` — but must never face the user, so show a friendly line.
	// (Tools that catch their own failures return a friendly `{ error }` string,
	// handled just below — that path is intentionally preserved.)
	if (part.state === "output-error") return "This change couldn't be applied.";

	const out = part.output;
	if (typeof out === "object" && out !== null && "error" in out) {
		return String((out as { error: unknown }).error);
	}
	// A structured summary already drives the action + breadcrumb — no prose
	// needed. Only fall back to the prose `message` (or a bare-string result)
	// when there's no summary to render from.
	if (outputOf(part)?.summary) return null;
	if (typeof out === "string") return out;
	if (typeof out === "object" && out !== null && "message" in out) {
		return String((out as { message: unknown }).message);
	}
	return null;
};

/** Roll a run of tool calls up to one status for the collapsed header: failed if
 *  any failed, else pending if any in-flight, else done. */
export const runStatus = (parts: ToolUIPart[]): ToolStatus => {
	if (parts.some((p) => toolStatus(p) === "failed")) return "failed";
	if (parts.some((p) => toolStatus(p) === "pending")) return "pending";
	return "done";
};
